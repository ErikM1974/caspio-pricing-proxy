// Locks the sticker price grid, the bounding-box / round-up rules, the derived
// unit price, the savings ladder and the best-value knee.
//
// Why this file exists (2026-07-24): sticker + banner pricing had ZERO automated
// coverage, and the grid is about to be published on a public customer-facing
// page. The invariants below are the ones that have actually broken before:
//   - monotonicity (caught the 2026-05-29 STK-3X3-50 and STK-6X6-100 repairs)
//   - round-UP direction (the deleted front-end service rounded DOWN, which
//     quotes BELOW the published sheet)
//   - unit price derivation (26 of 50 stored PricePerSticker values do not
//     multiply back to their own TotalPrice)
//
// Caspio is mocked to throw, forcing the inline grid — which is the source of
// truth in the route. Hermetic, no network.

jest.mock('../../src/utils/caspio', () => ({
  fetchAllCaspioPages: jest.fn(async () => { throw new Error('no caspio in test — force inline'); }),
}));

const {
  loadGrid,
  quoteStickerFromGrid,
  resolveRushMultiplier,
  deriveUnitPrice,
  STANDARD_SIZES,
  STANDARD_QTYS,
  SETUP_FEE_PART,
  SETUP_FEE_AMOUNT,
} = require('../../src/routes/sticker-pricing');

// Thin helper so each test reads like a customer request.
async function quote({ width, height, qty, rushMultiplier = null }) {
  const { grid } = await loadGrid();
  return quoteStickerFromGrid({ width, height, qty, grid, rushMultiplier });
}

describe('sticker-pricing — grid integrity', () => {
  test('inline grid is the full 5-size × 10-qty cross product, 50 unique SKUs', async () => {
    const { grid, source, degraded } = await loadGrid();
    expect(source).toBe('inline');
    expect(degraded).toBe(false);
    expect(grid).toHaveLength(50);

    const parts = grid.map(r => r.PartNumber);
    expect(new Set(parts).size).toBe(50);
    parts.forEach(p => expect(p).toMatch(/^STK-\d+X\d+-\d+$/));

    for (const size of STANDARD_SIZES) {
      const qtys = grid.filter(r => r.Size === size).map(r => r.Quantity).sort((a, b) => a - b);
      expect(qtys).toEqual(STANDARD_QTYS);
    }
  });

  test('every row carries a positive total and the setup fee is the shared GRT-50 $50', async () => {
    const { grid } = await loadGrid();
    grid.forEach(r => expect(r.TotalPrice).toBeGreaterThan(0));
    expect(SETUP_FEE_PART).toBe('GRT-50');
    expect(SETUP_FEE_AMOUNT).toBe(50);
  });

  test('source is always present — the contract the front end depends on', async () => {
    const { source } = await loadGrid();
    expect(['caspio', 'inline']).toContain(source);
  });

  test('the inline fallback is NEVER cached — two consecutive loads both report inline', async () => {
    // Pinning a fallback payload for a full TTL is the silent-stale-price hole
    // Rule 4 forbids. With Caspio throwing, nothing may be memoised.
    const a = await loadGrid();
    const b = await loadGrid();
    expect(a.source).toBe('inline');
    expect(b.source).toBe('inline');
  });

  test('loadGrid does not mutate the module-level INLINE_GRID between calls', async () => {
    const a = await loadGrid();
    a.grid[0].TotalPrice = 999999;
    const b = await loadGrid();
    expect(b.grid[0].TotalPrice).not.toBe(999999);
  });
});

describe('sticker-pricing — monotonicity (the invariant that caught the 2026-05-29 repairs)', () => {
  test('within each size: total strictly rises and unit price strictly falls as qty rises', async () => {
    const { grid } = await loadGrid();
    for (const size of STANDARD_SIZES) {
      const rows = grid.filter(r => r.Size === size).sort((a, b) => a.Quantity - b.Quantity);
      for (let i = 1; i < rows.length; i++) {
        expect(rows[i].TotalPrice).toBeGreaterThan(rows[i - 1].TotalPrice);
        expect(deriveUnitPrice(rows[i])).toBeLessThan(deriveUnitPrice(rows[i - 1]));
      }
    }
  });

  test('at every fixed quantity: total strictly rises from 2x2 through 6x6', async () => {
    const { grid } = await loadGrid();
    for (const qty of STANDARD_QTYS) {
      const totals = STANDARD_SIZES.map(
        size => grid.find(r => r.Size === size && r.Quantity === qty).TotalPrice
      );
      for (let i = 1; i < totals.length; i++) {
        expect(totals[i]).toBeGreaterThan(totals[i - 1]);
      }
    }
  });
});

describe('sticker-pricing — derived unit price (never the stored PricePerSticker)', () => {
  test('unitPrice on every grid row equals TotalPrice / Quantity exactly', async () => {
    const { grid } = await loadGrid();
    grid.forEach(r => expect(r.unitPrice).toBe(r.TotalPrice / r.Quantity));
  });

  test('the penny table — the six worst rows where the stored field does NOT reconcile', async () => {
    // Each of these publishes a PricePerSticker that multiplies back to a
    // DIFFERENT total than the one we charge. Deriving is the fix; these are
    // pinned so nobody "optimises" back to reading the stored column.
    const { grid } = await loadGrid();
    const row = pn => grid.find(r => r.PartNumber === pn);

    const cases = [
      ['STK-4X4-10000', 0.5846, 5846],  // stored 0.58 → $5,800 (a $46 gap)
      ['STK-2X2-10000', 0.2158, 2158],  // stored 0.22 → $2,200
      ['STK-2X2-5000',  0.255,  1275],  // stored 0.26 → $1,300
      ['STK-4X4-3000',  0.745333333333, 2236], // stored 0.75 → $2,250
      ['STK-3X3-3000',  0.494,  1482],  // stored 0.49 → $1,470
      ['STK-4X4-1000',  0.962,  962],   // stored 0.96 → $960 (the original bug)
    ];

    for (const [part, expectedUnit, expectedTotal] of cases) {
      const r = row(part);
      expect(r.TotalPrice).toBe(expectedTotal);
      expect(r.unitPrice).toBeCloseTo(expectedUnit, 8);
      // The whole point: unit × qty reconstructs the real total.
      expect(r.unitPrice * r.Quantity).toBeCloseTo(r.TotalPrice, 6);
    }
  });

  test('quote results derive unitPrice from the (possibly rushed) total, not the stored column', async () => {
    const q = await quote({ width: 4, height: 4, qty: 1000 });
    expect(q.ok).toBe(true);
    expect(q.totalPrice).toBe(962);
    expect(q.unitPrice).toBeCloseTo(0.962, 8);
    expect(q.unitPrice * q.quantity).toBeCloseTo(q.totalPrice, 6);
  });
});

describe('sticker-pricing — savings ladder', () => {
  test('first tier of every size is never badged', async () => {
    const { grid } = await loadGrid();
    for (const size of STANDARD_SIZES) {
      const rows = grid.filter(r => r.Size === size).sort((a, b) => a.Quantity - b.Quantity);
      expect(rows[0].savingsPct).toBeNull();
    }
  });

  test('the whole 3x3 savings column is pinned', async () => {
    const { grid } = await loadGrid();
    const col = grid
      .filter(r => r.Size === '3x3')
      .sort((a, b) => a.Quantity - b.Quantity)
      .map(r => r.savingsPct);
    expect(col).toEqual([null, 37, 40, 50, 59, 67, 72, 75, 78, 81]);
  });

  test('terminal savings per size are pinned (the 10,000-piece headline)', async () => {
    const { grid } = await loadGrid();
    const terminal = STANDARD_SIZES.map(size =>
      grid.find(r => r.Size === size && r.Quantity === 10000).savingsPct
    );
    expect(terminal).toEqual([88, 81, 81, 76, 72]);
  });

  test('savings never decrease as quantity rises', async () => {
    const { grid } = await loadGrid();
    for (const size of STANDARD_SIZES) {
      const rows = grid.filter(r => r.Size === size).sort((a, b) => a.Quantity - b.Quantity);
      for (let i = 2; i < rows.length; i++) {
        expect(rows[i].savingsPct).toBeGreaterThanOrEqual(rows[i - 1].savingsPct);
      }
    }
  });
});

describe('sticker-pricing — best-value knee', () => {
  test('exactly one flagged tier per size, pinned to the current curve', async () => {
    const { grid } = await loadGrid();
    const knees = {};
    for (const size of STANDARD_SIZES) {
      const flagged = grid.filter(r => r.Size === size && r.IsBestValue);
      expect(flagged).toHaveLength(1);
      knees[size] = flagged[0].Quantity;
    }
    expect(knees).toEqual({ '2x2': 200, '3x3': 100, '4x4': 200, '5x5': 200, '6x6': 200 });
  });

  test('the knee is never worse per-piece than the tier above it', async () => {
    const { grid } = await loadGrid();
    for (const size of STANDARD_SIZES) {
      const rows = grid.filter(r => r.Size === size).sort((a, b) => a.Quantity - b.Quantity);
      const i = rows.findIndex(r => r.IsBestValue);
      if (i < rows.length - 1) {
        expect(rows[i].unitPrice).toBeGreaterThan(rows[i + 1].unitPrice);
      }
    }
  });
});

describe('sticker-pricing — bounding-box rule', () => {
  test('the larger dimension rounds UP to the next standard square', async () => {
    expect((await quote({ width: 2, height: 3, qty: 100 })).size).toBe('3x3');
    expect((await quote({ width: 2.5, height: 2.5, qty: 100 })).size).toBe('3x3');
    expect((await quote({ width: 4, height: 2, qty: 100 })).size).toBe('4x4');
    expect((await quote({ width: 6, height: 6, qty: 100 })).size).toBe('6x6');
    expect((await quote({ width: 0.75, height: 0.75, qty: 100 })).size).toBe('2x2');
  });

  test('width and height are interchangeable — a swap prices identically', async () => {
    // `requested` deliberately echoes the caller's own w/h order, so compare the
    // priced result rather than the whole object.
    const strip = q => { const { requested, row, ...priced } = q; return priced; };
    const a = await quote({ width: 2, height: 5, qty: 300 });
    const b = await quote({ width: 5, height: 2, qty: 300 });
    expect(strip(a)).toEqual(strip(b));
    expect(a.totalPrice).toBe(b.totalPrice);
    expect(a.partNumber).toBe(b.partNumber);
  });

  test('an exact standard square is NOT reported as rounded', async () => {
    expect((await quote({ width: 3, height: 3, qty: 100 })).sizeWasRounded).toBe(false);
    expect((await quote({ width: 2, height: 3, qty: 100 })).sizeWasRounded).toBe(true);
    expect((await quote({ width: 2.5, height: 2.5, qty: 100 })).sizeWasRounded).toBe(true);
  });

  test('over 6 inches is off-grid and hands off to the decal ladder', async () => {
    const q = await quote({ width: 6.1, height: 6.1, qty: 100 });
    expect(q.ok).toBe(false);
    expect(q.kind).toBe('oversize_dimension');
    expect(q.maxDim).toBeCloseTo(6.1, 6);
  });
});

describe('sticker-pricing — quantity rounds UP, never down', () => {
  test('an off-tier quantity takes the NEXT tier up', async () => {
    expect((await quote({ width: 3, height: 3, qty: 75 })).quantity).toBe(100);
    expect((await quote({ width: 3, height: 3, qty: 250 })).quantity).toBe(300);
    expect((await quote({ width: 3, height: 3, qty: 250 })).totalPrice).toBe(296);
  });

  test('below the 50-piece minimum still charges the full 50 tier — never pro-rated', async () => {
    // The deleted front-end service pro-rated this to $17.40 and rounded 250
    // DOWN to the 200 tier ($175 against a published $186). Both are quotes
    // below our own sheet. Locked out permanently.
    const q = await quote({ width: 2, height: 2, qty: 10 });
    expect(q.quantity).toBe(50);
    expect(q.totalPrice).toBe(87);
  });

  test('an exact tier is not reported as rounded', async () => {
    expect((await quote({ width: 3, height: 3, qty: 100 })).qtyWasRounded).toBe(false);
    expect((await quote({ width: 3, height: 3, qty: 99 })).qtyWasRounded).toBe(true);
  });

  test('10,000 is exact; 10,001 is off-grid', async () => {
    expect((await quote({ width: 2, height: 2, qty: 10000 })).quantity).toBe(10000);
    const over = await quote({ width: 2, height: 2, qty: 10001 });
    expect(over.ok).toBe(false);
    expect(over.kind).toBe('oversize_quantity');
  });

  test('property sweep 1…10,000 — the total is non-decreasing and always equals the published cell', async () => {
    const { grid } = await loadGrid();
    let prev = 0;
    for (let qty = 1; qty <= 10000; qty += 37) {
      const q = quoteStickerFromGrid({ width: 3, height: 3, qty, grid });
      const tier = STANDARD_QTYS.find(t => t >= qty);
      const published = grid.find(r => r.Size === '3x3' && r.Quantity === tier).TotalPrice;
      expect(q.totalPrice).toBe(published);
      expect(q.totalPrice).toBeGreaterThanOrEqual(prev);
      prev = q.totalPrice;
    }
  });
});

describe('sticker-pricing — rush', () => {
  test('the multiplier is sourced from the shared RUSH-25PCT row, not a local constant', async () => {
    // Cross-module: it lives in Banner_Pricing, read by sticker AND decal.
    expect(await resolveRushMultiplier()).toBe(1.25);
  });

  test('rush scales the total and the derived unit, and never changes the tier', async () => {
    const base = await quote({ width: 4, height: 4, qty: 1000 });
    const rush = await quote({ width: 4, height: 4, qty: 1000, rushMultiplier: 1.25 });

    expect(rush.size).toBe(base.size);
    expect(rush.quantity).toBe(base.quantity);
    expect(rush.partNumber).toBe(base.partNumber);
    expect(rush.totalPrice).toBe(1202.5);           // 962 × 1.25
    expect(rush.unitPrice).toBeCloseTo(1.2025, 8);
    expect(rush.rushMultiplier).toBe(1.25);
    expect(base.rushMultiplier).toBeNull();
  });
});

describe('sticker-pricing — bad input never yields a price', () => {
  test.each([
    ['zero width', { width: 0, height: 2, qty: 100 }],
    ['negative qty', { width: 2, height: 2, qty: -1 }],
    ['non-numeric qty', { width: 2, height: 2, qty: 'abc' }],
    ['missing height', { width: 2, qty: 100 }],
    ['all missing', {}],
  ])('%s → bad_input, no price', async (_label, input) => {
    const q = await quote(input);
    expect(q.ok).toBe(false);
    expect(q.kind).toBe('bad_input');
    expect(q.totalPrice).toBeUndefined();
    expect(q.unitPrice).toBeUndefined();
  });
});
