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

// Metering: requiring api-tracker installs the global Caspio axios interceptor.
// This script builds its own CASPIO_BASE URLs with raw axios, so without this line
// nothing here is counted — it was ~910 calls/day invisible to the meter and to
// API_Usage_Daily. The interceptor attaches to the shared default axios instance,
// so the requires below are covered. Do not remove.
//
// The require transitively loads src/config, which process.exit(1)s — UNCATCHABLY —
// when CASPIO_ACCOUNT_DOMAIN is unset. Guard it so a metering import can never kill
// a sync on a machine without that env var. Heroku always sets it.
if (process.env.CASPIO_ACCOUNT_DOMAIN) {
  require('../src/utils/api-tracker');
} else {
  console.warn('[meter] CASPIO_ACCOUNT_DOMAIN unset — Caspio call metering is OFF for this run');
}

const axios = require('axios');

const BASE_URL = process.env.BASE_URL || 'https://caspio-pricing-proxy-ab30a049961a.herokuapp.com';
const CASPIO_BASE = 'https://c3eku948.caspio.com/rest/v2';
const CASPIO_CLIENT_ID = process.env.CASPIO_CLIENT_ID;
const CASPIO_CLIENT_SECRET = process.env.CASPIO_CLIENT_SECRET;
// GET /api/manageorders/* reads are PII-gated behind requireCrmApiSecret (server.js, v878
// 2026-07-05). Without this header every fetch 401s — the sync silently froze 7/4→7/16.
const CRM_API_SECRET = process.env.CRM_API_SECRET;
const DAYS_BACK = 60;
const LINE_ITEM_DELAY_MS = 250;
// Extended line-item columns (Erik 2026-09-02): Line_Key (id_Order-SortOrder, UNIQUE), id_Customer,
// id_OrderType, Style, Is_Garment, SanMar_PieceCost — read by the customer-portal reward engine and
// Caspio reports. Written ONLY when LINEITEMS_EXTENDED=1 (Heroku config var), because a POST that
// names a column the table does not have is a 400 — flip the var AFTER the six columns exist.
const LINEITEMS_EXTENDED = process.env.LINEITEMS_EXTENDED === '1';
// Orders present in the archive with ZERO archived lines (a failed line fetch that was never
// retried) are repaired, at most this many per run, so a bad day cannot snowball into a crawl.
const REPAIR_MISSING_LINES_MAX = 25;
// Orders OLDER than DAYS_BACK that ShopWorks reopened and re-invoiced (price change, credit,
// zeroed after a rejection) would keep stale lines forever — the daily pull is by date_Ordered.
// ORDER_ODBC (bandit agent, delta by timestamp_Modification every 15 min) carries the CURRENT
// subtotal / invoice date for any order touched, whatever its age; a mismatch against the
// archive re-pulls that order from ManageOrders. Bounded per run; look back this many months.
const REOPENED_LOOKBACK_MONTHS = 13;
const REOPENED_MAX = 25;
// Part numbers that are decoration / fees / setup, never a garment (mirrors the app's rule).
const NON_GARMENT_RE = /^(SETUP|LTM|FEE|TAX|SHIP|DISC|RUSH|ART|GRT|MOCK|DIGI|RWD|AL$|AL-|DECG|DECC|DD$|DDE|DDT|SPSU|SEG|SECC|CDP|3D-|LASER|TRANSFER|FREIGHT|MONOGRAM|NAME|EMBLEM|VELLUM|COLOR)/i;
const RATE_LIMIT_WAIT_MS = 62000;
const TIMEOUT = 30000;

// Fields to compare for change detection
const CHANGE_FIELDS = [
  'CustomerName', 'CustomerServiceRep',
  'cur_TotalInvoice', 'cur_Balance', 'cur_Payments', 'cur_Shipping',
  'cur_SubTotal', 'cur_SalesTaxTotal',
  'sts_Paid', 'sts_Shipped', 'sts_Produced', 'sts_Invoiced',
  'TotalProductQuantity',
  'date_Shipped', 'date_Invoiced', 'date_Produced',
  'cur_Adjustment', 'sts_Purchased', 'sts_Received', 'sts_ArtDone',
  'sts_PurchasedSub', 'sts_ReceivedSub'
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
  const s = String(val).trim();
  // Canonicalise ISO datetimes before comparing. The ManageOrders API returns
  // "2026-07-27T00:00:00.000Z" while Caspio hands the same value back as
  // "2026-07-27T00:00:00" — no milliseconds, no zone. Compared as raw strings
  // they are NEVER equal, so every order carrying date_Shipped, date_Invoiced or
  // date_Produced was detected as "changed" on EVERY run, forever, and re-PUT
  // along with a full delete-and-repost of its line items.
  //
  // Measured 2026-07-29: 457 of 611 orders in the 60-day window were flagged
  // changed — 403 on date_Shipped, 43 on date_Invoiced, 10 on date_Produced, and
  // exactly ONE (a CustomerName edit) that was real. That drove ~2,901 billed
  // Caspio calls in a single run, ~18% of the daily budget.
  //
  // Trimming to seconds only removes format noise: a genuinely different date or
  // time still compares different. These are date fields (both sides carry
  // T00:00:00), so dropping the Z cannot shift one across a day boundary.
  const iso = s.match(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})/);
  return iso ? iso[1] : s;
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

// ── Heartbeat ─────────────────────────────────────────────────────────────────
// This sync writes ONLY rows that changed, so a quiet weekend leaves no trace and
// looks exactly like a dead job. It has been dead before — silently, 7/4→7/16 2026,
// twelve days — and nothing noticed. Anything reading Last_Sync_Date to judge
// freshness therefore false-alarms every Monday AND misses a real freeze.
// The heartbeat records the RUN, including a zero-change run, which is the only
// signal that separates the two. Same table and shape the ODBC syncs already use.
//
// Timestamps are written WITHOUT a trailing 'Z' — Caspio timestamp fields mangle it
// (see caspio_pacific_timestamps.md). UTC wall-clock, read back on a UTC dyno.
const HEARTBEAT_SYNC_NAME = 'manageorders-orders';

async function stampHeartbeat(rows, summary) {
  const data = {
    Last_Success: new Date().toISOString().slice(0, 19),
    Last_Rows: rows,
    Last_Summary: String(summary).slice(0, 250),
  };
  const where = encodeURIComponent(`Sync_Name='${HEARTBEAT_SYNC_NAME}'`);
  const put = await caspioRequest(`/tables/Sync_Heartbeats/records?q.where=${where}`, 'PUT', data);
  if (((put && put.RecordsAffected) || 0) === 0) {
    await caspioRequest('/tables/Sync_Heartbeats/records', 'POST',
      Object.assign({ Sync_Name: HEARTBEAT_SYNC_NAME }, data));
  }
}

// q.orderBy=PK_ID is MANDATORY, not cosmetic: Caspio's paged reads are not
// stably ordered without it, so rows silently drop and duplicate across page
// boundaries. Both callers here read multi-page tables, and the line-item
// comparison below treats "absent from this result" as "not in the archive" —
// a dropped row would look like a deletion and trigger a needless re-sync,
// while a duplicated one would break the count check.
async function caspioReadAll(table, where) {
  const records = [];
  let page = 1;
  while (true) {
    const w = where ? `&q.where=${encodeURIComponent(where)}` : '';
    const data = await caspioRequest(`/tables/${table}/records?q.pageSize=1000&q.orderBy=PK_ID&q.pageNumber=${page}${w}`);
    const rows = data.Result || [];
    records.push(...rows);
    if (rows.length < 1000) break;
    page++;
  }
  return records;
}

// ── ManageOrders API (via proxy) ────────────────────────────────────────
const MAX_RETRIES = 3;

async function fetchWithRetry(url, label) {
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const resp = await axios.get(url, {
        timeout: TIMEOUT,
        headers: { 'x-crm-api-secret': CRM_API_SECRET }
      });
      return resp.data.result || [];
    } catch (err) {
      if (err.response && err.response.status === 429 && attempt < MAX_RETRIES) {
        const wait = RATE_LIMIT_WAIT_MS * attempt;
        console.log(`    Rate limited on ${label}, attempt ${attempt}/${MAX_RETRIES}, waiting ${Math.round(wait/1000)}s...`);
        await sleep(wait);
      } else {
        throw err;
      }
    }
  }
}

async function fetchOrders(startDate, endDate) {
  return fetchWithRetry(
    `${BASE_URL}/api/manageorders/orders?date_Ordered_start=${startDate}&date_Ordered_end=${endDate}`,
    'orders fetch'
  );
}

// One order header by number, bypassing the proxy's cache (a reopened order must not read stale).
async function fetchOrderFresh(orderId) {
  const j = await fetchWithRetry(`${BASE_URL}/api/manageorders/orders/${orderId}?refresh=true`, `order/${orderId}`);
  const arr = Array.isArray(j) ? j : (Array.isArray(j.result) ? j.result : (j.result ? [j.result] : []));
  return arr.find((o) => String(o.id_Order) === String(orderId)) || null;
}

async function fetchLineItems(orderId) {
  return fetchWithRetry(
    `${BASE_URL}/api/manageorders/lineitems/${orderId}`,
    `lineitems/${orderId}`
  );
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
    id_OrderType: parseInt(o.id_OrderType) || 0,
    id_CustomerInternal: parseInt(o.id_CustomerInternal) || 0,
    id_URL: cleanStr(o.id_URL),
    ContactFax: cleanStr(o.ContactFax),
    ContactTitle: cleanStr(o.ContactTitle),
    ContactDepartment: cleanStr(o.ContactDepartment),
    cur_Adjustment: parseFloat(o.cur_Adjustment) || 0,
    TermsDays: parseInt(o.TermsDays) || 0,
    sts_SizingType: parseFloat(o.sts_SizingType) || 0,
    sts_Purchased: cleanStr(o.sts_Purchased),
    sts_Received: cleanStr(o.sts_Received),
    sts_ReceivedSub: parseFloat(o.sts_ReceivedSub) || 0,
    sts_PurchasedSub: parseFloat(o.sts_PurchasedSub) || 0,
    sts_ArtDone: parseFloat(o.sts_ArtDone) || 0,
    // Order_Type_Name: read-only formula field in Caspio — don't write, just read via q.select
    Backfill_Source: 'daily_sync',
    Last_Sync_Date: new Date().toISOString()
  };
}

// SanMar piece cost per style (lowest PIECE_PRICE of the ordered color = base-size cost), via the
// proxy's own /api/product-details (Caspio-backed, one call per distinct style per run).
const _styleRows = new Map();
async function pieceCost(style, color) {
  const key = String(style).toUpperCase();
  if (!_styleRows.has(key)) {
    try {
      const r = await axios.get(`${BASE_URL}/api/product-details?styleNumber=${encodeURIComponent(style)}`, { headers: { 'X-CRM-API-Secret': CRM_API_SECRET }, timeout: TIMEOUT });
      _styleRows.set(key, Array.isArray(r.data) ? r.data : []);
    } catch (_) { _styleRows.set(key, []); }
  }
  const rows = _styleRows.get(key);
  if (!rows.length) return null;
  const n = (v) => String(v || '').toLowerCase().replace(/[^a-z0-9]/g, ''); const w = n(color);
  const m = rows.find((x) => n(x.COLOR_NAME) === w) || rows.find((x) => n(x.CATALOG_COLOR) === w) || rows.find((x) => { const c = n(x.COLOR_NAME); return c && (c.includes(w) || w.includes(c)); });
  const pool = m ? rows.filter((x) => x.COLOR_NAME === m.COLOR_NAME) : rows;
  const costs = pool.map((x) => Number(x.PIECE_PRICE)).filter((v) => v > 0);
  return costs.length ? Math.min(...costs) : null;
}
function garmentStyle(li) {
  const pn = cleanStr(li.PartNumber).trim(); const color = cleanStr(li.PartColor).trim();
  if (!pn || !color || NON_GARMENT_RE.test(pn)) return null;
  return pn.split('_')[0];
}
// Extended columns for one line; `order` is the ManageOrders header the line belongs to.
async function extendedLineFields(li, orderId, order) {
  const style = garmentStyle(li);
  const cost = style ? await pieceCost(style, li.PartColor) : null;
  return {
    Line_Key: `${parseInt(orderId) || 0}-${parseInt(li.SortOrder) || 0}`,
    id_Customer: order ? (parseInt(order.id_Customer) || 0) : 0,
    id_OrderType: order ? (parseInt(order.id_OrderType) || 0) : 0,
    Style: style || '',
    Is_Garment: style ? 'Yes' : 'No',
    SanMar_PieceCost: cost == null ? null : cost,
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

// ── Line-item comparison ────────────────────────────────────────────────
// An order "changes" whenever ANY of CHANGE_FIELDS moves, and most of those are
// order-level money/status fields — a payment posting, an invoice date, a ship
// flag. None of them touch line items, yet every one used to trigger a full
// DELETE + N POSTs. Measured 2026-07-29: sync-manageorders spent 2,901 billed
// Caspio calls in 22 minutes, ~18% of the entire daily budget, mostly re-writing
// line items that were byte-identical to what was already stored.
//
// Comparing CONTENT rather than guessing which order fields imply a line-item
// change: a heuristic (e.g. "only re-sync when TotalProductQuantity moves") would
// silently miss a colour or description edit that leaves totals untouched, and
// that stale PartColor feeds check-zero-billing's PartNumber+PartColor match.
const LINE_ITEM_FIELDS = [
  'PartNumber', 'PartDescription', 'PartColor', 'LineQuantity', 'LineUnitPrice',
  'SortOrder', 'Size01', 'Size02', 'Size03', 'Size04', 'Size05', 'Size06'
];
const NUMERIC_LINE_ITEM_FIELDS = new Set([
  'LineQuantity', 'LineUnitPrice', 'SortOrder',
  'Size01', 'Size02', 'Size03', 'Size04', 'Size05', 'Size06'
]);

// Verified against live rows 2026-07-29: Caspio round-trips these cleanly —
// unset sizes come back as null (not coerced to 0), numbers stay numbers and
// strings stay strings — so a value-wise comparison is exact. Numerics are
// normalised through Number() so 60, 60.0 and "60" compare equal.
function lineItemSignature(row) {
  return LINE_ITEM_FIELDS.map(f => {
    const v = row[f];
    if (v === null || v === undefined || v === '') return '';
    return NUMERIC_LINE_ITEM_FIELDS.has(f) ? String(Number(v)) : String(v).trim();
  }).join('');
}

// Order-independent: line items carry no stable key of their own, so compare the
// sorted multiset of signatures. Length first — a cheap reject for the common
// add/remove case.
function lineItemsUnchanged(freshItems, orderId, existingRows) {
  const existing = existingRows || [];   // absent from a COMPLETE read = no rows archived
  if (existing.length !== freshItems.length) return false;
  const fresh = freshItems.map(li => lineItemSignature(mapLineItem(li, orderId))).sort();
  const stored = existing.map(lineItemSignature).sort();
  for (let i = 0; i < fresh.length; i++) {
    if (fresh[i] !== stored[i]) return false;
  }
  return true;
}

// ── Sync Line Items for One Order ───────────────────────────────────────
async function syncLineItems(orderId, existingRows, order) {
  // Fetch BEFORE deleting. The old order was delete-then-fetch, so a failed or
  // rate-limited ManageOrders read (fetchWithRetry throws after 3 attempts) left
  // the archive rows destroyed and nothing to put back — silent data loss on a
  // transient network error. Nothing is removed now until replacements are in hand.
  const items = await fetchLineItems(orderId);   // ShopWorks API — 0 billed Caspio calls

  if (lineItemsUnchanged(items, orderId, existingRows)) {
    return { count: items.length, skipped: true };
  }

  try {
    await caspioRequest(
      `/tables/ManageOrders_LineItems/records?q.where=${encodeURIComponent(`id_Order=${orderId}`)}`,
      'DELETE'
    );
  } catch (e) { /* OK if none exist */ }

  for (const li of items) {
    const row = mapLineItem(li, orderId);
    if (LINEITEMS_EXTENDED) Object.assign(row, await extendedLineFields(li, orderId, order));
    await caspioRequest('/tables/ManageOrders_LineItems/records', 'POST', row);
  }
  return { count: items.length, skipped: false };
}

// ── Main ────────────────────────────────────────────────────────────────
async function main() {
  const isBackfill = process.argv.includes('--backfill');
  const isForce = process.argv.includes('--force');
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
  if (!CRM_API_SECRET) {
    console.error('ERROR: CRM_API_SECRET required — /api/manageorders reads are PII-gated (401 without it)');
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
  console.log(`  Found ${caspioOrders.length} records in Caspio`);

  // Read every archived line item ONCE, up front, so the per-order comparison in
  // syncLineItems costs nothing. This is a handful of paged reads (~5-8 calls)
  // that replaces up to N+1 writes on every changed order — the alternative, a
  // per-order read, would be ~1 call per changed order (~400/day) and strictly
  // worse. If this read throws, the whole run aborts rather than proceeding with
  // a partial map, because a partial map reads as "line items missing" and would
  // trigger a full re-sync of everything it failed to see.
  const caspioLineItems = await caspioReadAll('ManageOrders_LineItems');
  const lineItemMap = new Map();
  for (const li of caspioLineItems) {
    const k = String(li.id_Order);
    if (!lineItemMap.has(k)) lineItemMap.set(k, []);
    lineItemMap.get(k).push(li);
  }
  console.log(`  Found ${caspioLineItems.length} archived line items across ${lineItemMap.size} orders\n`);

  // Step 3: Smart sync
  console.log('Step 3: Syncing...');
  let stats = { new: 0, updated: 0, unchanged: 0, errors: 0, lineItems: 0, skipped: 0, lineItemsUnchanged: 0 };
  const total = moOrders.length;
  const today = new Date().toISOString().split('T')[0];
  let orderIndex = 0;

  for (const mo of moOrders) {
    orderIndex++;
    const id = String(mo.id_Order);
    const mapped = mapOrder(mo);
    const existing = caspioMap.get(id);

    try {
      if (!existing) {
        // New order
        console.log(`  [${orderIndex}/${total}] + NEW: ${id} (${cleanStr(mo.CustomerName)})`);
        await caspioRequest('/tables/ManageOrders_Orders/records', 'POST', mapped);
        const li = await syncLineItems(mo.id_Order, lineItemMap.get(id), mo);
        stats.lineItems += li.count;
        if (li.skipped) stats.lineItemsUnchanged++;
        stats.new++;
        await sleep(LINE_ITEM_DELAY_MS);

      } else if (isBackfill) {
        // Resume support: skip if already synced today
        const lastSync = existing.Last_Sync_Date ? String(existing.Last_Sync_Date) : '';
        if (!isForce && lastSync.startsWith(today)) {
          stats.skipped++;
          if (stats.skipped % 50 === 0) {
            console.log(`  [${orderIndex}/${total}] skipping ${stats.skipped} already synced today...`);
          }
          continue;
        }

        // Backfill: update everything
        console.log(`  [${orderIndex}/${total}] ${id} (${cleanStr(mo.CustomerName)})`);
        await caspioRequest(
          `/tables/ManageOrders_Orders/records?q.where=${encodeURIComponent(`id_Order=${id}`)}`,
          'PUT', mapped
        );
        const li = await syncLineItems(mo.id_Order, lineItemMap.get(id), mo);
        stats.lineItems += li.count;
        if (li.skipped) stats.lineItemsUnchanged++;
        stats.updated++;
        await sleep(LINE_ITEM_DELAY_MS);

        // Progress summary every 25 orders
        if (stats.updated % 25 === 0) {
          console.log(`  --- Progress: ${orderIndex}/${total}, ${stats.updated} updated, ${stats.skipped} skipped ---`);
        }

      } else {
        // Smart diff
        const changedField = detectChange(mapped, existing);
        if (changedField) {
          console.log(`  ~ CHANGED: ${id} (${cleanStr(mo.CustomerName)}) [${changedField}]`);
          await caspioRequest(
            `/tables/ManageOrders_Orders/records?q.where=${encodeURIComponent(`id_Order=${id}`)}`,
            'PUT', mapped
          );
          const li = await syncLineItems(mo.id_Order, lineItemMap.get(id), mo);
        stats.lineItems += li.count;
        if (li.skipped) stats.lineItemsUnchanged++;
          stats.updated++;
          await sleep(LINE_ITEM_DELAY_MS);
        } else {
          // NO WRITE. This branch used to PUT { Last_Sync_Date } on every unchanged
          // order purely to stamp "we looked at it" — ~619 billed Caspio writes/day
          // (60-day window x ~11 orders/day), the single largest avoidable cost in
          // this script, for a field nothing alerts on.
          //
          // Safe to drop because Last_Sync_Date on ManageOrders_Orders has exactly two
          // readers, and neither needs the touch:
          //   - the --backfill resume check at :322 below, which is satisfied by the
          //     backfill's own PUT at :333 (mapped includes Last_Sync_Date, see :208)
          //   - scripts/backfill-manageorders.js:67, a field list
          // The house-accounts / nika-accounts / taneisha-accounts readers of the same
          // column name are DIFFERENT TABLES and are unaffected.
          //
          // Semantics change: the field now means "last time this order's data was
          // written", not "last time the sync ran". That also fixes a latent bug — a
          // normal sync used to stamp today on all ~660 orders, so a same-day
          // `--backfill` (without --force) would skip every one of them as
          // "already synced today".
          stats.unchanged++;
          // REPAIR (2026-09-02): an order whose line fetch failed on an earlier run stays in the
          // archive with zero lines forever, because "unchanged" never re-syncs lines. Measured
          // on the customer-portal coverage check: 1–4 such orders per GOLD account. Fetch them
          // now, bounded per run.
          if (!(lineItemMap.get(id) || []).length && (parseInt(mo.TotalProductQuantity) || 0) > 0 && (stats.repaired || 0) < REPAIR_MISSING_LINES_MAX) {
            console.log(`  ! REPAIR: ${id} (${cleanStr(mo.CustomerName)}) — archived with no line items`);
            const li = await syncLineItems(mo.id_Order, [], mo);
            stats.lineItems += li.count;
            stats.repaired = (stats.repaired || 0) + 1;
            await sleep(LINE_ITEM_DELAY_MS);
          }
        }
      }
    } catch (err) {
      console.error(`  ! ERROR: ${id}: ${err.message}`);
      stats.errors++;
    }
  }

  // Step 4: older orders reopened in ShopWorks (see REOPENED_LOOKBACK_MONTHS).
  if (!isBackfill) {
    try {
      const pulled = new Set(moOrders.map((o) => String(o.id_Order)));
      const since = new Date(); since.setMonth(since.getMonth() - REOPENED_LOOKBACK_MONTHS);
      const odbc = await caspioReadAll('ORDER_ODBC', `date_OrderInvoiced>='${since.toISOString().slice(0, 10)}'`);
      const candidates = [];
      for (const r of odbc) {
        const id = String(r.ID_Order); const ex = caspioMap.get(id);
        if (!ex || pulled.has(id)) continue;                       // not archived / already compared above
        const sub = parseFloat(r.cur_Subtotal); const exSub = parseFloat(ex.cur_SubTotal);
        const inv = String(r.date_OrderInvoiced || '').slice(0, 10); const exInv = String(ex.date_Invoiced || '').slice(0, 10);
        if ((Number.isFinite(sub) && Number.isFinite(exSub) && Math.abs(sub - exSub) > 0.5) || (inv && exInv && inv !== exInv)) candidates.push({ id, sub, exSub, inv, exInv });
      }
      console.log(`\nStep 4: reopened older orders — ${candidates.length} archive/ShopWorks mismatch(es) among ${odbc.length} ORDER_ODBC rows`);
      stats.reopened = 0;
      for (const c of candidates.slice(0, REOPENED_MAX)) {
        try {
          const mo = await fetchOrderFresh(c.id);
          if (!mo) { console.log(`  ? ${c.id}: not returned by ManageOrders — skipped`); continue; }
          const mapped = mapOrder(mo);
          console.log(`  ~ REOPENED: ${c.id} (${cleanStr(mo.CustomerName)}) subtotal ${c.exSub} → ${mapped.cur_SubTotal}, invoiced ${c.exInv || '-'} → ${String(mapped.date_Invoiced || '').slice(0, 10) || '-'}`);
          await caspioRequest(`/tables/ManageOrders_Orders/records?q.where=${encodeURIComponent(`id_Order=${c.id}`)}`, 'PUT', mapped);
          const li = await syncLineItems(mo.id_Order, lineItemMap.get(c.id), mo);
          stats.lineItems += li.count;
          if (li.skipped) stats.lineItemsUnchanged++;
          stats.reopened++;
          await sleep(LINE_ITEM_DELAY_MS);
        } catch (err) { console.error(`  ! ERROR (reopened) ${c.id}: ${err.message}`); stats.errors++; }
      }
      if (candidates.length > REOPENED_MAX) console.log(`  (${candidates.length - REOPENED_MAX} more deferred to the next run)`);
    } catch (err) { console.error(`Step 4 skipped — ORDER_ODBC read failed: ${err.message}`); }
  }

  // Summary
  console.log(`\n=== SYNC COMPLETE ===`);
  console.log(`  New:       ${stats.new}`);
  console.log(`  Updated:   ${stats.updated}`);
  console.log(`  Unchanged: ${stats.unchanged}`);
  if (stats.skipped) console.log(`  Skipped:   ${stats.skipped} (already synced today)`);
  console.log(`  Errors:    ${stats.errors}`);
  console.log(`  Line items synced: ${stats.lineItems}`);
  // The saving is this number: each one is a DELETE + N POSTs that did not happen
  // because the archived line items were already identical to ManageOrders.
  console.log(`  Line-item re-writes skipped (already identical): ${stats.lineItemsUnchanged}`);
  console.log(`  Repaired (archived orders that had no lines): ${stats.repaired || 0}`);
  console.log(`  Reopened older orders re-pulled: ${stats.reopened || 0}`);
  console.log(`  Extended line columns: ${LINEITEMS_EXTENDED ? 'ON' : 'off (set LINEITEMS_EXTENDED=1 after the 6 columns exist)'}`);
  console.log(`  Total in archive:  ${caspioOrders.length + stats.new}`);

  // Last, and never fatal: a sync that did the work must not be reported as failed
  // because the bookkeeping write failed. A missed heartbeat ages into a stale
  // warning on its own, which is the safe direction.
  const touched = stats.new + stats.updated;
  try {
    await stampHeartbeat(touched,
      `${stats.new} new, ${stats.updated} updated, ${stats.unchanged} unchanged, ${stats.errors} errored`);
    console.log(`  Heartbeat: ${HEARTBEAT_SYNC_NAME} stamped (${touched} row(s) touched)`);
  } catch (e) {
    console.error(`  Heartbeat FAILED to stamp (sync itself succeeded): ${e.message}`);
  }
}

// Guarded so the pure helpers can be require()d by a test WITHOUT running a live
// sync against the production archive. `npm run sync-manageorders` is unaffected.
if (require.main === module) {
  // The success path drains naturally, so `beforeExit` already flushes it. This
  // FAILURE path did not: process.exit() skips that hook, so the calls made
  // before the throw were billed but never recorded — and this job makes
  // thousands. Exits 1 either way, so the scheduler still sees the failure.
  main().catch(err => {
    console.error(`\nFATAL: ${err.message}`);
    require('../src/utils/api-usage-rollup').flushAndExit(1);
  });
}

// Exported for tests/jest/manageorders-line-item-diff.test.js — the line-item
// comparison decides whether a financial archive gets rewritten, so it is locked.
module.exports = {
  mapLineItem,
  lineItemSignature,
  lineItemsUnchanged,
  detectChange,
  normalize,
  CHANGE_FIELDS,
  LINE_ITEM_FIELDS
};
