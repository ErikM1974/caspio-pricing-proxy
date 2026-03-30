#!/usr/bin/env node
/**
 * Fix Bad Backfill Records
 *
 * Deletes corrupt records (id_OrderType=0 from CSV comma parsing bug)
 * and the 2 records with id_Order=0, then re-inserts them correctly
 * from the Q1 CSV using the fixed CSV parser.
 *
 * Also updates the 18 records (140514-140531) that have blank id_OrderType
 * from early daily syncs — these are legitimate orders that just need
 * their order type populated.
 *
 * Usage:
 *   node scripts/fix-bad-backfill.js "path/to/Q1_2026_Orders_Complete_1.csv"
 */

require('dotenv').config();
const axios = require('axios');
const fs = require('fs');

const CASPIO_BASE = 'https://c3eku948.caspio.com/rest/v2';
const CASPIO_CLIENT_ID = process.env.CASPIO_CLIENT_ID;
const CASPIO_CLIENT_SECRET = process.env.CASPIO_CLIENT_SECRET;
const TABLE = 'ManageOrders_Orders';

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function cleanStr(val) {
  if (val === null || val === undefined) return '';
  return String(val).replace(/[\t\r\n]/g, ' ').replace(/[^\x20-\x7E]/g, '').trim();
}

// ── Proper CSV parser (handles quoted fields with commas) ───────────────
function parseCSVLine(line) {
  const fields = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && i + 1 < line.length && line[i + 1] === '"') {
        current += '"';
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

function parseCSV(content) {
  const lines = content.split('\n');
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

// ── Sales Rep Corrections (same as backfill script) ─────────────────────
const REP_OVERRIDES_BY_CUSTOMER = {
  '13552': 'Taneisha Clark',
  '13560': 'Taneisha Clark',
  '13597': 'Taneisha Clark',
};
const REP_NAME_FIXES = {
  'Ruth  Nhoung': 'Ruthie Nhoung',
};

function correctSalesRep(rep, customerId) {
  if ((!rep || !rep.trim()) && REP_OVERRIDES_BY_CUSTOMER[customerId]) {
    return REP_OVERRIDES_BY_CUSTOMER[customerId];
  }
  const trimmed = rep ? rep.trim() : '';
  return REP_NAME_FIXES[trimmed] || trimmed;
}

// ── Caspio Auth & CRUD ─────────────────────────────────────────────────
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
  tokenExpiry = Date.now() + (resp.data.expires_in - 60) * 1000;
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
  if (resp.status === 429 && retryCount < 3) {
    console.log(`    Rate limited, waiting 62s...`);
    await sleep(62000);
    return caspioRequest(endpoint, method, body, retryCount + 1);
  }
  if (resp.status >= 400) {
    const msg = typeof resp.data === 'string' ? resp.data : JSON.stringify(resp.data);
    throw new Error(`Caspio ${method}: ${resp.status} - ${msg}`);
  }
  return resp.data || {};
}

function mapCSVRow(row) {
  let invoiceDate = null;
  if (row.Invoice_Date) {
    const parts = row.Invoice_Date.split('/');
    if (parts.length === 3) {
      invoiceDate = `${parts[2]}-${parts[0].padStart(2, '0')}-${parts[1].padStart(2, '0')}`;
    }
  }
  const customerId = (row.Customer_ID || '').trim();
  return {
    id_Order: parseInt(row.Order_ID) || 0,
    id_Customer: parseInt(customerId) || 0,
    CustomerName: cleanStr(row.Company_Name),
    CustomerServiceRep: correctSalesRep(row.Sales_Rep, customerId),
    id_OrderType: parseInt(row.Order_Type_ID) || 0,
    date_Invoiced: invoiceDate,
    cur_SubTotal: parseFloat(row.Subtotal) || 0,
    cur_SalesTaxTotal: parseFloat(row.Sales_Tax) || 0,
    cur_TotalInvoice: parseFloat(row.Total_Invoice) || 0,
    cur_Shipping: parseFloat(row.Shipping) || 0,
    sts_Invoiced: 1,
    Backfill_Source: 'csv_backfill',
    Last_Sync_Date: new Date().toISOString()
  };
}

// ── Main ────────────────────────────────────────────────────────────────
async function main() {
  const csvPath = process.argv[2];
  if (!csvPath) {
    console.error('Usage: node scripts/fix-bad-backfill.js "path/to/Q1_CSV.csv"');
    process.exit(1);
  }

  console.log('=== Fix Bad Backfill Records ===\n');

  // Step 1: Read Q1 CSV with fixed parser
  console.log('Step 1: Reading Q1 CSV (with proper comma handling)...');
  const content = fs.readFileSync(csvPath, 'latin1');
  const csvRows = parseCSV(content);
  const csvMap = new Map();
  for (const row of csvRows) {
    csvMap.set(row.Order_ID, row);
  }
  console.log(`  Loaded ${csvRows.length} rows\n`);

  // Step 2: Delete bad records (id_OrderType=0 or id_Order=0)
  console.log('Step 2: Deleting corrupt records...');

  // Delete id_Order = 0 records
  try {
    const resp = await caspioRequest(
      `/tables/${TABLE}/records?q.where=${encodeURIComponent('id_Order=0')}`,
      'DELETE'
    );
    console.log(`  Deleted id_Order=0 records: ${resp.RecordsAffected || 0}`);
  } catch (err) {
    console.log(`  id_Order=0 delete: ${err.message}`);
  }
  await sleep(500);

  // Delete id_OrderType=0 records (the corrupt comma-parsed ones)
  try {
    const resp = await caspioRequest(
      `/tables/${TABLE}/records?q.where=${encodeURIComponent('id_OrderType=0')}`,
      'DELETE'
    );
    console.log(`  Deleted id_OrderType=0 records: ${resp.RecordsAffected || 0}`);
  } catch (err) {
    console.log(`  id_OrderType=0 delete: ${err.message}`);
  }
  await sleep(500);

  // Also delete records with blank id_OrderType
  try {
    const resp = await caspioRequest(
      `/tables/${TABLE}/records?q.where=${encodeURIComponent("id_OrderType IS NULL")}`,
      'DELETE'
    );
    console.log(`  Deleted NULL id_OrderType records: ${resp.RecordsAffected || 0}`);
  } catch (err) {
    console.log(`  NULL id_OrderType delete: ${err.message}`);
  }
  await sleep(500);

  console.log();

  // Step 3: Find which orders need re-inserting
  console.log('Step 3: Checking what needs re-inserting...');

  // The order IDs that were corrupt (from our earlier analysis)
  const corruptOrderIds = [
    '139271', '139272', '139715', '139988', '140033', '140114',
    '140130', '140218', '140268', '140282', '140324', '140330',
    '140393', '140457'
  ];

  // The order IDs that had blank id_OrderType (early daily sync)
  const blankTypeOrderIds = [
    '140514', '140515', '140516', '140517', '140518', '140519',
    '140520', '140521', '140522', '140523', '140524', '140525',
    '140526', '140527', '140528', '140529', '140530', '140531'
  ];

  const allFixIds = [...corruptOrderIds, ...blankTypeOrderIds];

  // Check which ones are in the CSV
  const toInsert = [];
  const notInCSV = [];
  for (const id of allFixIds) {
    const csvRow = csvMap.get(id);
    if (csvRow) {
      toInsert.push(mapCSVRow(csvRow));
    } else {
      notInCSV.push(id);
    }
  }

  console.log(`  Orders to re-insert from CSV: ${toInsert.length}`);
  if (notInCSV.length) {
    console.log(`  Orders NOT in CSV (will be picked up by daily sync): ${notInCSV.join(', ')}`);
  }
  console.log();

  // Step 4: Also find any OTHER orders from Q1 CSV that have commas in
  // company names and may have been corrupted — check if they exist correctly
  console.log('Step 4: Checking all comma-in-name orders...');
  const commaOrders = csvRows.filter(r => (r.Company_Name || '').includes(','));
  console.log(`  Found ${commaOrders.length} orders with commas in company names`);

  // Check which ones exist in Caspio
  let additionalMissing = 0;
  for (const row of commaOrders) {
    const id = row.Order_ID;
    if (allFixIds.includes(id)) continue; // Already handling

    try {
      const check = await caspioRequest(
        `/tables/${TABLE}/records?q.where=${encodeURIComponent(`id_Order=${id}`)}&q.select=id_Order,id_OrderType,CustomerName`
      );
      const existing = (check.Result || [])[0];
      if (!existing) {
        // Missing entirely — add to insert list
        toInsert.push(mapCSVRow(row));
        additionalMissing++;
        console.log(`    Missing: ${id} (${cleanStr(row.Company_Name)})`);
      } else if (!existing.id_OrderType || existing.id_OrderType === 0) {
        // Exists but corrupt — delete and re-insert
        await caspioRequest(
          `/tables/${TABLE}/records?q.where=${encodeURIComponent(`id_Order=${id}`)}`,
          'DELETE'
        );
        toInsert.push(mapCSVRow(row));
        additionalMissing++;
        console.log(`    Fixed corrupt: ${id} (${cleanStr(row.Company_Name)})`);
      }
      await sleep(200);
    } catch (err) {
      console.log(`    Error checking ${id}: ${err.message}`);
    }
  }
  console.log(`  Additional orders to fix: ${additionalMissing}`);
  console.log();

  // Step 5: Insert all fixed records
  console.log(`Step 5: Inserting ${toInsert.length} corrected records...`);
  let inserted = 0;
  let errors = 0;

  for (const record of toInsert) {
    try {
      await caspioRequest(`/tables/${TABLE}/records`, 'POST', record);
      inserted++;
      console.log(`  ✓ ${record.id_Order}: ${record.CustomerName} (${record.CustomerServiceRep})`);
    } catch (err) {
      // Might already exist if it wasn't deleted
      if (err.message.includes('duplicate') || err.message.includes('unique')) {
        console.log(`  ~ ${record.id_Order}: already exists, updating...`);
        try {
          await caspioRequest(
            `/tables/${TABLE}/records?q.where=${encodeURIComponent(`id_Order=${record.id_Order}`)}`,
            'PUT', record
          );
          inserted++;
        } catch (putErr) {
          console.error(`  ✗ ${record.id_Order}: ${putErr.message}`);
          errors++;
        }
      } else {
        console.error(`  ✗ ${record.id_Order}: ${err.message}`);
        errors++;
      }
    }
    await sleep(200);
  }

  console.log();
  console.log('=== FIX COMPLETE ===');
  console.log(`  Inserted/Updated: ${inserted}`);
  console.log(`  Errors: ${errors}`);
}

main().catch(err => {
  console.error(`\nFATAL: ${err.message}`);
  process.exit(1);
});
