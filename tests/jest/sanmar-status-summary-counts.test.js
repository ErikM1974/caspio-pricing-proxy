// GET /api/sanmar-orders/status-summary — exact counts (2026-09-06).
//
// The old handler read up to 1,000 PK_IDs per table and reported `.length`, so
// every count silently capped at 1,000 (two of the tables are past that), the
// status distribution was tallied from a capped page, and it cost eight reads of
// up to 1,000 rows each. Now: COUNT(*) per table, one GROUP BY for statuses, one
// COUNT for the data-quality check — still eight requests, all tiny and exact.

const mockMakeCaspioRequest = jest.fn();
jest.mock('../../src/utils/caspio', () => ({
  makeCaspioRequest: (...a) => mockMakeCaspioRequest(...a),
  fetchAllCaspioPages: jest.fn(),
  getCaspioAccessToken: jest.fn(async () => 'tok'),
  putWithRecordsAffected: jest.fn(),
}));

const express = require('express');
const router = require('../../src/routes/sanmar-orders');

const COUNTS = { SanMar_Orders: 1866, SanMar_Order_Items: 9412, SanMar_Shipments: 2410, SanMar_Invoices: 700, SanMar_Invoice_Items: 3100 };

beforeEach(() => {
  mockMakeCaspioRequest.mockReset();
  mockMakeCaspioRequest.mockImplementation(async (method, resource, params) => {
    const table = resource.split('/')[2];
    const select = params['q.select'] || '';
    if (select === 'COUNT(*) AS N') {
      if (params['q.where'] === 'Unit_Price IS NULL') return [{ N: 37 }];
      return [{ N: COUNTS[table] }];
    }
    if (params['q.groupBy'] === 'SanMar_Status') {
      return [{ SanMar_Status: 'complete', N: 1685 }, { SanMar_Status: 'confirmed', N: 88 }, { SanMar_Status: null, N: 2 }];
    }
    if (select === 'Last_Sync_Date') return [{ Last_Sync_Date: '2026-09-06T13:05:11' }];
    throw new Error('unexpected query ' + JSON.stringify(params));
  });
});

async function get() {
  const app = express();
  app.use('/api/sanmar-orders', router);
  const server = app.listen(0);
  try {
    const { port } = server.address();
    const res = await fetch(`http://127.0.0.1:${port}/api/sanmar-orders/status-summary`);
    return { status: res.status, body: await res.json() };
  } finally {
    server.close();
  }
}

test('table counts are exact past 1,000, statuses come from one GROUP BY, all in eight small reads', async () => {
  const r = await get();
  expect(r.status).toBe(200);
  expect(r.body.tables).toEqual({
    SanMar_Orders: { rows: 1866, error: null },
    SanMar_Order_Items: { rows: 9412, error: null },
    SanMar_Shipments: { rows: 2410, error: null },
    SanMar_Invoices: { rows: 700, error: null },
    SanMar_Invoice_Items: { rows: 3100, error: null },
  });
  expect(r.body.orderStatusDistribution).toEqual({ complete: 1685, confirmed: 88, Unknown: 2 });
  expect(r.body.dataQuality).toEqual({ itemsMissingUnitPrice: 37 });
  expect(r.body.lastSync).toBe('2026-09-06T13:05:11');

  expect(mockMakeCaspioRequest).toHaveBeenCalledTimes(8);
  // No read asks for rows: every query is an aggregate or a single-row select.
  for (const [, , params] of mockMakeCaspioRequest.mock.calls) {
    expect(params['q.select']).toMatch(/COUNT\(\*\)|Last_Sync_Date/);
    expect(params['q.limit']).not.toBe('1000');
  }
});

test('a table whose count fails reports the error for that table only', async () => {
  const good = mockMakeCaspioRequest.getMockImplementation();
  mockMakeCaspioRequest.mockImplementation(async (m, resource, params) => {
    if (resource.includes('SanMar_Invoices/') && params['q.select'] === 'COUNT(*) AS N') throw new Error('403 no permission');
    return good(m, resource, params);
  });
  const r = await get();
  expect(r.status).toBe(200);
  expect(r.body.tables.SanMar_Invoices).toEqual({ rows: 0, error: '403 no permission' });
  expect(r.body.tables.SanMar_Orders.rows).toBe(1866);
});
