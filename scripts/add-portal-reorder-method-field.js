#!/usr/bin/env node
/**
 * Add the `Method` column to Portal_Reorder_Requests (decoration method the
 * customer chose for a re-order: Embroidery / Screen Print / DTG / DTF).
 * Defaulted from the customer's order history (ORDER_ODBC.ORDER_TYPE) and
 * confirmable by the customer. Erik-editable in the Caspio UI after this runs.
 *
 *   node scripts/add-portal-reorder-method-field.js          # dry-run
 *   node scripts/add-portal-reorder-method-field.js --apply  # add the field
 *
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
const FIELD = { Name: 'Method', Type: 'STRING' };

async function main() {
  const token = await getCaspioAccessToken();
  const H = { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } };
  console.log(`Mode: ${APPLY ? 'APPLY (writing)' : 'DRY-RUN (no writes)'}\n`);

  const resp = await axios.get(`${BASE}/tables/${TABLE}/fields`, { headers: { Authorization: `Bearer ${token}` } });
  const list = (resp.data.Result || resp.data.result || resp.data || []).map(f => f.Name || f.name).filter(Boolean);
  const has = list.includes(FIELD.Name);
  console.log(`Table ${TABLE} fields: ${list.join(', ')}`);
  console.log(`\n${FIELD.Name}: ${has ? 'already exists — nothing to do' : (APPLY ? 'adding…' : 'would add (dry-run)')}`);

  if (!has && APPLY) {
    await axios.post(`${BASE}/tables/${TABLE}/fields`, FIELD, H);
    const after = (await axios.get(`${BASE}/tables/${TABLE}/fields`, { headers: { Authorization: `Bearer ${token}` } })).data;
    const list2 = (after.Result || after.result || after || []).map(f => f.Name || f.name).filter(Boolean);
    console.log(`  ✓ added. Fields now: ${list2.join(', ')}`);
  }
  console.log(`\n${APPLY ? 'Done.' : 'Dry-run only. Re-run with --apply.'}`);
}
main()
  .then(() => process.exit(0))
  .catch(e => { console.error('FATAL:', e.response ? JSON.stringify(e.response.data) : e.message); process.exit(1); });
