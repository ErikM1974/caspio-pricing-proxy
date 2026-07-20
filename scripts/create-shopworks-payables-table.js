#!/usr/bin/env node
/**
 * Create the `ShopWorks_Payables` Caspio table — the invoice-level ShopWorks
 * accounts-payable mirror that powers the SanMar Payables page's automatic
 * Imported?/Paid? cross-check (replacing the manual ShopWorks-CSV upload).
 *
 *   node scripts/create-shopworks-payables-table.js          # dry-run
 *   node scripts/create-shopworks-payables-table.js --apply  # create
 *
 * Populated by the bandit agent scripts/bandit-agent/sync-payables.ps1 →
 * POST /api/shopworks-odbc/sync-payables (upsert by ID_Payable). Columns mirror
 * the ShopWorks payables export (date_Paid is the reliable paid signal;
 * InvoiceNumber is the match key to SanMar invoices).
 */
'use strict';
const axios = require('axios');
const config = require('../src/config');
const { getCaspioAccessToken } = require('../src/utils/caspio');

const BASE = config.caspio.apiBaseUrl;
const TABLE = 'ShopWorks_Payables';
const APPLY = process.argv.includes('--apply');

const TABLE_DEF = {
  Name: TABLE,
  Fields: [
    { Name: 'ID_Payable', Type: 'Integer', Unique: true },
    { Name: 'InvoiceNumber', Type: 'String' },
    { Name: 'id_PO', Type: 'Integer' },
    { Name: 'id_Order', Type: 'Integer' },
    { Name: 'id_Vendor', Type: 'Integer' },
    { Name: 'VendorName', Type: 'String' },
    { Name: 'date_Payable', Type: 'Date/Time' },
    { Name: 'date_PayableDue', Type: 'Date/Time' },
    { Name: 'date_Creation', Type: 'Date/Time' },
    { Name: 'date_Paid', Type: 'Date/Time' },
    { Name: 'cur_Payable', Type: 'Number' },
    { Name: 'cnCur_PayableOutstanding', Type: 'Number' },
    { Name: 'sts_ToPay', Type: 'Integer' },
    { Name: 'date_Modification', Type: 'Date/Time' },
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
