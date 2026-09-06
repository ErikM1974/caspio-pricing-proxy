// GET /api/sanmar-orders/lookup — the unwrap bug and the per-order fan-out (2026-09-06).
//
// makeCaspioRequest returns Caspio's Result ARRAY, not the envelope. The route
// checked `.Result` on it, so (a) a style search always found nothing and (b) the
// items/shipments enrichment was always empty — while still costing two reads per
// order, up to 41 calls for a company search. Now: items and shipments come from
// TWO reads for the whole page (SanMar_PO IN (...)) and are actually attached.

const mockFetchAllCaspioPages = jest.fn();
const mockMakeCaspioRequest = jest.fn();
jest.mock('../../src/utils/caspio', () => ({
  fetchAllCaspioPages: (...a) => mockFetchAllCaspioPages(...a),
  makeCaspioRequest: (...a) => mockMakeCaspioRequest(...a),
  getCaspioAccessToken: jest.fn(async () => 'tok'),
  putWithRecordsAffected: jest.fn(),
}));

const express = require('express');
const router = require('../../src/routes/sanmar-orders');

const ORDERS = [
  { SanMar_PO: '113795', SanMar_Status: 'Shipped', Company_Name: 'Alpha Co', id_Order: '142000' },
  { SanMar_PO: '113787', SanMar_Status: 'Confirmed', Company_Name: 'Alpha Co', id_Order: '142001' },
];
const ITEMS = [
  { PK_ID: 1, SanMar_PO: '113795', Style: 'PC61', Part_ID: 'A', Qty_Ordered: 24 },
  { PK_ID: 2, SanMar_PO: '113795', Style: 'PC61', Part_ID: 'B', Qty_Ordered: 12 },
  { PK_ID: 3, SanMar_PO: '113787', Style: 'PC54', Part_ID: 'C', Qty_Ordered: 6 },
];
const SHIPMENTS = [{ PK_ID: 9, SanMar_PO: '113795', Tracking_Number: '1Z1' }];

async function get(path) {
  const app = express();
  app.use('/api/sanmar-orders', router);
  const server = app.listen(0);
  try {
    const { port } = server.address();
    const res = await fetch(`http://127.0.0.1:${port}${path}`);
    return { status: res.status, body: await res.json() };
  } finally {
    server.close();
  }
}

beforeEach(() => {
  mockFetchAllCaspioPages.mockReset();
  mockMakeCaspioRequest.mockReset();
  // The helper returns ARRAYS (its whole point). Route the reads by table.
  mockMakeCaspioRequest.mockImplementation(async (method, resource, params) => {
    if (resource.includes('SanMar_Orders')) {
      const where = params['q.where'] || '';
      if (/SanMar_PO IN/.test(where)) return ORDERS.filter(o => where.includes(`'${o.SanMar_PO}'`));
      return ORDERS;
    }
    if (resource.includes('SanMar_Order_Items')) return ITEMS.filter(i => i.Style === 'PC61').map(i => ({ SanMar_PO: i.SanMar_PO }));
    return [];
  });
  mockFetchAllCaspioPages.mockImplementation(async (resource, params) => {
    const where = params['q.where'] || '';
    const inList = (where.match(/IN \((.*)\)/) || [])[1] || '';
    const pos = inList.split(',').map(s => s.replace(/^'|'$/g, ''));
    if (resource.includes('SanMar_Order_Items')) return ITEMS.filter(i => pos.includes(i.SanMar_PO));
    if (resource.includes('SanMar_Shipments')) return SHIPMENTS.filter(s => pos.includes(s.SanMar_PO));
    return [];
  });
});

test('a company search: one orders read + two page reads, items and shipments ATTACHED', async () => {
  const r = await get('/api/sanmar-orders/lookup?company=Alpha');
  expect(r.status).toBe(200);
  expect(r.body.count).toBe(2);
  const byPo = Object.fromEntries(r.body.orders.map(o => [o.SanMar_PO, o]));
  expect(byPo['113795'].items).toHaveLength(2);
  expect(byPo['113795'].shipments).toEqual([expect.objectContaining({ Tracking_Number: '1Z1' })]);
  expect(byPo['113787'].items).toHaveLength(1);
  expect(byPo['113787'].shipments).toEqual([]);

  // Exactly one Caspio read for the orders and two for the whole page — not two per order.
  expect(mockMakeCaspioRequest).toHaveBeenCalledTimes(1);
  expect(mockFetchAllCaspioPages).toHaveBeenCalledTimes(2);
  const [itemsCall, shipCall] = mockFetchAllCaspioPages.mock.calls;
  expect(itemsCall[0]).toBe('/tables/SanMar_Order_Items/records');
  expect(itemsCall[1]['q.where']).toBe("SanMar_PO IN ('113795','113787')");
  expect(itemsCall[1]['q.orderBy']).toBe('PK_ID');
  expect(shipCall[0]).toBe('/tables/SanMar_Shipments/records');
  expect(shipCall[1]['q.where']).toBe("SanMar_PO IN ('113795','113787')");
});

test('a style search now finds orders (the .Result check used to swallow them)', async () => {
  const r = await get('/api/sanmar-orders/lookup?style=PC61');
  expect(r.status).toBe(200);
  expect(r.body.count).toBe(1); // only 113795 has PC61 items in the fixture
  // items read by Style, then orders by the POs those items belong to
  const calls = mockMakeCaspioRequest.mock.calls;
  expect(calls[0][1]).toBe('/tables/SanMar_Order_Items/records');
  expect(calls[0][2]['q.where']).toBe("Style='PC61'");
  expect(calls[1][1]).toBe('/tables/SanMar_Orders/records');
  expect(calls[1][2]['q.where']).toBe("SanMar_PO IN ('113795')");
});

test('no matches: no page reads at all', async () => {
  mockMakeCaspioRequest.mockResolvedValue([]);
  const r = await get('/api/sanmar-orders/lookup?company=Nobody');
  expect(r.status).toBe(200);
  expect(r.body.count).toBe(0);
  expect(mockFetchAllCaspioPages).not.toHaveBeenCalled();
});

test('a failed page read degrades to empty items, never a 500', async () => {
  mockFetchAllCaspioPages.mockRejectedValue(new Error('Caspio 502'));
  const r = await get('/api/sanmar-orders/lookup?company=Alpha');
  expect(r.status).toBe(200);
  expect(r.body.orders[0].items).toEqual([]);
  expect(r.body.orders[0].shipments).toEqual([]);
});
