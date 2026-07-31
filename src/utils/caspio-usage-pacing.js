// Caspio Integrations-quota pacing maths.
//
// Pure functions — no network, no Caspio, no clock of their own (callers pass
// `now`). Kept separate from the route so the thresholds can be tested without
// standing up a server, and so nobody has to trigger a real Slack DM to check
// the arithmetic.
//
// WHY THIS EXISTS: on 2026-07-26 a $358 overage invoice arrived with no prior
// warning. There was no signal for 30 days — not because someone ignored a
// dashboard, but because nothing ever looked at the number. This module is the
// "look at the number" half; the alert route is the "tell somebody" half.
//
// Caspio's billing period runs the **27th → the 26th** (e.g. 27 Jun–26 Jul was
// billed as "Day 30 of 30"), NOT a calendar month, and its length varies 28–31
// days while the 500,000 cap does not. So the daily budget is
// 500,000 ÷ daysInPeriod, recomputed per period rather than hardcoded at 16,667.

const { accountParts } = require('./account-time');

const MONTHLY_LIMIT = 500000;

// Alert BEFORE the money is spent, not after. At 100% the overage is already
// being billed; 90% leaves a few days to act.
const ALERT_AT_PERCENT = 90;

const PERIOD_START_DAY = 27;

// Dyno-mode only. Extrapolating a daily rate from a few minutes of uptime is
// noise, not a signal: a dyno 8 seconds old with 6 calls projects ~1.3M/period
// (260% of cap) and would fire a false alarm — observed while building this.
// Below this uptime we report `insufficient` and refuse to judge, rather than
// inventing a confident number. Rollup mode is unaffected (it reads real
// per-day history from Caspio and does not care how old this process is).
const MIN_UPTIME_FOR_RATE_MS = 60 * 60 * 1000; // 1 hour

function ymd(date) {
  return date.toISOString().slice(0, 10);
}

/**
 * The Caspio billing window containing `now`.
 *
 * Boundaries are computed on the CASPIO ACCOUNT CLOCK (Pacific), matching how
 * api-tracker keys its days and how Caspio buckets its usage bars — their
 * Integrations log header reads "Log date (UTC-07:00)". This used to run in
 * UTC, which put our period boundary seven hours ahead of theirs and made our
 * daily totals non-comparable with the chart. See utils/account-time.
 *
 * The Date objects below stay UTC-constructed purely as calendar arithmetic on
 * already-Pacific y/m/d values, so `ymd()` round-trips them unchanged.
 *
 * @param {Date} now
 * @returns {{startYmd:string, endYmd:string, daysInPeriod:number, daysElapsed:number}}
 */
function periodWindow(now) {
  const { year: y, month: m, day: d } = accountParts(now);

  // On/after the 27th the current period started this month; before it, last month.
  const start = d >= PERIOD_START_DAY
    ? new Date(Date.UTC(y, m, PERIOD_START_DAY))
    : new Date(Date.UTC(y, m - 1, PERIOD_START_DAY));

  // Ends the day before the next period starts (the 26th of the following month).
  const nextStart = new Date(Date.UTC(
    start.getUTCFullYear(), start.getUTCMonth() + 1, PERIOD_START_DAY
  ));
  const end = new Date(nextStart.getTime() - 86400000);

  const dayMs = 86400000;
  const daysInPeriod = Math.round((nextStart - start) / dayMs);
  const today = new Date(Date.UTC(y, m, d));
  // Day 1 is the 27th itself, matching Caspio's "Day 30 of 30" labelling.
  const daysElapsed = Math.round((today - start) / dayMs) + 1;

  return {
    startYmd: ymd(start),
    endYmd: ymd(end),
    daysInPeriod,
    daysElapsed: Math.min(Math.max(daysElapsed, 1), daysInPeriod)
  };
}

/**
 * Compute pacing for the current period.
 *
 * TWO MODES, and the caller MUST surface which one was used — they are not
 * equally trustworthy:
 *
 *  - `rollup`  — periodToDate summed from the Caspio API_Usage_Daily table
 *                across every dyno. Trustworthy.
 *  - `dyno`    — no rollup table configured, so all we have is this dyno's
 *                in-memory counter since its last restart. Heroku cycles dynos
 *                roughly daily and there may be more than one, so this is a
 *                LOWER BOUND. It still catches a gross overage (if one dyno
 *                alone projects past the cap, that is real), but it cannot see
 *                the aggregate. Never present it as the billed number.
 *
 * @param {object} input
 * @param {Date}   input.now
 * @param {number|null} input.rollupPeriodToDate  summed Call_Count, or null
 * @param {number} input.dynoDailyRate            calls/day observed on this dyno
 * @param {number} input.dynoCallsSinceStart
 * @param {Array<{table:string,count:number}>} [input.topTables]
 */
function computePacing({
  now,
  rollupPeriodToDate = null,
  // How many distinct days in the window actually have rollup rows. This, NOT
  // the summed total, is what says whether the rollup has data — see below.
  rollupDaysWithData = null,
  // { 'YYYY-MM-DD': calls } for the period. Enables a TREND-based projection —
  // see the trailing-rate block below. Optional: without it the old
  // whole-period average is used unchanged.
  rollupByDay = null,
  dynoDailyRate = 0,
  dynoCallsSinceStart = 0,
  dynoUptimeMs = Infinity,
  topTables = []
}) {
  const period = periodWindow(now);
  const budgetPerDay = Math.round(MONTHLY_LIMIT / period.daysInPeriod);

  let mode = rollupPeriodToDate === null ? 'dyno' : 'rollup';
  let insufficientNote = null;

  if (mode === 'dyno' && dynoUptimeMs < MIN_UPTIME_FOR_RATE_MS) {
    mode = 'insufficient';
    insufficientNote =
      'Dyno restarted less than an hour ago — too little history to project a rate. ' +
      'Not judging, and deliberately not alerting. Set API_USAGE_ROLLUP_TABLE for a ' +
      'projection that survives dyno cycling.';
  }

  // An EMPTY rollup table also sums to 0, and 0 renders as "0% of limit — you're
  // fine". That is the same falsy-reads-as-healthy failure that cost $358: the
  // old meter reported 4% while Caspio billed 138%. A live dyno cannot make zero
  // Caspio calls in a period — the rollup writer itself makes them — so "no rows
  // yet" is the only real explanation for an empty window.
  //
  // Discriminate on ROW COUNT, not on the sum. A window that genuinely has rows
  // adding to 0 is still reported as a real 0 (callers that can't supply
  // rollupDaysWithData keep the old behaviour and pass null).
  if (mode === 'rollup' && rollupDaysWithData === 0) {
    mode = 'insufficient';
    insufficientNote =
      'The rollup table is configured but has no rows for this period yet, so there is ' +
      'nothing to project from. Reporting "unknown" rather than 0% — an empty table is ' +
      'not the same as zero usage. It writes hourly; check again within the hour.';
  }

  if (mode === 'insufficient') {
    return {
      mode,
      period,
      budgetPerDay,
      periodToDate: rollupPeriodToDate === null ? dynoCallsSinceStart : rollupPeriodToDate,
      projected: null,
      monthlyLimit: MONTHLY_LIMIT,
      percentOfLimit: null,
      estimatedOverageUsd: 0,
      shouldAlert: false,
      alertAtPercent: ALERT_AT_PERCENT,
      dynoUptimeMs,
      note: insufficientNote,
      topTables: topTables.slice(0, 3)
    };
  }

  let periodToDate;
  let projected;
  let partialCoverage = null;

  if (mode === 'rollup') {
    periodToDate = rollupPeriodToDate;

    // Average over the days that actually HAVE data, not every calendar day
    // elapsed. The rollup can start mid-period (it did — switched on 2026-07-26,
    // day 30 of 30), and dividing one day of calls by 30 elapsed days would
    // under-report the rate ~30x and read as comfortably under budget. Same
    // false-confidence failure as an empty table, just quieter.
    const daysCounted = rollupDaysWithData > 0
      ? Math.min(rollupDaysWithData, period.daysElapsed)
      : period.daysElapsed;

    const avgPerDay = periodToDate / daysCounted;

    // SPENT + TREND, not a whole-period average.
    //
    // The old formula was `avgPerDay * daysInPeriod`, which permanently anchors
    // the projection to however the period STARTED. Measured 2026-07-31: 27-29 Jul
    // cost 23,959 / 22,659 / 20,616 before the quota fixes landed, so the average
    // stayed high enough to project 98% of cap even though the current rate had
    // fallen to ~11-12K/day and the period was really tracking to ~380K. It would
    // have fired EVERY DAY for the rest of the period — and an alarm that always
    // fires is one you learn to ignore, which is exactly the failure it exists to
    // prevent (nobody looked for 30 days before the $358 bill).
    //
    // Instead: money already spent is SUNK (periodToDate, not extrapolated), and
    // only the days that REMAIN are projected, from the recent rate. That makes
    // the number respond to a fix within a day or two instead of being held
    // hostage by the start of the period.
    //
    // Today is excluded from the trend — it is partial, and including it would
    // drag the rate down all morning and read as false comfort.
    const TREND_DAYS = 3;
    const todayYmd = ymd(now);
    let recentRate = null;
    if (rollupByDay && typeof rollupByDay === 'object') {
      const complete = Object.entries(rollupByDay)
        .filter(([d, v]) => d < todayYmd && Number.isFinite(Number(v)))
        .sort((a, b) => (a[0] < b[0] ? 1 : -1))          // newest first
        .slice(0, TREND_DAYS);
      if (complete.length > 0) {
        recentRate = complete.reduce((s, [, v]) => s + Number(v), 0) / complete.length;
      }
    }

    if (recentRate !== null) {
      const daysRemaining = Math.max(0, period.daysInPeriod - period.daysElapsed);
      projected = Math.round(periodToDate + recentRate * daysRemaining);
    } else {
      // No per-day data (older callers, or a period with no complete days yet).
      projected = Math.round(avgPerDay * period.daysInPeriod);
    }

    if (rollupDaysWithData !== null && daysCounted < period.daysElapsed) {
      partialCoverage = {
        daysWithData: daysCounted,
        daysElapsed: period.daysElapsed,
        note: `Rollup covers ${daysCounted} of ${period.daysElapsed} elapsed days. ` +
              `periodToDate is therefore a LOWER BOUND for the period; the projection ` +
              `is extrapolated from the days that do have data.`
      };
    }
  } else {
    // No period history — the best we can say is "if this dyno's current rate
    // held for a whole period". Deliberately NOT multiplied by a guessed dyno
    // count; over-reporting would be its own kind of lie.
    periodToDate = dynoCallsSinceStart;
    projected = Math.round(dynoDailyRate * period.daysInPeriod);
  }

  const percentOfLimit = Math.round((projected / MONTHLY_LIMIT) * 100);
  const overageCalls = Math.max(0, projected - MONTHLY_LIMIT);

  return {
    mode,
    period,
    budgetPerDay,
    periodToDate,
    projected,
    monthlyLimit: MONTHLY_LIMIT,
    percentOfLimit,
    dynoUptimeMs,
    partialCoverage,
    // $0.002/call — 1,000 calls/day over = $60/period.
    estimatedOverageUsd: Math.round(overageCalls * 0.002 * 100) / 100,
    shouldAlert: percentOfLimit >= ALERT_AT_PERCENT,
    alertAtPercent: ALERT_AT_PERCENT,
    topTables: topTables.slice(0, 3)
  };
}

/**
 * Slack mrkdwn body.
 *
 * Names the top tables on purpose: "you are over budget" is not actionable on
 * its own. The single most useful fact in the 2026-07 investigation was
 * "Shopworks_Thumbnail_Report is 24% of the quota" — that is what turns an
 * alert into a fix.
 */
function formatAlert(p) {
  if (p.mode === 'insufficient') {
    // Should never reach Slack (shouldAlert is false), but a forced/manual fire
    // must not print "NaN% of the cap".
    return ':grey_question: *Caspio usage: not enough data to judge* — ' + p.note;
  }
  const pct = p.percentOfLimit;
  const icon = pct >= 100 ? ':rotating_light:' : ':warning:';
  const verdict = pct >= 100
    ? `projected to EXCEED the 500K cap by ~${(p.projected - p.monthlyLimit).toLocaleString()} calls (~$${p.estimatedOverageUsd.toLocaleString()})`
    : `projected to reach ${pct}% of the 500K cap`;

  const lines = [
    `${icon} *Caspio API usage is pacing high* — ${verdict}.`,
    `Period ${p.period.startYmd} → ${p.period.endYmd} (day ${p.period.daysElapsed} of ${p.period.daysInPeriod}).`,
    `So far: *${p.periodToDate.toLocaleString()}* calls · projected *${p.projected.toLocaleString()}* / ${p.monthlyLimit.toLocaleString()} · budget ${p.budgetPerDay.toLocaleString()}/day.`
  ];

  if (p.topTables.length) {
    lines.push('Top tables: ' + p.topTables.map(t => `\`${t.table}\` ${t.count.toLocaleString()}`).join(' · '));
  }

  if (p.mode === 'dyno') {
    lines.push('_Source: one dyno since its last restart — a LOWER BOUND, not the billed total. Set `API_USAGE_ROLLUP_TABLE` for a real period figure._');
  } else {
    lines.push('_Source: API_Usage_Daily rollup, summed across dynos._');
  }

  lines.push('Billed truth: Caspio → Plan and billing → Usage. Attribution: `/dashboards/api-usage.html`.');

  return lines.join('\n');
}

module.exports = {
  MONTHLY_LIMIT,
  ALERT_AT_PERCENT,
  periodWindow,
  computePacing,
  formatAlert
};
