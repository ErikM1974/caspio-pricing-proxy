/**
 * Pricing Bundle endpoint tests — the most critical endpoint.
 * Read-only against real Caspio data.
 */
const { api, delay } = require('./setup');

afterEach(() => delay(1000));

describe('GET /api/pricing-bundle — EMB method', () => {
  let res;

  beforeAll(async () => {
    res = await api.get('/api/pricing-bundle', { params: { method: 'EMB' } });
  });

  test('returns 200', () => {
    expect(res.status).toBe(200);
  });

  test('has tiersR array', () => {
    expect(Array.isArray(res.data.tiersR)).toBe(true);
    expect(res.data.tiersR.length).toBeGreaterThanOrEqual(4);
  });

  test('tiersR items have required fields', () => {
    const tier = res.data.tiersR[0];
    expect(tier).toHaveProperty('TierLabel');
    expect(tier).toHaveProperty('MinQuantity');
    expect(tier).toHaveProperty('MaxQuantity');
    expect(tier).toHaveProperty('MarginDenominator');
    expect(typeof tier.MarginDenominator).toBe('number');
  });

  test('has rulesR object', () => {
    expect(typeof res.data.rulesR).toBe('object');
    expect(res.data.rulesR).not.toBeNull();
  });

  test('has locations array', () => {
    expect(Array.isArray(res.data.locations)).toBe(true);
    expect(res.data.locations.length).toBeGreaterThan(0);
  });

  test('has allEmbroideryCostsR array', () => {
    expect(Array.isArray(res.data.allEmbroideryCostsR)).toBe(true);
    expect(res.data.allEmbroideryCostsR.length).toBeGreaterThan(0);
  });
});

describe('GET /api/pricing-bundle — CAP method', () => {
  test('CAP has margin 0.57', async () => {
    const res = await api.get('/api/pricing-bundle', { params: { method: 'CAP' } });
    expect(res.status).toBe(200);
    const tier = res.data.tiersR.find(t => t.TierLabel === '1-23');
    expect(tier).toBeDefined();
    expect(tier.MarginDenominator).toBe(0.57);
  });
});

describe('GET /api/pricing-bundle — DTG method', () => {
  test('DTG returns allDtgCostsR', async () => {
    const res = await api.get('/api/pricing-bundle', { params: { method: 'DTG' } });
    expect(res.status).toBe(200);
    expect(Array.isArray(res.data.allDtgCostsR)).toBe(true);
  });
});

describe('GET /api/pricing-bundle — DTF method', () => {
  test('DTF returns allDtfCostsR and freightR', async () => {
    const res = await api.get('/api/pricing-bundle', { params: { method: 'DTF' } });
    expect(res.status).toBe(200);
    expect(Array.isArray(res.data.allDtfCostsR)).toBe(true);
    expect(Array.isArray(res.data.freightR)).toBe(true);
  });
});

describe('GET /api/pricing-bundle — with styleNumber', () => {
  test('EMB + PC54 returns sizes and sellingPriceDisplayAddOns', async () => {
    const res = await api.get('/api/pricing-bundle', {
      params: { method: 'EMB', styleNumber: 'PC54' },
    });
    expect(res.status).toBe(200);
    expect(Array.isArray(res.data.sizes)).toBe(true);
    expect(res.data.sizes.length).toBeGreaterThan(0);
    expect(res.data.sellingPriceDisplayAddOns).toBeDefined();
  });
});

describe('GET /api/pricing-bundle — error cases', () => {
  test('missing method returns 400', async () => {
    const res = await api.get('/api/pricing-bundle');
    expect(res.status).toBe(400);
    expect(res.data.error).toBeDefined();
  });
});
