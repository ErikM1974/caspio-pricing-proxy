/**
 * Cache-behavior tests for the per-style pricing endpoints
 * (/api/base-item-costs, /api/size-pricing, /api/max-prices-by-style) added in
 * the 2026-07-18 Caspio quota reduction. Hermetic: real router, mocked Caspio.
 */

jest.mock('../../src/utils/caspio', () => ({
  makeCaspioRequest: jest.fn(),
  fetchAllCaspioPages: jest.fn()
}));

const express = require('express');
const axios = require('axios');
const { fetchAllCaspioPages } = require('../../src/utils/caspio');
const { clearAll } = require('../../src/utils/ttl-cache');
const { clearStaticTableCaches } = require('../../src/utils/caspio-static-tables');
const pricingRouter = require('../../src/routes/pricing');

const BULK_ROWS = [
  { STYLE: 'PC61', COLOR_NAME: 'Jet Black', SIZE: 'S', CASE_PRICE: 3.5 },
  { STYLE: 'PC61', COLOR_NAME: 'Jet Black', SIZE: 'M', CASE_PRICE: 3.5 },
  { STYLE: 'PC61', COLOR_NAME: 'Jet Black', SIZE: '2XL', CASE_PRICE: 5.25 }
];

const UPCHARGE_ROWS = [
  { SizeDesignation: '2XL', StandardAddOnAmount: 2 },
  { SizeDesignation: '3XL', StandardAddOnAmount: 3 }
];

function mockCaspio({ bulk = BULK_ROWS, upcharges = UPCHARGE_ROWS } = {}) {
  fetchAllCaspioPages.mockImplementation((path) => {
    if (path.includes('Sanmar_Bulk')) {
      return bulk instanceof Error ? Promise.reject(bulk) : Promise.resolve(bulk);
    }
    if (path.includes('Standard_Size_Upcharges')) {
      return upcharges instanceof Error ? Promise.reject(upcharges) : Promise.resolve(upcharges);
    }
    return Promise.reject(new Error(`Unexpected table path: ${path}`));
  });
}

function callsTo(table) {
  return fetchAllCaspioPages.mock.calls.filter(([p]) => p.includes(table)).length;
}

let server;
let baseUrl;

beforeAll((done) => {
  const app = express();
  app.use('/api', pricingRouter);
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
  clearAll();
  clearStaticTableCaches();
});

describe('GET /api/base-item-costs', () => {
  test('second identical request is a cache hit — no new Caspio call', async () => {
    mockCaspio();
    const first = await axios.get(`${baseUrl}/api/base-item-costs?styleNumber=PC61`, { validateStatus: () => true });
    expect(first.status).toBe(200);
    expect(first.data.baseCosts).toEqual({ S: 3.5, M: 3.5, '2XL': 5.25 });
    expect(callsTo('Sanmar_Bulk')).toBe(1);

    const second = await axios.get(`${baseUrl}/api/base-item-costs?styleNumber=PC61`, { validateStatus: () => true });
    expect(second.status).toBe(200);
    expect(second.data).toEqual(first.data);
    expect(callsTo('Sanmar_Bulk')).toBe(1);
  });

  test('refresh=true bypasses the cache', async () => {
    mockCaspio();
    await axios.get(`${baseUrl}/api/base-item-costs?styleNumber=PC61`, { validateStatus: () => true });
    await axios.get(`${baseUrl}/api/base-item-costs?styleNumber=PC61&refresh=true`, { validateStatus: () => true });
    expect(callsTo('Sanmar_Bulk')).toBe(2);
  });

  test('Caspio failure → 500 propagated, error not cached (Rule 4)', async () => {
    mockCaspio({ bulk: new Error('Caspio down') });
    const fail = await axios.get(`${baseUrl}/api/base-item-costs?styleNumber=PC61`, { validateStatus: () => true });
    expect(fail.status).toBe(500);
    expect(fail.data.details).toContain('Caspio down');

    mockCaspio();
    const recovered = await axios.get(`${baseUrl}/api/base-item-costs?styleNumber=PC61`, { validateStatus: () => true });
    expect(recovered.status).toBe(200);
    expect(recovered.data.baseCosts['2XL']).toBe(5.25);
  });

  test('404 (unknown style) is not cached', async () => {
    mockCaspio({ bulk: [] });
    const miss = await axios.get(`${baseUrl}/api/base-item-costs?styleNumber=NEWSTYLE`, { validateStatus: () => true });
    expect(miss.status).toBe(404);

    mockCaspio();
    const hit = await axios.get(`${baseUrl}/api/base-item-costs?styleNumber=NEWSTYLE`, { validateStatus: () => true });
    expect(hit.status).toBe(200);
  });
});

describe('GET /api/size-pricing', () => {
  test('caches per style+color; Standard_Size_Upcharges shared via the 1h static cache', async () => {
    mockCaspio();

    const first = await axios.get(`${baseUrl}/api/size-pricing?styleNumber=PC61`, { validateStatus: () => true });
    expect(first.status).toBe(200);
    expect(first.data[0].sizeUpcharges['2XL']).toBe(2);
    expect(callsTo('Sanmar_Bulk')).toBe(1);
    expect(callsTo('Standard_Size_Upcharges')).toBe(1);

    // Different style → new bulk read, but the upcharge table comes from the
    // static cache (no second Caspio read).
    const other = await axios.get(`${baseUrl}/api/size-pricing?styleNumber=PC90H`, { validateStatus: () => true });
    expect(other.status).toBe(200);
    expect(callsTo('Sanmar_Bulk')).toBe(2);
    expect(callsTo('Standard_Size_Upcharges')).toBe(1);

    // Repeat of the first style → full cache hit, no Caspio at all.
    await axios.get(`${baseUrl}/api/size-pricing?styleNumber=PC61`, { validateStatus: () => true });
    expect(callsTo('Sanmar_Bulk')).toBe(2);
    expect(callsTo('Standard_Size_Upcharges')).toBe(1);
  });

  test('style+color and style-only are distinct cache entries', async () => {
    mockCaspio();
    await axios.get(`${baseUrl}/api/size-pricing?styleNumber=PC61`, { validateStatus: () => true });
    await axios.get(`${baseUrl}/api/size-pricing?styleNumber=PC61&color=${encodeURIComponent('Jet Black')}`, { validateStatus: () => true });
    expect(callsTo('Sanmar_Bulk')).toBe(2);
  });

  test('upcharge-table failure still 500s (unchanged behavior, nothing cached)', async () => {
    mockCaspio({ upcharges: new Error('upcharge table down') });
    const res = await axios.get(`${baseUrl}/api/size-pricing?styleNumber=PC61`, { validateStatus: () => true });
    expect(res.status).toBe(500);

    mockCaspio();
    const recovered = await axios.get(`${baseUrl}/api/size-pricing?styleNumber=PC61`, { validateStatus: () => true });
    expect(recovered.status).toBe(200);
  });
});

describe('GET /api/max-prices-by-style', () => {
  test('second identical request is a cache hit', async () => {
    mockCaspio();
    const first = await axios.get(`${baseUrl}/api/max-prices-by-style?styleNumber=PC61`, { validateStatus: () => true });
    expect(first.status).toBe(200);
    expect(first.data.sellingPriceDisplayAddOns['2XL']).toBe(2);
    expect(callsTo('Sanmar_Bulk')).toBe(1);

    const second = await axios.get(`${baseUrl}/api/max-prices-by-style?styleNumber=PC61`, { validateStatus: () => true });
    expect(second.status).toBe(200);
    expect(callsTo('Sanmar_Bulk')).toBe(1);
  });

  test('degraded upcharges ({} add-ons) is served but NOT cached', async () => {
    mockCaspio({ upcharges: new Error('upcharge table down') });
    const degraded = await axios.get(`${baseUrl}/api/max-prices-by-style?styleNumber=PC61`, { validateStatus: () => true });
    expect(degraded.status).toBe(200); // fail-open by design
    expect(degraded.data.sellingPriceDisplayAddOns).toEqual({});
    expect(callsTo('Sanmar_Bulk')).toBe(1);

    // Next request must NOT be served from cache — it retries and heals.
    mockCaspio();
    const healed = await axios.get(`${baseUrl}/api/max-prices-by-style?styleNumber=PC61`, { validateStatus: () => true });
    expect(healed.status).toBe(200);
    expect(healed.data.sellingPriceDisplayAddOns['2XL']).toBe(2);
    expect(callsTo('Sanmar_Bulk')).toBe(2);
  });

  test('empty-inventory response is served but NOT cached', async () => {
    mockCaspio({ bulk: [] });
    const empty = await axios.get(`${baseUrl}/api/max-prices-by-style?styleNumber=NEWSTYLE`, { validateStatus: () => true });
    expect(empty.status).toBe(200);
    expect(empty.data.sizes).toEqual([]);

    mockCaspio();
    const filled = await axios.get(`${baseUrl}/api/max-prices-by-style?styleNumber=NEWSTYLE`, { validateStatus: () => true });
    expect(filled.status).toBe(200);
    expect(filled.data.sizes.length).toBeGreaterThan(0);
  });
});
