// Credit-Card Reconciliation Lookups
//
// Read-only endpoints that feed the InkSoft "Atmos Credit Card Formatter":
//   GET /api/vendors                              — vendor master (tbl_vendor_basics)
//   GET /api/purchase-orders?vendorIds=&sinceDate= — POs scoped to specific vendors (PurchaseOrders)
//   GET /api/supacolor-po-index?sinceDate=        — lean Supacolor_Jobs rows for amount->PO matching
//   POST /api/creditcard-atmos/upsert             — upsert cleaned charges into CreditCard_NWCA_ATMOS by Reference_ID
//
// The formatter matches each Bank-of-America card charge to a vendor (by Payee) and,
// for production vendors, to a ShopWorks Purchase Order (by amount + date) so the
// cleaned CSV carries a PONumber. PurchaseOrders is large (100k+), so PO reads MUST be
// vendor-scoped — never fetch the whole table. Mirrors the read pattern in designs.js
// and getSupacolorPoEnrichmentMap() in supacolor-jobs.js.

const express = require('express');
const router = express.Router();
const axios = require('axios');
const { getCaspioAccessToken, fetchAllCaspioPages } = require('../utils/caspio');
const config = require('../../config');

const caspioApiBaseUrl = config.caspio.apiBaseUrl;
const TABLE_VENDORS = 'tbl_vendor_basics';
const TABLE_POS = 'PurchaseOrders';
const TABLE_SUPACOLOR_JOBS = 'Supacolor_Jobs';
const TABLE_CC = 'CreditCard_NWCA_ATMOS';

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

// ── Upsert into CreditCard_NWCA_ATMOS by Reference_ID ──────────────────
//
// POST /api/creditcard-atmos/upsert  body: { rows: [...formatter rows...], dryRun: bool }
//
// The formatter's "Push to Caspio" button calls this. Each row is matched to an existing
// record by Reference_ID (the bare BoA reference number): found -> PUT (update), else POST
// (insert). Safeguards:
//   - id_Vendor is a Caspio FORMULA field -> never written (Caspio rejects it).
//   - GL_Account and (on update) Reconciled are NEVER overwritten -> human edits preserved.
//   - Never deletes. Rows with a blank Reference_ID are skipped (can't dedup).
// Writes run in small parallel batches to stay well under Heroku's 30s request limit.

const CC_WRITE_BATCH = 6;          // concurrent Caspio writes per batch
const CC_DELETE_ME_PREFIX = '';    // (reserved)

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function isCaspioRateLimit(err) {
    const d = err && err.response && err.response.data;
    if (!d) return false;
    const s = typeof d === 'string' ? d : JSON.stringify(d);
    return s.indexOf('api-calls-rate') !== -1 || s.toLowerCase().indexOf('rate limit') !== -1;
}

async function ccWriteWithRetry(fn, maxRetries = 3) {
    let attempt = 0;
    while (true) {
        try { return await fn(); }
        catch (err) {
            if (!isCaspioRateLimit(err) || attempt >= maxRetries) throw err;
            await sleep(1000 * Math.pow(2, attempt));
            attempt++;
        }
    }
}

// 'M/D/YYYY' -> 'YYYY-MM-DD' (Caspio Date/Time). Returns null if unparseable.
function mdyToIso(s) {
    const m = String(s || '').trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
    return m ? `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}` : null;
}

// Build a Caspio-typed payload from a formatter row. Excludes id_Vendor (formula) and
// GL_Account (preserved). Reconciled is set only on insert (preserved on update).
function ccPayload(row, isInsert) {
    const p = {};
    const pd = mdyToIso(row.PayableDate); if (pd) p.PayableDate = pd;
    const dd = mdyToIso(row.PayableDueDateOverride); if (dd) p.PayableDueDateOverride = dd;
    if (row.InvoiceNumber != null) p.InvoiceNumber = String(row.InvoiceNumber);
    const amt = parseFloat(String(row.Amount == null ? '' : row.Amount).replace(/[$,]/g, ''));
    if (!isNaN(amt)) p.Amount = amt;
    if (row.Vendor_Charged_To != null) p.Vendor_Charged_To = String(row.Vendor_Charged_To);
    const vc = String(row.id_Vendor_Charge == null ? '' : row.id_Vendor_Charge).trim();
    if (/^\d+$/.test(vc)) p.id_Vendor_Charge = parseInt(vc, 10);
    if (row.PONumber != null) p.PONumber = String(row.PONumber);
    if (row.Month_Reconciled != null) p.Month_Reconciled = String(row.Month_Reconciled);
    p.Reference_ID = String(row.Reference_ID || '');
    if (isInsert) p.Reconciled = String(row.Reconciled).toLowerCase() === 'yes';
    return p;
}

router.post('/creditcard-atmos/upsert', async (req, res) => {
    const rows = (req.body && req.body.rows) || [];
    const dryRun = !!(req.body && req.body.dryRun);
    if (!Array.isArray(rows) || rows.length === 0) {
        return res.status(400).json({ success: false, error: 'Body must be { rows: [...], dryRun }' });
    }
    try {
        // One bulk read of existing non-blank Reference_IDs (the table is mostly blank-ref
        // historically, so this set is small and grows only as we insert).
        const existingRows = await fetchAllCaspioPages(`/tables/${TABLE_CC}/records`, {
            'q.where': "Reference_ID IS NOT NULL AND Reference_ID<>''",
            'q.select': 'Reference_ID',
            'q.pageSize': 1000
        });
        const existingRefs = new Set(existingRows.map(r => String(r.Reference_ID)));

        // Classify
        let skipped = 0;
        const inserts = [], updates = [];
        const seenInBatch = new Set();
        for (const row of rows) {
            const ref = String(row.Reference_ID || '').trim();
            if (!ref) { skipped++; continue; }
            if (existingRefs.has(ref) || seenInBatch.has(ref)) updates.push(row);
            else { inserts.push(row); seenInBatch.add(ref); }
        }

        if (dryRun) {
            return res.json({
                success: true, dryRun: true, total: rows.length,
                toInsert: inserts.length, toUpdate: updates.length, skipped
            });
        }

        const token = await getCaspioAccessToken();
        const errors = [];
        let inserted = 0, updated = 0;

        async function runBatched(list, fn) {
            for (let i = 0; i < list.length; i += CC_WRITE_BATCH) {
                const batch = list.slice(i, i + CC_WRITE_BATCH);
                const results = await Promise.allSettled(batch.map(fn));
                results.forEach((r, j) => {
                    if (r.status === 'rejected') {
                        const e = r.reason;
                        errors.push({
                            ref: String(batch[j].Reference_ID || ''),
                            error: e.response ? JSON.stringify(e.response.data) : e.message
                        });
                    }
                });
            }
        }

        await runBatched(updates, async (row) => {
            const ref = String(row.Reference_ID).replace(/'/g, "''");
            await ccWriteWithRetry(() => axios.put(
                `${caspioApiBaseUrl}/tables/${TABLE_CC}/records?q.where=Reference_ID='${ref}'`,
                ccPayload(row, false),
                { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, timeout: 15000 }
            ));
            updated++;
        });

        await runBatched(inserts, async (row) => {
            await ccWriteWithRetry(() => axios.post(
                `${caspioApiBaseUrl}/tables/${TABLE_CC}/records`,
                ccPayload(row, true),
                { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, timeout: 15000 }
            ));
            inserted++;
        });

        res.json({
            success: errors.length === 0, dryRun: false, total: rows.length,
            inserted, updated, skipped, errorCount: errors.length, errors: errors.slice(0, 20)
        });
    } catch (error) {
        console.error('Error upserting credit-card charges:', error.response ? JSON.stringify(error.response.data) : error.message);
        res.status(500).json({ success: false, error: 'Upsert failed: ' + error.message });
    }
});

module.exports = router;
