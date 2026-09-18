/**
 * Shared response cache for GET /api/quote_sessions.
 *
 * WHY THIS IS A MODULE AND NOT A LOCAL IN routes/quotes.js
 * --------------------------------------------------------
 * The GET caches list reads per-filter for 5 minutes. That means ANY write to
 * Quote_Sessions leaves every already-cached filter serving the PRE-write
 * answer until the TTL expires — a quiet wrong answer (Rule 4), not a slow one.
 * Writes happen in four files (routes/quotes.js POST/PUT/DELETE and the three
 * ShopWorks push routes), so the invalidator has to be reachable from all of
 * them or the rule only half-holds.
 *
 * The bug that forced this (2026-09-17, reported by Taneisha):
 *   1. Opening a lead in the Leads workspace auto-runs the
 *      `CustomerEmail='…'` lookup, which caches the EMPTY result.
 *   2. The rep clicks through to a builder, saves a quote for that lead (POST).
 *   3. Back on the lead, "check again" re-reads the SAME cache key and still
 *      says "No quotes for … yet" — for up to 5 more minutes.
 * Only DELETE invalidated, so create and update were both silently stale.
 *
 * Rule: if you write to Quote_Sessions, call invalidate() on the way out.
 */

const cache = new Map();
const TTL_MS = 5 * 60 * 1000; // 5 minutes
const MAX_ENTRIES = 100;

/** Cached rows for `key`, or null when absent/expired. */
function get(key) {
  const hit = cache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.timestamp >= TTL_MS) {
    cache.delete(key);
    return null;
  }
  return hit.data;
}

/** Cache `rows` under `key`, evicting oldest-first past MAX_ENTRIES. */
function set(key, rows) {
  cache.set(key, { data: rows, timestamp: Date.now() });
  if (cache.size > MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    cache.delete(oldest);
  }
}

/**
 * Drop every cached read. Called by EVERY Quote_Sessions writer.
 * `reason` is logged so a stale-read report can be traced in the dyno log.
 */
function invalidate(reason) {
  if (cache.size === 0) return;
  console.log(`Quote sessions cache cleared (${cache.size} key(s)) — ${reason}`);
  cache.clear();
}

module.exports = { get, set, invalidate, TTL_MS };
