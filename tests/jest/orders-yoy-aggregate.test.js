// orders.js ytdAggregate — the dashboard's year-over-year block (2026-09-06).
//
// It used to fetch every invoiced order of the year month by month — up to 72
// paged reads of full rows per cache miss — only to count unique ID_Orders and
// sum cur_Subtotal in JS, and it silently stopped at 3,000 rows per month.
// Now: ONE aggregate read per year. COUNT(DISTINCT ID_Order) keeps the old
// per-order dedupe; if a range holds duplicate ID_Order rows the total is
// recomputed one subtotal per order, so nothing double-counts.

const mockFetchAllCaspioPages = jest.fn();
jest.mock('../../src/utils/caspio', () => ({
  fetchAllCaspioPages: (...a) => mockFetchAllCaspioPages(...a),
  makeCaspioRequest: jest.fn(),
  getCaspioAccessToken: jest.fn(async () => 'tok'),
  putWithRecordsAffected: jest.fn(),
  postBulk: jest.fn(),
}));

const { ytdAggregate } = require('../../src/routes/orders');

beforeEach(() => mockFetchAllCaspioPages.mockReset());

test('one aggregate read gives the order count and the total for the range', async () => {
  mockFetchAllCaspioPages.mockResolvedValue([{ Rows: 4321, Orders: 4321, Total: '1234567.89' }]);
  const r = await ytdAggregate('2026-01-01', '2026-09-06');
  expect(r).toEqual({ orders: 4321, total: 1234567.89, rows: 4321 });
  expect(mockFetchAllCaspioPages).toHaveBeenCalledTimes(1);
  const [resource, params] = mockFetchAllCaspioPages.mock.calls[0];
  expect(resource).toBe('/tables/ORDER_ODBC/records');
  expect(params['q.where']).toBe("date_OrderInvoiced>='2026-01-01' AND date_OrderInvoiced<='2026-09-06'");
  expect(params['q.select']).toBe('COUNT(*) AS Rows, COUNT(DISTINCT ID_Order) AS Orders, SUM(cur_Subtotal) AS Total');
});

test('duplicate ID_Order rows in the range: the total is recomputed one subtotal per order', async () => {
  mockFetchAllCaspioPages
    .mockResolvedValueOnce([{ Rows: 5, Orders: 3, Total: '500' }])           // 2 duplicates → SUM would double-count
    .mockResolvedValueOnce([{ ID_Order: 1, Sub: '100' }, { ID_Order: 2, Sub: '150' }, { ID_Order: 3, Sub: '50' }]);
  const r = await ytdAggregate('2025-01-01', '2025-09-06');
  expect(r).toEqual({ orders: 3, total: 300, rows: 5 });
  expect(mockFetchAllCaspioPages).toHaveBeenCalledTimes(2);
  const [, params] = mockFetchAllCaspioPages.mock.calls[1];
  expect(params['q.select']).toBe('ID_Order, MAX(cur_Subtotal) AS Sub');
  expect(params['q.groupBy']).toBe('ID_Order');
  expect(params['q.orderBy']).toBe('ID_Order'); // stable paging on a query that can span pages
});

test('an empty range is zero everything, one read', async () => {
  mockFetchAllCaspioPages.mockResolvedValue([{ Rows: 0, Orders: 0, Total: null }]);
  expect(await ytdAggregate('2020-01-01', '2020-01-02')).toEqual({ orders: 0, total: 0, rows: 0 });
  expect(mockFetchAllCaspioPages).toHaveBeenCalledTimes(1);
});
