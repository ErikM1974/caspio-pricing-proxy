// Top-sellers tables are read through a shared 15-min row cache (2026-09-06).
//
// Measured on the production meter over one 14-hour window BEFORE this change:
// Safety_Stripe_Top_Sellers_2026 (15 rows) was read 557 times and
// DTG_Top_Sellers_2026 (143 rows) 456 times — one Caspio call per request,
// because the only guard was a CDN Cache-Control header. These tests pin the
// contract of src/utils/top-sellers-cache.js as the three routes use it:
//   • a repeat request with the same filters costs ZERO Caspio calls
//   • different filters are different cache keys (Caspio still does the filtering)
//   • ?refresh=true re-reads Caspio (and refreshes the entry)
//   • an empty read is NOT pinned
//   • /api/product-cache/clear (ttl-cache clearAll) empties it
//   • a Caspio failure is still surfaced by the route, never masked by stale rows

const mockFetchAllCaspioPages = jest.fn();
jest.mock('../../src/utils/caspio', () => ({
  fetchAllCaspioPages: (...a) => mockFetchAllCaspioPages(...a),
  makeCaspioRequest: jest.fn(),
}));

const express = require('express');
const { clearAll } = require('../../src/utils/ttl-cache');
const { readTopSellerRows, clearTopSellerRowsCache } = require('../../src/utils/top-sellers-cache');
const dtgRouter = require('../../src/routes/dtg-top-sellers');
const safetyRouter = require('../../src/routes/safety-stripe-top-sellers');
const embRouter = require('../../src/routes/emb-top-sellers');

const DTG_ROWS = [
  { style: 'PC61', style_rank: 1, product_title: 'Essential Tee', category: 'T-Shirt', color_name: 'Black', catalog_color: 'Black', color_rank: 1, total_units_sold: 900, color_units_sold: 500 },
  { style: 'PC61', style_rank: 1, product_title: 'Essential Tee', category: 'T-Shirt', color_name: 'Navy', catalog_color: 'Navy', color_rank: 2, total_units_sold: 900, color_units_sold: 400 },
  { style: 'PC78H', style_rank: 2, product_title: 'Core Fleece Hoodie', category: 'Hoodie', color_name: 'Black', catalog_color: 'Black', color_rank: 1, total_units_sold: 300, color_units_sold: 300 },
];
const SAFETY_ROWS = [
  { style: 'PC55', style_rank: 1, product_title: 'Core Blend Tee', category: 'T-Shirt', color_name: 'Safety Green', catalog_color: 'Safety Green', color_rank: 1, units_sold: 1200, is_active: 'Yes' },
  { style: 'PC55', style_rank: 1, product_title: 'Core Blend Tee', category: 'T-Shirt', color_name: 'Safety Orange', catalog_color: 'Safety Orange', color_rank: 2, units_sold: 800, is_active: 'Yes' },
];

beforeEach(() => {
  mockFetchAllCaspioPages.mockReset();
  clearTopSellerRowsCache();
});

async function call(router, path) {
  const app = express();
  app.use('/api', router);
  const server = app.listen(0);
  try {
    const { port } = server.address();
    const res = await fetch(`http://127.0.0.1:${port}${path}`);
    return { status: res.status, body: await res.json() };
  } finally {
    server.close();
  }
}

describe('readTopSellerRows (the helper)', () => {
  test('second read with the same query is served from cache — zero Caspio calls', async () => {
    mockFetchAllCaspioPages.mockResolvedValue(DTG_ROWS);
    const params = { 'q.orderBy': 'style_rank ASC, color_rank ASC' };
    const a = await readTopSellerRows('/tables/DTG_Top_Sellers_2026/records', params);
    const b = await readTopSellerRows('/tables/DTG_Top_Sellers_2026/records', params);
    expect(a).toBe(b);
    expect(mockFetchAllCaspioPages).toHaveBeenCalledTimes(1);
  });

  test('the key carries the WHERE clause — a filtered read never serves another filter', async () => {
    mockFetchAllCaspioPages.mockImplementation(async (_r, params) =>
      (params['q.where'] || '').includes('Hoodie') ? [DTG_ROWS[2]] : DTG_ROWS
    );
    const all = await readTopSellerRows('/tables/DTG_Top_Sellers_2026/records', { 'q.orderBy': 'style_rank ASC' });
    const hoodies = await readTopSellerRows('/tables/DTG_Top_Sellers_2026/records', { 'q.where': "category='Hoodie'", 'q.orderBy': 'style_rank ASC' });
    expect(all).toHaveLength(3);
    expect(hoodies).toHaveLength(1);
    expect(mockFetchAllCaspioPages).toHaveBeenCalledTimes(2);
    // The cached copy of each stays distinct.
    expect(await readTopSellerRows('/tables/DTG_Top_Sellers_2026/records', { 'q.where': "category='Hoodie'", 'q.orderBy': 'style_rank ASC' })).toHaveLength(1);
    expect(mockFetchAllCaspioPages).toHaveBeenCalledTimes(2);
  });

  test('the key carries the table — two tables with identical params do not collide', async () => {
    mockFetchAllCaspioPages.mockImplementation(async (resource) =>
      resource.includes('Safety') ? SAFETY_ROWS : DTG_ROWS
    );
    const params = { 'q.orderBy': 'style_rank ASC, color_rank ASC' };
    const dtg = await readTopSellerRows('/tables/DTG_Top_Sellers_2026/records', params);
    const safety = await readTopSellerRows('/tables/Safety_Stripe_Top_Sellers_2026/records', params);
    expect(dtg[0].style).toBe('PC61');
    expect(safety[0].style).toBe('PC55');
    expect(mockFetchAllCaspioPages).toHaveBeenCalledTimes(2);
  });

  test('force:true re-reads Caspio and refreshes the entry', async () => {
    mockFetchAllCaspioPages.mockResolvedValueOnce(DTG_ROWS).mockResolvedValueOnce([DTG_ROWS[0]]);
    const params = {};
    await readTopSellerRows('/tables/DTG_Top_Sellers_2026/records', params);
    const forced = await readTopSellerRows('/tables/DTG_Top_Sellers_2026/records', params, { force: true });
    expect(forced).toHaveLength(1);
    expect(mockFetchAllCaspioPages).toHaveBeenCalledTimes(2);
    // The forced read replaced the cached rows.
    expect(await readTopSellerRows('/tables/DTG_Top_Sellers_2026/records', params)).toHaveLength(1);
    expect(mockFetchAllCaspioPages).toHaveBeenCalledTimes(2);
  });

  test('an empty read is returned but NOT pinned for 15 minutes', async () => {
    mockFetchAllCaspioPages.mockResolvedValueOnce([]).mockResolvedValueOnce(DTG_ROWS);
    expect(await readTopSellerRows('/tables/DTG_Top_Sellers_2026/records', {})).toEqual([]);
    expect(await readTopSellerRows('/tables/DTG_Top_Sellers_2026/records', {})).toHaveLength(3);
    expect(mockFetchAllCaspioPages).toHaveBeenCalledTimes(2);
  });

  test('a Caspio failure propagates — nothing stale is served in its place', async () => {
    mockFetchAllCaspioPages.mockRejectedValue(new Error('Caspio 502'));
    await expect(readTopSellerRows('/tables/DTG_Top_Sellers_2026/records', {})).rejects.toThrow('Caspio 502');
  });

  test('ttl-cache clearAll (what /api/product-cache/clear calls) empties it', async () => {
    mockFetchAllCaspioPages.mockResolvedValue(DTG_ROWS);
    await readTopSellerRows('/tables/DTG_Top_Sellers_2026/records', {});
    const cleared = clearAll();
    expect(cleared['top-seller-rows']).toBe(1);
    await readTopSellerRows('/tables/DTG_Top_Sellers_2026/records', {});
    expect(mockFetchAllCaspioPages).toHaveBeenCalledTimes(2);
  });
});

describe('the routes read through the cache', () => {
  test('GET /api/dtg/top-sellers twice = one Caspio call, identical payloads', async () => {
    mockFetchAllCaspioPages.mockResolvedValue(DTG_ROWS);
    const first = await call(dtgRouter, '/api/dtg/top-sellers');
    const second = await call(dtgRouter, '/api/dtg/top-sellers');
    expect(first.status).toBe(200);
    expect(first.body.count).toBe(3);
    expect(first.body.uniqueStyles).toBe(2);
    expect(second.body).toEqual(first.body);
    expect(mockFetchAllCaspioPages).toHaveBeenCalledTimes(1);
  });

  test('GET /api/dtg/top-sellers?category=Hoodie is its own key (Caspio still filters)', async () => {
    mockFetchAllCaspioPages.mockImplementation(async (_r, params) =>
      (params['q.where'] || '').includes('Hoodie') ? [DTG_ROWS[2]] : DTG_ROWS
    );
    await call(dtgRouter, '/api/dtg/top-sellers');
    const hoodie = await call(dtgRouter, '/api/dtg/top-sellers?category=Hoodie');
    expect(hoodie.body.count).toBe(1);
    expect(hoodie.body.records[0].style).toBe('PC78H');
    expect(mockFetchAllCaspioPages).toHaveBeenCalledTimes(2);
    expect(mockFetchAllCaspioPages.mock.calls[1][1]['q.where']).toBe("category='Hoodie'");
  });

  test('GET /api/dtg/top-sellers/categories twice = one Caspio call', async () => {
    mockFetchAllCaspioPages.mockResolvedValue(DTG_ROWS);
    const a = await call(dtgRouter, '/api/dtg/top-sellers/categories');
    const b = await call(dtgRouter, '/api/dtg/top-sellers/categories');
    expect(a.body.categories.map(c => c.category).sort()).toEqual(['Hoodie', 'T-Shirt']);
    expect(b.body).toEqual(a.body);
    expect(mockFetchAllCaspioPages).toHaveBeenCalledTimes(1);
  });

  test('?refresh=true on a route bypasses the cache', async () => {
    mockFetchAllCaspioPages.mockResolvedValue(DTG_ROWS);
    await call(dtgRouter, '/api/dtg/top-sellers');
    await call(dtgRouter, '/api/dtg/top-sellers?refresh=true');
    expect(mockFetchAllCaspioPages).toHaveBeenCalledTimes(2);
  });

  test('GET /api/safety-stripes/top-sellers twice = one Caspio call, is_active still applied', async () => {
    mockFetchAllCaspioPages.mockResolvedValue([...SAFETY_ROWS, { ...SAFETY_ROWS[0], color_name: 'Retired', color_rank: 9, is_active: 'No' }]);
    const a = await call(safetyRouter, '/api/safety-stripes/top-sellers');
    const b = await call(safetyRouter, '/api/safety-stripes/top-sellers');
    expect(a.status).toBe(200);
    expect(a.body.count).toBe(2);                 // the is_active='No' row is filtered every time
    expect(b.body).toEqual(a.body);
    expect(mockFetchAllCaspioPages).toHaveBeenCalledTimes(1);
  });

  test('GET /api/emb/top-sellers twice = one Caspio call', async () => {
    mockFetchAllCaspioPages.mockResolvedValue(DTG_ROWS);
    await call(embRouter, '/api/emb/top-sellers');
    const b = await call(embRouter, '/api/emb/top-sellers');
    expect(b.status).toBe(200);
    expect(mockFetchAllCaspioPages).toHaveBeenCalledTimes(1);
  });

  test('a Caspio failure still returns the route\'s error status (502 safety, 500 dtg)', async () => {
    mockFetchAllCaspioPages.mockRejectedValue(new Error('Caspio down'));
    expect((await call(safetyRouter, '/api/safety-stripes/top-sellers')).status).toBe(502);
    expect((await call(dtgRouter, '/api/dtg/top-sellers')).status).toBe(500);
  });
});
