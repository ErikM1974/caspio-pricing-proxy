// slack-transfer-new-order-notify.js — POST a Slack incoming-webhook when
// Steve submits a new NON-screen-print transfer order (DTF, heat-transfer,
// etc.). Targets the #transfer-new-orders channel — Mikhail is the production
// owner, Steve and Erik are also members.
//
// Sister to slack-screenprint-new-order-notify.js — same shape, same call
// site (transfer-orders.js POST handler). The internal Method filter routes
// each new order to exactly one of the two utilities:
//   - Method === 'Screen Print' → notifyScreenprintNewOrder (Bradley channel)
//   - Method !== 'Screen Print' → notifyTransferNewOrder    (Mikhail channel)
//
// Activation: set `SLACK_TRANSFER_NEW_ORDER_WEBHOOK_URL`. Unset = no-op.

const axios = require('axios');

const WEBHOOK_URL = process.env.SLACK_TRANSFER_NEW_ORDER_WEBHOOK_URL || '';
const SITE_ORIGIN = process.env.SITE_ORIGIN || 'https://www.teamnwca.com';
const DEDUP_TTL_MS = 5 * 60 * 1000;
const MAX_DEDUP_ENTRIES = 1000;

const dedupCache = new Map();

function pruneDedupCache(now) {
    for (const [key, expiresAt] of dedupCache.entries()) {
        if (expiresAt <= now) dedupCache.delete(key);
    }
}

function shouldSkipDedup(idTransfer) {
    if (!idTransfer) return false;
    const now = Date.now();
    const expiresAt = dedupCache.get(idTransfer);
    if (expiresAt && expiresAt > now) return true;
    if (dedupCache.size >= MAX_DEDUP_ENTRIES) pruneDedupCache(now);
    dedupCache.set(idTransfer, now + DEDUP_TTL_MS);
    return false;
}

function isTruthy(v) {
    return v === true || v === 'true' || v === 'Yes' || v === 1;
}

function previewNotes(notes) {
    if (!notes) return '';
    return String(notes).trim();
}

function buildText(record, opts) {
    const isRush = isTruthy(record.Is_Rush);
    const requestedByName = (opts && opts.requestedByName)
        || record.Requested_By_Name
        || record.Requested_By
        || 'Steve Deland';

    const designNumber = String(record.Design_Number || '');
    const companyName = String(record.Company_Name || '');
    const method = String(record.Method || '');
    const repName = String(record.Sales_Rep_Name || '');
    const detailUrl = SITE_ORIGIN + '/pages/transfer-detail.html?id=' + encodeURIComponent(record.ID_Transfer);

    let quantity = record.Quantity != null ? String(record.Quantity) : '';
    if (opts && Array.isArray(opts.lines) && opts.lines.length > 0) {
        const total = opts.lines.reduce((sum, l) => {
            const q = parseInt(l.Quantity, 10);
            return sum + (Number.isNaN(q) ? 0 : q);
        }, 0);
        if (total > 0) quantity = String(total);
    }

    const garmentInfo = (opts && opts.garmentInfo) ? String(opts.garmentInfo) : '';
    const fileNotesPreview = previewNotes(record.File_Notes);
    const rushSuffix = isRush ? '  🚨 *RUSH*' : '';

    const lines = [
        `📦 *New Transfer Order*${rushSuffix}`,
        `*Design:* ${designNumber}`,
        `*Company:* ${companyName}`,
        `*Method:* ${method || '(not specified)'}`,
        `*Submitted by:* ${requestedByName}`,
        `*Quantity:* ${quantity || '—'}`,
        garmentInfo ? `*Garment:* ${garmentInfo}` : '',
        repName ? `*Sales Rep:* ${repName}` : '',
        fileNotesPreview ? `\n>${fileNotesPreview.replace(/\n/g, '\n>')}` : '',
        `\n<${detailUrl}|View order details>`
    ];

    return lines.filter(Boolean).join('\n');
}

/**
 * Send a "new transfer order" Slack message (everything that ISN'T screen print).
 *
 * @param {object} record   — the just-created Transfer_Orders row
 * @param {object} [opts]
 * @param {string} [opts.requestedByName]
 * @param {string} [opts.garmentInfo]
 * @param {Array}  [opts.lines]
 * @returns {Promise<{sent, skipped?, error?}>} — resolves rather than throws.
 */
async function notifyTransferNewOrder(record, opts) {
    if (!WEBHOOK_URL) {
        console.log('[SLACK_TRANSFER_NEW_ORDER_SKIP]', 'no-webhook');
        return { sent: false, skipped: 'no-webhook' };
    }
    if (!record || !record.ID_Transfer) {
        console.log('[SLACK_TRANSFER_NEW_ORDER_SKIP]', 'missing-id-transfer');
        return { sent: false, skipped: 'missing-id-transfer' };
    }
    // Skip screen-print orders — those go to the Bradley channel via
    // notifyScreenprintNewOrder.
    if (record.Method === 'Screen Print') {
        console.log('[SLACK_TRANSFER_NEW_ORDER_SKIP]', record.ID_Transfer, 'is-screen-print');
        return { sent: false, skipped: 'is-screen-print' };
    }

    if (shouldSkipDedup(record.ID_Transfer)) {
        console.log('[SLACK_TRANSFER_NEW_ORDER_SKIP]', record.ID_Transfer, 'dedup');
        return { sent: false, skipped: 'dedup' };
    }

    const text = buildText(record, opts);

    try {
        await axios.post(WEBHOOK_URL, { text }, {
            timeout: 8000,
            headers: { 'Content-Type': 'application/json' }
        });
        console.log('[SLACK_TRANSFER_NEW_ORDER_OK]', record.ID_Transfer);
        return { sent: true };
    } catch (err) {
        const msg = err && err.message ? err.message : String(err);
        console.warn('[SLACK_TRANSFER_NEW_ORDER_FAIL]', record.ID_Transfer, msg);
        dedupCache.delete(record.ID_Transfer);
        return { sent: false, error: msg };
    }
}

module.exports = {
    notifyTransferNewOrder,
    __test__: {
        clearDedup: () => dedupCache.clear(),
        getDedupSize: () => dedupCache.size,
        DEDUP_TTL_MS,
        buildText
    }
};
