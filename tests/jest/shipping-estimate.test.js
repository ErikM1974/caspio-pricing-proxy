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

describe('zoneForZip — origin 983 (Milton WA), exact UPS 983 chart', () => {
  test.each([
    ['98390', 2], ['98101', 2], ['97201', 2], ['90001', 5], ['80202', 5], ['10001', 8], ['33101', 8],
  ])('%s → zone %p', (zip, zone) => {
    expect(ship.zoneForZip(zip).zone).toBe(zone);
  });
  test('mapped zips are exact (sourced from the real 983 chart, not rough)', () => {
    expect(ship.zoneForZip('98390').source).toBe('ups-983-chart');
    expect(ship.zoneForZip('98390').rough).toBe(false);
  });
  test('unmapped zips (e.g. AK) fall back to the approximate range, flagged rough', () => {
    const ak = ship.zoneForZip('99501');
    expect(ak.source).toBe('approx-range');
    expect(ak.rough).toBe(true);
  });
});

describe('computeEstimate — negotiated cost + markup model (fit to real UPS invoice)', () => {
  test('light box hits the $11.99 floor: zone 2, 5 lb → cost $14.39, estimate $16.55', () => {
    const e = ship.computeEstimate({ toZip: '98390', boxWeightsLb: [5], boxes: 1, residential: false });
    expect(e.basis).toBe('negotiated');
    expect(e.markupPct).toBeCloseTo(0.15, 2);
    expect(e.estimatedCost).toBeCloseTo(14.39, 2);  // $11.99 floor + 20% fuel
    expect(e.estimate).toBeCloseTo(16.55, 2);        // cost × 1.15 markup
    expect(e.zone).toBe(2);
  });

  test('estimate ≈ estimatedCost × (1 + markup)', () => {
    const e = ship.computeEstimate({ toZip: '10001', boxWeightsLb: [40], boxes: 1 });
    // estimate is computed from the UNrounded cost, so allow a cent of rounding slack
    expect(e.estimate).toBeCloseTo(e.estimatedCost * 1.15, 1);
  });

  test('residential adds $3.90/box (carried through fuel + markup)', () => {
    const c = ship.computeEstimate({ toZip: '98390', boxWeightsLb: [5], boxes: 1, residential: false });
    const r = ship.computeEstimate({ toZip: '98390', boxWeightsLb: [5], boxes: 1, residential: true });
    expect(r.residentialUsd).toBeCloseTo(3.90, 2);
    expect(r.estimate).toBeGreaterThan(c.estimate);
    expect(r.estimate).toBeCloseTo(21.93, 2);
  });

  test('heavy far box uses the discounted grid, not the floor: zone 8, 40 lb → ~$62.83', () => {
    const e = ship.computeEstimate({ toZip: '10001', boxWeightsLb: [40], boxes: 1 });
    expect(e.estimate).toBeCloseTo(62.83, 1);
  });

  test('estimated COST matches a real UPS invoice within ~$1: San Diego 11 lb commercial (actual $15.75)', () => {
    const e = ship.computeEstimate({ toZip: '92101', boxWeightsLb: [11], boxes: 1, residential: false });
    expect(Math.abs(e.estimatedCost - 15.75)).toBeLessThan(1.0);
  });

  test('a far box still costs more than a local box of the same weight', () => {
    const ny = ship.computeEstimate({ toZip: '10001', boxWeightsLb: [40], boxes: 1 }).estimate;
    const wa = ship.computeEstimate({ toZip: '98390', boxWeightsLb: [40], boxes: 1 }).estimate;
    expect(ny).toBeGreaterThan(wa);
  });
});
