// The SanMar sync writers in sanmar-orders.js go through the shared batch
// (utils/sanmar-caspio-batch.js) — 2026-09-06 Caspio quota reduction.
//
// These pin the GLUE: that upsertOrderToCaspio and pullAndStoreShipments no
// longer issue an existence GET per row, that a preloaded batch is honoured
// (zero extra reads), and that the write semantics the per-row code had are
// unchanged — order PUT by SanMar_PO carrying Matched_By, item PUT by the
// composite key only when changed, carton POST only when not held.

const mockFetchAllCaspioPages = jest.fn();
const mockMakeCaspioRequest = jest.fn();
jest.mock('../../src/utils/caspio', () => ({
  fetchAllCaspioPages: (...a) => mockFetchAllCaspioPages(...a),
  makeCaspioRequest: (...a) => mockMakeCaspioRequest(...a),
  getCaspioAccessToken: jest.fn(),
  putWithRecordsAffected: jest.fn(),
}));

// SOAP layer: hand back a parsed shipment fixture; everything else is inert.
const mockParseShipmentResponse = jest.fn();
jest.mock('../../src/utils/sanmar-soap', () => {
  const actual = jest.requireActual('../../src/utils/sanmar-soap');
  return {
    ...actual,
    makeSoapRequest: jest.fn(async () => '<xml/>'),
    checkSoapError: jest.fn(() => null),
    buildShipmentRequest: jest.fn(() => '<req/>'),
    parseShipmentResponse: (...a) => mockParseShipmentResponse(...a),
  };
});

const { upsertOrderToCaspio, pullAndStoreShipments } = require('../../src/routes/sanmar-orders');
const { loadSanmarBatch } = require('../../src/utils/sanmar-caspio-batch');

const PO = '113795';
const ORDER = {
  purchaseOrderNumber: PO,
  details: [{
    status: 'Confirmed', salesOrderNumber: '163472846', validTimestamp: '2026-09-05T10:00:00',
    issues: [],
    products: [
      { productId: 'PC61', partId: 'PC61-BLK-L', qtyOrdered: '24', qtyShipped: '0', status: 'Confirmed' },
      { productId: 'PC61', partId: 'PC61-BLK-XL', qtyOrdered: '12', qtyShipped: '12', status: 'Shipped' },
    ],
  }],
};
const STORED = {
  orders: [{ PK_ID: 1, SanMar_PO: PO }],
  items: [
    { SanMar_PO: PO, Style: 'PC61', Part_ID: 'PC61-BLK-L', Qty_Ordered: 24, Qty_Shipped: 0, Item_Status: 'Confirmed' },
    { SanMar_PO: PO, Style: 'PC61', Part_ID: 'PC61-BLK-XL', Qty_Ordered: 12, Qty_Shipped: 0, Item_Status: 'Confirmed' }, // XL has since shipped
  ],
  shipments: [{ SanMar_PO: PO, Tracking_Number: '1ZGH03410357056814' }],
};
const PARSED_SHIPMENTS = [{
  purchaseOrderNumber: PO,
  salesOrders: [{
    locations: [{
      shipFrom: { city: 'RICHMOND', region: 'VA', postalCode: '23231', address1: '1 WAREHOUSE WAY' },
      shipTo: { address1: '2025 Freeman Rd', city: 'Milton', region: 'WA', postalCode: '98354' },
      packages: [
        { trackingNumber: '1ZGH03410357056814', carrier: 'UPS', shipmentMethod: 'Ground', shipmentDate: '2026-09-04T16:02:11' }, // held
        { trackingNumber: '1ZGH03410357056136', carrier: 'UPS', shipmentMethod: 'Ground', shipmentDate: '2026-09-04T16:04:52' }, // new
      ],
    }],
  }],
}];

beforeEach(() => {
  mockFetchAllCaspioPages.mockReset();
  mockMakeCaspioRequest.mockReset();
  mockMakeCaspioRequest.mockResolvedValue({ success: true });
  mockParseShipmentResponse.mockReset();
  mockParseShipmentResponse.mockReturnValue(PARSED_SHIPMENTS);
  mockFetchAllCaspioPages.mockImplementation(async (resource) => {
    if (resource.includes('SanMar_Orders')) return STORED.orders;
    if (resource.includes('SanMar_Order_Items')) return STORED.items;
    if (resource.includes('SanMar_Shipments')) return STORED.shipments;
    return [];
  });
});
const writes = () => mockMakeCaspioRequest.mock.calls.map(([m, r, p, d]) => ({ m, table: r.split('/')[2], where: p && p['q.where'], d }));

describe('upsertOrderToCaspio', () => {
  test('without a batch: two chunked reads (orders, items), never a GET per row', async () => {
    await upsertOrderToCaspio(PO, ORDER, 'backfill');
    expect(mockFetchAllCaspioPages).toHaveBeenCalledTimes(2);
    expect(mockMakeCaspioRequest.mock.calls.some(([m]) => m === 'GET')).toBe(false);
  });

  test('order is PUT by SanMar_PO with Matched_By; only the changed item is PUT', async () => {
    await upsertOrderToCaspio(PO, ORDER, 'backfill');
    const w = writes();
    expect(w).toHaveLength(2);
    expect(w[0]).toMatchObject({ m: 'PUT', table: 'SanMar_Orders', where: "SanMar_PO='113795'" });
    expect(w[0].d).toMatchObject({ SanMar_PO: PO, SanMar_Status: 'Confirmed', Matched_By: 'backfill', SanMar_Sales_Order: '163472846', Status_Updated_Date: '2026-09-05T10:00:00' });
    expect(typeof w[0].d.Last_Sync_Date).toBe('string');
    expect(w[1]).toMatchObject({
      m: 'PUT', table: 'SanMar_Order_Items',
      where: "SanMar_PO='113795' AND Style='PC61' AND Part_ID='PC61-BLK-XL'",
      d: { SanMar_PO: PO, Style: 'PC61', Part_ID: 'PC61-BLK-XL', Qty_Ordered: 12, Qty_Shipped: 12, Item_Status: 'Shipped' },
    });
  });

  test('with a preloaded batch: zero additional reads', async () => {
    const batch = await loadSanmarBatch([PO], { shipments: false });
    mockFetchAllCaspioPages.mockClear();
    await upsertOrderToCaspio(PO, ORDER, 'invoice-catchup', batch);
    expect(mockFetchAllCaspioPages).not.toHaveBeenCalled();
    expect(batch.stats).toMatchObject({ ordersPut: 1, itemsPut: 1, itemsUnchanged: 1, itemsPosted: 0 });
  });

  test('a PO Caspio has never seen is POSTed (order + both items)', async () => {
    mockFetchAllCaspioPages.mockResolvedValue([]);
    await upsertOrderToCaspio('999999', { ...ORDER, purchaseOrderNumber: '999999' }, 'backfill');
    const w = writes();
    expect(w.map(x => x.m)).toEqual(['POST', 'POST', 'POST']);
    expect(w[0].d.Matched_By).toBe('backfill');
  });
});

describe('pullAndStoreShipments', () => {
  test('one shipments read for the PO, then POST only the carton not already held', async () => {
    const added = await pullAndStoreShipments(PO);
    expect(added).toBe(1);
    expect(mockFetchAllCaspioPages).toHaveBeenCalledTimes(1);
    expect(mockFetchAllCaspioPages.mock.calls[0][0]).toBe('/tables/SanMar_Shipments/records');
    const w = writes();
    expect(w).toHaveLength(1);
    expect(w[0]).toMatchObject({ m: 'POST', table: 'SanMar_Shipments' });
    expect(w[0].d).toMatchObject({
      SanMar_PO: PO, Tracking_Number: '1ZGH03410357056136', Carrier: 'UPS', Ship_Date: '2026-09-04',
      Ship_From_Warehouse: 'RICHMOND', Ship_To_Zip: '98354', Ship_To_City: 'Milton',
    });
  });

  test('with a preloaded batch the read is skipped entirely', async () => {
    const batch = await loadSanmarBatch([PO]);
    mockFetchAllCaspioPages.mockClear();
    const added = await pullAndStoreShipments(PO, batch);
    expect(added).toBe(1);
    expect(mockFetchAllCaspioPages).not.toHaveBeenCalled();
    // A second pull in the same run adds nothing and costs nothing.
    mockMakeCaspioRequest.mockClear();
    expect(await pullAndStoreShipments(PO, batch)).toBe(0);
    expect(mockMakeCaspioRequest).not.toHaveBeenCalled();
  });

  test('a SOAP error means nothing to store and no Caspio traffic', async () => {
    const soap = require('../../src/utils/sanmar-soap');
    soap.checkSoapError.mockReturnValueOnce({ code: 160, message: 'no shipments' });
    expect(await pullAndStoreShipments(PO)).toBe(0);
    expect(mockFetchAllCaspioPages).not.toHaveBeenCalled();
    expect(mockMakeCaspioRequest).not.toHaveBeenCalled();
  });
});
