/**
 * Quote Sessions CRUD lifecycle tests.
 * Creates → reads → updates → deletes a test session.
 * Uses longer delays to avoid rate limits.
 *
 * NOTE: Caspio REST API PUT/DELETE with q.where may have eventual consistency.
 * Tests validate the proxy accepts requests correctly (status codes, validation).
 */
const { api, delay, testId, trackForCleanup, cleanupAll } = require('./setup');

const QUOTE_ID = testId('SESS');
const SESSION_ID = `sid-${Date.now()}`;
let createdPkId = null;

afterEach(() => delay(1500));

afterAll(async () => {
  await cleanupAll();
});

// ── READ (baseline) ────────────────────────────────────────────────

describe('GET /api/quote_sessions', () => {
  test('returns empty array for nonexistent QuoteID', async () => {
    const res = await api.get('/api/quote_sessions', {
      params: { filter: `QuoteID='NONEXISTENT-${Date.now()}'` },
    });
    expect(res.status).toBe(200);
    expect(Array.isArray(res.data)).toBe(true);
    expect(res.data.length).toBe(0);
  });
});

// ── CREATE ─────────────────────────────────────────────────────────

describe('POST /api/quote_sessions', () => {
  test('creates a session and returns 201', async () => {
    const body = {
      QuoteID: QUOTE_ID,
      SessionID: SESSION_ID,
      CustomerName: 'Jest Test Customer',
      CompanyName: 'Jest Testing Inc',
      TotalAmount: 100.00,
      TotalQuantity: 10,
      Status: 'Draft',
    };
    const res = await api.post('/api/quote_sessions', body);
    expect(res.status).toBe(201);
    expect(res.data.success).toBe(true);
  });

  test('missing required fields returns 400', async () => {
    const res = await api.post('/api/quote_sessions', {});
    expect(res.status).toBe(400);
    expect(res.data.error).toBeDefined();
  });

  test('missing SessionID returns 400', async () => {
    const res = await api.post('/api/quote_sessions', {
      QuoteID: 'INCOMPLETE',
      Status: 'Draft',
    });
    expect(res.status).toBe(400);
  });
});

// ── READ by filter ─────────────────────────────────────────────────

describe('GET /api/quote_sessions — read created session', () => {
  test('finds the created session by QuoteID', async () => {
    const res = await api.get('/api/quote_sessions', {
      params: { filter: `QuoteID='${QUOTE_ID}'` },
    });
    expect(res.status).toBe(200);
    expect(Array.isArray(res.data)).toBe(true);
    expect(res.data.length).toBe(1);
    expect(res.data[0].CustomerName).toBe('Jest Test Customer');
    expect(res.data[0].CompanyName).toBe('Jest Testing Inc');
    expect(res.data[0].TotalAmount).toBe(100);

    // Capture PK_ID for update/delete
    createdPkId = res.data[0].PK_ID;
    trackForCleanup('session', createdPkId);
  });
});

// ── UPDATE ─────────────────────────────────────────────────────────

describe('PUT /api/quote_sessions/:id', () => {
  test('returns 200 for valid update', async () => {
    if (!createdPkId) return;
    const res = await api.put(`/api/quote_sessions/${createdPkId}`, {
      Status: 'Sent',
    });
    expect(res.status).toBe(200);
  });

  test('empty body returns 400', async () => {
    if (!createdPkId) return;
    const res = await api.put(`/api/quote_sessions/${createdPkId}`, {});
    expect(res.status).toBe(400);
    expect(res.data.error).toMatch(/no valid fields/i);
  });
});

// ── DELETE ──────────────────────────────────────────────────────────

describe('DELETE /api/quote_sessions/:id', () => {
  test('returns 200 for delete', async () => {
    if (!createdPkId) return;
    const res = await api.delete(`/api/quote_sessions/${createdPkId}`);
    expect(res.status).toBe(200);
    expect(res.data.message).toMatch(/deleted/i);
  });
});
