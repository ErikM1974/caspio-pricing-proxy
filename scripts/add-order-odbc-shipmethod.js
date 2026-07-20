#!/usr/bin/env node
/**
 * Add the `ShipMethod` column to ORDER_ODBC.
 *
 * WHY: the AE Mission Control data-quality radar wants to flag orders where a
 * ship METHOD was chosen (e.g. "UPS Ground") but the ship-to address block is
 * blank — the "method picked, address never entered" failure. ShopWorks keeps
 * the method on the ADDRESS row (`Addr.ShipMethod`), not on the Orders table,
 * so the bandit order-sync agent joins it in per order and posts it here. This
 * column is its destination. Text (≤255) — ShopWorks methods are short labels.
 *
 *   node scripts/add-order-odbc-shipmethod.js          # dry-run (read-only)
 *   node scripts/add-order-odbc-shipmethod.js --apply   # add the field
 *
 * Idempotent: skips if the column already exists. Adds a NULLABLE text column,
 * so it is safe on the live table (existing rows get NULL until re-synced).
 *
 * ROLLOUT ORDER (must be this order or Caspio 400s/500s):
 *   1. this script --apply           (column exists)
 *   2. deploy the proxy              (ODBC_FIELDS + data-quality q.select)
 *   3. recopy sync-orders.ps1 to bandit + run once  (column fills)
 */
'use strict';
require('dotenv').config();
const axios = require('axios');
const config = require('../src/config');
const { getCaspioAccessToken } = require('../src/utils/caspio');

const BASE = config.caspio.apiBaseUrl;
const APPLY = process.argv.includes('--apply');
const TABLE = 'ORDER_ODBC';
const FIELD = { Name: 'ShipMethod', Type: 'STRING' }; // STRING = Text(255) in Caspio

async function main() {
  const token = await getCaspioAccessToken();
  const H = { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } };
  console.log(`Mode: ${APPLY ? 'APPLY (writing)' : 'DRY-RUN (no writes)'}\n`);

  const resp = await axios.get(`${BASE}/tables/${TABLE}/fields`, { headers: { Authorization: `Bearer ${token}` } });
  const list = (resp.data.Result || resp.data.result || resp.data || []).map(f => f.Name || f.name).filter(Boolean);
  const has = list.includes(FIELD.Name);
  console.log(`Table ${TABLE} has ${list.length} fields:\n  ${list.join(', ')}`);
  console.log(`\n${FIELD.Name}: ${has ? 'already exists — nothing to do' : (APPLY ? 'adding…' : 'would add (dry-run)')}`);

  if (!has && APPLY) {
    await axios.post(`${BASE}/tables/${TABLE}/fields`, FIELD, H);
    const after = (await axios.get(`${BASE}/tables/${TABLE}/fields`, { headers: { Authorization: `Bearer ${token}` } })).data;
    const list2 = (after.Result || after.result || after || []).map(f => f.Name || f.name).filter(Boolean);
    console.log(`  ✓ added. ${TABLE} now has ${list2.length} fields.`);
  }
  console.log(`\n${APPLY ? 'Done.' : 'Dry-run only. Re-run with --apply to add the column.'}`);
}
main()
  .then(() => process.exit(0))
  .catch(e => { console.error('FATAL:', e.response ? JSON.stringify(e.response.data) : e.message); process.exit(1); });
