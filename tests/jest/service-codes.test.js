/**
 * Service Codes endpoint tests.
 * Read-only — validates structure, filters, tiers, and aliases.
 */
const { api, delay } = require('./setup');

afterEach(() => delay(1000));

// ── GET /api/service-codes ─────────────────────────────────────────

describe('GET /api/service-codes', () => {
  let res;

  beforeAll(async () => {
    res = await api.get('/api/service-codes');
  });

  test('returns success with data array', () => {
    expect(res.status).toBe(200);
    expect(res.data.success).toBe(true);
    expect(Array.isArray(res.data.data)).toBe(true);
    expect(res.data.count).toBeGreaterThan(0);
  });

  test('source is caspio', () => {
    expect(res.data.source).toBe('caspio');
  });

  test('records have required fields', () => {
    const rec = res.data.data[0];
    expect(rec).toHaveProperty('ServiceCode');
    expect(rec).toHaveProperty('SellPrice');
    expect(rec).toHaveProperty('PricingMethod');
    expect(rec).toHaveProperty('IsActive');
  });
});

describe('GET /api/service-codes — filters', () => {
  test('filter by code=AL returns only AL records', async () => {
    const res = await api.get('/api/service-codes', { params: { code: 'AL' } });
    expect(res.status).toBe(200);
    expect(res.data.data.length).toBeGreaterThan(0);
    for (const rec of res.data.data) {
      expect(rec.ServiceCode).toBe('AL');
    }
  });

  test('filter by type returns matching records', async () => {
    const res = await api.get('/api/service-codes', { params: { type: 'FEE' } });
    expect(res.status).toBe(200);
    // All returned records should have ServiceType = FEE
    for (const rec of res.data.data) {
      expect(rec.ServiceType).toBe('FEE');
    }
  });
});

// ── GET /api/service-codes/tier/:code/:qty ─────────────────────────

describe('GET /api/service-codes/tier/:code/:qty', () => {
  test('AL tier for qty 50 returns valid response shape', async () => {
    const res = await api.get('/api/service-codes/tier/AL/50');
    expect(res.status).toBe(200);
    expect(res.data.success).toBe(true);
    expect(res.data.resolvedCode).toBe('AL');
    expect(res.data.quantity).toBe(50);
    expect(typeof res.data.sellPrice).toBe('number');
    expect(typeof res.data.unitCost).toBe('number');
    expect(res.data.source).toBe('caspio');
  });

  test('nonexistent code returns 404', async () => {
    const res = await api.get('/api/service-codes/tier/ZZZZZ/10');
    expect(res.status).toBe(404);
  });

  test('qty 0 returns 400', async () => {
    const res = await api.get('/api/service-codes/tier/AL/0');
    expect(res.status).toBe(400);
  });

  test('negative qty returns 400', async () => {
    const res = await api.get('/api/service-codes/tier/AL/-5');
    expect(res.status).toBe(400);
  });
});

// ── GET /api/service-codes/aliases ─────────────────────────────────

describe('GET /api/service-codes/aliases', () => {
  let res;

  beforeAll(async () => {
    res = await api.get('/api/service-codes/aliases');
  });

  test('returns success with alias map', () => {
    expect(res.status).toBe(200);
    expect(res.data.success).toBe(true);
    expect(typeof res.data.data).toBe('object');
  });

  test('SEW maps to SEG', () => {
    // SEW or SEW-ON should resolve to SEG
    const aliases = res.data.data;
    const sewAlias = aliases['SEW'] || aliases['SEW-ON'];
    expect(sewAlias).toBe('SEG');
  });

  test('AONOGRAM maps to Monogram', () => {
    expect(res.data.data['AONOGRAM']).toBe('Monogram');
  });
});
