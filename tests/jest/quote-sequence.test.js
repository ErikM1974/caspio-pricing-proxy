/**
 * Quote Sequence endpoint tests.
 * WRITE operation — increments a counter. Uses JTEST prefix to avoid collisions.
 * Longer delays between calls.
 */
const { api, delay } = require('./setup');

afterEach(() => delay(2000));

describe('GET /api/quote-sequence/:prefix', () => {
  test('returns prefix, year, and sequence number', async () => {
    const res = await api.get('/api/quote-sequence/JTEST');
    expect(res.status).toBe(200);
    expect(res.data.prefix).toBe('JTEST');
    expect(typeof res.data.year).toBe('number');
    expect(res.data.year).toBeGreaterThanOrEqual(2026);
    expect(typeof res.data.sequence).toBe('number');
    expect(res.data.sequence).toBeGreaterThanOrEqual(1);
  });

  test('consecutive calls return incrementing sequences', async () => {
    const res1 = await api.get('/api/quote-sequence/JTEST');
    await delay(1500);
    const res2 = await api.get('/api/quote-sequence/JTEST');
    expect(res2.data.sequence).toBe(res1.data.sequence + 1);
  });

  test('lowercase prefix gets uppercased', async () => {
    const res = await api.get('/api/quote-sequence/jtest');
    expect(res.status).toBe(200);
    expect(res.data.prefix).toBe('JTEST');
  });
});

describe('GET /api/quote-sequence — error cases', () => {
  test('special characters returns 400', async () => {
    const res = await api.get('/api/quote-sequence/AB$CD');
    expect(res.status).toBe(400);
    expect(res.data.error).toBeDefined();
  });

  test('too-long prefix returns 400', async () => {
    const res = await api.get('/api/quote-sequence/ABCDEFGHIJK');
    expect(res.status).toBe(400);
    expect(res.data.error).toBeDefined();
  });
});
