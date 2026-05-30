// Credit-Card Reconciliation Lookups
//
// Read-only endpoints that feed the InkSoft "Atmos Credit Card Formatter":
//   GET /api/vendors                              — vendor master (tbl_vendor_basics)
//   GET /api/purchase-orders?vendorIds=&sinceDate= — POs scoped to specific vendors (PurchaseOrders)
//   GET /api/supacolor-po-index?sinceDate=        — lean Supacolor_Jobs rows for amount->PO matching
//
// The formatter matches each Bank-of-America card charge to a vendor (by Payee) and,
// for production vendors, to a ShopWorks Purchase Order (by amount + date) so the
// cleaned CSV carries a PONumber. PurchaseOrders is large (100k+), so PO reads MUST be
// vendor-scoped — never fetch the whole table. Mirrors the read pattern in designs.js
// and getSupacolorPoEnrichmentMap() in supacolor-jobs.js.

const express = require('express');
const router = express.Router();
const { fetchAllCaspioPages } = require('../utils/caspio');

const TABLE_VENDORS = 'tbl_vendor_basics';
const TABLE_POS = 'PurchaseOrders';
const TABLE_SUPACOLOR_JOBS = 'Supacolor_Jobs';

// YYYY-MM-DD guard for the optional date floor (prevents SQL injection in q.where).
function safeIsoDate(s) {
    return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
}

/**
 * GET /api/vendors
 * Returns the full vendor master so the formatter can match BoA descriptions
 * against the Payee column. ~457 rows = one page. NOT cached — the list is tiny and
 * the formatter reads it once per run, so a cache only delays newly-added vendors.
 */
router.get('/vendors', async (req, res) => {
    try {
        const rows = await fetchAllCaspioPages(`/tables/${TABLE_VENDORS}/records`, {
            'q.select': 'ID_Vendor,VendorName,Payee',
            'q.limit': 1000
        });
        res.json({ success: true, count: rows.length, vendors: rows });
    } catch (error) {
        console.error('Error fetching vendors:', error.message);
        res.status(500).json({ success: false, error: 'Failed to fetch vendors: ' + error.message });
    }
});

/**
 * GET /api/purchase-orders?vendorIds=2708,1002&sinceDate=2026-01-15
 * Returns POs for the given vendors only (scoped — the table is huge). Optional
 * sinceDate floors on date_POIssued (every PO has one) to bound the largest vendors.
 * Amount fields (TotalInvoice, Subtotal) let the formatter match a charge to a PO.
 */
router.get('/purchase-orders', async (req, res) => {
    try {
        const ids = String(req.query.vendorIds || '')
            .split(',')
            .map(s => s.trim())
            .filter(s => /^\d+$/.test(s));
        if (!ids.length) {
            return res.status(400).json({ success: false, error: 'vendorIds query param required (comma-separated integers)' });
        }
        const since = safeIsoDate(req.query.sinceDate);

        const all = [];
        for (const vid of ids) {
            let where = `id_Vendor=${vid}`;
            if (since) where += ` AND date_POIssued>='${since}'`;
            const rows = await fetchAllCaspioPages(`/tables/${TABLE_POS}/records`, {
                'q.where': where,
                'q.select': 'ID_PO,id_Vendor,VendorName,TotalInvoice,Subtotal,date_POIssued,date_Received',
                'q.limit': 1000
            });
            all.push(...rows);
        }
        res.json({ success: true, count: all.length, vendorIds: ids, purchaseOrders: all });
    } catch (error) {
        console.error('Error fetching purchase orders:', error.message);
        res.status(500).json({ success: false, error: 'Failed to fetch purchase orders: ' + error.message });
    }
});

/**
 * GET /api/supacolor-po-index?sinceDate=2026-01-15
 * Lean Supacolor_Jobs rows (amount + PO_Number + dates). Supacolor charges the card
 * per job, so the job Total/Subtotal is what hits the statement, and PO_Number ("112759 BW")
 * maps to PurchaseOrders.ID_PO. The table is small (~1k rows) so we fetch it whole; sinceDate
 * is optional and filters on Date_Entered when supplied (note: skips rows with a null Date_Entered).
 */
router.get('/supacolor-po-index', async (req, res) => {
    try {
        const since = safeIsoDate(req.query.sinceDate);
        const params = {
            'q.select': 'PO_Number,Subtotal,Tax_Total,Total,Date_Entered,Date_Shipped',
            'q.limit': 1000
        };
        if (since) params['q.where'] = `Date_Entered>='${since}'`;
        const rows = await fetchAllCaspioPages(`/tables/${TABLE_SUPACOLOR_JOBS}/records`, params);
        res.json({ success: true, count: rows.length, jobs: rows });
    } catch (error) {
        console.error('Error fetching supacolor PO index:', error.message);
        res.status(500).json({ success: false, error: 'Failed to fetch supacolor PO index: ' + error.message });
    }
});

module.exports = router;
