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
    expect(rows.every(r => r.Call_Count <= 250)).toBe(true);
    expect(rows.reduce((s, r) => s + r.Call_Count, 0)).toBe(500);
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

    expect(rows.reduce((s, r) => s + r.Call_Count, 0)).toBe(600);
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
    await mod.runOnce();
    expect(rows.reduce((s, r) => s + r.Call_Count, 0)).toBe(250);
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

  test('status() reports the table and dyno it writes as', () => {
    const { mod } = bootProcess('scheduler.42');
    expect(mod.status()).toMatchObject({
      configured: true,
      table: 'API_Usage_Daily',
      dyno: 'scheduler.42'
    });
  });
});
