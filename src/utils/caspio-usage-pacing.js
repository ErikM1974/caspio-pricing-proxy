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
 * Dates are handled in UTC to match how api-tracker keys its days
 * (`toISOString().slice(0,10)`). Caspio bills on its own clock, so around the
 * boundary this can be off by a few hours — fine for a pacing alert, which is
 * why Caspio's own usage page stays the source of truth for the billed total.
 *
 * @param {Date} now
 * @returns {{startYmd:string, endYmd:string, daysInPeriod:number, daysElapsed:number}}
 */
function periodWindow(now) {
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  const d = now.getUTCDate();

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
  dynoDailyRate = 0,
  dynoCallsSinceStart = 0,
  dynoUptimeMs = Infinity,
  topTables = []
}) {
  const period = periodWindow(now);
  const budgetPerDay = Math.round(MONTHLY_LIMIT / period.daysInPeriod);

  let mode = rollupPeriodToDate === null ? 'dyno' : 'rollup';
  if (mode === 'dyno' && dynoUptimeMs < MIN_UPTIME_FOR_RATE_MS) {
    mode = 'insufficient';
  }

  if (mode === 'insufficient') {
    return {
      mode,
      period,
      budgetPerDay,
      periodToDate: dynoCallsSinceStart,
      projected: null,
      monthlyLimit: MONTHLY_LIMIT,
      percentOfLimit: null,
      estimatedOverageUsd: 0,
      shouldAlert: false,
      alertAtPercent: ALERT_AT_PERCENT,
      dynoUptimeMs,
      note: 'Dyno restarted less than an hour ago — too little history to project a rate. ' +
            'Not judging, and deliberately not alerting. Set API_USAGE_ROLLUP_TABLE for a ' +
            'projection that survives dyno cycling.',
      topTables: topTables.slice(0, 3)
    };
  }

  let periodToDate;
  let projected;

  if (mode === 'rollup') {
    periodToDate = rollupPeriodToDate;
    // Extrapolate the observed average across the remaining days.
    const avgPerDay = periodToDate / period.daysElapsed;
    projected = Math.round(avgPerDay * period.daysInPeriod);
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
