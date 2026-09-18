// GET /api/quote_sessions caches list reads per-filter for 5 minutes, so EVERY
// write to Quote_Sessions has to drop that cache or the next read serves the
// pre-write answer — a quiet wrong answer (Rule 4), not a slow one.
//
// The bug this pins (2026-09-17, reported by Taneisha):
//   1. Opening a lead in the Leads workspace auto-runs the CustomerEmail lookup,
//      which caches the EMPTY "no quotes yet" result.
//   2. The rep clicks through to a builder and saves a quote for that lead (POST).
//   3. Back on the lead, "check again" re-read the SAME cache key and still said
//      "No quotes for … yet" — for up to 5 more minutes.
// Only DELETE invalidated; POST and PUT did not, and neither did the three
// ShopWorks push routes that stamp PushedToShopWorks.
//
// Pinned here:
//   • a cached filter is served without a second Caspio read (the cache still works)
//   • POST, PUT and DELETE each drop it, so the next read hits Caspio again
//   • ?refresh=true bypasses a warm cache
//   • the Leads sequence end-to-end: empty read → save → next read finds the quote

jest.mock('../../src/utils/caspio', () => ({
  fetchAllCaspioPages: jest.fn(),
  makeCaspioRequest: jest.fn(async () => ({ success: true, status: 201 })),
}));

const express = require('express');
const { fetchAllCaspioPages, makeCaspioRequest } = require('../../src/utils/caspio');
const quoteSessionsCache = require('../../src/utils/quote-sessions-cache');
const router = require('../../src/routes/quotes');

const LEAD_EMAIL = 'velasco.d26@gmail.com';
const QUOTE = {
  PK_ID: 4411,
  QuoteID: 'EMB0917-1',
  SessionID: 'sess-emb0917-1',
  Status: 'Quoted',
  CustomerEmail: LEAD_EMAIL,
  TotalAmount: 1736.75,
};

let server;
let baseUrl;

beforeAll((done) => {
  const app = express();
  app.use(express.json());
  app.use('/api', router);
  server = app.listen(0, () => { baseUrl = `http://127.0.0.1:${server.address().port}`; done(); });
});
afterAll((done) => { server.closeAllConnections(); server.close(done); });

beforeEach(() => {
  jest.clearAllMocks();
  quoteSessionsCache.invalidate('test reset');
  makeCaspioRequest.mockResolvedValue({ success: true, status: 201 });
});

const byEmail = (qs = '') =>
  fetch(`${baseUrl}/api/quote_sessions?customerEmail=${encodeURIComponent(LEAD_EMAIL)}${qs}`)
    .then((r) => r.json());

describe('GET /api/quote_sessions caching', () => {
  test('serves a repeat read from cache without a second Caspio call', async () => {
    fetchAllCaspioPages.mockResolvedValue([QUOTE]);

    await expect(byEmail()).resolves.toEqual([QUOTE]);
    await expect(byEmail()).resolves.toEqual([QUOTE]);

    expect(fetchAllCaspioPages).toHaveBeenCalledTimes(1);
  });

  test('?refresh=true bypasses a warm cache', async () => {
    fetchAllCaspioPages.mockResolvedValue([QUOTE]);

    await byEmail();
    await byEmail('&refresh=true');

    expect(fetchAllCaspioPages).toHaveBeenCalledTimes(2);
  });
});

describe('every Quote_Sessions write drops the cache', () => {
  test('POST (a rep saving a quote) invalidates', async () => {
    fetchAllCaspioPages.mockResolvedValue([]);
    await byEmail();
    expect(fetchAllCaspioPages).toHaveBeenCalledTimes(1);

    await fetch(`${baseUrl}/api/quote_sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ QuoteID: QUOTE.QuoteID, SessionID: QUOTE.SessionID, Status: QUOTE.Status }),
    });

    await byEmail();
    expect(fetchAllCaspioPages).toHaveBeenCalledTimes(2);
  });

  test('PUT (a revision / status change) invalidates', async () => {
    fetchAllCaspioPages.mockResolvedValue([QUOTE]);
    await byEmail();
    expect(fetchAllCaspioPages).toHaveBeenCalledTimes(1);

    await fetch(`${baseUrl}/api/quote_sessions/${QUOTE.PK_ID}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ Status: 'Payment Confirmed' }),
    });

    await byEmail();
    expect(fetchAllCaspioPages).toHaveBeenCalledTimes(2);
  });

  test('DELETE invalidates (no ghost rows)', async () => {
    fetchAllCaspioPages.mockResolvedValue([QUOTE]);
    await byEmail();
    expect(fetchAllCaspioPages).toHaveBeenCalledTimes(1);

    makeCaspioRequest.mockResolvedValue({ RecordsAffected: 1 });
    await fetch(`${baseUrl}/api/quote_sessions/${QUOTE.PK_ID}`, { method: 'DELETE' });

    await byEmail();
    expect(fetchAllCaspioPages).toHaveBeenCalledTimes(2);
  });
});

describe("the Leads workspace sequence that reported this", () => {
  test('lead opened (no quotes) → rep saves a quote → next lookup finds it', async () => {
    // 1. Lead opened. Nothing saved yet — this empty answer is what used to stick.
    fetchAllCaspioPages.mockResolvedValue([]);
    await expect(byEmail()).resolves.toEqual([]);

    // 2. The rep builds and saves the quote for that same email.
    await fetch(`${baseUrl}/api/quote_sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        QuoteID: QUOTE.QuoteID,
        SessionID: QUOTE.SessionID,
        Status: QUOTE.Status,
        CustomerEmail: LEAD_EMAIL,
        TotalAmount: QUOTE.TotalAmount,
      }),
    });

    // 3. "check again" on the lead must now see it, not the cached empty array.
    fetchAllCaspioPages.mockResolvedValue([QUOTE]);
    await expect(byEmail()).resolves.toEqual([QUOTE]);
  });
});
