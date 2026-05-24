#!/usr/bin/env node
/**
 * probe-mo-orders-schema.js — single-call diagnostic.
 *
 * Uses RAW axios calls (NOT fetchAllCaspioPages which walks all pages)
 * to peek at ManageOrders_Orders schema + count records cheaply.
 */
'use strict';
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const axios = require('axios');
const config = require('../src/config');
const { getCaspioAccessToken } = require('../src/utils/caspio');

async function rawGet(resourcePath, params = {}) {
  const token = await getCaspioAccessToken();
  const url = `${config.caspio.apiBaseUrl}${resourcePath}`;
  const r = await axios.get(url, {
    params,
    headers: { Authorization: `Bearer ${token}` },
    timeout: 30000,
  });
  return r.data;
}

(async () => {
  console.log('=== 1. Sample 2 rows of ManageOrders_Orders (single call) ===');
  try {
    const r = await rawGet('/tables/ManageOrders_Orders/records', { 'q.limit': 2 });
    const rows = r.Result || [];
    console.log('Rows returned:', rows.length);
    console.log('Caspio echoed PageSize:', r.PageSize, '· PageNumber:', r.PageNumber);
    if (rows.length) {
      const cols = Object.keys(rows[0]).sort();
      console.log('Columns (' + cols.length + '):');
      cols.forEach(c => console.log('  ' + c + ' = ' + JSON.stringify(rows[0][c]).slice(0, 90)));
    }
  } catch (e) {
    console.error('  ERR:', e.response?.status, JSON.stringify(e.response?.data || e.message).slice(0, 300));
  }

  console.log('\n=== 2. Probe ManageOrders_LineItems (single call, 2 rows) ===');
  try {
    const r = await rawGet('/tables/ManageOrders_LineItems/records', { 'q.limit': 2 });
    const rows = r.Result || [];
    console.log('Rows:', rows.length);
    if (rows.length) console.log('Columns:', Object.keys(rows[0]).sort().join(', '));
  } catch (e) {
    console.log('  ERR:', e.response?.status, e.response?.data?.Message || e.message);
  }

  console.log('\n=== 3. Probe ManageOrders_Lines (single call, 2 rows) ===');
  try {
    const r = await rawGet('/tables/ManageOrders_Lines/records', { 'q.limit': 2 });
    const rows = r.Result || [];
    console.log('Rows:', rows.length);
    if (rows.length) console.log('Columns:', Object.keys(rows[0]).sort().join(', '));
  } catch (e) {
    console.log('  ERR:', e.response?.status, e.response?.data?.Message || e.message);
  }
})().catch(e => {
  console.error('FATAL:', e.message);
  process.exit(1);
});
