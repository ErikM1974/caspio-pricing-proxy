// /api/policies-public/* reads are cached for 5 minutes (2026-09-06).
//
// The staff dashboard's policy page read the Policies table once per request —
// 46 Caspio reads in the first hour of a dyno, for content that changes a few
// times a week. Pinned here:
//   • list / tree / detail: a repeat public read costs ZERO Caspio calls
//   • detail keys per policy id; list keys per filter set
//   • a 404 is never cached
//   • ?refresh=true bypasses
//   • the ADMIN router never serves from cache, and any successful admin write
//     (POST / PUT / DELETE / move) clears the public cache
//   • a Caspio failure is still a 500, never stale data

const mockFetchAllCaspioPages = jest.fn();
jest.mock('../../src/utils/caspio', () => ({
  fetchAllCaspioPages: (...a) => mockFetchAllCaspioPages(...a),
  makeCaspioRequest: jest.fn(),
  getCaspioAccessToken: jest.fn(async () => 'tok'),
  putWithRecordsAffected: jest.fn(),
  postBulk: jest.fn(),
}));
const mockAxios = jest.fn(async () => ({ status: 200, data: { RecordsAffected: 1, Result: [] } }));
jest.mock('axios', () => Object.assign((...a) => mockAxios(...a), {
  get: (...a) => mockAxios({ method: 'get', url: a[0], ...(a[1] || {}) }),
  put: (...a) => mockAxios({ method: 'put', url: a[0], data: a[1], ...(a[2] || {}) }),
  post: (...a) => mockAxios({ method: 'post', url: a[0], data: a[1], ...(a[2] || {}) }),
  delete: (...a) => mockAxios({ method: 'delete', url: a[0], ...(a[1] || {}) }),
}));

const express = require('express');
const { publicRouter, adminRouter } = require('../../src/routes/policies');
const { clearAll } = require('../../src/utils/ttl-cache');

const ROWS = [
  { Policy_ID: 'refunds', Title: 'Refunds', Category: 'Customer Service', Status: 'Published', Is_Active: 1, Sort_Order: 1, Body_HTML: '<p>x</p>' },
  { Policy_ID: 'rush', Title: 'Rush orders', Category: 'Operations', Status: 'Published', Is_Active: 1, Sort_Order: 2, Body_HTML: '<p>y</p>' },
];

async function call(router, mount, method, path, body) {
  const app = express();
  app.use(express.json());
  app.use(mount, router);
  const server = app.listen(0);
  try {
    const { port } = server.address();
    const res = await fetch(`http://127.0.0.1:${port}${mount}${path}`, {
      method, headers: body ? { 'Content-Type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: await res.json() };
  } finally {
    server.close();
  }
}
const pub = (path) => call(publicRouter, '/api/policies-public', 'GET', path);

beforeEach(() => {
  mockFetchAllCaspioPages.mockReset();
  mockAxios.mockClear();
  clearAll();
  mockFetchAllCaspioPages.mockImplementation(async (resource, params) => {
    const where = params['q.where'] || '';
    const m = where.match(/Policy_ID='([^']+)'/);
    if (m) return ROWS.filter(r => r.Policy_ID === m[1]);
    return ROWS;
  });
});

describe('public reads', () => {
  test('detail twice = one Caspio read; a different id is its own key', async () => {
    const a = await pub('/refunds');
    const b = await pub('/refunds');
    expect(a.status).toBe(200);
    expect(a.body.policy.Policy_ID).toBe('refunds');
    expect(b.body).toEqual(a.body);
    expect(mockFetchAllCaspioPages).toHaveBeenCalledTimes(1);
    expect(mockFetchAllCaspioPages.mock.calls[0][1]['q.where']).toBe("Policy_ID='refunds' AND Status='Published' AND Is_Active=1");
    await pub('/rush');
    expect(mockFetchAllCaspioPages).toHaveBeenCalledTimes(2);
  });

  test('list and tree twice = one read each; filters are separate keys', async () => {
    await pub('/'); await pub('/');
    await pub('/tree'); await pub('/tree');
    expect(mockFetchAllCaspioPages).toHaveBeenCalledTimes(2);
    const list = await pub('/?category=Operations');
    expect(list.status).toBe(200);
    expect(mockFetchAllCaspioPages).toHaveBeenCalledTimes(3);
    expect(mockFetchAllCaspioPages.mock.calls[2][1]['q.where']).toContain("Category='Operations'");
  });

  test('a 404 is never cached', async () => {
    expect((await pub('/nope')).status).toBe(404);
    expect((await pub('/nope')).status).toBe(404);
    expect(mockFetchAllCaspioPages).toHaveBeenCalledTimes(2);
  });

  test('?refresh=true bypasses the cache', async () => {
    await pub('/refunds');
    await pub('/refunds?refresh=true');
    expect(mockFetchAllCaspioPages).toHaveBeenCalledTimes(2);
  });

  test('a Caspio failure is a 500 and nothing gets pinned', async () => {
    mockFetchAllCaspioPages.mockRejectedValueOnce(new Error('Caspio down'));
    expect((await pub('/refunds')).status).toBe(500);
    expect((await pub('/refunds')).status).toBe(200);
    expect(mockFetchAllCaspioPages).toHaveBeenCalledTimes(2);
  });
});

describe('admin router', () => {
  test('never serves from the public cache', async () => {
    await pub('/refunds');
    const r = await call(adminRouter, '/api/policies', 'GET', '/refunds');
    expect(r.status).toBe(200);
    expect(mockFetchAllCaspioPages).toHaveBeenCalledTimes(2);
    // and its read is not filtered to Published
    expect(mockFetchAllCaspioPages.mock.calls[1][1]['q.where']).toBe("Policy_ID='refunds'");
  });

  test('a successful admin write clears the public cache; a rejected one does not', async () => {
    await pub('/refunds');
    expect(mockFetchAllCaspioPages).toHaveBeenCalledTimes(1);

    // Rejected write (400: no Title) — cache untouched.
    const bad = await call(adminRouter, '/api/policies', 'POST', '/', { Category: 'HR' });
    expect(bad.status).toBe(400);
    await pub('/refunds');
    expect(mockFetchAllCaspioPages).toHaveBeenCalledTimes(1);

    // Successful DELETE (archive) — the next public read re-fetches.
    const del = await call(adminRouter, '/api/policies', 'DELETE', '/rush');
    expect(del.status).toBe(200);
    await pub('/refunds');
    expect(mockFetchAllCaspioPages).toHaveBeenCalledTimes(2);
  });
});
