// api-tracker: a request tagged `_caspioTable` is attributed to that table NAME
// (2026-09-06). v4 URLs carry a six-character tableId, so without the tag every
// bulk insert would show up in /api/admin/metrics as an opaque id.

process.env.CASPIO_ACCOUNT_DOMAIN = process.env.CASPIO_ACCOUNT_DOMAIN || 'c3eku948.caspio.com';
const tracker = require('../../src/utils/api-tracker');
const CASPIO = 'https://c3eku948.caspio.com';

describe('api-tracker: _caspioTable label override', () => {
  let stub;
  beforeEach(() => {
    tracker.reset();
    const handlers = [];
    stub = {
      interceptors: { response: { use: (ok, err) => handlers.push({ ok, err }) } },
      respond: cfg => handlers.forEach(h => h.ok && h.ok({ config: cfg, status: 201 })),
    };
    tracker.installOn(stub);
  });

  test('a v4 bulk insert is counted once, under the table name, as a POST', () => {
    stub.respond({ url: `${CASPIO}/integrations/rest/v4/tables/abc123/records/bulk`, method: 'post', _caspioTable: 'Quote_Change_Log' });
    expect(tracker.stats.totalCalls).toBe(1);
    expect(tracker.getTopTables(5)).toEqual([{ table: 'Quote_Change_Log', count: 1 }]);
    expect(tracker.getTopEndpoints(5)).toEqual([{ endpoint: '/tables/Quote_Change_Log/records/bulk', count: 1 }]);
    expect(Object.fromEntries(tracker.stats.callsByMethod)).toEqual({ POST: 1 });
  });

  test('without the tag a v4 URL still counts, labelled by whatever the path carries', () => {
    stub.respond({ url: `${CASPIO}/integrations/rest/v4/tables/abc123/records/bulk`, method: 'post' });
    expect(tracker.getTopTables(5)).toEqual([{ table: 'abc123', count: 1 }]);
  });

  test('the tag never bypasses _skipMeter', () => {
    stub.respond({ url: `${CASPIO}/integrations/rest/v4/tables/abc123/records/bulk`, method: 'post', _caspioTable: 'X', _skipMeter: true });
    expect(tracker.stats.totalCalls).toBe(0);
  });
});
