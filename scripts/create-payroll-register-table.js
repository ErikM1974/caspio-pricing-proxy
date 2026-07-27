#!/usr/bin/env node
/**
 * SCHEMA step for payroll tracking (Erik, 2026-07-27).
 *
 *   node scripts/create-payroll-register-table.js          # dry-run
 *   node scripts/create-payroll-register-table.js --apply  # create + alter
 *
 * Two things:
 *   1. ADD fields to `Employees` so it can hold CURRENT truth (rate + leave) sourced
 *      from the payroll packet instead of being hand-typed. Purely additive — nothing
 *      renamed or removed, because `Employees` is attached to 10 bridge apps AND is the
 *      staff auth table (Password / Email_Employee_Login / the *_Admin auth views).
 *   2. CREATE `Payroll_Register` — one row per employee per PAY DATE. This is the
 *      mechanism that keeps `Employees` correct: without per-period history a one-time
 *      correction just drifts again (it already drifted on 20/20 employees by 7/24/2026).
 *
 * Grain note: 21 people appear on the leave report but only 16 got checks, so the
 * register carries a row for EVERY employee on the packet with `Paid_This_Period`
 * flagging which ones had a check. That lets leave balances ride along on the same row
 * instead of needing a second table.
 *
 * Deliberate choices:
 *   - `Payroll_Employee_ID` is NOT declared Unique: 8 of 29 Employees rows have no
 *     payroll ID, and multi-NULL behaviour under a Caspio unique index is unverified.
 *     The importer asserts uniqueness instead (see import-payroll-packet.js).
 *   - `Sick_Hours_Remaining` / `Annual_Salary_Est` are plain fields, not formulas:
 *     REST formula creation is undocumented, and the importer is the single writer so a
 *     computed value can't drift. Convert them to formulas in the UI if preferred.
 */
'use strict';
const axios = require('axios');
const config = require('../src/config');
const { getCaspioAccessToken } = require('../src/utils/caspio');

const BASE = config.caspio.apiBaseUrl;
const APPLY = process.argv.includes('--apply');
const REGISTER = 'Payroll_Register';
const EMPLOYEES = 'Employees';

// --- 1. Additive fields on Employees -----------------------------------------
const EMPLOYEE_FIELDS = [
  { Name: 'Payroll_Employee_ID', Type: 'INTEGER', note: 'join key to the payroll packet (6366, 6087, 1000)' },
  { Name: 'Pay_Type', Type: 'STRING', note: 'Hourly | Hourly+Commission | Salary | Salary+Commission' },
  { Name: 'Salary_Per_Period', Type: 'CURRENCY', note: 'salaried staff: wages per pay period, straight off the register' },
  { Name: 'Annual_Salary_Est', Type: 'CURRENCY', note: 'Salary_Per_Period x 26 (computed by the importer)' },
  { Name: 'Pay_Rate_Effective_Date', Type: 'DATE/TIME', note: 'check date the current rate was observed on' },
  { Name: 'Sick_Hours_Used', Type: 'NUMBER', note: 'missing today; the packet reports it' },
  { Name: 'Sick_Hours_Remaining', Type: 'NUMBER', note: 'Sick_Accum_Hours_Available - Sick_Hours_Used' },
  { Name: 'Leave_Balances_As_Of', Type: 'DATE/TIME', note: 'ANTI-DRIFT stamp — makes stale leave numbers visible' },
];

// --- 2. Payroll_Register ------------------------------------------------------
const REGISTER_DEF = {
  Name: REGISTER,
  Fields: [
    { Name: 'Register_Key', Type: 'STRING', Unique: true },   // "6366-20260724" — idempotent re-import
    { Name: 'Payroll_Employee_ID', Type: 'INTEGER' },
    { Name: 'ID_Record_Employee', Type: 'STRING' },           // FK -> Employees
    { Name: 'Employee_Full_Name', Type: 'STRING' },
    { Name: 'Check_Date', Type: 'DATE/TIME' },
    { Name: 'Period_Start', Type: 'DATE/TIME' },
    { Name: 'Period_End', Type: 'DATE/TIME' },
    { Name: 'Check_Number', Type: 'STRING' },
    { Name: 'Paid_This_Period', Type: 'YES/NO' },
    { Name: 'Pay_Type', Type: 'STRING' },
    { Name: 'Pay_Rate', Type: 'CURRENCY' },

    { Name: 'Hours_Regular', Type: 'NUMBER' },
    { Name: 'Hours_Overtime', Type: 'NUMBER' },
    { Name: 'Hours_Sick', Type: 'NUMBER' },
    { Name: 'Hours_Vacation_PTO', Type: 'NUMBER' },
    { Name: 'Hours_Holiday', Type: 'NUMBER' },
    { Name: 'Hours_Total', Type: 'NUMBER' },

    { Name: 'Wages_Regular', Type: 'CURRENCY' },
    { Name: 'Wages_Overtime', Type: 'CURRENCY' },
    { Name: 'Wages_Sick', Type: 'CURRENCY' },
    { Name: 'Wages_Vacation_PTO', Type: 'CURRENCY' },
    { Name: 'Wages_Holiday', Type: 'CURRENCY' },
    { Name: 'Wages_Commissions', Type: 'CURRENCY' },
    { Name: 'Gross_Wages', Type: 'CURRENCY' },

    { Name: 'Ded_Federal_WH', Type: 'CURRENCY' },
    { Name: 'Ded_Social_Security', Type: 'CURRENCY' },
    { Name: 'Ded_Medicare', Type: 'CURRENCY' },
    { Name: 'Ded_State_Other', Type: 'CURRENCY' },
    { Name: 'Ded_WA_FamMed_Leave', Type: 'CURRENCY' },
    { Name: 'Ded_WA_Cares_Fund', Type: 'CURRENCY' },
    { Name: 'Ded_Other', Type: 'CURRENCY' },
    { Name: 'Total_Deductions', Type: 'CURRENCY' },
    { Name: 'Net_Pay', Type: 'CURRENCY' },

    // Leave balances as of this pay date (negatives are REAL — do not clamp)
    { Name: 'Vacation_Accrued', Type: 'NUMBER' },
    { Name: 'Vacation_Used', Type: 'NUMBER' },
    { Name: 'Vacation_Available', Type: 'NUMBER' },
    { Name: 'Sick_Accrued', Type: 'NUMBER' },
    { Name: 'Sick_Used', Type: 'NUMBER' },
    { Name: 'Sick_Available', Type: 'NUMBER' },

    { Name: 'Source_File', Type: 'STRING' },
    { Name: 'Imported_At', Type: 'DATE/TIME' },
  ],
};

async function main() {
  const token = await getCaspioAccessToken();
  const auth = { Authorization: `Bearer ${token}` };
  const H = { headers: { ...auth, 'Content-Type': 'application/json' } };
  console.log(`Mode: ${APPLY ? 'APPLY (writing)' : 'DRY-RUN (no writes)'}\n`);

  // ---- Phase 1: Employees additive fields ----
  console.log(`=== ${EMPLOYEES}: add ${EMPLOYEE_FIELDS.length} fields ===`);
  const existing = (await axios.get(`${BASE}/tables/${EMPLOYEES}/fields`, { headers: auth })).data.Result;
  const have = new Set(existing.map(f => f.Name));
  console.log(`  ${EMPLOYEES} currently has ${existing.length} fields.`);

  for (const f of EMPLOYEE_FIELDS) {
    if (have.has(f.Name)) { console.log(`  = ${f.Name} already exists — skipping`); continue; }
    if (!APPLY) { console.log(`  + would add ${f.Name} (${f.Type}) — ${f.note}`); continue; }
    try {
      await axios.post(`${BASE}/tables/${EMPLOYEES}/fields`, { Name: f.Name, Type: f.Type }, H);
      console.log(`  ✓ added ${f.Name} (${f.Type})`);
    } catch (e) {
      console.log(`  ❌ ${f.Name}: ${e.response ? JSON.stringify(e.response.data) : e.message}`);
    }
  }

  // ---- Phase 2: First_Name UNIQUE is a latent bug (a 2nd "Steve" would fail to insert) ----
  const firstName = existing.find(f => f.Name === 'First_Name');
  if (firstName && firstName.Unique) {
    console.log(`\n=== ${EMPLOYEES}.First_Name: clear UNIQUE (blocks a 2nd employee sharing a first name) ===`);
    if (!APPLY) {
      console.log('  ~ would PUT Unique:false');
    } else {
      try {
        await axios.put(`${BASE}/tables/${EMPLOYEES}/fields/First_Name`, { Unique: false }, H);
        console.log('  ✓ First_Name is no longer unique');
      } catch (e) {
        console.log(`  ⚠ could not clear (uncheck "Unique" on First_Name in the Caspio UI): ${e.response ? JSON.stringify(e.response.data) : e.message}`);
      }
    }
  }

  // ---- Phase 3: Payroll_Register ----
  console.log(`\n=== ${REGISTER}: create (${REGISTER_DEF.Fields.length} fields) ===`);
  let exists = false;
  try { await axios.get(`${BASE}/tables/${REGISTER}/fields`, { headers: auth }); exists = true; } catch (_) {}
  console.log(`  Table ${REGISTER}: ${exists ? 'already exists' : 'does NOT exist'}`);
  if (!exists) {
    if (!APPLY) {
      console.log(`  + would create with Register_Key(unique) + ${REGISTER_DEF.Fields.length - 1} more`);
    } else {
      await axios.post(`${BASE}/tables`, REGISTER_DEF, H);
      console.log('  ✓ table created');
    }
  }

  // ---- Verify ----
  if (APPLY) {
    const emp = (await axios.get(`${BASE}/tables/${EMPLOYEES}/fields`, { headers: auth })).data.Result;
    const added = EMPLOYEE_FIELDS.filter(f => emp.some(x => x.Name === f.Name));
    console.log(`\nVerify — ${EMPLOYEES} now ${emp.length} fields; ${added.length}/${EMPLOYEE_FIELDS.length} new present.`);
    try {
      const reg = (await axios.get(`${BASE}/tables/${REGISTER}/fields`, { headers: auth })).data.Result;
      console.log(`Verify — ${REGISTER} has ${reg.length} fields.`);
    } catch (e) { console.log(`Verify — ${REGISTER} NOT readable: ${e.message}`); }
  }

  console.log(`\n${APPLY ? 'Schema done. Next: node scripts/import-payroll-packet.js --apply' : 'Dry-run only. Re-run with --apply.'}`);
}
main().catch(e => { console.error('FATAL:', e.response ? JSON.stringify(e.response.data) : e.message); process.exit(1); });
