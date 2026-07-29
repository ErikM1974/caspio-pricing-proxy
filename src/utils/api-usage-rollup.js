// Hourly rollup of this dyno's Caspio call count into a Caspio table, so the
// meter survives dyno cycling and multi-dyno splits.
//
// The in-memory tracker (utils/api-tracker.js) resets on every restart and only
// ever sees its own dyno. That is fine for attribution ("which table is hot")
// but useless for "how many calls have we burned this period", which is exactly
// the question the $358 overage on 2026-07-26 raised.
//
// OFF BY DEFAULT. Set API_USAGE_ROLLUP_TABLE to the Caspio table name to enable.
// Deliberately env-gated rather than always-on: without the table this would be
// 24 failing writes/day forever, and a sync that fails quietly is worse than one
// that was never turned on. Status is always reported in /api/admin/metrics, so
// "enabled but broken" is visible rather than silent.
//
// Table shape:
//   Usage_Date   Text(10)   YYYY-MM-DD (UTC)
//   Dyno_Id      Text(64)   Heroku dyno name (web.1, scheduler.1234, local)
//   Call_Count   Integer    the DELTA this write is contributing, not a total
//   Updated_At   Text(32)   ISO timestamp
//
// APPEND-ONLY: every flush INSERTS a row holding only the calls accrued since
// the previous one; readPeriod sums them per day. Many rows per dyno per day is
// expected and correct — do not "fix" it into one cumulative row, which is what
// made concurrent dynos clobber each other and restarts walk the total
// backwards. Rows are cheap; a lost call is not.
//
// Cost: one POST per FLUSH_EVERY_CALLS (250) plus an hourly tick — roughly
// 0.4% overhead, and it buys visibility into ~30% of traffic that was invisible.

const axios = require('axios');
const config = require('../config');
const { getCaspioAccessToken, fetchAllCaspioPages } = require('./caspio');
const tracker = require('./api-tracker');
const { accountDay } = require('./account-time');

const TABLE = process.env.API_USAGE_ROLLUP_TABLE || '';
const DYNO = process.env.DYNO || 'local';
const INTERVAL_MS = 60 * 60 * 1000;

// Flush once this many calls have accrued since the last write.
//
// THE REASON THIS EXISTS: Heroku Scheduler runs jobs as ONE-OFF DYNOS. Those
// processes live for seconds and exit, so a 60-minute setInterval never fires
// and SIGTERM never arrives (they exit normally via process.exit(0)). Result:
// from the day this rollup shipped until 2026-07-28 the table contained rows
// from `web.1` and NOTHING ELSE — every scheduled sync's Caspio calls were
// invisible, ~30% of the account's traffic. Caspio billed 23,959 on 27 Jul
// while the rollup reported 16,055.
//
// A count-based trigger fires regardless of process lifetime. It also caps
// restart loss on the web dyno at this many calls instead of a full hour.
// Cost is one POST per threshold — at 250 that is ~0.4% overhead.
const FLUSH_EVERY_CALLS = 250;

const state = {
  enabled: Boolean(TABLE),
  lastRunAt: null,
  lastOk: null,
  lastError: null,
  consecutiveFailures: 0,
  flushes: 0
};

// How much of THIS process's count has already been written, per UTC day.
const contributed = new Map();
let inFlight = false;
let inFlightPromise = null;
let pending = false;

/**
 * Caspio's per-second burst limit — transient, and NOT a reason to disable the
 * rollup. Only structural failures (missing table, bad shape, bad credentials)
 * should trip the circuit breaker; treating a rate limit as fatal turns a
 * momentary burst into permanently-off metering.
 */
function isRateLimited(err) {
  if (err?.response?.status === 429) return true;
  const body = JSON.stringify(err?.response?.data || '');
  return /api-calls-rate|rate limit/i.test(body);
}

async function pushRollup() {
  // Account clock, matching how Caspio buckets its usage bars and how the
  // tracker keys callsByDay. A UTC key here would look up a day the tracker
  // never wrote.
  const day = accountDay();
  const sinceStart = tracker.stats.callsByDay.get(day) || 0;

  // APPEND-ONLY DELTAS. Each flush inserts a row holding only what has accrued
  // since the last one; readPeriod sums them per day. Three reasons over the
  // previous read-modify-write of a single cumulative row:
  //   1. No read — 1 Caspio call per flush instead of 3.
  //   2. No race. Concurrent scheduler dynos would otherwise read the same
  //      cumulative value and each overwrite the other's contribution. With
  //      hundreds of one-off dynos a day that is a real collision, and every
  //      collision LOSES calls — under-reporting again.
  //   3. Restart-safe by construction: a fresh process has contributed 0 and
  //      simply appends, so nothing can walk the stored total backwards.
  const delta = sinceStart - (contributed.get(day) || 0);
  if (delta <= 0) return;

  const token = await getCaspioAccessToken();
  const url = `${config.caspio.apiBaseUrl}/tables/${TABLE}/records`;
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

  const body = {
    Usage_Date: day,
    Dyno_Id: DYNO,
    Call_Count: delta,
    Updated_At: new Date().toISOString()
  };

  // Caspio's PER-SECOND burst limit is the hard one (the period cap is soft and
  // merely billed). A flush lands right after the work that triggered it, so it
  // is exactly when a burst is most likely — observed 2026-07-28: a read-only
  // script's flush got `api-calls-rate` three times and tripped the breaker.
  // Back off and retry rather than counting a transient limit as a failure.
  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await axios.post(url, body, { headers, timeout: config.timeouts.perRequest, _skipMeter: true });
      lastErr = null;
      break;
    } catch (err) {
      lastErr = err;
      if (!isRateLimited(err)) throw err;      // a real error must surface now
      await new Promise(r => setTimeout(r, 400 * (attempt + 1)));
    }
  }
  if (lastErr) throw lastErr;

  // Only advance the watermark once the write actually landed, so a failed
  // write is retried next tick rather than silently skipped.
  contributed.set(day, sinceStart);
  state.flushes++;

  // Yesterday's watermark is dead weight after a UTC rollover.
  for (const k of contributed.keys()) {
    if (k < day) contributed.delete(k);
  }
}

async function runOnce() {
  if (!state.enabled) return;

  // Overlapping flushes would race, but DROPPING a trigger loses calls: a burst
  // that crosses the threshold twice while the first write is still in flight
  // would leave the second slice unwritten, and a short-lived dyno then exits
  // without ever recording it. So coalesce instead of discard — mark it pending
  // and re-run once the current write lands. pushRollup always reads the CURRENT
  // counter, so one extra pass catches up however far behind it got.
  //
  // Hand back the RUNNING promise, not undefined. `await runOnce()` from
  // flushAndExit used to resolve instantly whenever a flush was already in
  // flight — the exact case it exists for, since the threshold hook fires a
  // flush and the script then exits on top of it. The process died mid-write and
  // reported success, losing up to FLUSH_EVERY_CALLS calls. The do/while below
  // already re-runs while `pending`, so awaiting this one promise covers the
  // deferred pass too.
  if (inFlight) { pending = true; return inFlightPromise; }
  inFlight = true;
  inFlightPromise = doFlush();
  try {
    await inFlightPromise;
  } finally {
    inFlight = false;
    inFlightPromise = null;
  }
}

async function doFlush() {
  state.lastRunAt = new Date().toISOString();
  try {
    do {
      pending = false;
      await pushRollup();
    } while (pending);
    state.lastOk = state.lastRunAt;
    state.lastError = null;
    state.consecutiveFailures = 0;
  } catch (err) {
    state.lastError = err.response?.data
      ? JSON.stringify(err.response.data).slice(0, 300)
      : err.message;

    // A rate limit is a "try later", not "this is broken". Counting it toward
    // the breaker meant one busy second could switch metering off for the rest
    // of the process — observed 2026-07-28. The watermark is untouched either
    // way, so the delta is simply carried into the next flush.
    if (isRateLimited(err)) {
      console.warn(`[API USAGE ROLLUP] rate-limited, deferring: ${state.lastError}`);
      return;
    }

    state.consecutiveFailures++;
    console.error(
      `[API USAGE ROLLUP] write failed (${state.consecutiveFailures} in a row): ${state.lastError}`
    );
    // Stop hammering a table that does not exist / is misshapen. The status stays
    // in /api/admin/metrics so this is visible, not silent.
    if (state.consecutiveFailures >= 3) {
      state.enabled = false;
      console.error(
        `[API USAGE ROLLUP] DISABLED after 3 consecutive failures. ` +
        `Check that Caspio table "${TABLE}" exists with Usage_Date/Dyno_Id/Call_Count/Updated_At.`
      );
    }
  }
  // No `finally { inFlight = false }` here — runOnce owns that flag now, so it
  // stays true for the whole life of this promise and callers coalesce onto it.
}

// How many calls this process has counted but not yet written. Used to make an
// exit-flush timeout say what it actually cost instead of failing silently.
function unflushedCount() {
  const day = accountDay();
  const sinceStart = tracker.stats.callsByDay.get(day) || 0;
  return Math.max(0, sinceStart - (contributed.get(day) || 0));
}

// A short-lived script that ends in process.exit() never reaches `beforeExit`,
// so its tail — everything since the last 250-call flush — was never recorded.
// That is why six of the nine morning cluster jobs showed ZERO in
// API_Usage_Daily on 2026-07-29 while Caspio billed for them.
//
// 10 s, not 3: pushRollup retries a rate limit three times with backoff on top
// of a per-request timeout, and Caspio's per-second limit is most likely to bite
// exactly here, right after the burst of work that triggered the flush.
const EXIT_FLUSH_TIMEOUT_MS = 10000;

async function flushAndExit(code = 0) {
  try {
    const before = unflushedCount();
    let timedOut = false;
    await Promise.race([
      runOnce(),
      new Promise(resolve => {
        const t = setTimeout(() => { timedOut = true; resolve(); }, EXIT_FLUSH_TIMEOUT_MS);
        if (t.unref) t.unref();
      })
    ]);
    if (timedOut) {
      // Loud, with the number. Silently abandoning the tail is the same class of
      // failure as a silent cache fallback: the meter reads low and nothing says why.
      console.error(
        `[API USAGE ROLLUP] exit flush timed out after ${EXIT_FLUSH_TIMEOUT_MS}ms — ` +
        `up to ${before} call(s) unrecorded for ${accountDay()} on ${DYNO}`
      );
    }
  } catch (err) {
    console.error('[API USAGE ROLLUP] exit flush failed:', err.message);
  } finally {
    // ALWAYS exit, with the caller's code. A metering helper must never change
    // whether a job reports success, and must never hang a one-off dyno open —
    // dyno-hours cost money and an overrun can overlap the next scheduled run.
    process.exit(code);
  }
}

let started = false;

// Idempotent: server.js calls this explicitly, and utils/api-tracker auto-calls
// it so scheduler one-off dynos get metering too. Whichever lands first wins.
function start() {
  if (started) return;
  started = true;
  if (!TABLE) {
    console.log('✓ API usage rollup OFF (set API_USAGE_ROLLUP_TABLE to enable)');
    return;
  }
  const timer = setInterval(runOnce, INTERVAL_MS);
  if (timer.unref) timer.unref();

  // THE ONE THAT MAKES SCHEDULER DYNOS VISIBLE. A one-off dyno (every `npm run
  // sync-*` job) lives for seconds: the interval above never fires and SIGTERM
  // never arrives, so before this hook the rollup table held rows from `web.1`
  // and nothing else. Counting calls instead of minutes fires regardless of how
  // long the process lives. Fire-and-forget — metering must never delay or fail
  // the work the process actually exists to do.
  tracker.onCallThreshold(FLUSH_EVERY_CALLS, () => {
    runOnce().catch(() => {});
  });

  // Catches the tail of a short-lived process that ends below the threshold.
  // Only fires when the event loop empties naturally; scripts ending in
  // process.exit(0) skip it, which is why the threshold above is the primary
  // mechanism, not this.
  //
  // ONCE ONLY. `beforeExit` re-fires every time the loop drains, so an async
  // flush inside it re-arms it — three instant retries against Caspio's
  // per-second limit, which is exactly how the breaker got tripped on
  // 2026-07-28.
  let exitFlushed = false;
  process.on('beforeExit', () => {
    if (exitFlushed) return;
    exitFlushed = true;
    runOnce().catch(() => {});
  });

  // Flush on the way down. Heroku SIGTERMs before every dyno cycle (deploy,
  // config change, daily recycle), and on 2026-07-26 that happened four times
  // in one day — without this, up to an hour of calls is lost per restart even
  // with the accumulate fix, because they were never written at all.
  let flushed = false;
  const flush = async () => {
    if (flushed) return;
    flushed = true;
    try {
      await runOnce();
      console.log('[API USAGE ROLLUP] flushed on shutdown');
    } catch (err) {
      console.error('[API USAGE ROLLUP] shutdown flush failed:', err.message);
    }
  };
  process.once('SIGTERM', flush);
  process.once('SIGINT', flush);

  console.log(`✓ API usage rollup ON → Caspio table "${TABLE}" (hourly, dyno ${DYNO})`);
}

/**
 * Sum Call_Count across ALL dynos for a date range — the trustworthy number the
 * pacing alert and the usage dashboard both want.
 *
 * Returns null (not 0) when the rollup isn't configured, so callers can tell
 * "no data source" from "genuinely zero calls" and label their output honestly.
 * A zero here would read as "we're fine", which is the exact failure that cost
 * $358 on 2026-07-26.
 *
 * @param {string} startYmd inclusive, YYYY-MM-DD
 * @param {string} endYmd   inclusive, YYYY-MM-DD
 * @returns {Promise<{total:number, byDay:Object, dynos:string[]}|null>}
 */
async function readPeriod(startYmd, endYmd) {
  if (!TABLE) return null;

  const rows = await fetchAllCaspioPages(
    `/tables/${TABLE}/records`,
    {
      'q.where': `Usage_Date>='${startYmd}' AND Usage_Date<='${endYmd}'`,
      'q.select': 'Usage_Date,Dyno_Id,Call_Count',
      'q.orderBy': 'PK_ID', // stable pagination — unordered multi-page reads drop rows
      'q.pageSize': 1000
    },
    // strict: a truncated read would under-report usage and could suppress an
    // alert. Better to fail the check loudly than to quietly say "you're fine".
    { strict: true }
  );

  const byDay = {};
  const dynos = new Set();
  let total = 0;
  for (const r of rows) {
    const n = Number(r.Call_Count) || 0;
    total += n;
    byDay[r.Usage_Date] = (byDay[r.Usage_Date] || 0) + n;
    if (r.Dyno_Id) dynos.add(r.Dyno_Id);
  }

  return { total, byDay, dynos: [...dynos] };
}

function status() {
  return {
    configured: Boolean(TABLE),
    table: TABLE || null,
    dyno: DYNO,
    active: state.enabled,
    lastRunAt: state.lastRunAt,
    lastSuccessAt: state.lastOk,
    lastError: state.lastError,
    consecutiveFailures: state.consecutiveFailures,
    note: TABLE
      ? (state.enabled ? null : 'DISABLED after repeated write failures — see lastError')
      : 'Not configured; metrics are in-memory per-dyno only and reset on restart.'
  };
}

module.exports = {
  start,
  runOnce,
  status,
  readPeriod,
  flushAndExit,
  unflushedCount,
  isConfigured: () => Boolean(TABLE)
};
