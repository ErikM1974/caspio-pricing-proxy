/**
 * Hourly cron: fallback sync for ShipStation tracking numbers.
 *
 * The primary path is the SHIP_NOTIFY webhook — ShipStation pings us when a
 * label is bought, we extract tracking#, write to Caspio. That works ~100%
 * of the time but isn't bulletproof (proxy down briefly, ShipStation outage,
 * webhook retry exhausted). This script is the safety net.
 *
 * What it does (thin caller — heavy logic in pricing-index):
 *   POST https://sanmar-inventory-app-4cd7b252508d.herokuapp.com/api/quote-sessions/bulk-sync-shipstation-tracking
 *
 * That endpoint:
 *   1. Pulls quote_sessions WHERE ShipStation_Order_ID IS NOT NULL AND
 *      ShipStation_Status != 'shipped' (orders in SS, not yet labeled)
 *   2. For each, calls proxy /api/shipstation/shipments?orderId={ssId}
 *   3. If a shipment exists with tracking# → write TrackingNumber +
 *      TrackingCarrier + TrackingURL + ShippedAt + LabelCost to Caspio
 *      (same fields the webhook writes — reuses /shipstation-tracking
 *      endpoint at server.js:5600)
 *   4. Slack-notify each newly-discovered shipped order
 *   5. Returns aggregate stats
 *
 * Why this lives next to sync-quote-sessions-from-shopworks.js:
 *   The proxy already has Heroku Scheduler installed for other sync jobs.
 *   Putting all our scheduled tasks here keeps the cron config in one place.
 *
 * Usage:
 *   node scripts/sync-shipstation-tracking.js                  # production
 *   node scripts/sync-shipstation-tracking.js --dry-run         # preview candidates
 *   node scripts/sync-shipstation-tracking.js --days-back=7     # narrower window
 *
 * Heroku Scheduler config:
 *   heroku addons:open scheduler --app caspio-pricing-proxy
 *   → Add Job:
 *     - Command:   node scripts/sync-shipstation-tracking.js
 *     - Frequency: Every hour
 *     - Next run:  top of hour (e.g. 09:00 UTC, 10:00 UTC, ...)
 *
 * Output:
 *   Logs to stdout + exit code 0 on success / 1 on error.
 *   Heroku log tail: heroku logs --tail --app caspio-pricing-proxy --source app
 */

'use strict';

const https = require('https');

const PRICING_INDEX_BASE = process.env.PRICING_INDEX_BASE_URL
  || 'https://sanmar-inventory-app-4cd7b252508d.herokuapp.com';

function getArg(flag, fallback) {
  const arg = process.argv.find(a => a.startsWith(`${flag}=`));
  if (arg) return arg.split('=')[1];
  return fallback;
}
const isDryRun = process.argv.includes('--dry-run');
const daysBack = Number(getArg('--days-back', 30));

async function callBulkSync(payload) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(payload);
    const url = new URL('/api/quote-sessions/bulk-sync-shipstation-tracking', PRICING_INDEX_BASE);
    const req = https.request(
      {
        method: 'POST',
        hostname: url.hostname,
        path: url.pathname,
        port: url.port || 443,
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(data),
        },
        timeout: 600000, // 10 min — bulk sync can take a while with many candidates
      },
      (res) => {
        let body = '';
        res.on('data', (chunk) => { body += chunk; });
        res.on('end', () => {
          try {
            const parsed = JSON.parse(body);
            if (res.statusCode >= 200 && res.statusCode < 300) {
              resolve(parsed);
            } else {
              reject(new Error(`HTTP ${res.statusCode}: ${body.substring(0, 500)}`));
            }
          } catch (e) {
            reject(new Error(`Parse error: ${e.message}, body: ${body.substring(0, 500)}`));
          }
        });
      }
    );
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Request timeout (10 min)'));
    });
    req.write(data);
    req.end();
  });
}

(async () => {
  const startedAt = Date.now();
  console.log(`[sync-shipstation-tracking] starting at ${new Date().toISOString()}`);
  console.log(`[sync-shipstation-tracking] target: ${PRICING_INDEX_BASE}`);
  console.log(`[sync-shipstation-tracking] daysBack=${daysBack} dryRun=${isDryRun}`);

  try {
    const result = await callBulkSync({ daysBack, dryRun: isDryRun });
    const elapsedSec = Math.round((Date.now() - startedAt) / 1000);

    if (isDryRun) {
      console.log(`[sync-shipstation-tracking] DRY RUN (${elapsedSec}s):`);
      console.log(`  Candidates (in-SS, not-yet-shipped): ${result.candidateCount}`);
      (result.candidates || []).forEach(c => {
        console.log(`    ${c.quoteId} SS#${c.shipstationOrderId} (${c.customer || 'no customer'})`);
      });
    } else {
      console.log(`[sync-shipstation-tracking] DONE in ${elapsedSec}s:`);
      console.log(`  Checked:           ${result.checked || 0}`);
      console.log(`  Newly shipped:     ${result.newlyShipped || 0}  ← webhook missed these`);
      console.log(`  Still in-transit:  ${result.stillPending || 0}`);
      console.log(`  Voided in SS:      ${result.voided || 0}`);
      console.log(`  Errors:            ${result.errors || 0}`);
      if (result.errors > 0 && result.errorDetails) {
        console.log('  Error details:');
        result.errorDetails.slice(0, 10).forEach(e => {
          console.log(`    ${e.quoteId}: ${e.error}`);
        });
      }
    }

    process.exit(0);
  } catch (e) {
    console.error(`[sync-shipstation-tracking] FAILED:`, e.message);
    console.error(e.stack);
    process.exit(1);
  }
})();
