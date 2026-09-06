// utils/caspio.js postBulk — the one v4 capability that removes billed calls
// (2026-09-06). Pins the contract against the live-verified v4 shapes:
//   • table NAME → six-character tableId via GET /v4/tables (cached per process,
//     refreshed once on a miss, refused if still unknown — a wrong id would
//     write the wrong table silently)
//   • ≤1,000 rows per request; 201 → { PK_ID: [...] }; 207 → data[] per row
//   • per-row failures are returned, a whole-request failure throws with the body
//   • every request is tagged _caspioTable so the meter labels it by table name

process.env.CASPIO_ACCOUNT_DOMAIN = process.env.CASPIO_ACCOUNT_DOMAIN || 'c3eku948.caspio.com';
process.env.CASPIO_CLIENT_ID = process.env.CASPIO_CLIENT_ID || 'id';
process.env.CASPIO_CLIENT_SECRET = process.env.CASPIO_CLIENT_SECRET || 'secret';

const mockAxios = jest.fn();
jest.mock('axios', () => Object.assign((...a) => mockAxios(...a), {
  get: (...a) => mockAxios(...a), post: (...a) => mockAxios(...a),
  interceptors: { request: { use: jest.fn() }, response: { use: jest.fn() } },
}));

const caspio = require('../../src/utils/caspio');
const { postBulk, resolveTableId, _resetTableIdCache } = caspio;

const TABLES = { data: [
  { tableId: 'q4y4zp', name: 'Account_Assignment_History' },
  { tableId: 'e3g5df', name: 'Quote_Items' },
  { tableId: 'abc123', name: 'Quote_Change_Log' },
] };

// Route every axios call: token → tables list → bulk POST(s).
let bulkResponder;
function wire() {
  mockAxios.mockImplementation(async (cfg) => {
    const url = typeof cfg === 'string' ? cfg : cfg.url;
    if (/\/oauth\/token$/.test(url)) return { data: { access_token: 'tok', expires_in: 86000 } };
    if (/\/v4\/tables\?pageSize=1000$/.test(url)) return { status: 200, data: TABLES };
    if (/\/v4\/tables\/[a-z0-9]{6}\/records\/bulk/.test(url)) return bulkResponder(cfg);
    throw new Error('unexpected url ' + url);
  });
}
const bulkCalls = () => mockAxios.mock.calls.map(([c]) => c).filter(c => c && /records\/bulk/.test(c.url));

beforeEach(() => {
  mockAxios.mockReset();
  _resetTableIdCache();
  bulkResponder = (cfg) => ({ status: 201, data: { PK_ID: cfg.data.map((_, i) => String(1000 + i)) } });
  wire();
});

describe('resolveTableId', () => {
  test('resolves by name, case-insensitively, and caches the list for the process', async () => {
    expect(await resolveTableId('Quote_Change_Log')).toBe('abc123');
    expect(await resolveTableId('quote_items')).toBe('e3g5df');
    const listCalls = mockAxios.mock.calls.filter(([c]) => /v4\/tables\?/.test(c.url));
    expect(listCalls).toHaveLength(1);
  });

  test('an unknown name refreshes the list once, then throws — never guesses an id', async () => {
    await resolveTableId('Quote_Items');
    await expect(resolveTableId('Nope_Table')).rejects.toThrow(/No Caspio table named "Nope_Table"/);
    const listCalls = mockAxios.mock.calls.filter(([c]) => /v4\/tables\?/.test(c.url));
    expect(listCalls).toHaveLength(2);
  });
});

describe('postBulk', () => {
  test('one request for ≤1,000 rows, posted to the resolved id, tagged for the meter', async () => {
    const rows = [{ QuoteID: 'Q1', FieldName: 'Status' }, { QuoteID: 'Q2', FieldName: 'Status' }];
    const r = await postBulk('Quote_Change_Log', rows);
    expect(r).toMatchObject({ table: 'Quote_Change_Log', tableId: 'abc123', calls: 1, inserted: 2, failed: 0, failures: [] });
    expect(r.pkIds).toEqual(['1000', '1001']);
    const [call] = bulkCalls();
    expect(call.method).toBe('post');
    expect(call.url).toBe('https://c3eku948.caspio.com/integrations/rest/v4/tables/abc123/records/bulk');
    expect(call.data).toEqual(rows);
    expect(call.headers.Authorization).toBe('Bearer tok');
    expect(call._caspioTable).toBe('Quote_Change_Log');
    expect(call.validateStatus(201)).toBe(true);
    expect(call.validateStatus(207)).toBe(true);
    expect(call.validateStatus(400)).toBe(false);
  });

  test('2,500 rows → three requests of 1,000 / 1,000 / 500, results aggregated', async () => {
    const rows = Array.from({ length: 2500 }, (_, i) => ({ n: i }));
    const r = await postBulk('Quote_Items', rows);
    expect(r.calls).toBe(3);
    expect(r.inserted).toBe(2500);
    expect(bulkCalls().map(c => c.data.length)).toEqual([1000, 1000, 500]);
    expect(r.pkIds).toHaveLength(2500);
  });

  test('a 207 reports the failed rows by index with their error, and still counts the created ones', async () => {
    bulkResponder = (cfg) => ({
      status: 207,
      data: {
        PK_ID: ['5', '7'],
        data: cfg.data.map((row, i) => (i === 1
          ? { status: 400, error: "Field 'Quantity' must be a number" }
          : { status: 201, PK_ID: String(5 + i) })),
      },
    });
    const rows = [{ a: 1 }, { a: 'x' }, { a: 3 }];
    const r = await postBulk('Quote_Items', rows);
    expect(r).toMatchObject({ calls: 1, inserted: 2, failed: 1 });
    expect(r.failures).toEqual([{ index: 1, status: 400, error: "Field 'Quantity' must be a number", row: { a: 'x' } }]);
  });

  test('a whole-request failure throws with the status and body, never a silent partial', async () => {
    bulkResponder = () => { const e = new Error('Request failed with status code 400'); e.response = { status: 400, data: { code: 'IncorrectQueryParameter', message: 'bad field' } }; throw e; };
    await expect(postBulk('Quote_Items', [{ a: 1 }])).rejects.toThrow(/postBulk Quote_Items rows 0-0: 400 .*IncorrectQueryParameter/);
  });

  test('an empty array costs nothing, including no table lookup', async () => {
    const r = await postBulk('Quote_Items', []);
    expect(r).toMatchObject({ calls: 0, inserted: 0, failed: 0 });
    expect(mockAxios).not.toHaveBeenCalled();
  });

  test('rows must be an array', async () => {
    await expect(postBulk('Quote_Items', { a: 1 })).rejects.toThrow(/rows must be an array/);
  });

  test('chunkSize can be lowered but never raised above 1,000', async () => {
    await postBulk('Quote_Items', Array.from({ length: 5 }, (_, i) => ({ i })), { chunkSize: 2 });
    expect(bulkCalls().map(c => c.data.length)).toEqual([2, 2, 1]);
    mockAxios.mockClear(); wire();
    await postBulk('Quote_Items', Array.from({ length: 1500 }, (_, i) => ({ i })), { chunkSize: 5000 });
    expect(bulkCalls().map(c => c.data.length)).toEqual([1000, 500]);
  });
});
