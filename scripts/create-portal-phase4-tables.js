#!/usr/bin/env node
/**
 * Create the two Caspio tables for Customer Portal Phase 4 (catalog + request-to-rep
 * re-order). Both are Erik-managed (edit in the Caspio UI, no deploy):
 *
 *   Portal_Recommendations   — curated "Recommended for you" strip (Erik picks styles)
 *   Portal_Reorder_Requests  — the rep work-queue + audit trail of customer re-order asks
 *
 *   node scripts/create-portal-phase4-tables.js          # dry-run (no writes)
 *   node scripts/create-portal-phase4-tables.js --apply  # create the tables
 *
 * Idempotent: skips any table that already exists. No rows seeded.
 */
'use strict';
require('dotenv').config(); // standalone runs need Caspio creds from .env (server.js does this at boot)
const axios = require('axios');
const config = require('../src/config');
const { getCaspioAccessToken } = require('../src/utils/caspio');

const BASE = config.caspio.apiBaseUrl;
const APPLY = process.argv.includes('--apply');

// All STRING (the proven-to-create type; Caspio auto-adds the PK_ID). Booleans stored as
// 'Yes'/'No' text so Erik can toggle them in the Caspio UI; the proxy reads case-insensitively.
const TABLES = [
  {
    Name: 'Portal_Recommendations',
    Fields: [
      { Name: 'Featured_Style', Type: 'STRING' }, // SanMar style # (e.g. PC54)
      { Name: 'Color',          Type: 'STRING' }, // optional specific color (blank = style default)
      { Name: 'Title',          Type: 'STRING' }, // optional override display name
      { Name: 'Blurb',          Type: 'STRING' }, // short marketing line ("New for spring")
      { Name: 'Category',       Type: 'STRING' }, // optional — for category-matched recs later
      { Name: 'Active',         Type: 'STRING' }, // 'Yes' / 'No'
      { Name: 'Sort',           Type: 'STRING' }, // display order (numeric-as-text)
    ],
  },
  {
    Name: 'Portal_Reorder_Requests',
    Fields: [
      { Name: 'Request_Num',    Type: 'STRING' }, // human-friendly id (RR-YYYY-####)
      { Name: 'id_Customer',    Type: 'STRING' }, // ShopWorks customer id (scoping key)
      { Name: 'Company_Name',   Type: 'STRING' },
      { Name: 'Email',          Type: 'STRING' }, // the customer who asked (session identity)
      { Name: 'Style',          Type: 'STRING' }, // base SanMar style
      { Name: 'Color',          Type: 'STRING' },
      { Name: 'Product_Title',  Type: 'STRING' },
      { Name: 'Design_Number',  Type: 'STRING' }, // the prior design (so the rep knows the decoration)
      { Name: 'Design_Name',    Type: 'STRING' },
      { Name: 'Qty',            Type: 'STRING' }, // requested quantity
      { Name: 'Size_Breakdown', Type: 'STRING' }, // e.g. "S:2, M:4, L:6"
      { Name: 'Method',         Type: 'STRING' }, // decoration method (Embroidery/Screen Print/DTG/DTF), defaulted from ORDER_ODBC.ORDER_TYPE
      { Name: 'Note',           Type: 'STRING' }, // customer note ("same as last time")
      { Name: 'Rep',            Type: 'STRING' }, // assigned CustomerServiceRep (from Sales_Reps_2026)
      { Name: 'Source',         Type: 'STRING' }, // 'reorder' | 'recommendation'
      { Name: 'Status',         Type: 'STRING' }, // New | In Progress | Quoted | Closed
      { Name: 'Created',        Type: 'STRING' }, // ISO timestamp (best-effort)
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
