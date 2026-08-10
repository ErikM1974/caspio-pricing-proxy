// Locks the leave-only reconciliation gate for the payroll uploader.
//
// WHY THIS FILE EXISTS: the "Available Vacation And Sick Time" page used to be uploaded
// through the full-packet reader, whose gate compares the packet's printed money totals to
// the sum of the extracted rows. A leave page prints no money, so the extraction returned 0
// for gross/net/deductions/check-count, the gate compared 0 to 0, and it PASSED — reporting
// success having verified nothing, one click from writing 21 all-zero rows under a guessed
// check date. reconcileLeave() checks all six leave columns against the report's own Total:
// row instead, so there is no free pass. Erik, 2026-08-10.
'use strict';

const payrollRouter = require('../../src/routes/payroll');
const reconcileLeave = payrollRouter._reconcileLeave;

// The page prints HH:MM; the extractor converts to decimal hours at 4dp.
const hm = (h, m) => Math.round((h + m / 60) * 10000) / 10000;

// The real 2026-08-07 report, all 21 employees.
// [name, id, vacAccrued, vacUsed, vacAvail, sickAccrued, sickUsed, sickAvail]
const ROWS = [
  ['MICKELSON JAMES A', 1000, 0, 0, 0, 96, 0, 96],
  ['MICKELSON ERIK J', 6087, 80, 56, 24, hm(109, 24), 0, hm(109, 24)],
  ['NHOUNG RUTH E', 6221, 80, 48, 32, hm(57, 29), 39, hm(18, 29)],
  ['SOM SAVY', 6292, 80, 40, 40, hm(40, 19), hm(39, 15), hm(1, 4)],
  ['SORM SORPHORN', 6295, 112, 64, 48, hm(55, 9), 31, hm(24, 9)],
  ['LAO RATANAKAKNIKA', 6310, 80, 48, 32, hm(54, 18), 16, hm(38, 18)],
  ['HANSON TAYLAR', 6331, 0, 0, 0, 0, 0, 0],
  ['HOEU BUNSEREYTHEAVY', 6333, 80, 88, -8, hm(56, 49), 40, hm(16, 49)],
  ['WRIGHT BRADLEY', 6347, 80, 72, 8, hm(75, 14), 0, hm(75, 14)],
  ['DELAND STEVEN A', 6349, 80, 72, 8, 28, 40, -12],
  ['CHHORN KANHA', 6356, 80, 64, 16, hm(47, 17), 16, hm(31, 17)],
  ['BEARDSLEY BRIAN', 6366, 80, 24, 56, hm(35, 19), 24, hm(11, 19)],
  ['HALLOWELL JOSEPH A', 6372, 80, 44, 36, hm(41, 59), 22, hm(19, 59)],
  ['MEANG SREYANI', 6376, 80, 80, 0, hm(35, 54), 32, hm(3, 54)],
  ['MASSEY ANTONIO', 6380, 0, 0, 0, hm(2, 55), 0, hm(2, 55)],
  ['TANN SOTHEA', 6382, 40, 40, 0, hm(76, 43), hm(50, 30), hm(26, 13)],
  ['PON SANOU', 6383, 0, 0, 0, hm(34, 13), 0, hm(34, 13)],
  ['KHIEV SOTHIDA', 6384, 0, 0, 0, hm(0, 49), 0, hm(0, 49)],
  ['HEDE MIKALAH', 6389, 80, 40, 40, hm(45, 11), hm(31, 45), hm(13, 26)],
  ['TRUJILLO ADRIYELLA', 6390, 0, 0, 0, hm(5, 42), 0, hm(5, 42)],
  // 🔴 The one row where the report does NOT print accrued minus used: 0 accrued, 16 used,
  // available printed as 00:00 rather than -16:00. That single floor is the entire 16-hour
  // gap between the vacation totals (1112 - 796 = 316, but the Total: row prints 332).
  ['CLARK TANEISHA', 6391, 0, 16, 0, hm(38, 26), hm(78, 30), -hm(40, 4)],
];

const employees = ROWS.map(([nameOnPacket, payrollEmployeeId, vacationAccrued, vacationUsed,
  vacationAvailable, sickAccrued, sickUsed, sickAvailable]) => ({
  nameOnPacket, payrollEmployeeId, hoursPerDay: 8,
  vacationAccrued, vacationUsed, vacationAvailable,
  sickAccrued, sickUsed, sickAvailable,
}));

// The report's own Total: row, exactly as printed.
const printedTotals = {
  vacationAccrued: 1112, vacationUsed: 796, vacationAvailable: 332,
  sickAccrued: hm(937, 10), sickUsed: 460, sickAvailable: hm(477, 10),
};

const payload = () => ({
  asOfDate: '2026-08-07',
  employees: employees.map(e => ({ ...e })),
  printedTotals: { ...printedTotals },
});

describe('payroll leave-only reconciliation', () => {
  test('the real 2026-08-07 report reconciles against its own Total: row', () => {
    const rec = reconcileLeave(payload());
    expect(rec.checks).toHaveLength(6);
    expect(rec.checks.filter(c => !c.ok)).toEqual([]);
    expect(rec.rowIssues).toEqual([]);
    expect(rec.passed).toBe(true);
  });

  test('every check is a leave column — no money check to pass vacuously', () => {
    const rec = reconcileLeave(payload());
    expect(rec.checks.every(c => c.unit === 'hours')).toBe(true);
    expect(rec.checks.map(c => c.label)).toEqual([
      'Vacation accrued', 'Vacation used', 'Vacation available',
      'Sick accrued', 'Sick used', 'Sick available',
    ]);
    // The gate must compare against a printed figure, not against zero.
    expect(rec.checks.every(c => c.printed !== 0)).toBe(true);
  });

  test('an over-drawn balance the report floors at zero is a note, not a failure', () => {
    const rec = reconcileLeave(payload());
    expect(rec.passed).toBe(true); // still saveable
    expect(rec.notes).toHaveLength(1);
    expect(rec.notes[0]).toContain('CLARK TANEISHA');
    expect(rec.notes[0]).toContain('vacation available');
  });

  test('a misread row fails the gate even when the printed totals are right', () => {
    const p = payload();
    p.employees[4].vacationAccrued = 12; // SORM SORPHORN, 112 misread as 12
    const rec = reconcileLeave(p);
    expect(rec.passed).toBe(false);
    const failed = rec.checks.filter(c => !c.ok).map(c => c.label);
    expect(failed).toContain('Vacation accrued');
  });

  test('negative balances are carried through, never clamped', () => {
    const rec = reconcileLeave(payload());
    expect(rec.passed).toBe(true);
    // Hoeu -8 vacation and Deland -12 / Clark -40.0667 sick are all real balances; if any
    // were clamped to zero the available columns would no longer hit the printed totals.
    const avail = rec.checks.find(c => c.label === 'Sick available');
    expect(avail.derived).toBeCloseTo(hm(477, 10), 1);
  });

  test('an empty extraction is refused rather than reported as a clean read', () => {
    const rec = reconcileLeave({ asOfDate: '2026-08-07', employees: [], printedTotals });
    expect(rec.passed).toBe(false);
    expect(rec.rowIssues).toContain('no employees extracted');
  });

  test('duplicate employee IDs are refused — a doubled row would overwrite a balance', () => {
    const p = payload();
    p.employees[1].payrollEmployeeId = p.employees[0].payrollEmployeeId;
    const rec = reconcileLeave(p);
    expect(rec.passed).toBe(false);
    expect(rec.rowIssues.join(' ')).toMatch(/duplicate/i);
  });
});
