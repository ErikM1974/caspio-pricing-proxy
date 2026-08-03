/**
 * /sync-shipments must keep re-polling a PO until its cartons stop arriving.
 *
 * WHY (2026-08-03, PO 113852 — City of Tukwila)
 * Carton 1 left NV on 7/30 while SanMar still had the order OPEN, so the daily loop pulled
 * it. Carton 2 left VA on 7/31, by which time the order was CLOSED. Every ingest path then
 * declined it:
 *   - daily sync loop  — skips Complete/Canceled                    (sanmar-orders.js :1561)
 *   - /sync-shipments  — skipped any PO that already had a carton   (this fix)
 *   - /sync-recent-completed — only ingests orders we don't hold    (sanmar-orders.js :1833)
 * The carton was invisible to receiving permanently. Confirmed against SanMar's live feed
 * (both cartons present) and the two PSST manifests (Order Status Open -> Closed between them).
 *
 * Sibling PO 113837 survived only by luck: both its cartons shipped the same day, while the
 * order was still open, so one pull got both. That near-miss is why "has a carton" was never
 * a safe proxy for "done".
 */
const fs = require('fs');
const path = require('path');

const SRC = fs.readFileSync(path.join(__dirname, '../../src/routes/sanmar-orders.js'), 'utf8');
const BLOCK = SRC.slice(
  SRC.indexOf("router.post('/sync-shipments'"),
  SRC.indexOf("log.completed = new Date().toISOString();", SRC.indexOf("router.post('/sync-shipments'"))
);

// Mirror of the route's settled/pending logic, so the RULE is tested rather than the prose.
function selectPending(pos, newestShipByPo, todayISO, recheckDays = 10) {
  const cutoff = new Date(Date.parse(todayISO) - recheckDays * 86400000).toISOString().slice(0, 10);
  const has = (p) => Object.prototype.hasOwnProperty.call(newestShipByPo, p);
  const settled = (p) => has(p) && newestShipByPo[p] !== '' && newestShipByPo[p] < cutoff;
  return [...pos.filter(p => !has(p)), ...pos.filter(p => has(p) && !settled(p))];
}

describe('sync-shipments: a PO with one carton is not assumed finished', () => {
  const TODAY = '2026-08-03';

  test('PO 113852 — carton 1 on 7/30 must NOT stop us looking for carton 2', () => {
    const pending = selectPending(['113852'], { '113852': '2026-07-30' }, TODAY);
    expect(pending).toContain('113852');   // the exact regression
  });

  test('a PO with no carton at all is still picked up, and goes FIRST', () => {
    const pending = selectPending(
      ['113852', '113999'],
      { '113852': '2026-07-30' },          // 113999 has nothing
      TODAY
    );
    expect(pending[0]).toBe('113999');     // wholly-invisible POs outrank stragglers
    expect(pending).toContain('113852');
  });

  test('a PO whose last carton is older than the window drops out for good', () => {
    const pending = selectPending(['113700'], { '113700': '2026-07-01' }, TODAY);
    expect(pending).not.toContain('113700');
  });

  test('the window boundary is honoured', () => {
    // 10 days back from 2026-08-03 is 2026-07-24.
    expect(selectPending(['A'], { A: '2026-07-25' }, TODAY)).toContain('A');      // inside
    expect(selectPending(['B'], { B: '2026-07-23' }, TODAY)).not.toContain('B');  // outside
  });

  test('a tracking row with no Ship_Date is never treated as settled', () => {
    // We cannot prove such a PO has gone quiet, so it must keep being polled.
    expect(selectPending(['C'], { C: '' }, TODAY)).toContain('C');
  });
});

describe('sync-shipments: the route implements that rule', () => {
  test('selection is recency-based, not a bare has-tracking skip', () => {
    expect(BLOCK).toMatch(/recheckDays/);
    expect(BLOCK).toMatch(/newestShip/);
    expect(BLOCK).toMatch(/isSettled/);
    // The regression shape: a Set of POs that have any tracking row at all.
    expect(BLOCK).not.toMatch(/withTracking\.has\(/);
  });

  test('it reads Ship_Date — the old query selected only SanMar_PO', () => {
    expect(BLOCK).toMatch(/'q\.select':\s*'SanMar_PO,Ship_Date'/);
  });

  test('zero-carton POs are prioritised ahead of straggler re-polls', () => {
    expect(BLOCK).toMatch(/const pending = \[\.\.\.noTracking, \.\.\.recentlyShipped\]/);
  });

  test('the recheck window is bounded so it cannot become a full-table scan', () => {
    expect(BLOCK).toMatch(/Math\.min\(Math\.max\(parseInt\(req\.query\.recheckDays\)[^)]*\)[^)]*60\)/);
  });

  test('the response distinguishes never-tracked from being-rechecked', () => {
    expect(BLOCK).toMatch(/log\.noTracking/);
    expect(BLOCK).toMatch(/log\.recheckWindow/);
    expect(BLOCK).toMatch(/log\.pendingNoTracking/);   // kept for existing log parsers
  });
});

describe('sync-shipments: rounds must advance, not re-poll the same batch', () => {
  // Caught in production straight after the 2026-08-03 deploy: three consecutive rounds
  // returned an identical batch and `remaining` stuck at 53. Re-polling no longer shrinks
  // `pending`, so the drain loop needs an explicit cursor.
  test('the route slices from an offset, not always from 0', () => {
    expect(BLOCK).toMatch(/const offset = Math\.max\(parseInt\(req\.query\.offset\)/);
    expect(BLOCK).toMatch(/pending\.slice\(offset, offset \+ cap\)/);
    expect(BLOCK).not.toMatch(/pending\.slice\(0, cap\)/);
  });

  test('remaining and nextOffset account for the cursor', () => {
    expect(BLOCK).toMatch(/pending\.length - \(offset \+ batch\.length\)/);
    expect(BLOCK).toMatch(/log\.nextOffset = offset \+ batch\.length/);
  });

  test('re-polls are ordered oldest-carton-first, so they get a last chance before ageing out', () => {
    expect(BLOCK).toMatch(/\.sort\(\(a, b\) =>[\s\S]*newestShip\.get\(a\)/);
  });

  test('the scheduler walks the cursor across its rounds', () => {
    const fs2 = require('fs'), path2 = require('path');
    const JOB = fs2.readFileSync(path2.join(__dirname, '../../scripts/sync-sanmar.js'), 'utf8');
    const fn = JOB.slice(JOB.indexOf('async function syncPendingShipments'), JOB.indexOf('// Recently-completed catch-up'));
    expect(fn).toMatch(/offset=\$\{offset\}/);
    expect(fn).toMatch(/offset = typeof r\.nextOffset === 'number'/);
  });
});
