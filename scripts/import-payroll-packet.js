#!/usr/bin/env node
/**
 * Import a NW Regional Accounting payroll packet -> `Payroll_Register` (+ refresh the
 * CURRENT-state columns on `Employees`).  Erik, 2026-07-27.
 *
 *   node scripts/import-payroll-packet.js          # dry-run (prints every write + checksums)
 *   node scripts/import-payroll-packet.js --apply  # write
 *
 * Run scripts/create-payroll-register-table.js first (schema).
 *
 * Packet loaded here: Pay 15 — check date 7/24/2026, period 7/6–7/19/2026.
 * Source PDF is a SCAN with no text layer, so the figures below were read visually and
 * then proven against the packet's own totals. The CHECKS block below re-proves them on
 * every run and ABORTS on mismatch — never let unreconciled payroll numbers reach Caspio.
 *
 * Grain: one row per employee per pay date. 21 employees are on the leave report but only
 * 16 had checks, so `Paid_This_Period` distinguishes them and leave balances ride along.
 *
 * Leave hours are HH:MM in the packet and CAN BE NEGATIVE (Clark sick -33:52). They are
 * stored as decimal hours; negatives are real and must not be clamped.
 */
'use strict';
const axios = require('axios');
const config = require('../src/config');
const { getCaspioAccessToken } = require('../src/utils/caspio');

const BASE = config.caspio.apiBaseUrl;
const APPLY = process.argv.includes('--apply');
const REGISTER = 'Payroll_Register';
const EMPLOYEES = 'Employees';

const CHECK_DATE = '2026-07-24';
const PERIOD_START = '2026-07-06';
const PERIOD_END = '2026-07-19';
const CHECK_NUMBER = 'DD260724';
const SOURCE_FILE = 'NORTHWEST EMBROIDERY INC. (40).pdf';

// HH:MM -> decimal hours, sign-aware ("-33:52" -> -33.8667)
const hm = (s) => {
  const neg = String(s).trim().startsWith('-');
  const [h, m] = String(s).replace('-', '').split(':').map(Number);
  const v = h + m / 60;
  return Math.round((neg ? -v : v) * 10000) / 10000;
};

// first/last EXACTLY as they appear in Caspio Employees (payroll spells several differently:
// packet "MICKELSON JAMES" = Caspio "Jim Mickelson"; "LAO RATANAKAKNIKA" = "Nika Lao";
// "KHIEV SOTHIDA" = "Sothida Khieve"; "NHOUNG RUTH" = "Ruthie Nhoung").
const ROWS = [
  { id: 6366, first: 'Brian', last: 'Beardsley', payType: 'Hourly', rate: 25.75, paid: true,
    hrsReg: 78.75, wReg: 2027.81, gross: 2027.81,
    fed: 199.00, ss: 125.72, med: 29.40, so: 7.29, fml: 16.43, cares: 11.76, ded: 389.60, net: 1638.21,
    vac: ['80:00', '24:00', '56:00'], sick: ['33:22', '24:00', '09:22'] },

  { id: 6356, first: 'Kanha', last: 'Chhorn', payType: 'Hourly', rate: 23.00, paid: true,
    hrsReg: 59.50, wReg: 1368.50, gross: 1368.50,
    fed: 0, ss: 84.85, med: 19.84, so: 9.38, fml: 11.08, cares: 7.94, ded: 133.09, net: 1235.41,
    vac: ['80:00', '64:00', '16:00'], sick: ['46:03', '16:00', '30:03'] },

  { id: 6391, first: 'Taneisha', last: 'Clark', payType: 'Salary+Commission', salary: 2423.08, paid: true,
    hrsReg: 80.00, wReg: 2423.08, wComm: 785.61, gross: 3208.69,
    fed: 366.00, ss: 198.94, med: 46.53, so: 7.40, fml: 25.99, cares: 18.61, ded: 663.47, net: 2545.22,
    vac: ['00:00', '16:00', '00:00'], sick: ['36:38', '70:30', '-33:52'] },

  { id: 6349, first: 'Steve', last: 'Deland', payType: 'Hourly', rate: 34.90, paid: true,
    hrsReg: 72.00, wReg: 2512.80, hrsSick: 8.00, wSick: 279.20, gross: 2792.00,
    fed: 302.00, ss: 173.10, med: 40.48, so: 6.66, fml: 22.62, cares: 16.19, ded: 561.05, net: 2230.95,
    vac: ['80:00', '72:00', '08:00'], sick: ['26:00', '40:00', '-14:00'] },

  { id: 6372, first: 'Joseph', last: 'Hallowell', payType: 'Hourly', rate: 21.50, paid: true,
    hrsReg: 77.00, wReg: 1655.50, gross: 1655.50,
    fed: 155.00, ss: 102.64, med: 24.00, so: 7.13, fml: 13.41, cares: 9.60, ded: 311.78, net: 1343.72,
    vac: ['40:00', '44:00', '-04:00'], sick: ['40:12', '22:00', '18:12'] },

  { id: 6389, first: 'Mikalah', last: 'Hede', payType: 'Hourly', rate: 22.50, paid: true,
    hrsReg: 80.00, wReg: 1800.00, hrsOT: 1.00, wOT: 33.75, gross: 1833.75,
    fed: 136.00, ss: 113.69, med: 26.59, so: 12.77, fml: 14.85, cares: 10.64, ded: 314.54, net: 1519.21,
    vac: ['80:00', '40:00', '40:00'], sick: ['43:12', '31:45', '11:27'] },

  { id: 6333, first: 'Bunsereytheavy', last: 'Hoeu', payType: 'Hourly', rate: 19.00, paid: true,
    hrsReg: 69.50, wReg: 1320.50, hrsSick: 8.00, wSick: 152.00, gross: 1472.50,
    fed: 0, ss: 91.30, med: 21.35, so: 10.96, fml: 11.93, cares: 8.54, ded: 144.08, net: 1328.42,
    vac: ['80:00', '88:00', '-08:00'], sick: ['55:26', '16:00', '39:26'] },

  { id: 6310, first: 'Nika', last: 'Lao', payType: 'Salary+Commission', salary: 2876.54, paid: true,
    hrsReg: 80.00, wReg: 2876.54, wComm: 231.22, gross: 3107.76,
    fed: 417.00, ss: 192.68, med: 45.06, so: 7.40, fml: 25.17, cares: 18.03, ded: 705.34, net: 2402.42,
    vac: ['80:00', '40:00', '40:00'], sick: ['52:30', '16:00', '36:30'] },

  // ⚠ Caspio First_Name is "Sreynai" but its own Employee_Full_Name says "Sreyani Meang",
  // and the payroll packet says SREYANI — i.e. First_Name is a transposition typo. Matching
  // the stored value so the import works; flagged for Erik rather than renaming a person here.
  { id: 6376, first: 'Sreynai', last: 'Meang', payType: 'Hourly', rate: 18.00, paid: true,
    hrsReg: 80.00, wReg: 1440.00, gross: 1440.00,
    fed: 70.00, ss: 89.28, med: 20.88, so: 12.62, fml: 11.66, cares: 8.35, ded: 212.79, net: 1227.21,
    vac: ['80:00', '80:00', '00:00'], sick: ['33:56', '32:00', '01:56'] },

  { id: 6087, first: 'Erik', last: 'Mickelson', payType: 'Hourly+Commission', rate: 25.00, paid: true,
    hrsReg: 64.00, wReg: 1600.00, hrsVac: 16.00, wVac: 400.00, wComm: 3500.00, gross: 5500.00,
    fed: 1016.00, ss: 341.00, med: 79.75, so: 6.10, fml: 44.55, cares: 31.90, ded: 1519.30, net: 3980.70,
    vac: ['80:00', '56:00', '24:00'], sick: ['107:24', '00:00', '107:24'] },

  { id: 6221, first: 'Ruthie', last: 'Nhoung', payType: 'Hourly', rate: 34.00, paid: true,
    hrsReg: 80.00, wReg: 2720.00, gross: 2720.00,
    fed: 332.00, ss: 168.64, med: 39.44, so: 12.62, fml: 22.03, cares: 15.78, ded: 590.51, net: 2129.49,
    vac: ['80:00', '40:00', '40:00'], sick: ['55:53', '31:00', '24:53'] },

  { id: 6292, first: 'Savy', last: 'Som', payType: 'Hourly', rate: 19.00, paid: true,
    hrsReg: 56.00, wReg: 1064.00, hrsVac: 24.00, wVac: 456.00, gross: 1520.00,
    fed: 200.00, ss: 94.24, med: 22.04, so: 8.83, fml: 12.31, cares: 8.82, ded: 346.24, net: 1173.76,
    vac: ['80:00', '40:00', '40:00'], sick: ['38:19', '39:15', '-00:56'] },

  { id: 6295, first: 'Sorphorn', last: 'Sorm', payType: 'Hourly', rate: 19.00, paid: true,
    hrsReg: 72.00, wReg: 1368.00, hrsVac: 8.00, wVac: 152.00, gross: 1520.00,
    fed: 99.00, ss: 94.24, med: 22.04, so: 11.35, fml: 12.31, cares: 8.82, ded: 247.76, net: 1272.24,
    vac: ['112:00', '56:00', '56:00'], sick: ['53:21', '31:00', '22:21'] },

  { id: 6382, first: 'Sothea', last: 'Tann', payType: 'Hourly', rate: 17.50, paid: true,
    hrsReg: 40.00, wReg: 700.00, hrsVac: 40.00, wVac: 700.00, gross: 1400.00,
    fed: 16.00, ss: 86.80, med: 20.30, so: 6.31, fml: 11.34, cares: 8.12, ded: 148.87, net: 1251.13,
    vac: ['40:00', '40:00', '00:00'], sick: ['74:55', '42:30', '32:25'] },

  { id: 6347, first: 'Bradley', last: 'Wright', payType: 'Hourly', rate: 42.09, paid: true,
    hrsReg: 32.00, wReg: 1346.88, hrsVac: 48.00, wVac: 2020.32, gross: 3367.20,
    fed: 474.00, ss: 208.77, med: 48.82, so: 2.96, fml: 27.27, cares: 19.53, ded: 781.35, net: 2585.85,
    vac: ['80:00', '72:00', '08:00'], sick: ['73:14', '00:00', '73:14'] },

  { id: 1000, first: 'Jim', last: 'Mickelson', payType: 'Salary', salary: 4000.00, paid: true,
    hrsReg: 40.00, wReg: 4000.00, gross: 4000.00,
    fed: 540.00, ss: 248.00, med: 58.00, so: 0, fml: 32.40, cares: 23.20, ded: 901.60, net: 3098.40,
    vac: ['00:00', '00:00', '00:00'], sick: ['95:00', '00:00', '95:00'] },

  // --- On the leave report, NO check this period. Pay/rate deliberately NOT touched. ---
  { id: 6331, first: 'Taylar', last: 'Hanson', paid: false, vac: ['00:00', '00:00', '00:00'], sick: ['00:00', '00:00', '00:00'] },
  { id: 6380, first: 'Antonio', last: 'Massey', paid: false, vac: ['00:00', '00:00', '00:00'], sick: ['02:55', '00:00', '02:55'] },
  { id: 6383, first: 'Sanou', last: 'Pon', paid: false, vac: ['00:00', '00:00', '00:00'], sick: ['34:13', '00:00', '34:13'] },
  // ⚠ Caspio Last_Name "Khiev" (matches the payroll packet) but Employee_Full_Name says
  // "Sothida Khieve" — one of the two carries a stray 'e'. Flagged, not guessed.
  { id: 6384, first: 'Sothida', last: 'Khiev', paid: false, vac: ['00:00', '00:00', '00:00'], sick: ['00:49', '00:00', '00:49'] },
  { id: 6390, first: 'Adriyella', last: 'Trujillo', paid: false, vac: ['00:00', '00:00', '00:00'], sick: ['05:42', '00:00', '05:42'] },
];

// Packet's own printed totals — the extraction must reproduce these EXACTLY or we abort.
const CHECKS = {
  grossWages: 38933.71, netPayroll: 30962.34, checkCount: 16,
  hoursRegular: 1060.75, wagesRegular: 30223.61,
  wagesCommissions: 4516.83, hoursSick: 16.00, wagesSick: 431.20,
  hoursOvertime: 1.00, wagesOvertime: 33.75, hoursVacation: 136.00, wagesVacation: 3728.32,
  fed: 4322.00, ss: 2413.89, med: 564.52, so: 129.78, fml: 315.35, cares: 225.83, totalDed: 7971.37,
  vacAccrued: 1072.00, vacUsed: 772.00, vacAvailable: 316.00,
};

const r2 = (n) => Math.round(n * 100) / 100;
const sum = (f) => r2(ROWS.reduce((a, x) => a + (f(x) || 0), 0));

function reconcile() {
  const got = {
    grossWages: sum(x => x.gross), netPayroll: sum(x => x.net), checkCount: ROWS.filter(x => x.paid).length,
    hoursRegular: sum(x => x.hrsReg), wagesRegular: sum(x => x.wReg),
    wagesCommissions: sum(x => x.wComm), hoursSick: sum(x => x.hrsSick), wagesSick: sum(x => x.wSick),
    hoursOvertime: sum(x => x.hrsOT), wagesOvertime: sum(x => x.wOT),
    hoursVacation: sum(x => x.hrsVac), wagesVacation: sum(x => x.wVac),
    fed: sum(x => x.fed), ss: sum(x => x.ss), med: sum(x => x.med), so: sum(x => x.so),
    fml: sum(x => x.fml), cares: sum(x => x.cares), totalDed: sum(x => x.ded),
    vacAccrued: sum(x => hm(x.vac[0])), vacUsed: sum(x => hm(x.vac[1])), vacAvailable: sum(x => hm(x.vac[2])),
  };
  const bad = [];
  for (const [k, want] of Object.entries(CHECKS)) {
    if (Math.abs(got[k] - want) > 0.005) bad.push(`  ✗ ${k}: extracted ${got[k]} vs packet ${want}`);
  }
  // Every row must also self-balance: gross - deductions = net
  for (const x of ROWS.filter(r => r.paid)) {
    if (Math.abs(r2(x.gross - x.ded) - x.net) > 0.005) bad.push(`  ✗ ${x.first} ${x.last}: ${x.gross} - ${x.ded} != ${x.net}`);
  }
  return { got, bad };
}

async function main() {
  console.log(`Mode: ${APPLY ? 'APPLY (writing)' : 'DRY-RUN (no writes)'}`);
  console.log(`Packet: ${SOURCE_FILE} — check date ${CHECK_DATE}, period ${PERIOD_START}..${PERIOD_END}\n`);

  // ---- Gate 1: the extraction must reconcile to the packet ----
  const { got, bad } = reconcile();
  console.log('=== Reconciliation against the packet\'s printed totals ===');
  console.log(`  gross ${got.grossWages} | net ${got.netPayroll} | checks ${got.checkCount} | deductions ${got.totalDed}`);
  console.log(`  vacation accrued/used/avail ${got.vacAccrued}/${got.vacUsed}/${got.vacAvailable}`);
  if (bad.length) { console.error('\nABORT — extraction does not match the packet:\n' + bad.join('\n')); process.exit(1); }
  console.log(`  ✓ all ${Object.keys(CHECKS).length} totals + ${ROWS.filter(r => r.paid).length} per-row gross-ded=net checks pass\n`);

  const token = await getCaspioAccessToken();
  const auth = { Authorization: `Bearer ${token}` };
  const H = { headers: { ...auth, 'Content-Type': 'application/json' } };

  // ---- Gate 2: resolve every payroll row to exactly ONE Employees record ----
  const emps = (await axios.get(
    `${BASE}/tables/${EMPLOYEES}/records?q.select=PK_ID,ID_Record_Employee,First_Name,Last_Name,Employee_Full_Name&q.pageSize=500&q.orderBy=PK_ID`,
    { headers: auth })).data.Result;
  const key = (f, l) => `${String(f).trim().toLowerCase()}|${String(l).trim().toLowerCase()}`;
  const index = new Map();
  emps.forEach(e => { const k = key(e.First_Name, e.Last_Name); index.set(k, (index.get(k) || []).concat(e)); });

  console.log('=== Employee resolution ===');
  const unresolved = [];
  const seenIds = new Set();
  for (const row of ROWS) {
    const hits = index.get(key(row.first, row.last)) || [];
    if (hits.length !== 1) { unresolved.push(`  ✗ ${row.first} ${row.last} (payroll #${row.id}) matched ${hits.length} Employees rows`); continue; }
    if (seenIds.has(row.id)) { unresolved.push(`  ✗ duplicate payroll id ${row.id}`); continue; }
    seenIds.add(row.id);
    row._emp = hits[0];
  }
  if (unresolved.length) { console.error('ABORT — cannot map payroll to Employees:\n' + unresolved.join('\n')); process.exit(1); }
  console.log(`  ✓ all ${ROWS.length} payroll employees resolved to a unique Employees record\n`);

  // ---- Write register rows ----
  console.log(`=== ${REGISTER}: ${ROWS.length} rows (upsert by Register_Key) ===`);
  const stamp = `${CHECK_DATE} 00:00:00`;
  let wrote = 0;
  for (const x of ROWS) {
    const rec = {
      Register_Key: `${x.id}-${CHECK_DATE.replace(/-/g, '')}`,
      Payroll_Employee_ID: x.id,
      ID_Record_Employee: x._emp.ID_Record_Employee,
      Employee_Full_Name: x._emp.Employee_Full_Name || `${x._emp.First_Name} ${x._emp.Last_Name}`,
      Check_Date: CHECK_DATE, Period_Start: PERIOD_START, Period_End: PERIOD_END,
      Check_Number: x.paid ? CHECK_NUMBER : '', Paid_This_Period: !!x.paid,
      Pay_Type: x.payType || '', Pay_Rate: x.rate || 0,
      Hours_Regular: x.hrsReg || 0, Hours_Overtime: x.hrsOT || 0, Hours_Sick: x.hrsSick || 0,
      Hours_Vacation_PTO: x.hrsVac || 0, Hours_Holiday: x.hrsHol || 0,
      Hours_Total: r2((x.hrsReg || 0) + (x.hrsOT || 0) + (x.hrsSick || 0) + (x.hrsVac || 0) + (x.hrsHol || 0)),
      Wages_Regular: x.wReg || 0, Wages_Overtime: x.wOT || 0, Wages_Sick: x.wSick || 0,
      Wages_Vacation_PTO: x.wVac || 0, Wages_Holiday: x.wHol || 0, Wages_Commissions: x.wComm || 0,
      Gross_Wages: x.gross || 0,
      Ded_Federal_WH: x.fed || 0, Ded_Social_Security: x.ss || 0, Ded_Medicare: x.med || 0,
      Ded_State_Other: x.so || 0, Ded_WA_FamMed_Leave: x.fml || 0, Ded_WA_Cares_Fund: x.cares || 0,
      Ded_Other: 0, Total_Deductions: x.ded || 0, Net_Pay: x.net || 0,
      Vacation_Accrued: hm(x.vac[0]), Vacation_Used: hm(x.vac[1]), Vacation_Available: hm(x.vac[2]),
      Sick_Accrued: hm(x.sick[0]), Sick_Used: hm(x.sick[1]), Sick_Available: hm(x.sick[2]),
      Source_File: SOURCE_FILE, Imported_At: stamp,
    };
    if (!APPLY) {
      console.log(`  would upsert ${rec.Register_Key.padEnd(14)} ${String(rec.Employee_Full_Name).padEnd(22)} `
        + `${x.paid ? `net $${x.net}` : 'no check'} | vac ${rec.Vacation_Available} sick ${rec.Sick_Available}`);
      continue;
    }
    try {
      try { await axios.post(`${BASE}/tables/${REGISTER}/records`, rec, H); }
      catch (_) {
        const { Register_Key, ...upd } = rec;
        await axios.put(`${BASE}/tables/${REGISTER}/records?q.where=${encodeURIComponent(`Register_Key='${Register_Key}'`)}`, upd, H);
      }
      wrote++; console.log(`  ✓ ${rec.Register_Key} ${rec.Employee_Full_Name}`);
    } catch (e) { console.log(`  ❌ ${rec.Register_Key}: ${e.response ? JSON.stringify(e.response.data) : e.message}`); }
  }

  // ---- Refresh Employees CURRENT state ----
  console.log(`\n=== ${EMPLOYEES}: refresh current rate + leave (${ROWS.length} rows) ===`);
  for (const x of ROWS) {
    const upd = {
      Payroll_Employee_ID: x.id,
      Vacation_Hours_Available: hm(x.vac[0]),          // Caspio "Available" == packet "Accum."
      Vacation_Hours_Used: hm(x.vac[1]),               // Vacation_Hours_Remaining is a formula off these two
      Sick_Accum_Hours_Available: hm(x.sick[0]),
      Sick_Hours_Used: hm(x.sick[1]),
      Sick_Hours_Remaining: r2(hm(x.sick[0]) - hm(x.sick[1])),
      Leave_Balances_As_Of: CHECK_DATE,
    };
    // Only touch pay where the packet actually states it (the 5 unpaid keep their existing Pay).
    if (x.paid) {
      upd.Pay_Type = x.payType;
      upd.Pay_Rate_Effective_Date = CHECK_DATE;
      if (x.rate) upd.Pay = x.rate;
      if (x.salary) { upd.Salary_Per_Period = x.salary; upd.Annual_Salary_Est = r2(x.salary * 26); }
    }
    if (!APPLY) {
      console.log(`  would update ${String(x._emp.Employee_Full_Name).padEnd(22)} `
        + `${x.paid ? `${x.payType} ${x.rate ? '$' + x.rate + '/hr' : '$' + x.salary + '/period'}` : 'leave only (no check)'}`);
      continue;
    }
    try {
      await axios.put(`${BASE}/tables/${EMPLOYEES}/records?q.where=${encodeURIComponent(`ID_Record_Employee='${x._emp.ID_Record_Employee}'`)}`, upd, H);
      console.log(`  ✓ ${x._emp.Employee_Full_Name}`);
    } catch (e) { console.log(`  ❌ ${x._emp.Employee_Full_Name}: ${e.response ? JSON.stringify(e.response.data) : e.message}`); }
  }

  if (APPLY) {
    const back = (await axios.get(`${BASE}/tables/${REGISTER}/records?q.select=Net_Pay,Gross_Wages&q.pageSize=500`, { headers: auth })).data.Result;
    const net = r2(back.reduce((a, r) => a + Number(r.Net_Pay || 0), 0));
    const grs = r2(back.reduce((a, r) => a + Number(r.Gross_Wages || 0), 0));
    console.log(`\nVerify — ${REGISTER} holds ${back.length} rows; net $${net} (packet $${CHECKS.netPayroll}), gross $${grs} (packet $${CHECKS.grossWages})`);
    console.log(net === CHECKS.netPayroll && grs === CHECKS.grossWages ? '  ✓ round-trips to the packet' : '  ⚠ MISMATCH — investigate before trusting');
    console.log(`\nWrote ${wrote}/${ROWS.length} register rows.`);
  }
  console.log(`\n${APPLY ? 'Done.' : 'Dry-run only. Re-run with --apply.'}`);
}
main().catch(e => { console.error('FATAL:', e.response ? JSON.stringify(e.response.data) : e.message); process.exit(1); });
