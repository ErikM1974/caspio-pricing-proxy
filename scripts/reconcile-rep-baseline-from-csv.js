#!/usr/bin/env node
/**
 * NWCA Per-Rep YTD Reconciliation from ShopWorks CSV
 *
 * One-time fix for drift in the pre-rolling-window archive (Jan 1 → Feb 25, 2026).
 * That window is locked because ManageOrders only retains the last 60 days, so
 * any voids/modifications since the original archive can no longer be detected
 * automatically. This script imports a ShopWorks "Sales by Sales Rep" CSV and
 * collapses the 136 stale archive rows for that window into ONE per-rep
 * baseline row that brings each rep's YTD total to match the CSV exactly.
 *
 * The Feb 26+ rolling window stays untouched and continues auto-syncing nightly
 * via the regular archive-daily-sales cron. Result: dashboard YTD per rep =
 * CSV YTD per rep.
 *
 * Usage:
 *   node scripts/reconcile-rep-baseline-from-csv.js --csv "<path>" [--apply]
 *
 *   Without --apply, runs as a dry-run (computes deltas, reports nothing written).
 *
 * Environment:
 *   BASE_URL — defaults to Heroku production
 *
 * The CSV must have columns: ID_Order, CompanyName, cur_Subtotal, Sales Rep
 * (Windows-1252 / latin-1 encoding handled gracefully — ShopWorks exports
 * sometimes have non-UTF-8 bytes in CompanyName fields.)
 */

const fs = require('fs');
const axios = require('axios');

const BASE_URL = process.env.BASE_URL || 'https://caspio-pricing-proxy-ab30a049961a.herokuapp.com';

// The cutoff between the locked window and the rolling window. Anything <= this
// date is the one-time-correction zone; > this date is auto-managed by the cron.
const CUTOFF_DATE = '2026-02-25';
const ROLLING_START = '2026-02-26';

// Reasonable axios defaults
const TIMEOUT = 60000;

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = { csv: null, apply: false };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--csv') opts.csv = args[++i];
    else if (args[i] === '--apply') opts.apply = true;
  }
  return opts;
}

function todayIsoDate() {
  return new Date().toISOString().split('T')[0];
}

/**
 * Parse a CSV line, respecting quoted fields with embedded commas / newlines.
 * Returns an array of field strings.
 */
function splitCsvLine(line) {
  const fields = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') {
      if (inQuotes && line[i + 1] === '"') { cur += '"'; i++; }
      else inQuotes = !inQuotes;
    } else if (c === ',' && !inQuotes) {
      fields.push(cur); cur = '';
    } else {
      cur += c;
    }
  }
  fields.push(cur);
  return fields;
}

/**
 * Read CSV with latin-1 decoding (ShopWorks exports sometimes have 0xFF bytes
 * inside company names from Windows-1252 source). Returns array of row objects.
 */
function readCsv(path) {
  const buf = fs.readFileSync(path);
  // latin-1 (binary) decoding — every byte is a valid character; loses no data
  const text = buf.toString('latin1');

  // Handle quoted multi-line fields by joining physical lines until quote count is even
  const physical = text.split(/\r?\n/);
  const logical = [];
  let pending = '';
  for (const line of physical) {
    const candidate = pending ? pending + '\n' + line : line;
    const quoteCount = (candidate.match(/"/g) || []).length;
    if (quoteCount % 2 === 0) {
      logical.push(candidate);
      pending = '';
    } else {
      pending = candidate;
    }
  }
  if (pending) logical.push(pending); // unterminated — best effort

  if (logical.length === 0) return [];
  const header = splitCsvLine(logical[0]).map(h => h.trim());
  const rows = [];
  for (let i = 1; i < logical.length; i++) {
    if (!logical[i].trim()) continue;
    const fields = splitCsvLine(logical[i]);
    const row = {};
    for (let j = 0; j < header.length; j++) {
      row[header[j]] = (fields[j] || '').trim();
    }
    rows.push(row);
  }
  return rows;
}

async function main() {
  const opts = parseArgs();
  if (!opts.csv) {
    console.error('ERROR: --csv <path> is required');
    process.exit(1);
  }
  if (!fs.existsSync(opts.csv)) {
    console.error(`ERROR: CSV not found: ${opts.csv}`);
    process.exit(1);
  }

  console.log('='.repeat(72));
  console.log('NWCA Per-Rep YTD Reconciliation from ShopWorks CSV');
  console.log(`Started:  ${new Date().toISOString()}`);
  console.log(`CSV:      ${opts.csv}`);
  console.log(`Target:   ${BASE_URL}`);
  console.log(`Mode:     ${opts.apply ? 'APPLY (will write)' : 'DRY RUN (no writes)'}`);
  console.log(`Cutoff:   ${CUTOFF_DATE}  (rolling window starts ${ROLLING_START})`);
  console.log('='.repeat(72));

  // 1. Parse CSV → per-rep totals.
  //
  // IMPORTANT: trim rep names. Caspio normalizes trailing whitespace on its
  // primary-key composite, so "House" and "House " collide on insert. If we
  // accumulate them as separate keys here, the second /import call updates
  // the first row (overwriting the positive baseline with the negative one)
  // instead of inserting alongside. We learned this the hard way on the
  // first apply attempt — the House baseline ended up at -$3066 instead of
  // the intended $4538 (sum of the two trimmed-equivalent variants).
  console.log('\n[1/5] Reading CSV…');
  const rows = readCsv(opts.csv);
  const csvTotals = {};
  let csvGrandRev = 0;
  let csvGrandOrders = 0;
  for (const row of rows) {
    const rep = (row['Sales Rep'] || '').trim();
    if (!rep) continue;
    const sub = parseFloat(row['cur_Subtotal']) || 0;
    if (!csvTotals[rep]) csvTotals[rep] = { revenue: 0, orders: 0 };
    csvTotals[rep].revenue += sub;
    csvTotals[rep].orders += 1;
    csvGrandRev += sub;
    csvGrandOrders += 1;
  }
  console.log(`  CSV truth: $${csvGrandRev.toFixed(2)} / ${csvGrandOrders} orders across ${Object.keys(csvTotals).length} reps`);

  // 2. Fetch in-window archive (Feb 26 → today) — already auto-synced, treated as truth
  console.log('\n[2/5] Fetching in-window archive (Feb 26 → today)…');
  const today = todayIsoDate();
  const inWindowResp = await axios.get(
    `${BASE_URL}/api/caspio/daily-sales-by-rep?start=${ROLLING_START}&end=${today}`,
    { timeout: TIMEOUT }
  );
  const inWindowReps = inWindowResp.data?.summary?.reps || [];
  const inWindowMap = {};
  for (const r of inWindowReps) {
    // Trim to merge "House" + "House " into the same bucket — Caspio sees them
    // as the same primary key, so the script must too.
    const trimmedName = (r.name || '').trim();
    if (!inWindowMap[trimmedName]) {
      inWindowMap[trimmedName] = { revenue: 0, orders: 0 };
    }
    inWindowMap[trimmedName].revenue += r.totalRevenue || 0;
    inWindowMap[trimmedName].orders += r.totalOrders || 0;
  }
  console.log(`  In-window: $${(inWindowResp.data?.summary?.totalRevenue || 0).toFixed(2)} / ${inWindowResp.data?.summary?.totalOrders || 0} orders, ${inWindowReps.length} reps`);

  // 3. Compute per-rep pre-window adjustment = CSV − in-window
  console.log('\n[3/5] Computing per-rep pre-window baselines (CSV − in-window)…');
  const allReps = new Set([...Object.keys(csvTotals), ...Object.keys(inWindowMap)]);
  const baselines = [];
  console.log(`  ${'Rep'.padEnd(28)} ${'CSV'.padStart(20)} ${'In-window'.padStart(20)} ${'Pre-window baseline'.padStart(22)}`);
  console.log('  ' + '-'.repeat(94));
  for (const rep of [...allReps].sort()) {
    const csv = csvTotals[rep] || { revenue: 0, orders: 0 };
    const live = inWindowMap[rep] || { revenue: 0, orders: 0 };
    const preRev = Math.round((csv.revenue - live.revenue) * 100) / 100;
    const preOrders = csv.orders - live.orders;
    const csvStr = `$${csv.revenue.toFixed(2)} / ${csv.orders}`;
    const liveStr = `$${live.revenue.toFixed(2)} / ${live.orders}`;
    const baseStr = `$${preRev.toFixed(2)} / ${preOrders}`;
    console.log(`  ${rep.padEnd(28)} ${csvStr.padStart(20)} ${liveStr.padStart(20)} ${baseStr.padStart(22)}`);

    // Skip reps with no presence in either source
    if (csv.revenue === 0 && csv.orders === 0 && preRev === 0 && preOrders === 0) continue;

    baselines.push({
      date: CUTOFF_DATE,
      rep,
      revenue: preRev,
      orderCount: preOrders
    });
  }

  // Sanity check: pre-window adjustments should sum to CSV total minus in-window total
  const baselineRevSum = baselines.reduce((s, b) => s + b.revenue, 0);
  const baselineOrdSum = baselines.reduce((s, b) => s + b.orderCount, 0);
  const expectedRev = Math.round((csvGrandRev - (inWindowResp.data?.summary?.totalRevenue || 0)) * 100) / 100;
  const expectedOrd = csvGrandOrders - (inWindowResp.data?.summary?.totalOrders || 0);
  console.log(`\n  Baseline rows to insert: ${baselines.length}`);
  console.log(`  Baseline revenue sum:    $${baselineRevSum.toFixed(2)}  (expected ${expectedRev.toFixed(2)})`);
  console.log(`  Baseline orders sum:     ${baselineOrdSum}  (expected ${expectedOrd})`);

  // 4. If dry-run, stop here
  if (!opts.apply) {
    console.log('\n[4/5] DRY RUN — no writes performed.');
    console.log('       Re-run with --apply to delete Jan 1 → Feb 25 archive rows for these reps');
    console.log('       and insert the baseline rows above.');
    console.log('\n[5/5] Done (dry run).');
    return;
  }

  // 5. APPLY: bulk-delete the locked window for these reps, then import baselines
  console.log('\n[4/5] APPLY — wiping locked-window rows for reconciled reps…');

  // Single bulk-delete covers all reps with one Caspio call: every row at or
  // before the cutoff. Safer than per-rep deletes (no rep-name escaping
  // mismatches, no partial-progress state).
  console.log(`  DELETE WHERE SalesDate <= '${CUTOFF_DATE}'`);
  const delResp = await axios.delete(
    `${BASE_URL}/api/caspio/daily-sales-by-rep/bulk`,
    {
      data: { where: `SalesDate <= '${CUTOFF_DATE}'` },
      headers: { 'Content-Type': 'application/json' },
      timeout: TIMEOUT
    }
  );
  console.log(`  Deleted ${delResp.data?.recordsAffected || 0} rows`);

  console.log('\n[5/5] Inserting per-rep baseline rows via /import…');
  const importResp = await axios.post(
    `${BASE_URL}/api/caspio/daily-sales-by-rep/import`,
    { data: baselines },
    {
      headers: { 'Content-Type': 'application/json' },
      timeout: TIMEOUT
    }
  );
  const imp = importResp.data || {};
  console.log(`  Created: ${imp.created || 0}, Updated: ${imp.updated || 0}, Errors: ${(imp.errors || []).length}`);
  if (imp.errors && imp.errors.length) {
    for (const e of imp.errors) console.log(`    - ${JSON.stringify(e)}`);
  }

  // 6. Re-fetch YTD and verify
  console.log('\nVerifying post-state YTD…');
  const ytdResp = await axios.get(`${BASE_URL}/api/caspio/daily-sales-by-rep/ytd?year=2026`, { timeout: TIMEOUT });
  console.log(`  Archive YTD: $${(ytdResp.data?.totalRevenue || 0).toFixed(2)} / ${ytdResp.data?.totalOrders || 0} orders`);
  console.log(`  CSV target:  $${csvGrandRev.toFixed(2)} / ${csvGrandOrders} orders`);

  const revGap = Math.round(((ytdResp.data?.totalRevenue || 0) - csvGrandRev) * 100) / 100;
  const ordGap = (ytdResp.data?.totalOrders || 0) - csvGrandOrders;
  console.log(`  Gap:         $${revGap.toFixed(2)} / ${ordGap} orders ${Math.abs(revGap) < 1 && ordGap === 0 ? '✓' : '⚠'}`);

  console.log('\n' + '='.repeat(72));
  console.log('RECONCILIATION COMPLETE');
  console.log('='.repeat(72));
}

main().catch(err => {
  console.error('\nFATAL:', err.message);
  if (err.response) {
    console.error('Response:', JSON.stringify(err.response.data, null, 2));
  }
  process.exit(1);
});
