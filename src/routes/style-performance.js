// SanMar Style Performance 10yr Routes
//
// Backed by the Caspio table `Sanmar_Style_Performance_10yr_26` — one row
// per SanMar STYLE with 10 years of NWCA sales aggregates:
//   - SanMar catalog identity (product_title, brand_name, category_name,
//     subcategory_name, msrp, current_case_price, product_status, keywords,
//     companion_styles) — sourced from the live SanMar bulk catalog
//   - 10-year velocity (decade_rank, total_units_10yr, total_revenue_10yr,
//     total_orders_10yr)
//   - Margin signals (avg_margin_pct, avg_sell_price, avg_our_cost)
//   - Top 3 colors with units
//   - Customer_Types_That_Buy (top 5 Customer_Type with % share)
//   - Frequently_Paired_With (top 3 co-ordered styles for cross-sell)
//
// NOTE: Caspio table name is `Sanmar_Style_Performance_10yr_26` (suffix _26
// not _2026 — original was too long for Caspio's table-name limit).
//
// Endpoints:
//   GET /api/style-performance/:style          → one style by exact match
//   GET /api/style-performance/top?category=X&brand=Y&sort=units|revenue|margin&limit=N
//                                              → ranked list (default: top 20 by units)
//   GET /api/style-performance/high-margin-alternatives/:style
//                                              → finds similar-category styles with HIGHER margin
//
// Used by: emb-quote-ai.js's new tools `lookup_style_performance` +
// `recommend_high_margin_alternative`.
//
// Created 2026-05-25 — EMB Smart Phase E2.

const express = require('express');
const router = express.Router();
const { fetchAllCaspioPages } = require('../utils/caspio');

const TABLE = 'Sanmar_Style_Performance_10yr_26';
const RESOURCE = `/tables/${TABLE}/records`;

// === Cache — 4hr TTL ===
const cacheByStyle = new Map();     // STYLE → { ts, row }
const cacheByCategory = new Map();  // `${category}|${brand}|${sort}|${limit}` → { ts, rows }
const cacheAlternatives = new Map(); // STYLE → { ts, rows }
const CACHE_TTL_MS = 4 * 60 * 60 * 1000;

function sanitize(v) {
    return String(v || '').replace(/'/g, '');
}

function shapeRow(r) {
    if (!r) return null;
    return {
        style: r.style || '',
        product_title: r.product_title || '',
        brand_name: r.brand_name || '',
        category_name: r.category_name || '',
        subcategory_name: r.subcategory_name || '',
        decade_rank: Number(r.decade_rank) || 0,
        total_units_10yr: Number(r.total_units_10yr) || 0,
        total_revenue_10yr: Number(r.total_revenue_10yr) || 0,
        total_orders_10yr: Number(r.total_orders_10yr) || 0,
        avg_margin_pct: Number(r.avg_margin_pct) || 0,
        avg_sell_price: Number(r.avg_sell_price) || 0,
        avg_our_cost: Number(r.avg_our_cost) || 0,
        msrp: Number(r.msrp) || 0,
        current_case_price: Number(r.current_case_price) || 0,
        product_status: r.product_status || '',
        top_colors: [
            r.top_color_1 ? { color: r.top_color_1, units: Number(r.top_color_1_units) || 0 } : null,
            r.top_color_2 ? { color: r.top_color_2, units: Number(r.top_color_2_units) || 0 } : null,
            r.top_color_3 ? { color: r.top_color_3, units: Number(r.top_color_3_units) || 0 } : null,
        ].filter(Boolean),
        customer_types_that_buy: r.customer_types_that_buy || '',
        frequently_paired_with: r.frequently_paired_with || '',
        companion_styles: r.companion_styles || '',
        keywords: r.keywords || '',
    };
}

// === GET /api/style-performance/top — list view ===
// Mounted BEFORE :style so /top doesn't get caught by the param route.
router.get('/top', async (req, res) => {
    const category = sanitize(req.query.category);
    const brand = sanitize(req.query.brand);
    const sort = ['units', 'revenue', 'margin'].includes(req.query.sort) ? req.query.sort : 'units';
    const limit = (() => {
        const n = parseInt(req.query.limit, 10);
        if (!Number.isFinite(n) || n <= 0) return 20;
        return Math.min(n, 50);
    })();

    const cacheKey = `${category.toLowerCase()}|${brand.toLowerCase()}|${sort}|${limit}`;
    const cached = cacheByCategory.get(cacheKey);
    if (cached && (Date.now() - cached.ts) < CACHE_TTL_MS) {
        return res.json({ success: true, count: cached.rows.length, styles: cached.rows, _source: 'cache' });
    }

    try {
        const where = [];
        if (category) where.push(`category_name='${category}'`);
        if (brand) where.push(`brand_name LIKE '%${brand}%'`);
        const orderBy = sort === 'revenue' ? 'total_revenue_10yr DESC'
                      : sort === 'margin' ? 'avg_margin_pct DESC'
                      : 'total_units_10yr DESC';

        const params = {
            'q.orderBy': orderBy,
            'q.limit': Math.max(limit, 5), // Caspio v3 floor
        };
        if (where.length) params['q.where'] = where.join(' AND ');

        const rows = await fetchAllCaspioPages(RESOURCE, params, { maxPages: 1 });
        const out = (rows || []).slice(0, limit).map(shapeRow);
        cacheByCategory.set(cacheKey, { ts: Date.now(), rows: out });
        res.json({
            success: true, count: out.length, styles: out,
            filters: { category: category || null, brand: brand || null, sort },
            _source: 'live',
        });
    } catch (err) {
        console.error('[style-performance/top] error:', err.message);
        res.status(500).json({ success: false, error: 'Failed to fetch top styles', details: err.message });
    }
});

// === GET /api/style-performance/high-margin-alternatives/:style ===
// Find styles in the SAME CATEGORY with HIGHER margin — for the bot's
// `recommend_high_margin_alternative` tool. Used when the rep is about
// to quote a low-margin style and the bot wants to suggest an upgrade.
router.get('/high-margin-alternatives/:style', async (req, res) => {
    const style = sanitize(req.params.style).toUpperCase();
    if (!style) return res.status(400).json({ success: false, error: 'style required' });

    const cached = cacheAlternatives.get(style);
    if (cached && (Date.now() - cached.ts) < CACHE_TTL_MS) {
        return res.json({ ...cached.payload, _source: 'cache' });
    }

    try {
        // Step 1: get the base style
        const base = await fetchAllCaspioPages(RESOURCE, {
            'q.where': `style='${style}'`, 'q.limit': 5,
        });
        if (!base?.length) {
            return res.json({
                success: true, found: false, style,
                message: `Style ${style} not in 10yr performance table — too few sales or new SKU.`,
            });
        }
        const baseRow = shapeRow(base[0]);

        // Step 2: pull same-category styles with HIGHER margin + meaningful volume
        const minUnits = Math.max(100, Math.floor(baseRow.total_units_10yr * 0.05)); // at least 5% of base volume
        const alts = await fetchAllCaspioPages(RESOURCE, {
            'q.where': `category_name='${baseRow.category_name}' AND avg_margin_pct>${baseRow.avg_margin_pct} AND total_units_10yr>=${minUnits} AND style<>'${style}'`,
            'q.orderBy': 'avg_margin_pct DESC',
            'q.limit': 10,
        }, { maxPages: 1 });

        const payload = {
            success: true,
            found: true,
            base: baseRow,
            alternatives: (alts || []).slice(0, 5).map(shapeRow),
            count: Math.min((alts || []).length, 5),
            _note: `Filtered to category="${baseRow.category_name}", margin > ${baseRow.avg_margin_pct}%, with at least ${minUnits} lifetime units of sales to ensure proven sellers.`,
        };
        cacheAlternatives.set(style, { ts: Date.now(), payload });
        res.json({ ...payload, _source: 'live' });
    } catch (err) {
        console.error(`[style-performance/alternatives] error for "${style}":`, err.message);
        res.status(500).json({ success: false, error: 'Failed to find alternatives', details: err.message });
    }
});

// === GET /api/style-performance/:style — one style ===
router.get('/:style', async (req, res) => {
    const style = sanitize(req.params.style).toUpperCase();
    if (!style) return res.status(400).json({ success: false, error: 'style required' });
    const cached = cacheByStyle.get(style);
    if (cached && (Date.now() - cached.ts) < CACHE_TTL_MS) {
        return res.json({ success: true, found: true, style: cached.row, _source: 'cache' });
    }
    try {
        const t0 = Date.now();
        const rows = await fetchAllCaspioPages(RESOURCE, {
            'q.where': `style='${style}'`,
            'q.limit': 5,
        });
        if (!rows?.length) {
            return res.json({
                success: true, found: false, style,
                message: `Style ${style} not in 10yr performance table — too few sales, new SKU, or possibly a service code.`,
            });
        }
        const out = shapeRow(rows[0]);
        cacheByStyle.set(style, { ts: Date.now(), row: out });
        res.json({ success: true, found: true, style: out, _source: 'live', _elapsedMs: Date.now() - t0 });
    } catch (err) {
        console.error(`[style-performance] error for "${style}":`, err.message);
        res.status(500).json({ success: false, error: 'Failed to fetch style performance', details: err.message });
    }
});

// === Admin cache clear ===
router.get('/cache/clear', (req, res) => {
    const stats = { byStyle: cacheByStyle.size, byCategory: cacheByCategory.size, alternatives: cacheAlternatives.size };
    cacheByStyle.clear(); cacheByCategory.clear(); cacheAlternatives.clear();
    res.json({ success: true, cleared: stats });
});

module.exports = router;
