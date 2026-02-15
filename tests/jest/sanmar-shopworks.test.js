/**
 * SanMar-ShopWorks import format endpoint tests.
 * Read-only.
 */
const { api, delay } = require('./setup');

afterEach(() => delay(1000));

describe('GET /api/sanmar-shopworks/import-format — PC54', () => {
  let res;

  beforeAll(async () => {
    res = await api.get('/api/sanmar-shopworks/import-format', {
      params: { styleNumber: 'PC54' },
    });
  });

  test('returns 200 with array', () => {
    expect(res.status).toBe(200);
    expect(Array.isArray(res.data)).toBe(true);
    expect(res.data.length).toBeGreaterThan(0);
  });

  test('base SKU has Size01=S through Size04=XL, Size05 null', () => {
    const base = res.data.find(r => r.ID_Product === 'PC54');
    expect(base).toBeDefined();
    expect(base.Size01).toBe('S');
    expect(base.Size02).toBe('M');
    expect(base.Size03).toBe('L');
    expect(base.Size04).toBe('XL');
    expect(base.Size05).toBeNull();
  });

  test('PC54_2X entry has Size05=2XL', () => {
    const ext = res.data.find(r => r.ID_Product === 'PC54_2X');
    expect(ext).toBeDefined();
    expect(ext.Size05).toBe('2XL');
  });
});

describe('GET /api/sanmar-shopworks/import-format — error cases', () => {
  test('missing styleNumber returns 400', async () => {
    const res = await api.get('/api/sanmar-shopworks/import-format');
    expect(res.status).toBe(400);
    expect(res.data.error).toBeDefined();
  });

  test('unknown style+color returns 404 with availableColors', async () => {
    const res = await api.get('/api/sanmar-shopworks/import-format', {
      params: { styleNumber: 'PC54', color: 'XYZNONEXISTENT' },
    });
    // Should be 404 with available colors hint
    expect(res.status).toBe(404);
    expect(res.data.availableColors).toBeDefined();
  });
});

describe('GET /api/sanmar-shopworks/suffix-mapping', () => {
  test('_2X maps to Size05, _3XL maps to Size06', async () => {
    const res = await api.get('/api/sanmar-shopworks/suffix-mapping');
    expect(res.status).toBe(200);
    expect(res.data.mappingRules['_2X']).toBe('Size05');
    expect(res.data.mappingRules['_3XL']).toBe('Size06');
  });
});
