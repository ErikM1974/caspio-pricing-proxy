#!/usr/bin/env node
/**
 * NWCA Per-Rep Archive Rebuild from ManageOrders API
 *
 * Rebuilds the NW_Daily_Sales_By_Rep archive for a given window directly from
 * ManageOrders. We discovered (2026-04-28) that MO retains 19+ months of pull
 * history despite the 60-day push window we'd been designing around — so the
 * archive no longer needs the "locked pre-window baseline" pattern from the
 * 2026-04-27 CSV reconciliation. The whole 2026 YTD can be regenerated from
 * the live API with daily granularity.
 *
 * Mirrors archive-range's rep attribution exactly:
 *   rep = Sales_Reps_2026[id_Customer]?.CustomerServiceRep
 *      || order.CustomerServiceRep
 *      || 'Unknown'
 *
 * The script does NOT call /archive-range (60-day-capped at the route layer
 * and would Heroku H12 on a YTD window). It pulls /manageorders/orders in
 * chunks, aggregates locally, and writes via /import in batches.
 *
 * Usage:
 *   node scripts/rebuild-rep-archive-from-manageorders.js [--start YYYY-MM-DD] [--end YYYY-MM-DD] [--apply]
 *
 *   Defaults: --start 2026-01-01, --end <today>
 *   Without --apply, runs as a dry-run (prints deltas, writes nothing).
 *
 * Environment:
 *   BASE_URL — defaults to Heroku production
 */

require('dotenv').config();
const axios = require('axios');

const BASE_URL = process.env.BASE_URL || 'https://caspio-pricing-proxy-ab30a049961a.herokuapp.com';
const CRM_API_SECRET = process.env.CRM_API_SECRET;
if (!CRM_API_SECRET) {
  console.error('ERROR: CRM_API_SECRET env var is required (read from .env or Heroku config).');
  process.exit(1);
}
const CRM_HEADERS = { 'x-crm-api-secret': CRM_API_SECRET };

// MO API tolerates large windows but the proxy has a 30s Heroku ceiling and
// caches per query string. 14-day chunks fit comfortably under both.
const FETCH_CHUNK_DAYS = 14;

// /import does its own serial Caspio upserts inside one HTTP call. Keep
// per-call payload small enough to stay under Heroku's 30s — ~30 records is
// safely under the timeout even with cold tokens.
const IMPORT_BATCH_SIZE = 30;
const IMPORT_BATCH_DELAY_MS = 500;

const TIMEOUT = 60000;

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = { start: '2026-01-01', end: new Date().toISOString().split('T')[0], apply: false };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--start') opts.start = args[++i];
    else if (args[i] === '--end') opts.end = args[++i];
    else if (args[i] === '--apply') opts.apply = true;
  }
  return opts;
}

function fmtUsd(n) {
  return '$' + (Math.round(n * 100) / 100).toFixed(2);
}

function addDays(dateStr, n) {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().split('T')[0];
}

function dateChunks(start, end, chunkDays) {
  const chunks = [];
  let cur = start;
  while (cur <= end) {
    const chunkEnd = addDays(cur, chunkDays - 1);
    chunks.push({ start: cur, end: chunkEnd > end ? end : chunkEnd });
    cur = addDays(cur, chunkDays);
  }
  return chunks;
}

async function fetchAllOrders(start, end) {
  const chunks = dateChunks(start, end, FETCH_CHUNK_DAYS);
  console.log(`  Pulling ${chunks.length} chunk(s) of ${FETCH_CHUNK_DAYS} days each from ${start} to ${end}...`);
  const all = [];
  const seen = new Set();
  for (const [i, c] of chunks.entries()) {
    const url = `${BASE_URL}/api/manageorders/orders?date_Invoiced_start=${c.start}&date_Invoiced_end=${c.end}&refresh=true`;
    const t0 = Date.now();
    const resp = await axios.get(url, { timeout: TIMEOUT });
    const orders = resp.data?.result || [];
    let added = 0;
    for (const o of orders) {
      if (seen.has(o.id_Order)) continue;
      seen.add(o.id_Order);
      all.push(o);
      added++;
    }
    console.log(`    [${i + 1}/${chunks.length}] ${c.start} → ${c.end}: ${orders.length} orders (${added} new) in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  }
  return all;
}

async function fetchSalesRepsMap() {
  console.log('  Fetching Sales_Reps_2026 (current rep ownership)...');
  const resp = await axios.get(`${BASE_URL}/api/sales-reps-2026`, { timeout: TIMEOUT, headers: CRM_HEADERS });
  const records = resp.data?.records || [];
  const map = new Map();
  for (const r of records) {
    if (r.ID_Customer && r.CustomerServiceRep) {
      map.set(r.ID_Customer, r.CustomerServiceRep);
    }
  }
  console.log(`  Loaded ${map.size} rep assignments.`);
  return map;
}

async function fetchCurrentArchive(start, end) {
  console.log(`  Fetching current archive ${start} → ${end}...`);
  const resp = await axios.get(
    `${BASE_URL}/api/caspio/daily-sales-by-rep?start=${start}&end=${end}`,
    { timeout: TIMEOUT }
  );
  const reps = resp.data?.summary?.reps || [];
  const map = new Map();
  for (const r of reps) {
    map.set(r.name, { revenue: r.totalRevenue || 0, orderCount: r.totalOrders || 0 });
  }
  return {
    map,
    totalRevenue: resp.data?.summary?.totalRevenue || 0,
    totalOrders: resp.data?.summary?.totalOrders || 0,
    days: resp.data?.days || []
  };
}

function aggregate(orders, salesRepsMap) {
  // (date, rep) -> {revenue, orderCount}
  const dailyRep = new Map();
  // rep -> {revenue, orderCount} (YTD totals across the window)
  const repYtd = new Map();
  let grandRev = 0;
  let grandOrd = 0;

  for (const order of orders) {
    if (!order.date_Invoiced) continue;
    const date = order.date_Invoiced.split('T')[0];
    const rep = salesRepsMap.get(order.id_Customer) || order.CustomerServiceRep || 'Unknown';
    const amt = parseFloat(order.cur_SubTotal) || 0;

    const dayKey = `${date}|${rep}`;
    if (!dailyRep.has(dayKey)) dailyRep.set(dayKey, { date, rep, revenue: 0, orderCount: 0 });
    const dr = dailyRep.get(dayKey);
    dr.revenue += amt;
    dr.orderCount += 1;

    if (!repYtd.has(rep)) repYtd.set(rep, { revenue: 0, orderCount: 0 });
    const ry = repYtd.get(rep);
    ry.revenue += amt;
    ry.orderCount += 1;

    grandRev += amt;
    grandOrd += 1;
  }

  return {
    dailyRows: [...dailyRep.values()].map(r => ({
      date: r.date,
      rep: r.rep,
      revenue: Math.round(r.revenue * 100) / 100,
      orderCount: r.orderCount
    })),
    repYtd,
    grandRev: Math.round(grandRev * 100) / 100,
    grandOrd
  };
}

function printRepDeltaTable(currentArchive, rebuildYtd) {
  const allReps = new Set([...currentArchive.map.keys(), ...rebuildYtd.keys()]);
  console.log(`  ${'Rep'.padEnd(28)} ${'Current archive'.padStart(22)} ${'API rebuild'.padStart(22)} ${'Δ'.padStart(15)}`);
  console.log('  ' + '-'.repeat(90));
  for (const rep of [...allReps].sort()) {
    const cur = currentArchive.map.get(rep) || { revenue: 0, orderCount: 0 };
    const rb = rebuildYtd.get(rep) || { revenue: 0, orderCount: 0 };
    const delta = Math.round((rb.revenue - cur.revenue) * 100) / 100;
    const curStr = `${fmtUsd(cur.revenue)} / ${cur.orderCount}`;
    const rbStr = `${fmtUsd(rb.revenue)} / ${rb.orderCount}`;
    const flag = Math.abs(delta) >= 0.01 ? ` ${delta > 0 ? '↑' : '↓'}` : '';
    console.log(`  ${rep.padEnd(28)} ${curStr.padStart(22)} ${rbStr.padStart(22)} ${fmtUsd(delta).padStart(13)}${flag}`);
  }
}

async function applyRebuild(start, end, dailyRows) {
  console.log(`\n[APPLY 1/3] Bulk-deleting archive rows where SalesDate BETWEEN '${start}' AND '${end}'`);
  const delResp = await axios.delete(
    `${BASE_URL}/api/caspio/daily-sales-by-rep/bulk`,
    {
      data: { where: `SalesDate>='${start}' AND SalesDate<='${end}'` },
      headers: { 'Content-Type': 'application/json' },
      timeout: TIMEOUT
    }
  );
  console.log(`  Deleted ${delResp.data?.recordsAffected || 0} rows.`);

  console.log(`\n[APPLY 2/3] Importing ${dailyRows.length} rebuilt rows in batches of ${IMPORT_BATCH_SIZE}...`);
  let totalCreated = 0;
  let totalUpdated = 0;
  const errors = [];
  for (let i = 0; i < dailyRows.length; i += IMPORT_BATCH_SIZE) {
    const batch = dailyRows.slice(i, i + IMPORT_BATCH_SIZE);
    const t0 = Date.now();
    const resp = await axios.post(
      `${BASE_URL}/api/caspio/daily-sales-by-rep/import`,
      { data: batch },
      { headers: { 'Content-Type': 'application/json' }, timeout: TIMEOUT }
    );
    const r = resp.data || {};
    totalCreated += r.created || 0;
    totalUpdated += r.updated || 0;
    if (r.errors?.length) errors.push(...r.errors);
    const batchNum = Math.floor(i / IMPORT_BATCH_SIZE) + 1;
    const totalBatches = Math.ceil(dailyRows.length / IMPORT_BATCH_SIZE);
    console.log(`  [${batchNum}/${totalBatches}] +${r.created || 0} created, ~${r.updated || 0} updated in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    if (i + IMPORT_BATCH_SIZE < dailyRows.length) {
      await new Promise(r => setTimeout(r, IMPORT_BATCH_DELAY_MS));
    }
  }
  console.log(`  Total: ${totalCreated} created, ${totalUpdated} updated, ${errors.length} errors.`);
  if (errors.length) {
    console.log('  Errors (first 5):');
    for (const e of errors.slice(0, 5)) console.log(`    - ${JSON.stringify(e)}`);
  }

  console.log('\n[APPLY 3/3] Verifying post-state archive…');
  const verify = await fetchCurrentArchive(start, end);
  console.log(`  Archive ${start} → ${end}: ${fmtUsd(verify.totalRevenue)} / ${verify.totalOrders} orders`);
  return { totalCreated, totalUpdated, errors, verify };
}

async function main() {
  const opts = parseArgs();
  const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
  if (!dateRegex.test(opts.start) || !dateRegex.test(opts.end)) {
    console.error('ERROR: --start and --end must be YYYY-MM-DD');
    process.exit(1);
  }
  if (opts.start > opts.end) {
    console.error('ERROR: --start must be <= --end');
    process.exit(1);
  }

  console.log('='.repeat(72));
  console.log('NWCA Per-Rep Archive Rebuild from ManageOrders API');
  console.log(`Started: ${new Date().toISOString()}`);
  console.log(`Window:  ${opts.start} → ${opts.end}`);
  console.log(`Target:  ${BASE_URL}`);
  console.log(`Mode:    ${opts.apply ? 'APPLY (will write)' : 'DRY RUN (no writes)'}`);
  console.log('='.repeat(72));

  console.log('\n[1/4] Fetching source data...');
  const [salesRepsMap, currentArchive] = await Promise.all([
    fetchSalesRepsMap(),
    fetchCurrentArchive(opts.start, opts.end)
  ]);
  const orders = await fetchAllOrders(opts.start, opts.end);
  console.log(`  Pulled ${orders.length} unique orders.`);

  console.log('\n[2/4] Aggregating per (date, rep)...');
  const { dailyRows, repYtd, grandRev, grandOrd } = aggregate(orders, salesRepsMap);
  const ordersWithoutDate = orders.filter(o => !o.date_Invoiced).length;
  if (ordersWithoutDate > 0) {
    console.log(`  WARN: ${ordersWithoutDate} orders had no date_Invoiced (skipped — these aren't yet invoiced).`);
  }
  console.log(`  Rebuilt: ${dailyRows.length} (date, rep) rows, ${repYtd.size} reps, ${fmtUsd(grandRev)} / ${grandOrd} orders.`);

  console.log('\n[3/4] Comparing to current archive...');
  console.log(`  Current archive ${opts.start} → ${opts.end}: ${fmtUsd(currentArchive.totalRevenue)} / ${currentArchive.totalOrders} orders.`);
  console.log(`  Proposed rebuild:                            ${fmtUsd(grandRev)} / ${grandOrd} orders.`);
  const totalDelta = Math.round((grandRev - currentArchive.totalRevenue) * 100) / 100;
  console.log(`  Delta (rebuild − current):                   ${fmtUsd(totalDelta)} / ${grandOrd - currentArchive.totalOrders} orders\n`);
  printRepDeltaTable(currentArchive, repYtd);

  if (!opts.apply) {
    console.log('\n[4/4] DRY RUN — no writes performed.');
    console.log('       Re-run with --apply to:');
    console.log(`         1) Bulk-delete archive rows where SalesDate BETWEEN '${opts.start}' AND '${opts.end}'`);
    console.log(`         2) Import ${dailyRows.length} rebuilt rows`);
    console.log(`         3) Verify the post-state YTD`);
    console.log('\nDone (dry run).');
    return;
  }

  const result = await applyRebuild(opts.start, opts.end, dailyRows);
  const verifyDelta = Math.round((result.verify.totalRevenue - grandRev) * 100) / 100;
  console.log(`\nVerify delta (archive − planned): ${fmtUsd(verifyDelta)}  ${Math.abs(verifyDelta) < 1 ? '✓' : '⚠ check errors above'}`);

  console.log('\n' + '='.repeat(72));
  console.log('REBUILD COMPLETE');
  console.log('='.repeat(72));
}

main().catch(err => {
  console.error('\nFATAL:', err.message);
  if (err.response) {
    console.error('Response:', JSON.stringify(err.response.data, null, 2));
  }
  process.exit(1);
});
