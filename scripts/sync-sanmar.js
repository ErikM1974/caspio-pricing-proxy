#!/usr/bin/env node
/**
 * NWCA SanMar Order & Invoice Sync
 *
 * Syncs SanMar order statuses, shipments, and invoices to Caspio tables.
 * - Orders: allOpen on Mondays, lastUpdate (1 day) other days
 * - Invoices: GetInvoices (incremental) nightly
 *
 * Usage:
 *   npm run sync-sanmar                          # Normal daily sync (orders + invoices)
 *   npm run sync-sanmar -- --full                # Force allOpen (full) order sync
 *   npm run sync-sanmar -- --backfill 90         # Backfill orders (N days)
 *   npm run sync-sanmar -- --backfill-invoices 90 # Backfill invoices (N days)
 *   npm run sync-sanmar -- --status              # Check table counts and sync health
 *
 * Environment:
 *   BASE_URL - API base URL (defaults to Heroku production)
 *   CRM_API_SECRET - Required authentication secret
 *
 * Heroku Scheduler:
 *   Run daily at 5 AM Pacific (13:00 UTC): npm run sync-sanmar
 */

const axios = require('axios');

const BASE_URL = process.env.BASE_URL || 'https://caspio-pricing-proxy-ab30a049961a.herokuapp.com';
const CRM_API_SECRET = process.env.CRM_API_SECRET;
const TIMEOUT = 300000; // 5 minutes

if (!CRM_API_SECRET) {
  console.error('ERROR: CRM_API_SECRET environment variable is required');
  console.error('This should be set as a Heroku config var.');
  process.exit(1);
}

const AUTH_HEADERS = {
  'Content-Type': 'application/json',
  'x-api-secret': CRM_API_SECRET
};

// Heroku's ROUTER kills any web request at 30 s (H12) regardless of the client timeout —
// the 5-minute axios timeout below has never once applied. Measured 2026-07-31, twice:
// POST /sync returns 503 at 30.36 s. The dyno KEEPS PROCESSING after the router gives up,
// so the sync itself finishes; only our view of it dies.
//
// That 503 used to throw straight out of this function, and because main() ran all six
// phases under ONE try/catch, everything after it was skipped — including
// syncRecentCompleted(), which exists precisely to ingest orders that never made it into
// the table. The single slowest phase was silently disabling its own safety net.
function isRouterTimeout(err) {
  return err.code === 'ECONNABORTED'
    || err.code === 'ETIMEDOUT'
    || (err.response && err.response.status === 503);
}

// After an H12 the work continues on the dyno. Wait for it to land so the later phases
// run against finished data instead of a half-written table. Bounded — never hangs the job.
async function waitForSyncToSettle(startedAtMs, maxWaitMs = 4 * 60 * 1000) {
  const deadline = Date.now() + maxWaitMs;
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 10000));
    try {
      const s = await axios.get(`${BASE_URL}/api/sanmar-orders/status-summary`, { timeout: 15000 });
      const last = Date.parse((s.data || {}).lastSync || '');
      if (Number.isFinite(last) && last >= startedAtMs) return true;
    } catch (e) { /* keep waiting; a poll blip is not a failure */ }
  }
  return false;
}

async function syncOrders(full = false) {
  const url = `${BASE_URL}/api/sanmar-orders/sync${full ? '?full=true' : ''}`;
  console.log(`\n[${new Date().toISOString()}] Starting order sync (${full ? 'full' : 'incremental'})...`);
  const startedAtMs = Date.now();

  let result;
  try {
    const response = await axios.post(url, {}, { headers: AUTH_HEADERS, timeout: TIMEOUT });
    result = response.data;
  } catch (err) {
    if (!isRouterTimeout(err)) throw err;
    console.log(`  Router timed out at 30s (H12) — expected; the dyno is still syncing.`);
    const settled = await waitForSyncToSettle(startedAtMs);
    console.log(settled
      ? `  Server-side sync completed (confirmed via status-summary). Status: SUCCESS (after H12)`
      : `  Could not confirm completion within 4 min — continuing anyway so the catch-up phases still run.`);
    return { viaH12: true, settled };
  }

  console.log(`  Orders found: ${result.ordersFound || 0}`);
  console.log(`  Orders upserted: ${result.ordersUpserted || 0}`);
  console.log(`  Shipments updated: ${result.shipmentsUpdated || 0}`);
  console.log(`  Status: SUCCESS`);
  return result;
}

// Daily short backfill (Erik 2026-08-05). The incremental order sync looks back 24 HOURS,
// and Monday's run uses allOpen — which EXCLUDES Complete orders. An order that closes over
// a weekend therefore falls through BOTH windows and never enters the table: PO 113847 was
// still missing 2.4 hours after Monday 8/3's sync had run, and had to be pulled by hand.
// Four consecutive days of reconciling SanMar's PSST manifest ended the same way — a manual
// `backfill?days=3` closed the gap every time, in about 15 seconds.
//
// So the thing that kept working by hand now runs on the schedule. Deliberately WIDE (5 days,
// not 3): it has to span an ordinary weekend AND a Monday holiday without special-casing a
// calendar, and re-covering a day costs almost nothing because the backfill upserts. Measured
// ~27 orders per run, roughly 1% of the daily Caspio budget.
//
// Runs FIRST, before the catch-up phases, so they operate on the fuller order set.
// Async endpoint (returns 202) + poll, so it never trips Heroku's 30s web timeout.
const BACKFILL_DAYS = parseInt(process.env.SANMAR_BACKFILL_DAYS, 10) || 5;
async function syncDailyBackfill() {
  console.log(`\n[${new Date().toISOString()}] Daily short backfill (${BACKFILL_DAYS} days — spans weekends/holiday Mondays)...`);
  let resp;
  try {
    resp = await axios.post(`${BASE_URL}/api/sanmar-orders/backfill?days=${BACKFILL_DAYS}`, {},
      { headers: AUTH_HEADERS, timeout: 30000 });
  } catch (e) {
    // 409 = a backfill is already running (a hand-run, or a previous job still going).
    // That is not a failure: the work we wanted is happening. Don't start a second one.
    if (e.response && e.response.status === 409) {
      console.log('  A backfill is already in progress — leaving it to finish. Status: SKIPPED');
      return;
    }
    throw e;
  }
  const result = await pollBackfillStatus('/api/sanmar-orders/backfill-status', 'Daily Backfill');
  if (result && result.error) {
    console.log(`  Backfill reported an error: ${result.error}`);
    return;
  }
  if (result) {
    console.log(`  Backfill: ${result.ordersSaved || 0} order(s) upserted, ${result.shipmentsSaved || 0} shipment(s), ${result.errors || 0} error(s). Status: SUCCESS`);
  } else {
    console.log('  Backfill still running after the poll window — it continues on the dyno.');
  }
}

// Catch-up shipment pull (Erik 2026-06-16). The incremental order sync above only
// re-touches orders whose STATUS changed, so an order that shipped without an
// order-status change never gets its tracking pulled — its Inbound dot stays
// "confirmed" until the weekly full sync. This drains the bounded /sync-shipments
// endpoint in rounds (each < Heroku's 30s limit) so those self-heal daily. Wrapped
// non-fatal so a hiccup here never fails the main sync.
async function syncPendingShipments() {
  console.log(`\n[${new Date().toISOString()}] Catch-up shipment pull (status-unchanged shipped orders)...`);
  const maxRounds = 6; // up to ~48 POs/run
  let totalAdded = 0, totalChecked = 0;
  // Walk the cursor. Rounds used to drain on their own because pulling tracking for a
  // PO removed it from `pending` — but a PO being RE-checked for a straggler carton
  // stays pending until its ship date ages out, so without `offset` every round would
  // re-poll the same first 8 forever (2026-08-03).
  let offset = 0;
  for (let round = 1; round <= maxRounds; round++) {
    let r;
    try {
      const resp = await axios.post(`${BASE_URL}/api/sanmar-orders/sync-shipments?limit=8&offset=${offset}`, {},
        { headers: AUTH_HEADERS, timeout: TIMEOUT });
      r = resp.data || {};
    } catch (e) {
      console.log(`  round ${round} error (non-fatal): ${e.response?.data?.error || e.message}`);
      break;
    }
    totalAdded += r.shipmentsAdded || 0;
    totalChecked += r.checked || 0;
    console.log(`  round ${round} (offset ${offset}): checked ${r.checked || 0}, +${r.shipmentsAdded || 0} tracking, ${r.remaining || 0} remaining`);
    if (!r.remaining || (r.checked || 0) === 0) break;
    offset = typeof r.nextOffset === 'number' ? r.nextOffset : offset + (r.checked || 0);
  }
  console.log(`  Catch-up: +${totalAdded} tracking rows (${totalChecked} POs checked). Status: SUCCESS`);
}

// Recently-completed catch-up (Erik 2026-06-26). allOpen excludes Complete and the
// daily lastUpdate@24h can miss an order that races placed→shipped→Complete between
// sync windows — it then never enters the table at all, so no quote-view tracking, no
// inbound dot, no daily-shipments row (real case: PO 113470 / WO 142292). This drains
// the bounded /sync-recent-completed endpoint (invoice-discovered orders, fully ingested)
// in rounds. Non-fatal so a hiccup never fails the main sync.
async function syncRecentCompleted() {
  console.log(`\n[${new Date().toISOString()}] Recently-completed catch-up (async; lastUpdate-wide + invoice discovery)...`);
  // ASYNC endpoint (Erik 2026-06-26): kick off (returns 202 fast) then poll the status
  // endpoint. The work runs in the background on the dyno so invoice discovery + per-PO
  // SOAP never trips Heroku's 30s WEB limit (the old bounded-synchronous version H12'd).
  try {
    const kick = await axios.post(`${BASE_URL}/api/sanmar-orders/sync-recent-completed?days=7`, {},
      { headers: AUTH_HEADERS, timeout: 30000 });
    if (kick.data && kick.data.alreadyRunning) { console.log('  Already running — skipping.'); return; }
  } catch (e) {
    console.log(`  kickoff error (non-fatal): ${e.response?.data?.error || e.message}`);
    return;
  }
  for (let i = 0; i < 60; i++) { // up to ~10 min
    await new Promise(r => setTimeout(r, 10000));
    let d;
    try {
      const s = await axios.get(`${BASE_URL}/api/sanmar-orders/sync-recent-completed-status`, { timeout: 10000 });
      d = s.data || {};
    } catch (e) { console.log(`  poll error: ${e.message}`); continue; }
    if (!d.running) {
      const r = d.lastResult || {};
      if (r.error) console.log(`  Catch-up error: ${r.error}`);
      else {
        // Phase 0 first — this is the shipment-FIRST view (SanMar's manifest), so a PO listed
        // under newPos shipped without us holding an order row for it. Worth reading daily.
        const s = r.sweep;
        if (s && s.error) console.log(`  ⚠ Shipment sweep FAILED: ${s.error} — completeness NOT guaranteed this run`);
        else if (s) console.log(`  Shipment sweep (${s.window}): ${s.cartons} carton(s) across ${s.posSeen} PO(s), +${s.added} new${s.newPos && s.newPos.length ? `, ${s.newPos.length} PO(s) with no order row: ${s.newPos.join(', ')}` : ''}`);
        console.log(`  Catch-up: ingested ${r.ingested || 0} order(s), +${r.shipmentsAdded || 0} tracking (discovered ${r.discovered || 0}, stale ${r.staleDiscovered || 0}, deferred ${r.deferred || 0}, errors ${r.errors || 0}). Status: SUCCESS`);
      }
      return;
    }
    const p = d.progress || {};
    console.log(`  …${p.phase || 'working'} — ingested ${p.ingested || 0}/${p.pending || '?'}`);
  }
  console.log('  Still running after 10 min — exiting poll (job continues on dyno).');
}

async function syncInvoices() {
  const url = `${BASE_URL}/api/sanmar-invoices/sync`;
  console.log(`\n[${new Date().toISOString()}] Starting invoice sync...`);

  const response = await axios.post(url, {}, { headers: AUTH_HEADERS, timeout: TIMEOUT });
  const result = response.data;
  console.log(`  Invoices found: ${result.invoicesFound || 0}`);
  console.log(`  Invoices saved: ${result.invoicesSaved || 0}`);
  console.log(`  Items saved: ${result.itemsSaved || 0}`);
  console.log(`  Status: SUCCESS`);
  return result;
}

async function pollBackfillStatus(endpoint, label) {
  const maxPolls = 80; // 20 minutes max (80 * 15s)
  for (let i = 0; i < maxPolls; i++) {
    await new Promise(r => setTimeout(r, 15000));
    try {
      const status = await axios.get(`${BASE_URL}${endpoint}`, { timeout: 10000 });
      const data = status.data;
      const progress = data.progress || {};
      console.log(`  [${label}] ${progress.phase || 'unknown'} — orders: ${progress.ordersSaved || progress.invoicesSaved || 0}, errors: ${progress.errors || 0}`);
      if (!data.running) {
        return data.lastResult;
      }
    } catch (e) {
      console.log(`  [${label}] Poll error: ${e.message}`);
    }
  }
  console.log(`  [${label}] Still running after 20 minutes. Exiting poll loop.`);
  return null;
}

async function runBackfill(days) {
  const url = `${BASE_URL}/api/sanmar-orders/backfill?days=${days}`;
  console.log(`\n[${new Date().toISOString()}] Starting order backfill (${days} days)...`);

  const response = await axios.post(url, {}, { headers: AUTH_HEADERS, timeout: 30000 });
  if (response.status === 202) {
    console.log('  Backfill started in background. Polling for completion...');
    const result = await pollBackfillStatus('/api/sanmar-orders/backfill-status', 'Order Backfill');
    if (result) {
      console.log(`\n  Backfill result: ${JSON.stringify(result)}`);
    }
    return result;
  }
  return response.data;
}

async function runInvoiceBackfill(days) {
  const url = `${BASE_URL}/api/sanmar-invoices/backfill?days=${days}`;
  console.log(`\n[${new Date().toISOString()}] Starting invoice backfill (${days} days)...`);

  const response = await axios.post(url, {}, { headers: AUTH_HEADERS, timeout: 30000 });
  if (response.status === 202) {
    console.log('  Invoice backfill started in background. Polling for completion...');
    const result = await pollBackfillStatus('/api/sanmar-invoices/backfill-status', 'Invoice Backfill');
    if (result) {
      console.log(`\n  Invoice backfill result: ${JSON.stringify(result)}`);
    }
    return result;
  }
  return response.data;
}

async function matchManageOrders() {
  const url = `${BASE_URL}/api/sanmar-orders/match-manageorders`;
  console.log(`\n[${new Date().toISOString()}] Matching SanMar orders to ManageOrders...`);

  const response = await axios.post(url, {}, { headers: AUTH_HEADERS, timeout: TIMEOUT });
  const result = response.data;
  console.log(`  Matched: ${result.matched || 0}`);
  console.log(`  Unmatched: ${result.unmatched || 0}`);
  console.log(`  Already linked: ${result.alreadyLinked || 0}`);
  console.log(`  Errors: ${result.errors || 0}`);
  console.log(`  Status: SUCCESS`);
  return result;
}

async function syncDeliveryDates() {
  const url = `${BASE_URL}/api/sanmar-orders/sync-delivery-dates`;
  console.log(`\n[${new Date().toISOString()}] Syncing UPS delivery/received dates onto shipments...`);
  // Async (202) — fire-and-forget; the web dyno backfills recent shipments (skips already-delivered)
  // in the background. Poll /sync-delivery-dates-status if you need the tally.
  const response = await axios.post(url, {}, { headers: AUTH_HEADERS, timeout: TIMEOUT });
  console.log(`  ${(response.data && response.data.message) || 'started'}`);
  return response.data;
}

async function checkStatus() {
  const url = `${BASE_URL}/api/sanmar-orders/status-summary`;
  console.log(`\n[${new Date().toISOString()}] Checking SanMar sync status...`);

  const response = await axios.get(url, { timeout: 30000 });
  const data = response.data;

  console.log('\n  Table Row Counts:');
  for (const [table, info] of Object.entries(data.tables)) {
    console.log(`    ${table}: ${info.rows}${info.error ? ` (ERROR: ${info.error})` : ''}`);
  }

  console.log(`\n  Last Sync: ${data.lastSync}`);

  if (data.orderStatusDistribution && Object.keys(data.orderStatusDistribution).length > 0) {
    console.log('\n  Order Status Distribution:');
    for (const [status, count] of Object.entries(data.orderStatusDistribution)) {
      console.log(`    ${status}: ${count}`);
    }
  }

  if (data.dataQuality) {
    console.log(`\n  Data Quality:`);
    console.log(`    Items missing Unit_Price: ${data.dataQuality.itemsMissingUnitPrice}`);
  }

  if (data.backfill) {
    console.log(`\n  Backfill: ${data.backfill.running ? 'RUNNING' : 'idle'}`);
    if (data.backfill.lastRun) console.log(`    Last run: ${data.backfill.lastRun}`);
  }

  return data;
}

async function main() {
  const args = process.argv.slice(2);

  try {
    if (args.includes('--status')) {
      await checkStatus();
    } else if (args.includes('--backfill')) {
      const idx = args.indexOf('--backfill');
      const days = parseInt(args[idx + 1]) || 90;
      await runBackfill(days);
    } else if (args.includes('--backfill-invoices')) {
      const idx = args.indexOf('--backfill-invoices');
      const days = parseInt(args[idx + 1]) || 90;
      await runInvoiceBackfill(days);
    } else {
      // Normal daily sync. Each phase is ISOLATED (2026-07-31): these used to be six bare
      // awaits under this one try/catch, so the first throw skipped every later phase —
      // and the first phase is the slowest and the only one that reliably H12s. Losing
      // syncRecentCompleted() that way is the worst case: it is the catch-up that ingests
      // orders which never entered the table at all, so the failure removed exactly the
      // mechanism that would have covered for it. A phase failing must never silence
      // the phases behind it.
      const full = args.includes('--full');
      const phases = [
        ['orders', () => syncOrders(full)],
        // Closes the weekend/Monday hole the 24h window and allOpen both miss. Before the
        // catch-up phases so they see the fuller order set.
        ['daily backfill', () => syncDailyBackfill()],
        ['shipment catch-up', () => syncPendingShipments()],
        ['recently-completed catch-up', () => syncRecentCompleted()],
        ['invoices', () => syncInvoices()],
        ['ManageOrders match', () => matchManageOrders()],
        ['delivery dates', () => syncDeliveryDates()],
      ];
      const failed = [];
      for (const [name, run] of phases) {
        try {
          await run();
        } catch (err) {
          failed.push(name);
          console.error(`\n  ✗ PHASE FAILED (${name}): ${err.response?.data?.error || err.message}`);
          console.error(`    Continuing with the remaining phases.`);
        }
      }
      if (failed.length) {
        // Still a non-zero exit so the run is visibly red — but only AFTER everything ran.
        console.error(`\n[${new Date().toISOString()}] SanMar sync finished with ${failed.length} failed phase(s): ${failed.join(', ')}`);
        process.exit(1);
      }
    }

    console.log(`\n[${new Date().toISOString()}] SanMar sync completed successfully.`);
    process.exit(0);
  } catch (error) {
    console.error(`\n[${new Date().toISOString()}] SanMar sync FAILED:`, error.response?.data || error.message);
    process.exit(1);
  }
}

main();
