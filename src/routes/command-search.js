/**
 * Command Search API — backs the staff dashboard's Ctrl+K "Everything Bar"
 * (Phase 2 of the dashboard "alive + personal" roadmap, 2026-07-20).
 *
 * GET /api/command-search?q=<term>
 *
 * ONE query fans out server-side to four sources (parallel, each independently
 * capped + fault-isolated so a slow/broken source never blanks the palette):
 *   • customers — CompanyContactsMerge2026 (active, grouped by id_Customer)
 *   • orders    — ORDER_ODBC (numeric q = ID_Order exact; text = CompanyName)
 *   • quotes    — quote_sessions (QuoteID prefix or company/customer name)
 *   • designs   — Design_Lookup_2026 (numeric = Design_Number; text = name/company)
 *
 * Response: { success, q, customers[], orders[], quotes[], designs[],
 *             errors[category], tookMs }
 * A failed source appears in `errors` — the frontend shows "orders search
 * unavailable" instead of silently missing results (Erik's Rule #4).
 *
 * Gating: mounted behind requireCrmApiSecret (company names, reps, emails =
 * CRM data). The main app forwards via SAML-gated GET /api/staff/command-search.
 *
 * Caching: 60s in-memory keyed by normalized q — the palette debounces at
 * ~250ms, so cache mostly serves repeat/backspace keystrokes cheaply.
 */

const express = require('express');
const { fetchAllCaspioPages } = require('../utils/caspio');

const router = express.Router();

const CACHE_TTL_MS = 60 * 1000;
const cache = new Map(); // qKey -> { at, data }

const PER_CATEGORY = 5;

/* ── sanitize ───────────────────────────────────────── */

// Caspio q.where string literal: double the quotes, drop LIKE wildcards and
// control chars. Result is safe to embed inside '...'.
function sqlSafe(term) {
    return term.replace(/'/g, "''").replace(/[%_\[\]\\]/g, ' ').replace(/\s+/g, ' ').trim();
}

function normalizeQ(raw) {
    const q = String(raw || '').trim().slice(0, 60);
    return q.length >= 2 ? q : null;
}

/* ── per-source searchers (each returns an array; throws on failure) ── */

async function searchCustomers(q) {
    const safe = sqlSafe(q);
    if (!safe) return [];
    const rows = await fetchAllCaspioPages('/tables/CompanyContactsMerge2026/records', {
        'q.where': `Is_Active=1 AND (Company_Name LIKE '%${safe}%' OR ct_NameFull LIKE '%${safe}%')`,
        'q.select': 'id_Customer,Company_Name,Sales_Rep,Last_Order_Date,City,State',
        'q.orderBy': 'Last_Order_Date DESC',
        'q.limit': 40,
    }, { maxPages: 1 });
    const byId = new Map();
    for (const r of rows) {
        if (r.id_Customer == null || byId.has(r.id_Customer)) continue;
        byId.set(r.id_Customer, {
            idCustomer: r.id_Customer,
            company: r.Company_Name || '',
            rep: r.Sales_Rep || '',
            lastOrder: r.Last_Order_Date || null,
            city: r.City || '',
            state: r.State || '',
        });
        if (byId.size >= PER_CATEGORY) break;
    }
    return [...byId.values()];
}

async function searchOrders(q) {
    const isNumeric = /^\d{3,9}$/.test(q);
    const safe = sqlSafe(q);
    if (!isNumeric && !safe) return [];
    const where = isNumeric
        ? `ID_Order=${parseInt(q, 10)}`
        : `CompanyName LIKE '%${safe}%'`;
    const rows = await fetchAllCaspioPages('/tables/ORDER_ODBC/records', {
        'q.where': where,
        'q.select': 'ID_Order,CompanyName,CustomerServiceRep,id_Customer,date_OrderPlaced,cur_Subtotal,ORDER_TYPE,sts_Shipped,sts_Invoiced',
        'q.orderBy': 'date_OrderPlaced DESC',
        'q.limit': PER_CATEGORY,
    }, { maxPages: 1 });
    return rows.slice(0, PER_CATEGORY).map((r) => ({
        idOrder: r.ID_Order,
        company: r.CompanyName || '',
        rep: r.CustomerServiceRep || '',
        idCustomer: r.id_Customer ?? null,
        placed: r.date_OrderPlaced || null,
        subtotal: parseFloat(r.cur_Subtotal) || 0,
        orderType: r.ORDER_TYPE || '',
        shipped: r.sts_Shipped === 1,
        invoiced: r.sts_Invoiced === 1,
    }));
}

async function searchQuotes(q) {
    const safe = sqlSafe(q);
    if (!safe) return [];
    // QuoteIDs come in several shapes ("EMB-2026-314", "DTG0712-4") — always
    // try the ID as a prefix AND the company/customer name in one clause.
    const where = `(QuoteID LIKE '${safe}%' OR CompanyName LIKE '%${safe}%' OR CustomerName LIKE '%${safe}%')`;
    const rows = await fetchAllCaspioPages('/tables/quote_sessions/records', {
        'q.where': where,
        'q.select': 'QuoteID,CompanyName,CustomerName,Status,SubtotalAmount,TotalAmount,SalesRepName,CreatedAt',
        'q.orderBy': 'PK_ID DESC',
        'q.limit': PER_CATEGORY,
    }, { maxPages: 1 });
    return rows.slice(0, PER_CATEGORY).map((r) => ({
        quoteID: r.QuoteID,
        company: r.CompanyName || r.CustomerName || '',
        status: r.Status || '',
        subtotal: parseFloat(r.SubtotalAmount) || parseFloat(r.TotalAmount) || 0,
        rep: r.SalesRepName || '',
        created: r.CreatedAt || null,
    }));
}

async function searchDesigns(q) {
    const isNumeric = /^\d{2,8}$/.test(q);
    const safe = sqlSafe(q);
    if (!isNumeric && !safe) return [];
    const where = isNumeric
        ? `(Design_Number='${q}' OR Design_Number LIKE '${q}%')`
        : `(Design_Name LIKE '%${safe}%' OR Company LIKE '%${safe}%')`;
    const rows = await fetchAllCaspioPages('/tables/Design_Lookup_2026/records', {
        'q.where': where,
        'q.select': 'Design_Number,Design_Name,Company,Stitch_Count,Thumbnail_URL,Mockup_URL,Last_Order_Date',
        'q.orderBy': 'Last_Order_Date DESC',
        'q.limit': 25,
    }, { maxPages: 1 });
    // Design_Number is NOT unique (DST variants) — keep the freshest row per number.
    const byNumber = new Map();
    for (const r of rows) {
        const dn = String(r.Design_Number || '');
        if (!dn || byNumber.has(dn)) continue;
        byNumber.set(dn, {
            designNumber: dn,
            name: r.Design_Name || '',
            company: r.Company || '',
            stitchCount: parseInt(r.Stitch_Count, 10) || 0,
            image: r.Mockup_URL || r.Thumbnail_URL || '',
            lastOrder: r.Last_Order_Date || null,
        });
        if (byNumber.size >= PER_CATEGORY) break;
    }
    return [...byNumber.values()];
}

/* ── route ──────────────────────────────────────────── */

router.get('/', async (req, res) => {
    const q = normalizeQ(req.query.q);
    if (!q) return res.status(400).json({ success: false, error: 'q must be 2-60 characters' });

    const qKey = q.toLowerCase();
    const hit = cache.get(qKey);
    if (hit && Date.now() - hit.at < CACHE_TTL_MS) {
        return res.json({ ...hit.data, fromCache: true });
    }

    const started = Date.now();
    const [customers, orders, quotes, designs] = await Promise.allSettled([
        searchCustomers(q),
        searchOrders(q),
        searchQuotes(q),
        searchDesigns(q),
    ]);

    const errors = {};
    const val = (settled, name) => {
        if (settled.status === 'fulfilled') return settled.value;
        console.error(`[command-search] ${name} failed for "${q}":`, settled.reason?.message);
        errors[name] = true;
        return [];
    };

    const data = {
        success: true,
        q,
        customers: val(customers, 'customers'),
        orders: val(orders, 'orders'),
        quotes: val(quotes, 'quotes'),
        designs: val(designs, 'designs'),
        errors,
        tookMs: Date.now() - started,
    };

    // Only cache fully-healthy responses — a blip shouldn't stick for 60s.
    if (Object.keys(errors).length === 0) {
        cache.set(qKey, { at: Date.now(), data });
        if (cache.size > 500) { // primitive bound; oldest-first eviction
            const oldest = cache.keys().next().value;
            cache.delete(oldest);
        }
    }
    res.json(data);
});

module.exports = router;
