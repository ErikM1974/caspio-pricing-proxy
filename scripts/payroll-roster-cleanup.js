#!/usr/bin/env node
/**
 * Payroll follow-ups Erik confirmed 2026-07-27, after the first packet import.
 *
 *   node scripts/payroll-roster-cleanup.js          # dry-run
 *   node scripts/payroll-roster-cleanup.js --apply  # write
 *
 * 1. Vacation eligibility. Clark's -16 vacation is CORRECT, not a data error: she was hired
 *    2025-08-12 and accrues her first 40 hours on 2026-08-16 (1 year), so she runs negative
 *    until then. NW Regional's report prints 0 for her, which is the wrong display — do NOT
 *    "correct" the -16. Recording the eligibility date so nobody re-litigates this later.
 * 2. Deactivate the 4 remaining ex-employees (Hanson, Massey, Pon, Trujillo).
 *    Status=false, NOT deleted — deleting would destroy their payroll history and orphan the
 *    Payroll_Register rows that record what NW Regional actually reported.
 * 3. Restrict payroll to admin via Staff_Page_Access.
 */
'use strict';
const axios = require('axios');
const config = require('../src/config');
const { getCaspioAccessToken } = require('../src/utils/caspio');

const BASE = config.caspio.apiBaseUrl;
const APPLY = process.argv.includes('--apply');
const EMPLOYEES = 'Employees';

const NEW_FIELD = { Name: 'Vacation_Eligible_Date', Type: 'DATE/TIME' };

// Vacation accrues at the 1-year anniversary. Only Clark is set here — say the word and I'll
// backfill the rest as Date_Hired + 1 year if that's the universal rule.
const ELIGIBILITY = [
  { last: 'Clark', first: 'Taneisha', date: '2026-08-16', why: 'hired 2025-08-12; first 40 h accrue at 1 year' },
];

// Erik 2026-07-27: no longer employed. Khiev was already deactivated during the packet import.
const DEACTIVATE = [
  { first: 'Taylar', last: 'Hanson' },
  { first: 'Antonio', last: 'Massey' },
  { first: 'Sanou', last: 'Pon' },
  { first: 'Adriyella', last: 'Trujillo' },
];

// Payroll is the most sensitive data in the account — admin only, no accountant.
const PAGE_ACCESS = {
  Page: 'payroll.html',
  Allowed_Roles: 'admin',
  Allowed_Emails: '',
  Description: 'Payroll register + pay rates + leave balances — admin only',
};

const esc = (s) => String(s).replace(/'/g, "''");

async function main() {
  const token = await getCaspioAccessToken();
  const auth = { Authorization: `Bearer ${token}` };
  const H = { headers: { ...auth, 'Content-Type': 'application/json' } };
  console.log(`Mode: ${APPLY ? 'APPLY (writing)' : 'DRY-RUN (no writes)'}\n`);

  // ---- 1. Vacation_Eligible_Date ----
  console.log('=== 1. Vacation eligibility ===');
  const fields = (await axios.get(`${BASE}/tables/${EMPLOYEES}/fields`, { headers: auth })).data.Result;
  if (fields.some(f => f.Name === NEW_FIELD.Name)) {
    console.log(`  = ${NEW_FIELD.Name} already exists`);
  } else if (!APPLY) {
    console.log(`  + would add ${NEW_FIELD.Name} (${NEW_FIELD.Type})`);
  } else {
    await axios.post(`${BASE}/tables/${EMPLOYEES}/fields`, NEW_FIELD, H);
    console.log(`  ✓ added ${NEW_FIELD.Name}`);
  }
  for (const e of ELIGIBILITY) {
    const where = `First_Name='${esc(e.first)}' AND Last_Name='${esc(e.last)}'`;
    if (!APPLY) { console.log(`  would set ${e.first} ${e.last} → ${e.date} (${e.why})`); continue; }
    try {
      await axios.put(`${BASE}/tables/${EMPLOYEES}/records?q.where=${encodeURIComponent(where)}`,
        { Vacation_Eligible_Date: e.date }, H);
      console.log(`  ✓ ${e.first} ${e.last} → ${e.date}`);
    } catch (err) { console.log(`  ❌ ${e.first} ${e.last}: ${err.response ? JSON.stringify(err.response.data) : err.message}`); }
  }

  // ---- 2. Deactivate ex-employees ----
  console.log('\n=== 2. Deactivate ex-employees (Status=false, records KEPT) ===');
  for (const d of DEACTIVATE) {
    const where = `First_Name='${esc(d.first)}' AND Last_Name='${esc(d.last)}'`;
    if (!APPLY) { console.log(`  would set Status=false on ${d.first} ${d.last}`); continue; }
    try {
      const r = await axios.put(`${BASE}/tables/${EMPLOYEES}/records?q.where=${encodeURIComponent(where)}`,
        { Status: false }, H);
      const n = r.data && r.data.RecordsAffected;
      console.log(n === 0 ? `  ⚠ ${d.first} ${d.last}: matched 0 rows` : `  ✓ ${d.first} ${d.last} deactivated`);
    } catch (err) { console.log(`  ❌ ${d.first} ${d.last}: ${err.response ? JSON.stringify(err.response.data) : err.message}`); }
  }

  // ---- 3. Admin-only page access ----
  console.log('\n=== 3. Staff_Page_Access → admin only ===');
  if (!APPLY) {
    console.log(`  would upsert ${PAGE_ACCESS.Page} → roles[${PAGE_ACCESS.Allowed_Roles}]`);
  } else {
    try {
      try { await axios.post(`${BASE}/tables/Staff_Page_Access/records`, PAGE_ACCESS, H); }
      catch (_) {
        const { Page, ...upd } = PAGE_ACCESS;
        await axios.put(`${BASE}/tables/Staff_Page_Access/records?q.where=${encodeURIComponent(`Page='${esc(Page)}'`)}`, upd, H);
      }
      console.log(`  ✓ ${PAGE_ACCESS.Page} → roles[${PAGE_ACCESS.Allowed_Roles}]`);
    } catch (err) { console.log(`  ❌ ${err.response ? JSON.stringify(err.response.data) : err.message}`); }
  }

  // ---- Verify ----
  if (APPLY) {
    const rows = (await axios.get(
      `${BASE}/tables/${EMPLOYEES}/records?q.select=Employee_Full_Name,Status,Vacation_Eligible_Date&q.pageSize=500&q.orderBy=PK_ID`,
      { headers: auth })).data.Result;
    console.log(`\nVerify — active employees: ${rows.filter(r => r.Status).length} of ${rows.length}`);
    const still = DEACTIVATE.filter(d => rows.some(r => r.Employee_Full_Name === `${d.first} ${d.last}` && r.Status));
    console.log(still.length ? `  ⚠ still active: ${still.map(d => d.first + ' ' + d.last).join(', ')}` : '  ✓ all 4 deactivated');
    const clark = rows.find(r => /Clark/.test(r.Employee_Full_Name || ''));
    console.log(`  Clark vacation-eligible: ${clark && clark.Vacation_Eligible_Date ? String(clark.Vacation_Eligible_Date).slice(0, 10) : 'NOT SET'}`);
  }
  console.log(`\n${APPLY ? 'Done.' : 'Dry-run only. Re-run with --apply.'}`);
}
main().catch(e => { console.error('FATAL:', e.response ? JSON.stringify(e.response.data) : e.message); process.exit(1); });
