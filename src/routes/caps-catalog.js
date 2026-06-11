// Custom Caps Catalog Route
//
// GET /api/caps/catalog — the curated Custom Hats storefront lineup from the
// Caspio table `CAPS_Catalog_2026` (one row per style + hero color, seeded
// 2026-06-11 with the Erik-approved 9-style lineup). The storefront server
// (sanmar-inventory-app getCapsCatalog) whitelists styles from this feed, so
// Erik adds/retires caps or colors in Caspio with NO deploy.
//
// Response: plain array of active rows ordered by style_rank, color_rank.
// On Caspio failure: 502 (the consumer falls back LOUDLY to its registry-pinned
// lineup — never serve an empty-but-200 that would silently empty the store).
//
// Query params:
//   - refresh=true  bypasses the 1h cache

const express = require('express');
const router = express.Router();
const { fetchAllCaspioPages } = require('../utils/caspio');

const CAPS_CATALOG_CACHE_TTL = 60 * 60 * 1000; // 1 hour
let capsCatalogCache = null; // { at, data }

function isActiveRow(value) {
  if (value === true || value === 1) return true;
  if (typeof value === 'string') {
    return ['yes', 'y', 'true', '1'].includes(value.trim().toLowerCase());
  }
  return false;
}

router.get('/caps/catalog', async (req, res) => {
  console.log('GET /api/caps/catalog requested');

  const forceRefresh = req.query.refresh === 'true';
  const now = Date.now();
  if (!forceRefresh && capsCatalogCache && (now - capsCatalogCache.at) < CAPS_CATALOG_CACHE_TTL) {
    console.log('[CACHE HIT] caps-catalog');
    return res.json(capsCatalogCache.data);
  }
  console.log('[CACHE MISS] caps-catalog');

  try {
    const rows = await fetchAllCaspioPages('/tables/CAPS_Catalog_2026/records', { 'q.limit': 500 });
    const active = (rows || [])
      .filter((row) => row && isActiveRow(row.is_active) && String(row.style || '').trim())
      .sort((a, b) =>
        ((a.style_rank || 0) - (b.style_rank || 0)) ||
        ((a.color_rank || 0) - (b.color_rank || 0))
      );

    // Seeded with 51 rows — zero active rows means wiped/wrong data, not an
    // intentionally empty store. Surface it (consumer falls back loudly).
    if (active.length === 0) {
      throw new Error('CAPS_Catalog_2026 returned no active rows');
    }

    capsCatalogCache = { at: now, data: active };
    console.log(`Caps catalog: ${active.length} active style/color rows`);
    res.json(active);
  } catch (error) {
    console.error('Error in /api/caps/catalog:', error.message);
    res.status(502).json({
      error: 'Failed to fetch caps catalog',
      details: error.message
    });
  }
});

module.exports = router;
