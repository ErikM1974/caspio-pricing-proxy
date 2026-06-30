#!/usr/bin/env node
/**
 * One-time: set the `Role` field on each ACTIVE Caspio "Staff" directory user, so
 * the app can derive RBAC from Caspio (no more hardcoded permission map). Updates
 * ONLY the Role field, scoped by exact Email. DRY-RUN by default; pass --apply to write.
 *
 *   node scripts/set-staff-roles.js            # dry-run (prints intended changes)
 *   node scripts/set-staff-roles.js --apply    # actually write the Role field
 *
 * Does NOT touch terminated users (adriyella@, taylar@) — those are offboarded by Erik
 * in the Caspio UI. Read-only verify after each write. Sensitive fields never printed.
 */
'use strict';
const axios = require('axios');
const config = require('../src/config');
const { getCaspioAccessToken } = require('../src/utils/caspio');

const BASE = config.caspio.apiBaseUrl;
const DIR = '55u0q8'; // Staff directory
const APPLY = process.argv.includes('--apply');

// email → Role value. Single source of truth for the role assignment.
const ROLES = {
  'erik@nwcustomapparel.com': 'admin',          // full access incl. financials
  'bradley@nwcustomapparel.com': 'accountant',  // financials (cards/gift-certs/invoices/sales $)
  'taneisha@nwcustomapparel.com': 'sales',      // own CRM dashboard (by identity) + sales tools
  'nika@nwcustomapparel.com': 'sales',
  'art@nwcustomapparel.com': 'art',             // Steve — art hub
  'ruth@nwcustomapparel.com': 'art',            // Ruth — digitizing/mockups
  'mikalah@nwcustomapparel.com': 'shipping',    // shipping & receiving
  'brian.beardsley@nwcustomapparel.com': 'production', // DTG supervisor
};

async function main() {
  const token = await getCaspioAccessToken();
  const H = { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } };

  console.log(`Mode: ${APPLY ? 'APPLY (writing)' : 'DRY-RUN (no writes)'}\nDirectory: ${DIR}\n`);

  for (const [email, role] of Object.entries(ROLES)) {
    const where = `Email='${email}'`;
    if (!APPLY) {
      console.log(`  would set Role='${role}'  where ${where}`);
      continue;
    }
    try {
      const url = `${BASE}/directories/${DIR}/users?Where=${encodeURIComponent(where)}&response=rows`;
      await axios.put(url, { Role: role }, H);
      // read-back verify (only Role + Email/Name to prove nothing else mangled)
      const back = (await axios.get(`${BASE}/directories/${DIR}/users?Where=${encodeURIComponent(where)}`, { headers: { Authorization: `Bearer ${token}` } })).data;
      const u = (back.Result || back.result || [])[0] || {};
      const ok = u.Role === role && u.Email === email;
      console.log(`  ${ok ? 'OK ' : '⚠️ '} ${email} → Role='${u.Role}'  (Name='${u.Full_Name}' intact: ${!!u.Full_Name})`);
    } catch (e) {
      console.log(`  ❌ ${email}: ${e.response ? `${e.response.status} ${JSON.stringify(e.response.data)}` : e.message}`);
    }
  }
  console.log(`\n${APPLY ? 'Done.' : 'Dry-run only. Re-run with --apply to write.'}`);
}
main().catch(e => { console.error('FATAL:', e.response ? JSON.stringify(e.response.data) : e.message); process.exit(1); });
