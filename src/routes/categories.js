// Catalog Categories API
// GET /api/categories — live category list with product counts for the customer
// catalog nav / mega-menu, so the frontend taxonomy stops being hardcoded
// (a stale hardcoded category list caused the "hoodies → 0 results" production bug).
//
// Counts mirror how /api/products/search builds facets.categories: one row per unique
// STYLE × CATEGORY_NAME of Active products in Sanmar_Bulk. Cached ~1 hour.

const express = require('express');
const router = express.Router();
const { fetchAllCaspioPages } = require('../utils/caspio');

const CATEGORIES_CACHE_TTL = 60 * 60 * 1000; // 1 hour
let categoriesCache = null; // { data, timestamp }

/**
 * Aggregate grouped (STYLE, CATEGORY_NAME) rows into [{ name, count }] sorted by
 * count desc — the same ordering the search facets use.
 * Trims names before bucketing (Caspio collapses trailing whitespace inconsistently).
 * @param {Array<{STYLE?: string, CATEGORY_NAME?: string}>} rows
 * @returns {Array<{name: string, count: number}>}
 */
function buildCategoryCounts(rows) {
  const counts = new Map();
  (rows || []).forEach(row => {
    const name = (row.CATEGORY_NAME || '').trim();
    if (!name) return;
    counts.set(name, (counts.get(name) || 0) + 1);
  });
  return Array.from(counts.entries())
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

// GET /api/categories
// Query params:
//   - refresh (optional): "true" bypasses the 1h cache
// Response: { categories: [{ name, count }] }
router.get('/categories', async (req, res) => {
  console.log('GET /api/categories requested');

  const forceRefresh = req.query.refresh === 'true';
  const now = Date.now();
  if (!forceRefresh && categoriesCache && (now - categoriesCache.timestamp) < CATEGORIES_CACHE_TTL) {
    console.log('[CACHE HIT] categories');
    return res.json(categoriesCache.data);
  }
  console.log('[CACHE MISS] categories');

  try {
    // Same data the /api/products/search facets are built from: unique style/category
    // pairs of Active products. Lightweight grouped query — no variant fetch.
    const rows = await fetchAllCaspioPages('/tables/Sanmar_Bulk_251816_Feb2024/records', {
      'q.where': "PRODUCT_STATUS='Active'",
      'q.select': 'STYLE, CATEGORY_NAME',
      'q.groupBy': 'STYLE, CATEGORY_NAME',
      'q.orderBy': 'STYLE' // stable pagination — ~3k+ groups = multi-page; unordered reads drop rows
    });

    const categories = buildCategoryCounts(rows);
    console.log(`Categories: ${categories.length} categories across ${rows.length} style rows`);

    const data = { categories };
    categoriesCache = { data, timestamp: now };
    res.json(data);
  } catch (error) {
    // Erik's #1 rule: visible failure, no stale/hardcoded fallback list.
    console.error('Error in /api/categories:', error.message);
    res.status(500).json({ error: 'Failed to fetch categories', details: error.message });
  }
});

module.exports = router;
module.exports.buildCategoryCounts = buildCategoryCounts;
