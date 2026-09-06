// POST /api/taneisha-accounts/sync-sales — diff-before-write, end to end through
// the route (2026-09-06 Caspio quota reduction). The Nika handler is the same
// code with the table names swapped; one route test pins the shape for both.
//
// Fixture: three accounts.
//   4021 Alpha  — stored 850 / 2 orders (30d + 58d). Ordered again yesterday → CHANGED.
//   4022 Beta   — stored 540.25 / 2 orders (48d + 57d). Nothing new → UNCHANGED.
//   4023 Gamma  — stored 75 / 1 but no 2026 orders any more → reset to 0 → CHANGED.
// Archive window (days 55-60): Beta's 57d order is already archived, Alpha's 58d is not.
// Expect: 2 per-row PUTs, ONE bulk stamp PUT for Beta, one archive range read,
// one archive POST, and no per-customer archive GETs.

const mockFetchAllCaspioPages = jest.fn();
const mockMakeCaspioRequest = jest.fn();
jest.mock('../../src/utils/caspio', () => ({
  fetchAllCaspioPages: (...a) => mockFetchAllCaspioPages(...a),
  makeCaspioRequest: (...a) => mockMakeCaspioRequest(...a),
  getCaspioAccessToken: jest.fn(async () => 'tok'),
}));

// axios is called as a function in this route: axios({ method, url, data })
const mockAxios = jest.fn(async () => ({ data: { RecordsAffected: 1 } }));
jest.mock('axios', () => Object.assign((...a) => mockAxios(...a), { get: jest.fn(), post: jest.fn(), put: jest.fn() }));

const mockToday = '2026-09-06';
function mockDaysAgo(n) { const d = new Date(`${mockToday}T12:00:00Z`); d.setUTCDate(d.getUTCDate() - n); return d.toISOString().slice(0, 10); }
const mockFetchOrders = jest.fn();
jest.mock('../../src/utils/manageorders', () => ({
  fetchOrders: (...a) => mockFetchOrders(...a),
  getDateDaysAgo: (n) => mockDaysAgo(n),
  getTodayDate: () => mockToday,
}));

const express = require('express');
const router = require('../../src/routes/taneisha-accounts');

const ALPHA = { ID_Customer: 4021, CompanyName: 'Alpha Co', YTD_Sales_2026: 850, Order_Count_2026: 2, Last_Order_Date: `${mockDaysAgo(30)}T00:00:00`, Last_Sync_Date: '2026-09-05T13:00:00' };
const BETA = { ID_Customer: 4022, CompanyName: 'Beta LLC', YTD_Sales_2026: 540.25, Order_Count_2026: 2, Last_Order_Date: `${mockDaysAgo(48)}T00:00:00`, Last_Sync_Date: '2026-09-05T13:00:00' };
const GAMMA = { ID_Customer: 4023, CompanyName: 'Gamma Inc', YTD_Sales_2026: 75, Order_Count_2026: 1, Last_Order_Date: '2026-03-01T00:00:00', Last_Sync_Date: '2026-09-05T13:00:00' };

const NEW_ALPHA_ORDER = { id_Order: 1, id_Customer: 4021, date_Invoiced: `${mockDaysAgo(1)}T00:00:00`, cur_SubTotal: '250.00' };
const BASE_ORDERS = [
  { id_Order: 2, id_Customer: 4021, date_Invoiced: `${mockDaysAgo(30)}T00:00:00`, cur_SubTotal: '750.00' },
  { id_Order: 5, id_Customer: 4021, date_Invoiced: `${mockDaysAgo(58)}T00:00:00`, cur_SubTotal: '100.00' },
  { id_Order: 3, id_Customer: 4022, date_Invoiced: `${mockDaysAgo(48)}T00:00:00`, cur_SubTotal: '500.25' },
  { id_Order: 4, id_Customer: 4022, date_Invoiced: `${mockDaysAgo(57)}T00:00:00`, cur_SubTotal: '40.00' },
];

function serve({ accounts, orders, archived }) {
  mockFetchOrders.mockImplementation(async ({ date_Invoiced_start, date_Invoiced_end }) =>
    orders.filter(o => o.date_Invoiced.slice(0, 10) >= date_Invoiced_start && o.date_Invoiced.slice(0, 10) <= date_Invoiced_end));
  mockFetchAllCaspioPages.mockImplementation(async (resource, params) => {
    if (resource.includes('Taneisha_All_Accounts_Caspio')) return accounts;
    if (resource.includes('Taneisha_Daily_Sales_By_Account')) {
      if ((params['q.select'] || '') === 'SalesDate,CustomerID') return archived;   // the one range read
      return [];                                                                    // archived YTD totals (none this year)
    }
    return [];
  });
}

beforeEach(() => {
  mockFetchAllCaspioPages.mockReset();
  mockMakeCaspioRequest.mockReset();
  mockMakeCaspioRequest.mockResolvedValue({ RecordsAffected: 1 });
  mockAxios.mockClear();
  mockFetchOrders.mockReset();
  serve({
    accounts: [ALPHA, BETA, GAMMA],
    orders: [NEW_ALPHA_ORDER, ...BASE_ORDERS],
    archived: [{ SalesDate: `${mockDaysAgo(57)}T00:00:00`, CustomerID: '4022' }],
  });
});

async function post(path) {
  const app = express();
  app.use('/api', router);
  const server = app.listen(0);
  try {
    const { port } = server.address();
    const res = await fetch(`http://127.0.0.1:${port}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    return { status: res.status, body: await res.json() };
  } finally {
    server.close();
  }
}
const puts = () => mockAxios.mock.calls.map(([c]) => c).filter(c => c.method === 'put');
const posts = () => mockAxios.mock.calls.map(([c]) => c).filter(c => c.method === 'post');
const stamps = () => mockMakeCaspioRequest.mock.calls.filter(([m]) => m === 'put');

test('changed accounts are PUT one by one; the unchanged one is bulk-stamped; archive is deduped by one read', async () => {
  const r = await post('/api/taneisha-accounts/sync-sales');
  expect(r.status).toBe(200);
  expect(r.body.success).toBe(true);

  const p = puts();
  expect(p.map(c => c.url.split('q.where=')[1]).sort()).toEqual(['ID_Customer=4021', 'ID_Customer=4023']);
  const alpha = p.find(c => c.url.endsWith('=4021')).data;
  expect(alpha).toMatchObject({ YTD_Sales_2026: 1100, Order_Count_2026: 3, Last_Order_Date: mockDaysAgo(1) });
  expect(typeof alpha.Last_Sync_Date).toBe('string');
  const gamma = p.find(c => c.url.endsWith('=4023')).data;
  expect(gamma).toMatchObject({ YTD_Sales_2026: 0, Order_Count_2026: 0 });
  expect(gamma.Last_Order_Date).toBeUndefined(); // no fresh order → stored date left alone, as before

  // Beta: identical cents / count / day → no per-row PUT; ONE bulk stamp with only Last_Sync_Date.
  expect(stamps()).toHaveLength(1);
  expect(stamps()[0][1]).toBe('/tables/Taneisha_All_Accounts_Caspio/records');
  expect(stamps()[0][2]['q.where']).toBe('ID_Customer IN (4022)');
  expect(Object.keys(stamps()[0][3])).toEqual(['Last_Sync_Date']);

  // Archive step: the YTD-totals read plus ONE range read, zero per-customer existence GETs,
  // and only the not-yet-archived customer-day (Alpha, 58d) is POSTed.
  const archiveReads = mockFetchAllCaspioPages.mock.calls.filter(([res]) => res.includes('Daily_Sales_By_Account'));
  expect(archiveReads.map(([, prm]) => prm['q.select'])).toEqual([undefined, 'SalesDate,CustomerID']);
  expect(posts()).toHaveLength(1);
  expect(posts()[0].data).toMatchObject({ SalesDate: mockDaysAgo(58), CustomerID: '4021', CustomerName: 'Alpha Co', Revenue: 100, OrderCount: 1 });

  // Reported counts: processed = changed + stamped (what the nightly script reads), plus the split.
  expect(r.body).toMatchObject({ accountsUpdated: 3, accountsChanged: 2, accountsUnchanged: 1, accountsFailed: 0, customerRecordsArchived: 1 });
  expect(r.body.caspio).toEqual({ accountPuts: 2, stampCalls: 1, archiveReads: 1 });
});

test('a quiet day (nothing moved) is one stamp call, and accountsUpdated still counts every account', async () => {
  serve({
    accounts: [ALPHA, BETA],
    orders: BASE_ORDERS,
    archived: [{ SalesDate: `${mockDaysAgo(57)}T00:00:00`, CustomerID: '4022' }, { SalesDate: `${mockDaysAgo(58)}T00:00:00`, CustomerID: '4021' }],
  });
  const r = await post('/api/taneisha-accounts/sync-sales');
  expect(r.status).toBe(200);
  expect(puts()).toHaveLength(0);
  expect(posts()).toHaveLength(0);
  expect(stamps()).toHaveLength(1);
  expect(stamps()[0][2]['q.where']).toBe('ID_Customer IN (4021,4022)');
  expect(r.body).toMatchObject({ accountsUpdated: 2, accountsChanged: 0, accountsUnchanged: 2, customerRecordsArchived: 0 });
});

test('a failed bulk stamp is reported as a failure, not swallowed', async () => {
  mockMakeCaspioRequest.mockRejectedValue(new Error('Caspio 500'));
  const r = await post('/api/taneisha-accounts/sync-sales');
  expect(r.status).toBe(200);
  expect(r.body.success).toBe(false);
  expect(r.body.accountsFailed).toBe(1);
  expect(r.body.accountsUpdated).toBe(2); // the two per-row PUTs still counted; the stamped one is not
});
