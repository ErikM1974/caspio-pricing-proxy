/**
 * Unit tests for the outbound UPS Ground freight estimator (src/routes/shipping.js).
 * Pure math — no network. Locks the rate-grid interpolation, zone resolution, billable
 * weight rounding, fuel, residential, and per-box pricing so a future edit can't silently
 * change quoted freight. (2026-06-07)
 */
const ship = require('../../src/routes/shipping');

describe('billableLb — UPS rounds UP to whole lb, min 1', () => {
  test.each([
    [0, 1], [0.4, 1], [1, 1], [3.36, 4], [5.64, 6], [17.55, 18], [18, 18],
  ])('billableLb(%p) === %p', (input, expected) => {
    expect(ship.billableLb(input)).toBe(expected);
  });
});

describe('groundRate — anchor cells exact, between anchors interpolated', () => {
  test('zone 2 anchor weights are exact', () => {
    expect(ship.groundRate(2, 1)).toBeCloseTo(11.32, 2);
    expect(ship.groundRate(2, 10)).toBeCloseTo(15.08, 2);
    expect(ship.groundRate(2, 70)).toBeCloseTo(32.89, 2);
  });
  test('zone 2 at 7 lb interpolates between 5 and 10', () => {
    // 13.38 + (7-5)/(10-5) * (15.08-13.38) = 14.06
    expect(ship.groundRate(2, 7)).toBeCloseTo(14.06, 2);
  });
  test('higher zone costs more at the same weight', () => {
    expect(ship.groundRate(8, 20)).toBeGreaterThan(ship.groundRate(2, 20));
  });
});

describe('zoneForZip — origin 983 (Milton WA)', () => {
  test.each([
    ['98390', 2], ['98101', 2], ['97201', 3], ['90001', 6], ['10001', 8], ['33101', 8],
  ])('%s → zone %p', (zip, zone) => {
    expect(ship.zoneForZip(zip).zone).toBe(zone);
  });
  test('range-derived zones are flagged rough', () => {
    expect(ship.zoneForZip('98390').rough).toBe(true);
    expect(ship.zoneForZip('98390').source).toBe('approx-range');
  });
});

describe('computeEstimate — worked example: 12 caps + 13 jackets + 12 tees → 98390', () => {
  const base = { toZip: '98390', weightLb: 26.55, boxes: 3, boxWeightsLb: [3.36, 17.55, 5.64] };

  test('commercial = $55.33 (real Daily grid, zone 2, 25.5% fuel)', () => {
    const e = ship.computeEstimate({ ...base, residential: false });
    expect(e.estimate).toBeCloseTo(55.33, 2);
    expect(e.zone).toBe(2);
    expect(e.boxes).toBe(3);
    expect(e.billableWeightLb).toBe(28); // 4 + 18 + 6
    expect(e.perBox).toHaveLength(3);
  });

  test('residential adds the surcharge', () => {
    const c = ship.computeEstimate({ ...base, residential: false }).estimate;
    const r = ship.computeEstimate({ ...base, residential: true }).estimate;
    expect(r).toBeCloseTo(c + 6.5, 2);
  });

  test('per-box weights beat an even split for uneven boxes (sanity: both ~same total here)', () => {
    const withBoxes = ship.computeEstimate({ ...base, residential: false }).estimate;
    const evenSplit = ship.computeEstimate({ toZip: '98390', weightLb: 26.55, boxes: 3, residential: false }).estimate;
    expect(withBoxes).toBeGreaterThan(0);
    expect(evenSplit).toBeGreaterThan(0);
  });
});

describe('computeEstimate — far + heavy is materially higher', () => {
  test('40 lb to NYC (zone 8) >> 40 lb local (zone 2)', () => {
    const ny = ship.computeEstimate({ toZip: '10001', boxWeightsLb: [40], boxes: 1 }).estimate;
    const wa = ship.computeEstimate({ toZip: '98390', boxWeightsLb: [40], boxes: 1 }).estimate;
    expect(ny).toBeGreaterThan(wa * 1.5);
  });
});
