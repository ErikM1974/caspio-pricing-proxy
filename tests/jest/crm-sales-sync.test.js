// CRM sync-sales diff-before-write helpers (2026-09-06 Caspio quota reduction).
//
// Before: /api/{taneisha,nika}-accounts/sync-sales PUT every account with any
// 2026 sales (892 + 474 rows) every morning, changed or not, and the archive
// step GET-checked every customer-day before POSTing it. These pin:
//   • accountChanged compares the way Caspio stores the values — cents for the
//     NUMBER column, calendar day for DATE/TIME ('2026-08-14T00:00:00' vs
//     '2026-08-14'), and ignores Last_Order_Date when the run has no fresh order
//   • stampLastSync writes Last_Sync_Date to many rows in ONE where-clause PUT
//     per 200 ids, integers only in the where
//   • loadArchivedKeys turns one range read into the (day, customer) set

const mockFetchAllCaspioPages = jest.fn();
const mockMakeCaspioRequest = jest.fn();
jest.mock('../../src/utils/caspio', () => ({
  fetchAllCaspioPages: (...a) => mockFetchAllCaspioPages(...a),
  makeCaspioRequest: (...a) => mockMakeCaspioRequest(...a),
}));

const { accountChanged, stampLastSync, loadArchivedKeys, archiveKey, ymd, cents } = require('../../src/utils/crm-sales-sync');

beforeEach(() => {
  mockFetchAllCaspioPages.mockReset();
  mockMakeCaspioRequest.mockReset();
  mockMakeCaspioRequest.mockResolvedValue({ RecordsAffected: 200 });
});

describe('accountChanged', () => {
  const stored = { ID_Customer: 4021, YTD_Sales_2026: 1234.5, Order_Count_2026: 7, Last_Order_Date: '2026-08-14T00:00:00', Last_Sync_Date: '2026-09-05T13:00:04' };

  test('same numbers and same calendar day → unchanged, whatever the formats', () => {
    expect(accountChanged(stored, { YTD_Sales_2026: 1234.5000000001, Order_Count_2026: '7', Last_Order_Date: '2026-08-14', Last_Sync_Date: 'now' })).toBe(false);
    expect(accountChanged(stored, { YTD_Sales_2026: 1234.5, Order_Count_2026: 7 })).toBe(false); // no fresh order → date not compared
  });

  test('a cent of revenue, one more order, or a newer order date → changed', () => {
    expect(accountChanged(stored, { YTD_Sales_2026: 1234.51, Order_Count_2026: 7 })).toBe(true);
    expect(accountChanged(stored, { YTD_Sales_2026: 1234.5, Order_Count_2026: 8 })).toBe(true);
    expect(accountChanged(stored, { YTD_Sales_2026: 1234.5, Order_Count_2026: 7, Last_Order_Date: '2026-09-05' })).toBe(true);
  });

  test('a reset to zero on a stored total is a change; blanks read as zero', () => {
    expect(accountChanged(stored, { YTD_Sales_2026: 0, Order_Count_2026: 0 })).toBe(true);
    expect(accountChanged({ YTD_Sales_2026: null, Order_Count_2026: '' }, { YTD_Sales_2026: 0, Order_Count_2026: 0 })).toBe(false);
    expect(accountChanged(undefined, { YTD_Sales_2026: 0, Order_Count_2026: 0 })).toBe(true);
  });

  test('helpers: ymd keeps the day, cents rounds', () => {
    expect(ymd('2026-08-14T00:00:00')).toBe('2026-08-14');
    expect(ymd(null)).toBe('');
    expect(cents('19.999')).toBe(2000);
  });
});

describe('stampLastSync', () => {
  test('450 ids → 3 PUTs of ≤200 integer ids, body is only Last_Sync_Date', async () => {
    const ids = Array.from({ length: 450 }, (_, i) => 1000 + i);
    const r = await stampLastSync('Taneisha_All_Accounts_Caspio', 'ID_Customer', ids, '2026-09-06T13:00:00.000Z');
    expect(r).toEqual({ calls: 3, ids: 450, recordsAffected: 600 });
    expect(mockMakeCaspioRequest).toHaveBeenCalledTimes(3);
    const [method, resource, params, data] = mockMakeCaspioRequest.mock.calls[0];
    expect(method).toBe('put');
    expect(resource).toBe('/tables/Taneisha_All_Accounts_Caspio/records');
    expect(params['q.where']).toMatch(/^ID_Customer IN \(1000,1001,.*,1199\)$/);
    expect(params['q.where'].split(',')).toHaveLength(200);
    expect(data).toEqual({ Last_Sync_Date: '2026-09-06T13:00:00.000Z' });
    expect(mockMakeCaspioRequest.mock.calls[2][2]['q.where'].split(',')).toHaveLength(50);
  });

  test('non-integer ids are dropped, duplicates collapsed, empty list costs nothing', async () => {
    const r = await stampLastSync('T', 'ID_Customer', ['12', 12, 'abc', null, "1 OR 1=1", 13], 'ts');
    expect(mockMakeCaspioRequest).toHaveBeenCalledTimes(1);
    expect(mockMakeCaspioRequest.mock.calls[0][2]['q.where']).toBe('ID_Customer IN (12,1,13)'); // parseInt("1 OR 1=1") → 1: digits only ever reach the where
    expect(r.ids).toBe(3);
    mockMakeCaspioRequest.mockClear();
    expect(await stampLastSync('T', 'ID_Customer', [], 'ts')).toEqual({ calls: 0, ids: 0, recordsAffected: 0 });
    expect(mockMakeCaspioRequest).not.toHaveBeenCalled();
  });
});

describe('loadArchivedKeys', () => {
  test('one range read, keyed on calendar day + customer id', async () => {
    mockFetchAllCaspioPages.mockResolvedValue([
      { SalesDate: '2026-07-08T00:00:00', CustomerID: '4021' },
      { SalesDate: '2026-07-10T00:00:00', CustomerID: '77' },
    ]);
    const keys = await loadArchivedKeys('Taneisha_Daily_Sales_By_Account', '2026-07-08', '2026-07-13');
    expect(mockFetchAllCaspioPages).toHaveBeenCalledTimes(1);
    const [resource, params] = mockFetchAllCaspioPages.mock.calls[0];
    expect(resource).toBe('/tables/Taneisha_Daily_Sales_By_Account/records');
    expect(params['q.where']).toBe("SalesDate>='2026-07-08' AND SalesDate<='2026-07-13'");
    expect(params['q.select']).toBe('SalesDate,CustomerID');
    expect(keys.has(archiveKey('2026-07-08', 4021))).toBe(true);   // numeric id matches the stored TEXT id
    expect(keys.has(archiveKey('2026-07-10', '77'))).toBe(true);
    expect(keys.has(archiveKey('2026-07-09', 4021))).toBe(false);
  });
});
