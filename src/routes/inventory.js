// Inventory-related routes

const express = require('express');
const router = express.Router();
const { fetchAllCaspioPages } = require('../utils/caspio');
const { createTtlCache, shouldBypass, makeKey } = require('../utils/ttl-cache');
const { getSizeDisplayOrderRows } = require('../utils/caspio-static-tables');

// The live SanMar product feed. This is the table that actually exists in Caspio and
// powers /api/inventory, /max-prices-by-style and /pricing-bundle.
const SANMAR_TABLE = '/tables/Sanmar_Bulk_251816_Feb2024/records';

// Per-style response caches (2026-07-18 Caspio quota reduction). Product-master
// data only changes on the nightly SanMar sync; `?refresh=true` bypasses.
// inventory rows are full-width (no q.select), so that cache stays small —
// the bound is a memory cap, not a hit-rate target.
const inventoryCache = createTtlCache({ name: 'inventory', ttlMs: 10 * 60 * 1000, maxEntries: 50 });
const sizeRunCache = createTtlCache({ name: 'size-run', ttlMs: 15 * 60 * 1000, maxEntries: 300 });

// Strip anything that isn't a valid SanMar style character before interpolating into
// a Caspio WHERE clause (injection guard). Mirrors sanitizeStyleNumber in pricing.js.
function sanitizeStyleNumber(input) {
  if (!input || typeof input !== 'string') return null;
  const sanitized = input.replace(/[^a-zA-Z0-9\-\.]/g, '').trim();
  return (sanitized.length > 0 && sanitized.length <= 30) ? sanitized : null;
}

/**
 * Derive the real size run for a style from the live SanMar bulk table, sorted by the
 * canonical Size_Display_Order table (the same source /api/pricing-bundle uses).
 *
 * The run is style-level (color-independent) on purpose: SanMar carries the same size
 * range across a style's colors, and color *names* are unreliable to filter on — e.g.
 * PC61 has "Jet Black", not "Black", and "Drk Hthr Grey" vs "Dark Heather Grey" — so a
 * COLOR_NAME match would spuriously return zero sizes. Returns [] when the style has no
 * rows (e.g. unknown/discontinued style) OR when the style number fails sanitization
 * (never fall back to interpolating raw input into the WHERE clause).
 */
async function getStyleSizeRun(styleNumber, { force = false } = {}) {
  const safeStyle = sanitizeStyleNumber(styleNumber);
  if (!safeStyle) return [];

  const [rows, sizeOrder] = await Promise.all([
    fetchAllCaspioPages(SANMAR_TABLE, {
      'q.where': `STYLE='${safeStyle}'`,
      'q.select': 'SIZE',
      'q.limit': 1000
    }),
    getSizeDisplayOrderRows({ force }).catch(err => {
      // Sort table is a nice-to-have; without it we still return the sizes (unsorted).
      console.error('Failed to fetch size display order:', err.message);
      return [];
    })
  ]);

  const sortMap = {};
  sizeOrder.forEach(o => {
    if (o.size != null) sortMap[String(o.size).trim().toUpperCase()] = o.sort_order;
  });

  return [...new Set(
    rows.map(r => (r.SIZE == null ? '' : String(r.SIZE).trim().toUpperCase())).filter(Boolean)
  )].sort((a, b) => (sortMap[a] ?? 999) - (sortMap[b] ?? 999));
}

// GET /api/inventory
router.get('/inventory', async (req, res) => {
  const { styleNumber, color } = req.query;
  console.log(`GET /api/inventory requested with styleNumber=${styleNumber}, color=${color}`);

  if (!styleNumber) {
    return res.status(400).json({ error: 'styleNumber is required' });
  }

  try {
    const safeStyle = sanitizeStyleNumber(styleNumber);
    if (!safeStyle) return res.status(400).json({ error: 'Invalid style number format' });

    const cacheKey = makeKey({
      style: safeStyle.toUpperCase(),
      color: color ? String(color).trim().toLowerCase() : null
    });
    if (!shouldBypass(req)) {
      const cached = inventoryCache.get(cacheKey);
      if (cached !== undefined) return res.json(cached);
    }

    let whereClause = `STYLE='${safeStyle}'`;
    if (color) {
      const safeColor = String(color).replace(/'/g, "''").substring(0, 100);
      whereClause += ` AND COLOR_NAME='${safeColor}'`;
    }

    const records = await fetchAllCaspioPages('/tables/Sanmar_Bulk_251816_Feb2024/records', {
      'q.where': whereClause
    });

    console.log(`Inventory for ${styleNumber}: ${records.length} record(s) found`);
    if (records.length > 0) {
      inventoryCache.set(cacheKey, records);
    }
    res.json(records);
  } catch (error) {
    console.error('Error fetching inventory:', error.message);
    res.status(500).json({ error: 'Failed to fetch inventory', details: error.message });
  }
});

// GET /api/sizes-by-style-color
//
// Until 2026-07 this route first probed a dedicated Caspio "/tables/Inventory"
// warehouse-matrix table (`source: 'inventory'` responses). That table has 404'd
// on 100% of requests since 2026-06-18, so the probe was removed to save one
// doomed Caspio call per request — restore it from git history if Caspio ever
// brings the table back.
router.get('/sizes-by-style-color', async (req, res) => {
  const { styleNumber, color } = req.query;
  console.log(`GET /api/sizes-by-style-color requested with styleNumber=${styleNumber}, color=${color}`);

  if (!styleNumber || !color) {
    return res.status(400).json({ error: 'Both styleNumber and color are required' });
  }

  try {
    const safeStyle = sanitizeStyleNumber(styleNumber);
    if (!safeStyle) return res.status(400).json({ error: 'Invalid style number format' });

    // Size runs are style-level (see getStyleSizeRun), so the cache is keyed by
    // style alone — every color of a style shares one entry. The response
    // envelope is rebuilt per request so the style/color echo stays exact.
    const force = shouldBypass(req);
    const cacheKey = makeKey({ style: safeStyle.toUpperCase() });
    let sizes = force ? undefined : sizeRunCache.get(cacheKey);
    if (sizes === undefined) {
      sizes = await getStyleSizeRun(styleNumber, { force });
      if (sizes.length > 0) {
        sizeRunCache.set(cacheKey, sizes);
      }
    }

    if (sizes.length === 0) {
      console.warn(`No sizes found for style: ${styleNumber} (color: ${color}) in SanMar bulk.`);
      return res.status(404).json({ error: `No sizes found for style: ${styleNumber} and color: ${color}` });
    }

    console.log(`Returning ${sizes.length} sizes for style: ${styleNumber}, color: ${color} (source: sanmar-bulk)`);
    return res.json({
      style: styleNumber,
      color: color,
      sizes: sizes,
      warehouses: [],
      sizeTotals: sizes.map(() => 0),
      grandTotal: 0,
      source: 'sanmar-bulk'
    });
  } catch (error) {
    console.error('Error fetching sizes for the specified style and color:', error.message);
    return res.status(500).json({ error: 'Failed to fetch sizes for the specified style and color', details: error.message });
  }
});

module.exports = router;
module.exports.getStyleSizeRun = getStyleSizeRun;
module.exports.sanitizeStyleNumber = sanitizeStyleNumber;
