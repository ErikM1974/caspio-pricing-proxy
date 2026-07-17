// shopworks-odbc-sync.js — direct ShopWorks OnSite → Caspio ORDER_ODBC sync.
//
// Replaces the legacy chain: bandit CSV export → OneDrive → Caspio DataHub import.
// A PowerShell agent on BANDIT (shop LAN, has the FileMaker ODBC driver) pulls
// Orders rows changed since its last run and POSTs them here in batches; this
// route is the ONLY thing that writes them into Caspio.
//
//   POST /api/shopworks-odbc/sync-orders   (x-crm-api-secret) — batch upsert
//   GET  /api/shopworks-odbc/health                            — watchdog read
//   POST /api/shopworks-odbc/health/alert                      — health + Slack DM on !ok
//
// DESIGN RULES (memory/SHOPWORKS_ODBC_INTEGRATION.md in the pricing-index repo):
//  - Upsert key = ID_Order (UNIQUE in ORDER_ODBC).
//  - Only the ODBC_FIELDS whitelist is ever written. The 13 Caspio-side
//    enrichment columns (Codereadr_*, Comment, Cust_Rating, SalesRep2026,
//    Rep_Email, Sales_Rep_Email, UserID_Bigin, ORDER_TYPE_1, LATE_STATUS_MESSAGE)
//    are NEVER touched — other systems own them. ORDER_TYPE is a Caspio formula.
//  - ShopWorks is source-of-truth for whitelisted fields → full overwrite on
//    update (NOT fill-only-empty; totals/dates/notes legitimately change).
//  - '' → null on Date/Time fields (Caspio 400s on empty-string dates).
//  - Heartbeat row in Sync_Heartbeats on every successful batch (even 0 rows)
//    so the watchdog can tell "agent dead" from "quiet afternoon".

const express = require('express');
const axios = require('axios');
const router = express.Router();
const config = require('../../config');
const { getCaspioAccessToken } = require('../utils/caspio');
const { sendSlackDM } = require('../utils/slack-dm-notify');

const caspioApiBaseUrl = config.caspio.apiBaseUrl;
const TABLE_ORDERS = 'ORDER_ODBC';
const TABLE_HEARTBEATS = 'Sync_Heartbeats';
const SYNC_NAME = 'shopworks-odbc-orders';
const ALERT_EMAIL = 'erik@nwcustomapparel.com';
const STALE_MINUTES = 45;          // agent runs every 15 min; 3 misses = stale
const MAX_ROWS_PER_CALL = 1000;    // agent batches well below this

// The 33 ODBC-sourced columns (Caspio names == FileMaker names, 1:1).
// ID_Order is the key; the rest are payload.
const ODBC_FIELDS = [
    'ID_Order', 'ID_Contact', 'id_Customer', 'id_OrderType', 'id_EmpCreatedBy',
    'date_OrderPlaced', 'date_OrderRequestedToShip', 'date_OrderDropDead',
    'date_OrderInvoiced', 'date_Stamp_Invoiced',
    'CompanyName', 'ct_ContactNameFull', 'ContactEmail', 'ContactLast',
    'ContactFirst', 'ContactPhone', 'ContactTitle',
    'Invoice_AddressBlock_Billing', 'Invoice_AddressBlock_Shipping',
    'CustomerServiceRep', 'CustomerType', 'CustomerPurchaseOrder', 'TermsName',
    'NotesOnOrder', 'NotesToProduction', 'NotesToAccounting',
    'sts_Invoiced', 'sts_Shipped',
    'cur_Subtotal', 'cur_Taxable01', 'cur_Shipping',
    'cnCur_TotalInvoice', 'cnCur_SalesTaxTotal'
];
// Keep only whitelisted fields; blank dates → null (Caspio Date/Time 400s on '').
function sanitizeRow(raw) {
    const row = {};
    for (const f of ODBC_FIELDS) {
        if (!(f in raw)) continue;
        let v = raw[f];
        if (v === '') v = null; // esp. Date/Time fields — Caspio 400s on ''
        row[f] = v;
    }
    return row;
}

// PUT-by-key first (1 call for the common case); 0 RecordsAffected → INSERT.
async function upsertOrder(token, row) {
    const idOrder = parseInt(row.ID_Order, 10);
    if (!Number.isInteger(idOrder)) throw new Error('bad ID_Order: ' + row.ID_Order);

    const payload = Object.assign({}, row);
    delete payload.ID_Order; // never rewrite the key on update

    const putResp = await axios.put(
        `${caspioApiBaseUrl}/tables/${TABLE_ORDERS}/records`,
        payload,
        {
            headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
            params: { 'q.where': `ID_Order=${idOrder}` },
            timeout: 15000
        }
    );
    const affected = (putResp.data && putResp.data.RecordsAffected) || 0;
    if (affected > 0) return 'updated';

    // Caspio DELETE/PUT no-match = 200 with RecordsAffected:0 — this is the insert path.
    await axios.post(
        `${caspioApiBaseUrl}/tables/${TABLE_ORDERS}/records`,
        Object.assign({ ID_Order: idOrder }, payload),
        {
            headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
            timeout: 15000
        }
    );
    return 'inserted';
}

// Heartbeat timestamps: written WITHOUT trailing 'Z' (Caspio timestamp fields
// reject/mangle it — see caspio_pacific_timestamps.md). We write UTC wall-clock
// and read it back on a UTC dyno, so age math is consistent in production.
function utcStamp() {
    return new Date().toISOString().slice(0, 19);
}

async function stampHeartbeat(token, rows, summary) {
    const data = { Last_Success: utcStamp(), Last_Rows: rows, Last_Summary: String(summary).slice(0, 250) };
    const putResp = await axios.put(
        `${caspioApiBaseUrl}/tables/${TABLE_HEARTBEATS}/records`,
        data,
        {
            headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
            params: { 'q.where': `Sync_Name='${SYNC_NAME}'` },
            timeout: 15000
        }
    );
    if (((putResp.data && putResp.data.RecordsAffected) || 0) === 0) {
        await axios.post(
            `${caspioApiBaseUrl}/tables/${TABLE_HEARTBEATS}/records`,
            Object.assign({ Sync_Name: SYNC_NAME }, data),
            { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, timeout: 15000 }
        );
    }
}

/**
 * POST /api/shopworks-odbc/sync-orders
 * Body: { rows: [ { ID_Order, date_OrderPlaced, ... } ] }  (rows: [] is a valid
 * "I ran, nothing changed" heartbeat ping from the agent.)
 * Auth: x-crm-api-secret (mounted in server.js).
 */
router.post('/shopworks-odbc/sync-orders', async (req, res) => {
    try {
        const rows = (req.body && req.body.rows) || null;
        if (!Array.isArray(rows)) {
            return res.status(400).json({ success: false, error: 'Body must be { rows: [...] }' });
        }
        if (rows.length > MAX_ROWS_PER_CALL) {
            return res.status(400).json({ success: false, error: `Max ${MAX_ROWS_PER_CALL} rows per call — batch on the agent side` });
        }

        const token = await getCaspioAccessToken();
        let updated = 0, inserted = 0, errored = 0;
        const errors = [];

        for (const raw of rows) {
            const row = sanitizeRow(raw);
            if (row.ID_Order == null) {
                errored++;
                errors.push({ error: 'missing ID_Order' });
                continue;
            }
            try {
                const action = await upsertOrder(token, row);
                if (action === 'inserted') inserted++; else updated++;
            } catch (rowErr) {
                errored++;
                const detail = rowErr.response ? JSON.stringify(rowErr.response.data) : rowErr.message;
                errors.push({ ID_Order: row.ID_Order, error: detail.slice(0, 300) });
                console.error(`[odbc-sync] row ${row.ID_Order} failed:`, detail);
            }
        }

        const summary = `${inserted} inserted, ${updated} updated, ${errored} errored of ${rows.length}`;
        // Heartbeat only when the batch was materially healthy — an all-errors
        // batch must NOT look like a success to the watchdog.
        if (errored === 0 || errored < rows.length) {
            try { await stampHeartbeat(token, rows.length, summary); }
            catch (hbErr) { console.warn('[odbc-sync] heartbeat write failed:', hbErr.message); }
        }

        console.log(`[odbc-sync] ${summary}`);
        res.json({ success: errored === 0, summary: { inserted, updated, errored, total: rows.length }, errors });
    } catch (error) {
        console.error('[odbc-sync] batch failed:', error.response ? JSON.stringify(error.response.data) : error.message);
        res.status(500).json({ success: false, error: 'Sync failed: ' + error.message });
    }
});

async function computeHealth() {
    const token = await getCaspioAccessToken();
    const resp = await axios.get(
        `${caspioApiBaseUrl}/tables/${TABLE_HEARTBEATS}/records?q.where=Sync_Name='${SYNC_NAME}'`,
        { headers: { Authorization: `Bearer ${token}` }, timeout: 15000 }
    );
    const hb = (resp.data.Result || [])[0] || null;
    if (!hb || !hb.Last_Success) {
        return { ok: false, reason: 'no-heartbeat-ever', lastSuccess: null, ageMin: null };
    }
    // Stored without 'Z' as UTC wall-clock; parse as UTC explicitly so this
    // also reads correctly on non-UTC dev machines.
    const last = Date.parse(String(hb.Last_Success).replace(/Z?$/, 'Z'));
    const ageMin = Math.round((Date.now() - last) / 60000);
    return {
        ok: ageMin <= STALE_MINUTES,
        reason: ageMin <= STALE_MINUTES ? 'fresh' : `stale-${ageMin}min`,
        lastSuccess: hb.Last_Success,
        ageMin,
        lastRows: hb.Last_Rows,
        lastSummary: hb.Last_Summary
    };
}

/**
 * GET /api/shopworks-odbc/health — read-only watchdog view (humans + cron).
 */
router.get('/shopworks-odbc/health', async (req, res) => {
    try {
        const result = await computeHealth();
        res.json({ success: true, ...result });
    } catch (error) {
        console.error('[odbc-sync] health failed:', error.message);
        res.status(500).json({ success: false, ok: false, error: 'Health check failed: ' + error.message });
    }
});

// In-process alert dedup — at most one DM per 4h while broken (same pattern as
// the Supacolor watchdog). Dyno restart resets it; worst case one extra DM.
let lastAlertAt = 0;
const ALERT_TTL_MS = 4 * 60 * 60 * 1000;

/**
 * POST /api/shopworks-odbc/health/alert — health + Slack DM to Erik when !ok.
 * Called by a Heroku Scheduler script every ~30 min.
 */
router.post('/shopworks-odbc/health/alert', async (req, res) => {
    try {
        const result = await computeHealth();
        let notify = { sent: false, skipped: 'ok' };
        if (!result.ok) {
            if (Date.now() - lastAlertAt > ALERT_TTL_MS) {
                notify = await sendSlackDM(ALERT_EMAIL,
                    `:warning: *ShopWorks ODBC order sync is STALE* — last successful sync ` +
                    `${result.lastSuccess || 'NEVER'} (${result.ageMin == null ? 'n/a' : result.ageMin + ' min ago'}). ` +
                    `Check bandit (power? Task Scheduler? ODBC listener?). ` +
                    `Health: /api/shopworks-odbc/health`);
                if (notify.sent) lastAlertAt = Date.now();
            } else {
                notify = { sent: false, skipped: 'deduped-4h' };
            }
        }
        res.json({ success: true, ...result, notify });
    } catch (error) {
        console.error('[odbc-sync] health alert failed:', error.message);
        res.status(500).json({ success: false, ok: false, error: 'Health alert failed: ' + error.message });
    }
});

module.exports = router;
