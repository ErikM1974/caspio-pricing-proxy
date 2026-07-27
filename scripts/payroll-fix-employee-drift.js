#!/usr/bin/env node
/**
 * Repair two defects found by auditing a Caspio CSV export of `Employees` against the
 * 7/24/2026 payroll packet (Erik, 2026-07-27).
 *
 *   node scripts/payroll-fix-employee-drift.js          # dry-run
 *   node scripts/payroll-fix-employee-drift.js --apply  # write + read back
 *
 * 1. FOUR ex-employees have Sick_Accum_Hours_Available = 0 while Sick_Hours_Remaining
 *    still holds the right number — internally contradictory, since remaining was
 *    computed as accrued - used at import time. Restore accrued from the packet and
 *    re-derive remaining so the two agree.
 *
 * 2. TWO salaried staff carry a stale HOURLY rate in `Pay`. Both are provably wrong
 *    against the packet — Jim 51.92 x 40 h = 2,076.80 but he was paid 4,000.00; Nika
 *    23.00 x 80 h = 1,840.00 but she was paid 2,876.54. The importer only writes `Pay`
 *    when the packet prints a rate, so for salaried staff the old value was left behind.
 *    Their real compensation now lives in Pay_Type + Salary_Per_Period + Annual_Salary_Est,
 *    so `Pay` is cleared rather than left holding a number that reads as an hourly rate.
 *    (Clark was already null — nothing to do.)
 *
 * Inactive ex-employees keep their stale `Pay`: they are off the roster, and their last
 * known rate is harmless history rather than something anyone will price work from.
 */
'use strict';
const axios = require('axios');
const config = require('../src/config');
const { getCaspioAccessToken } = require('../src/utils/caspio');

const BASE = config.caspio.apiBaseUrl;
const APPLY = process.argv.includes('--apply');
const TABLE = 'Employees';
const r2 = (n) => Math.round(n * 100) / 100;

// Sick accrued / used exactly as printed on the 7/24/2026 packet (HH:MM -> decimal).
const SICK_FIX = [
  { id: 6380, name: 'Antonio Massey', accrued: 2.9167, used: 0 },
  { id: 6383, name: 'Sanou Pon', accrued: 34.2167, used: 0 },
  { id: 6384, name: 'Sothida Khieve', accrued: 0.8167, used: 0 },
  { id: 6390, name: 'Adriyella Trujillo', accrued: 5.7, used: 0 },
];

// Salaried staff whose `Pay` still holds an hourly rate that the packet contradicts.
const CLEAR_HOURLY = [
  { id: 1000, name: 'Jim Mickelson', stale: 51.92, perPeriod: 4000.00 },
  { id: 6310, name: 'Nika Lao', stale: 23.00, perPeriod: 2876.54 },
];

async function main() {
  const token = await getCaspioAccessToken();
  const auth = { Authorization: `Bearer ${token}` };
  const H = { headers: { ...auth, 'Content-Type': 'application/json' } };
  console.log(`Mode: ${APPLY ? 'APPLY (writing)' : 'DRY-RUN (no writes)'}\n`);

  const put = (id, body) => axios.put(
    `${BASE}/tables/${TABLE}/records?q.where=${encodeURIComponent(`Payroll_Employee_ID=${id}`)}`, body, H);

  console.log('=== 1. Restore sick accrued (accrued was 0 while remaining held the real value) ===');
  for (const f of SICK_FIX) {
    const body = {
      Sick_Accum_Hours_Available: f.accrued,
      Sick_Hours_Used: f.used,
      Sick_Hours_Remaining: r2(f.accrued - f.used),
    };
    if (!APPLY) { console.log(`  would set ${f.name.padEnd(20)} accrued=${f.accrued} used=${f.used} remaining=${r2(f.accrued - f.used)}`); continue; }
    try { await put(f.id, body); console.log(`  ✓ ${f.name}`); }
    catch (e) { console.log(`  ❌ ${f.name}: ${e.response ? JSON.stringify(e.response.data) : e.message}`); }
  }

  console.log('\n=== 2. Clear stale hourly rate on salaried staff ===');
  for (const c of CLEAR_HOURLY) {
    if (!APPLY) {
      console.log(`  would clear ${c.name.padEnd(20)} Pay ${c.stale} -> null  (salary is $${c.perPeriod}/period)`);
      continue;
    }
    try { await put(c.id, { Pay: null }); console.log(`  ✓ ${c.name}: Pay cleared`); }
    catch (e) { console.log(`  ❌ ${c.name}: ${e.response ? JSON.stringify(e.response.data) : e.message}`); }
  }

  if (APPLY) {
    // Read back — a write that reports success but doesn't stick is the failure mode that
    // produced this drift in the first place.
    const ids = [...SICK_FIX, ...CLEAR_HOURLY].map(x => x.id);
    const sel = 'Employee_Full_Name,Payroll_Employee_ID,Pay,Pay_Type,Salary_Per_Period,Sick_Accum_Hours_Available,Sick_Hours_Used,Sick_Hours_Remaining';
    const rows = (await axios.get(`${BASE}/tables/${TABLE}/records?q.select=${sel}&q.pageSize=500&q.orderBy=PK_ID`, { headers: auth })).data.Result;
    console.log('\nVerify — read back from Caspio:');
    let bad = 0;
    for (const row of rows.filter(r => ids.includes(Number(r.Payroll_Employee_ID)))) {
      const id = Number(row.Payroll_Employee_ID);
      const s = SICK_FIX.find(x => x.id === id);
      const c = CLEAR_HOURLY.find(x => x.id === id);
      let verdict = 'ok';
      if (s && Math.abs(Number(row.Sick_Accum_Hours_Available) - s.accrued) > 0.02) { verdict = 'STILL WRONG'; bad++; }
      if (c && row.Pay != null) { verdict = 'STILL WRONG'; bad++; }
      console.log(`  ${String(row.Employee_Full_Name).padEnd(20)} Pay=${row.Pay ?? 'null'} sickAccrued=${row.Sick_Accum_Hours_Available} remaining=${row.Sick_Hours_Remaining}  [${verdict}]`);
    }
    console.log(bad ? `\n⚠ ${bad} value(s) did not stick — investigate before trusting this table.` : '\n✓ every value stuck.');
  }
  console.log(`\n${APPLY ? 'Done.' : 'Dry-run only. Re-run with --apply.'}`);
}
main().catch(e => { console.error('FATAL:', e.response ? JSON.stringify(e.response.data) : e.message); process.exit(1); });
