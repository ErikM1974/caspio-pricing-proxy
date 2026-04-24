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

// ── Caspio queries ──────────────────────────────────────────────────

/**
 * Fetch all unlinked Transfer_Orders eligible for auto-linking.
 */
async function fetchUnlinkedTransfers(token) {
    const cutoffIso = new Date(Date.now() - MATCH_WINDOW_DAYS * 24 * 60 * 60 * 1000)
        .toISOString().slice(0, 19);
    const whereClauses = [
        `Supacolor_Order_Number IS NULL`,
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

    // Only consider jobs entered AFTER the transfer was submitted. Small
    // 24h pre-window for clock-skew tolerance (rare but possible).
    const timeFiltered = transferDate
        ? supaJobs.filter(j => {
            const sd = parseDate(j.Date_Entered);
            if (!sd) return false;
            const h = hoursAfter(transferDate, sd);
            return h !== null && h >= -24; // allow 24h pre-submission tolerance
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
            // Multiple exact PO matches — prefer the closest-in-time one
            const withTime = exact.map(j => {
                const sd = parseDate(j.Date_Entered);
                return { job: j, hoursAfterTransfer: hoursAfter(transferDate, sd) };
            }).sort((a, b) => {
                // Positive (after) is closer to zero = better; null goes last
                const ax = a.hoursAfterTransfer === null ? Infinity : a.hoursAfterTransfer;
                const bx = b.hoursAfterTransfer === null ? Infinity : b.hoursAfterTransfer;
                return ax - bx;
            });
            // If the closest match is clearly closer than the runner-up (more than 48h gap), take it
            if (withTime[0].hoursAfterTransfer !== null &&
                withTime[1].hoursAfterTransfer !== null &&
                (withTime[1].hoursAfterTransfer - withTime[0].hoursAfterTransfer) >= 48) {
                return { match: withTime[0].job, confidence: 'exact' };
            }
            return {
                ambiguous: true,
                confidence: 'exact',
                candidateJobNumbers: exact.map(j => j.Supacolor_Job_Number)
            };
        }
    }

    // Step B: fuzzy on Company_Name vs Description
    const company = normalizeCompany(transfer.Company_Name);
    if (!company) return null;

    const scored = timeFiltered
        .map(j => ({
            job: j,
            score: tokenOverlap(company, normalizeCompany(j.Description)),
            hoursAfterTransfer: hoursAfter(transferDate, parseDate(j.Date_Entered))
        }))
        .filter(s => s.score >= FUZZY_THRESHOLD)
        // Primary sort: score desc. Tiebreak: temporally-closest AFTER the transfer.
        .sort((a, b) => {
            if (Math.abs(a.score - b.score) > 0.01) return b.score - a.score;
            const ax = a.hoursAfterTransfer === null ? Infinity : a.hoursAfterTransfer;
            const bx = b.hoursAfterTransfer === null ? Infinity : b.hoursAfterTransfer;
            return ax - bx;
        });

    if (scored.length === 0) return null;
    if (scored.length === 1) return { match: scored[0].job, confidence: 'fuzzy' };

    // Clear winner: top score beats runner-up by ≥0.1 OR same score but
    // at least 48h temporal gap (closer one wins clearly).
    const top = scored[0];
    const runner = scored[1];
    const scoreDelta = top.score - runner.score;
    const timeDelta = (runner.hoursAfterTransfer !== null && top.hoursAfterTransfer !== null)
        ? (runner.hoursAfterTransfer - top.hoursAfterTransfer)
        : 0;

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
