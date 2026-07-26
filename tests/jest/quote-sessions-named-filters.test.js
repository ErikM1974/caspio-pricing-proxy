/**
 * Route tests for GET /api/quote_sessions filter handling (src/routes/quotes.js).
 *
 * Locks the 2026-07-26 Caspio-quota fix. The bug: the two hourly crons in the app
 * repo sent `?q.where=...&q.pageSize=...`, and this route has never read either
 * param. They were silently dropped, so `whereConditions` stayed empty and every
 * run fell through to a FULL, UNCACHED, UNORDERED scan of Quote_Sessions — 48x a
 * day, up to 20 pages each, silently truncating at the page cap.
 *
 * Three properties are locked here:
 *  1. syncCandidates=true / shipstationPending=true produce the exact predicates
 *     the crons need, server-side (allowlisted — no q.where passthrough).
 *  2. q.where is REJECTED rather than quietly ignored.
 *  3. q.orderBy is ALWAYS sent, including on the unfiltered path — an unordered
 *     multi-page Caspio read drops rows silently.
 *
 * Mounts the real router on an ephemeral express server with Caspio mocked.
 */

jest.mock('../../src/utils/caspio', () => ({
  makeCaspioRequest: jest.fn(),
  fetchAllCaspioPages: jest.fn(),
  putWithRecordsAffected: jest.fn()
}));

const express = require('express');
const axios = require('axios');
const { fetchAllCaspioPages } = require('../../src/utils/caspio');
const quotesRouter = require('../../src/routes/quotes');

let server;
let baseUrl;

beforeAll((done) => {
  const app = express();
  app.use(express.json());
  app.use('/api', quotesRouter);
  server = app.listen(0, () => {
    baseUrl = `http://127.0.0.1:${server.address().port}`;
    done();
  });
});

afterAll(() => new Promise((resolve) => {
  if (server.closeAllConnections) server.closeAllConnections();
  server.close(() => resolve());
}));

// validateStatus:null so 4xx/5xx resolve instead of throwing.
const request = (path) => axios.get(`${baseUrl}${path}`, { validateStatus: () => true });

/** Params / options handed to Caspio on the most recent read. */
function lastCaspioParams() {
  const call = fetchAllCaspioPages.mock.calls.at(-1);
  return call ? call[1] : null;
}
function lastCaspioOptions() {
  const call = fetchAllCaspioPages.mock.calls.at(-1);
  return call ? call[2] : null;
}

beforeEach(() => {
  jest.clearAllMocks();
  fetchAllCaspioPages.mockResolvedValue([]);
});

describe('GET /api/quote_sessions — named cron filters', () => {
  test('syncCandidates=true builds the ShopWorks sync predicate server-side', async () => {
    const res = await request('/api/quote_sessions?syncCandidates=true');
    expect(res.status).toBe(200);

    const where = lastCaspioParams()['q.where'];
    // DTG order-form flips Status to 'Processed'; EMB/SCP/DTF push handlers stamp
    // PushedToShopWorks and leave Status='Open' — hence the OR.
    expect(where).toContain("Status='Processed'");
    expect(where).toContain('PushedToShopWorks IS NOT NULL');
    // Cancelled rows excluded at the source, or the hourly re-sync re-stamps
    // ShopWorks_Last_Synced and resets the 30-day purge countdown daily.
    expect(where).toContain("Status<>'Cancelled_in_ShopWorks'");
  });

  test('shipstationPending=true builds the tracking-sweep predicate', async () => {
    const res = await request('/api/quote_sessions?shipstationPending=true');
    expect(res.status).toBe(200);

    const where = lastCaspioParams()['q.where'];
    expect(where).toContain('ShipStation_Order_ID>0');
    expect(where).toContain("ShipStation_Status<>'shipped'");
  });

  // The other half of the win: the old unfiltered path could not be cached at all
  // (quotes.js gates both the cache read AND write on whereConditions.length > 0),
  // so all 48 cron runs/day were guaranteed Caspio scans. A named filter populates
  // whereConditions, so the second identical run inside the TTL costs zero calls.
  test('a named filter is CACHEABLE — a repeat read makes no Caspio call', async () => {
    await request('/api/quote_sessions?syncCandidates=true&refresh=true'); // prime
    const callsAfterPrime = fetchAllCaspioPages.mock.calls.length;

    await request('/api/quote_sessions?syncCandidates=true'); // served from cache
    expect(fetchAllCaspioPages.mock.calls.length).toBe(callsAfterPrime);
  });
});

describe('GET /api/quote_sessions — q.where is rejected, never silently dropped', () => {
  test('q.where with no named filter returns 400 instead of scanning the table', async () => {
    const res = await request(
      "/api/quote_sessions?q.where=" + encodeURIComponent("Status='Processed'")
    );
    expect(res.status).toBe(400);
    expect(res.data.error).toMatch(/q\.where is not supported/i);
    expect(res.data.hint).toMatch(/syncCandidates/);
    // The whole point: no Caspio read happened at all.
    expect(fetchAllCaspioPages).not.toHaveBeenCalled();
  });

  test('the 400 names the supported filters so the caller can fix it', async () => {
    const res = await request('/api/quote_sessions?q.where=anything');
    expect(res.data.hint).toMatch(/shipstationPending/);
    expect(res.data.hint).toMatch(/createdAfter/);
  });
});

describe('GET /api/quote_sessions — stable pagination ordering', () => {
  test('orderBy is sent on a FILTERED read', async () => {
    await request('/api/quote_sessions?status=active');
    expect(lastCaspioParams()['q.orderBy']).toBe('PK_ID DESC');
  });

  // The regression: q.orderBy used to be set only inside the
  // `whereConditions.length > 0` branch, so the biggest, most expensive query on
  // the route was the one paging with no stable sort — and unordered multi-page
  // Caspio reads drop rows.
  test('orderBy is sent on the UNFILTERED read too', async () => {
    await request('/api/quote_sessions');
    expect(lastCaspioParams()['q.orderBy']).toBe('PK_ID DESC');
  });

  // refresh=true bypasses the response cache so we observe the real Caspio call.
  test('reads are strict, so a truncated page cap throws instead of returning a partial list', async () => {
    await request('/api/quote_sessions?syncCandidates=true&refresh=true');
    expect(lastCaspioOptions()).toEqual(expect.objectContaining({ strict: true }));
  });

  test('a truncation error surfaces as a failure, not a short list', async () => {
    const err = new Error('Caspio pagination truncated');
    err.code = 'CASPIO_PAGINATION_TRUNCATED';
    fetchAllCaspioPages.mockRejectedValueOnce(err);

    const res = await request('/api/quote_sessions?shipstationPending=true&refresh=true');
    expect(res.status).toBe(500);
  });
});
