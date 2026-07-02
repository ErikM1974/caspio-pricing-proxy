#!/usr/bin/env node
/**
 * Product_Upgrades — the Erik-editable "good -> better -> best" upgrade ladder for the customer
 * portal product page (Phase C). Keyed by CATEGORY (matches product-details CATEGORY_NAME) so the
 * page can look up "the premium version of the tee you already buy + an embroidered logo".
 *
 * Mirrors the Portal_Recommendations pattern (margin-ranked, Erik maintains in Caspio). This script
 * CREATES the table if missing, ensures all columns exist, and upserts a starter ladder. Extend it
 * later for more category recommendations — just add rows in Caspio (or here + re-run).
 *
 *   node scripts/setup-product-upgrades.js          # dry-run (no writes)
 *   node scripts/setup-product-upgrades.js --apply  # create table + columns + seed rows
 *
 * Idempotent: table create is skipped if it already exists; columns added only if missing; rows
 * upserted by (Category + Upgrade_Style). NOTE: Sell_Anchor/GP_Pct are INTERNAL margin ranking
 * signals — the portal server strips them before anything reaches the browser (like buildRecommendations).
 */
'use strict';
require('dotenv').config();
const axios = require('axios');
const config = require('../src/config');
const { getCaspioAccessToken, fetchAllCaspioPages } = require('../src/utils/caspio');

const BASE = config.caspio.apiBaseUrl;
const APPLY = process.argv.includes('--apply');
const TABLE = 'Product_Upgrades';

const COLUMNS = [
  { Name: 'Category', Type: 'STRING' },          // anchor — matches product CATEGORY_NAME
  { Name: 'From_Style', Type: 'STRING' },        // optional: only offer for this base style (blank = whole category)
  { Name: 'Tier', Type: 'STRING' },              // Better | Best
  { Name: 'Upgrade_Style', Type: 'STRING' },     // the SanMar style we upsell TO
  { Name: 'Upgrade_Title', Type: 'STRING' },
  { Name: 'Default_Stitch', Type: 'STRING' },    // logo size for the price matrix (e.g. 8000)
  { Name: 'Default_Location', Type: 'STRING' },  // e.g. Left Chest
  { Name: 'Sell_Anchor', Type: 'STRING' },       // INTERNAL margin $ rank (never shown)
  { Name: 'GP_Pct', Type: 'STRING' },            // INTERNAL gross-profit % rank (never shown)
  { Name: 'Blurb', Type: 'STRING' },
  { Name: 'Active', Type: 'STRING' },            // Yes | No
  { Name: 'Sort', Type: 'STRING' },
];

// Starter ladder — categories verified against live product-details CATEGORY_NAME (2026-07-01).
const ROWS = [
  { Category: 'T-Shirts', From_Style: '', Tier: 'Better', Upgrade_Style: 'PC450', Upgrade_Title: 'Port & Company Fan Favorite Tee', Default_Stitch: '8000', Default_Location: 'Left Chest', Sell_Anchor: '15', GP_Pct: '65', Blurb: 'A heavier, softer everyday tee that holds an embroidered logo crisply.', Active: 'Yes', Sort: '1' },
  { Category: 'T-Shirts', From_Style: '', Tier: 'Best', Upgrade_Style: 'BC3001', Upgrade_Title: 'Bella+Canvas Unisex Jersey Tee', Default_Stitch: '8000', Default_Location: 'Left Chest', Sell_Anchor: '18', GP_Pct: '60', Blurb: 'Premium ring-spun jersey — the retail-soft tee people actually keep wearing.', Active: 'Yes', Sort: '2' },
  { Category: 'Polos/Knits', From_Style: '', Tier: 'Best', Upgrade_Style: 'NKDC1963', Upgrade_Title: 'Nike Dri-FIT Polo', Default_Stitch: '8000', Default_Location: 'Left Chest', Sell_Anchor: '49', GP_Pct: '47', Blurb: 'The swoosh sells itself — moisture-wicking performance with an embroidered logo.', Active: 'Yes', Sort: '1' },
  { Category: 'Sweatshirts/Fleece', From_Style: '', Tier: 'Better', Upgrade_Style: 'PC90H', Upgrade_Title: 'Port & Company Pullover Hoodie', Default_Stitch: '8000', Default_Location: 'Left Chest', Sell_Anchor: '28', GP_Pct: '65', Blurb: 'A cozy everyday hoodie — embroidery gives it a premium, built-to-last look.', Active: 'Yes', Sort: '1' },
  { Category: 'Sweatshirts/Fleece', From_Style: '', Tier: 'Best', Upgrade_Style: 'CTK121', Upgrade_Title: 'Carhartt Midweight Hoodie', Default_Stitch: '8000', Default_Location: 'Left Chest', Sell_Anchor: '69', GP_Pct: '50', Blurb: 'The Carhartt name plus your embroidered logo — a hoodie crews are proud to wear.', Active: 'Yes', Sort: '2' },
  { Category: 'Outerwear', From_Style: '', Tier: 'Best', Upgrade_Style: 'CT104670', Upgrade_Title: 'Carhartt Storm Defender Jacket', Default_Stitch: '8000', Default_Location: 'Left Chest', Sell_Anchor: '160', GP_Pct: '45', Blurb: 'Waterproof, rugged, and premium — the jacket that makes your brand look serious.', Active: 'Yes', Sort: '1' },
];

const enc = (s) => encodeURIComponent(String(s).replace(/'/g, "''"));
const whereFor = (r) => enc(`Category='${r.Category}' AND Upgrade_Style='${r.Upgrade_Style}'`);

async function main() {
  const token = await getCaspioAccessToken();
  const H = { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } };
  const AH = { headers: { Authorization: `Bearer ${token}` } };
  console.log(`Mode: ${APPLY ? 'APPLY (writing)' : 'DRY-RUN (no writes)'}\nTable: ${TABLE}\n`);

  // 1) Ensure the table exists.
  let exists = false;
  try {
    const t = (await axios.get(`${BASE}/tables/${TABLE}/fields`, AH)).data;
    exists = !!(t && (t.Result || t.result || t));
    console.log('Table exists — will ensure columns + upsert rows.');
  } catch (e) {
    if (e.response && e.response.status === 404) console.log('Table does not exist yet.');
    else console.log('Field check returned:', e.response ? e.response.status : e.message);
  }
  if (!exists) {
    console.log(`  ${APPLY ? 'CREATING' : 'would create'} table ${TABLE} with ${COLUMNS.length} columns (+ auto PK_ID).`);
    if (APPLY) {
      await axios.post(`${BASE}/tables`, { Name: TABLE, Columns: COLUMNS }, H);
      console.log('  Table created.');
      exists = true;
    }
  }

  // 2) Ensure all columns exist (covers a pre-existing/partial table).
  if (exists && APPLY) {
    const fieldsResp = (await axios.get(`${BASE}/tables/${TABLE}/fields`, AH)).data;
    const have = new Set((fieldsResp.Result || fieldsResp.result || fieldsResp || []).map((f) => f.Name || f.name).filter(Boolean));
    for (const c of COLUMNS) {
      if (have.has(c.Name)) continue;
      console.log(`  adding column ${c.Name}`);
      await axios.post(`${BASE}/tables/${TABLE}/fields`, c, H);
    }
  }

  // 3) Upsert the starter ladder by (Category + Upgrade_Style).
  let existingRows = [];
  if (exists) {
    try { existingRows = await fetchAllCaspioPages(`/tables/${TABLE}/records`, { 'q.select': 'Category,Upgrade_Style', 'q.pageSize': 500 }) || []; }
    catch (_) { existingRows = []; }
  }
  const seen = new Set(existingRows.map((r) => `${r.Category}||${r.Upgrade_Style}`));
  console.log(`\nStarter ladder (${ROWS.length} rows):`);
  for (const r of ROWS) {
    const verb = seen.has(`${r.Category}||${r.Upgrade_Style}`) ? 'update' : 'insert';
    console.log(`  [${r.Tier.padEnd(6)}] ${r.Category.padEnd(20)} -> ${r.Upgrade_Style.padEnd(9)} (${verb})`);
    if (APPLY) {
      if (verb === 'update') await axios.put(`${BASE}/tables/${TABLE}/records?q.where=${whereFor(r)}`, r, H);
      else await axios.post(`${BASE}/tables/${TABLE}/records`, r, H);
    }
  }
  console.log(`\n${APPLY ? 'Done.' : 'Dry-run only. Re-run with --apply.'}`);
}
main().then(() => process.exit(0)).catch((e) => {
  console.error('FATAL:', e.response ? JSON.stringify(e.response.data) : (e.stack || e.message));
  process.exit(1);
});
