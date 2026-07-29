// Locks the exit-flush path in src/utils/api-usage-rollup.js.
//
// The hole: a script ending in process.exit() never reaches `beforeExit`, so
// everything counted since the last 250-call flush was billed by Caspio and
// never recorded. check-transfers-received makes a FIXED ~2 calls per run —
// two orders of magnitude below the threshold — so every hourly run recorded
// ZERO. That is under-reporting, which always reads as "we're fine".
//
// Two things are tested here that bit during implementation:
//   1. runOnce() must return the RUNNING promise when a flush is already in
//      flight. It used to `return` bare undefined, so `await runOnce()` from the
//      exit path resolved instantly and the process died mid-write.
//   2. flushAndExit must ALWAYS exit, with the caller's code, even when the
//      flush throws or times out — a metering helper must never change whether a
//      job reports success, nor hang a one-off dyno open.

process.env.API_USAGE_ROLLUP_TABLE = 'API_Usage_Daily';
process.env.DYNO = 'test.1';

jest.mock('axios');
jest.mock('../../src/utils/caspio', () => ({
  getCaspioAccessToken: jest.fn(async () => 'test-token'),
  fetchAllCaspioPages: jest.fn(async () => [])
}));
jest.mock('../../src/utils/api-tracker', () => ({
  stats: { callsByDay: new Map() },
  onCallThreshold: jest.fn()
}));

// EVERY handle is re-required inside beforeEach, AFTER jest.resetModules().
// resetModules invalidates the registry, so a module-scope `require` hands back a
// stale instance while the code under test gets a fresh one — the mocks then look
// wired up but observe nothing (axios.post: 0 calls). resetModules is itself
// required here: the rollup keeps `contributed` watermarks in module state, so
// without it each test inherits the previous test's flush history.
let rollup, axios, tracker, accountDay, exitSpy;

beforeEach(() => {
  jest.resetModules();
  axios = require('axios');
  axios.post = jest.fn(async () => ({ data: {} }));
  tracker = require('../../src/utils/api-tracker');
  tracker.stats.callsByDay = new Map();
  ({ accountDay } = require('../../src/utils/account-time'));
  exitSpy = jest.spyOn(process, 'exit').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  rollup = require('../../src/utils/api-usage-rollup');
});

afterEach(() => jest.restoreAllMocks());

const countToday = n => tracker.stats.callsByDay.set(accountDay(), n);

describe('runOnce coalescing is awaitable', () => {
  test('a second caller awaits the in-flight write instead of resolving instantly', async () => {
    let releaseWrite;
    axios.post = jest.fn(() => new Promise(res => { releaseWrite = () => res({ data: {} }); }));
    countToday(300);

    const first = rollup.runOnce();
    await Promise.resolve();                      // let the first reach the POST

    let secondSettled = false;
    const second = Promise.resolve(rollup.runOnce()).then(() => { secondSettled = true; });

    await Promise.resolve(); await Promise.resolve();
    // THE REGRESSION: this used to be true — runOnce returned undefined, so the
    // caller carried straight on to process.exit() over a live write.
    expect(secondSettled).toBe(false);

    releaseWrite();
    await first; await second;
    expect(secondSettled).toBe(true);
  });

  test('nothing is written when there is no delta', async () => {
    countToday(0);
    await rollup.runOnce();
    expect(axios.post).not.toHaveBeenCalled();
  });

  test('the write carries the account-clock day, the dyno and the delta', async () => {
    countToday(42);
    await rollup.runOnce();
    expect(axios.post).toHaveBeenCalledTimes(1);
    const body = axios.post.mock.calls[0][1];
    expect(body).toMatchObject({ Usage_Date: accountDay(), Dyno_Id: 'test.1', Call_Count: 42 });
    // Must not meter itself — that feedback loop wrote ~1,893 junk rows on 2026-07-28.
    expect(axios.post.mock.calls[0][2]).toMatchObject({ _skipMeter: true });
  });
});

describe('unflushedCount', () => {
  test('reports what has been counted but not written, and clears after a flush', async () => {
    countToday(120);
    expect(rollup.unflushedCount()).toBe(120);
    await rollup.runOnce();
    expect(rollup.unflushedCount()).toBe(0);
  });

  test('never goes negative', () => {
    countToday(0);
    expect(rollup.unflushedCount()).toBe(0);
  });
});

describe('flushAndExit', () => {
  test('writes the tail, then exits 0', async () => {
    countToday(7);
    await rollup.flushAndExit(0);
    expect(axios.post).toHaveBeenCalledTimes(1);
    expect(axios.post.mock.calls[0][1].Call_Count).toBe(7);
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  test('PRESERVES a non-zero exit code — the scheduler must still see failure', async () => {
    countToday(5);
    await rollup.flushAndExit(1);
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  test('defaults to 0 when no code is given', async () => {
    countToday(1);
    await rollup.flushAndExit();
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  test('still exits with the right code when the write throws', async () => {
    axios.post = jest.fn(async () => { throw new Error('caspio exploded'); });
    countToday(9);
    await rollup.flushAndExit(1);
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  test('exits exactly once', async () => {
    countToday(3);
    await rollup.flushAndExit(0);
    expect(exitSpy).toHaveBeenCalledTimes(1);
  });
});

describe('repo guard — every metering entry point flushes before it exits', () => {
  const fs = require('fs');
  const path = require('path');
  const repo = path.join(__dirname, '..', '..');

  // Scoped to package.json entry points ON PURPOSE. A blanket scan of scripts/
  // hits ~25 once-a-year dev one-shots (create-*-table.js, seed-*.js) and would
  // fail on unrelated work.
  const entryPoints = () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(repo, 'package.json'), 'utf8'));
    const files = new Set();
    for (const cmd of Object.values(pkg.scripts || {})) {
      const m = String(cmd).match(/node\s+(scripts\/[\w.-]+\.js)/);
      if (m) files.add(m[1]);
    }
    return [...files].filter(f => fs.existsSync(path.join(repo, f)));
  };

  test('a script that loads the tracker and exits explicitly uses flushAndExit', () => {
    const offenders = [];
    for (const f of entryPoints()) {
      const src = fs.readFileSync(path.join(repo, f), 'utf8');
      const meters = /require\(['"]\.\.\/src\/utils\/(api-tracker|caspio)['"]\)/.test(src);
      if (!meters) continue;                       // calls the proxy over HTTP; nothing to flush
      // Ignore exits that fire before any work (missing-env guards): only the
      // terminal handlers after main() can strand a counted-but-unwritten tail.
      const terminal = /main\(\)[\s\S]*process\.exit\(/.test(src);
      if (terminal && !/flushAndExit/.test(src)) offenders.push(f);
    }
    expect(offenders).toEqual([]);
  });

  test('the four known metering jobs are actually covered (guard cannot pass vacuously)', () => {
    const covered = entryPoints().filter(f =>
      /flushAndExit/.test(fs.readFileSync(path.join(repo, f), 'utf8')));
    for (const f of [
      'scripts/check-transfers-received.js',
      'scripts/sync-manageorders.js',
      'scripts/sync-commissions.js',
      'scripts/check-zero-billing.js'
    ]) {
      expect(covered).toContain(f);
    }
  });
});
