#!/usr/bin/env node
/**
 * Caspio Integrations-quota pacing watchdog (Heroku Scheduler task)
 *
 * Hits POST /api/admin/usage/alert once a day. The endpoint works out where we
 * are in Caspio's 27th→26th billing period, projects the period total against
 * the 500,000 cap, and DMs Erik on Slack when the projection reaches 90% — early
 * enough to act, rather than after the overage is already billed.
 *
 * WHY: invoice AI-334269 (2026-07-26) billed 178,874 calls over the cap, $358,
 * with no prior warning. Nothing was ignored — there was simply no signal for 30
 * days. This is the signal.
 *
 * Heroku Scheduler command: `npm run check-caspio-usage`
 * Recommended interval: **Daily**. A pacing check has no reason to run more
 * often, and Heroku Scheduler only offers 10 min / hourly / daily anyway.
 *
 * ACCURACY: with API_USAGE_ROLLUP_TABLE set, period-to-date is summed across all
 * dynos from Caspio and is trustworthy. Without it the endpoint falls back to a
 * single dyno's in-memory counter since its last restart — a LOWER BOUND, and the
 * Slack message says so. Caspio's own Plan-and-billing → Usage page remains the
 * source of truth for the billed total; this watchdog exists to tell you to go
 * look at it, and to name which tables are responsible.
 *
 * Slack DM needs SLACK_BOT_TOKEN (with users:read.email, since Erik is not in the
 * hardcoded EMAIL_TO_SLACK_ID map). Without it the alert is a no-op
 * (skipped:'no-token') — the check still runs and still logs.
 *
 * Exits 1 when pacing is over threshold, so a red run surfaces in the Scheduler log.
 *
 * Design doc: pricing-index repo memory/caspio-api-usage-audit-2026-07.md
 */

const axios = require('axios');

const BASE_URL = process.env.BASE_URL || 'https://caspio-pricing-proxy-ab30a049961a.herokuapp.com';
const ALERT_PATH = '/api/admin/usage/alert';
const SECRET = process.env.CRM_API_SECRET || process.env.API_SECRET || '';
const TIMEOUT_MS = 30000;

async function main() {
    const started = Date.now();

    if (!SECRET) {
        // The route is secret-gated; without the secret every run would 401. Fail
        // loudly rather than logging a green "checked, nothing to report".
        console.error('[check-caspio-usage] FAILED — CRM_API_SECRET is not set on this app.');
        process.exit(1);
    }

    try {
        const resp = await axios.post(`${BASE_URL}${ALERT_PATH}`, {}, {
            headers: { 'Content-Type': 'application/json', 'x-crm-api-secret': SECRET },
            timeout: TIMEOUT_MS
        });

        const d = resp.data || {};
        const p = d.data || {};
        const secs = ((Date.now() - started) / 1000).toFixed(1);
        const notify = d.notify
            ? (d.notify.sent ? 'DM sent'
                : d.notify.skipped ? `skipped:${d.notify.skipped}`
                : d.notify.error ? `notify-fail:${d.notify.error}` : 'no-notify')
            : 'no-notify';

        console.log(
            `[check-caspio-usage] ${secs}s — mode=${p.mode} ` +
            `day ${p.period && p.period.daysElapsed}/${p.period && p.period.daysInPeriod}, ` +
            `periodToDate=${p.periodToDate}, projected=${p.projected}/${p.monthlyLimit} ` +
            `(${p.percentOfLimit}%), budget=${p.budgetPerDay}/day, ` +
            `alert=${d.alerted}, notify=${notify}` +
            (p.rollupError ? `, ROLLUP READ FAILED: ${p.rollupError}` : '') +
            (p.mode === 'dyno' ? ' [single-dyno lower bound — set API_USAGE_ROLLUP_TABLE]' : '')
        );

        // A failed rollup read is its own problem: it silently downgrades the
        // number the alert threshold is judged against.
        if (p.rollupError) process.exit(1);
        if (d.alerted) process.exit(1); // Red exit surfaces in Heroku Scheduler logs.
    } catch (err) {
        const secs = ((Date.now() - started) / 1000).toFixed(1);
        const status = err.response && err.response.status;
        const body = err.response && err.response.data;
        console.error(
            `[check-caspio-usage] ${secs}s FAILED — ` +
            (status ? `HTTP ${status}: ${JSON.stringify(body)}` : err.message)
        );
        process.exit(1);
    }
}

main();
