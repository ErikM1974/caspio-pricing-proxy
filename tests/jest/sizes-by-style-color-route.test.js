/**
 * Route tests for GET /api/sizes-by-style-color (src/routes/inventory.js).
 * Mounts the real router on an ephemeral local express server with Caspio mocked —
 * no network, no dependence on what's deployed.
 *
 * Regression context (2026-06-18): the dedicated Caspio "Inventory" table started
 * 404ing, so the route 500'd on EVERY style/color and the quote builders silently
 * fell back to a hardcoded S–4XL list — hiding 5XL/6XL for styles like PC61. The fix
 * falls back to the real size run derived from the live SanMar bulk table.
 */

jest.mock('../../src/utils/caspio', () => ({
  makeCaspioRequest: jest.fn(),
  fetchAllCaspioPages: jest.fn()
}));

const express = require('express');
const axios = require('axios');
const { fetchAllCaspioPages } = require('../../src/utils/caspio');
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

/** Inventory-table rows in the legacy warehouse-matrix shape (the primary source). */
const INVENTORY_ROWS = [
  { catalog_no: 'PC61', catalog_color: 'Black', size: 'S', SizeSortOrder: 1, WarehouseName: 'Seattle', quantity: 10, WarehouseSort: 1 },
  { catalog_no: 'PC61', catalog_color: 'Black', size: 'M', SizeSortOrder: 2, WarehouseName: 'Seattle', quantity: 5,  WarehouseSort: 1 },
  { catalog_no: 'PC61', catalog_color: 'Black', size: 'S', SizeSortOrder: 1, WarehouseName: 'Dallas',  quantity: 7,  WarehouseSort: 2 }
];

/**
 * Dispatch the Caspio mock by table path.
 * @param {object} opts
 *   inventory: array of rows | Error to reject with (default: reject 404 — the live bug)
 *   bulk:      SanMar bulk rows (default: PC61 run)
 *   sizeOrder: Size_Display_Order rows (default: canonical subset)
 */
function mockCaspio({ inventory, bulk = PC61_BULK_ROWS, sizeOrder = SIZE_DISPLAY_ORDER } = {}) {
  fetchAllCaspioPages.mockImplementation((path) => {
    if (path.includes('/tables/Inventory/records')) {
      if (inventory instanceof Error) return Promise.reject(inventory);
      return Promise.resolve(inventory || []);
    }
    if (path.includes('Sanmar_Bulk')) return Promise.resolve(bulk);
    if (path.includes('Size_Display_Order')) return Promise.resolve(sizeOrder);
    return Promise.reject(new Error(`Unexpected table path: ${path}`));
  });
}

/** A 404 error shaped like what the Caspio helper throws for the missing table. */
function caspio404() {
  return new Error('Request failed with status code 404');
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
});

describe('GET /api/sizes-by-style-color', () => {
  test('validation: missing color → 400', async () => {
    const res = await axios.get(`${baseUrl}/api/sizes-by-style-color?styleNumber=PC61`, { validateStatus: () => true });
    expect(res.status).toBe(400);
    expect(res.data.error).toMatch(/required/i);
    expect(fetchAllCaspioPages).not.toHaveBeenCalled();
  });

  test('Inventory table 404 → falls back to the real SanMar size run (incl. 5XL/6XL)', async () => {
    mockCaspio({ inventory: caspio404() });

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

  test('Inventory table reachable with rows → returns warehouse matrix (source: inventory)', async () => {
    mockCaspio({ inventory: INVENTORY_ROWS });

    const res = await axios.get(
      `${baseUrl}/api/sizes-by-style-color?styleNumber=PC61&color=${encodeURIComponent('Black')}`,
      { validateStatus: () => true }
    );

    expect(res.status).toBe(200);
    expect(res.data.source).toBe('inventory');
    expect(res.data.sizes).toEqual(['S', 'M']);
    expect(res.data.warehouses.map(w => w.name)).toEqual(['Seattle', 'Dallas']);
    expect(res.data.grandTotal).toBe(22); // 10 + 5 + 7
    // Did NOT need the bulk fallback.
    const paths = fetchAllCaspioPages.mock.calls.map(([p]) => p);
    expect(paths.some(p => p.includes('Sanmar_Bulk'))).toBe(false);
  });

  test('Inventory reachable but empty → still falls back to the bulk size run', async () => {
    mockCaspio({ inventory: [] });

    const res = await axios.get(
      `${baseUrl}/api/sizes-by-style-color?styleNumber=PC61&color=${encodeURIComponent('Jet Black')}`,
      { validateStatus: () => true }
    );

    expect(res.status).toBe(200);
    expect(res.data.source).toBe('sanmar-bulk');
    expect(res.data.sizes).toEqual(PC61_RUN);
  });

  test('unknown style: Inventory 404 and no bulk rows → 404 (not 500)', async () => {
    mockCaspio({ inventory: caspio404(), bulk: [] });

    const res = await axios.get(
      `${baseUrl}/api/sizes-by-style-color?styleNumber=NOPE&color=Black`,
      { validateStatus: () => true }
    );

    expect(res.status).toBe(404);
    expect(res.data.error).toMatch(/no sizes found/i);
  });

  test('fallback source itself errors → 500 with details', async () => {
    fetchAllCaspioPages.mockImplementation((path) => {
      if (path.includes('/tables/Inventory/records')) return Promise.reject(caspio404());
      return Promise.reject(new Error('Caspio down'));
    });

    const res = await axios.get(
      `${baseUrl}/api/sizes-by-style-color?styleNumber=PC61&color=Black`,
      { validateStatus: () => true }
    );

    expect(res.status).toBe(500);
    expect(res.data.error).toMatch(/failed to fetch sizes/i);
    expect(res.data.details).toContain('Caspio down');
  });
});

describe('getStyleSizeRun (helper)', () => {
  test('de-dups, drops junk, sorts by Size_Display_Order — color-independent', async () => {
    mockCaspio({ inventory: caspio404() });
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
});
