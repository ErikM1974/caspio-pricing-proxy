#!/usr/bin/env node
/**
 * ShopWorks ODBC Sync Health Watchdog (Heroku Scheduler task)
 *
 * Hits POST /api/shopworks-odbc/health/alert every 30 min. The endpoint reads
 * the Sync_Heartbeats row for 'shopworks-odbc-orders' (stamped by the bandit
 * agent's every-15-min run — even 0-row runs stamp it) and DMs Erik on Slack
 * when the heartbeat is > 45 min old.
 *
 * Failure modes detected:
 *  - bandit powered off / asleep
 *  - Task Scheduler job disabled or failing
 *  - FileMaker xDBC listener wedged (agent can't query)
 *  - agent can't reach the proxy (LAN outage)
 *
 * Heroku Scheduler command: `npm run check-shopworks-odbc-health`
 * Recommended interval: Every 30 minutes.
 *
 * Slack DM requires SLACK_BOT_TOKEN on the app (already used by the AE
 * digitizing notifications). Without it the alert is a no-op (skipped:'no-token').
 *
 * Design doc: pricing-index repo memory/SHOPWORKS_ODBC_INTEGRATION.md
 */

const axios = require('axios');

const BASE_URL = process.env.BASE_URL || 'https://caspio-pricing-proxy-ab30a049961a.herokuapp.com';
const ALERT_PATH = '/api/shopworks-odbc/health/alert';
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
            `[check-shopworks-odbc-health] ${secs}s — ${health}, ` +
            `lastSuccess=${d.lastSuccess}, ageMin=${d.ageMin}, ` +
            `lastRows=${d.lastRows}, notify=${notify}`
        );
        if (!d.ok) process.exit(1); // Red exit surfaces in Heroku Scheduler logs.
    } catch (err) {
        const secs = ((Date.now() - started) / 1000).toFixed(1);
        const status = err.response && err.response.status;
        const body = err.response && err.response.data;
        console.error(
            `[check-shopworks-odbc-health] ${secs}s FAILED — ` +
            (status ? `HTTP ${status}: ${JSON.stringify(body)}` : err.message)
        );
        process.exit(1);
    }
}

main();
