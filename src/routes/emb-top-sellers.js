// EMB Top Sellers Routes
//
// Backed by the Caspio table `EMB_Top_Sellers_2026` — one row per
// (style, color) pair, each entry sourced from 10 years of NWCA
// embroidery sales history. Erik curates the list quarterly.
//
// Endpoints:
//   GET /api/emb/top-sellers              → all rows, ordered by style_rank, color_rank
//   GET /api/emb/top-sellers?style=PC54   → all colors for one style
//   GET /api/emb/top-sellers?category=X   → filter by category (T-Shirt, Cap, Polo, Hoodie, Jacket, Beanie, Bag, etc.)
//   GET /api/emb/top-sellers?limit=N      → take only the top N style ranks
//   GET /api/emb/top-sellers/styles       → one row per style (aggregated), for quick-pick pills + bot tool
//   GET /api/emb/top-sellers/categories   → distinct category list
//
// The bot uses /styles as the DEFAULT recommendation source for EMB quotes.
// For one-off styles not in this table the bot falls back to lookup_product_details
// (live SanMar query).
//
// Clone of dtg-top-sellers.js (2026-05-24, Phase EMB Chat A). Schema parity
// with DTG_Top_Sellers_2026 — same column names, same shape() helper, same
// hydrateMainImages() pattern.

const express = require('express');
const router = express.Router();
const { fetchAllCaspioPages } = require('../utils/caspio');

const TABLE_NAME = 'EMB_Top_Sellers_2026';
const RESOURCE = `/tables/${TABLE_NAME}/records`;

// Per-dyno cache of {main_image_url, colors_by_catalog} keyed by style.
// Built lazily on first /styles request; reused thereafter. Restart-fresh on
// dyno cycle. `colors_by_catalog` is { [CATALOG_COLOR]: MAIN_IMAGE_URL } so
// each top_color row can carry its own model-wearing-the-color image — used
// by the recommendation card / bot reply to surface the right swatch.
let _imageCache = null;
let _imagePromise = null;
const INTERNAL_API = process.env.INTERNAL_API_BASE || 'http://localhost:' + (process.env.PORT || 3002);

async function hydrateMainImages(styles) {
    if (_imageCache) {
        const missing = styles.filter((s) => !(s in _imageCache));
        if (!missing.length) return _imageCache;
    }
    if (_imagePromise) return _imagePromise;
    _imagePromise = Promise.all(styles.map(async (style) => {
        try {
            // /api/dtg/product-bundle returns generic SanMar bundle data (not
            // DTG-specific). Reusing for EMB until a method-agnostic
            // /api/product-bundle ships. If/when that's added, swap the URL here.
            const r = await fetch(`${INTERNAL_API}/api/dtg/product-bundle?styleNumber=${encodeURIComponent(style)}`);
            if (!r.ok) return [style, { main_image_url: null, colors_by_catalog: {} }];
            const j = await r.json();
            const colors = (j && j.product && Array.isArray(j.product.colors)) ? j.product.colors : [];
            const first = colors.find((c) => c && c.MAIN_IMAGE_URL);
            const colorsByCatalog = {};
            for (const c of colors) {
                if (!c) continue;
                const cc = String(c.CATALOG_COLOR || '').trim();
                const url = c.MAIN_IMAGE_URL || c.FRONT_MODEL_IMAGE_URL || c.FRONT_FLAT_IMAGE_URL || '';
                if (cc && url) colorsByCatalog[cc] = url;
            }
            return [style, {
                main_image_url: first ? first.MAIN_IMAGE_URL : null,
                colors_by_catalog: colorsByCatalog,
            }];
        } catch {
            return [style, { main_image_url: null, colors_by_catalog: {} }];
        }
    })).then((entries) => {
        _imageCache = Object.assign({}, _imageCache || {}, Object.fromEntries(entries));
        _imagePromise = null;
        return _imageCache;
    });
    return _imagePromise;
}

// Caspio WHERE clauses use single quotes. Strip single quotes from any
// user-supplied filter to avoid breaking the query / injection. Values here
// are well-known catalog identifiers, so stripping is simpler than escaping.
function sanitize(v) {
    return String(v || '').replace(/'/g, '');
}

// A single Caspio record → standardized public shape. Drops Caspio-internal
// pk_id, normalizes types, exposes a sizes{} object.
function shape(record) {
    return {
        style: record.style || '',
        style_rank: Number(record.style_rank) || 0,
        product_title: record.product_title || '',
        category: record.category || '',
        total_units_sold: Number(record.total_units_sold) || 0,
        total_orders: Number(record.total_orders) || 0,
        color_name: record.color_name || '',
        catalog_color: record.catalog_color || '',
        color_units_sold: Number(record.color_units_sold) || 0,
        color_orders: Number(record.color_orders) || 0,
        color_rank: Number(record.color_rank) || 0,
        sizes: {
            XS: Number(record.units_XS) || 0,
            S: Number(record.units_S) || 0,
            M: Number(record.units_M) || 0,
            L: Number(record.units_L) || 0,
            XL: Number(record.units_XL) || 0,
            '2XL': Number(record.units_2XL) || 0,
            '3XL': Number(record.units_3XL) || 0,
            '4XL': Number(record.units_4XL) || 0,
            '5XL': Number(record.units_5XL) || 0,
            '6XL': Number(record.units_6XL) || 0,
        },
        swatch_image_url: record.swatch_image_url || '',
    };
}

// GET /api/emb/top-sellers — main lookup with filters
router.get('/emb/top-sellers', async (req, res) => {
    try {
        const params = {};
        const whereConditions = [];

        if (req.query.style) {
            whereConditions.push(`style='${sanitize(req.query.style).toUpperCase()}'`);
        }
        if (req.query.category) {
            whereConditions.push(`category='${sanitize(req.query.category)}'`);
        }
        if (req.query.color) {
            whereConditions.push(`color_name='${sanitize(req.query.color)}'`);
        }

        if (whereConditions.length) {
            params['q.where'] = whereConditions.join(' AND ');
        }

        // Order: style_rank ASC, color_rank ASC (most popular style first;
        // within each style, the most popular color first).
        params['q.orderBy'] = 'style_rank ASC, color_rank ASC';

        const rawRecords = await fetchAllCaspioPages(RESOURCE, params);
        let records = rawRecords.map(shape);

        // Apply limit on STYLE rank (not row count) — limit=5 means top 5 styles
        // including all their colors.
        const limit = parseInt(req.query.limit, 10);
        if (Number.isFinite(limit) && limit > 0) {
            const keepRanks = new Set();
            for (const r of records) {
                if (keepRanks.size < limit) keepRanks.add(r.style_rank);
            }
            records = records.filter(r => keepRanks.has(r.style_rank));
        }

        res.set('Cache-Control', 'public, max-age=300'); // 5min CDN cache
        res.json({
            success: true,
            count: records.length,
            uniqueStyles: new Set(records.map(r => r.style)).size,
            records,
        });
    } catch (err) {
        console.error('[emb-top-sellers] error:', err.message);
        res.status(500).json({ success: false, error: 'Failed to fetch EMB top sellers' });
    }
});

// GET /api/emb/top-sellers/styles — one row per style (aggregated)
// Used by the bot's recommend_top_sellers_emb tool.
router.get('/emb/top-sellers/styles', async (req, res) => {
    try {
        const params = {};
        if (req.query.category) {
            params['q.where'] = `category='${sanitize(req.query.category)}'`;
        }
        params['q.orderBy'] = 'style_rank ASC, color_rank ASC';

        const raw = await fetchAllCaspioPages(RESOURCE, params);

        // Aggregate per-style — first row (color_rank=1) is the top color
        // exposed as the "hero". Also accumulate up to 6 top colors per style
        // so the frontend / bot can show inline swatches without a second
        // round-trip.
        const byStyle = new Map();
        for (const r of raw) {
            const style = r.style;
            if (!byStyle.has(style)) {
                byStyle.set(style, {
                    style,
                    style_rank: Number(r.style_rank) || 0,
                    product_title: r.product_title || '',
                    category: r.category || '',
                    total_units_sold: Number(r.total_units_sold) || 0,
                    total_orders: Number(r.total_orders) || 0,
                    top_color: r.color_name || '',
                    top_color_catalog: r.catalog_color || '',
                    top_color_swatch: r.swatch_image_url || '',
                    color_count: 0,
                    top_colors: [], // populated below — up to 6 top colors
                });
            }
            const s = byStyle.get(style);
            s.color_count++;
            if (s.top_colors.length < 6) {
                s.top_colors.push({
                    color_name: r.color_name || '',
                    catalog_color: r.catalog_color || '',
                    swatch_image_url: r.swatch_image_url || '',
                    color_units_sold: Number(r.color_units_sold || 0),
                    color_rank: Number(r.color_rank || 0),
                });
            }
        }

        const records = [...byStyle.values()].sort((a, b) => a.style_rank - b.style_rank);

        const limit = parseInt(req.query.limit, 10);
        const out = Number.isFinite(limit) && limit > 0 ? records.slice(0, limit) : records;

        // Hydrate main_image_url per style + front_image_url per top_color so
        // the bot/UI can surface a model-wearing-the-color image. main_image_url
        // prefers the TOP-seller color's image so the hero matches the
        // initial-selected swatch — falls back to the first SanMar-photographed
        // color if the top color has no MAIN_IMAGE_URL.
        try {
            const imageMap = await hydrateMainImages(out.map((r) => r.style));
            for (const r of out) {
                const entry = imageMap[r.style] || {};
                const byColor = entry.colors_by_catalog || {};
                r.main_image_url = byColor[r.top_color_catalog] || entry.main_image_url || '';
                if (Array.isArray(r.top_colors)) {
                    for (const tc of r.top_colors) {
                        tc.front_image_url = byColor[tc.catalog_color] || '';
                    }
                }
            }
        } catch (e) {
            console.warn('[emb-top-sellers/styles] image hydration skipped:', e.message);
            for (const r of out) {
                r.main_image_url = '';
                if (Array.isArray(r.top_colors)) {
                    for (const tc of r.top_colors) tc.front_image_url = '';
                }
            }
        }

        res.set('Cache-Control', 'public, max-age=300');
        res.json({
            success: true,
            count: out.length,
            records: out,
        });
    } catch (err) {
        console.error('[emb-top-sellers/styles] error:', err.message);
        res.status(500).json({ success: false, error: 'Failed to fetch styles' });
    }
});

// GET /api/emb/top-sellers/categories — distinct categories with counts
router.get('/emb/top-sellers/categories', async (req, res) => {
    try {
        const raw = await fetchAllCaspioPages(RESOURCE, { 'q.orderBy': 'style_rank ASC' });

        const byCat = new Map();
        const stylesPerCat = new Map();
        for (const r of raw) {
            const cat = r.category || 'Other';
            byCat.set(cat, (byCat.get(cat) || 0) + 1);
            if (!stylesPerCat.has(cat)) stylesPerCat.set(cat, new Set());
            stylesPerCat.get(cat).add(r.style);
        }

        const categories = [...byCat.entries()].map(([category, color_row_count]) => ({
            category,
            style_count: stylesPerCat.get(category).size,
            color_row_count,
        })).sort((a, b) => b.style_count - a.style_count);

        res.set('Cache-Control', 'public, max-age=600');
        res.json({ success: true, count: categories.length, categories });
    } catch (err) {
        console.error('[emb-top-sellers/categories] error:', err.message);
        res.status(500).json({ success: false, error: 'Failed to fetch categories' });
    }
});

module.exports = router;
