// Order Form — Customer Service History API (Phase 6c, 2026-05-03)
//
// Two endpoints powering the order form's "Suggested for {Company}" rail
// section. The frontend reads /customer-suggestions to populate the rail;
// the order-form submit handler in the Pricing Index project's server.js
// writes /history after each successful ShopWorks push.
//
// Tables in Caspio (created 2026-05-03 — see caspio-import/ in Pricing
// Index repo):
//   - Customer_Service_History  : (Customer_Company, Service_Code) unique;
//                                 tracks Used_Count, Last_Used, First_Used,
//                                 Last_Order_ID. Drives suggestion ranking.
//   - Customer_Service_Overrides: optional admin pin/hide table (not yet
//                                 wired — Phase 6c MVP uses history only).

const express = require('express');
const router = express.Router();
const { fetchAllCaspioPages, makeCaspioRequest } = require('../utils/caspio');

// Per-company suggestion cache. 5-min TTL keeps the rail snappy when a rep
// switches between rows on the same order, without staling out for long.
const suggestionsCache = new Map();
const CACHE_TTL = 5 * 60 * 1000;

// Normalize a company name to the canonical form we store in the table.
// Trim + lowercase to dodge the trailing-whitespace + casing gotchas Erik
// flagged in MEMORY.md (composite-key tables collapse trailing whitespace).
function normCompany(s) {
    return String(s || '').trim().toLowerCase();
}

// ============================================================================
// GET /api/order-form/customer-suggestions
// Query params:
//   - company   : Customer name (required) — case + whitespace insensitive
//   - limit     : Max codes to return (default 10, max 50)
//   - refresh   : Set "true" to bypass cache
//
// Response:
//   {
//     success: true,
//     customer: "ACME Corp",
//     normalized: "acme corp",
//     matched: true | false,    // false when company has no history
//     count: <n>,
//     suggestions: [
//       { code: "EMB-METALLIC", usedCount: 14, lastUsed: "2026-04-21 ...",
//         firstUsed: "...", lastOrderId: "OF-0421" },
//       ...
//     ],
//     source: "caspio" | "cache"
//   }
// ============================================================================
router.get('/order-form/customer-suggestions', async (req, res) => {
    const company = String(req.query.company || '');
    const limitRaw = parseInt(req.query.limit) || 10;
    const limit = Math.max(1, Math.min(50, limitRaw));
    const forceRefresh = req.query.refresh === 'true';

    if (!company.trim()) {
        return res.status(400).json({
            success: false,
            error: 'company query param is required',
        });
    }

    const norm = normCompany(company);
    const cacheKey = `${norm}|${limit}`;
    const cached = suggestionsCache.get(cacheKey);
    if (!forceRefresh && cached && Date.now() - cached.timestamp < CACHE_TTL) {
        return res.json({ ...cached.data, source: 'cache' });
    }

    try {
        // Single-quote escape for Caspio q.where string literal.
        const safeCompany = norm.replace(/'/g, "''");
        const records = await fetchAllCaspioPages('/tables/Customer_Service_History/records', {
            'q.where': `Customer_Company='${safeCompany}'`,
            'q.orderby': 'Used_Count DESC, Last_Used DESC',
            'q.limit': String(limit),
        });

        const suggestions = (records || []).slice(0, limit).map(r => ({
            code: r.Service_Code,
            usedCount: Number(r.Used_Count) || 0,
            lastUsed: r.Last_Used || null,
            firstUsed: r.First_Used || null,
            lastOrderId: r.Last_Order_ID || null,
        }));

        const payload = {
            success: true,
            customer: company,
            normalized: norm,
            matched: suggestions.length > 0,
            count: suggestions.length,
            suggestions,
            source: 'caspio',
        };

        suggestionsCache.set(cacheKey, { data: payload, timestamp: Date.now() });
        res.json(payload);
    } catch (error) {
        console.error('[Customer Suggestions] Error fetching from Caspio:', error.message);
        // Fallback to stale cache if available — better to show old data than nothing
        if (cached) {
            return res.json({ ...cached.data, source: 'stale-cache', warning: error.message });
        }
        res.status(500).json({
            success: false,
            error: 'Failed to fetch customer suggestions',
            details: error.message,
        });
    }
});

// ============================================================================
// POST /api/order-form/customer-suggestions/history
// Upsert one row of Customer_Service_History after a successful order push.
// Called from the Pricing Index project's server.js submit handler — wrap
// in try/catch on the caller side so a tracking failure NEVER blocks the
// order push.
//
// Body: {
//   company:     "ACME Corp",            // required
//   serviceCode: "EMB-METALLIC",          // required
//   orderId:     "OF-0421",               // optional but recommended
// }
//
// Response: { success, action: "inserted" | "updated", record: {...} }
// ============================================================================
router.post('/order-form/customer-suggestions/history', async (req, res) => {
    const { company, serviceCode, orderId } = req.body || {};

    if (!company || !serviceCode) {
        return res.status(400).json({
            success: false,
            error: 'company and serviceCode are required',
        });
    }

    const norm = normCompany(company);
    const safeCompany = norm.replace(/'/g, "''");
    const safeCode = String(serviceCode).replace(/'/g, "''");
    const nowIso = new Date().toISOString().replace('T', ' ').slice(0, 19);

    try {
        // 1. Look up existing row (composite (Customer_Company, Service_Code))
        const existing = await fetchAllCaspioPages('/tables/Customer_Service_History/records', {
            'q.where': `Customer_Company='${safeCompany}' AND Service_Code='${safeCode}'`,
        });

        if (existing && existing.length > 0) {
            // Update — bump Used_Count + Last_Used + Last_Order_ID
            const row = existing[0];
            const nextCount = (Number(row.Used_Count) || 0) + 1;
            const updates = {
                Used_Count: nextCount,
                Last_Used: nowIso,
                ...(orderId ? { Last_Order_ID: String(orderId) } : {}),
            };
            await makeCaspioRequest(
                'put',
                '/tables/Customer_Service_History/records',
                { 'q.where': `Customer_Company='${safeCompany}' AND Service_Code='${safeCode}'` },
                updates,
            );
            // Invalidate the suggestion cache for this company
            for (const key of suggestionsCache.keys()) {
                if (key.startsWith(norm + '|')) suggestionsCache.delete(key);
            }
            return res.json({
                success: true,
                action: 'updated',
                record: { ...row, ...updates },
            });
        }

        // 2. Insert new row
        const newRow = {
            Customer_Company: norm,
            Service_Code: serviceCode,
            Used_Count: 1,
            First_Used: nowIso,
            Last_Used: nowIso,
            Last_Order_ID: orderId ? String(orderId) : '',
        };
        await makeCaspioRequest('post', '/tables/Customer_Service_History/records', {}, newRow);
        // Invalidate cache
        for (const key of suggestionsCache.keys()) {
            if (key.startsWith(norm + '|')) suggestionsCache.delete(key);
        }
        res.status(201).json({
            success: true,
            action: 'inserted',
            record: newRow,
        });
    } catch (error) {
        console.error('[Customer Suggestions] Upsert failed:', error.message);
        res.status(500).json({
            success: false,
            error: 'Failed to upsert customer service history',
            details: error.message,
        });
    }
});

// ============================================================================
// GET /api/order-form/customer-suggestions/cache/clear
// Admin convenience — clear the suggestion cache. Useful after a manual
// Caspio table edit or when debugging.
// ============================================================================
router.get('/order-form/customer-suggestions/cache/clear', (_req, res) => {
    suggestionsCache.clear();
    res.json({ success: true, message: 'Customer suggestions cache cleared' });
});

module.exports = router;
