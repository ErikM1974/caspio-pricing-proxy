/**
 * JDS Catalog API
 *
 * Curated catalog of JDS Industries products that AEs can pick from when
 * submitting an art request via the AE dashboard's "JDS" intake form.
 *
 * The JDS API itself (api.jdsapp.com via /api/jds/*) is SKU-lookup only —
 * there's no browse endpoint. This catalog table holds the metadata we
 * need (category, friendly name, imprint area, decoration defaults) so AEs
 * can browse visually. Live price/inventory still comes from /api/jds/products/:sku.
 *
 * Endpoints:
 * - GET  /api/jds-catalog                — list active items (filterable by category)
 * - GET  /api/jds-catalog/categories     — distinct categories with counts
 * - GET  /api/jds-catalog/:sku           — single record by SKU
 *
 * Data source: Caspio table JDS_Catalog
 * Cache: 10 min in-memory (table mutates rarely; Erik edits via Caspio Bridge for v1)
 */

const express = require('express');
const router = express.Router();
const { fetchAllCaspioPages } = require('../utils/caspio');

const CACHE_TTL = 10 * 60 * 1000;
const cache = new Map();

async function fetchCatalog(forceRefresh = false) {
    const cacheKey = 'all-jds-catalog';
    const cached = cache.get(cacheKey);

    if (!forceRefresh && cached && Date.now() - cached.timestamp < CACHE_TTL) {
        console.log('[JDS-Catalog] CACHE HIT');
        return cached.data;
    }

    console.log('[JDS-Catalog] CACHE MISS — fetching from Caspio');

    try {
        const records = await fetchAllCaspioPages('/tables/JDS_Catalog/records', {});
        cache.set(cacheKey, { data: records, timestamp: Date.now() });
        console.log(`[JDS-Catalog] Fetched ${records.length} rows from Caspio`);
        return records;
    } catch (error) {
        console.error('[JDS-Catalog] Caspio fetch error:', error.message);
        if (cached) {
            console.log('[JDS-Catalog] Using stale cache due to error');
            return cached.data;
        }
        throw error;
    }
}

// Caspio Yes/No fields can come back as boolean or 0/1 — normalize.
function isActiveRow(row) {
    const v = row.IsActive;
    if (v === true || v === 1 || v === '1') return true;
    if (v === false || v === 0 || v === '0') return false;
    return v == null ? true : !!v;
}

function sortCatalog(rows) {
    return rows.slice().sort((a, b) => {
        const cat = String(a.Category || '').localeCompare(String(b.Category || ''));
        if (cat !== 0) return cat;
        const ordA = Number.isFinite(a.DisplayOrder) ? a.DisplayOrder : 100;
        const ordB = Number.isFinite(b.DisplayOrder) ? b.DisplayOrder : 100;
        if (ordA !== ordB) return ordA - ordB;
        return String(a.DisplayName || '').localeCompare(String(b.DisplayName || ''));
    });
}

/**
 * GET /api/jds-catalog
 *
 * Query params:
 * - category   (string, optional)  — exact match, e.g. ?category=Drinkware
 * - activeOnly (boolean, optional) — defaults to true. Set "false" to include inactive
 * - refresh    (boolean, optional) — bypass cache when "true"
 *
 * Response: { result: [...rows...], count, cached, timestamp }
 */
router.get('/', async (req, res) => {
    try {
        const forceRefresh = req.query.refresh === 'true';
        const activeOnly = req.query.activeOnly !== 'false';
        const category = (req.query.category || '').trim();

        const all = await fetchCatalog(forceRefresh);

        let rows = activeOnly ? all.filter(isActiveRow) : all.slice();
        if (category) {
            rows = rows.filter(r => String(r.Category || '').toLowerCase() === category.toLowerCase());
        }
        rows = sortCatalog(rows);

        res.json({
            result: rows,
            count: rows.length,
            cached: !forceRefresh,
            timestamp: new Date().toISOString()
        });
    } catch (error) {
        console.error('[JDS-Catalog] GET / error:', error.message);
        res.status(500).json({
            error: 'Failed to fetch JDS catalog',
            details: error.message,
            timestamp: new Date().toISOString()
        });
    }
});

/**
 * GET /api/jds-catalog/categories
 *
 * Returns distinct categories with item counts and a sample thumbnail per
 * category (for the picker landing screen).
 *
 * Response: { result: [{category, count, sampleThumbnail}], count, timestamp }
 */
router.get('/categories', async (req, res) => {
    try {
        const forceRefresh = req.query.refresh === 'true';
        const all = await fetchCatalog(forceRefresh);
        const active = all.filter(isActiveRow);

        const byCategory = new Map();
        active.forEach(row => {
            const cat = String(row.Category || 'Uncategorized').trim() || 'Uncategorized';
            if (!byCategory.has(cat)) {
                byCategory.set(cat, { category: cat, count: 0, sampleThumbnail: null });
            }
            const entry = byCategory.get(cat);
            entry.count += 1;
            if (!entry.sampleThumbnail && row.ThumbnailURL) {
                entry.sampleThumbnail = row.ThumbnailURL;
            }
        });

        const result = Array.from(byCategory.values())
            .sort((a, b) => a.category.localeCompare(b.category));

        res.json({
            result: result,
            count: result.length,
            timestamp: new Date().toISOString()
        });
    } catch (error) {
        console.error('[JDS-Catalog] GET /categories error:', error.message);
        res.status(500).json({
            error: 'Failed to fetch JDS catalog categories',
            details: error.message,
            timestamp: new Date().toISOString()
        });
    }
});

/**
 * GET /api/jds-catalog/:sku
 *
 * Single record lookup. Returns 404 if SKU not found in catalog.
 * Inactive rows are still returned — useful for AE link-back from a saved
 * request whose SKU has since been deactivated.
 *
 * Response: { result: {...row...}, cached, timestamp }
 */
router.get('/:sku', async (req, res) => {
    try {
        const sku = String(req.params.sku || '').trim();
        if (!sku) {
            return res.status(400).json({ error: 'SKU parameter required', timestamp: new Date().toISOString() });
        }

        const forceRefresh = req.query.refresh === 'true';
        const all = await fetchCatalog(forceRefresh);
        const row = all.find(r => String(r.SKU || '').toLowerCase() === sku.toLowerCase());

        if (!row) {
            return res.status(404).json({
                error: 'SKU not found in JDS_Catalog',
                sku: sku,
                timestamp: new Date().toISOString()
            });
        }

        res.json({
            result: row,
            cached: !forceRefresh,
            timestamp: new Date().toISOString()
        });
    } catch (error) {
        console.error('[JDS-Catalog] GET /:sku error:', error.message);
        res.status(500).json({
            error: 'Failed to fetch JDS catalog row',
            details: error.message,
            timestamp: new Date().toISOString()
        });
    }
});

module.exports = router;
