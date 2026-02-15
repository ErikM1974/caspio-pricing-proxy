/**
 * Embroidery-specific pricing endpoints:
 *   /api/embroidery-costs, /api/decg-pricing, /api/al-pricing
 * Read-only.
 */
const { api, delay } = require('./setup');

afterEach(() => delay(1000));

// ── /api/embroidery-costs ──────────────────────────────────────────

describe('GET /api/embroidery-costs — Shirt/8000', () => {
  let res;

  beforeAll(async () => {
    res = await api.get('/api/embroidery-costs', {
      params: { itemType: 'Shirt', stitchCount: 8000 },
    });
  });

  test('returns 200 with array', () => {
    expect(res.status).toBe(200);
    expect(Array.isArray(res.data)).toBe(true);
    expect(res.data.length).toBeGreaterThan(0);
  });

  test('records have EmbroideryCost field', () => {
    expect(typeof res.data[0].EmbroideryCost).toBe('number');
  });
});

describe('GET /api/embroidery-costs — Cap/8000', () => {
  test('returns cost records for caps', async () => {
    // Caps use 8000 base stitch count (5000 is for AL)
    const res = await api.get('/api/embroidery-costs', {
      params: { itemType: 'Cap', stitchCount: 8000 },
    });
    expect(res.status).toBe(200);
    expect(Array.isArray(res.data)).toBe(true);
    expect(res.data.length).toBeGreaterThan(0);
  });
});

describe('GET /api/embroidery-costs — error cases', () => {
  test('missing params returns 400', async () => {
    const res = await api.get('/api/embroidery-costs');
    expect(res.status).toBe(400);
    expect(res.data.error).toBeDefined();
  });

  test('invalid itemType returns 400', async () => {
    const res = await api.get('/api/embroidery-costs', {
      params: { itemType: 'INVALID', stitchCount: 8000 },
    });
    expect(res.status).toBe(400);
  });
});

// ── /api/decg-pricing ──────────────────────────────────────────────

describe('GET /api/decg-pricing', () => {
  let res;

  beforeAll(async () => {
    res = await api.get('/api/decg-pricing');
  });

  test('returns garments, caps, fullBack', () => {
    expect(res.status).toBe(200);
    expect(res.data.garments).toBeDefined();
    expect(res.data.caps).toBeDefined();
    expect(res.data.fullBack).toBeDefined();
  });

  test('source is caspio', () => {
    expect(res.data.source).toBe('caspio');
  });

  test('garment tier values are numeric', () => {
    const prices = res.data.garments.basePrices;
    for (const key of Object.keys(prices)) {
      expect(typeof prices[key]).toBe('number');
    }
  });
});

// ── /api/al-pricing ────────────────────────────────────────────────

describe('GET /api/al-pricing', () => {
  let res;

  beforeAll(async () => {
    res = await api.get('/api/al-pricing');
  });

  test('returns all sections', () => {
    expect(res.status).toBe(200);
    expect(res.data.garments).toBeDefined();
    expect(res.data.caps).toBeDefined();
    expect(res.data.source).toBe('caspio');
  });

  test('LTM threshold is 7 or appropriate value', () => {
    // LTM threshold should exist and be a number
    const threshold = res.data.fees?.ltm?.threshold
      ?? res.data.garments?.ltmThreshold;
    expect(typeof threshold).toBe('number');
  });

  test('tier keys match expected pattern', () => {
    const keys = Object.keys(res.data.garments.basePrices);
    expect(keys.length).toBeGreaterThanOrEqual(3);
    // Tier keys like "1-23", "24-47", "72+"
    for (const key of keys) {
      expect(key).toMatch(/^\d+[-+]/);
    }
  });
});
