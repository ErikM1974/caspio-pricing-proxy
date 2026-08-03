#!/usr/bin/env node
/**
 * add-vacation-entitlement-field.js — adds `Vacation_Annual_Entitlement` to the Caspio
 * `Employees` table and seeds it for the active roster. Erik, 2026-08-03.
 *
 * WHY THIS FIELD EXISTS
 * Payroll books hours to the tax year of the CHECK date. Vacation taken in the final pay
 * period of a year is paid on a January check, so it lands in the new payroll year — and
 * to pay it, the prior year's balance is carried forward. Both accrued and used come in
 * inflated by that carryover and cancel:
 *
 *   Sorphorn Sorm 2026: 112 accrued / 56 used / 56 remaining
 *     112 = 80 (the 2026 grant) + 32 carried in
 *      56 = 24 (real 2026 use)  + 32 the same
 *
 * Her slip must read 80 / 24 / 56. Deriving that needs the real annual grant, which the
 * packet never states — hence a hand-maintained column.
 *
 * 🔴 IT MUST BE ITS OWN COLUMN. `POST /api/payroll/import` overwrites
 * Vacation_Hours_Available, _Used and _Remaining on every Friday packet. Storing the
 * entitlement in any of them destroys it on the next import and silently reverts Sorphorn
 * to 112. `Vacation_Eligible_Hours` is not a substitute either — it is populated only for
 * staff not yet vested (Taneisha Clark alone today) and is blank for everyone else.
 *
 * USAGE
 *   node scripts/add-vacation-entitlement-field.js            # dry run (default)
 *   node scripts/add-vacation-entitlement-field.js --apply    # actually write
 *   node scripts/add-vacation-entitlement-field.js --apply --field-only   # schema, no seed
 *
 * Re-runnable: the field is created only if absent, and seeding writes only where the
 * stored value differs. Existing values are NOT overwritten unless --force is passed —
 * Erik maintains this column by hand and a re-run must not stomp his edits.
 */
'use strict';
require('dotenv').config();
const axios = require('axios');
const config = require('../src/config');
const { getCaspioAccessToken } = require('../src/utils/caspio');

const BASE = config.caspio.apiBaseUrl;
const TABLE = 'Employees';
const FIELD = 'Vacation_Annual_Entitlement';

const APPLY = process.argv.includes('--apply');
const FIELD_ONLY = process.argv.includes('--field-only');
const FORCE = process.argv.includes('--force');

/**
 * The active roster as confirmed with Erik on 2026-08-03, keyed by payroll ID because
 * names drift (Ruthie/Ruth, MICKELSON JAMES/Jim Mickelson) and First_Name is UNIQUE for
 * unrelated auth reasons. This seeds Caspio ONCE; Caspio is the source of truth from then
 * on and the dashboard reads it live. Nothing in the app hardcodes these numbers.
 */
const SEED = [
  { id: 6347, name: 'Bradley Wright', hours: 80 },
  { id: 6366, name: 'Brian Beardsley', hours: 80 },
  { id: 6333, name: 'Bunsereytheavy Hoeu', hours: 80 },
  { id: 6087, name: 'Erik Mickelson', hours: 80 },
  { id: 6372, name: 'Joseph Hallowell', hours: 80 },
  { id: 6356, name: 'Kanha Chhorn', hours: 80 },
  { id: 6389, name: 'Mikalah Hede', hours: 80 },
  { id: 6310, name: 'Nika Lao', hours: 80 },
  { id: 6221, name: 'Ruthie Nhoung', hours: 80 },
  { id: 6292, name: 'Savy Som', hours: 80 },
  { id: 6295, name: 'Sorphorn Sorm', hours: 80 },   // 112 imported = 80 + 32 carryover
  { id: 6376, name: 'Sreyani Meang', hours: 80 },
  { id: 6349, name: 'Steve Deland', hours: 80 },
  { id: 6382, name: 'Sothea Tann', hours: 40 },     // full annual grant, NOT partial-year (Erik 2026-08-03)
  // Not vacation-eligible until 2026-08-12. The dashboard reads the entitlement as 0 for
  // any as-of date before Vacation_Eligible_Date, so seeding her post-anniversary grant
  // here is correct and needs no edit on the day.
  { id: 6391, name: 'Taneisha Clark', hours: 40 },
  { id: 1000, name: 'Jim Mickelson', hours: 0 },    // salaried, no tracked vacation
];

const log = (...a) => console.log(...a);

async function main() {
  log(`\n${APPLY ? '🔴 APPLY' : '🔍 DRY RUN'} — ${FIELD} on ${TABLE}`);
  if (!APPLY) log('   (nothing will be written; re-run with --apply)\n');

  const token = await getCaspioAccessToken();
  const H = { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } };

  // ---------------------------------------------------------------- 1. the field
  const fields = (await axios.get(`${BASE}/tables/${TABLE}/fields`, H)).data.Result || [];
  const existing = fields.find((f) => f.Name === FIELD);

  if (existing) {
    log(`✓ field already exists — ${FIELD} [${existing.Type}]`);
    if (existing.Type !== 'NUMBER') {
      log(`🔴 WRONG TYPE: expected NUMBER, found ${existing.Type}. Fix in Caspio before seeding.`);
      process.exit(1);
    }
  } else {
    log(`+ CREATE ${FIELD} (NUMBER, nullable — blank must stay distinguishable from 0,`);
    log('          because blank blocks the slip while 0 is a legitimate entitlement)');
    if (APPLY) {
      await axios.post(`${BASE}/tables/${TABLE}/fields`, {
        Name: FIELD,
        Type: 'NUMBER',
        Unique: false,
        Label: 'Vacation Annual Entitlement',
        Description: 'Hand-maintained annual vacation grant in hours. NOT written by the '
          + 'payroll import. The slip subtracts (Vacation_Hours_Available - this) as the '
          + 'prior-year carryover. Blank = no slip prints for this employee.',
      }, H);
      log('  ✓ created');
    }
  }

  if (FIELD_ONLY) { log('\n--field-only: skipping the seed.'); return; }

  // ---------------------------------------------------------------- 2. the seed
  const q = new URLSearchParams({
    'q.select': `ID_Record_Employee,Payroll_Employee_ID,Employee_Full_Name,Status,${existing ? FIELD : 'PK_ID'}`,
    'q.pageSize': '500', 'q.orderBy': 'PK_ID',
  });
  const rows = (await axios.get(`${BASE}/tables/${TABLE}/records?${q}`, H)).data.Result || [];

  const byPayrollId = new Map();
  for (const r of rows) {
    const id = Number(r.Payroll_Employee_ID);
    if (id) byPayrollId.set(id, r);
  }

  // Abort rather than half-seed: a roster the script doesn't recognise means the seed list
  // is stale, and a missed employee silently loses their slip.
  const missing = SEED.filter((s) => !byPayrollId.has(s.id));
  if (missing.length) {
    log('\n🔴 these seed entries have no Employees row:');
    missing.forEach((m) => log(`   ${m.id} ${m.name}`));
    process.exit(1);
  }

  const seeded = new Set(SEED.map((s) => s.id));
  const unseeded = rows.filter((r) => r.Status === true && !seeded.has(Number(r.Payroll_Employee_ID)));
  if (unseeded.length) {
    log('\n⚠ ACTIVE employees not in the seed list — they will get NO SLIP until set:');
    unseeded.forEach((r) => log(`   ${r.Payroll_Employee_ID || '(no payroll id)'} ${r.Employee_Full_Name}`));
  }

  log('\n  payroll  employee                        stored -> seed');
  let writes = 0, skips = 0;
  for (const s of SEED) {
    const row = byPayrollId.get(s.id);
    const stored = existing ? row[FIELD] : null;
    const isBlank = stored === null || stored === undefined || stored === '';
    const same = !isBlank && Number(stored) === s.hours;

    if (same) { log(`  ${s.id}  ${s.name.padEnd(28)}  ${s.hours} (unchanged)`); skips++; continue; }
    if (!isBlank && !FORCE) {
      log(`  ${s.id}  ${s.name.padEnd(28)}  ${stored} -> ${s.hours}  ⚠ SKIPPED (hand-set; use --force)`);
      skips++;
      continue;
    }

    log(`  ${s.id}  ${s.name.padEnd(28)}  ${isBlank ? 'blank' : stored} -> ${s.hours}`);
    if (APPLY) {
      const where = encodeURIComponent(`ID_Record_Employee='${String(row.ID_Record_Employee).replace(/'/g, "''")}'`);
      await axios.put(`${BASE}/tables/${TABLE}/records?q.where=${where}`, { [FIELD]: s.hours }, H);
    }
    writes++;
  }

  log(`\n${APPLY ? 'wrote' : 'would write'} ${writes}, left ${skips} alone.`);

  // ---------------------------------------------------------------- 3. read back
  if (APPLY && writes) {
    const verify = (await axios.get(`${BASE}/tables/${TABLE}/records?${new URLSearchParams({
      'q.select': `Payroll_Employee_ID,Employee_Full_Name,${FIELD}`,
      'q.where': 'Status=1', 'q.pageSize': '500', 'q.orderBy': 'PK_ID',
    })}`, H)).data.Result || [];
    const bad = verify.filter((r) => {
      const want = SEED.find((s) => s.id === Number(r.Payroll_Employee_ID));
      return want && Number(r[FIELD]) !== want.hours;
    });
    log(bad.length
      ? `🔴 READ-BACK MISMATCH on ${bad.length}: ` + bad.map((b) => b.Employee_Full_Name).join(', ')
      : `✓ read back ${verify.length} active rows — every seeded value matches.`);
    if (bad.length) process.exit(1);
  }

  if (!APPLY) log('\nRe-run with --apply to write.');
}

main().catch((e) => {
  console.error('FAILED:', e.response ? JSON.stringify(e.response.data) : e.message);
  process.exit(1);
});
