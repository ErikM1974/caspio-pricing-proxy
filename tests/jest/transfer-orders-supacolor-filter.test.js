/**
 * Route tests for ?supacolorOrderNumber= on GET /api/transfer-orders
 * (src/routes/transfer-orders.js), added 2026-07-26.
 *
 * Replaces a full-table scan AND a silent wrong answer. pages/js/supacolor-job-detail.js
 * built a `q.where` URL into a variable it never used, then fetched
 * `/api/transfer-orders?pageSize=500` with NO filter — up to 20 pages / 10,000 rows
 * on every job-detail view — and matched client-side. A row falling past the page
 * cap made the panel render "no linked transfers" as if that were a fact.
 *
 * Also locks the stable-sort fix: Requested_At is not unique, and Caspio paginates
 * tied/unordered rows non-deterministically, silently dropping or duplicating rows
 * across page boundaries.
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
const transferRouter = require('../../src/routes/transfer-orders');

let server;
let baseUrl;

beforeAll((done) => {
  const app = express();
  app.use(express.json());
  app.use('/api', transferRouter);
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

function lastParams() {
  const call = fetchAllCaspioPages.mock.calls.at(-1);
  return call ? call[1] : null;
}

beforeEach(() => {
  jest.clearAllMocks();
  fetchAllCaspioPages.mockResolvedValue([]);
});

describe('GET /api/transfer-orders?supacolorOrderNumber — server-side filter', () => {
  test('filters on Supacolor_Order_Number instead of scanning the table', async () => {
    const res = await request('/api/transfer-orders?supacolorOrderNumber=112759');
    expect(res.status).toBe(200);
    expect(lastParams()['q.where']).toBe("Supacolor_Order_Number='112759'");
  });

  test('the job-detail page no longer reads the whole table', async () => {
    // The old behaviour: no q.where at all, pageSize=500, up to 20 pages.
    await request('/api/transfer-orders?supacolorOrderNumber=112759');
    expect(lastParams()['q.where']).toBeTruthy();
  });

  test('combines with the other allowlisted filters', async () => {
    await request('/api/transfer-orders?supacolorOrderNumber=112759&status=Ordered');
    const where = lastParams()['q.where'];
    expect(where).toContain("Supacolor_Order_Number='112759'");
    expect(where).toContain("Status='Ordered'");
    expect(where).toContain(' AND ');
  });

  test('absent param leaves the other filters untouched', async () => {
    await request('/api/transfer-orders?status=Ordered');
    expect(lastParams()['q.where']).toBe("Status='Ordered'");
  });
});

describe('GET /api/transfer-orders?supacolorOrderNumber — injection guard', () => {
  test("escapes single quotes rather than letting them close the literal", async () => {
    await request('/api/transfer-orders?supacolorOrderNumber=' + encodeURIComponent("112759' OR '1'='1"));
    const where = lastParams()['q.where'];
    // Doubled quotes keep the whole payload inside one string literal.
    expect(where).toBe("Supacolor_Order_Number='112759'' OR ''1''=''1'");
    // The dangerous shape would be an unescaped `' OR '` breaking out.
    expect(where).not.toContain("='112759' OR '1'='1'");
  });

  test('a DROP TABLE payload stays inert inside the literal', async () => {
    await request('/api/transfer-orders?supacolorOrderNumber=' + encodeURIComponent("x'; DROP TABLE Transfer_Orders--"));
    const where = lastParams()['q.where'];
    expect(where).toBe("Supacolor_Order_Number='x''; DROP TABLE Transfer_Orders--'");
    expect(where.match(/'/g).length % 2).toBe(0); // quotes stay balanced
  });
});

describe('GET /api/transfer-orders — stable multi-page ordering', () => {
  // Requested_At is not unique; Caspio paginates ties non-deterministically and
  // silently drops/duplicates rows across page boundaries.
  test('appends PK_ID as a tiebreak to the default sort', async () => {
    await request('/api/transfer-orders');
    expect(lastParams()['q.orderBy']).toBe('Requested_At DESC, PK_ID DESC');
  });

  test('appends the tiebreak to a caller-supplied sort too', async () => {
    await request('/api/transfer-orders?orderBy=' + encodeURIComponent('Company_Name ASC'));
    expect(lastParams()['q.orderBy']).toBe('Company_Name ASC, PK_ID DESC');
  });

  test('does not double up when the caller already sorts by PK_ID', async () => {
    await request('/api/transfer-orders?orderBy=' + encodeURIComponent('PK_ID ASC'));
    expect(lastParams()['q.orderBy']).toBe('PK_ID ASC');
  });
});
