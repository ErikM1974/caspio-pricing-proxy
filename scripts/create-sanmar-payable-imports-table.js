#!/usr/bin/env node
/**
 * Create the `SanMar_Payable_Imports` Caspio table — a self-managed log of which
 * SanMar invoices/credits Erik has imported into ShopWorks (a date-stamp per
 * payable, the way the old Caspio payables table worked for 5 years). The SanMar
 * Payables page reads it to show Imported? + filter the "to import" worklist
 * WITHOUT any ShopWorks ODBC/upload dependency: unstamped = still to import.
 *
 *   node scripts/create-sanmar-payable-imports-table.js          # dry-run
 *   node scripts/create-sanmar-payable-imports-table.js --apply  # create
 *
 * Written by POST /api/sanmar-invoices/mark-imported (upsert by InvoiceNumber).
 */
'use strict';
const axios = require('axios');
const config = require('../src/config');
const { getCaspioAccessToken } = require('../src/utils/caspio');

const BASE = config.caspio.apiBaseUrl;
const TABLE = 'SanMar_Payable_Imports';
const APPLY = process.argv.includes('--apply');

const TABLE_DEF = {
  Name: TABLE,
  Fields: [
    { Name: 'InvoiceNumber', Type: 'String', Unique: true },
    { Name: 'Date_Imported', Type: 'Date/Time' },
    { Name: 'Imported_By', Type: 'String' },
    { Name: 'PayableDate', Type: 'String' },
    { Name: 'Amount', Type: 'Number' },
    { Name: 'PONumber', Type: 'String' },
    { Name: 'Vendor', Type: 'String' },
  ],
};

async function main() {
  const token = await getCaspioAccessToken();
  const H = { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } };
  console.log(`Mode: ${APPLY ? 'APPLY (writing)' : 'DRY-RUN (no writes)'}\n`);
  let exists = false;
  try { await axios.get(`${BASE}/tables/${TABLE}/fields`, { headers: { Authorization: `Bearer ${token}` } }); exists = true; } catch (_) {}
  console.log(`Table ${TABLE}: ${exists ? 'already exists' : 'does NOT exist'}`);
  if (!exists) {
    console.log(`  ${APPLY ? 'creating' : 'would create'}: ${TABLE_DEF.Fields.map(f => f.Name).join(', ')}`);
    if (APPLY) { await axios.post(`${BASE}/tables`, TABLE_DEF, H); console.log('  ✓ table created'); }
  }
  if (APPLY || exists) {
    const f = (await axios.get(`${BASE}/tables/${TABLE}/fields`, { headers: { Authorization: `Bearer ${token}` } })).data;
    console.log('\nFields:', (f.Result || f).map(x => `${x.Name}:${x.Type}`).join(', '));
  }
  console.log(`\n${APPLY ? 'Done.' : 'Dry-run only. Re-run with --apply.'}`);
}
main().catch(e => { console.error('FATAL:', e.response ? JSON.stringify(e.response.data) : e.message); process.exit(1); });
