// slack-screenprint-new-order-notify.js — POST a Slack incoming-webhook when
// Steve submits a new screen-print order. Targets the #sp-new-orders channel
// (whoever SLACK_SCREENPRINT_NEW_ORDER_WEBHOOK_URL points at). Bradley, Steve
// (art804), and Erik are members of that channel, so all three get pinged.
//
// Replaces the previous zapier-screenprint-new-order-notify.js path. Same
// shape — dedup Map with 5-min TTL, fire-and-forget contract, axios.post with
// 8s timeout — just one less SaaS hop and the message body lives in code.
//
// Activation: set `SLACK_SCREENPRINT_NEW_ORDER_WEBHOOK_URL` env to the Slack
// app's incoming-webhook URL (https://hooks.slack.com/services/...). Unset =
// no-op for local dev / staging.
//
// Slack incoming-webhook payload format: { text: "..." } with mrkdwn inline.
// See https://api.slack.com/messaging/webhooks for the full reference.

const axios = require('axios');

const WEBHOOK_URL = process.env.SLACK_SCREENPRINT_NEW_ORDER_WEBHOOK_URL || '';
const SITE_ORIGIN = process.env.SITE_ORIGIN || 'https://www.teamnwca.com';
const DEDUP_TTL_MS = 5 * 60 * 1000; // 5 minutes — defensive against retry paths
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

function previewSpNotes(spNotes) {
    if (!spNotes) return '';
    return String(spNotes).trim();
}

/**
 * Build the Slack mrkdwn message body. Exported via __test__ for unit testing.
 */
function buildText(record, opts) {
    const isRush = isTruthy(record.Is_Rush);
    const requestedByName = (opts && opts.requestedByName)
        || record.Requested_By_Name
        || record.Requested_By
        || 'Steve Deland';

    const designNumber = String(record.Design_Number || '');
    const companyName = String(record.Company_Name || '');
    const vendor = String(record.SP_Vendor || 'L&P Printing');
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
    const spNotesPreview = previewSpNotes(record.SP_Notes);
    const rushSuffix = isRush ? '  🚨 *RUSH*' : '';

    const lines = [
        `🎨 *New Screen Print Order*${rushSuffix}`,
        `*Design:* ${designNumber}`,
        `*Company:* ${companyName}`,
        `*Submitted by:* ${requestedByName}`,
        `*Quantity:* ${quantity || '—'}`,
        `*Vendor:* ${vendor}`,
        garmentInfo ? `*Garment:* ${garmentInfo}` : '',
        repName ? `*Sales Rep:* ${repName}` : '',
        spNotesPreview ? `\n>${spNotesPreview.replace(/\n/g, '\n>')}` : '',
        `\n<${detailUrl}|View order details>`
    ];

    return lines.filter(Boolean).join('\n');
}

/**
 * Send a "new screen print order" Slack message.
 *
 * @param {object} record   — the just-created Transfer_Orders row
 * @param {object} [opts]
 * @param {string} [opts.requestedByName]
 * @param {string} [opts.garmentInfo]
 * @param {Array}  [opts.lines]
 * @returns {Promise<{sent, skipped?, error?}>} — resolves rather than throws.
 */
async function notifyScreenprintNewOrder(record, opts) {
    if (!WEBHOOK_URL) {
        console.log('[SLACK_SP_NEW_ORDER_SKIP]', 'no-webhook');
        return { sent: false, skipped: 'no-webhook' };
    }
    if (!record || !record.ID_Transfer) {
        console.log('[SLACK_SP_NEW_ORDER_SKIP]', 'missing-id-transfer');
        return { sent: false, skipped: 'missing-id-transfer' };
    }
    // Only fire for screen-print orders. Other transfer methods route to
    // notifyTransferNewOrder (Mikhail's channel).
    if (record.Method !== 'Screen Print') {
        console.log('[SLACK_SP_NEW_ORDER_SKIP]', record.ID_Transfer, 'not-screen-print', 'method=' + JSON.stringify(record.Method));
        return { sent: false, skipped: 'not-screen-print' };
    }

    if (shouldSkipDedup(record.ID_Transfer)) {
        console.log('[SLACK_SP_NEW_ORDER_SKIP]', record.ID_Transfer, 'dedup');
        return { sent: false, skipped: 'dedup' };
    }

    const text = buildText(record, opts);

    try {
        await axios.post(WEBHOOK_URL, { text }, {
            timeout: 8000,
            headers: { 'Content-Type': 'application/json' }
        });
        console.log('[SLACK_SP_NEW_ORDER_OK]', record.ID_Transfer);
        return { sent: true };
    } catch (err) {
        const msg = err && err.message ? err.message : String(err);
        console.warn('[SLACK_SP_NEW_ORDER_FAIL]', record.ID_Transfer, msg);
        // Roll back the dedup entry so a transient Slack outage doesn't
        // permanently silence this order for 5min.
        dedupCache.delete(record.ID_Transfer);
        return { sent: false, error: msg };
    }
}

module.exports = {
    notifyScreenprintNewOrder,
    __test__: {
        clearDedup: () => dedupCache.clear(),
        getDedupSize: () => dedupCache.size,
        DEDUP_TTL_MS,
        buildText
    }
};
