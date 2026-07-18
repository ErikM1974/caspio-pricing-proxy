// Process-wide caches for the two tiny, near-immutable lookup tables that were
// being re-fetched from Caspio in full on every pricing/size request
// (2026-07-18 Caspio quota reduction). 1 h TTL, precedent: decoration-methods'
// 1 h cache.
//
// Failure semantics: on a cold cache a Caspio failure THROWS — each caller
// keeps its own existing handling (size-pricing 500s, max-prices degrades to
// {}, pricing-bundle/getStyleSizeRun degrade to []), so behavior is unchanged.
// Only non-empty result sets are cached: these tables are seeded, so an empty
// read is suspicious — return it, but don't pin it for an hour.

const { fetchAllCaspioPages } = require('./caspio');

const STATIC_TABLE_TTL_MS = 60 * 60 * 1000; // 1 hour

let upchargeCache = null;   // { rows, timestamp }
let sizeOrderCache = null;  // { rows, timestamp }

// Raw Standard_Size_Upcharges rows ({ SizeDesignation, StandardAddOnAmount }).
// Raw rows, not a map — callers build different map shapes from them.
async function getSizeUpchargeRows({ force = false } = {}) {
  const now = Date.now();
  if (!force && upchargeCache && (now - upchargeCache.timestamp) < STATIC_TABLE_TTL_MS) {
    return upchargeCache.rows;
  }
  const rows = await fetchAllCaspioPages('/tables/Standard_Size_Upcharges/records', {
    'q.select': 'SizeDesignation,StandardAddOnAmount',
    'q.orderby': 'SizeDesignation ASC',
    'q.limit': 200
  });
  if (Array.isArray(rows) && rows.length > 0) {
    upchargeCache = { rows, timestamp: now };
  }
  return rows;
}

// Raw Size_Display_Order rows ({ size, sort_order }).
async function getSizeDisplayOrderRows({ force = false } = {}) {
  const now = Date.now();
  if (!force && sizeOrderCache && (now - sizeOrderCache.timestamp) < STATIC_TABLE_TTL_MS) {
    return sizeOrderCache.rows;
  }
  const rows = await fetchAllCaspioPages('/tables/Size_Display_Order/records', {
    'q.select': 'size,sort_order',
    'q.limit': 200
  });
  if (Array.isArray(rows) && rows.length > 0) {
    sizeOrderCache = { rows, timestamp: now };
  }
  return rows;
}

function clearStaticTableCaches() {
  const cleared = {
    'standard-size-upcharges': upchargeCache ? 1 : 0,
    'size-display-order': sizeOrderCache ? 1 : 0
  };
  upchargeCache = null;
  sizeOrderCache = null;
  return cleared;
}

module.exports = { getSizeUpchargeRows, getSizeDisplayOrderRows, clearStaticTableCaches };
