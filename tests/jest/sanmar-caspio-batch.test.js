// SanMar sync: batched Caspio reads + diff-before-write (2026-09-06).
//
// Measured before this change: the daily backfill re-walked every open order
// (148 orders / 736 items) with a GET-then-PUT/POST per row — ~900 SanMar-table
// calls a morning. These pin the helper the /sync, backfill and catch-up paths
// now share:
//   • existing rows are loaded in chunked IN(...) reads, 100 POs per query
//   • orders are ALWAYS written (Last_Sync_Date is a freshness signal elsewhere)
//   • items are written only when qty/status changed; unchanged = zero calls
//   • cartons dedupe against a preloaded (PO, tracking) set
//   • PUT where-clauses are the same keys the per-row code used

const mockFetchAllCaspioPages = jest.fn();
const mockMakeCaspioRequest = jest.fn();
jest.mock('../../src/utils/caspio', () => ({
  fetchAllCaspioPages: (...a) => mockFetchAllCaspioPages(...a),
  makeCaspioRequest: (...a) => mockMakeCaspioRequest(...a),
}));

const {
  SanmarBatch, loadSanmarBatch, buildShipmentRow, itemChanged, itemKey, sqlQuote, inClause, CHUNK,
} = require('../../src/utils/sanmar-caspio-batch');

const STORED_ORDERS = [{ PK_ID: 1, SanMar_PO: '111352 BW' }, { PK_ID: 2, SanMar_PO: '111400' }];
const STORED_ITEMS = [
  { PK_ID: 10, SanMar_PO: '111352 BW', Style: 'PC61', Part_ID: 'PC61-BLK-L', Qty_Ordered: 24, Qty_Shipped: 0, Item_Status: 'Confirmed' },
  { PK_ID: 11, SanMar_PO: '111352 BW', Style: 'PC61', Part_ID: 'PC61-BLK-XL', Qty_Ordered: 12, Qty_Shipped: 12, Item_Status: 'Shipped' },
  { PK_ID: 12, SanMar_PO: '111352 BW', Style: 'PC61', Part_ID: 'PC61-BLK-XL', Qty_Ordered: 99, Qty_Shipped: 0, Item_Status: 'dupe' }, // duplicate key — first row wins
];
const STORED_SHIPMENTS = [{ SanMar_PO: '111352 BW', Tracking_Number: '1z999aa' }];

/** Serve stored rows by table, honouring the IN(...) filter loosely by PO. */
function serveTables() {
  mockFetchAllCaspioPages.mockImplementation(async (resource, params) => {
    const where = params['q.where'] || '';
    const inList = (where.match(/IN \((.*)\)/) || [])[1] || '';
    const pos = inList.split(',').map(s => s.replace(/^'|'$/g, '').replace(/''/g, "'"));
    const byPo = (r) => pos.includes(r.SanMar_PO);
    if (resource.includes('SanMar_Orders')) return STORED_ORDERS.filter(byPo);
    if (resource.includes('SanMar_Order_Items')) return STORED_ITEMS.filter(byPo);
    if (resource.includes('SanMar_Shipments')) return STORED_SHIPMENTS.filter(byPo);
    return [];
  });
}
const writes = () => mockMakeCaspioRequest.mock.calls.map(([m, r, p, d]) => ({ m, r, where: p && p['q.where'], d }));

beforeEach(() => {
  mockFetchAllCaspioPages.mockReset();
  mockMakeCaspioRequest.mockReset();
  mockMakeCaspioRequest.mockResolvedValue({ success: true });
  serveTables();
});

describe('helpers', () => {
  test('sqlQuote doubles single quotes; inClause quotes every value', () => {
    expect(sqlQuote("O'Brien")).toBe("'O''Brien'");
    expect(sqlQuote(null)).toBe("''");
    expect(inClause('SanMar_PO', ['111352 BW', '111400'])).toBe("SanMar_PO IN ('111352 BW','111400')");
  });

  test('itemKey normalizes null/blank Part_ID and whitespace', () => {
    expect(itemKey('111352 BW', 'PC61', null)).toBe('111352 BW|PC61|');
    expect(itemKey('111352 BW ', ' PC61', '')).toBe('111352 BW|PC61|');
  });

  test('itemChanged: numeric strings equal numbers; status compared trimmed', () => {
    const stored = { Qty_Ordered: 24, Qty_Shipped: 0, Item_Status: 'Confirmed' };
    expect(itemChanged(stored, { Qty_Ordered: '24', Qty_Shipped: '0', Item_Status: 'Confirmed ' })).toBe(false);
    expect(itemChanged(stored, { Qty_Ordered: 24, Qty_Shipped: 24, Item_Status: 'Confirmed' })).toBe(true);
    expect(itemChanged(stored, { Qty_Ordered: 24, Qty_Shipped: 0, Item_Status: 'Shipped' })).toBe(true);
    expect(itemChanged({ Qty_Ordered: null, Qty_Shipped: null, Item_Status: null }, { Qty_Ordered: 0, Qty_Shipped: 0, Item_Status: '' })).toBe(false);
  });

  test('buildShipmentRow carries ship-to and package fields (the backfill used to drop them)', () => {
    const row = buildShipmentRow('111352 BW',
      { trackingNumber: '1Z1', carrier: 'UPS', shipmentMethod: 'Ground', shipmentDate: '2026-09-05T10:00:00', weight: '12', dimensions: '20x14x10', packageClass: 'Carton' },
      { city: 'RENO', region: 'NV', postalCode: '89506', address1: '1 WAREHOUSE' },
      { city: 'Sequim', region: 'WA', postalCode: '98382', address1: '10 Customer St' });
    expect(row).toMatchObject({
      SanMar_PO: '111352 BW', Tracking_Number: '1Z1', Ship_Date: '2026-09-05',
      Ship_From_Warehouse: 'RENO', Ship_From_Zip: '89506', Ship_From_Address: '1 WAREHOUSE',
      Ship_To_City: 'Sequim', Ship_To_Zip: '98382', Package_Weight: '12', Package_Class: 'Carton',
    });
    expect(Object.keys(row)).toHaveLength(17);
  });
});

describe('loading', () => {
  test('loadSanmarBatch reads orders, items and shipments once each for a small PO list', async () => {
    const b = await loadSanmarBatch(['111352 BW', '111400', 'NEW-1']);
    expect(mockFetchAllCaspioPages).toHaveBeenCalledTimes(3);
    const resources = mockFetchAllCaspioPages.mock.calls.map(c => c[0]);
    expect(resources).toEqual(['/tables/SanMar_Orders/records', '/tables/SanMar_Order_Items/records', '/tables/SanMar_Shipments/records']);
    const params = mockFetchAllCaspioPages.mock.calls[0][1];
    expect(params['q.where']).toBe("SanMar_PO IN ('111352 BW','111400','NEW-1')");
    expect(params['q.orderBy']).toBe('PK_ID');
    expect(params['q.limit']).toBe(1000);
    expect(b.hasOrder('111352 BW')).toBe(true);
    expect(b.hasOrder('NEW-1')).toBe(false);
    expect(b.stats.reads).toBe(3);
  });

  test('reads are chunked at 100 POs per query, per table', async () => {
    const pos = Array.from({ length: CHUNK * 2 + 1 }, (_, i) => `PO${i}`);
    await loadSanmarBatch(pos, { shipments: false });
    expect(mockFetchAllCaspioPages).toHaveBeenCalledTimes(6); // 3 chunks × 2 tables
    const firstWhere = mockFetchAllCaspioPages.mock.calls[0][1]['q.where'];
    expect(firstWhere.split(',')).toHaveLength(CHUNK);
  });

  test('a PO is never re-read within one batch; new POs are loaded on demand', async () => {
    const b = await loadSanmarBatch(['111352 BW'], { shipments: false });
    expect(mockFetchAllCaspioPages).toHaveBeenCalledTimes(2);
    await b.loadOrders(['111352 BW']);                       // already loaded — no read
    expect(mockFetchAllCaspioPages).toHaveBeenCalledTimes(2);
    await b.upsertItem({ SanMar_PO: '111400', Style: 'PC54', Part_ID: 'X', Qty_Ordered: 1, Qty_Shipped: 0, Item_Status: 'Confirmed' });
    expect(mockFetchAllCaspioPages).toHaveBeenCalledTimes(4); // 111400 loaded lazily (orders + items)
  });

  test('an empty PO list costs zero reads', async () => {
    const b = await loadSanmarBatch([]);
    expect(mockFetchAllCaspioPages).not.toHaveBeenCalled();
    expect(b.stats.reads).toBe(0);
  });
});

describe('orders — always written, never re-checked', () => {
  test('existing order → PUT by SanMar_PO, insertFields NOT applied', async () => {
    const b = await loadSanmarBatch(['111352 BW'], { shipments: false });
    const r = await b.upsertOrder({ SanMar_PO: '111352 BW', SanMar_Status: 'Confirmed', Last_Sync_Date: 'T' }, { insertFields: { Matched_By: 'sync' } });
    expect(r).toBe('put');
    expect(writes()).toEqual([{ m: 'PUT', r: '/tables/SanMar_Orders/records', where: "SanMar_PO='111352 BW'", d: { SanMar_PO: '111352 BW', SanMar_Status: 'Confirmed', Last_Sync_Date: 'T' } }]);
    expect(mockFetchAllCaspioPages).toHaveBeenCalledTimes(2); // no per-order GET
  });

  test('new order → POST with insertFields merged; a second upsert in the same run is a PUT', async () => {
    const b = await loadSanmarBatch(['NEW-1'], { shipments: false });
    expect(await b.upsertOrder({ SanMar_PO: 'NEW-1', SanMar_Status: 'Received' }, { insertFields: { Matched_By: 'sync' } })).toBe('post');
    expect(writes()[0]).toEqual({ m: 'POST', r: '/tables/SanMar_Orders/records', where: undefined, d: { SanMar_PO: 'NEW-1', SanMar_Status: 'Received', Matched_By: 'sync' } });
    expect(await b.upsertOrder({ SanMar_PO: 'NEW-1', SanMar_Status: 'Confirmed' })).toBe('put');
    expect(b.stats).toMatchObject({ ordersPosted: 1, ordersPut: 1 });
  });

  test("the where-clause escapes a quote in a PO instead of breaking the query", async () => {
    mockFetchAllCaspioPages.mockResolvedValue([{ PK_ID: 5, SanMar_PO: "O'B 1" }]);
    const b = await loadSanmarBatch(["O'B 1"], { shipments: false });
    await b.upsertOrder({ SanMar_PO: "O'B 1" });
    expect(writes()[0].where).toBe("SanMar_PO='O''B 1'");
  });
});

describe('items — diff before write', () => {
  test('unchanged item → no Caspio call at all', async () => {
    const b = await loadSanmarBatch(['111352 BW'], { shipments: false });
    const r = await b.upsertItem({ SanMar_PO: '111352 BW', Style: 'PC61', Part_ID: 'PC61-BLK-L', Qty_Ordered: '24', Qty_Shipped: '0', Item_Status: 'Confirmed' });
    expect(r).toBe('unchanged');
    expect(mockMakeCaspioRequest).not.toHaveBeenCalled();
    expect(b.stats.itemsUnchanged).toBe(1);
  });

  test('changed quantity → PUT by the composite key, same where the per-row code used', async () => {
    const b = await loadSanmarBatch(['111352 BW'], { shipments: false });
    const r = await b.upsertItem({ SanMar_PO: '111352 BW', Style: 'PC61', Part_ID: 'PC61-BLK-L', Qty_Ordered: 24, Qty_Shipped: 24, Item_Status: 'Shipped' });
    expect(r).toBe('put');
    expect(writes()).toEqual([{
      m: 'PUT', r: '/tables/SanMar_Order_Items/records',
      where: "SanMar_PO='111352 BW' AND Style='PC61' AND Part_ID='PC61-BLK-L'",
      d: { SanMar_PO: '111352 BW', Style: 'PC61', Part_ID: 'PC61-BLK-L', Qty_Ordered: 24, Qty_Shipped: 24, Item_Status: 'Shipped' },
    }]);
    // The batch now holds the new values, so a repeat in the same run is unchanged.
    expect(await b.upsertItem({ SanMar_PO: '111352 BW', Style: 'PC61', Part_ID: 'PC61-BLK-L', Qty_Ordered: 24, Qty_Shipped: 24, Item_Status: 'Shipped' })).toBe('unchanged');
    expect(mockMakeCaspioRequest).toHaveBeenCalledTimes(1);
  });

  test('a duplicate stored row: first row wins the comparison; the PUT key still covers both', async () => {
    const b = await loadSanmarBatch(['111352 BW'], { shipments: false });
    // Stored twice (PK 11 first: 12/12 Shipped; PK 12: 99/0 dupe). Incoming equals PK 11 → unchanged.
    expect(await b.upsertItem({ SanMar_PO: '111352 BW', Style: 'PC61', Part_ID: 'PC61-BLK-XL', Qty_Ordered: 12, Qty_Shipped: 12, Item_Status: 'Shipped' })).toBe('unchanged');
  });

  test('new item → POST; blank Part_ID is keyed and queried as an empty string', async () => {
    const b = await loadSanmarBatch(['111352 BW'], { shipments: false });
    expect(await b.upsertItem({ SanMar_PO: '111352 BW', Style: 'PC54', Part_ID: '', Qty_Ordered: 6, Qty_Shipped: 0, Item_Status: 'Confirmed' })).toBe('post');
    expect(writes()[0]).toMatchObject({ m: 'POST', r: '/tables/SanMar_Order_Items/records' });
    // Same key again but with a change → PUT with Part_ID='' in the where.
    expect(await b.upsertItem({ SanMar_PO: '111352 BW', Style: 'PC54', Part_ID: null, Qty_Ordered: 6, Qty_Shipped: 6, Item_Status: 'Shipped' })).toBe('put');
    expect(writes()[1].where).toBe("SanMar_PO='111352 BW' AND Style='PC54' AND Part_ID=''");
  });
});

describe('cartons — dedupe against what Caspio holds', () => {
  test('a held (PO, tracking) is skipped case-insensitively; a new one is POSTed once', async () => {
    const b = await loadSanmarBatch(['111352 BW']);
    const held = buildShipmentRow('111352 BW', { trackingNumber: '1Z999AA' });
    expect(await b.storeCarton(held)).toBe(false);
    const fresh = buildShipmentRow('111352 BW', { trackingNumber: '1Z999BB', carrier: 'UPS' });
    expect(await b.storeCarton(fresh)).toBe(true);
    expect(await b.storeCarton(fresh)).toBe(false); // duplicate within one response
    expect(writes()).toEqual([{ m: 'POST', r: '/tables/SanMar_Shipments/records', where: undefined, d: fresh }]);
    expect(b.stats).toMatchObject({ shipmentsPosted: 1, shipmentsSkipped: 2 });
  });

  test('a PO not yet loaded is read on demand — one read, not one per carton', async () => {
    const b = new SanmarBatch();
    await b.storeCarton(buildShipmentRow('111400', { trackingNumber: 'A1' }));
    await b.storeCarton(buildShipmentRow('111400', { trackingNumber: 'A2' }));
    expect(mockFetchAllCaspioPages).toHaveBeenCalledTimes(1);
    expect(mockMakeCaspioRequest).toHaveBeenCalledTimes(2);
  });
});

describe('cost of a realistic daily backfill', () => {
  test('148 unchanged orders with 5 items each: 4 reads + 148 order PUTs, zero item writes', async () => {
    const pos = Array.from({ length: 148 }, (_, i) => `PO${1000 + i}`);
    mockFetchAllCaspioPages.mockImplementation(async (resource, params) => {
      const list = ((params['q.where'].match(/IN \((.*)\)/) || [])[1] || '').split(',').map(s => s.replace(/'/g, ''));
      if (resource.includes('SanMar_Orders')) return list.map((po, i) => ({ PK_ID: i, SanMar_PO: po }));
      if (resource.includes('SanMar_Order_Items')) return list.flatMap(po => [1, 2, 3, 4, 5].map(n => ({ SanMar_PO: po, Style: 'PC61', Part_ID: `P${n}`, Qty_Ordered: 12, Qty_Shipped: 0, Item_Status: 'Confirmed' })));
      return [];
    });
    const b = await loadSanmarBatch(pos, { shipments: false });
    for (const po of pos) {
      await b.upsertOrder({ SanMar_PO: po, SanMar_Status: 'Confirmed', Last_Sync_Date: 'now' });
      for (const n of [1, 2, 3, 4, 5]) {
        await b.upsertItem({ SanMar_PO: po, Style: 'PC61', Part_ID: `P${n}`, Qty_Ordered: '12', Qty_Shipped: '0', Item_Status: 'Confirmed' });
      }
    }
    expect(b.stats.reads).toBe(4);                 // 2 chunks × 2 tables
    expect(b.stats.ordersPut).toBe(148);
    expect(b.stats.itemsUnchanged).toBe(740);
    expect(mockMakeCaspioRequest).toHaveBeenCalledTimes(148);  // was ~1,776 with GET-then-write per row
  });
});
