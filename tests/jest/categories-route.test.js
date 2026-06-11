/**
 * Route tests for GET /api/categories (src/routes/categories.js).
 * Mounts the real router on an ephemeral local express server with Caspio mocked —
 * no network, no dependence on what's deployed.
 */

jest.mock('../../src/utils/caspio', () => ({
  fetchAllCaspioPages: jest.fn()
}));

const express = require('express');
const axios = require('axios');
const { fetchAllCaspioPages } = require('../../src/utils/caspio');
const categoriesRouter = require('../../src/routes/categories');
const { buildCategoryCounts } = categoriesRouter;

const ROWS = [
  { STYLE: 'PC54', CATEGORY_NAME: 'T-Shirts' },
  { STYLE: 'PC61', CATEGORY_NAME: 'T-Shirts' },
  { STYLE: 'PC90H', CATEGORY_NAME: 'Sweatshirts/Fleece' },
  { STYLE: 'C112', CATEGORY_NAME: 'Caps' },
  { STYLE: 'C402', CATEGORY_NAME: 'Caps ' },        // trailing whitespace → merged into Caps
  { STYLE: 'XX01', CATEGORY_NAME: '' },             // blank → skipped
  { STYLE: 'XX02', CATEGORY_NAME: null }            // null → skipped
];

let server;
let baseUrl;

beforeAll((done) => {
  const app = express();
  app.use('/api', categoriesRouter);
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
});

describe('buildCategoryCounts', () => {
  test('counts unique style rows per category, skips blanks, trims whitespace', () => {
    expect(buildCategoryCounts(ROWS)).toEqual([
      { name: 'Caps', count: 2 },
      { name: 'T-Shirts', count: 2 },
      { name: 'Sweatshirts/Fleece', count: 1 }
    ]);
  });

  test('empty/missing input → empty list', () => {
    expect(buildCategoryCounts([])).toEqual([]);
    expect(buildCategoryCounts(null)).toEqual([]);
  });
});

describe('GET /api/categories', () => {
  test('returns { categories: [{ name, count }] } sorted by count desc', async () => {
    fetchAllCaspioPages.mockResolvedValue(ROWS);

    const res = await axios.get(`${baseUrl}/api/categories?refresh=true`, { validateStatus: () => true });

    expect(res.status).toBe(200);
    expect(res.data).toEqual({
      categories: [
        { name: 'Caps', count: 2 },
        { name: 'T-Shirts', count: 2 },
        { name: 'Sweatshirts/Fleece', count: 1 }
      ]
    });
    res.data.categories.forEach(cat => {
      expect(typeof cat.name).toBe('string');
      expect(typeof cat.count).toBe('number');
    });

    // Queries the same Active-products data the search facets use
    const [path, params] = fetchAllCaspioPages.mock.calls[0];
    expect(path).toContain('Sanmar_Bulk');
    expect(params['q.where']).toContain("PRODUCT_STATUS='Active'");
    expect(params['q.groupBy']).toContain('CATEGORY_NAME');
  });

  test('serves from 1h cache on subsequent requests (no extra Caspio call)', async () => {
    fetchAllCaspioPages.mockResolvedValue(ROWS);

    await axios.get(`${baseUrl}/api/categories?refresh=true`);
    const callsAfterFirst = fetchAllCaspioPages.mock.calls.length;
    const res = await axios.get(`${baseUrl}/api/categories`);

    expect(res.status).toBe(200);
    expect(fetchAllCaspioPages.mock.calls.length).toBe(callsAfterFirst);
    expect(res.data.categories.length).toBeGreaterThan(0);
  });

  test('Caspio failure → visible 500, no stale/hardcoded fallback', async () => {
    fetchAllCaspioPages.mockRejectedValue(new Error('Caspio down'));

    const res = await axios.get(`${baseUrl}/api/categories?refresh=true`, { validateStatus: () => true });

    expect(res.status).toBe(500);
    expect(res.data.error).toBe('Failed to fetch categories');
    expect(res.data.categories).toBeUndefined();
  });
});
