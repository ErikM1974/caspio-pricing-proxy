/**
 * Hourly cron: sync all Processed quote_sessions from the last 30 days
 * against ManageOrders /v1 state.
 *
 * What it does (all the heavy lifting is in pricing-index, not here):
 *   POST https://sanmar-inventory-app-4cd7b252508d.herokuapp.com/api/quote-sessions/bulk-sync-from-shopworks
 *
 * That endpoint:
 *   1. Pulls every quote_sessions row with Status='Processed' from last 30 days
 *   2. Filters to ones with ShopWorks_Last_Synced NULL or > 30 min ago
 *   3. For each, calls /sync-from-shopworks (which hits the MO snapshot endpoint)
 *   4. Writes ShopWorks_* columns + hard-deletes rows where SW deleted the order
 *   5. Throttles 1s between requests (MO rate limits)
 *   6. Returns aggregate stats
 *
 * Why this script lives in the PROXY repo (not pricing-index):
 *   The proxy already has Heroku Scheduler installed for other sync jobs.
 *   This script is a thin HTTP caller, so it works equally well on either
 *   side. Putting it next to the supacolor sync cron keeps all our scheduled
 *   tasks in one place.
 *
 * Usage:
 *   node scripts/sync-quote-sessions-from-shopworks.js                 # production
 *   node scripts/sync-quote-sessions-from-shopworks.js --dry-run        # preview candidates without syncing
 *   node scripts/sync-quote-sessions-from-shopworks.js --days-back=14   # change window
 *
 * Heroku Scheduler config:
 *   heroku addons:open scheduler --app caspio-pricing-proxy
 *   → Add Job:
 *     - Command: node scripts/sync-quote-sessions-from-shopworks.js
 *     - Frequency: Hourly
 *     - Next run: top of hour
 *
 * Output:
 *   Logs to stdout + exit code 0 on success / 1 on error.
 *   Heroku log tail: heroku logs --tail --app caspio-pricing-proxy --source app
 */

'use strict';

const https = require('https');

const PRICING_INDEX_BASE = process.env.PRICING_INDEX_BASE_URL
  || 'https://sanmar-inventory-app-4cd7b252508d.herokuapp.com';

// Parse CLI args
function getArg(flag, fallback) {
  const arg = process.argv.find(a => a.startsWith(`${flag}=`));
  if (arg) return arg.split('=')[1];
  return fallback;
}
const isDryRun = process.argv.includes('--dry-run');
const daysBack = Number(getArg('--days-back', 30));
const olderThanMin = Number(getArg('--older-than-min', 30));

async function callBulkSync(payload) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(payload);
    const url = new URL('/api/quote-sessions/bulk-sync-from-shopworks', PRICING_INDEX_BASE);
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
        timeout: 600000, // 10 min — bulk sync can take a while
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
  console.log(`[sync-quote-sessions] starting at ${new Date().toISOString()}`);
  console.log(`[sync-quote-sessions] target: ${PRICING_INDEX_BASE}`);
  console.log(`[sync-quote-sessions] daysBack=${daysBack} olderThanMin=${olderThanMin} dryRun=${isDryRun}`);

  try {
    const result = await callBulkSync({
      daysBack,
      olderThanMin,
      dryRun: isDryRun,
    });

    const elapsedSec = Math.round((Date.now() - startedAt) / 1000);
    if (isDryRun) {
      console.log(`[sync-quote-sessions] DRY RUN result (${elapsedSec}s):`);
      console.log(`  Total Processed in last ${daysBack}d: ${result.totalProcessedInWindow}`);
      console.log(`  Stale (would sync):                   ${result.candidateCount}`);
      console.log('  Sample candidates:');
      (result.candidates || []).forEach(c => {
        console.log(`    ${c.quoteId} (${c.customer || 'no customer'}) lastSynced=${c.lastSynced || 'never'} status=${c.status || '(none)'}`);
      });
    } else {
      console.log(`[sync-quote-sessions] DONE in ${elapsedSec}s:`);
      console.log(`  Synced:    ${result.synced || 0}`);
      console.log(`  Imported:  ${result.imported || 0}`);
      console.log(`  Deleted:   ${result.deleted || 0}`);
      console.log(`  Pending:   ${result.pending || 0}`);
      console.log(`  Errors:    ${result.errors || 0}`);
      if (result.errors > 0 && result.errorDetails) {
        console.log('  Error details:');
        result.errorDetails.slice(0, 10).forEach(e => {
          console.log(`    ${e.quoteId}: ${e.error}`);
        });
      }
    }

    process.exit(0);
  } catch (e) {
    console.error(`[sync-quote-sessions] FAILED:`, e.message);
    console.error(e.stack);
    process.exit(1);
  }
})();
