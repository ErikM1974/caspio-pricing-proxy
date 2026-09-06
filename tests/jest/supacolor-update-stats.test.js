// supacolor-jobs.js (2026-09-06):
//   • PUT /api/supacolor-jobs/:id — the update PUT asks for ?response=rows and returns
//     that row; there is no read-back GET any more (every update used to be 2 calls)
//   • GET /api/supacolor-jobs/stats — one GROUP BY read instead of a full scan of the
//     table (2+ pages on every cache miss) to produce three counters

const mockFetchAllCaspioPages = jest.fn();
jest.mock('../../src/utils/caspio', () => ({
  fetchAllCaspioPages: (...a) => mockFetchAllCaspioPages(...a),
  makeCaspioRequest: jest.fn(),
  getCaspioAccessToken: jest.fn(async () => 'tok'),
  putWithRecordsAffected: jest.fn(),
  postBulk: jest.fn(),
}));

const mockAxios = jest.fn();
jest.mock('axios', () => Object.assign((...a) => mockAxios(...a), {
  get: (...a) => mockAxios({ method: 'get', url: a[0], ...(a[1] || {}) }),
  put: (...a) => mockAxios({ method: 'put', url: a[0], data: a[1], ...(a[2] || {}) }),
  post: (...a) => mockAxios({ method: 'post', url: a[0], data: a[1], ...(a[2] || {}) }),
  delete: (...a) => mockAxios({ method: 'delete', url: a[0], ...(a[1] || {}) }),
}));

const express = require('express');
const router = require('../../src/routes/supacolor-jobs');
const { clearAll } = require('../../src/utils/ttl-cache');

async function call(method, path, body) {
  const app = express();
  app.use(express.json());
  app.use('/api', router);
  const server = app.listen(0);
  try {
    const { port } = server.address();
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      method, headers: body ? { 'Content-Type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: await res.json() };
  } finally {
    server.close();
  }
}

beforeEach(() => {
  mockAxios.mockReset();
  mockFetchAllCaspioPages.mockReset();
  clearAll();
});

describe('GET /api/supacolor-jobs/stats', () => {
  test('one GROUP BY read; Active is everything that is not Closed/Cancelled', async () => {
    mockFetchAllCaspioPages.mockResolvedValue([
      { Status: 'Open', N: 12 }, { Status: 'In Production', N: 3 }, { Status: 'Closed', N: 1180 }, { Status: 'Cancelled', N: 9 },
    ]);
    const r = await call('GET', '/api/supacolor-jobs/stats');
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ success: true, stats: { Active: 15, Closed: 1180, Cancelled: 9 }, total: 1204 });
    expect(mockFetchAllCaspioPages).toHaveBeenCalledTimes(1);
    const [resource, params] = mockFetchAllCaspioPages.mock.calls[0];
    expect(resource).toBe('/tables/Supacolor_Jobs/records');
    expect(params).toEqual({ 'q.select': 'Status, COUNT(*) AS N', 'q.groupBy': 'Status' });
  });
});

describe('PUT /api/supacolor-jobs/:id', () => {
  test('the PUT carries response=rows and its row is returned — no read-back GET', async () => {
    const existing = { ID_Job: 501, Supacolor_Job_Number: 'SC-1', Status: 'Open' };
    mockAxios.mockImplementation(async (cfg) => {
      if (cfg.method === 'get') return { data: { Result: [existing] } };            // the 404 check
      if (cfg.method === 'put') return { data: { Result: [{ ...existing, Status: 'Closed' }], RecordsAffected: 1 } };
      throw new Error('unexpected ' + cfg.method);
    });
    const r = await call('PUT', '/api/supacolor-jobs/501', { Status: 'Closed' });
    expect(r.status).toBe(200);
    const put = mockAxios.mock.calls.map(([c]) => c).find(c => c.method === 'put');
    expect(put.url).toMatch(/ID_Job=501&response=rows$/);
    expect(put.data).toEqual({ Status: 'Closed' });
    const gets = mockAxios.mock.calls.map(([c]) => c).filter(c => c.method === 'get');
    expect(gets).toHaveLength(1); // only the existence check that preceded the write
    expect(JSON.stringify(r.body)).toContain('"Status":"Closed"');
  });

  test('if Caspio omits the row from the PUT answer, it is fetched once as a fallback', async () => {
    const existing = { ID_Job: 502, Supacolor_Job_Number: 'SC-2', Status: 'Open' };
    mockAxios.mockImplementation(async (cfg) => {
      if (cfg.method === 'get') return { data: { Result: [existing] } };
      if (cfg.method === 'put') return { data: { RecordsAffected: 1 } };
      throw new Error('unexpected ' + cfg.method);
    });
    const r = await call('PUT', '/api/supacolor-jobs/502', { Status: 'Closed' });
    expect(r.status).toBe(200);
    expect(mockAxios.mock.calls.map(([c]) => c).filter(c => c.method === 'get')).toHaveLength(2);
  });
});
