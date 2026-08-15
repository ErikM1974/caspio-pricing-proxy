// Full back = ONE ladder, one source (2026-08-15, Erik).
//
// Before this, full-back pricing had FIVE sources across three Caspio tables and the
// price depended on WHICH SCREEN the rep used: the staff reference page showed the
// contract ladder, the quote builder charged a flat AL rate, and the retail DECG-FB
// rows were read by nothing at all. **Zero tests pinned any of it** — every rate could
// change silently.
//
// These lock the consolidation:
//   • the rates come from Embroidery_Costs ItemType='DECG-FB'
//   • the rate column is EmbroideryCost, NOT PerThousandRate (null on these rows)
//   • the fee column is LTM, NOT LTM_Fee (no such column — it swallowed a real $50)
//   • all three endpoints hand back the SAME numbers, and cannot leak into each other
//   • a missing ladder THROWS rather than serving a cheap fallback (Erik's #1 rule)

const mockFetchAllCaspioPages = jest.fn();
jest.mock('../../src/utils/caspio', () => ({
  fetchAllCaspioPages: (...a) => mockFetchAllCaspioPages(...a),
  makeCaspioRequest: jest.fn(),
}));

const express = require('express');
const pricingRouter = require('../../src/routes/pricing');
const { getFullBackLadder } = pricingRouter;

/** The live DECG-FB rows, verified against Caspio 2026-08-15. */
const DECG_FB_ROWS = [
  { ItemType: 'DECG-FB', TierLabel: '1-7', EmbroideryCost: 1.5, PerThousandRate: null, LTM: 50, BaseStitchCount: 25000, StitchCount: 25000 },
  { ItemType: 'DECG-FB', TierLabel: '8-23', EmbroideryCost: 1.4, PerThousandRate: null, LTM: 0, BaseStitchCount: 25000, StitchCount: 25000 },
  { ItemType: 'DECG-FB', TierLabel: '24-47', EmbroideryCost: 1.3, PerThousandRate: null, LTM: 0, BaseStitchCount: 25000, StitchCount: 25000 },
  { ItemType: 'DECG-FB', TierLabel: '48-71', EmbroideryCost: 1.25, PerThousandRate: null, LTM: 0, BaseStitchCount: 25000, StitchCount: 25000 },
  { ItemType: 'DECG-FB', TierLabel: '72+', EmbroideryCost: 1.2, PerThousandRate: null, LTM: 0, BaseStitchCount: 25000, StitchCount: 25000 },
];

const DECG_GARMENT_ROWS = [
  { ItemType: 'DECG-Garmt', TierLabel: '1-7', EmbroideryCost: 28, LTM: 50 },
  { ItemType: 'DECG-Garmt', TierLabel: '72+', EmbroideryCost: 20, LTM: 0 },
  { ItemType: 'DECG-Cap', TierLabel: '1-7', EmbroideryCost: 22.5, LTM: 50 },
];

beforeEach(() => {
  mockFetchAllCaspioPages.mockReset();
  // Bust the module-level 15-min ladder cache between tests.
  jest.isolateModules(() => {});
});

// The contract and AL endpoints 404 early if their own ItemTypes return nothing, so
// each query needs plausible rows. Note the CTR-FB / FB rows below deliberately carry
// the OLD, different rates — the point is that they are now IGNORED.
const CTR_ROWS = [
  { ItemType: 'CTR-Garmt', TierLabel: '24-47', PerThousandRate: 0.55, LTM: 50 },
  { ItemType: 'CTR-Cap', TierLabel: '24-47', PerThousandRate: 0.5, LTM: 50 },
  { ItemType: 'CTR-FB', TierLabel: '24-47', PerThousandRate: 0.9, LTM: 50 },
];
const AL_ROWS = [
  { ItemType: 'AL', TierLabel: '24-47', EmbroideryCost: 8, LTM: 50, BaseStitchCount: 5000 },
  { ItemType: 'AL-CAP', TierLabel: '24-47', EmbroideryCost: 7, LTM: 50, BaseStitchCount: 5000 },
  { ItemType: 'FB', TierLabel: 'ALL', EmbroideryCost: 1.25, BaseStitchCount: 25000 },
];

/** Serve whatever rows a query asks for, so every endpoint can be exercised. */
function serveRows() {
  mockFetchAllCaspioPages.mockImplementation(async (_table, params) => {
    const where = (params && params['q.where']) || '';
    if (where.includes('DECG-FB') && !where.includes('OR')) return DECG_FB_ROWS;   // the ladder read
    if (where.includes('DECG-Garmt')) return [...DECG_GARMENT_ROWS, ...DECG_FB_ROWS];
    if (where.includes('CTR-Garmt')) return CTR_ROWS;
    if (where.includes("ItemType='AL'")) return AL_ROWS;
    return [];
  });
}

async function callRoute(path) {
  const app = express();
  app.use('/api', pricingRouter);
  const server = app.listen(0);
  try {
    const { port } = server.address();
    const res = await fetch(`http://127.0.0.1:${port}${path}`);
    return { status: res.status, body: await res.json() };
  } finally {
    server.close();
  }
}

describe('the one ladder', () => {
  test('rates come from EmbroideryCost, not the null PerThousandRate column', async () => {
    serveRows();
    const ladder = await getFullBackLadder({ force: true });
    expect(ladder.ratesPerThousand).toEqual({
      '1-7': 1.5, '8-23': 1.4, '24-47': 1.3, '48-71': 1.25, '72+': 1.2,
    });
  });

  test('the small-batch fee is read from LTM — NOT LTM_Fee', async () => {
    serveRows();
    const ladder = await getFullBackLadder({ force: true });
    expect(ladder.ltmFee).toBe(50);
    expect(ladder.ltmThreshold).toBe(7);
  });

  test('a fixture using the OLD LTM_Fee spelling yields NO fee — the bug, pinned', async () => {
    // This is the exact shape the code used to read. If someone reintroduces
    // `record.LTM_Fee`, the ladder silently loses its $50 and this fails.
    mockFetchAllCaspioPages.mockResolvedValue(
      DECG_FB_ROWS.map(({ LTM, ...rest }) => ({ ...rest, LTM_Fee: LTM }))
    );
    const ladder = await getFullBackLadder({ force: true });
    expect(ladder.ltmFee).toBe(0);
  });

  test('25K prices per tier: 37.50 / 35.00 / 32.50 / 31.25 / 30.00', async () => {
    serveRows();
    const { ratesPerThousand, minStitches } = await getFullBackLadder({ force: true });
    expect(minStitches).toBe(25000);
    const at25k = t => +( (minStitches / 1000) * ratesPerThousand[t] ).toFixed(2);
    expect(at25k('1-7')).toBe(37.50);
    expect(at25k('8-23')).toBe(35.00);
    expect(at25k('24-47')).toBe(32.50);
    expect(at25k('48-71')).toBe(31.25);
    expect(at25k('72+')).toBe(30.00);
  });

  test('the cheapest possible full back is $30 — so a $20 minimum charge is inert', async () => {
    // Why the "Min charge $20.00" badge and every `|| 20.00` floor were deleted.
    serveRows();
    const { ratesPerThousand, minStitches } = await getFullBackLadder({ force: true });
    const cheapest = (minStitches / 1000) * Math.min(...Object.values(ratesPerThousand));
    expect(cheapest).toBe(30);
    expect(cheapest).toBeGreaterThan(20);
  });

  test('no rows → THROWS; never a cheap fallback rate', async () => {
    mockFetchAllCaspioPages.mockResolvedValue([]);
    await expect(getFullBackLadder({ force: true })).rejects.toThrow(/No DECG-FB rows/);
  });

  test('callers get their own copy — decorating one cannot poison the cache', async () => {
    serveRows();
    const a = await getFullBackLadder({ force: true });
    a.perThousandRates = a.ratesPerThousand;
    a.ratesPerThousand['72+'] = 99;
    const b = await getFullBackLadder();
    expect(b.perThousandRates).toBeUndefined();
    expect(b.ratesPerThousand['72+']).toBe(1.2);
  });
});

describe('every endpoint serves the same numbers', () => {
  test('decg / contract / al full-back rates are identical', async () => {
    serveRows();
    const decg = await callRoute('/api/decg-pricing');
    const ctr = await callRoute('/api/contract-pricing');
    const al = await callRoute('/api/al-pricing');

    const expected = { '1-7': 1.5, '8-23': 1.4, '24-47': 1.3, '48-71': 1.25, '72+': 1.2 };
    expect(decg.body.fullBack.ratesPerThousand).toEqual(expected);
    // Back-compat key names preserved for existing frontend readers.
    expect(ctr.body.fullBack.perThousandRates).toEqual(expected);
    expect(al.body.fullBack.ratesPerThousand).toEqual(expected);

    // …and specifically NOT the old per-endpoint rates, which the fixtures still supply.
    expect(ctr.body.fullBack.perThousandRates['24-47']).not.toBe(0.9);   // was CTR-FB
    expect(al.body.fullBack.ratesPerThousand['24-47']).not.toBe(1.25);   // was the flat FB row
  });

  test("one endpoint's back-compat alias never leaks into another's response", async () => {
    serveRows();
    const ctr = await callRoute('/api/contract-pricing');
    expect(ctr.body.fullBack.perThousandRates).toBeDefined();

    const decg = await callRoute('/api/decg-pricing');
    expect(decg.body.fullBack.perThousandRates).toBeUndefined();
    expect(decg.body.fullBack.ratePerThousand).toBeUndefined();
  });

  test('the stale 8-piece minimum is gone — under 8 is allowed, with the fee', async () => {
    serveRows();
    const decg = await callRoute('/api/decg-pricing');
    expect(decg.body.fullBack.minQuantity).toBeUndefined();
    expect(decg.body.fullBack.ltmFee).toBe(50);
  });

  test('DECG garment/cap LTM now genuinely comes from Caspio', async () => {
    // Previously a hardcoded 50 that merely happened to match, so editing Caspio did
    // nothing. Feed a DIFFERENT value and it must come through.
    mockFetchAllCaspioPages.mockImplementation(async (_t, params) => {
      const where = (params && params['q.where']) || '';
      if (where.includes('DECG-FB') && !where.includes('OR')) return DECG_FB_ROWS;
      return [
        { ItemType: 'DECG-Garmt', TierLabel: '1-7', EmbroideryCost: 28, LTM: 75 },
        { ItemType: 'DECG-Cap', TierLabel: '1-7', EmbroideryCost: 22.5, LTM: 75 },
        ...DECG_FB_ROWS,
      ];
    });
    const decg = await callRoute('/api/decg-pricing');
    expect(decg.body.garments.ltmFee).toBe(75);
    expect(decg.body.caps.ltmFee).toBe(75);
  });
});
