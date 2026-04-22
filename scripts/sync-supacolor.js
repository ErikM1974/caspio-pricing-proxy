#!/usr/bin/env node
/**
 * Supacolor Auto-Sync (Heroku Scheduler task)
 *
 * Hits POST /api/supacolor-jobs/sync/all on the same Heroku app every 10 min.
 * Pulls the Supacolor /Jobs/active stubs (active-only by default) and upserts
 * into Caspio — replaces the manual "Refresh from Supacolor API" button for
 * background coverage.
 *
 * Heroku Scheduler command: `npm run sync-supacolor`
 * Interval: Every 10 minutes
 *
 * Notes:
 *  - Active-only by default so each run stays under Caspio's rate limit.
 *    Closed/Cancelled history is already backfilled; new closures naturally
 *    flow through when shipped-signal (tracking or ship date) is set.
 *  - For a full historical resync (rare), run manually with includeClosed=true.
 *  - Logs a single summary line per run so Heroku logs stay readable.
 */

const axios = require('axios');

const BASE_URL = process.env.BASE_URL || 'https://caspio-pricing-proxy-ab30a049961a.herokuapp.com';
const SYNC_PATH = '/api/supacolor-jobs/sync/all';
const TIMEOUT_MS = 30000; // Matches Heroku HTTP timeout

async function main() {
    const started = Date.now();
    try {
        const resp = await axios.post(`${BASE_URL}${SYNC_PATH}`, {}, {
            headers: { 'Content-Type': 'application/json' },
            timeout: TIMEOUT_MS
        });
        const d = resp.data || {};
        const secs = ((Date.now() - started) / 1000).toFixed(1);
        console.log(
            `[sync-supacolor] ${secs}s — fetched=${d.fetched || 0}, ` +
            `inserted=${d.inserted || 0}, patched=${d.patched || 0}, ` +
            `noop=${d.noop || 0}, errored=${d.errored || 0}` +
            (d.timedOut ? ' (timedOut)' : '') +
            (d.errored ? ` — first errors: ${JSON.stringify((d.errors || []).slice(0, 3))}` : '')
        );
        if (d.errored && !d.fetched) process.exit(1);
    } catch (err) {
        const secs = ((Date.now() - started) / 1000).toFixed(1);
        const status = err.response && err.response.status;
        const body = err.response && err.response.data;
        console.error(
            `[sync-supacolor] ${secs}s FAILED — ` +
            (status ? `HTTP ${status}: ${JSON.stringify(body)}` : err.message)
        );
        process.exit(1);
    }
}

main();
