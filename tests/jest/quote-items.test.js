/**
 * Quote Items CRUD lifecycle tests.
 * Creates a parent session in beforeAll, then tests item CRUD.
 * Cleans up both items and session in afterAll.
 *
 * NOTE: Caspio REST API PUT/DELETE with q.where may have eventual consistency.
 * Tests validate the proxy accepts requests correctly (status codes, validation).
 */
const { api, delay, testId, trackForCleanup, cleanupAll } = require('./setup');

const QUOTE_ID = testId('ITEM');
const SESSION_ID = `sid-item-${Date.now()}`;
let sessionPkId = null;
let itemPkId = null;

afterEach(() => delay(1500));

afterAll(async () => {
  await cleanupAll();
});

// ── Setup: create parent session ───────────────────────────────────

beforeAll(async () => {
  await api.post('/api/quote_sessions', {
    QuoteID: QUOTE_ID,
    SessionID: SESSION_ID,
    CustomerName: 'Jest Item Test',
    CompanyName: 'Jest Items Inc',
    TotalAmount: 50.00,
    TotalQuantity: 24,
    Status: 'Draft',
  });
  await delay(2000);

  // Fetch the session to get PK_ID for cleanup
  const getRes = await api.get('/api/quote_sessions', {
    params: { filter: `QuoteID='${QUOTE_ID}'` },
  });
  if (getRes.data?.length > 0) {
    sessionPkId = getRes.data[0].PK_ID;
    trackForCleanup('session', sessionPkId);
  }
  await delay(1500);
});

// ── CREATE ─────────────────────────────────────────────────────────

describe('POST /api/quote_items', () => {
  test('creates an item and returns 201', async () => {
    const body = {
      QuoteID: QUOTE_ID,
      StyleNumber: 'PC54',
      Color: 'Cardinal',
      EmbellishmentType: 'embroidery',
      Quantity: 24,
      FinalUnitPrice: 12.50,
      LineTotal: 300.00,
      SizeBreakdown: 'S:6,M:6,L:6,XL:6',
    };
    const res = await api.post('/api/quote_items', body);
    expect(res.status).toBe(201);
    expect(res.data.success).toBe(true);
  });

  test('missing required fields returns 400', async () => {
    const res = await api.post('/api/quote_items', {});
    expect(res.status).toBe(400);
    expect(res.data.error).toBeDefined();
  });

  test('missing Quantity returns 400', async () => {
    const res = await api.post('/api/quote_items', {
      QuoteID: QUOTE_ID,
      StyleNumber: 'PC54',
    });
    expect(res.status).toBe(400);
  });
});

// ── READ ───────────────────────────────────────────────────────────

describe('GET /api/quote_items — read created item', () => {
  test('finds item by QuoteID', async () => {
    // Allow Caspio time to propagate the new record
    await delay(3000);
    const res = await api.get('/api/quote_items', {
      params: { filter: `QuoteID='${QUOTE_ID}'` },
    });
    expect(res.status).toBe(200);
    expect(Array.isArray(res.data)).toBe(true);
    expect(res.data.length).toBeGreaterThanOrEqual(1);

    // Find our specific item (filter may include other items with same QuoteID)
    const pc54 = res.data.find(item => item.StyleNumber === 'PC54');
    expect(pc54).toBeDefined();
    expect(typeof pc54.PK_ID).toBe('number');

    // Capture PK_ID for update/delete
    itemPkId = pc54.PK_ID;
    trackForCleanup('item', itemPkId);
  });
});

// ── UPDATE ─────────────────────────────────────────────────────────

describe('PUT /api/quote_items/:id', () => {
  test('returns 200 for valid update', async () => {
    if (!itemPkId) return;
    const res = await api.put(`/api/quote_items/${itemPkId}`, {
      Quantity: 48,
    });
    expect(res.status).toBe(200);
  });

  test('empty body returns 400', async () => {
    if (!itemPkId) return;
    const res = await api.put(`/api/quote_items/${itemPkId}`, {});
    expect(res.status).toBe(400);
    expect(res.data.error).toMatch(/no valid fields/i);
  });
});

// ── DELETE ──────────────────────────────────────────────────────────

describe('DELETE /api/quote_items/:id', () => {
  test('returns 200 for delete', async () => {
    if (!itemPkId) return;
    const res = await api.delete(`/api/quote_items/${itemPkId}`);
    expect(res.status).toBe(200);
    expect(res.data.message).toMatch(/deleted/i);
  });
});
