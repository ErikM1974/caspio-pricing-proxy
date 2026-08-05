/**
 * scripts/sync-sanmar.js — the daily job must not let one phase silence the others.
 *
 * WHY (2026-07-31)
 * main() ran six phases as bare `await`s under a single try/catch. The FIRST phase calls
 * POST /api/sanmar-orders/sync, which Heroku's router kills at 30s (H12 — measured twice,
 * 503 at 30.36s). That threw, so phases 2-6 never ran — including syncRecentCompleted(),
 * the catch-up whose entire job is ingesting orders that never entered the table. The
 * slowest phase was disabling its own safety net.
 *
 * These are source-shape assertions rather than an execution harness: the script is a
 * top-level `main()` that calls process.exit() and hits the network, so importing it in
 * jest would exit the runner. Shape is what regressed, and shape is what this locks.
 */
const fs = require('fs');
const path = require('path');

const SRC = fs.readFileSync(path.join(__dirname, '../../scripts/sync-sanmar.js'), 'utf8');

// The body of main()'s normal-daily-sync branch.
function dailyBranch() {
  const start = SRC.indexOf('const phases = [');
  const end = SRC.indexOf('process.exit(0);');
  expect(start).toBeGreaterThan(-1);
  return SRC.slice(start, end);
}

describe('sync-sanmar daily job: phase isolation', () => {
  test('every phase is registered in the phases table', () => {
    const branch = dailyBranch();
    for (const phase of [
      'syncOrders',
      'syncPendingShipments',
      'syncRecentCompleted',
      'syncInvoices',
      'matchManageOrders',
      'syncDeliveryDates',
    ]) {
      expect(branch).toContain(phase);
    }
  });

  test('phases run in a loop with a per-phase catch, not as bare sequential awaits', () => {
    const branch = dailyBranch();
    expect(branch).toMatch(/for\s*\(const\s*\[\s*name\s*,\s*run\s*\]\s*of\s*phases\s*\)/);
    expect(branch).toMatch(/try\s*\{[\s\S]*await run\(\)[\s\S]*\}\s*catch/);
    // The regression shape: `await syncRecentCompleted();` sitting bare in main().
    expect(branch).not.toMatch(/^\s*await syncRecentCompleted\(\);\s*$/m);
    expect(branch).not.toMatch(/^\s*await syncInvoices\(\);\s*$/m);
  });

  test('a failed phase still marks the run red, but only after the rest have run', () => {
    const branch = dailyBranch();
    expect(branch).toMatch(/failed\.push\(name\)/);
    const pushAt = branch.indexOf('failed.push(name)');
    const exitAt = branch.indexOf('process.exit(1)');
    expect(pushAt).toBeGreaterThan(-1);
    expect(exitAt).toBeGreaterThan(pushAt);   // exit is after the loop, not inside it
  });
});

describe('sync-sanmar: Heroku H12 on the order sync is survivable', () => {
  test('a router timeout is recognised rather than thrown', () => {
    expect(SRC).toMatch(/function isRouterTimeout/);
    expect(SRC).toMatch(/ECONNABORTED/);
    expect(SRC).toMatch(/status === 503/);
  });

  test('syncOrders catches the router timeout and returns instead of throwing', () => {
    const fn = SRC.slice(SRC.indexOf('async function syncOrders'), SRC.indexOf('// Catch-up shipment pull'));
    expect(fn).toMatch(/catch\s*\(err\)/);
    expect(fn).toMatch(/if\s*\(!isRouterTimeout\(err\)\)\s*throw err;/);  // real errors still propagate
    expect(fn).toMatch(/return\s*\{\s*viaH12: true/);
  });

  test('after an H12 it waits for the server-side sync to settle, with a bound', () => {
    const fn = SRC.slice(SRC.indexOf('async function waitForSyncToSettle'), SRC.indexOf('async function syncOrders'));
    expect(fn).toMatch(/status-summary/);          // confirms via lastSync advancing
    expect(fn).toMatch(/deadline/);                // bounded — never hangs the scheduled job
    expect(fn).toMatch(/return false/);            // gives up rather than looping forever
  });
});

describe('sync-sanmar: the daily short backfill closes the weekend hole', () => {
  // The incremental sync looks back 24h and Monday uses allOpen (which excludes Complete),
  // so an order that closes over a weekend falls through both. PO 113847 was still missing
  // 2.4h after Monday 8/3's sync; a manual backfill?days=3 fixed it, four days running.
  test('it is registered as a phase, before the catch-ups', () => {
    const branch = dailyBranch();
    expect(branch).toContain('syncDailyBackfill');
    expect(branch.indexOf('syncDailyBackfill'))
      .toBeLessThan(branch.indexOf('syncPendingShipments'));
    expect(branch.indexOf('syncDailyBackfill'))
      .toBeLessThan(branch.indexOf('syncRecentCompleted'));
  });

  test('the window is wide enough to span a weekend AND a holiday Monday', () => {
    const m = SRC.match(/const BACKFILL_DAYS = parseInt\(process\.env\.SANMAR_BACKFILL_DAYS, 10\) \|\| (\d+)/);
    expect(m).not.toBeNull();
    expect(Number(m[1])).toBeGreaterThanOrEqual(4);   // 3 cannot reach Friday from a holiday Tuesday
  });

  test('it uses the async endpoint and polls, so it cannot H12', () => {
    const fn = SRC.slice(SRC.indexOf('async function syncDailyBackfill'), SRC.indexOf('// Catch-up shipment pull'));
    expect(fn).toMatch(/backfill\?days=/);
    expect(fn).toMatch(/pollBackfillStatus/);
  });

  test('an already-running backfill is skipped, not duplicated or failed', () => {
    const fn = SRC.slice(SRC.indexOf('async function syncDailyBackfill'), SRC.indexOf('// Catch-up shipment pull'));
    expect(fn).toMatch(/status === 409/);
    expect(fn).toMatch(/return;/);
    expect(fn).toMatch(/throw e/);   // any OTHER error still propagates to the phase handler
  });
});
