#!/usr/bin/env node
/**
 * Quote→ShopWorks Sync Health Watchdog (Heroku Scheduler task)
 *
 * Hits POST /api/quote-sync-health/alert on the PRICING-INDEX app every hour
 * (offset from the :00 sync, e.g. at :30). The endpoint computes sync health
 * from the in-process record of the last bulk-sync run; if unhealthy it fires
 * a deduped Slack alert.
 *
 * Why this exists: the ManageOrders sync-back cron silently failed for weeks
 * (its localhost self-call was 302'd to https://localhost → ECONNREFUSED →
 * synced:0/errors:N every run, exit 0, no alarm). This watchdog turns that
 * exact signature (and "cron stopped firing" / "cron never scheduled") into a
 * page instead of a silent stale dashboard.
 *
 * Failure modes detected (reason field):
 *  - "no-sync-since-boot" — dyno up 150+ min but no bulk-sync ever ran
 *                           (Scheduler job missing/disabled)
 *  - "stale-cron"         — last successful bulk-sync was 90+ min ago
 *  - "sync-errors"        — last bulk-sync returned errors>0 (the ECONNREFUSED
 *                           regression signature)
 *  - "sync-noop"          — last bulk-sync had candidates but synced 0
 *  - combinations joined with "+"
 *
 * Heroku Scheduler command: `npm run check-quote-sync-health`
 * Recommended interval: Hourly at :30 (offset from the :00 sync, one run grace).
 *
 * Activation requires `SLACK_QUOTE_SYNC_HEALTH_WEBHOOK_URL` on the PRICING-INDEX
 * Heroku app (sanmar-inventory-app). Without it the endpoint still runs but the
 * notify is a no-op (skipped='no-webhook') — safe to ship before the Slack
 * channel/webhook exists.
 *
 * Logs a single summary line per run; exit 1 on unhealthy so the failure
 * surfaces in Heroku logs.
 */

const axios = require('axios');

// The sync-back endpoints live on pricing-index, not the proxy — keep the same
// env-var/default convention as sync-quote-sessions-from-shopworks.js.
const PRICING_INDEX_BASE = process.env.PRICING_INDEX_BASE_URL
  || 'https://sanmar-inventory-app-4cd7b252508d.herokuapp.com';
const ALERT_PATH = '/api/quote-sync-health/alert';
const TIMEOUT_MS = 30000;

async function main() {
  const started = Date.now();
  try {
    const resp = await axios.post(`${PRICING_INDEX_BASE}${ALERT_PATH}`, {}, {
      headers: { 'Content-Type': 'application/json' },
      timeout: TIMEOUT_MS,
    });
    const d = resp.data || {};
    const secs = ((Date.now() - started) / 1000).toFixed(1);
    const health = d.ok ? 'OK' : `UNHEALTHY (${d.reason})`;
    const notify = d.notify
      ? (d.notify.sent ? 'alert sent' :
         d.notify.skipped ? `skipped:${d.notify.skipped}` :
         d.notify.error ? `notify-fail:${d.notify.error}` : 'no-notify')
      : 'no-notify';
    const r = d.lastSyncResult || {};
    console.log(
      `[check-quote-sync-health] ${secs}s — ${health}, ` +
      `coldStart=${d.coldStart}, lastSyncAgo=${d.lastSyncAgo_min}m, ` +
      `synced=${r.synced} errors=${r.errors} candidates=${r.candidateCount}, ` +
      `notify=${notify}`
    );
    if (!d.ok) process.exit(1); // Surface unhealthy state in Heroku exit codes.
  } catch (err) {
    const secs = ((Date.now() - started) / 1000).toFixed(1);
    const status = err.response && err.response.status;
    const body = err.response && err.response.data;
    console.error(
      `[check-quote-sync-health] ${secs}s FAILED — ` +
      (status ? `HTTP ${status}: ${JSON.stringify(body)}` : err.message)
    );
    process.exit(1);
  }
}

main();
