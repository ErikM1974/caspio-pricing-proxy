#!/usr/bin/env node
/**
 * Backfill ManageOrders_Orders from ShopWorks CSV Export
 *
 * Imports invoiced orders from a CSV export into the Caspio ManageOrders_Orders table.
 * Only inserts orders that don't already exist (by id_Order).
 * Formula fields (Order_Type_Name, Is_InkSoft, Invoice_Quarter, Invoice_Year)
 * auto-calculate in Caspio — no need to write them.
 *
 * Usage:
 *   node scripts/backfill-orders-from-csv.js "path/to/Q1_2026_Orders_Complete_1.csv"
 *   node scripts/backfill-orders-from-csv.js "path/to/file.csv" --dry-run
 *
 * Requires env vars: CASPIO_CLIENT_ID, CASPIO_CLIENT_SECRET
 */

require('dotenv').config();
const axios = require('axios');
const fs = require('fs');
const path = require('path');

const CASPIO_BASE = 'https://c3eku948.caspio.com/rest/v2';
const CASPIO_CLIENT_ID = process.env.CASPIO_CLIENT_ID;
const CASPIO_CLIENT_SECRET = process.env.CASPIO_CLIENT_SECRET;
const TABLE = 'ManageOrders_Orders';
const BATCH_SIZE = 25;       // Records per batch insert
const BATCH_DELAY_MS = 500;  // Delay between batches
const RATE_LIMIT_WAIT_MS = 62000;

// ── Helpers ─────────────────────────────────────────────────────────────
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function cleanStr(val) {
  if (val === null || val === undefined) return '';
  return String(val).replace(/[\t\r\n]/g, ' ').replace(/[^\x20-\x7E]/g, '').trim();
}

function parseCSV(content) {
  // Proper CSV parser that handles quoted fields with commas
  const lines = content.split('\n');
  if (!lines.length) return [];

  function parseCSVLine(line) {
    const fields = [];
    let current = '';
    let inQuotes = false;

    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') {
        if (inQuotes && i + 1 < line.length && line[i + 1] === '"') {
          current += '"'; // escaped quote
          i++;
        } else {
          inQuotes = !inQuotes;
        }
      } else if (ch === ',' && !inQuotes) {
        fields.push(current.trim());
        current = '';
      } else {
        current += ch;
      }
    }
    fields.push(current.trim());
    return fields;
  }

  // Parse header (handle BOM)
  const headerLine = lines[0].replace(/^\uFEFF/, '').trim();
  const cols = parseCSVLine(headerLine);

  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    const values = parseCSVLine(line);
    const row = {};
    for (let j = 0; j < cols.length; j++) {
      row[cols[j]] = (values[j] || '').trim();
    }
    rows.push(row);
  }
  return rows;
}

// ── Caspio Auth & CRUD (same pattern as sync-manageorders.js) ───────────
let caspioToken = null;
let tokenExpiry = 0;

async function getCaspioToken() {
  if (caspioToken && Date.now() < tokenExpiry) return caspioToken;

  console.log('  Authenticating with Caspio...');
  const resp = await axios.post('https://c3eku948.caspio.com/oauth/token',
    `grant_type=client_credentials&client_id=${CASPIO_CLIENT_ID}&client_secret=${CASPIO_CLIENT_SECRET}`,
    { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
  );
  caspioToken = resp.data.access_token;
  tokenExpiry = Date.now() + (resp.data.expires_in - 60) * 1000; // Refresh 60s early
  return caspioToken;
}

async function caspioRequest(endpoint, method = 'GET', body = null, retryCount = 0) {
  const token = await getCaspioToken();
  const config = {
    method,
    url: `${CASPIO_BASE}${endpoint}`,
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    validateStatus: () => true,
    timeout: 30000
  };
  if (body) config.data = body;

  const resp = await axios(config);

  // Handle rate limiting
  if (resp.status === 429 && retryCount < 3) {
    const wait = RATE_LIMIT_WAIT_MS * (retryCount + 1);
    console.log(`    Rate limited, waiting ${Math.round(wait / 1000)}s (attempt ${retryCount + 1}/3)...`);
    await sleep(wait);
    return caspioRequest(endpoint, method, body, retryCount + 1);
  }

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

// ── Sales Rep Corrections ───────────────────────────────────────────────
// Fix known data issues from ShopWorks before inserting into Caspio.
// These corrections were verified by Erik on 2026-03-30.

// Orders with blank Sales_Rep — confirmed as Taneisha's
const REP_OVERRIDES_BY_CUSTOMER = {
  '13552': 'Taneisha Clark',  // Superheat LLC
  '13560': 'Taneisha Clark',  // Peter Guarino
  '13597': 'Taneisha Clark',  // Steve Vardan
};

// Rep name normalization — fix typos/variants in ShopWorks
const REP_NAME_FIXES = {
  'Ruth  Nhoung': 'Ruthie Nhoung',  // Double-space typo (9 orders)
};

function correctSalesRep(rep, customerId) {
  // Check customer-level override first (for blank reps)
  if ((!rep || !rep.trim()) && REP_OVERRIDES_BY_CUSTOMER[customerId]) {
    return REP_OVERRIDES_BY_CUSTOMER[customerId];
  }

  const trimmed = rep ? rep.trim() : '';

  // Check name fixes
  if (REP_NAME_FIXES[trimmed]) {
    return REP_NAME_FIXES[trimmed];
  }

  return trimmed;
}

// ── CSV Row → Caspio Record Mapping ────────────────────────────────────
function mapCSVRow(row) {
  // Parse invoice date to ISO format for Caspio
  let invoiceDate = null;
  if (row.Invoice_Date) {
    const parts = row.Invoice_Date.split('/');
    if (parts.length === 3) {
      // M/D/YYYY → YYYY-MM-DD
      invoiceDate = `${parts[2]}-${parts[0].padStart(2, '0')}-${parts[1].padStart(2, '0')}`;
    }
  }

  const customerId = (row.Customer_ID || '').trim();
  const salesRep = correctSalesRep(row.Sales_Rep, customerId);

  return {
    id_Order: parseInt(row.Order_ID) || 0,
    id_Customer: parseInt(customerId) || 0,
    CustomerName: cleanStr(row.Company_Name),
    CustomerServiceRep: salesRep,
    id_OrderType: parseInt(row.Order_Type_ID) || 0,
    date_Invoiced: invoiceDate,
    cur_SubTotal: parseFloat(row.Subtotal) || 0,
    cur_SalesTaxTotal: parseFloat(row.Sales_Tax) || 0,
    cur_TotalInvoice: parseFloat(row.Total_Invoice) || 0,
    cur_Shipping: parseFloat(row.Shipping) || 0,
    // Mark as invoiced since these come from an invoiced orders export
    sts_Invoiced: 1,
    // Audit trail
    Backfill_Source: 'csv_backfill',
    Last_Sync_Date: new Date().toISOString()
  };
}

// ── Main ────────────────────────────────────────────────────────────────
async function main() {
  const args = process.argv.slice(2);
  const csvPath = args.find(a => !a.startsWith('--'));
  const dryRun = args.includes('--dry-run');

  if (!csvPath) {
    console.error('Usage: node scripts/backfill-orders-from-csv.js "path/to/file.csv" [--dry-run]');
    process.exit(1);
  }

  if (!CASPIO_CLIENT_ID || !CASPIO_CLIENT_SECRET) {
    console.error('Missing CASPIO_CLIENT_ID or CASPIO_CLIENT_SECRET environment variables');
    process.exit(1);
  }

  console.log('=== ManageOrders CSV Backfill ===');
  console.log(`CSV: ${csvPath}`);
  console.log(`Mode: ${dryRun ? 'DRY RUN (no writes)' : 'LIVE'}`);
  console.log();

  // Step 1: Read CSV
  console.log('Step 1: Reading CSV...');
  const content = fs.readFileSync(csvPath, 'latin1');
  const csvRows = parseCSV(content);
  console.log(`  Found ${csvRows.length} rows in CSV`);

  // Validate CSV has expected columns
  const requiredCols = ['Order_ID', 'Customer_ID', 'Company_Name', 'Sales_Rep', 'Invoice_Date', 'Subtotal'];
  const missingCols = requiredCols.filter(c => !(c in csvRows[0]));
  if (missingCols.length) {
    console.error(`  ERROR: CSV missing required columns: ${missingCols.join(', ')}`);
    process.exit(1);
  }
  console.log('  CSV columns validated ✓');
  console.log();

  // Step 2: Read existing Caspio records
  console.log('Step 2: Reading existing Caspio records...');
  const existingOrders = await caspioReadAll(TABLE);
  const existingIds = new Set(existingOrders.map(o => String(o.id_Order)));
  console.log(`  Found ${existingOrders.length} existing orders in Caspio`);
  console.log();

  // Step 3: Find missing orders and apply corrections
  console.log('Step 3: Identifying missing orders...');
  const toInsert = [];
  let skipped = 0;
  let invalidSkipped = 0;
  let repCorrected = 0;
  let nameCorrected = 0;
  const corrections = [];

  for (const row of csvRows) {
    const orderId = row.Order_ID?.trim();
    if (!orderId) {
      invalidSkipped++;
      continue;
    }

    if (existingIds.has(orderId)) {
      skipped++;
      continue;
    }

    // Track corrections for logging
    const originalRep = (row.Sales_Rep || '').trim();
    const customerId = (row.Customer_ID || '').trim();
    const correctedRep = correctSalesRep(row.Sales_Rep, customerId);

    if (originalRep !== correctedRep) {
      if (!originalRep) {
        repCorrected++;
        corrections.push(`  Order ${orderId}: (blank) → ${correctedRep} [${cleanStr(row.Company_Name)}]`);
      } else {
        nameCorrected++;
        corrections.push(`  Order ${orderId}: "${originalRep}" → "${correctedRep}" [${cleanStr(row.Company_Name)}]`);
      }
    }

    toInsert.push(mapCSVRow(row));
  }

  console.log(`  Orders to insert: ${toInsert.length}`);
  console.log(`  Already in Caspio (skipped): ${skipped}`);
  if (invalidSkipped) console.log(`  Invalid rows skipped: ${invalidSkipped}`);

  if (corrections.length) {
    console.log();
    console.log(`  Sales rep corrections applied (${repCorrected} blank reps fixed, ${nameCorrected} names normalized):`);
    for (const c of corrections) {
      console.log(c);
    }
  }
  console.log();

  if (!toInsert.length) {
    console.log('Nothing to backfill — all orders already exist!');
    return;
  }

  // Summary by rep
  const repSummary = {};
  for (const rec of toInsert) {
    const rep = rec.CustomerServiceRep || '(blank)';
    if (!repSummary[rep]) repSummary[rep] = { count: 0, subtotal: 0 };
    repSummary[rep].count++;
    repSummary[rep].subtotal += rec.cur_SubTotal;
  }
  console.log('  Backfill by rep:');
  for (const [rep, stats] of Object.entries(repSummary).sort((a, b) => b[1].subtotal - a[1].subtotal)) {
    console.log(`    ${rep}: ${stats.count} orders, $${stats.subtotal.toLocaleString('en-US', { minimumFractionDigits: 2 })}`);
  }
  console.log();

  if (dryRun) {
    console.log('=== DRY RUN COMPLETE (no records written) ===');
    console.log(`Would insert ${toInsert.length} orders into ${TABLE}`);
    return;
  }

  // Step 4: Insert in batches
  console.log(`Step 4: Inserting ${toInsert.length} orders in batches of ${BATCH_SIZE}...`);
  let inserted = 0;
  let errors = 0;

  for (let i = 0; i < toInsert.length; i += BATCH_SIZE) {
    const batch = toInsert.slice(i, i + BATCH_SIZE);
    const batchNum = Math.floor(i / BATCH_SIZE) + 1;
    const totalBatches = Math.ceil(toInsert.length / BATCH_SIZE);

    try {
      await caspioRequest(`/tables/${TABLE}/records`, 'POST', batch);
      inserted += batch.length;
      console.log(`  Batch ${batchNum}/${totalBatches}: inserted ${batch.length} orders (${inserted}/${toInsert.length} total)`);
    } catch (err) {
      console.error(`  Batch ${batchNum}/${totalBatches} ERROR: ${err.message}`);
      // Fall back to single inserts for this batch
      for (const record of batch) {
        try {
          await caspioRequest(`/tables/${TABLE}/records`, 'POST', record);
          inserted++;
        } catch (singleErr) {
          console.error(`    Order ${record.id_Order}: ${singleErr.message}`);
          errors++;
        }
        await sleep(100);
      }
    }

    await sleep(BATCH_DELAY_MS);
  }

  // Step 5: Summary
  console.log();
  console.log('=== BACKFILL COMPLETE ===');
  console.log(`  Inserted:  ${inserted}`);
  console.log(`  Skipped:   ${skipped} (already existed)`);
  console.log(`  Errors:    ${errors}`);
  console.log(`  Total in table: ~${existingOrders.length + inserted}`);
  console.log();

  // Verify formula fields are populating
  console.log('Step 5: Verifying formula fields...');
  try {
    const sample = toInsert[0];
    const verify = await caspioRequest(
      `/tables/${TABLE}/records?q.where=${encodeURIComponent(`id_Order=${sample.id_Order}`)}&q.select=id_Order,Order_Type_Name,Is_InkSoft,Invoice_Quarter,Invoice_Year,Backfill_Source`
    );
    if (verify.Result && verify.Result.length) {
      const v = verify.Result[0];
      console.log(`  Sample order ${v.id_Order}:`);
      console.log(`    Order_Type_Name: ${v.Order_Type_Name}`);
      console.log(`    Is_InkSoft: ${v.Is_InkSoft}`);
      console.log(`    Invoice_Quarter: ${v.Invoice_Quarter}`);
      console.log(`    Invoice_Year: ${v.Invoice_Year}`);
      console.log(`    Backfill_Source: ${v.Backfill_Source}`);
      console.log('  Formula fields verified ✓');
    }
  } catch (err) {
    console.log(`  Could not verify formulas: ${err.message}`);
  }
}

main().catch(err => {
  console.error(`\nFATAL: ${err.message}`);
  process.exit(1);
});
