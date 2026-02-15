/**
 * Tax Rate Lookup endpoint tests.
 * Read-only (POST lookup doesn't mutate state).
 */
const { api, delay } = require('./setup');

afterEach(() => delay(1000));

// ── POST /api/tax-rates/lookup ─────────────────────────────────────

describe('POST /api/tax-rates/lookup — non-WA (out of state)', () => {
  test('returns rate 0 and outOfState true', async () => {
    const res = await api.post('/api/tax-rates/lookup', {
      address: '123 Main St',
      city: 'Portland',
      state: 'OR',
      zip: '97201',
    });
    expect(res.status).toBe(200);
    expect(res.data.rate).toBe(0);
    expect(res.data.outOfState).toBe(true);
    expect(res.data.account).toBe('2202');
    expect(res.data.source).toBe('static');
  });
});

describe('POST /api/tax-rates/lookup — WA address', () => {
  test('returns positive rate for Tacoma ZIP', async () => {
    const res = await api.post('/api/tax-rates/lookup', {
      address: '100 Pacific Ave',
      city: 'Tacoma',
      state: 'WA',
      zip: '98402',
    });
    expect(res.status).toBe(200);
    expect(res.data.rate).toBeGreaterThan(0);
    // Source should be dor, cache, or fallback
    expect(['dor', 'cache', 'fallback']).toContain(res.data.source);
  });
});

describe('POST /api/tax-rates/lookup — error cases', () => {
  test('missing state returns 400', async () => {
    const res = await api.post('/api/tax-rates/lookup', {
      address: '123 Main St',
      city: 'Tacoma',
      zip: '98402',
    });
    expect(res.status).toBe(400);
  });

  test('WA without ZIP returns 400', async () => {
    const res = await api.post('/api/tax-rates/lookup', {
      address: '123 Main St',
      city: 'Tacoma',
      state: 'WA',
    });
    expect(res.status).toBe(400);
  });
});

// ── GET /api/tax-rates ─────────────────────────────────────────────

describe('GET /api/tax-rates', () => {
  let res;

  beforeAll(async () => {
    res = await api.get('/api/tax-rates');
  });

  test('returns list with Account_Number and Tax_Rate', () => {
    expect(res.status).toBe(200);
    expect(res.data.success).toBe(true);
    expect(Array.isArray(res.data.data)).toBe(true);
    expect(res.data.data.length).toBeGreaterThan(0);

    const first = res.data.data[0];
    expect(first).toHaveProperty('Account_Number');
    expect(first).toHaveProperty('Tax_Rate');
  });

  test('contains the default WA account (2200)', () => {
    // Account_Number is numeric in Caspio
    const wa = res.data.data.find(a => a.Account_Number === 2200);
    expect(wa).toBeDefined();
    expect(wa.Tax_Rate).toBeCloseTo(0.101, 3);
  });

  test('contains out-of-state account (2202)', () => {
    const oos = res.data.data.find(a => a.Account_Number === 2202);
    expect(oos).toBeDefined();
  });
});
