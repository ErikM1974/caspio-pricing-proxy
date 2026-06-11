/**
 * Route tests for GET /api/decoration-methods (src/routes/decoration-methods.js).
 * Mounts the real router on an ephemeral local express server with Caspio mocked —
 * no network, no dependence on what's deployed.
 *
 * Covers: response shape, Caspio Yes/No → boolean normalization, 1h cache behavior,
 * and the 502-on-Caspio-failure contract (frontend must be able to TELL it failed —
 * never an empty-but-200).
 */

jest.mock('../../src/utils/caspio', () => ({
  fetchAllCaspioPages: jest.fn()
}));

const express = require('express');
const axios = require('axios');
const { fetchAllCaspioPages } = require('../../src/utils/caspio');
const decorationMethodsRouter = require('../../src/routes/decoration-methods');
const { normalizeYesNo } = decorationMethodsRouter;

// Caspio YES/NO fields serialize as JSON true/false, but rows edited via
// DataPages/CSV import can carry "Yes"/"No" strings — the route must handle both.
const RULE_ROWS = [
  { PK_ID: 1, Category: 'T-Shirts',  EMB: true,  DTG: true,  SCP: true,  DTF: true,  DTG_CottonGate: true,  Notes: 'All methods' },
  { PK_ID: 2, Category: 'Caps',      EMB: false, DTG: false, SCP: false, DTF: false, DTG_CottonGate: false, Notes: 'CAP branch handles caps' },
  { PK_ID: 3, Category: 'Outerwear', EMB: 'Yes', DTG: 'No',  SCP: 'No',  DTF: 'No',  DTG_CottonGate: 'No', Notes: null },
  { PK_ID: 4, Category: '',          EMB: true,  DTG: true,  SCP: true,  DTF: true,  DTG_CottonGate: true,  Notes: 'blank category → skipped' }
];

const OVERRIDE_ROWS = [
  { PK_ID: 1, StyleNumber: 'PC54', Method: 'dtg', Allow: false,  Note: 'Test override' },
  { PK_ID: 2, StyleNumber: 'C112', Method: 'EMB', Allow: 'Yes', Note: null },
  { PK_ID: 3, StyleNumber: '',     Method: 'DTF', Allow: true,  Note: 'blank style → skipped' }
];

/** Route fetches rules then overrides — dispatch the mock on table path. */
function mockCaspioTables({ rules = RULE_ROWS, overrides = OVERRIDE_ROWS } = {}) {
  fetchAllCaspioPages.mockImplementation((path) => {
    if (path.includes('Decoration_Method_Rules')) return Promise.resolve(rules);
    if (path.includes('Decoration_Method_Overrides')) return Promise.resolve(overrides);
    return Promise.reject(new Error(`Unexpected table path: ${path}`));
  });
}

let server;
let baseUrl;

beforeAll((done) => {
  const app = express();
  app.use('/api', decorationMethodsRouter);
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

describe('normalizeYesNo', () => {
  test('booleans pass through', () => {
    expect(normalizeYesNo(true)).toBe(true);
    expect(normalizeYesNo(false)).toBe(false);
  });

  test('Caspio string variants normalize case-insensitively', () => {
    expect(normalizeYesNo('Yes')).toBe(true);
    expect(normalizeYesNo('yes')).toBe(true);
    expect(normalizeYesNo('Y')).toBe(true);
    expect(normalizeYesNo('TRUE')).toBe(true);
    expect(normalizeYesNo('1')).toBe(true);
    expect(normalizeYesNo('No')).toBe(false);
    expect(normalizeYesNo('N')).toBe(false);
    expect(normalizeYesNo('false')).toBe(false);
    expect(normalizeYesNo('0')).toBe(false);
  });

  test('numbers: 1 → true, everything else → false', () => {
    expect(normalizeYesNo(1)).toBe(true);
    expect(normalizeYesNo(0)).toBe(false);
    expect(normalizeYesNo(2)).toBe(false);
  });

  test('null/undefined/garbage → false (deny method, never silently allow)', () => {
    expect(normalizeYesNo(null)).toBe(false);
    expect(normalizeYesNo(undefined)).toBe(false);
    expect(normalizeYesNo('maybe')).toBe(false);
    expect(normalizeYesNo({})).toBe(false);
  });
});

describe('GET /api/decoration-methods', () => {
  test('returns { rules, overrides } with normalized booleans and camelCase keys', async () => {
    mockCaspioTables();

    const res = await axios.get(`${baseUrl}/api/decoration-methods?refresh=true`, { validateStatus: () => true });

    expect(res.status).toBe(200);
    expect(res.data).toEqual({
      rules: [
        { category: 'T-Shirts',  EMB: true,  DTG: true,  SCP: true,  DTF: true,  dtgCottonGate: true,  notes: 'All methods' },
        { category: 'Caps',      EMB: false, DTG: false, SCP: false, DTF: false, dtgCottonGate: false, notes: 'CAP branch handles caps' },
        { category: 'Outerwear', EMB: true,  DTG: false, SCP: false, DTF: false, dtgCottonGate: false, notes: '' }
      ],
      overrides: [
        { styleNumber: 'PC54', method: 'DTG', allow: false, note: 'Test override' },
        { styleNumber: 'C112', method: 'EMB', allow: true,  note: '' }
      ]
    });

    // Every Yes/No surface is a strict boolean — frontends branch on these directly.
    res.data.rules.forEach(rule => {
      ['EMB', 'DTG', 'SCP', 'DTF', 'dtgCottonGate'].forEach(key => {
        expect(typeof rule[key]).toBe('boolean');
      });
    });
    res.data.overrides.forEach(o => expect(typeof o.allow).toBe('boolean'));

    // Reads both Caspio tables
    const paths = fetchAllCaspioPages.mock.calls.map(([path]) => path);
    expect(paths).toEqual(expect.arrayContaining([
      expect.stringContaining('Decoration_Method_Rules'),
      expect.stringContaining('Decoration_Method_Overrides')
    ]));
  });

  test('serves from 1h cache on subsequent requests (no extra Caspio calls)', async () => {
    mockCaspioTables();

    const first = await axios.get(`${baseUrl}/api/decoration-methods?refresh=true`);
    expect(first.status).toBe(200);
    const callsAfterFirst = fetchAllCaspioPages.mock.calls.length;
    expect(callsAfterFirst).toBeGreaterThan(0);

    const second = await axios.get(`${baseUrl}/api/decoration-methods`);

    expect(second.status).toBe(200);
    expect(second.data).toEqual(first.data);
    expect(fetchAllCaspioPages.mock.calls.length).toBe(callsAfterFirst); // cache hit — no new calls
  });

  test('refresh=true bypasses the cache and re-reads Caspio', async () => {
    mockCaspioTables();

    await axios.get(`${baseUrl}/api/decoration-methods?refresh=true`);
    const callsAfterFirst = fetchAllCaspioPages.mock.calls.length;

    const res = await axios.get(`${baseUrl}/api/decoration-methods?refresh=true`);

    expect(res.status).toBe(200);
    expect(fetchAllCaspioPages.mock.calls.length).toBeGreaterThan(callsAfterFirst);
  });

  test('Caspio failure → visible 502 with error body, no stale/hardcoded fallback', async () => {
    fetchAllCaspioPages.mockRejectedValue(new Error('Caspio down'));

    const res = await axios.get(`${baseUrl}/api/decoration-methods?refresh=true`, { validateStatus: () => true });

    expect(res.status).toBe(502);
    expect(res.data.error).toBe('Failed to fetch decoration method rules');
    expect(res.data.details).toContain('Caspio down');
    expect(res.data.rules).toBeUndefined(); // never an empty-but-200 (or empty-but-502) ruleset
  });

  test('empty rules table → 502, never an empty-but-200 ruleset', async () => {
    mockCaspioTables({ rules: [] });

    const res = await axios.get(`${baseUrl}/api/decoration-methods?refresh=true`, { validateStatus: () => true });

    expect(res.status).toBe(502);
    expect(res.data.error).toBe('Failed to fetch decoration method rules');
  });
});
