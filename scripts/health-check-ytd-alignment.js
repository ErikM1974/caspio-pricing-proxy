#!/usr/bin/env node
/**
 * Read-only health check: compares per-rep YTD archive vs live MO API totals.
 * No --apply flag, no data modifications.
 */

const axios = require('axios');

const BASE = 'https://caspio-pricing-proxy-ab30a049961a.herokuapp.com';
const TODAY = new Date().toISOString().split('T')[0]; // 2026-05-01

function addDays(dateStr, n) {
  const d = new Date(dateStr);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().split('T')[0];
}

function chunkDateRanges(start, end, chunkDays = 14) {
  const ranges = [];
  let cur = start;
  while (cur <= end) {
    const chunkEnd = addDays(cur, chunkDays - 1) <= end ? addDays(cur, chunkDays - 1) : end;
    ranges.push({ start: cur, end: chunkEnd });
    cur = addDays(chunkEnd, 1);
  }
  return ranges;
}

async function fetchArchiveYTD() {
  const url = `${BASE}/api/caspio/daily-sales-by-rep/ytd?year=2026`;
  console.log(`\nFetching archive YTD: ${url}`);
  const { data } = await axios.get(url, { timeout: 30000 });
  return data;
}

async function fetchMOChunk(start, end) {
  const url = `${BASE}/api/manageorders/orders?date_Invoiced_start=${start}&date_Invoiced_end=${end}&refresh=true`;
  const { data } = await axios.get(url, { timeout: 60000 });
  // Response may be array or { orders: [...] } or { Result: [...] }
  if (Array.isArray(data)) return data;
  if (Array.isArray(data.orders)) return data.orders;
  if (Array.isArray(data.Result)) return data.Result;
  if (Array.isArray(data.result)) return data.result;
  return [];
}

async function fetchAllMOOrders() {
  const ranges = chunkDateRanges('2026-01-01', TODAY, 14);
  console.log(`\nFetching MO orders in ${ranges.length} chunks (Jan 1 → ${TODAY})...`);

  const allOrders = new Map(); // deduplicate by id_Order

  for (const { start, end } of ranges) {
    process.stdout.write(`  ${start} → ${end} ... `);
    try {
      const chunk = await fetchMOChunk(start, end);
      let added = 0;
      for (const order of chunk) {
        if (!order.date_Invoiced) continue;
        if (!allOrders.has(order.id_Order)) {
          allOrders.set(order.id_Order, order);
          added++;
        }
      }
      console.log(`${chunk.length} records, ${added} new`);
    } catch (err) {
      console.log(`ERROR: ${err.message}`);
    }
    // small delay to avoid hammering the proxy
    await new Promise(r => setTimeout(r, 500));
  }

  return [...allOrders.values()];
}

function sumOrders(orders) {
  return orders.reduce((sum, o) => {
    const val = parseFloat(o.cur_SubTotal) || 0;
    return sum + val;
  }, 0);
}

async function main() {
  console.log('='.repeat(60));
  console.log(' NWCA Daily Sales Sync — Health Check');
  console.log(` Run date: ${TODAY}`);
  console.log('='.repeat(60));

  // 1. Archive YTD
  const archiveData = await fetchArchiveYTD();
  console.log('\nArchive response (raw):', JSON.stringify(archiveData, null, 2).slice(0, 800));

  // Tolerate multiple possible response shapes
  const archiveRevenue = parseFloat(
    archiveData.totalRevenue ?? archiveData.total_revenue ?? archiveData.revenue ?? 0
  );
  const archiveOrders = parseInt(
    archiveData.totalOrders ?? archiveData.total_orders ?? archiveData.orderCount ?? 0,
    10
  );

  // 2. MO API truth
  const moOrders = await fetchAllMOOrders();
  const moRevenue = sumOrders(moOrders);
  const moOrderCount = moOrders.length;

  // 3. Compare
  const delta = Math.abs(archiveRevenue - moRevenue);
  const pct = moRevenue > 0 ? (delta / moRevenue) * 100 : 0;
  const orderDiff = Math.abs(archiveOrders - moOrderCount);

  const PASS = delta <= 100 && orderDiff <= 5;

  console.log('\n' + '='.repeat(60));
  console.log(' RESULTS');
  console.log('='.repeat(60));
  console.log(`Archive total  : $${archiveRevenue.toLocaleString('en-US', { minimumFractionDigits: 2 })} / ${archiveOrders.toLocaleString()} orders`);
  console.log(`MO API truth   : $${moRevenue.toLocaleString('en-US', { minimumFractionDigits: 2 })} / ${moOrderCount.toLocaleString()} orders`);
  console.log(`Delta          : $${(archiveRevenue - moRevenue).toLocaleString('en-US', { minimumFractionDigits: 2 })} (${pct.toFixed(2)}%)`);
  console.log(`Order count Δ  : ${archiveOrders - moOrderCount}`);
  console.log(`Verdict        : ${PASS ? '✅ PASS' : '⚠️  FAIL'}`);
  console.log('='.repeat(60));

  if (PASS) {
    console.log(`\n✅ Alignment holding as of ${TODAY}. Archive: $${archiveRevenue.toLocaleString('en-US', { minimumFractionDigits: 2 })} / ${archiveOrders.toLocaleString()} orders. MO truth: $${moRevenue.toLocaleString('en-US', { minimumFractionDigits: 2 })} / ${moOrderCount.toLocaleString()} orders. Delta: $${(archiveRevenue - moRevenue).toFixed(2)}.`);
  } else {
    console.log(`\n⚠️  Drift detected. Archive: $${archiveRevenue.toLocaleString('en-US', { minimumFractionDigits: 2 })} / ${archiveOrders.toLocaleString()} orders. MO truth: $${moRevenue.toLocaleString('en-US', { minimumFractionDigits: 2 })} / ${moOrderCount.toLocaleString()} orders. Delta: $${(archiveRevenue - moRevenue).toFixed(2)}. The 2026-04-28 reconfiguration may not be holding — recommend running \`node scripts/rebuild-rep-archive-from-manageorders.js --apply\` and \`node scripts/rebuild-account-ytd-from-manageorders.js --apply\` from a local terminal (which has CRM_API_SECRET in \`.env\`) to truth-up.`);
  }
}

main().catch(err => {
  console.error('Fatal error:', err.message);
  process.exit(1);
});
