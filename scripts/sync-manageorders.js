#!/usr/bin/env node
/**
 * NWCA ManageOrders Archive Sync
 *
 * Smart sync: pulls ShopWorks ManageOrders data into Caspio archive tables.
 * - Pulls ALL orders for last 60 days (1 API call)
 * - Compares against Caspio records
 * - Only fetches line items for NEW or CHANGED orders
 * - Preserves historical data beyond 60-day ManageOrders window
 *
 * Usage:
 *   npm run sync-manageorders                    # Normal daily smart sync
 *   npm run sync-manageorders -- --backfill      # Force update ALL orders + line items
 *
 * Heroku Scheduler: npm run sync-manageorders (daily at 12:00 PM UTC)
 */

const axios = require('axios');

const BASE_URL = process.env.BASE_URL || 'https://caspio-pricing-proxy-ab30a049961a.herokuapp.com';
const CASPIO_BASE = 'https://c3eku948.caspio.com/rest/v2';
const CASPIO_CLIENT_ID = process.env.CASPIO_CLIENT_ID;
const CASPIO_CLIENT_SECRET = process.env.CASPIO_CLIENT_SECRET;
const DAYS_BACK = 60;
const LINE_ITEM_DELAY_MS = 250;
const RATE_LIMIT_WAIT_MS = 62000;
const TIMEOUT = 30000;

// Fields to compare for change detection
const CHANGE_FIELDS = [
  'CustomerName', 'CustomerServiceRep',
  'cur_TotalInvoice', 'cur_Balance', 'cur_Payments', 'cur_Shipping',
  'cur_SubTotal', 'cur_SalesTaxTotal',
  'sts_Paid', 'sts_Shipped', 'sts_Produced', 'sts_Invoiced',
  'TotalProductQuantity',
  'date_Shipped', 'date_Invoiced', 'date_Produced'
];

// ── Helpers ─────────────────────────────────────────────────────────────
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function dateStr(daysBack) {
  const d = new Date();
  d.setDate(d.getDate() - daysBack);
  return d.toISOString().split('T')[0];
}

function cleanStr(val) {
  if (val === null || val === undefined) return '';
  return String(val).replace(/[\t\r\n]/g, ' ').replace(/[^\x20-\x7E]/g, '').trim();
}

function normalize(val) {
  if (val === null || val === undefined || val === '') return '';
  return String(val).trim();
}

// ── Caspio Auth & CRUD ──────────────────────────────────────────────────
let caspioToken = null;

async function getCaspioToken() {
  if (caspioToken) return caspioToken;

  const resp = await axios.post('https://c3eku948.caspio.com/oauth/token',
    `grant_type=client_credentials&client_id=${CASPIO_CLIENT_ID}&client_secret=${CASPIO_CLIENT_SECRET}`,
    { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
  );
  caspioToken = resp.data.access_token;
  return caspioToken;
}

async function caspioRequest(endpoint, method = 'GET', body = null) {
  const token = await getCaspioToken();
  const config = {
    method,
    url: `${CASPIO_BASE}${endpoint}`,
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    validateStatus: () => true // Don't throw on non-2xx
  };
  if (body) config.data = body;

  const resp = await axios(config);
  if (resp.status >= 400) {
    const msg = typeof resp.data === 'string' ? resp.data : JSON.stringify(resp.data);
    throw new Error(`Caspio ${method} ${endpoint}: ${resp.status} - ${msg}`);
  }
  return resp.data || { RecordsAffected: 0, Result: [] };
}

async function caspioReadAll(table, where) {
  const records = [];
  let page = 1;
  while (true) {
    const w = where ? `&q.where=${encodeURIComponent(where)}` : '';
    const data = await caspioRequest(`/tables/${table}/records?q.pageSize=1000&q.pageNumber=${page}${w}`);
    const rows = data.Result || [];
    records.push(...rows);
    if (rows.length < 1000) break;
    page++;
  }
  return records;
}

// ── ManageOrders API (via proxy) ────────────────────────────────────────
async function fetchOrders(startDate, endDate) {
  const url = `${BASE_URL}/api/manageorders/orders?date_Ordered_start=${startDate}&date_Ordered_end=${endDate}`;
  try {
    const resp = await axios.get(url, { timeout: TIMEOUT });
    return resp.data.result || [];
  } catch (err) {
    if (err.response && err.response.status === 429) {
      console.log('  Rate limited on orders fetch, waiting 62s...');
      await sleep(RATE_LIMIT_WAIT_MS);
      const retry = await axios.get(url, { timeout: TIMEOUT });
      return retry.data.result || [];
    }
    throw err;
  }
}

async function fetchLineItems(orderId) {
  const url = `${BASE_URL}/api/manageorders/lineitems/${orderId}`;
  try {
    const resp = await axios.get(url, { timeout: TIMEOUT });
    return resp.data.result || [];
  } catch (err) {
    if (err.response && err.response.status === 429) {
      console.log(`    Rate limited on lineitems/${orderId}, waiting 62s...`);
      await sleep(RATE_LIMIT_WAIT_MS);
      const retry = await axios.get(url, { timeout: TIMEOUT });
      return retry.data.result || [];
    }
    throw err;
  }
}

// ── Data Mapping ────────────────────────────────────────────────────────
function mapOrder(o) {
  return {
    id_Order: parseInt(o.id_Order) || 0,
    id_Customer: parseInt(o.id_Customer) || 0,
    CustomerName: cleanStr(o.CustomerName),
    CustomerServiceRep: cleanStr(o.CustomerServiceRep),
    ContactFirstName: cleanStr(o.ContactFirstName),
    ContactLastName: cleanStr(o.ContactLastName),
    ContactEmail: cleanStr(o.ContactEmail),
    ContactPhone: cleanStr(o.ContactPhone),
    CustomerPurchaseOrder: cleanStr(o.CustomerPurchaseOrder),
    DesignName: cleanStr(o.DesignName),
    id_Design: o.id_Design || null,
    date_Ordered: o.date_Ordered || null,
    date_Invoiced: o.date_Invoiced || null,
    date_RequestedToShip: o.date_RequestedToShip || null,
    date_Shipped: o.date_Shippied || null, // ManageOrders API typo
    date_Produced: o.date_Produced || null,
    TotalProductQuantity: parseInt(o.TotalProductQuantity) || 0,
    cur_SubTotal: parseFloat(o.cur_SubTotal) || 0,
    cur_SalesTaxTotal: parseFloat(o.cur_SalesTaxTotal) || 0,
    cur_TotalInvoice: parseFloat(o.cur_TotalInvoice) || 0,
    cur_Shipping: parseFloat(o.cur_Shipping) || 0,
    cur_Payments: parseFloat(o.cur_Payments) || 0,
    cur_Balance: parseFloat(o.cur_Balance) || 0,
    TermsName: cleanStr(o.TermsName),
    sts_Invoiced: parseInt(o.sts_Invoiced) || 0,
    sts_Paid: parseInt(o.sts_Paid) || 0,
    sts_Produced: parseInt(o.sts_Produced) || 0,
    sts_Shipped: parseInt(o.sts_Shipped) || 0,
    Last_Sync_Date: new Date().toISOString()
  };
}

function mapLineItem(li, orderId) {
  return {
    id_Order: parseInt(orderId) || 0,
    PartNumber: cleanStr(li.PartNumber),
    PartDescription: cleanStr(li.PartDescription),
    PartColor: cleanStr(li.PartColor),
    LineQuantity: parseInt(li.LineQuantity) || 0,
    LineUnitPrice: parseFloat(li.LineUnitPrice) || 0,
    SortOrder: parseInt(li.SortOrder) || 0,
    Size01: li.Size01 != null ? parseInt(li.Size01) || 0 : null,
    Size02: li.Size02 != null ? parseInt(li.Size02) || 0 : null,
    Size03: li.Size03 != null ? parseInt(li.Size03) || 0 : null,
    Size04: li.Size04 != null ? parseInt(li.Size04) || 0 : null,
    Size05: li.Size05 != null ? parseInt(li.Size05) || 0 : null,
    Size06: li.Size06 != null ? parseInt(li.Size06) || 0 : null
  };
}

// ── Change Detection ────────────────────────────────────────────────────
function detectChange(mapped, existing) {
  for (const field of CHANGE_FIELDS) {
    if (normalize(mapped[field]) !== normalize(existing[field])) return field;
  }
  return null;
}

// ── Sync Line Items for One Order ───────────────────────────────────────
async function syncLineItems(orderId) {
  // Delete existing line items
  try {
    await caspioRequest(
      `/tables/ManageOrders_LineItems/records?q.where=${encodeURIComponent(`id_Order=${orderId}`)}`,
      'DELETE'
    );
  } catch (e) { /* OK if none exist */ }

  // Pull fresh from ManageOrders
  const items = await fetchLineItems(orderId);

  // Insert new
  for (const li of items) {
    await caspioRequest('/tables/ManageOrders_LineItems/records', 'POST', mapLineItem(li, orderId));
  }
  return items.length;
}

// ── Main ────────────────────────────────────────────────────────────────
async function main() {
  const isBackfill = process.argv.includes('--backfill');
  const startDate = dateStr(DAYS_BACK);
  const endDate = dateStr(-1);

  console.log(`\n[${new Date().toISOString()}] ManageOrders Smart Sync`);
  console.log(`  Mode: ${isBackfill ? 'BACKFILL (update all)' : 'Daily (smart diff)'}`);
  console.log(`  Range: ${startDate} to ${endDate}`);
  console.log(`  Proxy: ${BASE_URL}\n`);

  if (!CASPIO_CLIENT_ID || !CASPIO_CLIENT_SECRET) {
    console.error('ERROR: CASPIO_CLIENT_ID and CASPIO_CLIENT_SECRET required');
    process.exit(1);
  }

  // Step 1: Pull orders from ManageOrders
  console.log('Step 1: Pulling orders from ManageOrders...');
  const moOrders = await fetchOrders(startDate, endDate);
  console.log(`  Found ${moOrders.length} orders\n`);

  if (!moOrders.length) {
    console.log('No orders found. Done.');
    return;
  }

  // Step 2: Read Caspio archive
  console.log('Step 2: Reading Caspio archive...');
  const caspioOrders = await caspioReadAll('ManageOrders_Orders');
  const caspioMap = new Map();
  for (const co of caspioOrders) {
    caspioMap.set(String(co.id_Order), co);
  }
  console.log(`  Found ${caspioOrders.length} records in Caspio\n`);

  // Step 3: Smart sync
  console.log('Step 3: Syncing...');
  let stats = { new: 0, updated: 0, unchanged: 0, errors: 0, lineItems: 0 };

  for (const mo of moOrders) {
    const id = String(mo.id_Order);
    const mapped = mapOrder(mo);
    const existing = caspioMap.get(id);

    try {
      if (!existing) {
        // New order
        console.log(`  + NEW: ${id} (${cleanStr(mo.CustomerName)})`);
        await caspioRequest('/tables/ManageOrders_Orders/records', 'POST', mapped);
        stats.lineItems += await syncLineItems(mo.id_Order);
        stats.new++;
        await sleep(LINE_ITEM_DELAY_MS);

      } else if (isBackfill) {
        // Backfill: update everything
        await caspioRequest(
          `/tables/ManageOrders_Orders/records?q.where=${encodeURIComponent(`id_Order=${id}`)}`,
          'PUT', mapped
        );
        stats.lineItems += await syncLineItems(mo.id_Order);
        stats.updated++;
        await sleep(LINE_ITEM_DELAY_MS);

      } else {
        // Smart diff
        const changedField = detectChange(mapped, existing);
        if (changedField) {
          console.log(`  ~ CHANGED: ${id} (${cleanStr(mo.CustomerName)}) [${changedField}]`);
          await caspioRequest(
            `/tables/ManageOrders_Orders/records?q.where=${encodeURIComponent(`id_Order=${id}`)}`,
            'PUT', mapped
          );
          stats.lineItems += await syncLineItems(mo.id_Order);
          stats.updated++;
          await sleep(LINE_ITEM_DELAY_MS);
        } else {
          // Just update sync date
          await caspioRequest(
            `/tables/ManageOrders_Orders/records?q.where=${encodeURIComponent(`id_Order=${id}`)}`,
            'PUT', { Last_Sync_Date: new Date().toISOString() }
          );
          stats.unchanged++;
        }
      }
    } catch (err) {
      console.error(`  ! ERROR: ${id}: ${err.message}`);
      stats.errors++;
    }
  }

  // Summary
  console.log(`\n=== SYNC COMPLETE ===`);
  console.log(`  New:       ${stats.new}`);
  console.log(`  Updated:   ${stats.updated}`);
  console.log(`  Unchanged: ${stats.unchanged}`);
  console.log(`  Errors:    ${stats.errors}`);
  console.log(`  Line items synced: ${stats.lineItems}`);
  console.log(`  Total in archive:  ${caspioOrders.length + stats.new}`);
}

main().catch(err => {
  console.error(`\nFATAL: ${err.message}`);
  process.exit(1);
});
