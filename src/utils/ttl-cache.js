// Shared route-level TTL response cache (2026-07-18, Caspio quota reduction).
//
// Replaces the hand-rolled per-route `new Map()` caches (pattern origin:
// pricing.js pricing-bundle cache). Semantics:
//   - entries stored as { data, timestamp }
//   - LRU-bounded (see below) — a read refreshes an entry's position
//   - an expired entry is NEVER returned (Erik's Rule 4: never serve stale data;
//     on Caspio failure the route must surface the error, not an old payload)
//   - `?refresh=true` bypasses the cache for that request (shouldBypass)
//
// LRU, not FIFO (changed 2026-07-26 after the $358 Caspio overage). Eviction
// used to drop the oldest-INSERTED entry regardless of how hot it was. The PDP
// inserts ~5 product-details entries per view (the related-products fan-out), so
// with maxEntries=100 roughly 20 page views flushed the entire cache — including
// the styles people were actually looking at. Every one of those evictions costs
// a multi-page scan of the 251k-row Sanmar_Bulk table on the next request, and
// Sanmar_Bulk was 26% of all measured Caspio calls. Promoting on read keeps hot
// styles resident and lets the cold one-offs churn instead.
//
// RULE FOR CALLERS (Rule 4 corollary): only cache verified-complete responses.
// If any sub-query degraded (e.g. a `.catch(() => [])` fallback fired), skip
// `set()` so a partial payload is never pinned for a full TTL. The complete-
// response predicate lives in each route, next to the queries it validates.
//
// Caches are per-process (per-dyno). clearAll() / the /product-cache/clear
// route only affect the dyno that serves the request.

const registry = new Map(); // name -> cache instance

function createTtlCache({ name, ttlMs, maxEntries }) {
  if (registry.has(name)) return registry.get(name);

  const store = new Map();

  const cache = {
    name,
    ttlMs,
    maxEntries,

    // Fresh entry -> cached value. Missing OR expired -> undefined (expired
    // entries are deleted on read and never returned).
    get(key) {
      const entry = store.get(key);
      if (!entry) {
        console.log(`[CACHE MISS] ${name} - ${key}`);
        return undefined;
      }
      if (Date.now() - entry.timestamp >= ttlMs) {
        store.delete(key);
        console.log(`[CACHE MISS] ${name} - ${key} (expired)`);
        return undefined;
      }
      // LRU touch: re-insert to move this key to the most-recent end of the Map's
      // insertion order. The stored timestamp is NOT refreshed — a read must
      // never extend an entry's TTL, or a hot key could serve indefinitely stale
      // pricing (Rule 4).
      store.delete(key);
      store.set(key, entry);
      console.log(`[CACHE HIT] ${name} - ${key}`);
      return entry.data;
    },

    set(key, value) {
      // Delete-then-set so an overwrite also counts as "most recently used".
      store.delete(key);
      store.set(key, { data: value, timestamp: Date.now() });
      while (store.size > maxEntries) {
        // Map iteration order is insertion order, so the first key is the
        // least-recently used/inserted one.
        store.delete(store.keys().next().value);
      }
      console.log(`[CACHE SET] ${name} - ${key} - size: ${store.size}`);
    },

    clear() {
      const dropped = store.size;
      store.clear();
      return dropped;
    },

    get size() {
      return store.size;
    }
  };

  registry.set(name, cache);
  return cache;
}

// `?refresh=true` bypass, same contract as pricing-bundle's forceRefresh.
function shouldBypass(req) {
  return !!(req && req.query && req.query.refresh === 'true');
}

// Stable cache key. Callers pass an object literal with a fixed field order
// (JSON.stringify preserves insertion order), fields already normalized
// (sanitized style uppercased, color lowercased, booleans coerced).
function makeKey(obj) {
  return JSON.stringify(obj);
}

// Clears every registered cache; returns { [name]: droppedCount }.
function clearAll() {
  const cleared = {};
  for (const [name, cache] of registry) {
    cleared[name] = cache.clear();
  }
  return cleared;
}

module.exports = { createTtlCache, shouldBypass, makeKey, clearAll };
