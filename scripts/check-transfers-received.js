/**
 * check-transfers-received.js — polling cron that mirrors the (defunct)
 * "Mikalah Receives Transfers → Slack Team" Zap.
 *
 * Why a polling cron instead of a code-path hook: the source-of-truth write
 * to PurchaseOrders.date_Received does not happen in this codebase. It comes
 * from a ShopWorks sync that we don't own. A polling cron is robust to
 * however that sync writes — we just check Caspio periodically and fire on
 * anything we haven't already notified about.
 *
 * Logic:
 *   1. SELECT PurchaseOrders WHERE id_Vendor=2708
 *      AND date_Received IS NOT NULL
 *      AND date_Received >= today-LOOKBACK_DAYS  (avoid spamming on backlog)
 *      AND (Slack_Notified IS NULL OR Slack_Notified='')
 *   2. For each row:
 *      - Enrich via GET /api/manageorders/orders/{id_Order} (CustomerName, CustomerServiceRep)
 *      - notifyTransferReceived(...)
 *      - On success: PUT PurchaseOrders.Slack_Notified='true'
 *
 * Heroku Scheduler command: `npm run check-transfers-received`
 * Recommended interval: every 5 minutes.
 *
 * Activation requires `SLACK_TRANSFER_RECEIVED_WEBHOOK_URL` env on Heroku.
 * Without it the cron runs but the notify is a no-op (skipped='no-webhook') —
 * useful for staging or for shipping the cron before the channel exists.
 *
 * Backlog protection: LOOKBACK_DAYS limits the candidate set to recent
 * receipts. To suppress historical receipts entirely on first run, set
 * Slack_Notified='true' on existing rows via Caspio Datasheet or a one-off
 * SQL update before enabling the scheduler.
 */

require('dotenv').config();

const axios = require('axios');
const { getCaspioAccessToken, fetchAllCaspioPages } = require('../src/utils/caspio');
const { notifyTransferReceived } = require('../src/utils/slack-transfer-received-notify');
const config = require('../config');

const SUPACOLOR_VENDOR_ID = 2708;
const LOOKBACK_DAYS = parseInt(process.env.TRANSFERS_RECEIVED_LOOKBACK_DAYS || '14', 10);
const MAX_BATCH = parseInt(process.env.TRANSFERS_RECEIVED_MAX_BATCH || '50', 10);
const PROXY_BASE = process.env.PROXY_BASE_URL
    || 'https://caspio-pricing-proxy-ab30a049961a.herokuapp.com';

function isoDateNDaysAgo(n) {
    const d = new Date();
    d.setDate(d.getDate() - n);
    return d.toISOString().slice(0, 10); // YYYY-MM-DD
}

async function fetchEnrichment(idOrder) {
    if (idOrder == null || idOrder === '') return null;
    try {
        const url = `${PROXY_BASE}/api/manageorders/orders/${encodeURIComponent(idOrder)}`;
        // PII-gated read (requireCrmApiSecret, v878) — without the header this 401s
        // and Slack messages silently lose customer/rep enrichment.
        const { data } = await axios.get(url, {
            timeout: 15000,
            headers: { 'x-crm-api-secret': process.env.CRM_API_SECRET || '' }
        });
        // Endpoint shape: { result: [order], count, cached }
        const order = Array.isArray(data && data.result) && data.result.length > 0
            ? data.result[0]
            : null;
        if (!order) return null;
        return {
            CustomerName: order.CustomerName || '',
            CustomerServiceRep: order.CustomerServiceRep || ''
        };
    } catch (err) {
        console.warn(`[CHECK_TRANSFERS_RECEIVED] enrichment failed for id_Order=${idOrder}:`, err.message);
        return null;
    }
}

async function setSlackNotified(idPo, token) {
    const url = `${config.caspio.apiBaseUrl}/tables/PurchaseOrders/records?q.where=ID_PO=${encodeURIComponent(idPo)}`;
    await axios.put(url, { Slack_Notified: 'true' }, {
        headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json'
        },
        timeout: 15000
    });
}

async function main() {
    const startedAt = Date.now();
    console.log(`[CHECK_TRANSFERS_RECEIVED] starting (lookback=${LOOKBACK_DAYS}d, max-batch=${MAX_BATCH})`);

    const lookbackIso = isoDateNDaysAgo(LOOKBACK_DAYS);
    const where = `id_Vendor=${SUPACOLOR_VENDOR_ID}`
        + ` AND date_Received IS NOT NULL`
        + ` AND date_Received>='${lookbackIso}'`
        + ` AND (Slack_Notified IS NULL OR Slack_Notified='')`;

    const rows = await fetchAllCaspioPages('/tables/PurchaseOrders/records', {
        'q.where': where,
        'q.select': 'ID_PO,id_Order,date_Received,id_Vendor',
        'q.orderBy': 'date_Received DESC',
        'q.pageSize': 1000
    });

    const candidates = rows.slice(0, MAX_BATCH);
    console.log(`[CHECK_TRANSFERS_RECEIVED] candidates=${rows.length}, processing=${candidates.length}`);

    if (candidates.length === 0) {
        console.log('[CHECK_TRANSFERS_RECEIVED] nothing to do');
        return;
    }

    const token = await getCaspioAccessToken();
    let sent = 0;
    let failed = 0;
    let skipped = 0;

    for (const row of candidates) {
        try {
            const enrichment = await fetchEnrichment(row.id_Order);

            const result = await notifyTransferReceived({
                ID_PO: row.ID_PO,
                id_Order: row.id_Order,
                date_Received: row.date_Received,
                CustomerName: enrichment ? enrichment.CustomerName : '',
                CustomerServiceRep: enrichment ? enrichment.CustomerServiceRep : ''
            });

            if (result.sent) {
                await setSlackNotified(row.ID_PO, token);
                sent++;
            } else if (result.skipped === 'no-webhook') {
                // Env not set — leave Slack_Notified empty so the next run picks it up
                // when the env is added.
                skipped++;
            } else if (result.skipped === 'dedup') {
                // In-process dedup — don't mark Slack_Notified, will be revisited next run.
                skipped++;
            } else if (result.error) {
                failed++;
            } else {
                // Other skip reasons (missing-id-po) — mark notified to avoid revisiting bad data.
                await setSlackNotified(row.ID_PO, token);
                skipped++;
            }
        } catch (err) {
            failed++;
            console.error(`[CHECK_TRANSFERS_RECEIVED] error for ID_PO=${row.ID_PO}:`, err.message);
        }
    }

    const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
    console.log(`[CHECK_TRANSFERS_RECEIVED] complete: sent=${sent}, failed=${failed}, skipped=${skipped} (elapsed=${elapsed}s)`);
}

main()
    .then(() => process.exit(0))
    .catch(err => {
        console.error('[CHECK_TRANSFERS_RECEIVED] fatal:', err.message);
        if (err.response) {
            console.error('  response status:', err.response.status);
            console.error('  response body:', JSON.stringify(err.response.data).slice(0, 500));
        }
        process.exit(1);
    });
