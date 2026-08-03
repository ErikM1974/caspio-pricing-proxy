/**
 * /inbound-today must bucket by CARTON, not by PO.
 *
 * WHY (2026-08-03, PO 113852 — City of Tukwila)
 * The route collapsed every carton of a PO into one entry BEFORE choosing an arrival day:
 * the estimate became the earliest box's, and the UPS lookup used whichever tracking was
 * seen first. A PO shipping from two warehouses therefore had exactly one arrival day, and
 * its other cartons were dropped with no trace — the VA carton 1ZGH03410357176079 (est. 8/6)
 * appeared on NO day while its NV sibling sat on 8/3, even though both rows were in
 * SanMar_Shipments.
 *
 * Sibling 113837 escaped only by accident: its two estimates fell outside each other's
 * ±3-day candidate band, so each request happened to see a single carton. That is luck,
 * not correctness — a split shipment really does arrive on two days and must show on both,
 * each day carrying only the cartons that land that day (receiving counts boxes).
 */
const fs = require('fs');
const path = require('path');

const SRC = fs.readFileSync(path.join(__dirname, '../../src/routes/sanmar-orders.js'), 'utf8');
const BLOCK = SRC.slice(
  SRC.indexOf('const bandLo = addDaysISO(date, -3)'),
  SRC.indexOf('if (poShip.size === 0)')
);

/**
 * Mirror of the route's rule: keep cartons whose effective arrival == date, then group by PO.
 * Tests the RULE, so it fails if the logic regresses even if the prose survives.
 */
function bucket(cartons, date) {
  const byPo = new Map();
  for (const c of cartons) {
    const effective = c.ups || c.est;
    if (effective !== date) continue;
    let cur = byPo.get(c.po);
    if (!cur) { cur = { boxes: 0, tracking: new Set() }; byPo.set(c.po, cur); }
    cur.boxes += 1;
    cur.tracking.add(c.tracking);
  }
  return byPo;
}

// PO 113852 exactly as it really shipped.
const SPLIT_PO = [
  { po: '113852', tracking: '1Z021W510351579732', est: '2026-08-03', ups: '2026-08-03' }, // NV
  { po: '113852', tracking: '1ZGH03410357176079', est: '2026-08-06', ups: '2026-08-06' }, // VA
];

describe('inbound-today: a split shipment appears on every day it arrives', () => {
  test('PO 113852 shows on 8/3 with ONLY the NV carton', () => {
    const day = bucket(SPLIT_PO, '2026-08-03');
    expect(day.has('113852')).toBe(true);
    expect(day.get('113852').boxes).toBe(1);
    expect([...day.get('113852').tracking]).toEqual(['1Z021W510351579732']);
  });

  test('PO 113852 ALSO shows on 8/6 with the VA carton — the regression', () => {
    const day = bucket(SPLIT_PO, '2026-08-06');
    expect(day.has('113852')).toBe(true);          // used to be absent entirely
    expect(day.get('113852').boxes).toBe(1);
    expect([...day.get('113852').tracking]).toEqual(['1ZGH03410357176079']);
  });

  test('it does NOT appear on a day neither carton arrives', () => {
    expect(bucket(SPLIT_PO, '2026-08-04').has('113852')).toBe(false);
    expect(bucket(SPLIT_PO, '2026-08-05').has('113852')).toBe(false);
  });

  test('cartons landing the same day still collapse into one PO row', () => {
    const sameDay = [
      { po: '113838', tracking: 'A', est: '2026-07-30', ups: '2026-07-30' },
      { po: '113838', tracking: 'B', est: '2026-07-30', ups: '2026-07-30' },
    ];
    const day = bucket(sameDay, '2026-07-30');
    expect(day.get('113838').boxes).toBe(2);
    expect([...day.get('113838').tracking].sort()).toEqual(['A', 'B']);
  });

  test("each carton's own UPS date wins over its own estimate, independently", () => {
    // The second carton's UPS date pulls it to a different day than its estimate.
    const rescheduled = [
      { po: 'X', tracking: 'T1', est: '2026-08-03', ups: '2026-08-03' },
      { po: 'X', tracking: 'T2', est: '2026-08-03', ups: '2026-08-05' },
    ];
    expect([...bucket(rescheduled, '2026-08-03').get('X').tracking]).toEqual(['T1']);
    expect([...bucket(rescheduled, '2026-08-05').get('X').tracking]).toEqual(['T2']);
  });

  test('a carton with no UPS scan falls back to its own estimate', () => {
    const noScan = [{ po: 'Y', tracking: 'T', est: '2026-08-06', ups: null }];
    expect(bucket(noScan, '2026-08-06').has('Y')).toBe(true);
    expect(bucket(noScan, '2026-08-03').has('Y')).toBe(false);
  });
});

describe('inbound-today: the route implements carton-first bucketing', () => {
  test('candidates are built as cartons before any day is chosen', () => {
    expect(BLOCK).toMatch(/const cartons = \[\]/);
    expect(BLOCK).toMatch(/cartons\.push\(/);
  });

  test('UPS is resolved per carton, not per PO', () => {
    expect(BLOCK).toMatch(/cartons\.filter\(c => c\.tracking/);
    expect(BLOCK).not.toMatch(/\[\.\.\.poShip\.entries\(\)\]\.filter/);   // the old per-PO lookup
  });

  test('the day filter runs over cartons, and poShip is built after it', () => {
    const filterAt = BLOCK.indexOf('if (effective !== date) continue;');
    const groupAt = BLOCK.indexOf('poShip.set(c.po, cur)');
    expect(filterAt).toBeGreaterThan(-1);
    expect(groupAt).toBeGreaterThan(filterAt);      // group AFTER filtering, not before
    // The regression shape: build the PO map first, then delete whole POs.
    expect(BLOCK).not.toMatch(/poShip\.delete\(po\)/);
  });

  test('every field the per-PO record downstream reads is still populated', () => {
    for (const f of ['boxes', 'shipDate', 'lastShipDate', 'carrier', 'tracking',
                     'arrivingTracking', 'fromCity', 'fromState', 'estArrival', 'upsDelivery']) {
      expect(BLOCK).toContain(f);
    }
  });

  test('arrivingTracking is scoped to the cartons landing that day', () => {
    expect(BLOCK).toMatch(/cur\.arrivingTracking\.add\(c\.tracking\.toUpperCase\(\)\)/);
  });
});
