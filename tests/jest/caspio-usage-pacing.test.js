// Unit tests for the Caspio quota pacing maths (src/utils/caspio-usage-pacing.js).
// Hermetic — pure functions, injected clock, no network, no Slack.
//
// Guards the thing that actually failed on 2026-07-26: a $358 overage arrived
// with no prior warning. These lock the two properties that make the alert
// worth having — it fires BEFORE the money is spent, and it never presents a
// single-dyno lower bound as if it were the billed total.

const {
  MONTHLY_LIMIT,
  ALERT_AT_PERCENT,
  periodWindow,
  computePacing,
  formatAlert
} = require('../../src/utils/caspio-usage-pacing');

// Fixtures below mean CALENDAR DATES, so pin each to midday on the Caspio
// account clock (Pacific), which is what periodWindow uses. A bare
// `T00:00:00Z` fixture is 5 PM the PREVIOUS day in Pacific — the exact
// off-by-one that made our totals non-comparable with Caspio's chart. The
// timezone boundary itself is tested explicitly in account-time.test.js.
const at = (iso) => new Date(`${iso.slice(0, 10)}T19:00:00Z`); // 12:00 PDT

describe('periodWindow — Caspio bills the 27th → the 26th, not calendar months', () => {
  test('mid-period date resolves to the containing 27th→26th window', () => {
    // The invoice we were actually sent: 27 Jun – 26 Jul, "Day 30 of 30".
    const w = periodWindow(at('2026-07-10T12:00:00Z'));
    expect(w.startYmd).toBe('2026-06-27');
    expect(w.endYmd).toBe('2026-07-26');
    expect(w.daysInPeriod).toBe(30);
  });

  test('the 26th is the LAST day of the period, not the first of the next', () => {
    const w = periodWindow(at('2026-07-26T23:00:00Z'));
    expect(w.startYmd).toBe('2026-06-27');
    expect(w.daysElapsed).toBe(30);
    expect(w.daysElapsed).toBe(w.daysInPeriod);
  });

  test('the 27th rolls over into a fresh period on day 1', () => {
    const w = periodWindow(at('2026-07-27T00:30:00Z'));
    expect(w.startYmd).toBe('2026-07-27');
    expect(w.endYmd).toBe('2026-08-26');
    expect(w.daysElapsed).toBe(1);
  });

  test('period LENGTH varies while the 500K cap does not', () => {
    // Jun 27 → Jul 26 is 30 days; Jul 27 → Aug 26 is 31.
    expect(periodWindow(at('2026-07-10T00:00:00Z')).daysInPeriod).toBe(30);
    expect(periodWindow(at('2026-08-10T00:00:00Z')).daysInPeriod).toBe(31);
  });

  test('handles a year boundary', () => {
    const w = periodWindow(at('2027-01-05T00:00:00Z'));
    expect(w.startYmd).toBe('2026-12-27');
    expect(w.endYmd).toBe('2027-01-26');
  });
});

describe('computePacing — rollup mode (trustworthy)', () => {
  const base = { now: at('2026-07-10T00:00:00Z') }; // day 14 of 30

  test('projects the observed average across the full period', () => {
    const p = computePacing({ ...base, rollupPeriodToDate: 140000 });
    expect(p.mode).toBe('rollup');
    expect(p.period.daysElapsed).toBe(14);
    // 140,000 / 14 = 10,000/day × 30 = 300,000
    expect(p.projected).toBe(300000);
    expect(p.percentOfLimit).toBe(60);
    expect(p.shouldAlert).toBe(false);
  });

  test('budget per day is derived from the period length, not hardcoded', () => {
    expect(computePacing({ ...base, rollupPeriodToDate: 0 }).budgetPerDay).toBe(16667); // 500k/30
    expect(computePacing({ now: at('2026-08-10T00:00:00Z'), rollupPeriodToDate: 0 }).budgetPerDay)
      .toBe(16129); // 500k/31
  });

  // The rollup was switched on mid-period (2026-07-26, day 30 of 30). Averaging
  // one day of calls over 30 elapsed days would under-report the rate ~30x and
  // read as comfortably under budget — quieter than the empty-table case, same
  // false confidence.
  test('averages over days WITH data, not every elapsed day', () => {
    // 2 days of rollup data at 23K/day, but 14 calendar days elapsed.
    const p = computePacing({ ...base, rollupPeriodToDate: 46000, rollupDaysWithData: 2 });
    expect(p.projected).toBe(690000);   // 23,000 x 30 — the true pace
    expect(p.shouldAlert).toBe(true);
    // Dividing by daysElapsed instead would give 46,000/14 x 30 = 98,571 (20%),
    // i.e. "you're fine" while actually 138% of cap.
    expect(p.projected).not.toBe(98571);
  });

  test('partial coverage is labelled as a lower bound, not presented as complete', () => {
    const p = computePacing({ ...base, rollupPeriodToDate: 46000, rollupDaysWithData: 2 });
    expect(p.partialCoverage).toMatchObject({ daysWithData: 2, daysElapsed: 14 });
    expect(p.partialCoverage.note).toMatch(/LOWER BOUND/);
  });

  test('full coverage sets no partial-coverage warning', () => {
    const p = computePacing({ ...base, rollupPeriodToDate: 140000, rollupDaysWithData: 14 });
    expect(p.partialCoverage).toBeNull();
    expect(p.projected).toBe(300000);
  });

  test('reproduces the real overage: ~23K/day pace trips the alert', () => {
    // The actual July shape — ~23K/day against a 16,667 budget.
    const p = computePacing({ ...base, rollupPeriodToDate: 14 * 23000 });
    expect(p.projected).toBe(690000);
    expect(p.percentOfLimit).toBe(138);
    expect(p.shouldAlert).toBe(true);
    // 190,000 over × $0.002 = $380, the right order of magnitude for the $358 bill.
    expect(p.estimatedOverageUsd).toBeCloseTo(380, 0);
  });
});

describe('computePacing — the alert fires BEFORE the money is spent', () => {
  const day15 = at('2026-07-11T00:00:00Z'); // day 15 of 30

  test('does not fire while comfortably under', () => {
    const p = computePacing({ now: day15, rollupPeriodToDate: 15 * 14000 }); // 420k projected
    expect(p.percentOfLimit).toBe(84);
    expect(p.shouldAlert).toBe(false);
  });

  test('fires at 90% — with headroom left, not after the overage', () => {
    const p = computePacing({ now: day15, rollupPeriodToDate: 15 * 15000 }); // 450k = 90%
    expect(p.percentOfLimit).toBe(90);
    expect(p.shouldAlert).toBe(true);
    expect(p.projected).toBeLessThan(MONTHLY_LIMIT); // still under the cap when it fires
    expect(ALERT_AT_PERCENT).toBe(90);
  });

  test('still fires once actually over', () => {
    expect(computePacing({ now: day15, rollupPeriodToDate: 15 * 20000 }).shouldAlert).toBe(true);
  });
});

describe('computePacing — dyno fallback mode is honest about being a lower bound', () => {
  const now = at('2026-07-10T00:00:00Z');

  test('null rollup total selects dyno mode', () => {
    const p = computePacing({ now, rollupPeriodToDate: null, dynoDailyRate: 20000, dynoCallsSinceStart: 5000 });
    expect(p.mode).toBe('dyno');
    expect(p.projected).toBe(600000); // 20k/day × 30
    expect(p.shouldAlert).toBe(true);
  });

  test('a ZERO rollup total WITH rows is a real 0, not "no data"', () => {
    // 0 is a legitimate value when days actually reported it.
    const p = computePacing({ now, rollupPeriodToDate: 0, rollupDaysWithData: 5, dynoDailyRate: 20000 });
    expect(p.mode).toBe('rollup');
    expect(p.projected).toBe(0);
  });

  // Caught in production 2026-07-26, minutes after switching the rollup on: the
  // table was empty, summed to 0, and the endpoint reported "0% of limit" —
  // i.e. "you're fine" — which is the exact falsy-reads-as-healthy failure that
  // produced the $358 bill in the first place.
  test('an EMPTY rollup window reports "insufficient", never a reassuring 0%', () => {
    const p = computePacing({ now, rollupPeriodToDate: 0, rollupDaysWithData: 0, dynoDailyRate: 20000 });
    expect(p.mode).toBe('insufficient');
    expect(p.percentOfLimit).toBeNull();
    expect(p.projected).toBeNull();
    expect(p.shouldAlert).toBe(false); // refuse to judge, don't cry wolf either
    expect(p.note).toMatch(/no rows/i);
  });

  test('callers that cannot supply a row count keep the old behaviour', () => {
    const p = computePacing({ now, rollupPeriodToDate: 0, dynoDailyRate: 20000 });
    expect(p.mode).toBe('rollup');
    expect(p.projected).toBe(0);
  });

  test('dyno mode does NOT invent a dyno multiplier', () => {
    // Over-reporting would be its own kind of lie; the message says lower bound.
    const p = computePacing({ now, rollupPeriodToDate: null, dynoDailyRate: 10000 });
    expect(p.projected).toBe(300000);
  });
});

describe('computePacing — a freshly cycled dyno must NOT fire a false alarm', () => {
  const now = at('2026-07-10T00:00:00Z');

  // Observed while building this: a dyno 8 seconds old with 6 tracked calls
  // projected 1,300,661 (260% of cap). The daily scheduler could easily land on
  // a just-restarted dyno, and a false "you're at 260%" is exactly the kind of
  // confidently-wrong number this whole exercise exists to eliminate.
  test('seconds of uptime yields "insufficient", not a 260% projection', () => {
    const p = computePacing({
      now,
      rollupPeriodToDate: null,
      dynoDailyRate: 64800000, // what 6 calls in 8s extrapolates to
      dynoCallsSinceStart: 6,
      dynoUptimeMs: 8000
    });
    expect(p.mode).toBe('insufficient');
    expect(p.projected).toBeNull();
    expect(p.percentOfLimit).toBeNull();
    expect(p.shouldAlert).toBe(false);
    expect(p.note).toMatch(/not judging/i);
  });

  test('past an hour of uptime the rate is trusted again', () => {
    const p = computePacing({
      now,
      rollupPeriodToDate: null,
      dynoDailyRate: 25000,
      dynoUptimeMs: 2 * 60 * 60 * 1000
    });
    expect(p.mode).toBe('dyno');
    expect(p.shouldAlert).toBe(true);
  });

  // Rollup mode reads real per-day history from Caspio, so process age is irrelevant.
  test('rollup mode is unaffected by low dyno uptime', () => {
    const p = computePacing({
      now,
      rollupPeriodToDate: 14 * 23000,
      dynoUptimeMs: 1000
    });
    expect(p.mode).toBe('rollup');
    expect(p.shouldAlert).toBe(true);
  });

  test('a forced fire in insufficient mode never renders NaN%', () => {
    const p = computePacing({ now, rollupPeriodToDate: null, dynoUptimeMs: 5000 });
    const msg = formatAlert(p);
    expect(msg).not.toMatch(/NaN|null|undefined/);
    expect(msg).toMatch(/not enough data/i);
  });
});

describe('formatAlert — actionable, and states its own trustworthiness', () => {
  const pacing = (over) => computePacing({
    now: at('2026-07-10T00:00:00Z'),
    rollupPeriodToDate: 14 * (over ? 23000 : 15000),
    topTables: [
      { table: 'Shopworks_Thumbnail_Report', count: 4000 },
      { table: 'Sanmar_Bulk_251816_Feb2024', count: 3800 },
      { table: 'ORDER_ODBC', count: 900 }
    ]
  });

  test('names the top tables — "you are over" alone is not actionable', () => {
    const msg = formatAlert(pacing(true));
    expect(msg).toContain('Shopworks_Thumbnail_Report');
    expect(msg).toContain('Sanmar_Bulk_251816_Feb2024');
  });

  test('includes the period, the projection and the daily budget', () => {
    const msg = formatAlert(pacing(true));
    expect(msg).toContain('2026-06-27');
    expect(msg).toContain('2026-07-26');
    expect(msg).toContain('day 14 of 30');
    expect(msg).toContain('690,000');
    expect(msg).toContain('16,667/day');
  });

  test('points at Caspio as the billed source of truth, not itself', () => {
    expect(formatAlert(pacing(true))).toMatch(/Plan and billing/i);
  });

  test('dyno mode is explicitly labelled a LOWER BOUND', () => {
    const p = computePacing({
      now: at('2026-07-10T00:00:00Z'),
      rollupPeriodToDate: null,
      dynoDailyRate: 25000
    });
    const msg = formatAlert(p);
    expect(msg).toMatch(/LOWER BOUND/i);
    expect(msg).toContain('API_USAGE_ROLLUP_TABLE');
  });

  test('rollup mode says so instead', () => {
    const msg = formatAlert(pacing(true));
    expect(msg).toContain('API_Usage_Daily rollup');
    expect(msg).not.toMatch(/LOWER BOUND/i);
  });

  test('escalates the icon once actually over the cap', () => {
    expect(formatAlert(pacing(true))).toContain(':rotating_light:');
    expect(formatAlert(pacing(false))).toContain(':warning:');
  });
});

// ---------------------------------------------------------------------------
// Trend-based projection (2026-07-31). The old formula was
// `periodToDate / daysCounted * daysInPeriod` — a whole-period average, which
// anchors the projection to how the period STARTED. 27-29 Jul cost
// 23,959 / 22,659 / 20,616 before the quota fixes landed, so it would have
// projected ~98% of cap every day for the rest of the period even after the
// real rate fell to ~11-12K/day. An alarm that always fires is one you learn to
// ignore — the exact failure it exists to prevent.
describe('projection uses spent + recent trend, not a whole-period average', () => {
  const { computePacing } = require('../../src/utils/caspio-usage-pacing');
  const base = {
    rollupDaysWithData: 5, dynoDailyRate: 20000, dynoCallsSinceStart: 4481,
    dynoUptimeMs: 19176915, topTables: []
  };
  const sum = o => Object.values(o).reduce((a, c) => a + c, 0);

  // A period that started badly and then got fixed.
  const badStart = {
    '2026-07-27': 23959, '2026-07-28': 22659, '2026-07-29': 20616,
    '2026-07-30': 11200, '2026-07-31': 11000
  };

  test('a fixed rate stops projecting an overage — the old average never would', () => {
    const now = new Date('2026-08-01T18:00:00Z');
    const args = { ...base, now, rollupPeriodToDate: sum(badStart), rollupDaysWithData: 5 };

    const oldWay = computePacing(args);                                  // no rollupByDay
    const trend  = computePacing({ ...args, rollupByDay: badStart });

    // Same spend, same day — only the projection method differs.
    expect(trend.projected).toBeLessThan(oldWay.projected);
    expect(trend.shouldAlert).toBe(false);
  });

  test('money already spent is SUNK — never extrapolated', () => {
    const now = new Date('2026-08-01T18:00:00Z');
    const p = computePacing({ ...base, now, rollupPeriodToDate: sum(badStart), rollupByDay: badStart });
    // Projection must be at least what is already spent, and must equal
    // spent + (recent rate x days left) — not spent x some multiple.
    expect(p.projected).toBeGreaterThanOrEqual(p.periodToDate);
  });

  test("today is excluded from the trend — a partial day would read as false comfort", () => {
    const now = new Date('2026-08-01T09:00:00Z');   // early: today has barely any calls
    const withTinyToday = { ...badStart, '2026-08-01': 12 };
    const p = computePacing({
      ...base, now, rollupPeriodToDate: sum(withTinyToday), rollupByDay: withTinyToday
    });
    const withoutToday = computePacing({
      ...base, now, rollupPeriodToDate: sum(withTinyToday), rollupByDay: badStart
    });
    // The 12-call partial day must not drag the projected rate down.
    expect(p.projected).toBe(withoutToday.projected);
  });

  test('falls back to the whole-period average when no per-day data is supplied', () => {
    const now = new Date('2026-08-01T18:00:00Z');
    const p = computePacing({ ...base, now, rollupPeriodToDate: sum(badStart) });
    expect(Number.isFinite(p.projected)).toBe(true);
    expect(p.projected).toBeGreaterThan(0);
  });
});
