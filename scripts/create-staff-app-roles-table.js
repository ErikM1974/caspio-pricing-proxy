#!/usr/bin/env node
/**
 * Create the `Staff_App_Roles` Caspio table (Email + Role) and populate it with the
 * staff role map — the REST-readable home for app-side RBAC (admin/accountant/sales/
 * art/shipping/production). Replaces the hardcoded staff-saml permission map.
 *
 * Caspio Groups aren't exposed via REST and the directory Role field is auth-typed,
 * so a plain data table is the clean, app-readable, Erik-editable place for this.
 *
 *   node scripts/create-staff-app-roles-table.js          # dry-run (no writes)
 *   node scripts/create-staff-app-roles-table.js --apply  # create table + insert rows
 *
 * Idempotent-ish: skips table creation if it already exists; upserts rows by Email.
 */
'use strict';
const axios = require('axios');
const config = require('../src/config');
const { getCaspioAccessToken } = require('../src/utils/caspio');

const BASE = config.caspio.apiBaseUrl;
const TABLE = 'Staff_App_Roles';
const APPLY = process.argv.includes('--apply');

const ROWS = [
  { Email: 'erik@nwcustomapparel.com',           Role: 'admin' },
  { Email: 'bradley@nwcustomapparel.com',        Role: 'accountant' },
  { Email: 'taneisha@nwcustomapparel.com',       Role: 'sales' },
  { Email: 'nika@nwcustomapparel.com',           Role: 'sales' },
  { Email: 'art@nwcustomapparel.com',            Role: 'art' },        // Steve
  { Email: 'ruth@nwcustomapparel.com',           Role: 'art' },        // Ruth
  { Email: 'mikalah@nwcustomapparel.com',        Role: 'shipping' },
  { Email: 'brian.beardsley@nwcustomapparel.com', Role: 'production' },
];

const TABLE_DEF = {
  Name: TABLE,
  // Caspio REST field types: STRING = Text(255), TEXT = Text(64000). Caspio adds the
  // PK automatically, so we don't declare an AUTONUMBER field.
  Fields: [
    { Name: 'Email', Type: 'STRING', Unique: true },
    { Name: 'Role',  Type: 'STRING' },
  ],
};

async function main() {
  const token = await getCaspioAccessToken();
  const H = { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } };
  console.log(`Mode: ${APPLY ? 'APPLY (writing)' : 'DRY-RUN (no writes)'}\n`);

  // 1) Does the table already exist?
  let exists = false;
  try {
    await axios.get(`${BASE}/tables/${TABLE}/fields`, { headers: { Authorization: `Bearer ${token}` } });
    exists = true;
  } catch (_) { exists = false; }
  console.log(`Table ${TABLE}: ${exists ? 'already exists' : 'does NOT exist'}`);

  if (!exists) {
    console.log(`  ${APPLY ? 'creating' : 'would create'} table with fields: PK_ID(AutoNumber), Email(Text 255, unique), Role(Text 255)`);
    if (APPLY) {
      await axios.post(`${BASE}/tables`, TABLE_DEF, H);
      console.log('  ✓ table created');
    }
  }

  // 2) Populate rows (insert; on duplicate email, update Role).
  console.log(`\nRows:`);
  for (const r of ROWS) {
    if (!APPLY) { console.log(`  would set ${r.Email} → '${r.Role}'`); continue; }
    try {
      // upsert: try insert; if the unique Email already exists, PUT the Role.
      try {
        await axios.post(`${BASE}/tables/${TABLE}/records`, r, H);
        console.log(`  ✓ inserted ${r.Email} → '${r.Role}'`);
      } catch (e) {
        const where = `Email='${r.Email}'`;
        await axios.put(`${BASE}/tables/${TABLE}/records?q.where=${encodeURIComponent(where)}`, { Role: r.Role }, H);
        console.log(`  ✓ updated ${r.Email} → '${r.Role}'`);
      }
    } catch (e) {
      console.log(`  ❌ ${r.Email}: ${e.response ? `${e.response.status} ${JSON.stringify(e.response.data)}` : e.message}`);
    }
  }

  // 3) Verify
  if (APPLY) {
    const back = (await axios.get(`${BASE}/tables/${TABLE}/records?q.select=Email,Role&q.pageSize=50`, { headers: { Authorization: `Bearer ${token}` } })).data;
    const rows = back.Result || back.result || [];
    console.log(`\nVerify — ${rows.length} rows in ${TABLE}:`);
    rows.forEach(x => console.log(`   ${x.Email} → ${x.Role}`));
  }
  console.log(`\n${APPLY ? 'Done.' : 'Dry-run only. Re-run with --apply.'}`);
}
main().catch(e => { console.error('FATAL:', e.response ? JSON.stringify(e.response.data) : e.message); process.exit(1); });
