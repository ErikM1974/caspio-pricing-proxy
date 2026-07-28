// Caspio API call tracker — the meter behind GET /api/admin/metrics.
//
// Counts every HTTP request this dyno sends to Caspio, so we can attribute the
// 500K/period Integrations Calls quota to a table and catch a regression before
// the invoice does.
//
// HOW IT COUNTS (rewritten 2026-07-26 after a $358 overage the old meter missed):
// a global axios request interceptor fires on EVERY request whose host is
// *.caspio.com. That is the only counting path — `makeCaspioRequest` /
// `fetchAllCaspioPages` deliberately do NOT call trackCall themselves anymore.
//
// Why the interceptor and not per-helper calls: the old meter instrumented only
// those two helpers, so it never saw the ~236 direct-axios call sites across 41
// route files (every POST/PUT/DELETE), `putWithRecordsAffected`, or any of the
// four independent token caches. It reported ~4% of limit while Caspio billed
// 138%. An interceptor cannot be bypassed by a new route that reaches for axios
// directly, which is what kept happening.
//
// Counting at REQUEST time (not on a successful response) is also deliberate:
// Caspio bills the call even when it answers 400/429, and the 400-retry path in
// caspio.js issues a second real request. Both now show up.
//
// CAVEATS the numbers carry — read them before trusting a reading:
//  - In-memory and PER-DYNO. Restart resets it; >1 web dyno means /api/admin/metrics
//    reports only whichever dyno served your request. Compare `processUptimeMs`
//    against the window you think you're measuring.
//  - `callsByTable` / `callsByEndpoint` are cumulative SINCE PROCESS START.
//    `todayCount` / `last24hCount` / `callsByDay` are windowed. Never multiply a
//    cumulative share by a windowed total.
//  - Days key off UTC, while Caspio's billing period is its own window
//    (e.g. 27 Jun–26 Jul). Use these for attribution; use Caspio's own usage page
//    for "are we under the cap".

const { accountDay, accountHour } = require('./account-time');

const CASPIO_HOST = /(^|\.)caspio\.com$/i;

// Non-table Caspio surfaces get a stable synthetic label so they still show up
// in the breakdown instead of being lumped under a meaningless path.
const LABEL_TOKEN = '__oauth_token__';
const LABEL_FILES = '__files__';
const LABEL_UNKNOWN = '__unknown__';

/**
 * Derive { endpoint, table } from a Caspio URL.
 *
 * The old implementation was `path.split('/').pop().replace('/records','')`,
 * which returns the literal string "records" for every /tables/X/records URL —
 * so the entire breakdown collapsed to one row labelled "records" and the
 * per-table attribution the runbook told you to read never worked.
 */
function deriveTarget(rawUrl) {
  let pathname;
  try {
    pathname = new URL(rawUrl).pathname;
  } catch {
    pathname = String(rawUrl || '');
  }

  const segments = pathname.split('/').filter(Boolean);

  // /oauth/token
  if (segments.includes('oauth')) {
    return { endpoint: '/oauth/token', table: LABEL_TOKEN };
  }

  // Strip the REST prefix: integrations/rest/v3/... or rest/v2/...
  const restIdx = segments.indexOf('rest');
  const tail = restIdx === -1 ? segments : segments.slice(restIdx + 2); // drop "rest" + version

  // /tables/{name}/records, /views/{name}/records
  for (const kind of ['tables', 'views']) {
    const i = tail.indexOf(kind);
    if (i !== -1 && tail[i + 1]) {
      const name = tail[i + 1];
      return {
        endpoint: `/${kind}/${name}/${tail.slice(i + 2).join('/') || 'records'}`,
        table: kind === 'views' ? `view:${name}` : name
      };
    }
  }

  if (tail.includes('files')) {
    return { endpoint: `/${tail.join('/')}`, table: LABEL_FILES };
  }

  if (tail.length === 0) return { endpoint: pathname || '/', table: LABEL_UNKNOWN };
  return { endpoint: `/${tail.join('/')}`, table: tail[0] };
}

function isCaspioUrl(rawUrl) {
  try {
    return CASPIO_HOST.test(new URL(rawUrl).hostname);
  } catch {
    return false;
  }
}

class APITracker {
  constructor() {
    this.startedAt = Date.now();
    this.calls = [];
    this.stats = {
      totalCalls: 0,
      callsByEndpoint: new Map(),
      callsByTable: new Map(),
      callsByMethod: new Map(),
      callsByHour: new Map(),
      callsByDay: new Map()
    };

    // Cleanup + a single summary log line every 5 minutes. The old code logged
    // one line PER CALL (~16K+ lines/day), which buried everything else in the
    // Heroku log and cost more to read than it was worth.
    this._cleanupTimer = setInterval(() => {
      this.cleanup();
      this.logSummary();
    }, 5 * 60 * 1000);
    if (this._cleanupTimer.unref) this._cleanupTimer.unref();
  }

  /**
   * Track a single Caspio API call.
   * Called by the axios interceptor; not meant to be called directly.
   */
  trackCall(endpoint, table, method = 'GET', metadata = {}) {
    const timestamp = Date.now();

    this.calls.push({ timestamp, endpoint, table, method, ...metadata });
    this.stats.totalCalls++;

    const bump = (map, key) => map.set(key, (map.get(key) || 0) + 1);
    bump(this.stats.callsByEndpoint, endpoint);
    bump(this.stats.callsByTable, table);
    bump(this.stats.callsByMethod, method);
    // Keyed on the CASPIO ACCOUNT CLOCK (Pacific), not UTC — see utils/account-time.
    // Caspio's usage bars bucket on the account timezone, so a UTC key made our
    // daily total non-comparable with the number on their chart. The rollup looks
    // days up by this exact key, so the two must not diverge.
    bump(this.stats.callsByHour, accountHour(new Date(timestamp)));  // YYYY-MM-DDTHH
    bump(this.stats.callsByDay, accountDay(new Date(timestamp)));    // YYYY-MM-DD

    // Count-based flush trigger (see utils/api-usage-rollup.js). A Heroku
    // Scheduler one-off dyno lives for seconds, so a time-based flush never
    // fires and its calls were never recorded. Counting calls works regardless
    // of process lifetime.
    if (this._thresholdFn && ++this._sinceThreshold >= this._thresholdAt) {
      this._sinceThreshold = 0;
      try {
        this._thresholdFn();
      } catch (err) {
        console.error('[API TRACKER] threshold hook failed:', err.message);
      }
    }
  }

  /**
   * Call `fn` every `n` tracked calls. One hook only — the rollup owns it.
   * The hook must not throw and must not block; metering never delays real work.
   */
  onCallThreshold(n, fn) {
    this._thresholdAt = n;
    this._thresholdFn = fn;
    this._sinceThreshold = 0;
  }

  getTodayCount() {
    return this.stats.callsByDay.get(accountDay()) || 0;
  }

  get24HourCount() {
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    return this.calls.filter(call => call.timestamp > cutoff).length;
  }

  /**
   * Projected calls per 30-day period at the current pace.
   *
   * Extrapolates from the last 24h when the process has actually been up that
   * long; otherwise scales the observed uptime up to a full day, so a freshly
   * cycled dyno doesn't report a reassuring near-zero projection.
   */
  getMonthlyProjection() {
    const uptimeMs = Date.now() - this.startedAt;
    const dayMs = 24 * 60 * 60 * 1000;
    const dailyRate = uptimeMs >= dayMs
      ? this.get24HourCount()
      : (this.stats.totalCalls / Math.max(uptimeMs, 1)) * dayMs;
    return Math.round(dailyRate * 30);
  }

  _sortedEntries(map, limit) {
    const rows = Array.from(map.entries())
      .map(([key, count]) => ({ key, count }))
      .sort((a, b) => b.count - a.count);
    return limit ? rows.slice(0, limit) : rows;
  }

  getTopEndpoints(limit = 10) {
    return this._sortedEntries(this.stats.callsByEndpoint, limit)
      .map(({ key, count }) => ({ endpoint: key, count }));
  }

  getTopTables(limit = 10) {
    return this._sortedEntries(this.stats.callsByTable, limit)
      .map(({ key, count }) => ({ table: key, count }));
  }

  /**
   * Summary metrics.
   * @param {object} [opts]
   * @param {boolean} [opts.full] include the COMPLETE per-table/per-endpoint
   *   breakdown instead of a top-5. The top-5 was the whole diagnostic surface
   *   before 2026-07-26, which is not enough to find a regression.
   */
  getSummary(opts = {}) {
    const monthlyProjection = this.getMonthlyProjection();
    const monthlyLimit = 500000;
    const percentOfLimit = Math.round((monthlyProjection / monthlyLimit) * 100);
    const uptimeMs = Date.now() - this.startedAt;

    const summary = {
      todayCount: this.getTodayCount(),
      last24hCount: this.get24HourCount(),
      totalCallsSinceStart: this.stats.totalCalls,
      processUptimeMs: uptimeMs,
      processUptimeHours: Math.round((uptimeMs / 3600000) * 10) / 10,
      callsPerHourSinceStart: uptimeMs > 0
        ? Math.round(this.stats.totalCalls / (uptimeMs / 3600000))
        : 0,
      monthlyProjection,
      monthlyLimit,
      percentOfLimit,
      status: percentOfLimit > 100 ? 'OVER_LIMIT'
        : percentOfLimit > 90 ? 'CRITICAL'
        : percentOfLimit > 80 ? 'WARNING' : 'OK',
      topEndpoints: this.getTopEndpoints(5),
      topTables: this.getTopTables(5),
      // Both maps are cumulative since process start — see the header caveats.
      scope: 'single dyno, since process start; callsByDay/last24h are windowed'
    };

    if (opts.full) {
      summary.callsByTable = this.getTopTables(0);
      summary.callsByEndpoint = this.getTopEndpoints(0);
      summary.callsByMethod = Object.fromEntries(this.stats.callsByMethod);
      summary.callsByDay = Object.fromEntries(
        Array.from(this.stats.callsByDay.entries()).sort()
      );
      summary.callsByHour = Object.fromEntries(
        Array.from(this.stats.callsByHour.entries()).sort()
      );
    }

    return summary;
  }

  logSummary() {
    if (this.stats.totalCalls === 0) return;
    const top = this.getTopTables(3).map(t => `${t.table}=${t.count}`).join(' ');
    console.log(
      `[API TRACKER] ${this.stats.totalCalls} Caspio calls in ` +
      `${Math.round((Date.now() - this.startedAt) / 60000)}m ` +
      `(~${this.getSummary().callsPerHourSinceStart}/hr) | top: ${top}`
    );
  }

  cleanup() {
    const now = Date.now();

    const before = this.calls.length;
    this.calls = this.calls.filter(call => call.timestamp > now - 24 * 60 * 60 * 1000);
    if (before > this.calls.length) {
      console.log(`[API TRACKER] pruned ${before - this.calls.length} entries older than 24h`);
    }

    // Cutoffs must use the SAME key scheme as the maps, or the string compare
    // prunes the wrong buckets.
    const hourCutoff = accountHour(new Date(now - 48 * 60 * 60 * 1000));
    for (const [hour] of this.stats.callsByHour) {
      if (hour < hourCutoff) this.stats.callsByHour.delete(hour);
    }

    const dayCutoff = accountDay(new Date(now - 30 * 24 * 60 * 60 * 1000));
    for (const [day] of this.stats.callsByDay) {
      if (day < dayCutoff) this.stats.callsByDay.delete(day);
    }

    // Bound cardinality on the cumulative maps. Table names are naturally few,
    // but endpoint keys can drift, and these two used to grow forever.
    this._boundMap(this.stats.callsByEndpoint, 1000);
    this._boundMap(this.stats.callsByTable, 500);
  }

  _boundMap(map, maxEntries) {
    if (map.size <= maxEntries) return;
    const keep = new Map(this._sortedEntries(map, maxEntries).map(r => [r.key, r.count]));
    map.clear();
    for (const [k, v] of keep) map.set(k, v);
  }

  reset() {
    this.startedAt = Date.now();
    this.calls = [];
    this.stats = {
      totalCalls: 0,
      callsByEndpoint: new Map(),
      callsByTable: new Map(),
      callsByMethod: new Map(),
      callsByHour: new Map(),
      callsByDay: new Map()
    };
    console.log('[API TRACKER] Stats reset');
  }
}

const tracker = new APITracker();

// ---------------------------------------------------------------------------
// Global axios interceptor — the single counting path.
//
// Safe to attach to the default axios instance: the only axios.create() clients
// in this repo are Mailchimp and ManageOrders, neither of which talks to Caspio
// (and instance interceptors are independent of these anyway). If a future
// client is created with axios.create() AND targets Caspio, it must call
// installOn(instance) or its calls will be invisible here.
// ---------------------------------------------------------------------------
function installOn(instance) {
  instance.interceptors.request.use(cfg => {
    try {
      const url = cfg.baseURL && cfg.url && !/^https?:\/\//i.test(cfg.url)
        ? new URL(cfg.url, cfg.baseURL).toString()
        : cfg.url;

      // `_skipMeter` excludes the rollup's OWN writes. Counting them creates a
      // FEEDBACK LOOP: a flush POSTs, the interceptor counts that POST, which
      // leaves a fresh non-zero delta, which triggers another flush. On
      // 2026-07-28 that ran away and wrote ~1,893 junk rows before Caspio's
      // per-second limit stopped it. Metering overhead is not application
      // traffic and must never be able to trigger more metering.
      if (url && isCaspioUrl(url) && !cfg._skipMeter) {
        const { endpoint, table } = deriveTarget(url);
        tracker.trackCall(endpoint, table, (cfg.method || 'get').toUpperCase());
      }
    } catch (err) {
      // Never let metering break a real request.
      console.error('[API TRACKER] interceptor error (request still sent):', err.message);
    }
    return cfg;
  });
  return instance;
}

installOn(require('axios'));

// Auto-start the rollup in EVERY process that talks to Caspio — not just the
// web dyno. Heroku Scheduler jobs are one-off dynos that never load server.js,
// so before this the rollup was never started there and their calls went
// unrecorded: the table held `web.1` rows and nothing else, hiding ~30% of the
// account's traffic.
//
// Deferred with setImmediate because api-usage-rollup requires utils/caspio,
// which requires THIS module — running it inline would hit a half-initialised
// require graph. By the next tick everything is resolved. start() is idempotent,
// so server.js calling it explicitly is harmless.
setImmediate(() => {
  try {
    require('./api-usage-rollup').start();
  } catch (err) {
    console.error('[API TRACKER] rollup auto-start failed:', err.message);
  }
});

tracker.installOn = installOn;
tracker.deriveTarget = deriveTarget;
tracker.isCaspioUrl = isCaspioUrl;

module.exports = tracker;
