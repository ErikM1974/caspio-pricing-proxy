// Unit tests for the Caspio call meter (src/utils/api-tracker.js).
// Hermetic — no Caspio, no network. The interceptor is exercised against a
// stub axios instance so nothing is actually sent.
//
// Regression this file locks down: before 2026-07-26 the meter derived the
// table name with `path.split('/').pop().replace('/records','')`, which returns
// the literal "records" for EVERY /tables/X/records URL. The whole breakdown
// collapsed into one row called "records", so per-table attribution silently
// never worked — while Caspio billed a $358 overage.

const tracker = require('../../src/utils/api-tracker');

const CASPIO = 'https://nwcustom.caspio.com';

describe('api-tracker: deriveTarget', () => {
  test('names the real table for /tables/{name}/records (NOT "records")', () => {
    const t = tracker.deriveTarget(`${CASPIO}/integrations/rest/v3/tables/Quote_Sessions/records`);
    expect(t.table).toBe('Quote_Sessions');
    expect(t.table).not.toBe('records');
    expect(t.endpoint).toBe('/tables/Quote_Sessions/records');
  });

  test('works on the v2 base URL too (both bill against the same quota)', () => {
    const t = tracker.deriveTarget(`${CASPIO}/rest/v2/tables/ArtRequests/records`);
    expect(t.table).toBe('ArtRequests');
  });

  test('distinguishes views from tables', () => {
    const t = tracker.deriveTarget(`${CASPIO}/integrations/rest/v3/views/Active_Orders/records`);
    expect(t.table).toBe('view:Active_Orders');
  });

  test('labels token fetches', () => {
    const t = tracker.deriveTarget(`${CASPIO}/oauth/token`);
    expect(t.table).toBe('__oauth_token__');
  });

  test('labels the Files API', () => {
    const t = tracker.deriveTarget(`${CASPIO}/integrations/rest/v3/files/abc123`);
    expect(t.table).toBe('__files__');
  });

  test('does not throw on a malformed URL', () => {
    expect(() => tracker.deriveTarget('not a url')).not.toThrow();
  });
});

describe('api-tracker: isCaspioUrl', () => {
  test.each([
    [`${CASPIO}/integrations/rest/v3/tables/X/records`, true],
    ['https://caspio.com/oauth/token', true],
    ['https://caspio-pricing-proxy-ab30a049961a.herokuapp.com/api/quote_sessions', false],
    ['https://api.shopworks.com/orders', false],
    ['https://evil-caspio.com.attacker.net/x', false],
    ['garbage', false]
  ])('%s -> %s', (url, expected) => {
    expect(tracker.isCaspioUrl(url)).toBe(expected);
  });
});

describe('api-tracker: interceptor counting', () => {
  let stub;

  beforeEach(() => {
    tracker.reset();
    // Minimal axios-shaped stub: capture the registered interceptor so we can
    // invoke it directly without issuing a request.
    const handlers = [];
    stub = {
      interceptors: { request: { use: fn => handlers.push(fn) } },
      fire: cfg => handlers.forEach(fn => fn(cfg))
    };
    tracker.installOn(stub);
  });

  test('counts a Caspio request once, attributed to its table', () => {
    stub.fire({ url: `${CASPIO}/integrations/rest/v3/tables/ORDER_ODBC/records`, method: 'get' });
    expect(tracker.stats.totalCalls).toBe(1);
    expect(tracker.getTopTables(5)).toEqual([{ table: 'ORDER_ODBC', count: 1 }]);
  });

  test('counts writes, not just reads — these were 100% invisible before', () => {
    stub.fire({ url: `${CASPIO}/integrations/rest/v3/tables/ORDER_ODBC/records`, method: 'put' });
    stub.fire({ url: `${CASPIO}/integrations/rest/v3/tables/ORDER_ODBC/records`, method: 'post' });
    expect(tracker.stats.totalCalls).toBe(2);
    expect(tracker.stats.callsByMethod.get('PUT')).toBe(1);
    expect(tracker.stats.callsByMethod.get('POST')).toBe(1);
  });

  test('ignores non-Caspio traffic (ShopWorks, SanMar, Box, our own proxy)', () => {
    stub.fire({ url: 'https://api.shipstation.com/orders', method: 'get' });
    stub.fire({ url: 'https://caspio-pricing-proxy-ab30a049961a.herokuapp.com/api/x', method: 'get' });
    expect(tracker.stats.totalCalls).toBe(0);
  });

  test('resolves relative urls against baseURL', () => {
    stub.fire({ baseURL: `${CASPIO}/integrations/rest/v3`, url: '/tables/Leads_CRM/records', method: 'get' });
    expect(tracker.getTopTables(1)).toEqual([{ table: 'Leads_CRM', count: 1 }]);
  });

  test('a thrown interceptor error never blocks the request', () => {
    expect(() => stub.fire({ url: null, method: 'get' })).not.toThrow();
  });
});

describe('api-tracker: summary', () => {
  beforeEach(() => tracker.reset());

  test('full=true returns the COMPLETE breakdown, not a top-5', () => {
    for (let i = 0; i < 8; i++) {
      tracker.trackCall(`/tables/T${i}/records`, `T${i}`, 'GET');
    }
    const top = tracker.getSummary();
    const full = tracker.getSummary({ full: true });

    expect(top.topTables).toHaveLength(5);
    expect(full.callsByTable).toHaveLength(8);
    expect(full.callsByMethod).toEqual({ GET: 8 });
  });

  test('reports uptime so a reading from a freshly cycled dyno is interpretable', () => {
    tracker.trackCall('/tables/X/records', 'X', 'GET');
    const s = tracker.getSummary();
    expect(s.totalCallsSinceStart).toBe(1);
    expect(typeof s.processUptimeMs).toBe('number');
    expect(s).toHaveProperty('callsPerHourSinceStart');
  });

  test('a short-uptime dyno extrapolates rather than reporting a reassuring zero', () => {
    for (let i = 0; i < 100; i++) tracker.trackCall('/tables/X/records', 'X', 'GET');
    // Uptime is milliseconds here, so 100 calls must project to something large.
    expect(tracker.getMonthlyProjection()).toBeGreaterThan(100);
  });
});
