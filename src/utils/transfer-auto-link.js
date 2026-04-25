// Auto-link Steve's Transfer_Orders → matching Supacolor_Jobs.
//
// Direction matters (Erik 2026-04-24): we ALWAYS iterate over unlinked
// Steve submissions and look for their Supacolor match. We never scan
// new Supacolor jobs for Steve matches, because Bradley's direct reorders
// on supacolor.com produce jobs that have NO prior Steve submission — if
// we scanned from the API side we'd risk false-matching those to unrelated
// Transfer_Orders with a similar company name.
//
// Flow:
//   1. Steve pastes Box links → Transfer_Orders row with Status='Requested',
//      Supacolor_Order_Number=NULL (Phase 3)
//   2. Bradley places the order on supacolor.com
//   3. Cron POST /api/supacolor-jobs/sync/all pulls the new job into our table
//   4. **THIS MODULE** fires AFTER the sync: iterates unlinked Transfer_Orders
//      and tries to find their Supacolor match. Only matches are updated;
//      transfers without a match are left alone (retry next cron cycle).
//
// Matching strategy (confirmed with Erik):
//   A. EXACT on design#: Transfer_Orders.Design_Number === Supacolor_Jobs.PO_Number
//   B. FUZZY on company: Transfer_Orders.Company_Name token-overlaps
//      Supacolor_Jobs.Description >= 0.75 (after stripping Inc/LLC/Corp etc.).
//      Only used when no exact-design# match. Ambiguous fuzzy (2+ equally-scored)
//      skips to let Bradley link manually.
//
// Safety rails:
//   - Only Transfer_Orders with Supacolor_Order_Number IS NULL
//   - Only Status IN ('Requested', 'On_Hold')
//   - Only transfers submitted within last 14 days
//   - Only Supacolor jobs from the last 14 days (avoid cross-month confusion)
//   - Non-blocking: all errors swallowed + logged

const axios = require('axios');
const config = require('../../config');
const { sendTransferOrderedEmail } = require('./send-transfer-ordered-email');

const caspioApiBaseUrl = config.caspio.apiBaseUrl;
const TRANSFER_TABLE = 'Transfer_Orders';
const SUPA_JOBS_TABLE = 'Supacolor_Jobs';
const NOTES_TABLE = 'Transfer_Order_Notes';

const ELIGIBLE_STATUSES = ['Requested', 'On_Hold'];
const MATCH_WINDOW_DAYS = 14;
const FUZZY_THRESHOLD = 0.75;

function escapeSQL(s) {
    return String(s == null ? '' : s).replace(/'/g, "''");
}

// Normalize a company name for fuzzy comparison.
function normalizeCompany(name) {
    return String(name || '')
        .toLowerCase()
        .replace(/[.,&']/g, ' ')
        .replace(/\b(inc|llc|l\.l\.c|corp|corporation|co|ltd|limited|company)\b\.?/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

// Token-overlap similarity — denominator is the larger set (stricter than
// plain Jaccard), so "APS" vs "APS Inc Asphalt Patch Systems" doesn't score
// 100% just because the shorter is a subset.
function tokenOverlap(a, b) {
    const aTokens = new Set(a.split(' ').filter(t => t.length > 1));
    const bTokens = new Set(b.split(' ').filter(t => t.length > 1));
    if (aTokens.size === 0 || bTokens.size === 0) return 0;
    let overlap = 0;
    aTokens.forEach(t => { if (bTokens.has(t)) overlap++; });
    return overlap / Math.max(aTokens.size, bTokens.size);
}

/**
 * Company-name similarity score that handles Bradley's short Supacolor
 * descriptions ("Asphalt Patch") vs Steve's full company names ("Asphalt
 * Patch Systems"). Combines containment checks with the token-overlap fallback.
 *
 * 2026-04-25: added because real-world test (ST-260425-0001 ↔ #639515) showed
 * tokenOverlap("asphalt patch", "asphalt patch systems") = 0.67 — below the
 * 0.75 threshold — even though they're clearly the same company.
 *
 * Returns 0..1.
 */
function companyMatchScore(a, b) {
    const na = normalizeCompany(a);
    const nb = normalizeCompany(b);
    if (!na || !nb) return 0;
    if (na === nb) return 1.0;
    const shorter = na.length <= nb.length ? na : nb;
    const longer  = na.length <= nb.length ? nb : na;
    if (longer.startsWith(shorter)) return 0.95;  // prefix → high confidence
    if (longer.includes(shorter)) return 0.85;    // substring → medium-high
    return tokenOverlap(na, nb);                  // fall back to token overlap
}

// ── Caspio queries ──────────────────────────────────────────────────

/**
 * Fetch all unlinked Transfer_Orders eligible for auto-linking.
 */
async function fetchUnlinkedTransfers(token) {
    const cutoffIso = new Date(Date.now() - MATCH_WINDOW_DAYS * 24 * 60 * 60 * 1000)
        .toISOString().slice(0, 19);
    // Caspio returns Text fields as empty string, not NULL — accept both
    // (2026-04-25 fix: Erik's first real submission ST-260425-0001 had
    // Supacolor_Order_Number='' and was excluded by the IS NULL-only check).
    const whereClauses = [
        `(Supacolor_Order_Number IS NULL OR Supacolor_Order_Number='')`,
        `(${ELIGIBLE_STATUSES.map(s => `Status='${s}'`).join(' OR ')})`,
        `Requested_At>='${escapeSQL(cutoffIso)}'`
    ];
    const url = `${caspioApiBaseUrl}/tables/${TRANSFER_TABLE}/records` +
        `?q.where=${encodeURIComponent(whereClauses.join(' AND '))}` +
        `&q.orderBy=${encodeURIComponent('Requested_At DESC')}`;
    try {
        const resp = await axios.get(url, {
            headers: { 'Authorization': `Bearer ${token}` },
            timeout: 15000
        });
        return (resp.data && resp.data.Result) || [];
    } catch (err) {
        console.error('[auto-link] transfer fetch failed:',
            err.response ? JSON.stringify(err.response.data) : err.message);
        return [];
    }
}

/**
 * Fetch recent Supacolor jobs that could plausibly match a given transfer.
 * We only look at the last 14 days (the match window) to keep the
 * candidate set small.
 */
async function fetchCandidateSupacolorJobs(token) {
    const cutoffIso = new Date(Date.now() - MATCH_WINDOW_DAYS * 24 * 60 * 60 * 1000)
        .toISOString().slice(0, 19);
    const whereClauses = [
        `Date_Entered>='${escapeSQL(cutoffIso)}'`
    ];
    const url = `${caspioApiBaseUrl}/tables/${SUPA_JOBS_TABLE}/records` +
        `?q.where=${encodeURIComponent(whereClauses.join(' AND '))}` +
        `&q.orderBy=${encodeURIComponent('Date_Entered DESC')}` +
        `&q.pageSize=500`;
    try {
        const resp = await axios.get(url, {
            headers: { 'Authorization': `Bearer ${token}` },
            timeout: 15000
        });
        return (resp.data && resp.data.Result) || [];
    } catch (err) {
        console.error('[auto-link] Supacolor jobs fetch failed:',
            err.response ? JSON.stringify(err.response.data) : err.message);
        return [];
    }
}

// ── Matching ─────────────────────────────────────────────────────────

/**
 * Parse a Caspio-stored datetime (which strips the Z) into a JS Date.
 * Returns null for unparseable input.
 */
function parseDate(iso) {
    if (!iso) return null;
    const s = String(iso);
    const norm = s.endsWith('Z') ? s : (s.replace(' ', 'T') + 'Z');
    const d = new Date(norm);
    return isNaN(d.getTime()) ? null : d;
}

/**
 * Hours between two dates — positive means the Supacolor job was entered
 * AFTER Steve's submission (the normal direction, since Bradley places the
 * order after Steve sends the Box links).
 */
function hoursAfter(transferDate, supaDate) {
    if (!transferDate || !supaDate) return null;
    return (supaDate - transferDate) / (1000 * 60 * 60);
}

/**
 * Given ONE transfer + a list of candidate Supacolor jobs, find the
 * best-match job. Returns:
 *   { match, confidence: 'exact'|'fuzzy' }
 *   { ambiguous: true, confidence, candidateJobNumbers }
 *   null (no match)
 *
 * Matching signals, in priority order:
 *   1. Design_Number === PO_Number (exact) — highest confidence when Bradley
 *      typed the design# as the Supacolor PO
 *   2. Company_Name fuzzy-matches Description (token-overlap ≥ 0.75 after
 *      stripping legal suffixes) — fallback when PO differs
 *   3. Date proximity — Supacolor job must be entered AFTER Steve's
 *      submission (small tolerance: allow up to 24h before, in case of clock
 *      skew). Within fuzzy matches, the temporally-closest job wins.
 */
function findSupacolorMatchForTransfer(transfer, supaJobs) {
    if (!transfer || !supaJobs || !supaJobs.length) return null;

    const transferDate = parseDate(transfer.Requested_At);

    // Symmetric 14-day window in EITHER direction (2026-04-25 fix).
    // Original "must be after Steve" assumption was wrong: Bradley sometimes
    // places Supacolor orders DAYS before Steve creates the audit-trail
    // submission (legacy flow — Bradley already had the Box files via Slack).
    // Real-world repro: ST-260425-0001 (Steve, today) ↔ #639515 (Bradley, 3
    // days ago) failed under the old rule because the SC job was entered
    // BEFORE the transfer.
    const timeFiltered = transferDate
        ? supaJobs.filter(j => {
            const sd = parseDate(j.Date_Entered);
            if (!sd) return false;
            const h = hoursAfter(transferDate, sd);
            return h !== null && Math.abs(h) <= MATCH_WINDOW_DAYS * 24;
        })
        : supaJobs;

    if (timeFiltered.length === 0) return null;

    // Step A: exact on Design_Number === PO_Number
    const designNum = String(transfer.Design_Number || '').trim();
    if (designNum) {
        const exact = timeFiltered.filter(j =>
            String(j.PO_Number || '').trim() === designNum
        );
        if (exact.length === 1) return { match: exact[0], confidence: 'exact' };
        if (exact.length > 1) {
            // Multiple exact PO matches — prefer the absolutely-closest in time
            // (in either direction; v3.1 fix from signed direction).
            const withTime = exact.map(j => {
                const sd = parseDate(j.Date_Entered);
                const h = hoursAfter(transferDate, sd);
                return { job: j, absHours: h === null ? Infinity : Math.abs(h) };
            }).sort((a, b) => a.absHours - b.absHours);
            // Clear winner if next-closest is at least 48h further away
            if (withTime[1].absHours - withTime[0].absHours >= 48) {
                return { match: withTime[0].job, confidence: 'exact' };
            }
            return {
                ambiguous: true,
                confidence: 'exact',
                candidateJobNumbers: exact.map(j => j.Supacolor_Job_Number)
            };
        }
    }

    // Step B: fuzzy on Company_Name vs Description (now using companyMatchScore
    // which adds prefix/substring containment for short Bradley descriptions).
    if (!normalizeCompany(transfer.Company_Name)) return null;

    const scored = timeFiltered
        .map(j => {
            const sd = parseDate(j.Date_Entered);
            const h = hoursAfter(transferDate, sd);
            return {
                job: j,
                score: companyMatchScore(transfer.Company_Name, j.Description),
                absHours: h === null ? Infinity : Math.abs(h)
            };
        })
        .filter(s => s.score >= FUZZY_THRESHOLD)
        // Primary sort: score desc. Tiebreak: absolutely-closest in time
        // (either direction).
        .sort((a, b) => {
            if (Math.abs(a.score - b.score) > 0.01) return b.score - a.score;
            return a.absHours - b.absHours;
        });

    if (scored.length === 0) return null;
    if (scored.length === 1) return { match: scored[0].job, confidence: 'fuzzy' };

    // Clear winner: top score beats runner-up by ≥0.1 OR same score but
    // at least 48h temporal gap (closer one wins clearly).
    const top = scored[0];
    const runner = scored[1];
    const scoreDelta = top.score - runner.score;
    const timeDelta = runner.absHours - top.absHours;

    if (scoreDelta >= 0.1 || (scoreDelta < 0.01 && timeDelta >= 48)) {
        return { match: top.job, confidence: 'fuzzy' };
    }
    return {
        ambiguous: true,
        confidence: 'fuzzy',
        candidateJobNumbers: scored.map(s => s.job.Supacolor_Job_Number)
    };
}

// ── Caspio mutations ─────────────────────────────────────────────────

async function writeAutoLinkNote(token, transferId, supaNumber, confidence) {
    const noteText = `Auto-linked to Supacolor #${supaNumber} (${confidence} match) — Status flipped to Ordered`;
    try {
        await axios.post(`${caspioApiBaseUrl}/tables/${NOTES_TABLE}/records`, {
            Transfer_ID: transferId,
            Note_Type: 'status_change',
            Note_Text: noteText,
            Author_Email: 'auto-link@nwcustomapparel.com',
            Author_Name: 'Auto-link (Supacolor sync)'
        }, {
            headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
            timeout: 15000
        });
    } catch (err) {
        console.warn('[auto-link] note write failed (non-fatal):', err.message);
    }
}

async function updateTransferToOrdered(token, transfer, supaJob) {
    const now = new Date().toISOString();
    const update = {
        Status: 'Ordered',
        Sent_To_Supacolor_By: 'auto-link@nwcustomapparel.com',
        Sent_To_Supacolor_At: now,
        Supacolor_Order_Number: String(supaJob.Supacolor_Job_Number)
    };
    const safeId = escapeSQL(transfer.ID_Transfer);
    const url = `${caspioApiBaseUrl}/tables/${TRANSFER_TABLE}/records?q.where=ID_Transfer='${safeId}'`;
    await axios.put(url, update, {
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
        timeout: 15000
    });
}

// ── Main entry ───────────────────────────────────────────────────────

/**
 * Sweep all unlinked Transfer_Orders and try to link each one to a recent
 * Supacolor job. Call AFTER a Supacolor sync run completes.
 *
 * @param {string} token - Caspio access token
 * @param {object} [opts]
 * @param {boolean} [opts.skipEmail=false] - skip email sending (tests)
 * @param {boolean} [opts.dryRun=false] - log what would happen, don't write
 * @returns {Promise<{
 *   processed: number,
 *   linked: number,
 *   ambiguous: number,
 *   noMatch: number,
 *   details: Array<{transferId, result}>
 * }>}
 */
async function linkPendingSteveSubmissions(token, opts) {
    opts = opts || {};

    const transfers = await fetchUnlinkedTransfers(token);
    if (transfers.length === 0) {
        return { processed: 0, linked: 0, ambiguous: 0, noMatch: 0, details: [] };
    }

    // Pull candidate Supacolor jobs ONCE and match each transfer against the list.
    // (We don't narrow per-transfer because jobs are cheap — recent-window only.)
    const supaJobs = await fetchCandidateSupacolorJobs(token);

    let linked = 0;
    let ambiguous = 0;
    let noMatch = 0;
    const details = [];

    for (const transfer of transfers) {
        const result = findSupacolorMatchForTransfer(transfer, supaJobs);

        if (!result) {
            noMatch++;
            details.push({ transferId: transfer.ID_Transfer, result: 'no match' });
            continue;
        }

        if (result.ambiguous) {
            ambiguous++;
            console.warn(`[auto-link] AMBIGUOUS — Transfer ${transfer.ID_Transfer} has ${result.candidateJobNumbers.length} ${result.confidence} matches (${result.candidateJobNumbers.join(', ')}). Skipping.`);
            details.push({
                transferId: transfer.ID_Transfer,
                result: 'ambiguous',
                confidence: result.confidence,
                candidateJobNumbers: result.candidateJobNumbers
            });
            continue;
        }

        if (opts.dryRun) {
            linked++;
            console.log(`[auto-link DRYRUN] Transfer ${transfer.ID_Transfer} \u2192 Supacolor #${result.match.Supacolor_Job_Number} (${result.confidence})`);
            details.push({
                transferId: transfer.ID_Transfer,
                result: 'would-link',
                supacolorJobNumber: result.match.Supacolor_Job_Number,
                confidence: result.confidence
            });
            continue;
        }

        // Real link
        try {
            await updateTransferToOrdered(token, transfer, result.match);
            await writeAutoLinkNote(token, transfer.ID_Transfer, result.match.Supacolor_Job_Number, result.confidence);

            if (!opts.skipEmail) {
                try {
                    await sendTransferOrderedEmail(
                        Object.assign({}, transfer, {
                            Status: 'Ordered',
                            Supacolor_Order_Number: String(result.match.Supacolor_Job_Number)
                        }),
                        result.match
                    );
                } catch (emailErr) {
                    console.warn('[auto-link] transfer_ordered email failed (non-fatal):', emailErr.message);
                }
            }

            linked++;
            console.log(`[auto-link] \u2713 Transfer ${transfer.ID_Transfer} \u2192 Supacolor #${result.match.Supacolor_Job_Number} (${result.confidence})`);
            details.push({
                transferId: transfer.ID_Transfer,
                result: 'linked',
                supacolorJobNumber: result.match.Supacolor_Job_Number,
                confidence: result.confidence
            });
        } catch (err) {
            console.error(`[auto-link] update failed for Transfer ${transfer.ID_Transfer}:`, err.message);
            details.push({
                transferId: transfer.ID_Transfer,
                result: 'error',
                error: err.message
            });
        }
    }

    return {
        processed: transfers.length,
        linked,
        ambiguous,
        noMatch,
        details
    };
}

module.exports = {
    linkPendingSteveSubmissions,
    // Exposed for testing
    _normalizeCompany: normalizeCompany,
    _tokenOverlap: tokenOverlap,
    _findSupacolorMatchForTransfer: findSupacolorMatchForTransfer
};
