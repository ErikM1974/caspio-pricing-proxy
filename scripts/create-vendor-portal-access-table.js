#!/usr/bin/env node
/**
 * Create the `Vendor_Portal_Access` Caspio table — the invite registry for the
 * SUBCONTRACTOR vendor portal (magic-link login), starting with Ed Lacey at L&P
 * Screen Printing. Mirrors Customer_Portal_Access but keys on a VENDOR name
 * (matched against Transfer_Orders.SP_Vendor) instead of id_Customer. Erik-managed
 * (edit the table, no deploy): a row = "this email may log in and see this vendor's
 * screen-print jobs". Enabled='No' revokes within ~60s (live re-check in the gate).
 *
 *   node scripts/create-vendor-portal-access-table.js          # dry-run (no writes)
 *   node scripts/create-vendor-portal-access-table.js --apply  # create the table
 *
 * Idempotent: skips creation if the table already exists. No rows are seeded — Erik
 * adds invites (Email + Vendor_Name='L&P Printing' + Contact_Name + Enabled='Yes').
 */
'use strict';
require('dotenv').config(); // load .env so standalone runs get Caspio creds (server.js does this at boot; scripts must too)
const axios = require('axios');
const config = require('../src/config');
const { getCaspioAccessToken } = require('../src/utils/caspio');

const BASE = config.caspio.apiBaseUrl;
const TABLE = 'Vendor_Portal_Access';
const APPLY = process.argv.includes('--apply');

// All STRING (the proven-to-create type; Caspio auto-adds the PK). Enabled stores
// 'Yes'/'No' (Erik-friendly to toggle in the Caspio UI; the proxy reads it case-insensitively).
const TABLE_DEF = {
  Name: TABLE,
  Fields: [
    { Name: 'Email',        Type: 'STRING', Unique: true }, // login identity (lowercased)
    { Name: 'Vendor_Name',  Type: 'STRING' },               // MUST match Transfer_Orders.SP_Vendor (e.g. 'L&P Printing')
    { Name: 'Contact_Name', Type: 'STRING' },               // e.g. 'Ed Lacey' — display + note attribution
    { Name: 'Enabled',      Type: 'STRING' },               // 'Yes' / 'No'
    { Name: 'LastLogin',    Type: 'STRING' },               // ISO timestamp, best-effort
  ],
};

async function main() {
  const token = await getCaspioAccessToken();
  const H = { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } };
  console.log(`Mode: ${APPLY ? 'APPLY (writing)' : 'DRY-RUN (no writes)'}\n`);

  let exists = false;
  try {
    await axios.get(`${BASE}/tables/${TABLE}/fields`, { headers: { Authorization: `Bearer ${token}` } });
    exists = true;
  } catch (_) { exists = false; }
  console.log(`Table ${TABLE}: ${exists ? 'already exists' : 'does NOT exist'}`);

  if (!exists) {
    console.log(`  ${APPLY ? 'creating' : 'would create'} table: PK_ID(auto) + Email(unique), Vendor_Name, Contact_Name, Enabled, LastLogin (all Text 255)`);
    if (APPLY) {
      await axios.post(`${BASE}/tables`, TABLE_DEF, H);
      console.log('  ✓ table created');
    }
  } else {
    console.log('  (no changes — table already present)');
  }

  if (APPLY) {
    const fields = (await axios.get(`${BASE}/tables/${TABLE}/fields`, { headers: { Authorization: `Bearer ${token}` } })).data;
    const list = (fields.Result || fields.result || fields || []).map(f => f.Name || f.name).filter(Boolean);
    console.log(`\nVerify — ${TABLE} fields: ${list.join(', ')}`);
    console.log("\nNext: invite Ed by inserting a row (Email, Vendor_Name='L&P Printing', Contact_Name='Ed Lacey', Enabled='Yes').");
  }
  console.log(`\n${APPLY ? 'Done.' : 'Dry-run only. Re-run with --apply.'}`);
}
main().catch(e => { console.error('FATAL:', e.response ? JSON.stringify(e.response.data) : e.message); process.exit(1); });
