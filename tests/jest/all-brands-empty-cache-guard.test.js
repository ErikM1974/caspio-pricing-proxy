/**
 * Regression lock for the 2026-07-25 "No brands available" outage.
 *
 * The homepage Brands mega-dropdown went blank. Root cause was NOT the front
 * end: /api/all-brands cached its own empty result. The guard was
 * `if (!allBrandsCache.data || …)` over a plain `{at, data}` object, and `[]` is
 * TRUTHY in JS — so one bad Caspio read pinned an empty array for 24h in the
 * dyno AND shipped `Cache-Control: max-age=21600`, freezing "no brands" into
 * every visitor's browser for 6h with no revalidation. `catch` never fired, so
 * nothing logged an error.
 *
 * These tests lock the three properties that make that impossible:
 *   1. an empty upstream read is NEVER cached and NEVER returned as a
 *      cacheable 200 — it's a 503 + no-store, so the next request retries;
 *   2. an empty read cannot evict/overwrite a known-good cached list;
 *   3. the success response carries a short max-age (not 6h), so a bad window
 *      self-heals in minutes rather than being frozen into browsers.
 *
 * Mounts the real router on an ephemeral express server with Caspio mocked —
 * no network, no dependence on what's deployed. Covers /api/all-categories too,
 * which carried the identical copy-pasted bug.
 */

jest.mock('../../src/utils/caspio', () => ({
  fetchAllCaspioPages: jest.fn(),
  makeCaspioRequest: jest.fn()
}));

const express = require('express');
const axios = require('axios');
const { fetchAllCaspioPages } = require('../../src/utils/caspio');
const { clearAll } = require('../../src/utils/ttl-cache');
const productsRouter = require('../../src/routes/products');

// Two brands, three style rows — mirrors the real groupBy shape
// (BRAND_NAME, BRAND_LOGO_IMAGE, STYLE), one row per style.
const BRAND_ROWS = [
  { BRAND_NAME: 'Carhartt', BRAND_LOGO_IMAGE: 'https://cdnm.sanmar.com/catalog/images/Carharttheader.jpg', STYLE: 'CT104670' },
  { BRAND_NAME: 'Carhartt', BRAND_LOGO_IMAGE: 'https://cdnm.sanmar.com/catalog/images/Carharttheader.jpg', STYLE: 'CTK87' },
  { BRAND_NAME: 'Richardson', BRAND_LOGO_IMAGE: 'https://cdnm.sanmar.com/catalog/images/richardsonheader.jpg', STYLE: '112' }
];

// Rows that survive the fetch but yield zero usable brands — the exact shape
// that poisoned the cache (truthy `[]` after filtering).
const UNUSABLE_ROWS = [
  { BRAND_NAME: null, BRAND_LOGO_IMAGE: '', STYLE: 'PC54' },
  { BRAND_NAME: 'Gildan', BRAND_LOGO_IMAGE: '', STYLE: null }
];

const CATEGORY_ROWS = [
  { CATEGORY_NAME: 'T-Shirts' },
  { CATEGORY_NAME: 'Caps' }
];

let server;
let baseUrl;

beforeAll((done) => {
  const app = express();
  app.use('/api', productsRouter);
  server = app.listen(0, () => {
    baseUrl = `http://127.0.0.1:${server.address().port}`;
    done();
  });
});

afterAll(() => new Promise((resolve) => {
  if (server.closeAllConnections) server.closeAllConnections(); // drop keep-alive sockets
  server.close(() => resolve());
}));

beforeEach(() => {
  fetchAllCaspioPages.mockReset();
  clearAll(); // the ttl-cache registry is module-scoped and shared across tests
});

const get = (path) => axios.get(`${baseUrl}${path}`, { validateStatus: () => true });

describe('GET /api/all-brands — happy path', () => {
  test('groups rows into {brand, logo, sampleStyles}', async () => {
    fetchAllCaspioPages.mockResolvedValue(BRAND_ROWS);

    const res = await get('/api/all-brands');

    expect(res.status).toBe(200);
    expect(res.data).toEqual([
      {
        brand: 'Carhartt',
        logo: 'https://cdnm.sanmar.com/catalog/images/Carharttheader.jpg',
        sampleStyles: ['CT104670', 'CTK87']
      },
      {
        brand: 'Richardson',
        logo: 'https://cdnm.sanmar.com/catalog/images/richardsonheader.jpg',
        sampleStyles: ['112']
      }
    ]);
  });

  test('keeps the stable q.orderBy that prevents silent row drops across pages', async () => {
    fetchAllCaspioPages.mockResolvedValue(BRAND_ROWS);

    await get('/api/all-brands');

    const [path, params] = fetchAllCaspioPages.mock.calls[0];
    expect(path).toContain('Sanmar_Bulk');
    expect(params['q.orderBy']).toBe('STYLE');
  });

  test('serves from cache on the second request (no extra Caspio call)', async () => {
    fetchAllCaspioPages.mockResolvedValue(BRAND_ROWS);

    await get('/api/all-brands');
    const callsAfterFirst = fetchAllCaspioPages.mock.calls.length;
    const res = await get('/api/all-brands');

    expect(res.status).toBe(200);
    expect(fetchAllCaspioPages.mock.calls.length).toBe(callsAfterFirst);
    expect(res.data).toHaveLength(2);
  });

  test('?refresh=true bypasses the cache — a dyno restart is no longer the only flush', async () => {
    fetchAllCaspioPages.mockResolvedValue(BRAND_ROWS);

    await get('/api/all-brands');
    const callsAfterFirst = fetchAllCaspioPages.mock.calls.length;
    await get('/api/all-brands?refresh=true');

    expect(fetchAllCaspioPages.mock.calls.length).toBe(callsAfterFirst + 1);
  });

  test('success is cacheable but SHORT-lived — never the old 6h max-age', async () => {
    fetchAllCaspioPages.mockResolvedValue(BRAND_ROWS);

    const res = await get('/api/all-brands');
    const cc = res.headers['cache-control'];

    expect(cc).toContain('max-age=600');
    expect(cc).toContain('stale-while-revalidate');
    // The value that froze the outage into every browser for 6 hours.
    expect(cc).not.toContain('21600');
  });
});

describe('GET /api/all-brands — the empty-result guard (the actual bug)', () => {
  test('zero usable brand rows → 503 + no-store, NOT a cacheable empty 200', async () => {
    fetchAllCaspioPages.mockResolvedValue(UNUSABLE_ROWS);

    const res = await get('/api/all-brands');

    expect(res.status).toBe(503);
    expect(res.data).not.toEqual([]);
    expect(res.data.error).toMatch(/unavailable/i);
    // no-store is what stops a browser inheriting the bad window for hours
    expect(res.headers['cache-control']).toBe('no-store');
  });

  test('a totally empty upstream read → 503, never an empty 200', async () => {
    fetchAllCaspioPages.mockResolvedValue([]);

    const res = await get('/api/all-brands');

    expect(res.status).toBe(503);
    expect(res.headers['cache-control']).toBe('no-store');
  });

  test('an empty read is not cached — the very next request retries and recovers', async () => {
    fetchAllCaspioPages.mockResolvedValueOnce([]);
    const bad = await get('/api/all-brands');
    expect(bad.status).toBe(503);

    // Caspio recovers. Under the old truthy-[] guard this stayed broken for 24h.
    fetchAllCaspioPages.mockResolvedValue(BRAND_ROWS);
    const good = await get('/api/all-brands');

    expect(good.status).toBe(200);
    expect(good.data).toHaveLength(2);
  });

  test('an empty read cannot overwrite an already-good cached list', async () => {
    fetchAllCaspioPages.mockResolvedValue(BRAND_ROWS);
    expect((await get('/api/all-brands')).status).toBe(200);

    // Force a refetch while upstream is broken: the 503 must not poison the cache.
    fetchAllCaspioPages.mockResolvedValue([]);
    expect((await get('/api/all-brands?refresh=true')).status).toBe(503);

    // Normal request still serves the known-good list.
    const res = await get('/api/all-brands');
    expect(res.status).toBe(200);
    expect(res.data).toHaveLength(2);
  });

  test('Caspio throwing → visible 500, no silent empty list', async () => {
    fetchAllCaspioPages.mockRejectedValue(new Error('Caspio down'));

    const res = await get('/api/all-brands');

    expect(res.status).toBe(500);
    expect(res.data.error).toBe('Failed to fetch brands');
    expect(Array.isArray(res.data)).toBe(false);
  });
});

describe('GET /api/all-categories — same guard (identical copy-pasted bug)', () => {
  test('happy path returns the category names with a short max-age', async () => {
    fetchAllCaspioPages.mockResolvedValue(CATEGORY_ROWS);

    const res = await get('/api/all-categories');

    expect(res.status).toBe(200);
    expect(res.data).toEqual(['T-Shirts', 'Caps']);
    expect(res.headers['cache-control']).toContain('max-age=600');
    expect(res.headers['cache-control']).not.toContain('21600');
  });

  test('blank/whitespace-only names filtered to nothing → 503 + no-store, not cached', async () => {
    fetchAllCaspioPages.mockResolvedValue([{ CATEGORY_NAME: '' }, { CATEGORY_NAME: '   ' }, { CATEGORY_NAME: null }]);

    const res = await get('/api/all-categories');

    expect(res.status).toBe(503);
    expect(res.headers['cache-control']).toBe('no-store');

    fetchAllCaspioPages.mockResolvedValue(CATEGORY_ROWS);
    const recovered = await get('/api/all-categories');
    expect(recovered.status).toBe(200);
    expect(recovered.data).toEqual(['T-Shirts', 'Caps']);
  });
});
