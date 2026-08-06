/**
 * Route tests for GET /api/thumbnails/sync-status (src/routes/thumbnails.js).
 *
 * WHY THIS EXISTS
 * The endpoint reported `totalRecords: 20000, recordsWithImages: 0,
 * recordsNeedingImages: 20000` — wrong three times over:
 *
 *  1. It counted only `ExternalKey`, the RETIRED Caspio Files key. Artwork moved
 *     to Box and is addressed by `FileUrl`, so it answered "no artwork anywhere"
 *     about a table where 26,990 of 27,665 rows have an image.
 *  2. 20000 was the pagination cap (maxPages 20 × 1000), not a count. The scan
 *     did not pass `strict`, so truncation was silent and the short number was
 *     presented as fact. True size measured 2026-08-06: 27,665.
 *  3. Counting meant paging the whole table (~28 Caspio reads) on every uncached
 *     call, for a figure nobody asked for. `lastSync` — the field that answers
 *     "is the thumbnail sync stalled?" — costs one read, so counts are now opt-in.
 */

jest.mock('../../src/utils/caspio', () => ({
  getCaspioAccessToken: jest.fn().mockResolvedValue('test-token'),
  makeCaspioRequest: jest.fn(),
  fetchAllCaspioPages: jest.fn()
}));

const express = require('express');
const axios = require('axios');
const { makeCaspioRequest, fetchAllCaspioPages } = require('../../src/utils/caspio');
const thumbnailsRouter = require('../../src/routes/thumbnails');

let server;
let baseUrl;

beforeAll((done) => {
  const app = express();
  app.use('/api', thumbnailsRouter);
  server = app.listen(0, () => {
    baseUrl = `http://127.0.0.1:${server.address().port}`;
    done();
  });
});

afterAll(() => new Promise((resolve) => {
  if (server.closeAllConnections) server.closeAllConnections();
  server.close(() => resolve());
}));

// Always refresh=true: the route holds a 5-minute in-process cache, and a hit
// would let a test pass without exercising the code it claims to cover.
const get = (qs = '') =>
  axios.get(`${baseUrl}/api/thumbnails/sync-status?refresh=true${qs}`, { validateStatus: () => true });

beforeEach(() => {
  makeCaspioRequest.mockReset();
  fetchAllCaspioPages.mockReset();
  makeCaspioRequest.mockResolvedValue([{ timestamp_Added: '2026-08-05T14:22:02' }]);
  fetchAllCaspioPages.mockResolvedValue([]);
});

describe('sync-status is cheap by default', () => {
  test('reports lastSync from a single read and does NOT scan the table', async () => {
    const res = await get();

    expect(res.status).toBe(200);
    expect(res.data.lastSync).toBe('2026-08-05T14:22:02');
    expect(res.data.counts).toBeNull();
    // The whole point: no 28-page scan for a caller that only wants freshness.
    expect(fetchAllCaspioPages).not.toHaveBeenCalled();
    expect(makeCaspioRequest).toHaveBeenCalledTimes(1);
  });

  test('says how to get counts rather than silently omitting them', async () => {
    const res = await get();
    expect(String(res.data.countsHint)).toMatch(/counts=true/);
  });
});

describe('?counts=true counts rows that actually have an image', () => {
  // Streamed via pageCallback, so the mock must feed rows the way the real
  // paginator does rather than just resolving an array.
  const feed = (rows) => fetchAllCaspioPages.mockImplementation(async (path, params, opts) => {
    if (opts && opts.pageCallback) opts.pageCallback(rows, 1);
    return opts && opts.discardResults ? [] : rows;
  });

  test('a Box FileUrl counts as an image even with no ExternalKey', async () => {
    feed([
      { ID_Serial: 1, ExternalKey: '', FileUrl: 'https://proxy.test/api/box/thumbnail/111' },
      { ID_Serial: 2, ExternalKey: '', FileUrl: 'https://proxy.test/api/box/thumbnail/222' },
      { ID_Serial: 3, ExternalKey: '', FileUrl: '' }
    ]);

    const res = await get('&counts=true');

    // Under the old ExternalKey-only rule this was 0 with images / 3 needing.
    expect(res.data.counts).toEqual({
      totalRecords: 3,
      recordsWithImages: 2,
      recordsNeedingImages: 1
    });
  });

  test('a legacy ExternalKey row still counts', async () => {
    feed([
      { ID_Serial: 1, ExternalKey: 'ABC123', FileUrl: '' },
      { ID_Serial: 2, ExternalKey: '   ', FileUrl: '   ' }
    ]);

    const res = await get('&counts=true');
    expect(res.data.counts.recordsWithImages).toBe(1);
    expect(res.data.counts.recordsNeedingImages).toBe(1);
  });

  test('the scan is strict and roomy — truncation must throw, never under-report', async () => {
    feed([]);
    await get('&counts=true');

    const opts = fetchAllCaspioPages.mock.calls[0][2];
    expect(opts.strict).toBe(true);          // a hit page cap errors instead of lying
    expect(opts.discardResults).toBe(true);  // 27k rows never held in dyno memory
    expect(opts.maxPages).toBeGreaterThan(28); // real table is ~28 pages today
  });

  test('selects FileUrl — counting it is impossible if it is not fetched', async () => {
    feed([]);
    await get('&counts=true');

    const params = fetchAllCaspioPages.mock.calls[0][1];
    expect(params['q.select']).toMatch(/FileUrl/);
    expect(params['q.select']).toMatch(/ExternalKey/);
  });

  test('a truncated scan surfaces as an error, not a plausible smaller number', async () => {
    const err = new Error('Caspio pagination truncated: hit maxPages');
    err.code = 'CASPIO_PAGINATION_TRUNCATED';
    fetchAllCaspioPages.mockRejectedValue(err);

    const res = await get('&counts=true');

    expect(res.status).toBe(500);
    expect(res.data.success).toBe(false);
  });
});
