/**
 * seed-product-copy.js — generic Product_Copy seeder. Batches live as JSON
 * maps in scripts/product-copy/*.json ({ "STYLE": "description", ... }).
 *
 *   node scripts/seed-product-copy.js scripts/product-copy/batch3a-carhartt-outerwear.json "batch 3a"          # dry-run
 *   node scripts/seed-product-copy.js scripts/product-copy/batch3a-carhartt-outerwear.json "batch 3a" --apply  # insert
 *
 * Insert-only: existing rows are never overwritten, so Erik's Caspio edits win.
 * Also verifies each style exists in the live catalog (groupBy+orderBy query —
 * q.distinct is IGNORED by Caspio and unordered pagination drops rows; see
 * LESSONS_LEARNED 2026-07-12) and warns on unknown styles instead of seeding them.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const config = require('../src/config');
const { getCaspioAccessToken, fetchAllCaspioPages } = require('../src/utils/caspio');

const BASE = config.caspio.apiBaseUrl;
const TABLE = 'Product_Copy';
const [, , jsonPath, batchLabel] = process.argv;
const APPLY = process.argv.includes('--apply');

if (!jsonPath || !batchLabel) {
  console.error('Usage: node scripts/seed-product-copy.js <copy.json> "<batch label>" [--apply]');
  process.exit(1);
}
const COPY = JSON.parse(fs.readFileSync(path.resolve(jsonPath), 'utf8'));

(async () => {
  const token = await getCaspioAccessToken();
  const H = { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } };
  console.log(`Mode: ${APPLY ? 'APPLY (writing)' : 'DRY-RUN'} — ${Object.keys(COPY).length} styles from ${path.basename(jsonPath)}\n`);

  // Live-catalog guard: never seed a style that isn't in the bulk table.
  const records = await fetchAllCaspioPages('/tables/Sanmar_Bulk_251816_Feb2024/records', {
    'q.select': 'STYLE', 'q.groupBy': 'STYLE', 'q.orderBy': 'STYLE', 'q.pageSize': 1000,
  });
  const live = new Set(records.map((r) => String(r.STYLE || '').trim().toUpperCase()).filter(Boolean));

  let added = 0, skipped = 0, unknown = 0;
  for (const [style, desc] of Object.entries(COPY)) {
    if (!live.has(style.toUpperCase())) { console.log(`  ?? NOT IN CATALOG, not seeded: ${style}`); unknown++; continue; }
    if (typeof desc !== 'string' || desc.length < 80) { console.log(`  !! copy too short, not seeded: ${style}`); unknown++; continue; }
    if (!APPLY) { console.log(`  would add ${style} (${desc.length} chars)`); continue; }
    const q = await axios.get(`${BASE}/tables/${TABLE}/records?q.where=${encodeURIComponent(`Style='${style}'`)}&q.select=Style`, H);
    if ((q.data.Result || []).length) { console.log(`  = exists, skipped: ${style}`); skipped++; continue; }
    await axios.post(`${BASE}/tables/${TABLE}/records`, {
      Style: style, Custom_Description: desc, Author: `Claude (${batchLabel}, 2026-07-12)`, Updated_At: new Date().toISOString(),
    }, H);
    added++;
  }
  console.log(`\n${APPLY ? `Done: ${added} inserted, ${skipped} already existed, ${unknown} rejected.` : `Dry-run only (${unknown} rejected). Re-run with --apply.`}`);
  process.exit(0); // api-tracker timer keeps the loop alive — exit explicitly
})().catch(e => { console.error('FAILED:', e.response ? JSON.stringify(e.response.data) : e.message); process.exit(1); });
