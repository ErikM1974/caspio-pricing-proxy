/**
 * Cache-behavior tests for the products.js per-style endpoints
 * (/api/product-colors, /api/color-swatches, /api/product-details,
 * /api/stylesearch, /api/product-cache/clear) added in the 2026-07-18 Caspio
 * quota reduction. Hermetic: real router, mocked Caspio + mocked SanMar
 * active-colors feed.
 */

jest.mock('../../src/utils/caspio', () => ({
  makeCaspioRequest: jest.fn(),
  fetchAllCaspioPages: jest.fn()
}));

jest.mock('../../src/routes/sanmar-product-data', () => ({
  getActiveColors: jest.fn()
}));

const express = require('express');
const axios = require('axios');
const { fetchAllCaspioPages } = require('../../src/utils/caspio');
const { getActiveColors } = require('../../src/routes/sanmar-product-data');
const { clearAll } = require('../../src/utils/ttl-cache');
const { clearStaticTableCaches } = require('../../src/utils/caspio-static-tables');
const productsRouter = require('../../src/routes/products');

const PC61_ROWS = [
  {
    STYLE: 'PC61', PRODUCT_TITLE: 'Essential Tee', PRODUCT_DESCRIPTION: 'SanMar boilerplate',
    COLOR_NAME: 'Jet Black', CATALOG_COLOR: 'JetBlack', BRAND_NAME: 'Port & Company',
    FRONT_MODEL: 'front.jpg', BACK_MODEL: '', SIDE_MODEL: '', FRONT_FLAT: '', BACK_FLAT: '',
    PIECE_PRICE: 4, DOZEN_PRICE: 3.8, CASE_PRICE: 3.5,
    CATEGORY_NAME: 'T-Shirts', SUBCATEGORY_NAME: '', PRODUCT_STATUS: 'Active',
    PRODUCT_IMAGE: 'img.jpg', COLOR_SQUARE_IMAGE: 'sq.jpg', COLOR_SWATCH_IMAGE: 'sw.jpg',
    COMPANION_STYLES: '', PMS_COLOR: '', KEYWORDS: ''
  },
  {
    STYLE: 'PC61', PRODUCT_TITLE: 'Essential Tee', PRODUCT_DESCRIPTION: 'SanMar boilerplate',
    COLOR_NAME: 'Ash', CATALOG_COLOR: 'Ash', BRAND_NAME: 'Port & Company',
    FRONT_MODEL: 'front-ash.jpg', BACK_MODEL: '', SIDE_MODEL: '', FRONT_FLAT: '', BACK_FLAT: '',
    PIECE_PRICE: 4, DOZEN_PRICE: 3.8, CASE_PRICE: 3.5,
    CATEGORY_NAME: 'T-Shirts', SUBCATEGORY_NAME: '', PRODUCT_STATUS: 'Active',
    PRODUCT_IMAGE: 'img-ash.jpg', COLOR_SQUARE_IMAGE: 'sq-ash.jpg', COLOR_SWATCH_IMAGE: 'sw-ash.jpg',
    COMPANION_STYLES: '', PMS_COLOR: '', KEYWORDS: ''
  }
];

const PRODUCT_COPY_ROWS = [
  { Style: 'PC61', Custom_Description: 'NWCA custom copy' }
];

function mockCaspio({ bulk = PC61_ROWS, productCopy = PRODUCT_COPY_ROWS } = {}) {
  fetchAllCaspioPages.mockImplementation((path) => {
    if (path.includes('Sanmar_Bulk')) {
      return bulk instanceof Error ? Promise.reject(bulk) : Promise.resolve(bulk);
    }
    if (path.includes('Product_Copy')) return Promise.resolve(productCopy);
    return Promise.reject(new Error(`Unexpected table path: ${path}`));
  });
}

function bulkCalls() {
  return fetchAllCaspioPages.mock.calls.filter(([p]) => p.includes('Sanmar_Bulk')).length;
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
  getActiveColors.mockReset();
  // Both colors active by default — the discontinued filter runs cleanly.
  getActiveColors.mockResolvedValue(new Set(['jet black', 'ash']));
  clearAll();
  clearStaticTableCaches();
});

describe('GET /api/product-colors', () => {
  test('second request is a cache hit; includeDiscontinued=true is a distinct key', async () => {
    mockCaspio();

    const first = await axios.get(`${baseUrl}/api/product-colors?styleNumber=PC61`, { validateStatus: () => true });
    expect(first.status).toBe(200);
    expect(first.data.colors.length).toBe(2);
    expect(bulkCalls()).toBe(1);

    const second = await axios.get(`${baseUrl}/api/product-colors?styleNumber=PC61`, { validateStatus: () => true });
    expect(second.status).toBe(200);
    expect(bulkCalls()).toBe(1); // cache hit

    const withDisc = await axios.get(`${baseUrl}/api/product-colors?styleNumber=PC61&includeDiscontinued=true`, { validateStatus: () => true });
    expect(withDisc.status).toBe(200);
    expect(bulkCalls()).toBe(2); // separate cache entry → new fetch
  });

  test('SanMar active-colors unavailable → served fail-open but NOT cached', async () => {
    mockCaspio();
    getActiveColors.mockResolvedValue(null); // failed OR zero active — ambiguous

    const first = await axios.get(`${baseUrl}/api/product-colors?styleNumber=PC61`, { validateStatus: () => true });
    expect(first.status).toBe(200);
    expect(first.data.colors.length).toBe(2); // fail-open shows all
    expect(bulkCalls()).toBe(1);

    const second = await axios.get(`${baseUrl}/api/product-colors?styleNumber=PC61`, { validateStatus: () => true });
    expect(second.status).toBe(200);
    expect(bulkCalls()).toBe(2); // degraded response was not pinned
  });

  test('Caspio failure → 500, not cached', async () => {
    mockCaspio({ bulk: new Error('Caspio down') });
    const fail = await axios.get(`${baseUrl}/api/product-colors?styleNumber=PC61`, { validateStatus: () => true });
    expect(fail.status).toBe(500);

    mockCaspio();
    const ok = await axios.get(`${baseUrl}/api/product-colors?styleNumber=PC61`, { validateStatus: () => true });
    expect(ok.status).toBe(200);
  });
});

describe('GET /api/color-swatches', () => {
  test('cache hit on repeat; refresh=true bypasses', async () => {
    mockCaspio();
    await axios.get(`${baseUrl}/api/color-swatches?styleNumber=PC61`, { validateStatus: () => true });
    await axios.get(`${baseUrl}/api/color-swatches?styleNumber=PC61`, { validateStatus: () => true });
    expect(bulkCalls()).toBe(1);

    await axios.get(`${baseUrl}/api/color-swatches?styleNumber=PC61&refresh=true`, { validateStatus: () => true });
    expect(bulkCalls()).toBe(2);
  });
});

describe('GET /api/product-details', () => {
  test('cached pre-overlay snapshot: repeat hits skip Caspio bulk but still get NWCA copy', async () => {
    mockCaspio();

    const first = await axios.get(`${baseUrl}/api/product-details?styleNumber=PC61`, { validateStatus: () => true });
    expect(first.status).toBe(200);
    expect(first.data[0].PRODUCT_DESCRIPTION).toBe('NWCA custom copy'); // overlay applied
    expect(bulkCalls()).toBe(1);

    const second = await axios.get(`${baseUrl}/api/product-details?styleNumber=PC61`, { validateStatus: () => true });
    expect(second.status).toBe(200);
    expect(second.data[0].PRODUCT_DESCRIPTION).toBe('NWCA custom copy'); // overlay applied on the clone too
    expect(second.data).toEqual(first.data);
    expect(bulkCalls()).toBe(1); // bulk not re-read

    // The cached snapshot itself was never mutated by the overlay: a third hit
    // still starts from SanMar boilerplate and re-applies the current copy map.
    const third = await axios.get(`${baseUrl}/api/product-details?styleNumber=PC61`, { validateStatus: () => true });
    expect(third.status).toBe(200);
    expect(third.data[0].PRODUCT_DESCRIPTION).toBe('NWCA custom copy');
  });

  test('style+color is a distinct cache key from style-only', async () => {
    mockCaspio();
    await axios.get(`${baseUrl}/api/product-details?styleNumber=PC61`, { validateStatus: () => true });
    await axios.get(`${baseUrl}/api/product-details?styleNumber=PC61&color=${encodeURIComponent('Jet Black')}`, { validateStatus: () => true });
    expect(bulkCalls()).toBe(2);
  });
});

describe('GET /api/stylesearch', () => {
  test('per-term cache within 60s; quotes escaped in the LIKE clause', async () => {
    mockCaspio({ bulk: [{ STYLE: 'PC61', PRODUCT_TITLE: 'Essential Tee' }] });

    await axios.get(`${baseUrl}/api/stylesearch?term=PC6`, { validateStatus: () => true });
    await axios.get(`${baseUrl}/api/stylesearch?term=pc6`, { validateStatus: () => true }); // case-insensitive key
    expect(bulkCalls()).toBe(1);

    const quoted = await axios.get(`${baseUrl}/api/stylesearch?term=${encodeURIComponent("o'br")}`, { validateStatus: () => true });
    expect(quoted.status).toBe(200);
    const quotedCall = fetchAllCaspioPages.mock.calls.find(([, params]) => params['q.where'].includes('br'));
    expect(quotedCall[1]['q.where']).toBe("STYLE LIKE '%o''br%'");
  });

  test('empty suggestion lists ARE cached (legit result, not an error)', async () => {
    mockCaspio({ bulk: [] });
    const first = await axios.get(`${baseUrl}/api/stylesearch?term=ZZZZ`, { validateStatus: () => true });
    expect(first.status).toBe(200);
    expect(first.data).toEqual([]);
    await axios.get(`${baseUrl}/api/stylesearch?term=ZZZZ`, { validateStatus: () => true });
    expect(bulkCalls()).toBe(1);
  });
});

describe('GET /api/product-cache/clear', () => {
  test('clears the caches so the next request refetches', async () => {
    mockCaspio();
    await axios.get(`${baseUrl}/api/product-colors?styleNumber=PC61`, { validateStatus: () => true });
    expect(bulkCalls()).toBe(1);

    const clear = await axios.get(`${baseUrl}/api/product-cache/clear`, { validateStatus: () => true });
    expect(clear.status).toBe(200);
    expect(clear.data.success).toBe(true);
    expect(clear.data.cleared['product-colors']).toBe(1);

    await axios.get(`${baseUrl}/api/product-colors?styleNumber=PC61`, { validateStatus: () => true });
    expect(bulkCalls()).toBe(2); // refetched after clear
  });
});
