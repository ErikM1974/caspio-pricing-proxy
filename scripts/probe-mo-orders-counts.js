#!/usr/bin/env node
/**
 * probe-mo-orders-counts.js — measure size of MO tables.
 * Uses single GET with q.where date filter + q.pageSize to bound the response.
 */
'use strict';
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const axios = require('axios');
const config = require('../src/config');
const { getCaspioAccessToken } = require('../src/utils/caspio');

async function rawGet(resourcePath, params = {}) {
  const token = await getCaspioAccessToken();
  return (await axios.get(`${config.caspio.apiBaseUrl}${resourcePath}`, {
    params,
    headers: { Authorization: `Bearer ${token}` },
    timeout: 60000,
  })).data;
}

async function pageCount(table, where) {
  // Walk pages 1..N, counting until we hit an empty page.
  // Use pageSize=1000 (Caspio max).
  let n = 0, page = 1, lastNonZero = 0;
  while (true) {
    const r = await rawGet(`/tables/${table}/records`, {
      'q.where': where,
      'q.select': 'PK_ID',
      'q.pageSize': 1000,
      'q.pageNumber': page,
    });
    const got = (r.Result || []).length;
    n += got;
    if (got < 1000) break;
    page++;
    if (page % 5 === 0) console.log(`  [${table}] page ${page}, running total ${n}`);
    lastNonZero = page;
    if (page > 100) { console.log('  bailout at 100 pages = 100K rows'); break; }
  }
  return n;
}

(async () => {
  const today = new Date();
  const oneYearAgo = new Date(today.getTime() - 365 * 24 * 3600 * 1000)
      .toISOString().slice(0, 10);
  console.log('Cutoff (1yr ago):', oneYearAgo);

  console.log('\n=== ManageOrders_Orders date_Ordered >= ' + oneYearAgo + ' ===');
  const n1 = await pageCount('ManageOrders_Orders', `date_Ordered>='${oneYearAgo}'`);
  console.log(`✓ Total orders in last 365 days: ${n1}`);

  console.log('\n=== ManageOrders_Orders all-time (no date filter) ===');
  const n2 = await pageCount('ManageOrders_Orders', '1=1');
  console.log(`✓ Total orders all-time: ${n2}`);

  console.log('\n=== ManageOrders_LineItems all-time (proxy via id_Order) ===');
  // line items don't have date — count by id_Order being non-null
  const n3 = await pageCount('ManageOrders_LineItems', 'id_Order IS NOT NULL');
  console.log(`✓ Total line items all-time: ${n3}`);
})().catch(e => {
  console.error('FATAL:', e.response?.data || e.message);
  process.exit(1);
});
