// Locks the line-item comparison in scripts/sync-manageorders.js.
//
// Why this matters: the comparison decides whether ManageOrders_LineItems — a
// financial archive that check-zero-billing and the commission reports read —
// gets deleted and rewritten. A false "unchanged" leaves the archive stale
// forever; a false "changed" costs billed Caspio writes but loses nothing.
// The asymmetry is deliberate: when in doubt, re-sync.
//
// Context: on 2026-07-29 sync-manageorders spent 2,901 billed Caspio calls in
// 22 minutes (~18% of the whole daily budget) mostly rewriting line items that
// were byte-identical, because ANY order-level change (a payment posting, an
// invoice date) triggered a full DELETE + N POSTs.

const {
  mapLineItem,
  lineItemSignature,
  lineItemsUnchanged,
  detectChange,
  normalize,
  CHANGE_FIELDS
} = require('../../scripts/sync-manageorders');

// A ManageOrders API line item (the shape fetchLineItems returns).
const mo = (over = {}) => ({
  PartNumber: 'PC54', PartDescription: 'Core Cotton Tee', PartColor: 'Jet Black',
  LineQuantity: 24, LineUnitPrice: 4.39, SortOrder: 1,
  Size01: 24, Size02: null, Size03: null, Size04: null, Size05: null, Size06: null,
  ...over
});

// The same row as Caspio hands it back (verified against live rows 2026-07-29:
// unset sizes come back as null, numbers as numbers, strings as strings).
const stored = (over = {}) => mapLineItem(mo(over), 142609);

describe('line-item comparison (sync-manageorders)', () => {
  test('identical content compares equal — this is the whole saving', () => {
    expect(lineItemsUnchanged([mo()], 142609, [stored()])).toBe(true);
  });

  test('empty on both sides is unchanged, not a re-sync', () => {
    expect(lineItemsUnchanged([], 142609, [])).toBe(true);
  });

  test('an order absent from the archive map must re-sync', () => {
    // undefined = no rows found in a COMPLETE read. A new order lands here.
    expect(lineItemsUnchanged([mo()], 142609, undefined)).toBe(false);
  });

  test('line item removed upstream is detected', () => {
    expect(lineItemsUnchanged([mo()], 142609, [stored(), stored({ SortOrder: 2 })])).toBe(false);
  });

  test('line item added upstream is detected', () => {
    expect(lineItemsUnchanged([mo(), mo({ SortOrder: 2 })], 142609, [stored()])).toBe(false);
  });

  test('all upstream items removed is detected (never silently keeps stale rows)', () => {
    expect(lineItemsUnchanged([], 142609, [stored()])).toBe(false);
  });

  // Each of these is a real edit that leaves order-level totals untouched, which
  // is exactly what a "only re-sync when TotalProductQuantity moves" heuristic
  // would have missed.
  test.each([
    ['colour', { PartColor: 'Navy' }],
    ['description', { PartDescription: 'Core Cotton Tee - REORDER' }],
    ['part number', { PartNumber: 'PC54LS' }],
    ['unit price', { LineUnitPrice: 4.5 }],
    ['quantity', { LineQuantity: 25 }],
    ['size breakdown', { Size02: 6 }],
    ['sort order', { SortOrder: 3 }]
  ])('a changed %s forces a re-sync', (_label, over) => {
    expect(lineItemsUnchanged([mo(over)], 142609, [stored()])).toBe(false);
  });

  test('a size going from unset to zero is a real change, not noise', () => {
    // null and 0 must NOT collapse — an explicit 0 is data.
    expect(lineItemsUnchanged([mo({ Size02: 0 })], 142609, [stored()])).toBe(false);
  });

  test('numeric formatting differences do NOT force a pointless re-sync', () => {
    // Caspio may hand back 60 where ManageOrders sent "60.00"; both are one price.
    const asStrings = stored();
    asStrings.LineUnitPrice = '4.390';
    asStrings.LineQuantity = '24';
    asStrings.Size01 = '24';
    expect(lineItemsUnchanged([mo()], 142609, [asStrings])).toBe(true);
  });

  test('surrounding whitespace on text fields is not a change', () => {
    const padded = stored();
    padded.PartColor = '  Jet Black  ';
    expect(lineItemsUnchanged([mo()], 142609, [padded])).toBe(true);
  });

  test('items are compared as a multiset, so upstream reordering is not a change', () => {
    const a = mo({ SortOrder: 1 });
    const b = mo({ SortOrder: 2, PartColor: 'Navy' });
    expect(lineItemsUnchanged([a, b], 142609, [mapLineItem(b, 142609), mapLineItem(a, 142609)])).toBe(true);
  });

  test('signature covers every field mapLineItem writes except the order key', () => {
    // Guards against someone adding a column to mapLineItem and forgetting the
    // comparison — which would make that column permanently un-syncable.
    const written = Object.keys(mapLineItem(mo(), 142609)).filter(k => k !== 'id_Order');
    const sigOf = row => lineItemSignature(row);
    for (const field of written) {
      const base = stored();
      const mutated = stored();
      mutated[field] = typeof base[field] === 'number' ? base[field] + 7 : 'DIFFERENT';
      expect(sigOf(mutated)).not.toBe(sigOf(base));
    }
  });
});

describe('ISO date normalisation (the 2,901-call bug)', () => {
  // Measured 2026-07-29: 456 of 457 "changed" orders were this format mismatch.
  // The API sends milliseconds and a Z; Caspio hands the same value back without
  // either. Raw string comparison never matched, so every order that had ever
  // shipped was re-synced on every run, forever.
  test('API and Caspio renderings of the SAME instant compare equal', () => {
    expect(normalize('2026-07-27T00:00:00.000Z')).toBe(normalize('2026-07-27T00:00:00'));
  });

  test.each([
    ['date_Shipped', '2026-07-27T00:00:00.000Z', '2026-07-27T00:00:00'],
    ['date_Invoiced', '2026-07-23T00:00:00.000Z', '2026-07-23T00:00:00'],
    ['date_Produced', '2026-04-01T00:00:00.000Z', '2026-04-01T00:00:00']
  ])('%s no longer reports a phantom change', (field, fromApi, fromCaspio) => {
    expect(detectChange({ [field]: fromApi }, { [field]: fromCaspio })).toBeNull();
  });

  test('a REAL date change is still detected', () => {
    expect(detectChange(
      { date_Shipped: '2026-07-28T00:00:00.000Z' },
      { date_Shipped: '2026-07-27T00:00:00' }
    )).toBe('date_Shipped');
  });

  test('a real time-of-day difference is still detected (not blanket-truncated to the day)', () => {
    expect(normalize('2026-07-27T14:30:00.000Z')).not.toBe(normalize('2026-07-27T00:00:00'));
  });

  test('null / empty / absent all still collapse to the same blank', () => {
    expect(normalize(null)).toBe('');
    expect(normalize(undefined)).toBe('');
    expect(normalize('')).toBe('');
  });

  test('a date appearing where there was none is a change', () => {
    expect(detectChange({ date_Shipped: '2026-07-27T00:00:00.000Z' }, { date_Shipped: null })).toBe('date_Shipped');
  });

  test('non-date values are untouched by the normaliser', () => {
    expect(normalize('  Jet Black ')).toBe('Jet Black');
    expect(normalize(0)).toBe('0');
    expect(normalize('2026-07-27')).toBe('2026-07-27');
  });
});

describe('order-level change detection is unchanged', () => {
  test('CHANGE_FIELDS still drives detectChange, and money fields are in it', () => {
    for (const f of ['cur_Balance', 'cur_Payments', 'sts_Paid', 'date_Invoiced']) {
      expect(CHANGE_FIELDS).toContain(f);
    }
  });

  test('an order-only change is still detected (it must still PUT the order)', () => {
    expect(detectChange({ cur_Balance: 10 }, { cur_Balance: 0 })).toBe('cur_Balance');
  });

  test('no change returns null', () => {
    const row = {};
    for (const f of CHANGE_FIELDS) row[f] = 'same';
    expect(detectChange(row, { ...row })).toBeNull();
  });
});
