#!/usr/bin/env node
/**
 * One-off diagnostic: find the 2 specific orders behind the $851 Taneisha drift
 * between the per-rep rebuild ($334,334.35) and the per-account sum ($333,483.35).
 *
 * Hypothesis: orders where order.CustomerServiceRep = "Taneisha Clark" but the
 * customer's Sales_Reps_2026 mapping is NOT Taneisha (or the customer is missing
 * from Sales_Reps_2026 entirely). The rebuild attributes them to Taneisha via
 * the fallback chain; sync-sales skips them because the customer isn't in her
 * roster.
 *
 * Read-only — no writes.
 */

require('dotenv').config();
const axios = require('axios');

const BASE_URL = process.env.BASE_URL || 'https://caspio-pricing-proxy-ab30a049961a.herokuapp.com';
const SECRET = process.env.CRM_API_SECRET;
if (!SECRET) { console.error('CRM_API_SECRET required'); process.exit(1); }
const HDRS = { 'x-crm-api-secret': SECRET };

const TIMEOUT = 60000;
const FETCH_CHUNK_DAYS = 14;
const REP_NAME = 'Taneisha Clark';

function addDays(s, n) { const d = new Date(s+'T00:00:00Z'); d.setUTCDate(d.getUTCDate()+n); return d.toISOString().split('T')[0]; }
function chunks(start, end, n) { const out=[]; let cur=start; while(cur<=end){const e=addDays(cur,n-1); out.push({start:cur, end: e>end?end:e}); cur=addDays(cur,n);} return out; }

async function main() {
  const start = '2026-01-01';
  const end = new Date().toISOString().split('T')[0];
  console.log(`Window: ${start} → ${end}\nLooking for: orders attributed to "${REP_NAME}" only via the order.CustomerServiceRep fallback (NOT via current Sales_Reps_2026)\n`);

  console.log('[1/3] Fetching Sales_Reps_2026 ownership map...');
  const srResp = await axios.get(`${BASE_URL}/api/sales-reps-2026`, { timeout: TIMEOUT, headers: HDRS });
  const ownership = new Map();
  for (const r of srResp.data?.records || []) {
    if (r.ID_Customer && r.CustomerServiceRep) ownership.set(r.ID_Customer, r.CustomerServiceRep);
  }
  console.log(`  ${ownership.size} customer→rep mappings.`);

  console.log('[2/3] Fetching Taneisha account roster...');
  const rosterResp = await axios.get(`${BASE_URL}/api/taneisha-accounts`, { timeout: TIMEOUT, headers: HDRS });
  const roster = new Set((rosterResp.data?.accounts || []).map(a => a.ID_Customer));
  console.log(`  ${roster.size} customers on Taneisha's roster.`);

  console.log('[3/3] Pulling 2026 orders from MO API and filtering...');
  const slices = chunks(start, end, FETCH_CHUNK_DAYS);
  const all = [];
  const seen = new Set();
  for (const c of slices) {
    const url = `${BASE_URL}/api/manageorders/orders?date_Invoiced_start=${c.start}&date_Invoiced_end=${c.end}`;
    const r = await axios.get(url, { timeout: TIMEOUT });
    for (const o of r.data?.result || []) {
      if (seen.has(o.id_Order)) continue;
      seen.add(o.id_Order);
      all.push(o);
    }
  }
  console.log(`  Pulled ${all.length} unique orders.\n`);

  // Aggregate per customer using the SAME rule as the rebuild
  // (Sales_Reps_2026 lookup, fallback to order's snapshot, then 'Unknown')
  // Then compare to each customer's YTD_Sales_2026 on the roster.
  const moPerCustomer = new Map(); // customerId -> { ytd, orderCount, name, orders[] }

  for (const o of all) {
    if (!o.date_Invoiced) continue;
    const cid = o.id_Customer;
    const sub = parseFloat(o.cur_SubTotal) || 0;
    const rebuildRep = ownership.get(cid) || o.CustomerServiceRep || 'Unknown';
    if (rebuildRep !== REP_NAME) continue;

    if (!moPerCustomer.has(cid)) {
      moPerCustomer.set(cid, { ytd: 0, orderCount: 0, name: o.CustomerName || '', orders: [] });
    }
    const c = moPerCustomer.get(cid);
    c.ytd += sub;
    c.orderCount += 1;
    c.orders.push({ id: o.id_Order, date: o.date_Invoiced.slice(0,10), sub, rep: o.CustomerServiceRep });
  }

  // Now compare to roster YTD_Sales_2026
  const rosterMap = new Map();
  for (const a of rosterResp.data?.accounts || []) {
    rosterMap.set(a.ID_Customer, {
      name: a.CompanyName,
      rosterYTD: parseFloat(a.YTD_Sales_2026) || 0,
      rosterOrders: parseInt(a.Order_Count_2026) || 0,
      lastSync: a.Last_Sync_Date
    });
  }

  // Per-customer diffs
  const diffs = [];
  const allCustomers = new Set([...moPerCustomer.keys(), ...rosterMap.keys()]);
  for (const cid of allCustomers) {
    const mo = moPerCustomer.get(cid) || { ytd: 0, orderCount: 0, name: '(not in MO)', orders: [] };
    const r = rosterMap.get(cid) || { name: '(not on roster)', rosterYTD: 0, rosterOrders: 0 };
    const delta = Math.round((mo.ytd - r.rosterYTD) * 100) / 100;
    if (Math.abs(delta) >= 0.01 || mo.orderCount !== r.rosterOrders) {
      diffs.push({ cid, name: r.name || mo.name, mo, r, delta, deltaOrders: mo.orderCount - r.rosterOrders });
    }
  }
  diffs.sort((a,b) => Math.abs(b.delta) - Math.abs(a.delta));

  const totalDelta = diffs.reduce((s,d) => s+d.delta, 0);
  const totalOrderDelta = diffs.reduce((s,d) => s+d.deltaOrders, 0);
  console.log(`=== Per-customer drift between MO truth and roster YTD_Sales_2026 ===`);
  console.log(`Customers with any diff: ${diffs.length}`);
  console.log(`Sum of diffs:            $${totalDelta.toFixed(2)} / ${totalOrderDelta} orders`);
  console.log(`(Should match the $-851 / -2 reported gap)\n`);

  // Show top 10 by absolute diff
  for (const d of diffs.slice(0, 10)) {
    const onRoster = rosterMap.has(d.cid);
    console.log(`  Customer ID=${d.cid}  "${d.name}"`);
    console.log(`    MO truth:    $${d.mo.ytd.toFixed(2)} / ${d.mo.orderCount} orders`);
    console.log(`    Roster YTD:  $${d.r.rosterYTD.toFixed(2)} / ${d.r.rosterOrders} orders   ${onRoster ? `(synced ${d.r.lastSync || 'never'})` : '(not on roster)'}`);
    console.log(`    Δ:           $${d.delta.toFixed(2)} / ${d.deltaOrders} orders`);
    if (d.mo.orders.length && d.mo.orders.length <= 6) {
      for (const ord of d.mo.orders) {
        console.log(`      Order ${ord.id}  ${ord.date}  $${ord.sub.toFixed(2)}  rep_snapshot="${ord.rep || ''}"`);
      }
    } else if (d.mo.orders.length) {
      console.log(`      (${d.mo.orders.length} orders, listing first 3)`);
      for (const ord of d.mo.orders.slice(0,3)) {
        console.log(`      Order ${ord.id}  ${ord.date}  $${ord.sub.toFixed(2)}`);
      }
    }
    console.log('');
  }
}

main().catch(e => { console.error('FATAL:', e.message); if(e.response) console.error(JSON.stringify(e.response.data)); process.exit(1); });
