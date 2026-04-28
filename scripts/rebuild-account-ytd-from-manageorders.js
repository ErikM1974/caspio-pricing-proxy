#!/usr/bin/env node
/**
 * NWCA Per-Account YTD Rebuild from ManageOrders API
 *
 * Companion to rebuild-rep-archive-from-manageorders.js. That script rebuilds
 * NW_Daily_Sales_By_Rep (the per-rep daily archive) from MO API. This one does
 * the per-customer YTD totals stored on each rep's account roster
 * (Nika_All_Accounts_Caspio.YTD_Sales_2026 / Taneisha_All_Accounts_Caspio).
 *
 * Background: the existing /sync-sales endpoint merges archive (>60 days) +
 * live MO data (<60 days) to compute each customer's YTD. That merge has a
 * blind spot: if a customer was added to the rep's roster AFTER their pre-60-day
 * orders were archived, the archive table has no row for them, the live fetch
 * doesn't reach back that far, so their YTD stays at 0. Confirmed today on
 * Taneisha: Peter Guarino ($588) and Superheat LLC ($263) — the entire $851
 * gap between her per-rep headline and her per-account sum.
 *
 * MO API has 19+ months of pull retention (verified 2026-04-28), so we can
 * just fetch every 2026 order directly and rebuild each customer's YTD from
 * source. No archive dependency, no merge logic, no blind spot.
 *
 * Usage:
 *   node scripts/rebuild-account-ytd-from-manageorders.js [--rep nika|taneisha|all] [--start ...] [--end ...] [--apply] [--concurrency N]
 *
 *   Defaults: --rep all, --start 2026-01-01, --end <today>, --concurrency 5
 *   Dry-run by default; --apply writes via PUT /api/{rep}-accounts/:id.
 */

require('dotenv').config();
const axios = require('axios');

const BASE_URL = process.env.BASE_URL || 'https://caspio-pricing-proxy-ab30a049961a.herokuapp.com';
const CRM_API_SECRET = process.env.CRM_API_SECRET;
if (!CRM_API_SECRET) { console.error('CRM_API_SECRET required'); process.exit(1); }
const HDRS = { 'x-crm-api-secret': CRM_API_SECRET };

const FETCH_CHUNK_DAYS = 14;
const TIMEOUT = 60000;

const REPS = {
  nika:     { name: 'Nika Lao',       endpoint: '/api/nika-accounts' },
  taneisha: { name: 'Taneisha Clark', endpoint: '/api/taneisha-accounts' },
};

function parseArgs() {
  const a = process.argv.slice(2);
  const o = { rep: 'all', start: '2026-01-01', end: new Date().toISOString().split('T')[0], apply: false, concurrency: 5 };
  for (let i=0; i<a.length; i++) {
    if (a[i]==='--rep') o.rep = a[++i];
    else if (a[i]==='--start') o.start = a[++i];
    else if (a[i]==='--end') o.end = a[++i];
    else if (a[i]==='--apply') o.apply = true;
    else if (a[i]==='--concurrency') o.concurrency = parseInt(a[++i]) || 5;
  }
  return o;
}

const fmtUsd = n => '$' + (Math.round(n*100)/100).toFixed(2);
const addDays = (s, n) => { const d = new Date(s+'T00:00:00Z'); d.setUTCDate(d.getUTCDate()+n); return d.toISOString().split('T')[0]; };
function chunks(start, end, n) { const out=[]; let cur=start; while(cur<=end){const e=addDays(cur,n-1); out.push({start:cur, end: e>end?end:e}); cur=addDays(cur,n);} return out; }

async function fetchOrdersInWindow(start, end) {
  const slices = chunks(start, end, FETCH_CHUNK_DAYS);
  console.log(`  Pulling ${slices.length} chunk(s) from ${start} → ${end}...`);
  const all = [];
  const seen = new Set();
  for (const [i,c] of slices.entries()) {
    const url = `${BASE_URL}/api/manageorders/orders?date_Invoiced_start=${c.start}&date_Invoiced_end=${c.end}&refresh=true`;
    const t0 = Date.now();
    const r = await axios.get(url, { timeout: TIMEOUT });
    const orders = r.data?.result || [];
    let added = 0;
    for (const o of orders) { if (!seen.has(o.id_Order)) { seen.add(o.id_Order); all.push(o); added++; } }
    console.log(`    [${i+1}/${slices.length}] ${c.start} → ${c.end}: ${orders.length} orders (${added} new) in ${((Date.now()-t0)/1000).toFixed(1)}s`);
  }
  return all;
}

async function fetchOwnership() {
  const r = await axios.get(`${BASE_URL}/api/sales-reps-2026`, { timeout: TIMEOUT, headers: HDRS });
  const map = new Map();
  for (const x of r.data?.records || []) {
    if (x.ID_Customer && x.CustomerServiceRep) map.set(x.ID_Customer, x.CustomerServiceRep);
  }
  return map;
}

async function fetchRoster(endpoint) {
  const r = await axios.get(`${BASE_URL}${endpoint}`, { timeout: TIMEOUT, headers: HDRS });
  // nika-accounts returns {records: [...]}, taneisha-accounts returns {accounts: [...]} — handle both
  return r.data?.records || r.data?.accounts || [];
}

function aggregateByCustomer(orders, ownership, repName) {
  // (id_Customer) -> { ytd, orderCount, lastOrderDate, name }
  const map = new Map();
  for (const o of orders) {
    if (!o.date_Invoiced) continue;
    const cid = o.id_Customer;
    const attribution = ownership.get(cid) || o.CustomerServiceRep || 'Unknown';
    if (attribution !== repName) continue;
    const sub = parseFloat(o.cur_SubTotal) || 0;
    const date = o.date_Invoiced.slice(0,10);
    if (!map.has(cid)) map.set(cid, { ytd: 0, orderCount: 0, lastOrderDate: null, name: o.CustomerName || '' });
    const c = map.get(cid);
    c.ytd += sub;
    c.orderCount += 1;
    if (!c.lastOrderDate || date > c.lastOrderDate) c.lastOrderDate = date;
  }
  // Round to cents
  for (const c of map.values()) c.ytd = Math.round(c.ytd*100)/100;
  return map;
}

function computeChangeset(moPerCustomer, roster) {
  const changeset = [];     // [{ id, name, current: {ytd, orderCount}, target: {ytd, orderCount, lastOrderDate}, action }]
  const orphansFromMO = []; // attributed by MO/Sales_Reps_2026 but not on roster
  const rosterIdsSeen = new Set();

  // For each customer on the roster
  for (const acct of roster) {
    const cid = acct.ID_Customer;
    rosterIdsSeen.add(cid);
    const cur = {
      ytd: parseFloat(acct.YTD_Sales_2026) || 0,
      orderCount: parseInt(acct.Order_Count_2026) || 0,
      lastOrderDate: acct.Last_Order_Date,
    };
    const moData = moPerCustomer.get(cid);
    const target = moData ? { ytd: moData.ytd, orderCount: moData.orderCount, lastOrderDate: moData.lastOrderDate } : { ytd: 0, orderCount: 0, lastOrderDate: null };

    const ytdChanged = Math.abs(target.ytd - cur.ytd) >= 0.01;
    const countChanged = target.orderCount !== cur.orderCount;
    if (ytdChanged || countChanged) {
      changeset.push({
        id: cid,
        name: acct.CompanyName,
        current: cur,
        target: target,
        action: target.ytd > 0 ? (cur.ytd > 0 ? 'update' : 'add') : 'zero',
      });
    }
  }

  // Customers in MO data attributed to this rep but NOT on roster
  for (const [cid, mo] of moPerCustomer) {
    if (!rosterIdsSeen.has(cid)) {
      orphansFromMO.push({ id: cid, name: mo.name, ytd: mo.ytd, orderCount: mo.orderCount });
    }
  }

  return { changeset, orphansFromMO };
}

async function applyUpdates(endpoint, changeset, concurrency) {
  const syncTimestamp = new Date().toISOString();
  let done = 0, failed = 0;
  const errors = [];
  // Simple concurrency limiter
  const queue = [...changeset];
  async function worker() {
    while (queue.length) {
      const c = queue.shift();
      const updateData = {
        YTD_Sales_2026: c.target.ytd,
        Order_Count_2026: c.target.orderCount,
        Last_Sync_Date: syncTimestamp,
      };
      if (c.target.lastOrderDate) updateData.Last_Order_Date = c.target.lastOrderDate;
      try {
        await axios.put(`${BASE_URL}${endpoint}/${c.id}`, updateData, { timeout: 15000, headers: { ...HDRS, 'Content-Type': 'application/json' } });
        done++;
      } catch (e) {
        failed++;
        errors.push({ id: c.id, name: c.name, error: e.response?.data?.error || e.message });
      }
      if ((done + failed) % 25 === 0) {
        console.log(`    progress: ${done + failed}/${changeset.length} (${failed} failed)`);
      }
    }
  }
  await Promise.all(Array.from({length: concurrency}, () => worker()));
  return { done, failed, errors };
}

async function processRep(repKey, opts, ownership, allOrders) {
  const { name, endpoint } = REPS[repKey];
  console.log('\n' + '='.repeat(72));
  console.log(`[${name}]`);
  console.log('='.repeat(72));

  console.log(`  Fetching roster from ${endpoint}...`);
  const roster = await fetchRoster(endpoint);
  console.log(`  ${roster.length} customers on roster.`);

  const moPerCustomer = aggregateByCustomer(allOrders, ownership, name);
  const moTotal = [...moPerCustomer.values()].reduce((s,c) => s+c.ytd, 0);
  const moOrders = [...moPerCustomer.values()].reduce((s,c) => s+c.orderCount, 0);
  console.log(`  MO data attributes ${moPerCustomer.size} customers / ${moOrders} orders / ${fmtUsd(moTotal)} to ${name}.`);

  const { changeset, orphansFromMO } = computeChangeset(moPerCustomer, roster);

  // Current totals for comparison
  const curRosterTotal = roster.reduce((s,a) => s + (parseFloat(a.YTD_Sales_2026) || 0), 0);
  const curRosterOrders = roster.reduce((s,a) => s + (parseInt(a.Order_Count_2026) || 0), 0);

  // Projected totals after apply
  const projTotal = roster.reduce((s,a) => {
    const cs = changeset.find(c => c.id === a.ID_Customer);
    return s + (cs ? cs.target.ytd : (parseFloat(a.YTD_Sales_2026) || 0));
  }, 0);
  const projOrders = roster.reduce((s,a) => {
    const cs = changeset.find(c => c.id === a.ID_Customer);
    return s + (cs ? cs.target.orderCount : (parseInt(a.Order_Count_2026) || 0));
  }, 0);

  console.log('');
  console.log(`  Current roster sum: ${fmtUsd(curRosterTotal)} / ${curRosterOrders} orders`);
  console.log(`  Projected post-apply: ${fmtUsd(projTotal)} / ${projOrders} orders`);
  console.log(`  Δ: ${fmtUsd(projTotal - curRosterTotal)} / ${projOrders - curRosterOrders} orders`);
  console.log('');
  console.log(`  Changeset: ${changeset.length} customers (${changeset.filter(c => c.action==='add').length} add, ${changeset.filter(c => c.action==='update').length} update, ${changeset.filter(c => c.action==='zero').length} zero-out)`);

  // Top 10 by absolute delta
  if (changeset.length) {
    console.log(`  Top 10 changes by |Δ|:`);
    const sorted = [...changeset].sort((a,b) => Math.abs(b.target.ytd - b.current.ytd) - Math.abs(a.target.ytd - a.current.ytd)).slice(0, 10);
    for (const c of sorted) {
      const d = c.target.ytd - c.current.ytd;
      console.log(`    [${c.action.padEnd(6)}] ${(c.name||'').padEnd(40)} cur=${fmtUsd(c.current.ytd)}/${c.current.orderCount} → tgt=${fmtUsd(c.target.ytd)}/${c.target.orderCount}  Δ=${fmtUsd(d)}`);
    }
  }

  if (orphansFromMO.length) {
    console.log('');
    console.log(`  ⚠ ${orphansFromMO.length} customers attributed by MO/Sales_Reps_2026 but NOT on roster (sum=${fmtUsd(orphansFromMO.reduce((s,o)=>s+o.ytd,0))}):`);
    for (const o of orphansFromMO.slice(0, 5)) {
      console.log(`    ID=${o.id} "${o.name}" ${fmtUsd(o.ytd)} / ${o.orderCount} orders`);
    }
    if (orphansFromMO.length > 5) console.log(`    ...and ${orphansFromMO.length - 5} more`);
    console.log(`    (Run /sync-ownership to add them to the roster, then re-run this script.)`);
  }

  if (!opts.apply) return { skipped: true, changesetSize: changeset.length };

  console.log(`\n  APPLY: PUTting ${changeset.length} updates with concurrency=${opts.concurrency}...`);
  const t0 = Date.now();
  const result = await applyUpdates(endpoint, changeset, opts.concurrency);
  console.log(`  Done in ${((Date.now()-t0)/1000).toFixed(1)}s: ${result.done} succeeded, ${result.failed} failed.`);
  if (result.errors.length) {
    console.log(`  First 5 errors:`);
    for (const e of result.errors.slice(0,5)) console.log(`    ID=${e.id} "${e.name}": ${e.error}`);
  }
  return result;
}

async function main() {
  const opts = parseArgs();
  if (opts.rep !== 'all' && !REPS[opts.rep]) { console.error('Invalid --rep, must be nika|taneisha|all'); process.exit(1); }

  console.log('='.repeat(72));
  console.log('NWCA Per-Account YTD Rebuild from ManageOrders');
  console.log(`Started: ${new Date().toISOString()}`);
  console.log(`Window:  ${opts.start} → ${opts.end}`);
  console.log(`Reps:    ${opts.rep === 'all' ? Object.values(REPS).map(r=>r.name).join(', ') : REPS[opts.rep].name}`);
  console.log(`Mode:    ${opts.apply ? `APPLY (concurrency=${opts.concurrency})` : 'DRY RUN'}`);
  console.log('='.repeat(72));

  console.log('\n[1/3] Fetching shared data (Sales_Reps_2026 + MO orders)...');
  const ownership = await fetchOwnership();
  console.log(`  ${ownership.size} customer→rep mappings loaded.`);
  const allOrders = await fetchOrdersInWindow(opts.start, opts.end);
  console.log(`  Pulled ${allOrders.length} unique orders.`);

  console.log('\n[2/3] Processing reps...');
  const repsToProcess = opts.rep === 'all' ? Object.keys(REPS) : [opts.rep];
  for (const r of repsToProcess) {
    await processRep(r, opts, ownership, allOrders);
  }

  console.log('\n' + '='.repeat(72));
  console.log(opts.apply ? 'REBUILD COMPLETE' : 'DRY RUN COMPLETE — re-run with --apply to write');
  console.log('='.repeat(72));
}

main().catch(e => { console.error('\nFATAL:', e.message); if(e.response) console.error('Response:', JSON.stringify(e.response.data)); process.exit(1); });
