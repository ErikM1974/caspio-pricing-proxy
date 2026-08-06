/**
 * Route tests for GET /api/thumbnails/by-designs (src/routes/thumbnails.js).
 *
 * WHY THIS EXISTS
 * Shopworks_Thumbnail_Report stores one row per design PER LOCATION (the key is
 * Thumb_DesLocid_Design), so a batch of N designs can legitimately match many more
 * than N rows. The route sized its Caspio page as `q.limit: uncachedIds.length`,
 * so the page filled with the earlier designs' location rows and every design past
 * the cut came back `found: false` — and that wrong answer was then cached for the
 * 5-minute TTL.
 *
 * Because rows come back in serial order, the designs that got dropped were the
 * NEWEST ones. That is precisely what a SanMar inbound sheet is full of, so real
 * artwork rendered as the "no logo" tile and it read as a ShopWorks/bandit sync
 * lag. Measured live 2026-08-06: design 40738 resolved alone and in batches up to
 * 12, and vanished at 16 and 20.
 *
 * Mounts the real router on an ephemeral express server with Caspio mocked.
 */

jest.mock('../../src/utils/caspio', () => ({
  getCaspioAccessToken: jest.fn().mockResolvedValue('test-token'),
  makeCaspioRequest: jest.fn(),
  fetchAllCaspioPages: jest.fn()
}));

const express = require('express');
const axios = require('axios');
const { makeCaspioRequest } = require('../../src/utils/caspio');
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

const request = (path) => axios.get(`${baseUrl}${path}`, { validateStatus: () => true });

// Distinct ids per test so the route's in-process 5-minute cache never bleeds
// between cases (a cached `found:false` would mask the very bug under test).
let seq = 0;
const freshIds = (n) => {
  const base = 50000 + (seq++ * 100);
  return Array.from({ length: n }, (_, i) => String(base + i));
};

const rowFor = (id, loc = 1) => ({
  Thumb_DesLocid_Design: id,
  ID_Serial: Number(id) * 10 + loc,
  FileName: `${id}_loc${loc}.png`,
  ExternalKey: '',
  Thumb_DesLoc_DesDesignName: `Design ${id}`,
  FileUrl: `https://example.test/api/box/thumbnail/${id}${loc}`
});

beforeEach(() => makeCaspioRequest.mockReset());

describe('by-designs asks Caspio for enough rows to cover multi-location designs', () => {
  test('the page size is NOT the number of designs requested', async () => {
    const ids = freshIds(18);
    makeCaspioRequest.mockResolvedValue(ids.map((id) => rowFor(id)));

    await request(`/api/thumbnails/by-designs?ids=${ids.join(',')}`);

    expect(makeCaspioRequest).toHaveBeenCalledTimes(1);
    const params = makeCaspioRequest.mock.calls[0][2];
    expect(params['q.limit']).toBeGreaterThan(ids.length);
  });

  test('every requested design is still reported found when each has several location rows', async () => {
    const ids = freshIds(18);
    // 3 location rows per design — 54 rows for 18 designs.
    // The mock HONOURS q.limit, because that is the whole defect: Caspio truncates
    // the page and the route reads the short list as "these designs have no
    // artwork". A mock that returns everything regardless of q.limit would pass
    // against the buggy code and prove nothing.
    const rows = ids.flatMap((id) => [rowFor(id, 1), rowFor(id, 2), rowFor(id, 3)]);
    makeCaspioRequest.mockImplementation((verb, resource, params) =>
      Promise.resolve(rows.slice(0, params['q.limit'])));

    const res = await request(`/api/thumbnails/by-designs?ids=${ids.join(',')}`);
    expect(res.status).toBe(200);

    const th = res.data.thumbnails;
    const missing = ids.filter((id) => !th[id] || !th[id].found);
    expect(missing).toEqual([]);
  });

  test('the requested page is big enough for the route\'s own 20-id ceiling', async () => {
    const ids = freshIds(20);
    makeCaspioRequest.mockResolvedValue([]);

    await request(`/api/thumbnails/by-designs?ids=${ids.join(',')}`);

    const params = makeCaspioRequest.mock.calls[0][2];
    // 20 designs must be able to carry multiple locations each without truncating.
    expect(params['q.limit']).toBeGreaterThanOrEqual(20 * 20);
  });

  test('a design with no row is still reported found:false (not silently absent)', async () => {
    const ids = freshIds(3);
    makeCaspioRequest.mockResolvedValue([rowFor(ids[0])]);

    const res = await request(`/api/thumbnails/by-designs?ids=${ids.join(',')}`);
    const th = res.data.thumbnails;

    expect(th[ids[0]].found).toBe(true);
    expect(th[ids[1]]).toEqual(expect.objectContaining({ found: false }));
    expect(th[ids[2]]).toEqual(expect.objectContaining({ found: false }));
  });
});

describe('by-designs input guards still hold', () => {
  test('more than 20 ids is rejected, and rejected LOUDLY (400, not a short answer)', async () => {
    const ids = freshIds(21);
    const res = await request(`/api/thumbnails/by-designs?ids=${ids.join(',')}`);
    expect(res.status).toBe(400);
    expect(makeCaspioRequest).not.toHaveBeenCalled();
  });

  test('missing ids parameter is a 400', async () => {
    const res = await request('/api/thumbnails/by-designs');
    expect(res.status).toBe(400);
  });
});
