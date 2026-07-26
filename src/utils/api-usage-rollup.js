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
// Expected table shape (Erik creates this in Caspio):
//   Usage_Date   Text(10)   YYYY-MM-DD (UTC)
//   Dyno_Id      Text(64)   Heroku dyno name; one row per dyno per day
//   Call_Count   Integer
//   Updated_At   Text(32)   ISO timestamp
//
// Cost: one PUT (plus a POST the first time each day) per hour per dyno
// ≈ 24-48 calls/day ≈ 0.01% of the 500K period quota.

const axios = require('axios');
const config = require('../config');
const { getCaspioAccessToken, fetchAllCaspioPages } = require('./caspio');
const tracker = require('./api-tracker');

const TABLE = process.env.API_USAGE_ROLLUP_TABLE || '';
const DYNO = process.env.DYNO || 'local';
const INTERVAL_MS = 60 * 60 * 1000;

const state = {
  enabled: Boolean(TABLE),
  lastRunAt: null,
  lastOk: null,
  lastError: null,
  consecutiveFailures: 0
};

async function pushRollup() {
  const day = new Date().toISOString().slice(0, 10);
  const count = tracker.stats.callsByDay.get(day) || 0;
  if (count === 0) return;

  const token = await getCaspioAccessToken();
  const url = `${config.caspio.apiBaseUrl}/tables/${TABLE}/records`;
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  const where = `Usage_Date='${day}' AND Dyno_Id='${DYNO}'`;
  const body = {
    Usage_Date: day,
    Dyno_Id: DYNO,
    Call_Count: count,
    Updated_At: new Date().toISOString()
  };

  const put = await axios.put(url, body, {
    headers,
    params: { 'q.where': where },
    timeout: config.timeouts.perRequest
  });

  // Caspio answers 200 RecordsAffected:0 when nothing matched — that is a
  // no-op, not a success. Insert the row instead of silently losing the day.
  if ((put.data?.RecordsAffected ?? 0) === 0) {
    await axios.post(url, body, { headers, timeout: config.timeouts.perRequest });
  }
}

async function runOnce() {
  if (!state.enabled) return;
  state.lastRunAt = new Date().toISOString();
  try {
    await pushRollup();
    state.lastOk = state.lastRunAt;
    state.lastError = null;
    state.consecutiveFailures = 0;
  } catch (err) {
    state.consecutiveFailures++;
    state.lastError = err.response?.data
      ? JSON.stringify(err.response.data).slice(0, 300)
      : err.message;
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
}

function start() {
  if (!TABLE) {
    console.log('✓ API usage rollup OFF (set API_USAGE_ROLLUP_TABLE to enable)');
    return;
  }
  const timer = setInterval(runOnce, INTERVAL_MS);
  if (timer.unref) timer.unref();
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

module.exports = { start, runOnce, status, readPeriod, isConfigured: () => Boolean(TABLE) };
