#!/usr/bin/env node
/**
 * Create the Caspio table for the Customer Portal "Finished Photos" feature — real
 * photos of the decorated product, captured by the factory, shown to the customer
 * (once approved) next to their design. All-STRING (the proven-to-create type;
 * Caspio auto-adds PK_ID). Booleans stored 'Yes'/'No' so Erik toggles in the UI.
 *
 *   node scripts/create-finished-photos-table.js          # dry-run (no writes)
 *   node scripts/create-finished-photos-table.js --apply  # create the table
 *
 * Idempotent: skips if the table already exists. No rows seeded.
 */
'use strict';
require('dotenv').config(); // standalone runs need Caspio creds from .env
const axios = require('axios');
const config = require('../src/config');
const { getCaspioAccessToken } = require('../src/utils/caspio');

const BASE = config.caspio.apiBaseUrl;
const APPLY = process.argv.includes('--apply');

const TABLES = [
  {
    Name: 'Finished_Photos',
    Fields: [
      { Name: 'id_Customer',      Type: 'STRING' }, // ShopWorks customer id — the portal scoping key
      { Name: 'Design_Number',    Type: 'STRING' }, // ShopWorks design # — places the photo next to its design
      { Name: 'Design_Name',      Type: 'STRING' }, // human label for the card title
      { Name: 'ID_Order',         Type: 'STRING' }, // optional — order # for repeat-order provenance
      { Name: 'Company_Name',     Type: 'STRING' }, // denormalized for staff search + card fallback
      { Name: 'Box_File_Id',      Type: 'STRING' }, // numeric Box file id (stable serving key)
      { Name: 'Image_URL',        Type: 'STRING' }, // {proxy}/api/box/thumbnail/{Box_File_Id}
      { Name: 'Caption',          Type: 'STRING' }, // staff/customer-facing note
      { Name: 'Uploaded_By',      Type: 'STRING' }, // staff email/identity
      { Name: 'Uploaded_Date',    Type: 'STRING' }, // ISO timestamp (best-effort)
      { Name: 'Show_To_Customer', Type: 'STRING' }, // 'Yes' / 'No' — portal visibility gate (default 'No')
    ],
  },
];

async function main() {
  const token = await getCaspioAccessToken();
  const H = { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } };
  console.log(`Mode: ${APPLY ? 'APPLY (writing)' : 'DRY-RUN (no writes)'}\n`);

  for (const def of TABLES) {
    let exists = false;
    try {
      await axios.get(`${BASE}/tables/${def.Name}/fields`, { headers: { Authorization: `Bearer ${token}` } });
      exists = true;
    } catch (_) { exists = false; }
    console.log(`Table ${def.Name}: ${exists ? 'already exists' : 'does NOT exist'}`);
    if (!exists) {
      console.log(`  ${APPLY ? 'creating' : 'would create'}: PK_ID(auto) + ${def.Fields.map(f => f.Name).join(', ')}`);
      if (APPLY) { await axios.post(`${BASE}/tables`, def, H); console.log('  ✓ created'); }
    }
  }
  if (APPLY) {
    for (const def of TABLES) {
      const fields = (await axios.get(`${BASE}/tables/${def.Name}/fields`, { headers: { Authorization: `Bearer ${token}` } })).data;
      const list = (fields.Result || fields.result || fields || []).map(f => f.Name || f.name).filter(Boolean);
      console.log(`\nVerify — ${def.Name}: ${list.join(', ')}`);
    }
  }
  console.log(`\n${APPLY ? 'Done.' : 'Dry-run only. Re-run with --apply.'}`);
}
main()
  .then(() => process.exit(0)) // Caspio token-refresh timer keeps the loop alive; exit explicitly
  .catch(e => { console.error('FATAL:', e.response ? JSON.stringify(e.response.data) : e.message); process.exit(1); });
