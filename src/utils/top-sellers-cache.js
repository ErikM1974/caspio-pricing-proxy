// Shared row cache for the three curated top-sellers tables (2026-09-06, Caspio
// quota reduction).
//
//   Safety_Stripe_Top_Sellers_2026   15 rows
//   DTG_Top_Sellers_2026            143 rows
//   EMB_Top_Sellers_2026            (same shape)
//
// Measured on the production meter over one 14-hour dyno window: the first two
// tables were read 557 and 456 times. Every route that serves them set a CDN
// `Cache-Control: max-age=300` header and nothing else, and the meter shows the
// header is not absorbing traffic — each request reached Caspio. These are
// Erik-curated lists that change a few times a quarter, so a process-level
// 15-minute cache turns ~1,000 reads a window into a handful.
//
// Semantics (same contract as ttl-cache.js):
//   - keyed on the exact Caspio query (resource + where + orderBy), so a filtered
//     read never serves another filter's rows and Caspio's own comparison
//     semantics are preserved — nothing is re-filtered in memory
//   - an expired entry is never served (Rule 4); on Caspio failure the route keeps
//     its own error handling and returns 502/500 as before
//   - only non-empty reads are pinned: these tables are seeded, so an empty read
//     is suspicious and must not be served for 15 minutes
//   - `?refresh=true` on the route bypasses the cache for that request
//   - registered with ttl-cache's registry, so GET /api/product-cache/clear
//     empties it along with every other route cache on the dyno

const { fetchAllCaspioPages } = require('./caspio');
const { createTtlCache, makeKey } = require('./ttl-cache');

const TOP_SELLER_ROWS_TTL_MS = 15 * 60 * 1000;

const rowsCache = createTtlCache({
  name: 'top-seller-rows',
  ttlMs: TOP_SELLER_ROWS_TTL_MS,
  maxEntries: 60
});

/**
 * Read one of the top-sellers tables through the cache.
 * @param {string} resource  e.g. '/tables/DTG_Top_Sellers_2026/records'
 * @param {object} params    the exact Caspio params the route would have sent
 * @param {{force?: boolean}} opts  force=true skips the cache (still stores the result)
 */
async function readTopSellerRows(resource, params = {}, { force = false } = {}) {
  const key = makeKey({
    resource,
    where: params['q.where'] || '',
    orderBy: params['q.orderBy'] || ''
  });
  if (!force) {
    const hit = rowsCache.get(key);
    if (hit !== undefined) return hit;
  }
  const rows = await fetchAllCaspioPages(resource, params);
  if (Array.isArray(rows) && rows.length > 0) {
    rowsCache.set(key, rows);
  }
  return rows;
}

function clearTopSellerRowsCache() {
  return rowsCache.clear();
}

module.exports = { readTopSellerRows, clearTopSellerRowsCache, TOP_SELLER_ROWS_TTL_MS };
