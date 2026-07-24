/**
 * Route tests for GET /api/products/search (src/routes/products.js).
 *
 * Locks the 2026-07-23 fixes:
 *  1. Default status filter = PRODUCT_STATUS<>'Discontinued' (parity with
 *     /api/search and /api/products-by-*). The old PRODUCT_STATUS='Active'
 *     equality silently hid every PRODUCT_STATUS='New' row (all Fall-2026
 *     arrivals) from catalog search.
 *  2. ?styleNumbers=A,B,C exact-list filter (curated-page hydration) with
 *     whitelist sanitization — injection tokens are dropped, never interpolated.
 *  3. Cap embroidery-config fallback: 'New' rows ship with an empty
 *     CATEGORY_NAME, so cap detection falls back to a \bcap\b title test.
 *
 * Mounts the real router on an ephemeral express server with Caspio mocked.
 */

jest.mock('../../src/utils/caspio', () => ({
  makeCaspioRequest: jest.fn(),
  fetchAllCaspioPages: jest.fn()
}));

jest.mock('../../src/routes/sanmar-product-data', () => ({
  getActiveColors: jest.fn().mockResolvedValue(null)
}));

jest.mock('../../src/utils/catalog-display-price', () => {
  const actual = jest.requireActual('../../src/utils/catalog-display-price');
  return {
    ...actual,
    getDecoratedDisplayPricingConfig: jest.fn()
  };
});

const express = require('express');
const axios = require('axios');
const { fetchAllCaspioPages } = require('../../src/utils/caspio');
const { getDecoratedDisplayPricingConfig } = require('../../src/utils/catalog-display-price');
const productsRouter = require('../../src/routes/products');

// Distinct emb costs so a wrong cap/garment pick changes the computed price.
const PRICING_CONFIG = {
  garment: { marginDenominator: 0.5, roundingMethod: 'CeilDollar', embCost: 10 },
  cap: { marginDenominator: 0.5, roundingMethod: 'CeilDollar', embCost: 5 }
};

function bulkRow(over) {
  return {
    PK_ID: 1, STYLE: 'NF0A8JEV', PRODUCT_TITLE: 'The North Face Iron Drift Quilted Jacket NF0A8JEV',
    PRODUCT_DESCRIPTION: 'desc', BRAND_NAME: 'The North Face', CATEGORY_NAME: '',
    SUBCATEGORY_NAME: '', PRODUCT_STATUS: 'New', KEYWORDS: '', PIECE_PRICE: 97,
    DOZEN_PRICE: 97, CASE_PRICE: 87, MSRP: null, MAP_PRICING: null,
    COLOR_NAME: 'Taupe', CATALOG_COLOR: 'Taupe', SIZE: 'M', QTY: 5,
    ...over
  };
}

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
  if (server.closeAllConnections) server.closeAllConnections();
  server.close(() => resolve());
}));

beforeEach(() => {
  fetchAllCaspioPages.mockReset();
  getDecoratedDisplayPricingConfig.mockReset();
  getDecoratedDisplayPricingConfig.mockResolvedValue(PRICING_CONFIG);
});

// Route Caspio calls by table path: Phase-1 style query + Phase-2 variant fetch
// hit Sanmar_Bulk; the non-SanMar merge hits Non_SanMar_Products (return []).
function mockBulk(rows) {
  fetchAllCaspioPages.mockImplementation((path) => {
    if (String(path).includes('Non_SanMar_Products')) return Promise.resolve([]);
    return Promise.resolve(rows);
  });
}

function bulkWhereClauses() {
  return fetchAllCaspioPages.mock.calls
    .filter(([path]) => String(path).includes('Sanmar_Bulk'))
    .map(([, params]) => params['q.where']);
}

describe('GET /api/products/search — status filter default', () => {
  test("no status param → WHERE uses PRODUCT_STATUS<>'Discontinued' and returns 'New' rows", async () => {
    mockBulk([bulkRow()]);

    const res = await axios.get(`${baseUrl}/api/products/search?q=NF0A8JEV&refresh=true`, { validateStatus: () => true });

    expect(res.status).toBe(200);
    const where = bulkWhereClauses()[0];
    expect(where).toContain("PRODUCT_STATUS<>'Discontinued'");
    expect(where).not.toContain("PRODUCT_STATUS='Active'");
    expect(res.data.data.products.map(p => p.styleNumber)).toContain('NF0A8JEV');
    expect(res.data.data.metadata.filters.status).toBe('not-discontinued');
  });

  test('explicit ?status=Active still filters by equality', async () => {
    mockBulk([]);

    await axios.get(`${baseUrl}/api/products/search?q=PC54&status=Active&refresh=true`, { validateStatus: () => true });

    expect(bulkWhereClauses()[0]).toContain("PRODUCT_STATUS='Active'");
  });

  test('?status=all applies no status condition', async () => {
    mockBulk([]);

    await axios.get(`${baseUrl}/api/products/search?q=PC54&status=all&refresh=true`, { validateStatus: () => true });

    expect(bulkWhereClauses()[0]).not.toContain('PRODUCT_STATUS');
  });
});

describe('GET /api/products/search — styleNumbers list filter', () => {
  test('CSV builds STYLE IN (…) with uppercased sanitized tokens', async () => {
    mockBulk([bulkRow(), bulkRow({ PK_ID: 2, STYLE: 'FF6277', PRODUCT_TITLE: 'Flexfit Wooly Combed Cap FF6277', CASE_PRICE: 8.35, PIECE_PRICE: 10, SIZE: 'S/M' })]);

    const res = await axios.get(`${baseUrl}/api/products/search?styleNumbers=nf0a8jev,FF6277&limit=50&refresh=true`, { validateStatus: () => true });

    expect(res.status).toBe(200);
    expect(bulkWhereClauses()[0]).toContain("STYLE IN ('NF0A8JEV','FF6277')");
    expect(res.data.data.products).toHaveLength(2);
  });

  test('injection tokens are dropped, never interpolated', async () => {
    mockBulk([bulkRow()]);

    await axios.get(`${baseUrl}/api/products/search?styleNumbers=${encodeURIComponent("NF0A8JEV,PC54') OR 1=1--")}&refresh=true`, { validateStatus: () => true });

    const where = bulkWhereClauses()[0];
    expect(where).toContain("STYLE IN ('NF0A8JEV')");
    expect(where).not.toContain('1=1');
  });

  test('styleNumbers request skips the non-SanMar page-1 merge', async () => {
    mockBulk([bulkRow()]);

    await axios.get(`${baseUrl}/api/products/search?styleNumbers=NF0A8JEV&refresh=true`, { validateStatus: () => true });

    const nsCalls = fetchAllCaspioPages.mock.calls.filter(([path]) => String(path).includes('Non_SanMar_Products'));
    expect(nsCalls).toHaveLength(0);
  });
});

describe('GET /api/products/search — displayPrice cap fallback', () => {
  test("empty-category 'Cap' title uses cap emb config; non-cap uses garment", async () => {
    // cost 87 garment: 87/0.5 + 10 = 184 → cheapest-size base; cap 8.35/0.5 + 5 = 21.7 → ceil 22
    mockBulk([
      bulkRow(),
      bulkRow({ PK_ID: 2, STYLE: 'FF6277', PRODUCT_TITLE: 'Flexfit Wooly Combed Cap FF6277', CASE_PRICE: 8.35, PIECE_PRICE: 10, SIZE: 'S/M' })
    ]);

    const res = await axios.get(`${baseUrl}/api/products/search?styleNumbers=NF0A8JEV,FF6277&limit=50&refresh=true`, { validateStatus: () => true });

    const byStyle = Object.fromEntries(res.data.data.products.map(p => [p.styleNumber, p]));
    expect(byStyle.FF6277.displayPrice).toBe(22);           // cap config (embCost 5)
    expect(byStyle.NF0A8JEV.displayPrice).toBe(184);        // garment config (embCost 10)
    expect(byStyle.FF6277.displayPriceLabel).toContain('22');
  });
});
