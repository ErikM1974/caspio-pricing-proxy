/**
 * Health & Status endpoint tests.
 * Read-only — no cleanup needed.
 */
const { api, delay } = require('./setup');

afterEach(() => delay(1000));

describe('GET /api/health', () => {
  let res;

  beforeAll(async () => {
    res = await api.get('/api/health');
  });

  test('returns 200', () => {
    expect(res.status).toBe(200);
  });

  test('status is healthy', () => {
    expect(res.data.status).toBe('healthy');
  });

  test('has valid uptime number', () => {
    expect(typeof res.data.server.uptime).toBe('number');
    expect(res.data.server.uptime).toBeGreaterThan(0);
  });

  test('has ISO timestamp', () => {
    const ts = new Date(res.data.timestamp);
    expect(ts.getTime()).not.toBeNaN();
  });
});

describe('GET /api/status', () => {
  test('returns running status', async () => {
    const res = await api.get('/api/status');
    expect(res.status).toBe(200);
    expect(res.data.status).toMatch(/running/i);
    expect(res.data.timestamp).toBeDefined();
  });
});
