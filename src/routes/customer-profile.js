// Customer Profile 10yr Routes
//
// Backed by the Caspio table `Customer_Profile_10yr_2026` — one row per
// active SanMar-buying customer with their 10-year aggregated history:
//   - Identity + contact (CustomerCompanyName, phone, email, address, website)
//   - Status flags (Is_Active, Is_Dead, Is_Stale, Is_Tax_Exempt, Customer_Warning)
//   - Rep ownership (Sales_Rep, Account_Owner, Email_Salesrep)
//   - Financial signals (YTD_Sales, Total_Revenue_10yr, Order_Count_10yr,
//     Avg_Order_Size, Avg_Margin_Pct)
//   - Product signals (Top_5_Styles, Top_Style_Top_3_Colors, Top_3_Brands,
//     Last_Style_Bought, Last_Color_Bought, Top_Design_Type)
//   - Behavioral (Last_Order_Date, Reorder_Probability)
//
// Source: scripts/build-customer-profiles-10yr.js — joins contacts CSV ×
// bridge XLSX × SanMar line items. Erik refreshes quarterly.
//
// Endpoints:
//   GET /api/customer-profile/:idCustomer
//       → returns the full profile row for one customer, or 404
//   GET /api/customer-profile/by-company/:name
//       → look up by company name (exact + case-insensitive substring fallback)
//
// Used by: emb-quote-ai.js `lookup_customer_master_profile` tool — the bot
// calls this RIGHT AFTER lookup_customer matches a real customer record.
// Replaces the old lookup_customer_history tool (which only had 1 year of data
// from MO sync). This new endpoint has 10 years.
//
// Created 2026-05-25 — EMB Smart Phase E2.

const express = require('express');
const router = express.Router();
const { fetchAllCaspioPages } = require('../utils/caspio');

const TABLE = 'Customer_Profile_10yr_2026';
const RESOURCE = `/tables/${TABLE}/records`;

// === In-memory cache (4hr TTL — refresh quarterly = data doesn't shift fast) ===
// Two cache stores — one by idCustomer (most common bot lookup), one by company name.
const cacheById = new Map();   // idCustomer (number) → { ts, profile }
const cacheByName = new Map(); // company name (lowercase) → { ts, profile }
const CACHE_TTL_MS = 4 * 60 * 60 * 1000;

function sanitize(v) {
    return String(v || '').replace(/'/g, '');
}

function shapeRow(r) {
    if (!r) return null;
    // Pass through every column — the bot uses most of them. Coerce numerics
    // so JSON consumer doesn't have to. Booleans (Is_*) are Caspio Integers (1/0).
    return {
        id_Customer: Number(r.id_Customer) || 0,
        CustomerCompanyName: r.CustomerCompanyName || '',
        Customer_Type: r.Customer_Type || '',
        Account_Tier: r.Account_Tier || '',
        Sales_Rep: r.Sales_Rep || '',
        Account_Owner: r.Account_Owner || '',
        Email_Salesrep: r.Email_Salesrep || '',
        Is_Active: r.Is_Active === 1 || r.Is_Active === '1' || r.Is_Active === true,
        Is_Dead: r.Is_Dead === 1 || r.Is_Dead === '1' || r.Is_Dead === true,
        Is_Stale: r.Is_Stale === 1 || r.Is_Stale === '1' || r.Is_Stale === true,
        Is_Tax_Exempt: r.Is_Tax_Exempt === 1 || r.Is_Tax_Exempt === '1' || r.Is_Tax_Exempt === true,
        Customer_Warning: r.Customer_Warning || '',
        Payment_Terms: r.Payment_Terms || '',
        CustTerms: r.CustTerms || '',
        Phone_Best: r.Phone_Best || '',
        Email: r.Email || '',
        Address: r.Address || '',
        City: r.City || '',
        State: r.State || '',
        Zip: r.Zip || '',
        Website: r.Website || '',
        YTD_Sales: Number(r.YTD_Sales) || 0,
        Last_Order_Date: r.Last_Order_Date || null,
        Total_Revenue_10yr: Number(r.Total_Revenue_10yr) || 0,
        Order_Count_10yr: Number(r.Order_Count_10yr) || 0,
        Avg_Order_Size: Number(r.Avg_Order_Size) || 0,
        Avg_Margin_Pct: Number(r.Avg_Margin_Pct) || 0,
        Top_Design_Type: r.Top_Design_Type || '',
        Top_5_Styles: r.Top_5_Styles || '',
        Top_Style_Top_3_Colors: r.Top_Style_Top_3_Colors || '',
        Top_3_Brands: r.Top_3_Brands || '',
        Last_Style_Bought: r.Last_Style_Bought || '',
        Last_Color_Bought: r.Last_Color_Bought || '',
        Reorder_Probability: r.Reorder_Probability || '',
    };
}

// === GET /api/customer-profile/:idCustomer ===
router.get('/:idCustomer', async (req, res) => {
    const idCustomer = Number(req.params.idCustomer);
    if (!Number.isInteger(idCustomer) || idCustomer <= 0) {
        return res.status(400).json({ success: false, error: 'idCustomer must be a positive integer' });
    }
    const cached = cacheById.get(idCustomer);
    if (cached && (Date.now() - cached.ts) < CACHE_TTL_MS) {
        return res.json({ success: true, found: true, profile: cached.profile, _source: 'cache', _cachedAt: new Date(cached.ts).toISOString() });
    }

    try {
        const t0 = Date.now();
        const rows = await fetchAllCaspioPages(RESOURCE, {
            'q.where': `id_Customer=${idCustomer}`,
            'q.limit': 5, // Caspio v3 floor; expect exactly 1 row
        });
        if (!rows || !rows.length) {
            return res.json({
                success: true,
                found: false,
                idCustomer,
                message: `No profile found for id_Customer ${idCustomer}. This customer may not have any SanMar purchases in the 10-year history, or may be a brand-new customer.`,
                _source: 'live',
                _elapsedMs: Date.now() - t0,
            });
        }
        const profile = shapeRow(rows[0]);
        cacheById.set(idCustomer, { ts: Date.now(), profile });
        if (profile.CustomerCompanyName) {
            cacheByName.set(profile.CustomerCompanyName.toLowerCase().trim(), { ts: Date.now(), profile });
        }
        res.json({ success: true, found: true, profile, _source: 'live', _elapsedMs: Date.now() - t0 });
    } catch (err) {
        console.error(`[customer-profile] error for id_Customer=${idCustomer}:`, err.message);
        res.status(500).json({ success: false, error: 'Failed to fetch customer profile', details: err.message });
    }
});

// === GET /api/customer-profile/by-company/:name ===
// Substring match (case-insensitive). Returns up to 5 matches.
router.get('/by-company/:name', async (req, res) => {
    const name = sanitize(req.params.name).trim();
    if (name.length < 3) {
        return res.status(400).json({ success: false, error: 'name must be 3+ characters' });
    }
    const cacheKey = name.toLowerCase();
    const cached = cacheByName.get(cacheKey);
    if (cached && (Date.now() - cached.ts) < CACHE_TTL_MS) {
        return res.json({ success: true, found: true, profiles: [cached.profile], _source: 'cache' });
    }
    try {
        const t0 = Date.now();
        const rows = await fetchAllCaspioPages(RESOURCE, {
            'q.where': `CustomerCompanyName LIKE '%${name}%'`,
            'q.orderBy': 'Total_Revenue_10yr DESC',
            'q.limit': 5,
        });
        const profiles = (rows || []).slice(0, 5).map(shapeRow);
        // Cache top match by name for quick repeat
        if (profiles[0]?.CustomerCompanyName) {
            cacheByName.set(profiles[0].CustomerCompanyName.toLowerCase().trim(), { ts: Date.now(), profile: profiles[0] });
        }
        res.json({
            success: true, found: profiles.length > 0, count: profiles.length, profiles,
            _source: 'live', _elapsedMs: Date.now() - t0,
        });
    } catch (err) {
        console.error(`[customer-profile/by-company] error for "${name}":`, err.message);
        res.status(500).json({ success: false, error: 'Failed to search customer profiles', details: err.message });
    }
});

// === Admin: clear cache (for testing after Caspio re-import) ===
router.get('/cache/clear', (req, res) => {
    const n1 = cacheById.size, n2 = cacheByName.size;
    cacheById.clear(); cacheByName.clear();
    res.json({ success: true, cleared: { byId: n1, byName: n2 } });
});

module.exports = router;
