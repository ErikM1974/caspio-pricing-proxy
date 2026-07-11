#!/usr/bin/env node
/**
 * Create the `Forms_Library` Caspio table — the Erik-editable registry of printable /
 * fillable company forms surfaced on /dashboards/forms-library.html (Pricing Index repo).
 * Erik adds a row in Caspio (or via the gated POST /api/forms-library) → the form shows
 * up in the staff Forms Library with no deploy.
 *
 *   node scripts/create-forms-library-table.js          # dry-run
 *   node scripts/create-forms-library-table.js --apply  # create + seed
 *
 * Columns (all STRING per house convention):
 *   Form_ID (unique slug) · Form_Name · Description · Category · PDF_URL ·
 *   Fill_Online_URL (blank = no online version) · Sort_Order (numeric string) ·
 *   Is_Active ('Yes'/'No' — Text like Design_Lookup_2026, NOT boolean)
 *
 * PDF_URL / Fill_Online_URL are teamnwca.com-relative paths (e.g. /forms/x.pdf) or
 * absolute URLs (e.g. a proxy /api/files/:key link for Caspio-hosted files).
 */
'use strict';
const axios = require('axios');
const config = require('../src/config');
const { getCaspioAccessToken } = require('../src/utils/caspio');

const BASE = config.caspio.apiBaseUrl;
const TABLE = 'Forms_Library';
const APPLY = process.argv.includes('--apply');

const TABLE_DEF = {
  Name: TABLE,
  Fields: [
    { Name: 'Form_ID', Type: 'STRING', Unique: true },
    { Name: 'Form_Name', Type: 'STRING' },
    { Name: 'Description', Type: 'STRING' },
    { Name: 'Category', Type: 'STRING' },
    { Name: 'PDF_URL', Type: 'STRING' },
    { Name: 'Fill_Online_URL', Type: 'STRING' },
    { Name: 'Sort_Order', Type: 'STRING' },
    { Name: 'Is_Active', Type: 'STRING' },
  ],
};

// Seed = every PDF already in the Pricing Index /forms/ dir + the new drop-off form.
// Erik edits/deactivates rows in Caspio; sort within category by Sort_Order asc.
const SEED = [
  {
    Form_ID: 'garment-drop-off',
    Form_Name: 'Customer Garment Drop-Off Form',
    Description: 'Intake sheet for customer-supplied blank garments — decoration checklist, size grid, and liability waiver.',
    Category: 'Customer Intake',
    PDF_URL: '/forms/customer-garment-drop-off-form.pdf',
    Fill_Online_URL: '/pages/forms/garment-drop-off-form.html',
    Sort_Order: '10',
    Is_Active: 'Yes',
  },
  {
    Form_ID: 'customer-supplied-acknowledgment',
    Form_Name: 'Customer-Supplied Garments Acknowledgment',
    Description: 'Waiver the customer signs acknowledging NWCA is not liable for replacement of customer-supplied items.',
    Category: 'Customer Intake',
    PDF_URL: '/forms/Customer-Supplied-Garments-Acknowledgment.pdf',
    Fill_Online_URL: '',
    Sort_Order: '20',
    Is_Active: 'Yes',
  },
  {
    Form_ID: 'credit-card-authorization',
    Form_Name: 'Credit Card Authorization Form',
    Description: 'Card authorization for phone / manual payments.',
    Category: 'Payments',
    PDF_URL: '/forms/policies/credit-card-authorization.pdf',
    Fill_Online_URL: '',
    Sort_Order: '30',
    Is_Active: 'Yes',
  },
  {
    Form_ID: 'meal-period-waiver',
    Form_Name: 'Meal Period Waiver',
    Description: 'Employee meal-period waiver (WA L&I requirement).',
    Category: 'Employee / HR',
    PDF_URL: '/forms/NWCA-Meal-Period-Waiver.pdf',
    Fill_Online_URL: '',
    Sort_Order: '40',
    Is_Active: 'Yes',
  },
  {
    Form_ID: 'employee-handbook',
    Form_Name: 'Employee Handbook (PDF)',
    Description: 'Latest full employee handbook — also readable online in the Policies Hub.',
    Category: 'Employee / HR',
    PDF_URL: '/forms/Employee-Handbook-Latest.pdf',
    Fill_Online_URL: '',
    Sort_Order: '50',
    Is_Active: 'Yes',
  },
  {
    Form_ID: 'lg540-ink-order',
    Form_Name: 'Roland LG-540 Ink Order Form',
    Description: 'Ink / supplies order sheet for the Roland LG-540 printer.',
    Category: 'Supplies & Production',
    PDF_URL: '/forms/NWCA_LG540_Order_Form_1page.pdf',
    Fill_Online_URL: '',
    Sort_Order: '60',
    Is_Active: 'Yes',
  },
  {
    Form_ID: 'dtg-ink-order',
    Form_Name: 'DTG Ink Order Form',
    Description: 'DTG department ink order sheet.',
    Category: 'Supplies & Production',
    PDF_URL: '/forms/policies/dtg-ink-order-form.pdf',
    Fill_Online_URL: '',
    Sort_Order: '70',
    Is_Active: 'Yes',
  },
];

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

  console.log('\nSeed rows:');
  for (const r of SEED) {
    if (!APPLY) { console.log(`  would add ${r.Form_ID} → ${r.Form_Name} [${r.Category}]`); continue; }
    try {
      try { await axios.post(`${BASE}/tables/${TABLE}/records`, r, H); console.log(`  ✓ inserted ${r.Form_ID}`); }
      catch (_) {
        const { Form_ID, ...rest } = r;
        await axios.put(`${BASE}/tables/${TABLE}/records?q.where=${encodeURIComponent(`Form_ID='${Form_ID}'`)}`, rest, H);
        console.log(`  ✓ updated ${r.Form_ID}`);
      }
    } catch (e) { console.log(`  ❌ ${r.Form_ID}: ${e.response ? JSON.stringify(e.response.data) : e.message}`); }
  }

  if (APPLY) {
    const back = (await axios.get(`${BASE}/tables/${TABLE}/records?q.select=Form_ID,Form_Name,Category,Is_Active&q.pageSize=100`, { headers: { Authorization: `Bearer ${token}` } })).data;
    const rows = back.Result || [];
    console.log(`\nVerify — ${rows.length} rows:`);
    rows.forEach(x => console.log(`   ${x.Form_ID} → ${x.Form_Name} [${x.Category}] active=${x.Is_Active}`));
  }
  console.log(`\n${APPLY ? 'Done.' : 'Dry-run only. Re-run with --apply.'}`);
}
main().catch(e => { console.error('FATAL:', e.response ? JSON.stringify(e.response.data) : e.message); process.exit(1); });
