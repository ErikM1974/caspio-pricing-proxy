// GET /api/staff-page-access is cached 10 minutes (2026-09-09).
//
// The site caches this table 5 min itself and still asked for it 260 times in
// 19 hours (every expiry on every dyno, cold after each of its ~17 deploys a
// day). Pinned here:
//   • a repeat read inside the TTL costs ZERO Caspio calls
//   • ?refresh=true bypasses
//   • an EMPTY read is never cached — pinning "no restricted pages" would open
//     every dashboard to any staff login for ten minutes
//   • a Caspio failure is a 502 and the next request retries

jest.mock('../../src/utils/caspio', () => ({
  fetchAllCaspioPages: jest.fn(),
  makeCaspioRequest: jest.fn(),
}));

const express = require('express');
const { fetchAllCaspioPages } = require('../../src/utils/caspio');
const { clearAll } = require('../../src/utils/ttl-cache');
const router = require('../../src/routes/staff-page-access');

const RULES = [
  { Page: 'payroll.html', Allowed_Roles: 'admin,accountant', Allowed_Emails: '', Description: 'Payroll' },
  { Page: 'commissions.html', Allowed_Roles: 'admin', Allowed_Emails: 'erik@nwcustomapparel.com', Description: 'Commissions' },
];

let server;
let baseUrl;
beforeAll((done) => {
  const app = express();
  app.use('/api/staff-page-access', router);
  server = app.listen(0, () => { baseUrl = `http://127.0.0.1:${server.address().port}`; done(); });
});
afterAll((done) => { server.closeAllConnections(); server.close(done); });

beforeEach(() => {
  clearAll();
  fetchAllCaspioPages.mockReset();
  fetchAllCaspioPages.mockResolvedValue(RULES);
});

const get = async (q = '') => {
  const r = await fetch(`${baseUrl}/api/staff-page-access/${q}`);
  return { status: r.status, body: await r.json() };
};

test('a repeat read inside the TTL is served from memory', async () => {
  const a = await get();
  expect(a.status).toBe(200);
  expect(a.body.rules).toEqual(RULES);
  const b = await get();
  expect(b.body.rules).toEqual(RULES);
  expect(fetchAllCaspioPages).toHaveBeenCalledTimes(1);
  expect(fetchAllCaspioPages.mock.calls[0][0]).toBe('/tables/Staff_Page_Access/records');
});

test('?refresh=true bypasses the cache', async () => {
  await get();
  await get('?refresh=true');
  expect(fetchAllCaspioPages).toHaveBeenCalledTimes(2);
});

test('an empty read is served but never cached', async () => {
  fetchAllCaspioPages.mockResolvedValueOnce([]);
  expect((await get()).body.rules).toEqual([]);
  expect((await get()).body.rules).toEqual(RULES);
  expect(fetchAllCaspioPages).toHaveBeenCalledTimes(2);
});

test('a Caspio failure is a 502 and the next request retries', async () => {
  fetchAllCaspioPages.mockRejectedValueOnce(new Error('Caspio down'));
  expect((await get()).status).toBe(502);
  expect((await get()).status).toBe(200);
  expect(fetchAllCaspioPages).toHaveBeenCalledTimes(2);
});
