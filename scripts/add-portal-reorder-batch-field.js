#!/usr/bin/env node
/**
 * Add the `Batch_Num` column to Portal_Reorder_Requests. When a customer sends a
 * multi-item "Re-order List", every item becomes its own row sharing one Batch_Num
 * (RB-YYYYMMDD-HHMMSS) so the rep sees them grouped as a single ask.
 *   node scripts/add-portal-reorder-batch-field.js          # dry-run
 *   node scripts/add-portal-reorder-batch-field.js --apply  # add the field
 * Idempotent: skips if the column already exists.
 */
'use strict';
require('dotenv').config();
const axios = require('axios');
const config = require('../src/config');
const { getCaspioAccessToken } = require('../src/utils/caspio');
const BASE = config.caspio.apiBaseUrl;
const APPLY = process.argv.includes('--apply');
const TABLE = 'Portal_Reorder_Requests';
const FIELD = { Name: 'Batch_Num', Type: 'STRING' };
async function main() {
  const token = await getCaspioAccessToken();
  const H = { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } };
  console.log(`Mode: ${APPLY ? 'APPLY' : 'DRY-RUN'}\n`);
  const resp = await axios.get(`${BASE}/tables/${TABLE}/fields`, { headers: { Authorization: `Bearer ${token}` } });
  const list = (resp.data.Result || resp.data.result || resp.data || []).map(f => f.Name || f.name).filter(Boolean);
  const has = list.includes(FIELD.Name);
  console.log(`${TABLE} fields: ${list.join(', ')}`);
  console.log(`\n${FIELD.Name}: ${has ? 'already exists' : (APPLY ? 'adding…' : 'would add')}`);
  if (!has && APPLY) {
    await axios.post(`${BASE}/tables/${TABLE}/fields`, FIELD, H);
    const after = (await axios.get(`${BASE}/tables/${TABLE}/fields`, { headers: { Authorization: `Bearer ${token}` } })).data;
    console.log('  ✓ added. Fields now: ' + (after.Result || after.result || after || []).map(f => f.Name || f.name).filter(Boolean).join(', '));
  }
  console.log(`\n${APPLY ? 'Done.' : 'Dry-run only. Re-run with --apply.'}`);
}
main().then(() => process.exit(0)).catch(e => { console.error('FATAL:', e.response ? JSON.stringify(e.response.data) : e.message); process.exit(1); });
