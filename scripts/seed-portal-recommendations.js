#!/usr/bin/env node
/**
 * Seed a starter set of Portal_Recommendations rows so the customer portal's "Recommended
 * for You" strip isn't empty. Erik curates these in the Caspio UI afterward (edit/add/deactivate).
 *
 *   node scripts/seed-portal-recommendations.js          # dry-run
 *   node scripts/seed-portal-recommendations.js --apply  # insert (only if the table is empty)
 *
 * Idempotent: skips entirely if the table already has any rows (so re-runs don't duplicate).
 */
'use strict';
require('dotenv').config();
const axios = require('axios');
const config = require('../src/config');
const { getCaspioAccessToken, fetchAllCaspioPages } = require('../src/utils/caspio');

const BASE = config.caspio.apiBaseUrl;
const APPLY = process.argv.includes('--apply');
const TABLE = 'Portal_Recommendations';

const SEED = [
  { Featured_Style: 'PC61',  Color: '', Title: '', Blurb: 'Everyday favorite — 6.1 oz heavyweight tee', Category: 'Tees',   Active: 'Yes', Sort: '1' },
  { Featured_Style: 'ST650', Color: '', Title: '', Blurb: 'Moisture-wicking sport polo',                Category: 'Polos',  Active: 'Yes', Sort: '2' },
  { Featured_Style: 'PC90H', Color: '', Title: '', Blurb: 'Cozy pullover hoodie for cooler days',       Category: 'Fleece', Active: 'Yes', Sort: '3' },
  { Featured_Style: 'C112',  Color: '', Title: '', Blurb: "The trucker cap everyone's asking for",      Category: 'Caps',   Active: 'Yes', Sort: '4' },
  { Featured_Style: 'CP90',  Color: '', Title: '', Blurb: 'Classic knit beanie',                        Category: 'Caps',   Active: 'Yes', Sort: '5' },
  { Featured_Style: 'PC55',  Color: '', Title: '', Blurb: 'Soft, durable 50/50 blend tee',              Category: 'Tees',   Active: 'Yes', Sort: '6' },
];

async function main() {
  const token = await getCaspioAccessToken();
  const H = { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } };
  console.log(`Mode: ${APPLY ? 'APPLY' : 'DRY-RUN'}\n`);
  const existing = await fetchAllCaspioPages(`/tables/${TABLE}/records`, { 'q.select': 'Featured_Style', 'q.pageSize': 10 });
  if (existing && existing.length) {
    console.log(`${TABLE} already has ${existing.length} row(s) — skipping seed (edit in Caspio instead).`);
    return;
  }
  console.log(`${TABLE} is empty. ${APPLY ? 'Inserting' : 'Would insert'} ${SEED.length} rows:`);
  SEED.forEach(r => console.log(`  ${r.Featured_Style.padEnd(6)} — ${r.Blurb}`));
  if (APPLY) {
    for (const row of SEED) { await axios.post(`${BASE}/tables/${TABLE}/records`, row, H); }
    console.log('\n✓ inserted');
  } else {
    console.log('\nDry-run only. Re-run with --apply.');
  }
}
main().then(() => process.exit(0)).catch(e => { console.error('FATAL:', e.response ? JSON.stringify(e.response.data) : e.message); process.exit(1); });
