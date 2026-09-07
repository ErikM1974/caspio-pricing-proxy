// GET /api/product-heads/:style (2026-09-07) — the whole-catalog head map that
// replaces one /api/product-details Sanmar_Bulk read per crawled product page.
//
// Pinned here:
//   • the map is ONE catalog query (MIN(PK_ID) per STYLE, ordered, paged) and
//     every later style lookup costs ZERO Caspio calls
//   • concurrent cold requests share a single build
//   • unknown style → 404; a rep-added Non_SanMar_Products style is served
//   • Product_Copy overrides the description without mutating the cached row
//   • ?refresh=true rebuilds; /api/product-cache/clear drops the map
//   • an empty catalog read is a 502 and is never pinned
//   • a malformed style is a 400 before any Caspio read

jest.mock('../../src/utils/caspio', () => ({
  fetchAllCaspioPages: jest.fn(),
  makeCaspioRequest: jest.fn(),
}));

const express = require('express');
const { fetchAllCaspioPages } = require('../../src/utils/caspio');
const { clearAll } = require('../../src/utils/ttl-cache');
const productsRouter = require('../../src/routes/products');

const CATALOG = [
  { STYLE: 'PC54', PRODUCT_TITLE: 'Port & Co Core Cotton Tee. PC54', BRAND_NAME: 'Port & Co', PRODUCT_DESCRIPTION: 'SanMar boilerplate', CATEGORY_NAME: 'T-Shirts', PRODUCT_IMAGE: 'PC54.jpg', FRONT_MODEL: 'PC54_black_model_front.jpg', PRODUCT_STATUS: 'Active' },
  { STYLE: 'K500', PRODUCT_TITLE: 'Silk Touch Polo. K500', BRAND_NAME: 'Port Authority', PRODUCT_DESCRIPTION: 'Polo copy', CATEGORY_NAME: 'Polos/Knits', PRODUCT_IMAGE: 'K500.jpg', FRONT_MODEL: '', PRODUCT_STATUS: 'Active' },
];
const NON_SANMAR = [
  { StyleNumber: 'SS1000', ProductName: 'Vendor Hoodie', Brand: 'S&S', Notes: 'Vendor copy', Category: 'Sweatshirts/Fleece', ImageURL: 'ss1000.jpg', IsActive: 1 },
];
let productCopy = [];

function catalogCalls() {
  return fetchAllCaspioPages.mock.calls.filter(([resource]) => resource.includes('Sanmar_Bulk'));
}

let server;
let baseUrl;
beforeAll((done) => {
  const app = express();
  app.use('/api', productsRouter);
  server = app.listen(0, () => { baseUrl = `http://127.0.0.1:${server.address().port}`; done(); });
});
afterAll((done) => {
  server.closeAllConnections(); // undici keeps sockets alive; close() would wait on them
  server.close(done);
});

beforeEach(() => {
  clearAll();
  productCopy = [];
  fetchAllCaspioPages.mockReset();
  fetchAllCaspioPages.mockImplementation(async (resource) => {
    if (resource.includes('Sanmar_Bulk')) return CATALOG;
    if (resource.includes('Product_Copy')) return productCopy;
    if (resource.includes('Non_SanMar_Products')) return NON_SANMAR;
    return [];
  });
});

const get = async (path) => {
  const r = await fetch(`${baseUrl}${path}`);
  return { status: r.status, body: await r.json(), cacheControl: r.headers.get('cache-control') };
};

test('one catalog query builds the map; every later style is free', async () => {
  const a = await get('/api/product-heads/PC54');
  expect(a.status).toBe(200);
  expect(a.body).toMatchObject({ STYLE: 'PC54', PRODUCT_TITLE: 'Port & Co Core Cotton Tee. PC54', BRAND_NAME: 'Port & Co', CATEGORY_NAME: 'T-Shirts', FRONT_MODEL: 'PC54_black_model_front.jpg', source: 'sanmar' });
  expect(a.cacheControl).toBe('public, max-age=3600');
  expect(catalogCalls()).toHaveLength(1);
  const [, params, options] = catalogCalls()[0];
  expect(params['q.where']).toBe('PK_ID IN (SELECT MIN(PK_ID) FROM Sanmar_Bulk_251816_Feb2024 GROUP BY STYLE)');
  expect(params['q.select']).toBe('STYLE, PRODUCT_TITLE, BRAND_NAME, PRODUCT_DESCRIPTION, CATEGORY_NAME, PRODUCT_IMAGE, FRONT_MODEL, PRODUCT_STATUS');
  expect(params['q.orderBy']).toBe('STYLE');
  expect(params['q.pageSize']).toBe(1000);
  expect(options).toEqual({ maxPages: 20 });

  const b = await get('/api/product-heads/k500'); // case-insensitive
  expect(b.status).toBe(200);
  expect(b.body.STYLE).toBe('K500');
  await get('/api/product-heads/PC54');
  expect(catalogCalls()).toHaveLength(1);
});

test('concurrent cold requests share one build', async () => {
  const results = await Promise.all(['PC54', 'K500', 'PC54', 'K500', 'PC54'].map((s) => get(`/api/product-heads/${s}`)));
  expect(results.map((r) => r.status)).toEqual([200, 200, 200, 200, 200]);
  expect(catalogCalls()).toHaveLength(1);
});

test('unknown style is a 404; a Non_SanMar_Products style is served', async () => {
  const miss = await get('/api/product-heads/NOPE99');
  expect(miss.status).toBe(404);
  const ns = await get('/api/product-heads/SS1000');
  expect(ns.status).toBe(200);
  expect(ns.body).toMatchObject({ STYLE: 'SS1000', PRODUCT_TITLE: 'Vendor Hoodie', BRAND_NAME: 'S&S', PRODUCT_DESCRIPTION: 'Vendor copy', PRODUCT_IMAGE: 'ss1000.jpg', source: 'non-sanmar' });
  expect(catalogCalls()).toHaveLength(1);
});

test('Product_Copy overrides the description on a clone — the cached row is untouched', async () => {
  // The copy map is module state with its own 10-min TTL (shared with
  // product-details), so step the clock past it to force a reload each time.
  const realNow = Date.now();
  const nowSpy = jest.spyOn(Date, 'now');
  try {
    nowSpy.mockImplementation(() => realNow + 11 * 60 * 1000);
    productCopy = [{ Style: 'PC54', Custom_Description: 'NWCA custom copy' }];
    const a = await get('/api/product-heads/PC54');
    expect(a.body.PRODUCT_DESCRIPTION).toBe('NWCA custom copy');
    expect((await get('/api/product-heads/K500')).body.PRODUCT_DESCRIPTION).toBe('Polo copy');

    // Copy row removed + copy map expired: the SanMar description must come
    // back, which it only can if the overlay never wrote into the cached row.
    nowSpy.mockImplementation(() => realNow + 22 * 60 * 1000);
    productCopy = [];
    expect((await get('/api/product-heads/PC54')).body.PRODUCT_DESCRIPTION).toBe('SanMar boilerplate');
    expect(catalogCalls()).toHaveLength(1); // the 24 h head map never rebuilt
  } finally {
    nowSpy.mockRestore();
  }
});

test('?refresh=true rebuilds; /api/product-cache/clear drops the map', async () => {
  await get('/api/product-heads/PC54');
  expect(catalogCalls()).toHaveLength(1);
  await get('/api/product-heads/PC54?refresh=true');
  expect(catalogCalls()).toHaveLength(2);
  const cleared = await get('/api/product-cache/clear');
  expect(cleared.body.cleared['product-heads']).toBe(1);
  await get('/api/product-heads/PC54');
  expect(catalogCalls()).toHaveLength(3);
});

test('an empty catalog read is a 502 and is never pinned', async () => {
  fetchAllCaspioPages.mockImplementationOnce(async () => []);
  const bad = await get('/api/product-heads/PC54');
  expect(bad.status).toBe(502);
  const good = await get('/api/product-heads/PC54');
  expect(good.status).toBe(200);
  expect(catalogCalls()).toHaveLength(2);
});

test('a malformed style is a 400 before any Caspio read', async () => {
  const r = await get(`/api/product-heads/${'A'.repeat(31)}`); // over the 30-char sanitize bound
  expect(r.status).toBe(400);
  expect(fetchAllCaspioPages).not.toHaveBeenCalled();
});
