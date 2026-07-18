/**
 * Route tests for GET /api/sizes-by-style-color (src/routes/inventory.js).
 * Mounts the real router on an ephemeral local express server with Caspio mocked —
 * no network, no dependence on what's deployed.
 *
 * Regression context (2026-06-18): the dedicated Caspio "Inventory" table started
 * 404ing, so the route 500'd on EVERY style/color and the quote builders silently
 * fell back to a hardcoded S–4XL list — hiding 5XL/6XL for styles like PC61. The
 * route now derives the size run from the live SanMar bulk table; the doomed
 * /tables/Inventory probe was removed entirely in 2026-07 (the mock's
 * "Unexpected table path" rejection doubles as a regression guard that no code
 * path probes it anymore). A 15-min per-style cache was added at the same time.
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
const inventoryRouter = require('../../src/routes/inventory');
const { getStyleSizeRun } = inventoryRouter;

// PC61 in SanMar bulk: same S–6XL run across every color, and the colors are named
// "Jet Black" / "Deep Marine" — NOT "Black" — which is exactly why filtering the bulk
// table by COLOR_NAME would return zero sizes. The run must be derived style-wide.
const PC61_BULK_ROWS = [
  { SIZE: 'S' }, { SIZE: 'M' }, { SIZE: 'L' }, { SIZE: 'XL' },
  { SIZE: '2XL' }, { SIZE: '3XL' }, { SIZE: '4XL' }, { SIZE: '5XL' }, { SIZE: '6XL' },
  // duplicates from other colors — must be de-duped
  { SIZE: 'S' }, { SIZE: 'XL' }, { SIZE: '6XL' },
  { SIZE: null }, { SIZE: '' } // junk rows — must be dropped
];

// Canonical size ordering (subset of the real Size_Display_Order table), intentionally
// out of order to prove the route sorts by sort_order rather than insertion order.
const SIZE_DISPLAY_ORDER = [
  { size: '6XL', sort_order: 90 },
  { size: 'S', sort_order: 30 },
  { size: 'M', sort_order: 40 },
  { size: 'L', sort_order: 50 },
  { size: 'XL', sort_order: 60 },
  { size: '2XL', sort_order: 70 },
  { size: '3XL', sort_order: 80 },
  { size: '4XL', sort_order: 85 },
  { size: '5XL', sort_order: 88 }
];

const PC61_RUN = ['S', 'M', 'L', 'XL', '2XL', '3XL', '4XL', '5XL', '6XL'];

/**
 * Dispatch the Caspio mock by table path. Rejecting on any unexpected path is a
 * regression guard: it proves the removed /tables/Inventory probe stays removed.
 * @param {object} opts
 *   bulk:      SanMar bulk rows (default: PC61 run)
 *   sizeOrder: Size_Display_Order rows (default: canonical subset)
 */
function mockCaspio({ bulk = PC61_BULK_ROWS, sizeOrder = SIZE_DISPLAY_ORDER } = {}) {
  fetchAllCaspioPages.mockImplementation((path) => {
    if (path.includes('Sanmar_Bulk')) return Promise.resolve(bulk);
    if (path.includes('Size_Display_Order')) return Promise.resolve(sizeOrder);
    return Promise.reject(new Error(`Unexpected table path: ${path}`));
  });
}

/** Count of Caspio calls that hit the SanMar bulk table. */
function bulkCallCount() {
  return fetchAllCaspioPages.mock.calls.filter(([p]) => p.includes('Sanmar_Bulk')).length;
}

let server;
let baseUrl;

beforeAll((done) => {
  const app = express();
  app.use('/api', inventoryRouter);
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
  // Route-level caches are module-global — reset for hermetic tests.
  clearAll();
  clearStaticTableCaches();
});

describe('GET /api/sizes-by-style-color', () => {
  test('validation: missing color → 400', async () => {
    const res = await axios.get(`${baseUrl}/api/sizes-by-style-color?styleNumber=PC61`, { validateStatus: () => true });
    expect(res.status).toBe(400);
    expect(res.data.error).toMatch(/required/i);
    expect(fetchAllCaspioPages).not.toHaveBeenCalled();
  });

  test('validation: style that sanitizes to nothing → 400, no Caspio call', async () => {
    const res = await axios.get(
      `${baseUrl}/api/sizes-by-style-color?styleNumber=${encodeURIComponent('@@@')}&color=Black`,
      { validateStatus: () => true }
    );
    expect(res.status).toBe(400);
    expect(res.data.error).toMatch(/invalid style/i);
    expect(fetchAllCaspioPages).not.toHaveBeenCalled();
  });

  test('derives the real SanMar size run (incl. 5XL/6XL), sorted and de-duped', async () => {
    mockCaspio();

    const res = await axios.get(
      `${baseUrl}/api/sizes-by-style-color?styleNumber=PC61&color=${encodeURIComponent('Black')}`,
      { validateStatus: () => true }
    );

    expect(res.status).toBe(200);
    expect(res.data.source).toBe('sanmar-bulk');
    expect(res.data.style).toBe('PC61');
    expect(res.data.color).toBe('Black');
    // The whole point of the fix: the real run, sorted, de-duped, with no junk.
    expect(res.data.sizes).toEqual(PC61_RUN);
    // Regression guard — these were invisible in the builders while the route 500'd.
    expect(res.data.sizes).toEqual(expect.arrayContaining(['5XL', '6XL']));
    // Warehouse data isn't available from this source.
    expect(res.data.warehouses).toEqual([]);
    expect(res.data.grandTotal).toBe(0);
  });

  test('cache: a second request (even another color) serves from cache — no new bulk call', async () => {
    mockCaspio();

    const first = await axios.get(`${baseUrl}/api/sizes-by-style-color?styleNumber=PC61&color=Black`, { validateStatus: () => true });
    expect(first.status).toBe(200);
    const callsAfterFirst = bulkCallCount();
    expect(callsAfterFirst).toBe(1);

    // Same style, different color: size runs are style-level, so this is a hit.
    const second = await axios.get(
      `${baseUrl}/api/sizes-by-style-color?styleNumber=PC61&color=${encodeURIComponent('Jet Black')}`,
      { validateStatus: () => true }
    );
    expect(second.status).toBe(200);
    expect(second.data.sizes).toEqual(PC61_RUN);
    expect(second.data.color).toBe('Jet Black'); // envelope rebuilt per request
    expect(bulkCallCount()).toBe(callsAfterFirst); // no extra Caspio traffic
  });

  test('cache: refresh=true bypasses and refetches', async () => {
    mockCaspio();

    await axios.get(`${baseUrl}/api/sizes-by-style-color?styleNumber=PC61&color=Black`, { validateStatus: () => true });
    expect(bulkCallCount()).toBe(1);

    const res = await axios.get(
      `${baseUrl}/api/sizes-by-style-color?styleNumber=PC61&color=Black&refresh=true`,
      { validateStatus: () => true }
    );
    expect(res.status).toBe(200);
    expect(bulkCallCount()).toBe(2);
  });

  test('no negative caching: unknown style 404s, then succeeds once rows exist', async () => {
    mockCaspio({ bulk: [] });

    const miss = await axios.get(`${baseUrl}/api/sizes-by-style-color?styleNumber=NOPE&color=Black`, { validateStatus: () => true });
    expect(miss.status).toBe(404);
    expect(miss.data.error).toMatch(/no sizes found/i);

    // Style appears in the bulk table (e.g. new product on the nightly sync).
    mockCaspio();
    const hit = await axios.get(`${baseUrl}/api/sizes-by-style-color?styleNumber=NOPE&color=Black`, { validateStatus: () => true });
    expect(hit.status).toBe(200);
    expect(hit.data.sizes).toEqual(PC61_RUN); // empty result was NOT pinned
  });

  test('Caspio down → 500 with details, and the failure is not cached', async () => {
    fetchAllCaspioPages.mockImplementation(() => Promise.reject(new Error('Caspio down')));

    const res = await axios.get(
      `${baseUrl}/api/sizes-by-style-color?styleNumber=PC61&color=Black`,
      { validateStatus: () => true }
    );

    expect(res.status).toBe(500);
    expect(res.data.error).toMatch(/failed to fetch sizes/i);
    expect(res.data.details).toContain('Caspio down');

    // Recovery works immediately — the error was never cached (Rule 4).
    mockCaspio();
    const recovered = await axios.get(`${baseUrl}/api/sizes-by-style-color?styleNumber=PC61&color=Black`, { validateStatus: () => true });
    expect(recovered.status).toBe(200);
    expect(recovered.data.sizes).toEqual(PC61_RUN);
  });
});

describe('getStyleSizeRun (helper)', () => {
  test('de-dups, drops junk, sorts by Size_Display_Order — color-independent', async () => {
    mockCaspio();
    const sizes = await getStyleSizeRun('PC61');
    expect(sizes).toEqual(PC61_RUN);
  });

  test('tolerates Size_Display_Order being unavailable (returns sizes, unsorted)', async () => {
    fetchAllCaspioPages.mockImplementation((path) => {
      if (path.includes('Sanmar_Bulk')) return Promise.resolve([{ SIZE: 'M' }, { SIZE: 'S' }, { SIZE: 'M' }]);
      if (path.includes('Size_Display_Order')) return Promise.reject(new Error('order table down'));
      return Promise.reject(new Error(`Unexpected: ${path}`));
    });
    const sizes = await getStyleSizeRun('PC61');
    expect(sizes.sort()).toEqual(['M', 'S']); // de-duped; order unspecified without the sort table
  });

  test('no raw-input fallback: dangerous chars are stripped, unsanitizable style skips Caspio', async () => {
    mockCaspio();
    // "';DELETE--" strips to "DELETE--" — the quote/semicolon never reach the WHERE clause.
    await getStyleSizeRun("';DELETE--");
    const bulkCalls = fetchAllCaspioPages.mock.calls.filter(([p]) => p.includes('Sanmar_Bulk'));
    expect(bulkCalls.length).toBe(1);
    expect(bulkCalls[0][1]['q.where']).toBe("STYLE='DELETE--'");

    // A style that strips to nothing returns [] without any Caspio call.
    const empty = await getStyleSizeRun('@@@');
    expect(empty).toEqual([]);
    expect(fetchAllCaspioPages.mock.calls.filter(([p]) => p.includes('Sanmar_Bulk')).length).toBe(1);
  });
});
