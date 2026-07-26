// The rollup must ACCUMULATE across dyno restarts, never overwrite.
// Hermetic — axios and the Caspio helpers are stubbed, no network.
//
// Regression: `tracker.stats.callsByDay` counts since THIS PROCESS started, and
// the original pushRollup PUT that number straight into the row. Every dyno
// restart reset the counter, so the stored total walked BACKWARDS. Observed in
// production 2026-07-26: four restarts in one day left the row reading 1,650
// while Caspio billed 15,951 — a 10x under-report from the one component whose
// job is to be the trustworthy number.

jest.mock('axios');
jest.mock('../../src/utils/caspio', () => ({
  getCaspioAccessToken: jest.fn().mockResolvedValue('tok'),
  fetchAllCaspioPages: jest.fn()
}));

const axios = require('axios');
const { fetchAllCaspioPages } = require('../../src/utils/caspio');

// The module reads the table name at require time.
process.env.API_USAGE_ROLLUP_TABLE = 'API_Usage_Daily';
process.env.DYNO = 'web.1';

/** Fresh module instance = a fresh process (its in-memory watermark resets). */
function bootProcess() {
  let mod, tracker;
  jest.isolateModules(() => {
    tracker = require('../../src/utils/api-tracker');
    tracker.reset();
    mod = require('../../src/utils/api-usage-rollup');
  });
  return { mod, tracker };
}

/** Stand-in for the stored row; PUT/POST mutate it like Caspio would. */
function stubTable(initial) {
  const state = { value: initial };
  fetchAllCaspioPages.mockImplementation(async () =>
    state.value === null ? [] : [{ Call_Count: state.value }]
  );
  axios.put.mockImplementation(async (_u, body) => {
    if (state.value === null) return { data: { RecordsAffected: 0 } };
    state.value = body.Call_Count;
    return { data: { RecordsAffected: 1 } };
  });
  axios.post.mockImplementation(async (_u, body) => {
    state.value = body.Call_Count;
    return { data: {} };
  });
  return state;
}

const today = () => new Date().toISOString().slice(0, 10);

/** Simulate n tracked Caspio calls on this process. */
function record(tracker, n) {
  for (let i = 0; i < n; i++) tracker.trackCall('/tables/X/records', 'X', 'GET');
}

beforeEach(() => jest.clearAllMocks());

describe('api-usage-rollup: accumulation', () => {
  test('first write of the day INSERTS the running count', async () => {
    const table = stubTable(null);
    const { mod, tracker } = bootProcess();
    record(tracker, 500);

    await mod.runOnce();
    expect(table.value).toBe(500);
  });

  test('a second write in the same process adds only the DELTA', async () => {
    const table = stubTable(null);
    const { mod, tracker } = bootProcess();

    record(tracker, 500);
    await mod.runOnce();
    expect(table.value).toBe(500);

    record(tracker, 300); // now 800 since start
    await mod.runOnce();
    expect(table.value).toBe(800); // not 1300 — the delta is 300
  });

  test('THE REGRESSION: a restart adds to the stored total instead of resetting it', async () => {
    const table = stubTable(null);

    const p1 = bootProcess();
    record(p1.tracker, 12000);
    await p1.mod.runOnce();
    expect(table.value).toBe(12000);

    // Dyno cycles. New process: counters back to zero.
    const p2 = bootProcess();
    record(p2.tracker, 1650);
    await p2.mod.runOnce();

    // Old behaviour wrote 1650 and lost 12,000 calls.
    expect(table.value).toBe(13650);
    expect(table.value).not.toBe(1650);
  });

  test('several restarts in one day all accumulate', async () => {
    const table = stubTable(null);
    let expected = 0;
    for (const n of [4000, 3000, 1000, 1650]) {
      const p = bootProcess();
      record(p.tracker, n);
      await p.mod.runOnce();
      expected += n;
      expect(table.value).toBe(expected);
    }
    expect(table.value).toBe(9650);
  });

  test('a no-op tick writes nothing (no wasted Caspio calls)', async () => {
    stubTable(null);
    const { mod, tracker } = bootProcess();
    record(tracker, 100);
    await mod.runOnce();

    axios.put.mockClear();
    axios.post.mockClear();
    await mod.runOnce(); // nothing new since the last write

    expect(axios.put).not.toHaveBeenCalled();
    expect(axios.post).not.toHaveBeenCalled();
  });

  test('a FAILED write does not advance the watermark — the delta is retried', async () => {
    const table = stubTable(100);
    const { mod, tracker } = bootProcess();
    record(tracker, 500);

    axios.put.mockRejectedValueOnce(new Error('Caspio 500'));
    await mod.runOnce(); // swallowed into state.lastError
    expect(mod.status().consecutiveFailures).toBe(1);
    expect(table.value).toBe(100); // unchanged

    await mod.runOnce(); // retry must still carry the full 500
    expect(table.value).toBe(600);
  });

  test('status() reports the table and dyno it is writing as', () => {
    const { mod } = bootProcess();
    const s = mod.status();
    expect(s.configured).toBe(true);
    expect(s.table).toBe('API_Usage_Daily');
    expect(s.dyno).toBe('web.1');
  });

  test('readPeriod sums Call_Count across dynos and days', async () => {
    fetchAllCaspioPages.mockResolvedValueOnce([
      { Usage_Date: today(), Dyno_Id: 'web.1', Call_Count: 10000 },
      { Usage_Date: today(), Dyno_Id: 'web.2', Call_Count: 5000 },
      { Usage_Date: '2026-07-25', Dyno_Id: 'web.1', Call_Count: 20000 }
    ]);
    const { mod } = bootProcess();
    const p = await mod.readPeriod('2026-07-25', today());

    expect(p.total).toBe(35000);
    expect(p.byDay[today()]).toBe(15000);
    expect(p.dynos.sort()).toEqual(['web.1', 'web.2']);
  });
});
