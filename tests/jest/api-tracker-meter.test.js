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

// Counting moved from the REQUEST path to the RESPONSE path on 2026-07-31.
// Caspio bills requests it RECEIVES; we were counting requests we SENT, so any
// request that died before reaching them inflated our number and never theirs.
// That is how the meter went from 33% UNDER (7/27) to 18% OVER (7/30) as the
// coverage fixes landed and real usage fell — the two lines crossed.
describe('api-tracker: interceptor counting (counts what Caspio RECEIVES)', () => {
  let stub;

  beforeEach(() => {
    tracker.reset();
    // Minimal axios-shaped stub capturing the RESPONSE interceptor pair, so we
    // can simulate each outcome without issuing a request.
    const handlers = [];
    const swallow = p => { if (p && typeof p.catch === 'function') p.catch(() => {}); };
    stub = {
      interceptors: { response: { use: (ok, err) => handlers.push({ ok, err }) } },
      // Caspio answered normally.
      respond: cfg => handlers.forEach(h => h.ok && h.ok({ config: cfg, status: 200 })),
      // Caspio answered with an error STATUS — still a request they received and billed.
      errorStatus: (cfg, status) =>
        handlers.forEach(h => h.err && swallow(h.err({ config: cfg, response: { status } }))),
      // Never reached Caspio: connection refused / DNS / abort. NOT billed.
      netFail: cfg =>
        handlers.forEach(h => h.err && swallow(h.err({ config: cfg, message: 'socket hang up' }))),
      // Client-side timeout — may or may not have been billed; tracked separately.
      timeout: cfg =>
        handlers.forEach(h => h.err && swallow(h.err({ config: cfg, code: 'ECONNABORTED', message: 'timeout of 15000ms exceeded' })))
    };
    tracker.installOn(stub);
  });

  test('counts a Caspio call once, attributed to its table', () => {
    stub.respond({ url: `${CASPIO}/integrations/rest/v3/tables/ORDER_ODBC/records`, method: 'get' });
    expect(tracker.stats.totalCalls).toBe(1);
    expect(tracker.getTopTables(5)).toEqual([{ table: 'ORDER_ODBC', count: 1 }]);
  });

  test('counts writes, not just reads — these were 100% invisible before', () => {
    stub.respond({ url: `${CASPIO}/integrations/rest/v3/tables/ORDER_ODBC/records`, method: 'put' });
    stub.respond({ url: `${CASPIO}/integrations/rest/v3/tables/ORDER_ODBC/records`, method: 'post' });
    expect(tracker.stats.totalCalls).toBe(2);
    expect(tracker.stats.callsByMethod.get('PUT')).toBe(1);
    expect(tracker.stats.callsByMethod.get('POST')).toBe(1);
  });

  test('an error STATUS still counts — Caspio received and billed it', () => {
    const cfg = { url: `${CASPIO}/integrations/rest/v3/tables/X/records`, method: 'get' };
    stub.errorStatus(cfg, 429);   // the rate limit we hit constantly
    stub.errorStatus(cfg, 400);
    stub.errorStatus(cfg, 500);
    expect(tracker.stats.totalCalls).toBe(3);
    expect(tracker.stats.unbilled.noResponse).toBe(0);
  });

  test('a request that NEVER REACHED Caspio is not counted — this is the over-count fix', () => {
    stub.netFail({ url: `${CASPIO}/integrations/rest/v3/tables/X/records`, method: 'get' });
    expect(tracker.stats.totalCalls).toBe(0);
    expect(tracker.stats.unbilled.noResponse).toBe(1);
  });

  test('a client-side timeout is excluded but bucketed apart (it MAY have been billed)', () => {
    stub.timeout({ url: `${CASPIO}/integrations/rest/v3/tables/X/records`, method: 'get' });
    expect(tracker.stats.totalCalls).toBe(0);
    expect(tracker.stats.unbilled.timedOut).toBe(1);
    expect(tracker.stats.unbilled.noResponse).toBe(0);
  });

  test('a failed NON-Caspio request does not pollute the unbilled counters', () => {
    stub.netFail({ url: 'https://api.shipstation.com/orders', method: 'get' });
    expect(tracker.stats.unbilled.noResponse).toBe(0);
    expect(tracker.stats.unbilled.timedOut).toBe(0);
  });

  test('_skipMeter is honoured on the response path too (no feedback loop)', () => {
    stub.respond({ url: `${CASPIO}/integrations/rest/v3/tables/API_Usage_Daily/records`, method: 'post', _skipMeter: true });
    stub.netFail({ url: `${CASPIO}/integrations/rest/v3/tables/API_Usage_Daily/records`, method: 'post', _skipMeter: true });
    expect(tracker.stats.totalCalls).toBe(0);
    expect(tracker.stats.unbilled.noResponse).toBe(0);
  });

  test('ignores non-Caspio traffic (ShopWorks, SanMar, Box, our own proxy)', () => {
    stub.respond({ url: 'https://api.shipstation.com/orders', method: 'get' });
    stub.respond({ url: 'https://caspio-pricing-proxy-ab30a049961a.herokuapp.com/api/x', method: 'get' });
    expect(tracker.stats.totalCalls).toBe(0);
  });

  test('resolves relative urls against baseURL', () => {
    stub.respond({ baseURL: `${CASPIO}/integrations/rest/v3`, url: '/tables/Leads_CRM/records', method: 'get' });
    expect(tracker.getTopTables(1)).toEqual([{ table: 'Leads_CRM', count: 1 }]);
  });

  test('a thrown interceptor error never blocks the response', () => {
    expect(() => stub.respond({ url: null, method: 'get' })).not.toThrow();
    expect(() => stub.netFail(null)).not.toThrow();
  });

  test('getSummary publishes the unbilled counters so the fix is checkable', () => {
    stub.netFail({ url: `${CASPIO}/integrations/rest/v3/tables/X/records`, method: 'get' });
    expect(tracker.getSummary().unbilled).toEqual({ noResponse: 1, timedOut: 0 });
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
