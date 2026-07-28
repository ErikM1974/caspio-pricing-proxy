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

// Pricing_Tiers and DTG_Costs are NOT "near-immutable lookup tables" — they hold
// MarginDenominator / LTM_Fee / PrintCost, i.e. the rows Erik edits in Caspio, and
// CLAUDE.md promises those land with no deploy. They get the SAME 15-minute TTL as
// /api/pricing-bundle (src/routes/pricing.js), which reads the same two tables, so
// the DTG route and the pricing-bundle route can never disagree about a price for
// longer than one window. Do not fold these onto STATIC_TABLE_TTL_MS.
const PRICE_TABLE_TTL_MS = 15 * 60 * 1000; // 15 minutes

let upchargeCache = null;   // { rows, timestamp }
let sizeOrderCache = null;  // { rows, timestamp }
let dtgTierCache = null;    // { rows, timestamp }
let dtgCostCache = null;    // { rows, timestamp }

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

// Raw DTG Pricing_Tiers rows. 15-min TTL — see PRICE_TABLE_TTL_MS above.
async function getDtgPricingTierRows({ force = false } = {}) {
  const now = Date.now();
  if (!force && dtgTierCache && (now - dtgTierCache.timestamp) < PRICE_TABLE_TTL_MS) {
    return dtgTierCache.rows;
  }
  const rows = await fetchAllCaspioPages('/tables/Pricing_Tiers/records', {
    'q.where': "DecorationMethod='DTG'",
    'q.select': 'TierLabel,MinQuantity,MaxQuantity,MarginDenominator,TargetMargin,LTM_Fee',
    'q.limit': 100
  });
  if (Array.isArray(rows) && rows.length > 0) {
    dtgTierCache = { rows, timestamp: now };
  }
  return rows;
}

// Raw DTG_Costs rows. 15-min TTL — see PRICE_TABLE_TTL_MS above.
async function getDtgCostRows({ force = false } = {}) {
  const now = Date.now();
  if (!force && dtgCostCache && (now - dtgCostCache.timestamp) < PRICE_TABLE_TTL_MS) {
    return dtgCostCache.rows;
  }
  const rows = await fetchAllCaspioPages('/tables/DTG_Costs/records', {
    'q.select': 'PrintLocationCode,TierLabel,PrintCost',
    'q.limit': 200
  });
  if (Array.isArray(rows) && rows.length > 0) {
    dtgCostCache = { rows, timestamp: now };
  }
  return rows;
}

function clearStaticTableCaches() {
  const cleared = {
    'standard-size-upcharges': upchargeCache ? 1 : 0,
    'size-display-order': sizeOrderCache ? 1 : 0,
    'dtg-pricing-tiers': dtgTierCache ? 1 : 0,
    'dtg-costs': dtgCostCache ? 1 : 0
  };
  upchargeCache = null;
  sizeOrderCache = null;
  dtgTierCache = null;
  dtgCostCache = null;
  return cleared;
}

module.exports = {
  getSizeUpchargeRows,
  getSizeDisplayOrderRows,
  getDtgPricingTierRows,
  getDtgCostRows,
  clearStaticTableCaches
};
