#!/usr/bin/env node
/**
 * Create the `Staff_Page_Access` Caspio table — the app-readable map of which staff
 * PAGES are restricted to which roles/people. Holds only the EXCEPTIONS (restricted
 * pages); any page NOT listed defaults to "any logged-in staff". Erik edits this table
 * (or the Access-Admin UI) → page access changes with no deploy.
 *
 *   node scripts/create-staff-page-access-table.js          # dry-run
 *   node scripts/create-staff-page-access-table.js --apply  # create + seed
 *
 * Columns: Page (the /dashboards/*.html filename), Allowed_Roles (comma list, e.g.
 * "admin,accountant"), Allowed_Emails (comma list of specific people). Access = the
 * user's role/permission is in Allowed_Roles OR their email is in Allowed_Emails.
 */
'use strict';
const axios = require('axios');
const config = require('../src/config');
const { getCaspioAccessToken } = require('../src/utils/caspio');

const BASE = config.caspio.apiBaseUrl;
const TABLE = 'Staff_Page_Access';
const APPLY = process.argv.includes('--apply');

const TABLE_DEF = {
  Name: TABLE,
  Fields: [
    { Name: 'Page', Type: 'STRING', Unique: true },
    { Name: 'Allowed_Roles', Type: 'STRING' },
    { Name: 'Allowed_Emails', Type: 'TEXT' },
    { Name: 'Description', Type: 'STRING' },
  ],
};

// Seed a couple SENSIBLE examples so the table isn't empty + Erik sees the format.
// He adjusts/adds in Caspio (or the Access-Admin UI). NOTE: the 3 per-rep dashboards
// (taneisha/nika/house) keep their existing code gates — don't double-list them here.
const SEED = [
  { Page: 'art-invoices-dashboard.html', Allowed_Roles: 'admin,accountant', Allowed_Emails: '', Description: 'Art billing $ — finance only' },
  { Page: 'commission-structure.html',   Allowed_Roles: 'admin',            Allowed_Emails: '', Description: 'Commission structure — admin only' },
];

async function main() {
  const token = await getCaspioAccessToken();
  const H = { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } };
  console.log(`Mode: ${APPLY ? 'APPLY (writing)' : 'DRY-RUN (no writes)'}\n`);

  let exists = false;
  try { await axios.get(`${BASE}/tables/${TABLE}/fields`, { headers: { Authorization: `Bearer ${token}` } }); exists = true; } catch (_) {}
  console.log(`Table ${TABLE}: ${exists ? 'already exists' : 'does NOT exist'}`);
  if (!exists) {
    console.log(`  ${APPLY ? 'creating' : 'would create'}: Page(unique), Allowed_Roles, Allowed_Emails, Description`);
    if (APPLY) { await axios.post(`${BASE}/tables`, TABLE_DEF, H); console.log('  ✓ table created'); }
  }

  console.log('\nSeed rows (examples — Erik can edit/remove):');
  for (const r of SEED) {
    if (!APPLY) { console.log(`  would add ${r.Page} → roles[${r.Allowed_Roles}] emails[${r.Allowed_Emails}]`); continue; }
    try {
      try { await axios.post(`${BASE}/tables/${TABLE}/records`, r, H); console.log(`  ✓ inserted ${r.Page}`); }
      catch (_) { await axios.put(`${BASE}/tables/${TABLE}/records?q.where=${encodeURIComponent(`Page='${r.Page}'`)}`, { Allowed_Roles: r.Allowed_Roles, Allowed_Emails: r.Allowed_Emails, Description: r.Description }, H); console.log(`  ✓ updated ${r.Page}`); }
    } catch (e) { console.log(`  ❌ ${r.Page}: ${e.response ? JSON.stringify(e.response.data) : e.message}`); }
  }

  if (APPLY) {
    const back = (await axios.get(`${BASE}/tables/${TABLE}/records?q.select=Page,Allowed_Roles,Allowed_Emails&q.pageSize=100`, { headers: { Authorization: `Bearer ${token}` } })).data;
    const rows = back.Result || [];
    console.log(`\nVerify — ${rows.length} rows:`);
    rows.forEach(x => console.log(`   ${x.Page} → roles[${x.Allowed_Roles}] emails[${x.Allowed_Emails}]`));
  }
  console.log(`\n${APPLY ? 'Done.' : 'Dry-run only. Re-run with --apply.'}`);
}
main().catch(e => { console.error('FATAL:', e.response ? JSON.stringify(e.response.data) : e.message); process.exit(1); });
