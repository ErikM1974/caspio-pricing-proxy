// The rollup must record calls from SHORT-LIVED processes (Heroku Scheduler
// one-off dynos), not just the long-running web dyno.
//
// Regression: the rollup only flushed on a 60-minute setInterval. Every
// `npm run sync-*` job runs as a one-off dyno that lives for seconds and exits
// via process.exit(0), so the interval never fired and SIGTERM never arrived.
// From the day the rollup shipped until 2026-07-28 the API_Usage_Daily table
// contained rows from `web.1` and NOTHING ELSE — ~30% of the account's Caspio
// traffic was invisible. Caspio billed 23,959 on 27 Jul; the rollup said 16,055.

jest.mock('axios');
jest.mock('../../src/utils/caspio', () => ({
  getCaspioAccessToken: jest.fn().mockResolvedValue('tok'),
  fetchAllCaspioPages: jest.fn().mockResolvedValue([])
}));

const axios = require('axios');

process.env.API_USAGE_ROLLUP_TABLE = 'API_Usage_Daily';

/** Fresh module instances = a fresh process. */
function bootProcess(dyno) {
  process.env.DYNO = dyno;
  let mod, tracker;
  jest.isolateModules(() => {
    tracker = require('../../src/utils/api-tracker');
    tracker.reset();
    mod = require('../../src/utils/api-usage-rollup');
  });
  return { mod, tracker };
}

/** Rows the stubbed Caspio "table" has received. */
function captureRows() {
  const rows = [];
  axios.post.mockImplementation(async (_u, body) => { rows.push(body); return { data: {} }; });
  axios.put.mockImplementation(async () => { throw new Error('PUT must not be used — writes are append-only'); });
  return rows;
}

const record = (tracker, n) => {
  for (let i = 0; i < n; i++) tracker.trackCall('/tables/X/records', 'X', 'GET');
};
const flush = () => new Promise(r => setImmediate(r));

beforeEach(() => jest.clearAllMocks());

describe('rollup: short-lived scheduler dynos', () => {
  test('THE REGRESSION: a process that never fires a timer still records its calls', async () => {
    const rows = captureRows();
    const { mod, tracker } = bootProcess('scheduler.1234');
    mod.start();

    // A sync job burns 600 calls and exits. No interval, no SIGTERM.
    record(tracker, 600);
    await flush();

    expect(rows.length).toBeGreaterThan(0);
    const total = rows.reduce((s, r) => s + r.Call_Count, 0);
    expect(total).toBeGreaterThanOrEqual(500); // 2 thresholds of 250
    expect(rows[0].Dyno_Id).toBe('scheduler.1234');
  });

  test('writes are APPEND-ONLY deltas, never a cumulative overwrite', async () => {
    const rows = captureRows();
    const { mod, tracker } = bootProcess('scheduler.5678');
    mod.start();

    record(tracker, 250); await flush();
    record(tracker, 250); await flush();

    // Each row carries only its own slice; summing reconstructs the total.
    //
    // Since 2026-07-30 the sum can exceed the TRACKED calls by at most one per row:
    // every rollup POST is itself a billed Caspio call, is now counted, and lands in
    // the following flush's delta. Asserting the invariant rather than a literal
    // total, so the numbers stay meaningful instead of needing a bump each time.
    const sum = rows.reduce((s, r) => s + r.Call_Count, 0);
    expect(rows.every(r => r.Call_Count <= 250 + 1)).toBe(true);
    expect(sum).toBeGreaterThanOrEqual(500);
    expect(sum - 500).toBeLessThanOrEqual(rows.length);   // excess is our own writes only
    expect(axios.put).not.toHaveBeenCalled();
  });

  test('no read-modify-write, so concurrent dynos cannot clobber each other', async () => {
    const rows = captureRows();
    const a = bootProcess('scheduler.1'); a.mod.start();
    const b = bootProcess('scheduler.2'); b.mod.start();

    record(a.tracker, 250);
    record(b.tracker, 250);
    await flush();

    // Both contributions survive — the old cumulative row would have lost one.
    expect(rows.reduce((s, r) => s + r.Call_Count, 0)).toBe(500);
  });

  test('the web dyno still records, and restart loss is capped at the threshold', async () => {
    const rows = captureRows();
    const p1 = bootProcess('web.1'); p1.mod.start();
    record(p1.tracker, 700); await flush();
    const afterFirst = rows.reduce((s, r) => s + r.Call_Count, 0);

    // Dyno cycles mid-day; a fresh process simply appends.
    const p2 = bootProcess('web.1'); p2.mod.start();
    record(p2.tracker, 300); await flush();

    const total = rows.reduce((s, r) => s + r.Call_Count, 0);
    expect(total).toBeGreaterThan(afterFirst);
    expect(700 + 300 - total).toBeLessThanOrEqual(250); // unflushed tail only
  });

  test('a sub-threshold run writes nothing rather than a bogus row', async () => {
    const rows = captureRows();
    const { mod, tracker } = bootProcess('scheduler.9');
    mod.start();
    record(tracker, 10);
    await flush();
    expect(rows).toHaveLength(0);
  });

  test('start() is idempotent — server.js and the auto-start cannot double-register', async () => {
    const rows = captureRows();
    const { mod, tracker } = bootProcess('web.1');
    mod.start(); mod.start(); mod.start();
    record(tracker, 250);
    await flush();
    expect(rows).toHaveLength(1); // not 3
  });

  test('a threshold crossed while a write is in flight is deferred, never dropped', async () => {
    const rows = captureRows();
    const { mod, tracker } = bootProcess('scheduler.burst');
    mod.start();

    // 600 calls land synchronously: the 250 and 500 triggers both fire before
    // the first POST resolves. Dropping the second would strand 350 calls in a
    // process that is about to exit.
    record(tracker, 600);
    await flush(); await flush();

    // Nothing may be stranded. The sum may exceed 600 by at most one per row — each
    // flush's own billed POST is counted and rides in the next delta (2026-07-30).
    const sum = rows.reduce((s, r) => s + r.Call_Count, 0);
    expect(sum).toBeGreaterThanOrEqual(600);
    expect(sum - 600).toBeLessThanOrEqual(rows.length);
  });
});

describe('rollup: write failures and reads', () => {
  test('a FAILED write does not advance the watermark — the delta is retried', async () => {
    const rows = [];
    axios.post
      .mockImplementationOnce(async () => { throw new Error('Caspio 500'); })
      .mockImplementation(async (_u, body) => { rows.push(body); return { data: {} }; });

    const { mod, tracker } = bootProcess('web.1');
    mod.start();

    record(tracker, 250);
    await flush();
    expect(rows).toHaveLength(0);
    expect(mod.status().consecutiveFailures).toBe(1);

    // The retry must still carry the FULL 250 — a dropped watermark would lose it.
    // It carries 251, and that extra 1 is correct: Caspio bills a request that then
    // 500s, so the failed POST attempt is itself a billed call and is now counted
    // (2026-07-30). It rides in this delta.
    await mod.runOnce();
    const sum = rows.reduce((s, r) => s + r.Call_Count, 0);
    expect(sum).toBeGreaterThanOrEqual(250);      // nothing lost — the point of the test
    expect(sum - 250).toBeLessThanOrEqual(1);     // exactly the one failed attempt
  });

  test('readPeriod sums the delta rows across dynos and days', async () => {
    const { fetchAllCaspioPages } = require('../../src/utils/caspio');
    const today = new Date().toISOString().slice(0, 10);
    fetchAllCaspioPages.mockResolvedValueOnce([
      { Usage_Date: today, Dyno_Id: 'web.1', Call_Count: 250 },
      { Usage_Date: today, Dyno_Id: 'web.1', Call_Count: 250 },        // same dyno, 2 flushes
      { Usage_Date: today, Dyno_Id: 'scheduler.77', Call_Count: 800 }, // the previously-invisible one
      { Usage_Date: '2026-07-25', Dyno_Id: 'web.1', Call_Count: 9000 }
    ]);
    const { mod } = bootProcess('web.1');
    const p = await mod.readPeriod('2026-07-25', today);

    expect(p.total).toBe(10300);
    expect(p.byDay[today]).toBe(1300);
    expect(p.dynos.sort()).toEqual(['scheduler.77', 'web.1']);
  });

  // Observed in production 2026-07-28 on the very first one-off dyno: the flush
  // lands immediately after the work that triggered it, which is exactly when a
  // burst is most likely. Caspio answered `api-calls-rate` three times and the
  // circuit breaker switched metering off for the rest of the process.
  test('a rate limit is retried, not counted as a failure', async () => {
    const rows = [];
    const rateErr = { response: { status: 429, data: [{ name: 'api-calls-rate' }] } };
    axios.post
      .mockRejectedValueOnce(rateErr)
      .mockImplementation(async (_u, body) => { rows.push(body); return { data: {} }; });

    const { mod, tracker } = bootProcess('run.8695');
    record(tracker, 250);   // no start() — drive the write path directly
    await mod.runOnce();

    expect(rows.reduce((s, r) => s + r.Call_Count, 0)).toBe(250); // retry landed
    expect(mod.status().consecutiveFailures).toBe(0);             // not a "failure"
    expect(mod.status().active).toBe(true);                       // breaker untripped
  });

  test('a persistent rate limit defers without disabling metering', async () => {
    const rateErr = { response: { status: 429, data: [{ name: 'api-calls-rate' }] } };
    axios.post.mockRejectedValue(rateErr);

    const { mod, tracker } = bootProcess('run.999');
    record(tracker, 250);
    for (let i = 0; i < 4; i++) await mod.runOnce();

    expect(mod.status().active).toBe(true);            // still on — it is transient
    expect(mod.status().consecutiveFailures).toBe(0);
  });

  test('a STRUCTURAL error still trips the breaker after 3 tries', async () => {
    axios.post.mockRejectedValue({ response: { status: 404, data: { message: 'table not found' } } });

    const { mod, tracker } = bootProcess('web.1');
    record(tracker, 250);
    for (let i = 0; i < 3; i++) await mod.runOnce();

    expect(mod.status().active).toBe(false);           // a missing table IS fatal
    expect(mod.status().consecutiveFailures).toBe(3);
  });

  // THE RUNAWAY, 2026-07-28. The rollup's own POST was being counted by the
  // metering interceptor, so every flush left a fresh non-zero delta, which
  // triggered another flush. With an unguarded beforeExit that fed itself until
  // Caspio's per-second limit stopped it — ~1,893 junk rows in the table.
  test('the flush POST is marked _skipMeter so it cannot feed itself', async () => {
    const seen = [];
    axios.post.mockImplementation(async (_u, _b, cfg) => { seen.push(cfg); return { data: {} }; });

    const { mod, tracker } = bootProcess('web.1');
    record(tracker, 250);
    await mod.runOnce();

    expect(seen).toHaveLength(1);
    expect(seen[0]._skipMeter).toBe(true);
  });

  test('the interceptor ignores a _skipMeter request', () => {
    const { tracker } = bootProcess('web.1');
    const handlers = [];
    // Counting lives on the RESPONSE path since 2026-07-31 — Caspio bills what it
    // receives, so a request that never got there must not be counted.
    const stub = { interceptors: { response: { use: (ok, err) => handlers.push({ ok, err }) } } };
    tracker.installOn(stub);
    const fire = cfg => handlers.forEach(h => h.ok && h.ok({ config: cfg, status: 200 }));

    const url = 'https://nwcustom.caspio.com/integrations/rest/v3/tables/API_Usage_Daily/records';
    fire({ url, method: 'post', _skipMeter: true });
    expect(tracker.stats.totalCalls).toBe(0);        // metering overhead, not traffic

    fire({ url, method: 'post' });                    // a normal write still counts
    expect(tracker.stats.totalCalls).toBe(1);
  });

  test('status() reports the table and dyno it writes as', () => {
    const { mod } = bootProcess('scheduler.42');
    expect(mod.status()).toMatchObject({
      configured: true,
      table: 'API_Usage_Daily',
      dyno: 'scheduler.42'
    });
  });
});
