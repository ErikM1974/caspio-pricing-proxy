#!/usr/bin/env node
/**
 * Portal per-customer recommendations — Phase 1 setup.
 * Extends the existing Portal_Recommendations table into a small Erik-editable CANDIDATE POOL
 * (adds Brand / GP_Pct / Sell_Anchor / Is_Premium / Priority / Reward_Text), then upserts the
 * Phase-1 pool (4 premium heroes + 6 popular staples) and deactivates any old active row not in
 * the pool. The FE (server.js buildRecommendations(cid)) filters/ranks this pool per customer.
 *
 *   node scripts/setup-portal-recs-phase1.js          # dry-run (no writes)
 *   node scripts/setup-portal-recs-phase1.js --apply  # add columns + upsert pool
 *
 * Idempotent: only adds columns that are missing; upserts rows by Featured_Style.
 * NOTE: Sell_Anchor is an INTERNAL ranking anchor (margin-$ estimate) — it is NEVER shown as a
 * price on the portal (Rule 9). Reward_Text drives the "Earn $X" pill; blank = no pill.
 */
'use strict';
require('dotenv').config();
const axios = require('axios');
const config = require('../src/config');
const { getCaspioAccessToken, fetchAllCaspioPages } = require('../src/utils/caspio');

const BASE = config.caspio.apiBaseUrl;
const APPLY = process.argv.includes('--apply');
const TABLE = 'Portal_Recommendations';

const NEW_FIELDS = ['Brand', 'GP_Pct', 'Sell_Anchor', 'Is_Premium', 'Priority', 'Reward_Text'];

// The Phase-1 pool. Erik edits this in the Caspio UI afterward (swap styles, set Reward_Text $).
const POOL = [
  // ── 4 premium brand-name heroes (Is_Premium=Yes) — ranked by absolute margin $/pc ──
  { Featured_Style: 'CT104670', Color: '', Title: '', Blurb: 'Carhartt Storm Defender jacket — waterproof, built to last', Category: 'Outerwear', Brand: 'Carhartt',       GP_Pct: '50', Sell_Anchor: '160', Is_Premium: 'Yes', Priority: '1', Reward_Text: 'Earn reward dollars' },
  { Featured_Style: 'CTK121',   Color: '', Title: '', Blurb: 'Carhartt midweight hoodie they will live in',              Category: 'Fleece',    Brand: 'Carhartt',       GP_Pct: '50', Sell_Anchor: '69',  Is_Premium: 'Yes', Priority: '2', Reward_Text: 'Earn reward dollars' },
  { Featured_Style: 'NF0A3LGX', Color: '', Title: '', Blurb: 'The North Face soft shell — premium branded layer',        Category: 'Outerwear', Brand: 'The North Face', GP_Pct: '45', Sell_Anchor: '130', Is_Premium: 'Yes', Priority: '3', Reward_Text: 'Earn reward dollars' },
  { Featured_Style: 'NKDC1963', Color: '', Title: '', Blurb: 'Nike Dri-FIT polo — the swoosh sells itself',              Category: 'Polos',     Brand: 'Nike',           GP_Pct: '47', Sell_Anchor: '49',  Is_Premium: 'Yes', Priority: '4', Reward_Text: 'Earn reward dollars' },
  // ── 6 popular high-margin staples (Is_Premium=No) — for the 2 "popular" slots + backfill ──
  { Featured_Style: 'PC78H', Color: '', Title: '', Blurb: 'The #1 fleece pullover — 88 customers order it', Category: 'Fleece', Brand: 'Port & Company', GP_Pct: '65', Sell_Anchor: '32', Is_Premium: 'No', Priority: '1', Reward_Text: '' },
  { Featured_Style: '112',   Color: '', Title: '', Blurb: 'The trucker cap everyone asks for',              Category: 'Caps',   Brand: 'Richardson',     GP_Pct: '69', Sell_Anchor: '20', Is_Premium: 'No', Priority: '2', Reward_Text: '' },
  { Featured_Style: 'PC54',  Color: '', Title: '', Blurb: 'Soft, durable everyday cotton tee',              Category: 'Tees',   Brand: 'Port & Company', GP_Pct: '65', Sell_Anchor: '15', Is_Premium: 'No', Priority: '3', Reward_Text: '' },
  { Featured_Style: 'PC61',  Color: '', Title: '', Blurb: '6.1 oz heavyweight essential tee',               Category: 'Tees',   Brand: 'Port & Company', GP_Pct: '65', Sell_Anchor: '16', Is_Premium: 'No', Priority: '4', Reward_Text: '' },
  { Featured_Style: 'ST650', Color: '', Title: '', Blurb: 'Moisture-wicking sport polo',                    Category: 'Polos',  Brand: 'Sport-Tek',      GP_Pct: '58', Sell_Anchor: '22', Is_Premium: 'No', Priority: '5', Reward_Text: '' },
  { Featured_Style: 'PC90H', Color: '', Title: '', Blurb: 'Cozy pullover hoodie for cooler days',           Category: 'Fleece', Brand: 'Port & Company', GP_Pct: '65', Sell_Anchor: '28', Is_Premium: 'No', Priority: '6', Reward_Text: '' },
];

const ALL_FIELDS = ['Featured_Style', 'Color', 'Title', 'Blurb', 'Category', 'Active', 'Sort', 'Brand', 'GP_Pct', 'Sell_Anchor', 'Is_Premium', 'Priority', 'Reward_Text'];
function rowFor(p, i) { return Object.assign({ Active: 'Yes', Sort: String(i + 1) }, p); }
function whereStyle(s) { return encodeURIComponent(`Featured_Style='${String(s).replace(/'/g, "''")}'`); }

async function main() {
  const token = await getCaspioAccessToken();
  const H = { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } };
  const AH = { headers: { Authorization: `Bearer ${token}` } };
  console.log(`Mode: ${APPLY ? 'APPLY (writing)' : 'DRY-RUN (no writes)'}\n`);

  // 1) Add any missing columns.
  const fieldsResp = (await axios.get(`${BASE}/tables/${TABLE}/fields`, AH)).data;
  const existingFields = (fieldsResp.Result || fieldsResp.result || fieldsResp || []).map(f => f.Name || f.name).filter(Boolean);
  console.log(`Existing fields: ${existingFields.join(', ')}`);
  for (const name of NEW_FIELDS) {
    if (existingFields.includes(name)) { console.log(`  field ${name}: already exists`); continue; }
    console.log(`  field ${name}: ${APPLY ? 'ADDING' : 'would add'} (STRING)`);
    if (APPLY) { await axios.post(`${BASE}/tables/${TABLE}/fields`, { Name: name, Type: 'STRING' }, H); }
  }

  // 2) Upsert the pool by Featured_Style; deactivate old actives not in the pool.
  const existingRows = await fetchAllCaspioPages(`/tables/${TABLE}/records`, { 'q.select': 'Featured_Style,Active', 'q.pageSize': 200 }) || [];
  const existingStyles = new Set(existingRows.map(r => String(r.Featured_Style)));
  const poolStyles = new Set(POOL.map(p => p.Featured_Style));
  console.log(`\nPool = ${POOL.length} rows (${POOL.filter(p => p.Is_Premium === 'Yes').length} premium / ${POOL.filter(p => p.Is_Premium !== 'Yes').length} popular):`);
  for (let i = 0; i < POOL.length; i++) {
    const row = rowFor(POOL[i], i);
    const verb = existingStyles.has(row.Featured_Style) ? 'update' : 'insert';
    console.log(`  [${row.Is_Premium === 'Yes' ? 'PREM' : 'pop '}] ${row.Featured_Style.padEnd(9)} — ${verb}`);
    if (APPLY) {
      if (verb === 'update') await axios.put(`${BASE}/tables/${TABLE}/records?q.where=${whereStyle(row.Featured_Style)}`, row, H);
      else await axios.post(`${BASE}/tables/${TABLE}/records`, row, H);
    }
  }
  const toDeactivate = existingRows.filter(r => String(r.Active).toLowerCase() === 'yes' && !poolStyles.has(String(r.Featured_Style)));
  if (toDeactivate.length) {
    console.log(`\nDeactivating ${toDeactivate.length} old active row(s) not in the pool: ${toDeactivate.map(r => r.Featured_Style).join(', ')}`);
    if (APPLY) for (const r of toDeactivate) await axios.put(`${BASE}/tables/${TABLE}/records?q.where=${whereStyle(r.Featured_Style)}`, { Active: 'No' }, H);
  }
  console.log(`\n${APPLY ? 'Done.' : 'Dry-run only. Re-run with --apply.'}`);
}
main()
  .then(() => process.exit(0))
  .catch(e => { console.error('FATAL:', e.response ? JSON.stringify(e.response.data) : e.message); process.exit(1); });
