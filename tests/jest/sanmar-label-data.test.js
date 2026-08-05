/**
 * /label-data shared assembly (2026-08-04)
 *
 * The repack station (/pages/box-labels.html) and the receiving sheets (/inbound-today)
 * print through ONE assembly. These tests pin the two things that made the old split
 * dangerous:
 *   1. the ManageOrders → label-field mapping is a single definition (moLabelFields), and
 *   2. the repack rush clock anchors on max(arrival, today) — the runway that REMAINS at
 *      print time — using the SAME workingDaysBetween/threshold as the sheet.
 */
const {
  moLabelFields,
  rushFieldsFor,
  labelRushAnchor,
  workingDaysBetween,
  RUSH_MAX_PRODUCTION_DAYS,
} = require('../../src/routes/sanmar-orders');

describe('moLabelFields: one definition of the label header fields', () => {
  test('maps every ManageOrders header field the label prints', () => {
    expect(moLabelFields({
      date_RequestedToShip: '2026-08-10T00:00:00', date_Ordered: '2026-07-30',
      id_Design: 4812, DesignName: ' Left Chest Logo ',
      ContactFirstName: ' Pat ', ContactLastName: ' Lee ',
      CustomerPurchaseOrder: ' PO-77 ', TermsName: ' Net 30 ',
    })).toEqual({
      dueDate: '2026-08-10', dateOrdered: '2026-07-30',
      designNumber: '4812', designName: 'Left Chest Logo',
      contactName: 'Pat Lee', customerPO: 'PO-77', terms: 'Net 30',
    });
  });

  test('an unmatched work order yields empty strings, never undefined', () => {
    const f = moLabelFields(null);
    for (const v of Object.values(f)) expect(v).toBe('');
  });
});

describe('rushFieldsFor: same rule as the sheet', () => {
  test('3 working days = rush (inclusive), 4 = not', () => {
    expect(rushFieldsFor('2026-08-04', '2026-08-08')).toEqual({
      productionDays: 3, rush: true, pastDue: false, rushThreshold: RUSH_MAX_PRODUCTION_DAYS,
    });
    expect(rushFieldsFor('2026-08-04', '2026-08-10').rush).toBe(false);
  });

  test('missing due date is unknown — never a rush (absent data must not manufacture urgency)', () => {
    expect(rushFieldsFor('2026-08-04', '')).toEqual({
      productionDays: null, rush: false, pastDue: false, rushThreshold: RUSH_MAX_PRODUCTION_DAYS,
    });
  });

  test('due on/before the anchor is pastDue', () => {
    expect(rushFieldsFor('2026-08-04', '2026-08-04').pastDue).toBe(true);
    expect(rushFieldsFor('2026-08-04', '2026-08-03').pastDue).toBe(true);
  });
});

describe('labelRushAnchor: the repack clock starts at print time, never earlier', () => {
  test('blanks landed days ago → anchor is today (runway shrank while they sat)', () => {
    expect(labelRushAnchor('2026-07-30', '2026-08-04')).toBe('2026-08-04');
  });

  test('blanks not fully landed yet → anchor is the arrival day (same as the sheet)', () => {
    expect(labelRushAnchor('2026-08-06', '2026-08-04')).toBe('2026-08-06');
  });

  test('arrival == today → today', () => {
    expect(labelRushAnchor('2026-08-04', '2026-08-04')).toBe('2026-08-04');
  });

  test('missing/malformed arrival → today (never blocks a label)', () => {
    expect(labelRushAnchor('', '2026-08-04')).toBe('2026-08-04');
    expect(labelRushAnchor(null, '2026-08-04')).toBe('2026-08-04');
    expect(labelRushAnchor('not-a-date', '2026-08-04')).toBe('2026-08-04');
  });

  test('an order the sheet called rush on arrival day is AT LEAST as rushed at the station', () => {
    // Arrival Tue 8/4, due Mon 8/10 → 4 days on the sheet (not rush). Printed Thu 8/6 →
    // 2 remaining (rush). The station may only ever be tighter, never looser.
    const onSheet = workingDaysBetween('2026-08-04', '2026-08-10');
    const atStation = workingDaysBetween(labelRushAnchor('2026-08-04', '2026-08-06'), '2026-08-10');
    expect(onSheet).toBe(4);
    expect(atStation).toBe(2);
    expect(atStation).toBeLessThanOrEqual(onSheet);
  });
});
