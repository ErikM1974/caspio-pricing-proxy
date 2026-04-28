#!/usr/bin/env node
/**
 * NWCA Per-Account vs Per-Rep Daily Sales Drift Audit
 *
 * Read-only diagnostic. Quantifies drift between the per-customer daily archives
 * (Nika_Daily_Sales_By_Account, Taneisha_Daily_Sales_By_Account,
 * House_Daily_Sales_By_Account) and the per-rep daily archive
 * (NW_Daily_Sales_By_Rep, the master source of truth for the staff dashboard
 * banner, Team Performance widget, and CRM headlines).
 *
 * In theory, for any rep R and date D:
 *   sum({Rep}_Daily_Sales_By_Account.Revenue WHERE SalesDate=D)
 *     == NW_Daily_Sales_By_Rep.Revenue WHERE SalesDate=D AND RepName=R
 *
 * In practice nothing enforces this — the two archives are populated by separate
 * paths and could drift. The per-rep archive was rebuilt to truth on 2026-04-28
 * via rebuild-rep-archive-from-manageorders.js; the per-account tables were
 * never CSV-reconciled.
 *
 * House caveat: House_Daily_Sales_By_Account stores customer rows tagged with
 * an AssignedTo field that can be House/Ruthie/Erik/Jim/Web/etc. The audit's
 * naive comparison treats the *full* per-account total against the 'House'
 * rep total. If house drift is non-trivial, the script also breaks the
 * per-account total down by AssignedTo so we can see which sub-bucket diverges.
 *
 * Usage:
 *   node scripts/audit-account-vs-rep-archive-drift.js [--start YYYY-MM-DD] [--end YYYY-MM-DD] [--rep nika|taneisha|house|all]
 *
 *   Defaults: --start 2026-01-01, --end <today>, --rep all
 *
 * Environment:
 *   BASE_URL — defaults to Heroku production
 *   CRM_API_SECRET — optional. The endpoints we hit are NOT behind
 *     requireCrmApiSecret today, but the header is forwarded if present so the
 *     script keeps working if auth gets added later.
 *
 * Read-only: no --apply flag, no writes.
 */

require('dotenv').config();
const axios = require('axios');

const BASE_URL = process.env.BASE_URL || 'https://caspio-pricing-proxy-ab30a049961a.herokuapp.com';
const CRM_API_SECRET = process.env.CRM_API_SECRET;
const CRM_HEADERS = CRM_API_SECRET ? { 'x-crm-api-secret': CRM_API_SECRET } : {};

const TIMEOUT = 60000;
const DRIFT_THRESHOLD = 0.01; // dollars — anything below this is float-precision noise
const HOUSE_BREAKDOWN_THRESHOLD = 100; // dollars — surface AssignedTo breakdown only if House drift exceeds this

const REPS = [
  { slug: 'nika',     repName: 'Nika Lao' },
  { slug: 'taneisha', repName: 'Taneisha Clark' },
  { slug: 'house',    repName: 'House' }
];

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = {
    start: '2026-01-01',
    end: new Date().toISOString().split('T')[0],
    rep: 'all'
  };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--start') opts.start = args[++i];
    else if (args[i] === '--end') opts.end = args[++i];
    else if (args[i] === '--rep') opts.rep = args[++i];
  }
  return opts;
}

function fmtUsd(n) {
  const sign = n < 0 ? '-' : '';
  return sign + '$' + (Math.abs(Math.round(n * 100) / 100)).toFixed(2);
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

async function fetchPerAccount(slug, start, end) {
  const url = `${BASE_URL}/api/${slug}/daily-sales-by-account?start=${start}&end=${end}`;
  const resp = await axios.get(url, { timeout: TIMEOUT, headers: CRM_HEADERS });
  return resp.data || {};
}

async function fetchPerRep(start, end) {
  const url = `${BASE_URL}/api/caspio/daily-sales-by-rep?start=${start}&end=${end}`;
  const resp = await axios.get(url, { timeout: TIMEOUT, headers: CRM_HEADERS });
  return resp.data || {};
}

/**
 * Build date -> totalRevenue map from per-account response, summing customers per day.
 * Returns { dailyTotals: Map<date, revenue>, assignedToTotals: Map<assignedTo, revenue> }
 * (assignedToTotals is only populated for the house slug — other slugs leave it empty.)
 */
function aggregatePerAccount(payload, slug) {
  const dailyTotals = new Map();
  const assignedToTotals = new Map();
  const days = payload?.days || [];
  for (const day of days) {
    let dayTotal = 0;
    for (const customer of day.customers || []) {
      const rev = parseFloat(customer.revenue) || 0;
      dayTotal += rev;
      if (slug === 'house') {
        const tag = customer.assignedTo || 'House';
        assignedToTotals.set(tag, (assignedToTotals.get(tag) || 0) + rev);
      }
    }
    dailyTotals.set(day.date, round2(dayTotal));
  }
  return { dailyTotals, assignedToTotals };
}

/**
 * Build date -> revenue map for a single rep from per-rep response.
 */
function aggregatePerRep(payload, repName) {
  const dailyTotals = new Map();
  const days = payload?.days || [];
  for (const day of days) {
    const reps = day.reps || [];
    const found = reps.find(r => r.name === repName);
    if (found) {
      dailyTotals.set(day.date, round2(parseFloat(found.revenue) || 0));
    }
  }
  return dailyTotals;
}

/**
 * Compare the two daily maps for a rep. Returns:
 *   { driftRows: [{date, repName, accountTotal, repTotal, delta}],
 *     summary: { datesChecked, datesWithDrift, sumAbsDrift, netDrift, maxAbsDay } }
 */
function compareRep(perAccountDaily, perRepDaily, repName) {
  const allDates = new Set([...perAccountDaily.keys(), ...perRepDaily.keys()]);
  const driftRows = [];
  let datesWithDrift = 0;
  let sumAbsDrift = 0;
  let netDrift = 0;
  let maxAbsDay = { date: null, abs: 0, delta: 0 };

  for (const date of [...allDates].sort()) {
    const accountTotal = perAccountDaily.get(date) || 0;
    const repTotal = perRepDaily.get(date) || 0;
    const delta = round2(repTotal - accountTotal);
    const absDelta = Math.abs(delta);
    if (absDelta > DRIFT_THRESHOLD) {
      datesWithDrift++;
      sumAbsDrift += absDelta;
      if (absDelta > maxAbsDay.abs) maxAbsDay = { date, abs: absDelta, delta };
    }
    netDrift += delta;
    driftRows.push({ date, repName, accountTotal, repTotal, delta });
  }

  return {
    driftRows,
    summary: {
      datesChecked: allDates.size,
      datesWithDrift,
      sumAbsDrift: round2(sumAbsDrift),
      netDrift: round2(netDrift),
      maxAbsDay
    }
  };
}

function printRepSection(rep, summary, assignedToTotals) {
  const { datesChecked, datesWithDrift, sumAbsDrift, netDrift, maxAbsDay } = summary;
  console.log(`\n[${rep.repName}]`);
  console.log(`  Days checked:                 ${datesChecked}`);
  console.log(`  Days with drift > $0.01:      ${datesWithDrift}`);
  console.log(`  Sum |drift|:                  ${fmtUsd(sumAbsDrift)}`);
  console.log(`  Net drift (rep - account):    ${fmtUsd(netDrift)}`);
  if (maxAbsDay.date) {
    console.log(`  Max single-day drift:         ${fmtUsd(maxAbsDay.delta)} on ${maxAbsDay.date}`);
  } else {
    console.log(`  Max single-day drift:         (none)`);
  }

  // House caveat: if the naive comparison shows non-trivial drift, dump the
  // AssignedTo breakdown so we can see whether the per-account table is
  // bundling Ruthie/Erik/Jim/Web rows that the per-rep archive splits out.
  if (rep.slug === 'house' && Math.abs(sumAbsDrift) >= HOUSE_BREAKDOWN_THRESHOLD && assignedToTotals?.size) {
    console.log(`  House per-account breakdown by AssignedTo (${rep.start || ''} → ${rep.end || ''}):`);
    const sorted = [...assignedToTotals.entries()].sort((a, b) => b[1] - a[1]);
    for (const [tag, total] of sorted) {
      console.log(`    ${tag.padEnd(24)} ${fmtUsd(round2(total)).padStart(14)}`);
    }
    console.log(`  (Per-rep archive 'House' total alone won't include rows tagged Ruthie/Erik/Jim/Web — they each have their own RepName entry.)`);
  }
}

function printTopDriftDays(allDriftRows) {
  const flagged = allDriftRows.filter(r => Math.abs(r.delta) > DRIFT_THRESHOLD)
    .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))
    .slice(0, 10);

  console.log(`\nTop ${flagged.length} drift days (sorted by |Δ|):`);
  if (flagged.length === 0) {
    console.log('  (no drift detected above threshold)');
    return;
  }
  console.log(`  ${'Date'.padEnd(12)} ${'Rep'.padEnd(18)} ${'Account total'.padStart(14)} ${'Rep total'.padStart(14)} ${'Δ'.padStart(12)}`);
  console.log('  ' + '-'.repeat(74));
  for (const row of flagged) {
    console.log(`  ${row.date.padEnd(12)} ${row.repName.padEnd(18)} ${fmtUsd(row.accountTotal).padStart(14)} ${fmtUsd(row.repTotal).padStart(14)} ${fmtUsd(row.delta).padStart(12)}`);
  }
}

function printRecommendation(perRepResults) {
  console.log('\n' + '='.repeat(72));
  console.log('RECOMMENDATION');
  console.log('='.repeat(72));
  const totalAbs = perRepResults.reduce((s, r) => s + r.summary.sumAbsDrift, 0);
  const anyMaterial = perRepResults.some(r => r.summary.sumAbsDrift > 100);
  if (totalAbs < 1) {
    console.log('  No drift detected. Per-account and per-rep archives agree.');
  } else if (totalAbs < 100) {
    console.log(`  Trivial drift detected (sum |Δ| across all reps = ${fmtUsd(totalAbs)}).`);
    console.log('  Likely float-precision noise or rounding inconsistencies. No rebuild needed.');
    console.log('  Document and move on.');
  } else if (anyMaterial) {
    console.log(`  Material drift detected (sum |Δ| across all reps = ${fmtUsd(totalAbs)}).`);
    console.log('  Per-account totals diverge from the rebuilt-to-truth per-rep archive.');
    console.log('  Recommended: build a rebuild script for the per-account archives,');
    console.log('  analogous to rebuild-rep-archive-from-manageorders.js but writing');
    console.log('  per-customer rows. Document magnitude in LESSONS_LEARNED.md under');
    console.log('  "Sales Archive Reconciliation".');
    console.log('  (For House: check the AssignedTo breakdown above first — some of');
    console.log('  that drift is structural, not bug-driven.)');
  } else {
    console.log(`  Modest drift detected (sum |Δ| across all reps = ${fmtUsd(totalAbs)}).`);
    console.log('  No single rep over $100 — borderline. Document and re-check after');
    console.log('  the next archive cron cycle.');
  }
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
  const validReps = ['nika', 'taneisha', 'house', 'all'];
  if (!validReps.includes(opts.rep)) {
    console.error(`ERROR: --rep must be one of ${validReps.join(', ')}`);
    process.exit(1);
  }

  const repsToCheck = opts.rep === 'all' ? REPS : REPS.filter(r => r.slug === opts.rep);

  console.log('='.repeat(72));
  console.log('NWCA Per-Account vs Per-Rep Daily Sales Drift Audit');
  console.log(`Started: ${new Date().toISOString()}`);
  console.log(`Window:  ${opts.start} → ${opts.end}`);
  console.log(`Reps:    ${repsToCheck.map(r => r.repName).join(', ')}`);
  console.log(`Target:  ${BASE_URL}`);
  console.log(`Auth:    ${CRM_API_SECRET ? 'sending x-crm-api-secret' : 'no auth header'}`);
  console.log('='.repeat(72));

  console.log('\n[1/3] Fetching per-rep archive (one call covers all reps)...');
  const perRepPayload = await fetchPerRep(opts.start, opts.end);
  console.log(`  Got ${perRepPayload?.days?.length || 0} days, ${perRepPayload?.summary?.reps?.length || 0} distinct reps.`);

  console.log('\n[2/3] Fetching per-account archives (one per rep)...');
  const perAccountPayloads = {};
  for (const rep of repsToCheck) {
    const t0 = Date.now();
    perAccountPayloads[rep.slug] = await fetchPerAccount(rep.slug, opts.start, opts.end);
    const days = perAccountPayloads[rep.slug]?.days?.length || 0;
    const customerCount = perAccountPayloads[rep.slug]?.summary?.customers?.length || 0;
    console.log(`  ${rep.slug.padEnd(10)}: ${days} days, ${customerCount} distinct customers in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  }

  console.log('\n[3/3] Comparing per-day totals...');

  const perRepResults = [];
  const allDriftRows = [];

  for (const rep of repsToCheck) {
    const { dailyTotals: accountDaily, assignedToTotals } = aggregatePerAccount(perAccountPayloads[rep.slug], rep.slug);
    const repDaily = aggregatePerRep(perRepPayload, rep.repName);
    const result = compareRep(accountDaily, repDaily, rep.repName);
    perRepResults.push({ rep, summary: result.summary, assignedToTotals });
    allDriftRows.push(...result.driftRows);
    printRepSection({ ...rep, start: opts.start, end: opts.end }, result.summary, assignedToTotals);
  }

  printTopDriftDays(allDriftRows);
  printRecommendation(perRepResults);

  console.log('\n' + '='.repeat(72));
  console.log('AUDIT COMPLETE (read-only — no data was modified)');
  console.log('='.repeat(72));
}

main().catch(err => {
  console.error('\nFATAL:', err.message);
  if (err.response) {
    console.error('Response status:', err.response.status);
    console.error('Response data:', JSON.stringify(err.response.data, null, 2));
  }
  process.exit(1);
});
