// Industry Lookalikes Routes
//
// Backed by the Caspio table `Industry_Lookalikes_2026` — one row per
// (industry, style) pair. Each row carries the top 3 colors for that style
// within that industry plus bucket-level totals (customer count, total units,
// total revenue, exemplar customer names).
//
// Source: scripts/aggregate-industry-lookalikes-v2.js — aggregates
// ManageOrders_Orders + ManageOrders_LineItems, classifies customers via
// lib/industry-inference.js + Tavily, filters strictly to SanMar styles
// (via scripts/.sanmar-styles.cache.json), writes a CSV. Erik imports
// quarterly to refresh.
//
// Endpoints:
//   GET /api/industry-lookalikes                       → list distinct industries with bucket totals
//   GET /api/industry-lookalikes/:industry             → top styles for that industry (default top 10)
//   GET /api/industry-lookalikes/:industry?limit=N     → cap to top N styles
//
// Used by: emb-quote-ai.js `lookup_lookalike_customers` tool — the bot calls
// this whenever a customer is COLD (no own-history) or the rep asks "what
// do other [industry] customers buy?"
//
// Created 2026-05-24 — EMB Smart A2.

const express = require('express');
const router = express.Router();
const { fetchAllCaspioPages } = require('../utils/caspio');

const TABLE_NAME = 'Industry_Lookalikes_2026';
const RESOURCE = `/tables/${TABLE_NAME}/records`;

// === In-memory cache (4hr TTL — industry patterns don't shift fast) ===
// Key: industry name (lower-cased). Value: { ts, payload }
const cache = new Map();
const CACHE_TTL_MS = 4 * 60 * 60 * 1000;

// Caspio WHERE clauses use single quotes. Strip single quotes from any
// user-supplied filter to avoid breaking the query / injection.
function sanitize(v) {
    return String(v || '').replace(/'/g, '');
}

// Normalize a single Caspio record → bot-friendly shape.
function shapeRow(record) {
    return {
        industry: record.industry || '',
        style_rank: Number(record.style_rank) || 0,
        style: record.style || '',
        total_units: Number(record.total_units) || 0,
        top_colors: [
            record.top_color_1
                ? { color: record.top_color_1, units: Number(record.top_color_1_units) || 0 }
                : null,
            record.top_color_2
                ? { color: record.top_color_2, units: Number(record.top_color_2_units) || 0 }
                : null,
            record.top_color_3
                ? { color: record.top_color_3, units: Number(record.top_color_3_units) || 0 }
                : null,
        ].filter(Boolean),
    };
}

// === GET /api/industry-lookalikes — list distinct industries + totals ===
// Useful for diagnostics + populating a dropdown if we ever want a UI.
router.get('/', async (req, res) => {
    try {
        const rows = await fetchAllCaspioPages(RESOURCE, {
            'q.select': 'industry,industry_customer_count,industry_total_units,industry_total_revenue',
        });
        // Dedupe by industry
        const seen = new Map();
        for (const r of rows) {
            if (!seen.has(r.industry)) {
                seen.set(r.industry, {
                    industry: r.industry,
                    customerCount: Number(r.industry_customer_count) || 0,
                    totalUnits: Number(r.industry_total_units) || 0,
                    totalRevenue: Number(r.industry_total_revenue) || 0,
                });
            }
        }
        const industries = [...seen.values()].sort((a, b) => b.totalRevenue - a.totalRevenue);
        res.set('Cache-Control', 'public, max-age=600'); // 10min CDN
        res.json({
            success: true,
            count: industries.length,
            industries,
        });
    } catch (err) {
        console.error('[industry-lookalikes] list error:', err.message);
        res.status(500).json({ success: false, error: 'Failed to list industries' });
    }
});

// === GET /api/industry-lookalikes/:industry — top styles for an industry ===
router.get('/:industry', async (req, res) => {
    const industry = sanitize(req.params.industry);
    if (!industry) {
        return res.status(400).json({ success: false, error: 'industry param required' });
    }

    const limit = (() => {
        const n = parseInt(req.query.limit, 10);
        if (!Number.isFinite(n) || n <= 0) return 10;
        return Math.min(n, 25); // table tops out at 25 styles per industry
    })();

    // Cache lookup
    const cacheKey = `${industry.toLowerCase()}:${limit}`;
    const cached = cache.get(cacheKey);
    if (cached && (Date.now() - cached.ts) < CACHE_TTL_MS) {
        return res.json({ ...cached.payload, _source: 'cache', _cachedAt: new Date(cached.ts).toISOString() });
    }

    try {
        const t0 = Date.now();
        const rawRows = await fetchAllCaspioPages(RESOURCE, {
            'q.where': `industry='${industry}'`,
            'q.sort': 'style_rank ASC',
        });

        if (!rawRows.length) {
            const payload = {
                success: true,
                industry,
                found: false,
                message: `No lookalike data for industry "${industry}". Valid industries: Construction, Construction/Trades, Construction/Electrical, Public Safety, Professional Services, Education, Government, Retail, Agriculture, Hospitality, Healthcare, Religious, Logistics/Transportation, Manufacturing, Energy/Utilities, Sports/Recreation, Non-profit, Unknown.`,
                topStyles: [],
            };
            cache.set(cacheKey, { ts: Date.now(), payload });
            return res.json({ ...payload, _source: 'live', _elapsedMs: Date.now() - t0 });
        }

        // Bucket-level totals come from any row (all rows for an industry share these)
        const first = rawRows[0];
        const customerCount = Number(first.industry_customer_count) || 0;
        const totalUnits = Number(first.industry_total_units) || 0;
        const totalRevenue = Number(first.industry_total_revenue) || 0;
        const exemplars = String(first.exemplar_customers || '')
            .split(';').map(s => s.trim()).filter(Boolean);

        const topStyles = rawRows.slice(0, limit).map(shapeRow);

        // Small-bucket warning so the bot can hedge its recommendation
        let sampleSizeNote = null;
        if (customerCount < 10) {
            sampleSizeNote = `LIMITED DATA — only ${customerCount} customer(s) in this industry bucket. Treat as a starting point, not a strong pattern.`;
        } else if (customerCount < 20) {
            sampleSizeNote = `Modest sample (${customerCount} customers in bucket) — directional but not conclusive.`;
        }

        const payload = {
            success: true,
            industry,
            found: true,
            customerCount,
            totalUnits,
            totalRevenue,
            exemplars,
            sampleSizeNote,
            topStyles,
            _note: 'Data is from NWCA orders synced via FileMaker MO-UPDATE cron (currently ~2 months of history). Refresh quarterly by re-running scripts/aggregate-industry-lookalikes-v2.js.',
        };

        cache.set(cacheKey, { ts: Date.now(), payload });
        res.json({ ...payload, _source: 'live', _elapsedMs: Date.now() - t0 });
    } catch (err) {
        console.error(`[industry-lookalikes] error for "${industry}":`, err.message);
        res.status(500).json({ success: false, error: 'Failed to fetch industry data' });
    }
});

// === Admin: clear cache (for testing after data refresh) ===
router.get('/cache/clear', (req, res) => {
    const n = cache.size;
    cache.clear();
    res.json({ success: true, cleared: n });
});

module.exports = router;
