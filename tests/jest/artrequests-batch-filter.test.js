/**
 * Route tests for the ?id_designs= batch filter on GET /api/artrequests
 * (src/routes/art.js), added 2026-07-26 for Caspio quota reduction.
 *
 * Replaces an N+1: the Art Invoices dashboard resolved design numbers one HTTP
 * request at a time (its "batches of 10" chunked concurrency, not the query), and
 * /api/artrequests has no server-side cache — so ~100 designs on screen meant
 * ~100 Caspio reads, repeated by a 5-minute unguarded auto-refresh.
 *
 * The filter interpolates ids into an IN (...) clause, so the injection guard is
 * the security-critical part here: every element goes through reqInt(), which
 * returns null for anything that is not a positive integer.
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
const { fetchAllCaspioPages } = require('../../src/utils/caspio');
const artRouter = require('../../src/routes/art');

let server;
let baseUrl;

beforeAll((done) => {
  const app = express();
  app.use('/api', artRouter);
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

function lastWhere() {
  const call = fetchAllCaspioPages.mock.calls.at(-1);
  return call ? call[1]['q.where'] : null;
}

beforeEach(() => {
  jest.clearAllMocks();
  fetchAllCaspioPages.mockResolvedValue([]);
});

describe('GET /api/artrequests?id_designs — batching', () => {
  test('collapses many design ids into ONE IN (...) query', async () => {
    const res = await request('/api/artrequests?id_designs=101,102,103');
    expect(res.status).toBe(200);
    expect(fetchAllCaspioPages).toHaveBeenCalledTimes(1);
    expect(lastWhere()).toBe('ID_Design IN (101,102,103)');
  });

  test('de-duplicates repeated ids', async () => {
    await request('/api/artrequests?id_designs=101,101,102');
    expect(lastWhere()).toBe('ID_Design IN (101,102)');
  });

  test('still supports the single id_design form', async () => {
    await request('/api/artrequests?id_design=555');
    expect(lastWhere()).toBe('ID_Design=555');
  });

  test('combines with other filters', async () => {
    await request('/api/artrequests?id_designs=1,2&status=Completed');
    expect(lastWhere()).toContain('ID_Design IN (1,2)');
    expect(lastWhere()).toContain("Status='Completed'");
  });
});

describe('GET /api/artrequests?id_designs — injection guard', () => {
  test('drops non-integer elements instead of interpolating them', async () => {
    await request(
      '/api/artrequests?id_designs=' + encodeURIComponent("101,1 OR 1=1,102,'; DROP TABLE ArtRequests--")
    );
    const where = lastWhere();
    expect(where).toBe('ID_Design IN (101,102)');
    expect(where).not.toMatch(/OR/i);
    expect(where).not.toMatch(/DROP/i);
    expect(where).not.toContain("'");
  });

  test.each([
    ['1.5'],
    ['-5'],
    ['0'],
    ['abc'],
    ['1e3']
  ])('rejects %s as an id', async (bad) => {
    const res = await request('/api/artrequests?id_designs=' + encodeURIComponent(bad));
    expect(res.status).toBe(400);
    expect(fetchAllCaspioPages).not.toHaveBeenCalled();
  });

  test('400s when nothing valid survives sanitization — never a full-table scan', async () => {
    const res = await request('/api/artrequests?id_designs=' + encodeURIComponent("';--"));
    expect(res.status).toBe(400);
    expect(res.data.error).toMatch(/no valid ids/i);
    // The dangerous failure mode would be an empty IN() or a dropped filter that
    // silently returns the whole table.
    expect(fetchAllCaspioPages).not.toHaveBeenCalled();
  });

  test('caps the list so one request cannot build an unbounded IN clause', async () => {
    const ids = Array.from({ length: 201 }, (_, i) => i + 1).join(',');
    const res = await request('/api/artrequests?id_designs=' + ids);
    expect(res.status).toBe(400);
    expect(res.data.error).toMatch(/at most 200/i);
    expect(fetchAllCaspioPages).not.toHaveBeenCalled();
  });

  test('accepts exactly 200 ids', async () => {
    const ids = Array.from({ length: 200 }, (_, i) => i + 1).join(',');
    const res = await request('/api/artrequests?id_designs=' + ids);
    expect(res.status).toBe(200);
  });
});
