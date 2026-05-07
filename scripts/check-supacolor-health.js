#!/usr/bin/env node
/**
 * Supacolor Sync Health Watchdog (Heroku Scheduler task)
 *
 * Hits POST /api/supacolor-jobs/health/alert on the same Heroku app every
 * 30 min. The endpoint computes sync health from a single Caspio scan; if
 * unhealthy, it fires a Zapier webhook → Slack DM to Erik.
 *
 * Failure modes detected:
 *  - "stale-cron"      — 10-min sync hasn't touched any api-sourced row
 *                        in > 25 min (Heroku Scheduler disabled, OAuth
 *                        token expired, Supacolor API down)
 *  - "stuck-open-jobs" — > 5 jobs stuck Status='Open' for 30+ days
 *                        (means recent closures aren't being captured)
 *  - "both"
 *
 * Heroku Scheduler command: `npm run check-supacolor-health`
 * Recommended interval: Every 30 minutes (covers two sync ticks of grace)
 *
 * Activation requires `ZAPIER_SUPACOLOR_HEALTH_WEBHOOK_URL` env var on the
 * Heroku app. Without it the endpoint runs but the notify is a no-op
 * (skipped='no-webhook') — useful for staging or for shipping the script
 * before the Zap exists.
 *
 * Logs a single summary line per run.
 */

const axios = require('axios');

const BASE_URL = process.env.BASE_URL || 'https://caspio-pricing-proxy-ab30a049961a.herokuapp.com';
const ALERT_PATH = '/api/supacolor-jobs/health/alert';
const TIMEOUT_MS = 30000;

async function main() {
    const started = Date.now();
    try {
        const resp = await axios.post(`${BASE_URL}${ALERT_PATH}`, {}, {
            headers: { 'Content-Type': 'application/json' },
            timeout: TIMEOUT_MS
        });
        const d = resp.data || {};
        const secs = ((Date.now() - started) / 1000).toFixed(1);
        const health = d.ok ? 'OK' : `UNHEALTHY (${d.reason})`;
        const notify = d.notify
            ? (d.notify.sent ? 'DM sent' :
               d.notify.skipped ? `skipped:${d.notify.skipped}` :
               d.notify.error ? `notify-fail:${d.notify.error}` : 'no-notify')
            : 'no-notify';
        console.log(
            `[check-supacolor-health] ${secs}s — ${health}, ` +
            `lastSyncAgo=${d.lastSyncAgo_min}m, ` +
            `stuckOpen=${d.stuckOpenCount}, ` +
            `apiRows=${d.totalApiRows}, ` +
            `notify=${notify}`
        );
        if (!d.ok) process.exit(1); // Surface unhealthy state in Heroku exit codes for log monitoring.
    } catch (err) {
        const secs = ((Date.now() - started) / 1000).toFixed(1);
        const status = err.response && err.response.status;
        const body = err.response && err.response.data;
        console.error(
            `[check-supacolor-health] ${secs}s FAILED — ` +
            (status ? `HTTP ${status}: ${JSON.stringify(body)}` : err.message)
        );
        process.exit(1);
    }
}

main();
