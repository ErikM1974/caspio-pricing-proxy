// ============================================================================
// style-search-index.js — in-memory text-search index over distinct styles.
//
// WHY: /api/products/search?q= used to run five LIKE '%term%' scans (title,
// description, keywords, style, brand) + a groupBy against the 181k-row
// Sanmar_Bulk table PER QUERY. Every never-before-seen term cost 10-22
// SECONDS (measured live 2026-08-25: "hoodie" 21s, "polo" 16s, "tshirt" 18s),
// and the nav autocomplete fires one uncached term per keystroke — so real
// customers effectively never saw search results. The whole catalog is only
// ~4.5k distinct styles: fetch them once, search them in memory (~2ms), and
// hand the route an exact STYLE IN (...) list instead of the LIKE scan.
//
// Semantics parity with the old LIKE clause, by design:
//   - the query is ONE case-insensitive substring (phrase) match, against
//     style + title + brand + keywords + description — same five fields;
//   - status filtering stays in the ROUTE's WHERE (the index holds every
//     style, discontinued included, so ?status=... keeps working unchanged).
//
// The only deliberate difference: results are RANKED (exact style, style
// prefix, title, brand, then keyword/description hits) and capped at
// MAX_MATCHES before the IN() — the old path's thousands-of-rows result for
// a broad term was unusable anyway, and Caspio WHERE clauses have URL limits.
// ============================================================================

'use strict';

const TTL_MS = 30 * 60 * 1000;   // refresh the style list every 30 min
const MAX_MATCHES = 300;         // cap handed to STYLE IN (...) — URL-length safe

// Grouped fetch params — one row per (style × title × brand × category ×
// keywords × description) combination; dedupeRows() collapses to one entry
// per STYLE. NO status filter here: the route's own WHERE applies it, so
// ?status=all / ?status=New behave exactly as before.
const FETCH_PARAMS = {
  // IsTopSeller rides along (style-level, so it never splits styles — same
  // reasoning as products.js's phase-1) so the Top Sellers LISTING can hand
  // Caspio STYLE IN (...) instead of scanning 181k rows for IsTopSeller=1
  // (measured 10-15s cold; customers saw skeletons + late images).
  'q.select': 'STYLE, PRODUCT_TITLE, BRAND_NAME, KEYWORDS, PRODUCT_DESCRIPTION, IsTopSeller',
  'q.groupBy': 'STYLE, PRODUCT_TITLE, BRAND_NAME, KEYWORDS, PRODUCT_DESCRIPTION, IsTopSeller',
  // Stable orderBy is REQUIRED on any >1-page Caspio query — without it,
  // pagination skips/duplicates rows silently (~420 styles vanished on the
  // first run; same trap documented at products.js Phase-2).
  'q.orderBy': 'STYLE',
};

/** Collapse grouped rows to one index entry per STYLE (a style can group
 *  into several rows when keywords/description vary across its variants —
 *  concatenate so no searchable text is lost). Pure, for tests. */
function buildIndex(rows) {
  const byStyle = new Map();
  for (const r of rows || []) {
    const style = String(r.STYLE || '').trim();
    if (!style) continue;
    const chunk = `${r.PRODUCT_TITLE || ''} ${r.BRAND_NAME || ''} ${r.KEYWORDS || ''} ${r.PRODUCT_DESCRIPTION || ''}`;
    const cur = byStyle.get(style);
    if (cur) {
      cur.hay += ' ' + chunk.toLowerCase();
      cur.top = cur.top || !!r.IsTopSeller; // OR across rows: any flagged row marks the style
    } else {
      byStyle.set(style, {
        style,
        styleLower: style.toLowerCase(),
        titleLower: String(r.PRODUCT_TITLE || '').toLowerCase(),
        brandLower: String(r.BRAND_NAME || '').toLowerCase(),
        hay: chunk.toLowerCase(),
        top: !!r.IsTopSeller,
      });
    }
  }
  return [...byStyle.values()];
}

/** Style numbers flagged IsTopSeller in the index — lets the Top Sellers
 *  LISTING narrow its Caspio WHERE to STYLE IN (...). Membership can lag a
 *  flag flip by up to the index TTL (30 min); every price/field in the
 *  response still comes live from Caspio (Rule 4 untouched). Pure. */
function topSellerStyles(index) {
  return (index || []).filter(e => e.top).map(e => e.style);
}

/** Case-insensitive phrase match (parity with LIKE '%q%'), ranked:
 *  0 exact style · 1 style prefix · 2 style substring · 3 title · 4 brand ·
 *  5 keywords/description. Returns up to MAX_MATCHES style numbers. Pure. */
function searchIndex(index, q) {
  const needle = String(q || '').trim().toLowerCase();
  if (!needle) return [];
  const scored = [];
  for (const e of index) {
    let score = null;
    if (e.styleLower === needle) score = 0;
    else if (e.styleLower.startsWith(needle)) score = 1;
    else if (e.styleLower.includes(needle)) score = 2;
    else if (e.titleLower.includes(needle)) score = 3;
    else if (e.brandLower.includes(needle)) score = 4;
    else if (e.hay.includes(needle)) score = 5;
    if (score !== null) scored.push({ style: e.style, score });
  }
  scored.sort((a, b) => a.score - b.score || (a.style < b.style ? -1 : 1));
  return scored.slice(0, MAX_MATCHES).map(s => s.style);
}

// ── Cached accessor (stale-while-revalidate) ────────────────────────────────
// First call after boot/TTL pays the ~5-10s grouped fetch ONCE; while a
// refresh is in flight, searches keep answering from the stale copy — a
// customer never waits on the rebuild.
let _cache = { at: 0, index: null, building: null };

async function getStyleSearchIndex(fetchAllCaspioPages) {
  const fresh = _cache.index && (Date.now() - _cache.at) < TTL_MS;
  if (fresh) return _cache.index;
  if (!_cache.building) {
    // strict:true — a silently-truncated fetch would build a PARTIAL index
    // and quietly hide real products from search (caught on first local run:
    // 4,095 of 4,513 styles). Better to throw, keep the stale copy, retry.
    _cache.building = fetchAllCaspioPages('/tables/Sanmar_Bulk_251816_Feb2024/records',
      { ...FETCH_PARAMS, 'q.limit': 1000 }, { maxPages: 60, strict: true })
      .then((rows) => {
        _cache = { at: Date.now(), index: buildIndex(rows), building: null };
        console.log(`[style-search-index] built: ${_cache.index.length} styles from ${rows.length} grouped rows`);
        return _cache.index;
      })
      .catch((e) => {
        _cache.building = null;
        console.error('[style-search-index] build failed:', e.message);
        throw e;
      });
  }
  // stale copy available → serve it now, let the rebuild land in background
  if (_cache.index) return _cache.index;
  return _cache.building;
}

/** Warm the index shortly after boot so no customer ever pays the ~40s
 *  build (first search after a Heroku dyno restart would otherwise).
 *  Same pattern + jitter as design-search-index.warmOnBoot: misses the
 *  bandit sync windows; one retry after 60s absorbs a transient 429. */
function warmOnBoot(fetchAllCaspioPages) {
  if (process.env.JEST_WORKER_ID || process.env.STYLE_SEARCH_WARM === 'off') return null;
  const delay = 20000 + Math.floor(Math.random() * 40000);
  const timer = setTimeout(() => {
    getStyleSearchIndex(fetchAllCaspioPages).catch(() => {
      setTimeout(() => getStyleSearchIndex(fetchAllCaspioPages).catch(() => { }), 60000).unref();
    });
  }, delay);
  timer.unref();
  console.log(`[style-search-index] Boot warm scheduled in ${Math.round(delay / 1000)}s`);
  return timer;
}

/** Test hook — never used by the route. */
function _resetCacheForTests() { _cache = { at: 0, index: null, building: null }; }

module.exports = { buildIndex, searchIndex, topSellerStyles, getStyleSearchIndex, warmOnBoot, MAX_MATCHES, _resetCacheForTests };
