/**
 * SanMar inbound — a physically-arriving box must never fall off the receiving worklist.
 *
 * Both rules here were found by reconciling SanMar's 7/24/2026 freight manifest
 * (DEC-006920) against the Daily Inbound Report. Ten of twelve POs matched line for
 * line; the two that didn't were both cases of a SPLIT SHIPMENT — SanMar ships per
 * carton while both ShopWorks receiving and SanMar's box feed talk per PO:
 *
 *   1. boxDetail came from SanMar's live feed, which returns EVERY box the PO ever
 *      shipped — so PO 113682 reported 70 pcs / 3 boxes on 7/28 when only 6 pcs in
 *      one carton were actually inbound; the other two had been on the shelf since
 *      the 17th and were being counted (and costed) a second time.
 *   2. That same PO was counted in on 7/21, so the received flag collapsed it to
 *      "✓ Received" and dropped it from the totals, Mikalah's checklist AND the box
 *      labels — while a carton that shipped on the 24th was still in transit.
 *
 * Erik's Rule #4 cuts one way here: over-reporting a box is recoverable at the dock,
 * silently hiding one is not. So the scoping filter FALLS BACK to every box when it
 * can't match tracking, and the received suppression only applies when we can prove
 * the arriving carton predates the count-in.
 */
const { scopeBoxesToArrival, isFollowOnShipment } = require('../../src/routes/sanmar-orders');

// PO 113682 (Swiss Sportsmen's Club, WO 142473) exactly as SanMar's feed returned it.
// Only box 3 was on the 7/24 manifest; boxes 1-2 shipped 7/17 and were already received.
const PO_113682_BOXES = [
  { trackingNumber: '1Z021W510351543985', pieces: 58 },
  { trackingNumber: '1Z021W510313599747', pieces: 6 },
  { trackingNumber: '1Z021W510351562544', pieces: 6 },
];
const ARRIVING = new Set(['1Z021W510351562544']); // the only carton in the 7/28 window

describe('scopeBoxesToArrival — only the cartons landing this day are counted', () => {
  test('a split shipment reports ONLY the arriving carton (113682: 6 pcs, not 70)', () => {
    const scoped = scopeBoxesToArrival(PO_113682_BOXES, ARRIVING);
    expect(scoped).toHaveLength(1);
    expect(scoped[0].trackingNumber).toBe('1Z021W510351562544');
    expect(scoped.reduce((t, b) => t + b.pieces, 0)).toBe(6);
  });

  test('every box is kept when they all arrive together (multi-carton PO 113795)', () => {
    const boxes = [{ trackingNumber: '1ZGH03410357056814', pieces: 51 }, { trackingNumber: '1ZGH03410357056136', pieces: 12 }];
    const scoped = scopeBoxesToArrival(boxes, new Set(['1ZGH03410357056814', '1ZGH03410357056136']));
    expect(scoped.reduce((t, b) => t + b.pieces, 0)).toBe(63);
  });

  test('tracking match ignores case and stray whitespace', () => {
    const boxes = [{ trackingNumber: ' 1z021w510351562544 ' }];
    expect(scopeBoxesToArrival(boxes, ARRIVING)).toHaveLength(1);
  });

  // Rule #4 — a filter that can't match must not empty the box list.
  test('NO tracking overlap falls back to every box rather than showing none', () => {
    const scoped = scopeBoxesToArrival(PO_113682_BOXES, new Set(['1ZNOTAMATCH000000000']));
    expect(scoped).toHaveLength(3);
  });
  test('boxes with no tracking number at all are still shown', () => {
    const boxes = [{ trackingNumber: '', pieces: 4 }];
    expect(scopeBoxesToArrival(boxes, ARRIVING)).toHaveLength(1);
  });
  test('an empty/absent arriving set is not treated as "nothing arrives"', () => {
    expect(scopeBoxesToArrival(PO_113682_BOXES, new Set())).toHaveLength(3);
    expect(scopeBoxesToArrival(PO_113682_BOXES, undefined)).toHaveLength(3);
  });
});

describe('isFollowOnShipment — a count-in must not hide a later carton', () => {
  test('carton shipped AFTER the count-in is still inbound (113682: recv 7/21, ship 7/24)', () => {
    expect(isFollowOnShipment('2026-07-21', '2026-07-24')).toBe(true);
  });

  test('carton shipped BEFORE the count-in really is on the shelf', () => {
    expect(isFollowOnShipment('2026-07-24', '2026-07-21')).toBe(false);
  });

  test('same-day count-in and ship is treated as received, not follow-on', () => {
    expect(isFollowOnShipment('2026-07-24', '2026-07-24')).toBe(false);
  });

  test('full timestamps compare by date only', () => {
    expect(isFollowOnShipment('2026-07-21T00:00:00', '2026-07-24T19:12:41')).toBe(true);
    expect(isFollowOnShipment('2026-07-24T23:59:00', '2026-07-24T00:01:00')).toBe(false);
  });

  // No count-in date (sts_Received flag alone) ⇒ nothing to compare; honour the flag as before
  // rather than putting every historically-received PO back on the worklist.
  test('a missing date on either side is not a follow-on', () => {
    expect(isFollowOnShipment('', '2026-07-24')).toBe(false);
    expect(isFollowOnShipment('2026-07-21', '')).toBe(false);
    expect(isFollowOnShipment(null, undefined)).toBe(false);
  });
});
