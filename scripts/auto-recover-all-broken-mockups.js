#!/usr/bin/env node
/**
 * scripts/auto-recover-all-broken-mockups.js
 *
 * Nightly proactive sweep: pulls every record currently flagged as having a
 * broken Box mockup link (across BOTH Steve's ArtRequests + Ruth's
 * Digitizing_Mockups), then runs the slot-aware bulk recovery on each
 * (record, slot) pair. Self-heals everything that's healable BEFORE staff
 * opens the dashboard in the morning.
 *
 * Designed for Heroku Scheduler. Run via:
 *     npm run auto-recover-all-broken-mockups
 *
 * Recommended schedule: Daily at 06:00 UTC (~10 PM Pacific previous day,
 * gets done overnight before Steve's day starts at ~7 AM Pacific).
 *
 * Behavior:
 *   • Hits its own /api/.../broken-mockups?status=all endpoints (works on
 *     dyno startup the same way the daily-digest cron does).
 *   • Batches bulk-recovery calls in groups of 5 to stay under Heroku's
 *     30s request timeout (each entry needs 1-3 Box API calls).
 *   • Idempotent: rerunning the same day is harmless (already-recovered
 *     records won't appear in the broken list on the next pass).
 *   • Records that fail recovery WILL fire Slack DMs via the existing
 *     notify wiring (recover-broken-mockup.js / recover-broken-ruth-mockup.js).
 *     The dedup window (24h per design+slot) prevents Steve from getting
 *     paged twice for the same broken record between manual + scheduled runs.
 *
 * Exit codes:
 *   0 — sweep RAN (regardless of how many records failed recovery)
 *   1 — script crashed (unhandled error) OR the sweep was BLIND (a broken-list
 *       fetch failed, e.g. 401 from the gated endpoint) — in the blind case a
 *       Slack alert also fires to #mockup-alerts (alertSweepBlind).
 *
 * NEVER use exit codes to signal "broken records exist" — that would noise
 * Heroku Scheduler's failure log every morning.
 */

const axios = require('axios');

// Where to call. In production this is the Heroku app's own URL — the script
// runs as a one-off dyno alongside the web dyno, so we hit our own public
// hostname (Heroku's HEROKU_APP_NAME env var if set, else hardcoded fallback).
const APP_URL = process.env.PUBLIC_BASE_URL
    || (process.env.HEROKU_APP_NAME ? `https://${process.env.HEROKU_APP_NAME}.herokuapp.com` : null)
    || 'https://caspio-pricing-proxy-ab30a049961a.herokuapp.com';

// 2026-07-07: the broken-mockups GETs are gated by requireCrmSecretOrBrowserOrigin
// (PII side-door sealing wave). A one-off dyno sends neither a browser Origin nor
// the secret, so WITHOUT this header every fetch 401s and the sweep silently
// no-ops ("0/0 recovered", exit 0) — exactly how the nightly cron died unnoticed
// between the gating deploy and 2026-07-07. Server-to-server callers authenticate
// with the shared secret, per the gate's own contract (src/middleware/index.js).
const AUTH_HEADERS = process.env.CRM_API_SECRET
    ? { 'X-CRM-API-Secret': process.env.CRM_API_SECRET }
    : {};

// Heroku request timeout is 30s. Each (record, slot) recovery is 1-3 Box API
// calls (~3-5s avg). 5 entries per batch ≈ 15-25s total per call → safe margin.
const BATCH_SIZE = 5;
const PACING_MS = 500;

// A sweep that cannot even SEE the broken list is a dead watchdog — page a human
// (same #mockup-alerts webhook the per-record failures use) and exit non-zero so
// Heroku Scheduler's log shows red. Fire-and-forget; never throws.
async function alertSweepBlind(failures) {
    const hook = process.env.SLACK_BROKEN_MOCKUP_WEBHOOK_URL || '';
    const text = ':rotating_light: *Mockup recovery sweep is BLIND* — '
        + failures.map(f => `${f.table} broken-list fetch failed (${f.error})`).join('; ')
        + '. The nightly self-heal did NOT run. Check auth headers / gating on '
        + '/api/art-requests/broken-mockups (scripts/auto-recover-all-broken-mockups.js).';
    console.error(text);
    if (!hook) return;
    try {
        await axios.post(hook, { text }, { timeout: 10_000 });
    } catch (err) {
        console.error(`Slack blind-sweep alert failed too: ${err.message}`);
    }
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function fetchBrokenList(table) {
    const path = table === 'art-requests'
        ? '/api/art-requests/broken-mockups'
        : '/api/mockups/broken-mockups';
    const url = `${APP_URL}${path}?status=all&refresh=true`;
    const resp = await axios.get(url, { timeout: 60_000, headers: AUTH_HEADERS });
    return resp.data;
}

function flattenSteveEntries(brokenList) {
    const out = [];
    for (const r of (brokenList.results || [])) {
        for (const s of (r.brokenSlots || [])) {
            out.push({
                pkId: r.pkId,
                designNumber: r.designNumSw,
                companyName: r.companyName,
                slotField: s.field
            });
        }
    }
    return out;
}

function flattenRuthEntries(brokenList) {
    const out = [];
    for (const r of (brokenList.results || [])) {
        for (const s of (r.brokenSlots || [])) {
            out.push({
                id: r.id,
                slotField: s.field,
                designNumber: r.designNumber,
                companyName: r.companyName
            });
        }
    }
    return out;
}

async function bulkRecoverSteve(entries) {
    if (entries.length === 0) return { recovered: 0, total: 0, results: [] };
    const url = `${APP_URL}/api/art-requests/auto-recover-mockups-bulk`;
    const allResults = [];
    let totalRecovered = 0;
    for (let i = 0; i < entries.length; i += BATCH_SIZE) {
        const batch = entries.slice(i, i + BATCH_SIZE);
        try {
            const resp = await axios.post(url, { records: batch }, {
                timeout: 60_000,
                headers: { 'Content-Type': 'application/json', ...AUTH_HEADERS }
            });
            const data = resp.data || {};
            totalRecovered += (data.recovered || 0);
            allResults.push(...(data.results || []));
            console.log(`[steve] batch ${Math.floor(i / BATCH_SIZE) + 1}: ${data.recovered || 0}/${batch.length} recovered`);
        } catch (err) {
            const msg = err.response?.status ? `HTTP ${err.response.status}` : err.message;
            console.warn(`[steve] batch ${Math.floor(i / BATCH_SIZE) + 1} failed: ${msg}`);
            for (const e of batch) {
                allResults.push({ ...e, status: 'request-failed', error: msg });
            }
        }
        await sleep(PACING_MS);
    }
    return { recovered: totalRecovered, total: entries.length, results: allResults };
}

async function bulkRecoverRuth(entries) {
    if (entries.length === 0) return { recovered: 0, total: 0, results: [] };
    const url = `${APP_URL}/api/mockups/auto-recover-mockups-bulk`;
    const allResults = [];
    let totalRecovered = 0;
    for (let i = 0; i < entries.length; i += BATCH_SIZE) {
        const batch = entries.slice(i, i + BATCH_SIZE);
        try {
            const resp = await axios.post(url, { entries: batch }, {
                timeout: 60_000,
                headers: { 'Content-Type': 'application/json', ...AUTH_HEADERS }
            });
            const data = resp.data || {};
            totalRecovered += (data.recovered || 0);
            allResults.push(...(data.results || []));
            console.log(`[ruth]  batch ${Math.floor(i / BATCH_SIZE) + 1}: ${data.recovered || 0}/${batch.length} recovered`);
        } catch (err) {
            const msg = err.response?.status ? `HTTP ${err.response.status}` : err.message;
            console.warn(`[ruth]  batch ${Math.floor(i / BATCH_SIZE) + 1} failed: ${msg}`);
            for (const e of batch) {
                allResults.push({ ...e, status: 'request-failed', error: msg });
            }
        }
        await sleep(PACING_MS);
    }
    return { recovered: totalRecovered, total: entries.length, results: allResults };
}

function summarize(label, summary) {
    const failed = (summary.results || []).filter(r => r.status !== 'recovered');
    const reasons = {};
    for (const r of failed) {
        const k = r.status || 'unknown';
        reasons[k] = (reasons[k] || 0) + 1;
    }
    const reasonStr = Object.keys(reasons).length
        ? ' [' + Object.entries(reasons).map(([k, v]) => `${k}:${v}`).join(' ') + ']'
        : '';
    console.log(`${label} TOTAL: ${summary.recovered}/${summary.total} recovered${reasonStr}`);
}

async function main() {
    const startedAt = new Date().toISOString();
    console.log(`=== auto-recover-all-broken-mockups @ ${startedAt} ===`);
    console.log(`APP_URL: ${APP_URL}`);
    console.log('');

    // A failed broken-list fetch means the sweep is flying blind for that table —
    // collected here and escalated (Slack + exit 1) at the end instead of being
    // silently treated as "nothing to recover" (the 2026-07 401 incident).
    const fetchFailures = [];

    // Steve / ArtRequests
    console.log('--- Steve (ArtRequests) ---');
    let steveBroken;
    try {
        steveBroken = await fetchBrokenList('art-requests');
        console.log(`Found ${steveBroken.broken} broken records (${steveBroken.checked} scanned)`);
    } catch (err) {
        console.error(`Steve broken-mockups fetch failed: ${err.message}`);
        fetchFailures.push({ table: 'Steve/ArtRequests', error: err.response?.status ? `HTTP ${err.response.status}` : err.message });
        steveBroken = { results: [] };
    }
    const steveEntries = flattenSteveEntries(steveBroken);
    console.log(`Slot entries to recover: ${steveEntries.length}`);
    const steveResult = await bulkRecoverSteve(steveEntries);
    summarize('[steve]', steveResult);
    console.log('');

    // Ruth / Digitizing_Mockups
    console.log('--- Ruth (Digitizing_Mockups) ---');
    let ruthBroken;
    try {
        ruthBroken = await fetchBrokenList('mockups');
        console.log(`Found ${ruthBroken.broken} broken records (${ruthBroken.checked} scanned)`);
    } catch (err) {
        console.error(`Ruth broken-mockups fetch failed: ${err.message}`);
        fetchFailures.push({ table: 'Ruth/Digitizing_Mockups', error: err.response?.status ? `HTTP ${err.response.status}` : err.message });
        ruthBroken = { results: [] };
    }
    const ruthEntries = flattenRuthEntries(ruthBroken);
    console.log(`Slot entries to recover: ${ruthEntries.length}`);
    const ruthResult = await bulkRecoverRuth(ruthEntries);
    summarize('[ruth] ', ruthResult);
    console.log('');

    const totalRecovered = steveResult.recovered + ruthResult.recovered;
    const totalAttempted = steveResult.total + ruthResult.total;
    console.log(`=== DONE: ${totalRecovered}/${totalAttempted} slot recoveries succeeded ===`);

    // Exit 0 when the sweep RAN — unrecoverable records are a normal operational
    // state, not a script failure. But a sweep that couldn't fetch its work list
    // never ran at all: page a human and go red in the Scheduler log.
    if (fetchFailures.length > 0) {
        await alertSweepBlind(fetchFailures);
        process.exit(1);
    }
}

process.on('unhandledRejection', (err) => {
    console.error('UNHANDLED:', err);
    process.exit(1);
});

main().catch((err) => {
    console.error('FATAL:', err);
    process.exit(1);
});
