// DTG Top Sellers Routes
//
// Backed by the Caspio table `DTG_Top_Sellers_2026` — one row per
// (style, color) pair, every entry SanMar-verified at import time.
//
// Endpoints:
//   GET /api/dtg/top-sellers              → all rows, ordered by style_rank, color_rank
//   GET /api/dtg/top-sellers?style=PC61   → all colors for one style
//   GET /api/dtg/top-sellers?category=X   → filter by category (T-Shirt, Hoodie, etc.)
//   GET /api/dtg/top-sellers?limit=N      → take only the top N style ranks
//   GET /api/dtg/top-sellers/styles       → one row per style (aggregated), for quick-pick pills
//   GET /api/dtg/top-sellers/categories   → distinct category list
//
// The bot uses this as the DEFAULT catalog for DTG quotes (instead of
// querying SanMar's full ~30K-item catalog). For one-off styles not in
// this table, the bot still falls back to lookup_product_details against
// SanMar directly.

const express = require('express');
const router = express.Router();
const { fetchAllCaspioPages } = require('../utils/caspio');

const TABLE_NAME = 'DTG_Top_Sellers_2026';
const RESOURCE = `/tables/${TABLE_NAME}/records`;

// Caspio WHERE clauses use single quotes. Strip single quotes from any
// user-supplied filter to avoid breaking the query / injection. Caspio's
// REST API parses these as literal strings, so escaping by doubling
// (e.g. O''Brien) works too — but stripping is simpler for this read-only
// surface where the values are well-known catalog identifiers.
function sanitize(v) {
    return String(v || '').replace(/'/g, '');
}

// Helper: a single Caspio record → an outwardly clean object
// (keeps every field; just standardizes the shape and removes the
// Caspio-internal `pk_id` column from public-facing payloads.)
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

// GET /api/dtg/top-sellers — main lookup with filters
router.get('/dtg/top-sellers', async (req, res) => {
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

        // Order: style_rank ASC, color_rank ASC (most popular style first,
        // and within each style the most popular color first).
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
        console.error('[dtg-top-sellers] error:', err.message);
        res.status(500).json({ success: false, error: 'Failed to fetch DTG top sellers' });
    }
});

// GET /api/dtg/top-sellers/styles — one row per style (aggregated)
// Used by the form's quick-pick pills + bot's recommend_top_sellers tool.
router.get('/dtg/top-sellers/styles', async (req, res) => {
    try {
        const params = {};
        if (req.query.category) {
            params['q.where'] = `category='${sanitize(req.query.category)}'`;
        }
        params['q.orderBy'] = 'style_rank ASC, color_rank ASC';

        const raw = await fetchAllCaspioPages(RESOURCE, params);

        // Aggregate per-style — first occurrence (color_rank=1) holds the
        // top color which we expose as the "hero" for the pill.
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
                });
            }
            byStyle.get(style).color_count++;
        }

        const records = [...byStyle.values()].sort((a, b) => a.style_rank - b.style_rank);

        const limit = parseInt(req.query.limit, 10);
        const out = Number.isFinite(limit) && limit > 0 ? records.slice(0, limit) : records;

        res.set('Cache-Control', 'public, max-age=300');
        res.json({
            success: true,
            count: out.length,
            records: out,
        });
    } catch (err) {
        console.error('[dtg-top-sellers/styles] error:', err.message);
        res.status(500).json({ success: false, error: 'Failed to fetch styles' });
    }
});

// GET /api/dtg/top-sellers/categories — distinct categories with counts
router.get('/dtg/top-sellers/categories', async (req, res) => {
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
        console.error('[dtg-top-sellers/categories] error:', err.message);
        res.status(500).json({ success: false, error: 'Failed to fetch categories' });
    }
});

module.exports = router;
