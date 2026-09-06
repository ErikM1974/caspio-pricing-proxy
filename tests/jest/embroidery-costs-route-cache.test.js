// The four /api/pricing routes that read Embroidery_Costs with NO cache now read
// through caspio-static-tables.getEmbroideryCostRows (2026-09-06).
//
// Why: Embroidery_Costs was the single largest table on the production meter —
// 2,209 reads in one 14-hour window for a 237-row table — and every other
// consumer of it was already cached. These four were not:
//   GET /api/embroidery-costs?itemType&stitchCount
//   GET /api/contract-pricing
//   GET /api/decg-pricing        (~8% of all proxy requests in a router-log sample)
//   GET /api/al-pricing
//
// Pinned here:
//   • a repeat request costs ZERO Caspio calls for the route's own query
//   • each route keys on its exact WHERE clause — no cross-route bleed
//   • ?refresh=true re-reads Caspio
//   • an empty read (the routes' 404 path) is NOT pinned
//   • POST / PUT / DELETE /embroidery-costs clear the cache so an edit made
//     through the proxy shows on the very next read
//   • clearStaticTableCaches() (what /api/product-cache/clear calls) reports it

const mockFetchAllCaspioPages = jest.fn();
const mockMakeCaspioRequest = jest.fn();
jest.mock('../../src/utils/caspio', () => ({
  fetchAllCaspioPages: (...a) => mockFetchAllCaspioPages(...a),
  makeCaspioRequest: (...a) => mockMakeCaspioRequest(...a),
}));

const express = require('express');
const pricingRouter = require('../../src/routes/pricing');
const st = require('../../src/utils/caspio-static-tables');

const DECG_FB_ROWS = [
  { ItemType: 'DECG-FB', TierLabel: '1-7', EmbroideryCost: 1.5, LTM: 50, BaseStitchCount: 25000 },
  { ItemType: 'DECG-FB', TierLabel: '72+', EmbroideryCost: 1.2, LTM: 0, BaseStitchCount: 25000 },
];
const DECG_ROWS = [
  { ItemType: 'DECG-Garmt', TierLabel: '1-7', EmbroideryCost: 28, LTM: 50 },
  { ItemType: 'DECG-Cap', TierLabel: '1-7', EmbroideryCost: 22.5, LTM: 50 },
  ...DECG_FB_ROWS,
];
const CTR_ROWS = [
  { ItemType: 'CTR-Garmt', TierLabel: '24-47', PerThousandRate: 0.55, LTM: 0 },
  { ItemType: 'CTR-Cap', TierLabel: '24-47', PerThousandRate: 0.5, LTM: 0 },
];
const AL_ROWS = [
  { ItemType: 'AL', TierLabel: '24-47', EmbroideryCost: 8, BaseStitchCount: 5000 },
  { ItemType: 'AL-CAP', TierLabel: '24-47', EmbroideryCost: 7, BaseStitchCount: 5000 },
];
const SHIRT_8000 = [
  { EmbroideryCostID: 11, ItemType: 'Shirt', StitchCount: 8000, TierLabel: '24-47', EmbroideryCost: 6.5 },
];

/** Route Caspio queries to fixtures by their WHERE clause, and count them. */
function serveRows() {
  mockFetchAllCaspioPages.mockImplementation(async (_table, params) => {
    const where = (params && params['q.where']) || '';
    if (where === "ItemType='DECG-FB'") return DECG_FB_ROWS;          // the ladder (own cache)
    if (where.includes('DECG-Garmt')) return DECG_ROWS;
    if (where.includes('CTR-Garmt')) return CTR_ROWS;
    if (where.includes("ItemType='AL'")) return AL_ROWS;
    if (where.includes("ItemType='Shirt' AND StitchCount=8000")) return SHIRT_8000;
    return [];
  });
}
const callsWhere = (needle) =>
  mockFetchAllCaspioPages.mock.calls.filter(([, p]) => ((p && p['q.where']) || '').includes(needle)).length;

beforeEach(() => {
  mockFetchAllCaspioPages.mockReset();
  mockMakeCaspioRequest.mockReset();
  st.clearStaticTableCaches();
  // The full-back ladder has its own ttl-cache; a forced read resets it per test.
  serveRows();
});

async function call(method, path, body) {
  const app = express();
  app.use(express.json());
  app.use('/api', pricingRouter);
  const server = app.listen(0);
  try {
    const { port } = server.address();
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: await res.json() };
  } finally {
    server.close();
  }
}

describe('getEmbroideryCostRows', () => {
  test('same WHERE twice = one Caspio call; different WHERE = its own call', async () => {
    const a = await st.getEmbroideryCostRows("ItemType='Shirt' AND StitchCount=8000");
    const b = await st.getEmbroideryCostRows("ItemType='Shirt' AND StitchCount=8000");
    const c = await st.getEmbroideryCostRows("ItemType='AL' OR ItemType='AL-CAP' OR ItemType='CB' OR ItemType='CS' OR ItemType='FB'");
    expect(a).toBe(b);
    expect(c).toBe(AL_ROWS);
    expect(mockFetchAllCaspioPages).toHaveBeenCalledTimes(2);
  });

  test('empty reads are not pinned', async () => {
    expect(await st.getEmbroideryCostRows("ItemType='Nope'")).toEqual([]);
    expect(await st.getEmbroideryCostRows("ItemType='Nope'")).toEqual([]);
    expect(mockFetchAllCaspioPages).toHaveBeenCalledTimes(2);
  });

  test('force re-reads; clearEmbroideryCostCache reports and empties', async () => {
    await st.getEmbroideryCostRows("ItemType='Shirt' AND StitchCount=8000");
    await st.getEmbroideryCostRows("ItemType='Shirt' AND StitchCount=8000", { force: true });
    expect(mockFetchAllCaspioPages).toHaveBeenCalledTimes(2);
    expect(st.clearEmbroideryCostCache()).toBe(1);
    await st.getEmbroideryCostRows("ItemType='Shirt' AND StitchCount=8000");
    expect(mockFetchAllCaspioPages).toHaveBeenCalledTimes(3);
  });

  test('clearStaticTableCaches reports the embroidery-costs entry count', async () => {
    await st.getEmbroideryCostRows("ItemType='Shirt' AND StitchCount=8000");
    expect(st.clearStaticTableCaches()['embroidery-costs']).toBe(1);
  });
});

describe('the four routes', () => {
  test('GET /api/decg-pricing twice: one DECG read, identical payloads', async () => {
    const first = await call('GET', '/api/decg-pricing');
    const second = await call('GET', '/api/decg-pricing');
    expect(first.status).toBe(200);
    expect(first.body.garments.basePrices['1-7']).toBe(28);
    expect(first.body.garments.ltmFee).toBe(50);
    expect(second.body).toEqual(first.body);
    expect(callsWhere('DECG-Garmt')).toBe(1);
  });

  test('GET /api/contract-pricing twice: one CTR read', async () => {
    const first = await call('GET', '/api/contract-pricing');
    await call('GET', '/api/contract-pricing');
    expect(first.status).toBe(200);
    expect(first.body.garments.perThousandRates['24-47']).toBe(0.55);
    expect(callsWhere('CTR-Garmt')).toBe(1);
  });

  test('GET /api/al-pricing twice: one AL read', async () => {
    const first = await call('GET', '/api/al-pricing');
    await call('GET', '/api/al-pricing');
    expect(first.status).toBe(200);
    expect(first.body.garments.basePrices['24-47']).toBe(8);
    expect(callsWhere("ItemType='AL'")).toBe(1);
  });

  test('GET /api/embroidery-costs keys on itemType + stitchCount', async () => {
    const a = await call('GET', '/api/embroidery-costs?itemType=Shirt&stitchCount=8000');
    const b = await call('GET', '/api/embroidery-costs?itemType=Shirt&stitchCount=8000');
    expect(a.status).toBe(200);
    expect(a.body).toEqual(SHIRT_8000);
    expect(b.body).toEqual(a.body);
    expect(callsWhere("ItemType='Shirt' AND StitchCount=8000")).toBe(1);
    // A different stitch count is a different query — and an empty answer is not pinned.
    const c = await call('GET', '/api/embroidery-costs?itemType=Shirt&stitchCount=9000');
    expect(c.body).toEqual([]);
    await call('GET', '/api/embroidery-costs?itemType=Shirt&stitchCount=9000');
    expect(callsWhere("StitchCount=9000")).toBe(2);
  });

  test('the routes do not share entries — contract never serves decg rows', async () => {
    await call('GET', '/api/contract-pricing');
    const decg = await call('GET', '/api/decg-pricing');
    expect(decg.body.garments.basePrices['1-7']).toBe(28);
    expect(callsWhere('CTR-Garmt')).toBe(1);
    expect(callsWhere('DECG-Garmt')).toBe(1);
  });

  test('?refresh=true re-reads Caspio', async () => {
    await call('GET', '/api/decg-pricing');
    await call('GET', '/api/decg-pricing?refresh=true');
    expect(callsWhere('DECG-Garmt')).toBe(2);
  });

  test('the 404 path (no rows) is re-checked against Caspio every time', async () => {
    mockFetchAllCaspioPages.mockImplementation(async (_t, params) =>
      ((params && params['q.where']) || '') === "ItemType='DECG-FB'" ? DECG_FB_ROWS : []
    );
    expect((await call('GET', '/api/al-pricing')).status).toBe(404);
    expect((await call('GET', '/api/al-pricing')).status).toBe(404);
    expect(callsWhere("ItemType='AL'")).toBe(2);
  });

  test('a Caspio failure surfaces as 500 — no stale rows', async () => {
    mockFetchAllCaspioPages.mockRejectedValue(new Error('Caspio down'));
    expect((await call('GET', '/api/decg-pricing')).status).toBe(500);
  });
});

describe('writes through the proxy invalidate the cache', () => {
  test.each([
    ['POST', '/api/embroidery-costs', { ItemType: 'Shirt', StitchCount: 8000, EmbroideryCost: 7 }],
    ['PUT', '/api/embroidery-costs/11', { EmbroideryCost: 7 }],
    ['DELETE', '/api/embroidery-costs/11', undefined],
  ])('%s %s clears it so the next GET re-reads', async (method, path, body) => {
    mockMakeCaspioRequest.mockResolvedValue({ success: true, RecordsAffected: 1 });
    await call('GET', '/api/embroidery-costs?itemType=Shirt&stitchCount=8000');
    expect(callsWhere('StitchCount=8000')).toBe(1);
    const w = await call(method, path, body);
    expect([200, 201]).toContain(w.status);
    await call('GET', '/api/embroidery-costs?itemType=Shirt&stitchCount=8000');
    expect(callsWhere('StitchCount=8000')).toBe(2);
  });
});
