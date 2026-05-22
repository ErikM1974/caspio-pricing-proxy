// slack-shipstation-notify.js — POST a Slack incoming-webhook on ShipStation
// lifecycle events: order pushed to ShipStation, label purchased + tracking#
// received, push failures.
//
// Targets the #shipping (or #shipstation) channel. Mirrors the pattern from
// slack-supacolor-health-notify.js + slack-transfer-new-order-notify.js.
//
// Activation: set `SLACK_SHIPSTATION_WEBHOOK_URL` env. Unset = silent no-op
// (so non-prod environments + the test suite don't spam the channel).

'use strict';

const axios = require('axios');

const WEBHOOK_URL = process.env.SLACK_SHIPSTATION_WEBHOOK_URL || '';
const DEDUP_TTL_MS = 5 * 60 * 1000; // 5 min — prevents duplicate notifies on retry storms
const MAX_DEDUP_ENTRIES = 200;

const dedupCache = new Map();

function pruneDedupCache(now) {
    for (const [key, expiresAt] of dedupCache.entries()) {
        if (expiresAt <= now) dedupCache.delete(key);
    }
}

function shouldSkipDedup(dedupKey) {
    const now = Date.now();
    const expiresAt = dedupCache.get(dedupKey);
    if (expiresAt && expiresAt > now) return true;
    if (dedupCache.size >= MAX_DEDUP_ENTRIES) pruneDedupCache(now);
    dedupCache.set(dedupKey, now + DEDUP_TTL_MS);
    return false;
}

async function postSlack(text, dedupKey) {
    if (!WEBHOOK_URL) return; // silent no-op when not configured
    if (dedupKey && shouldSkipDedup(dedupKey)) return;
    try {
        await axios.post(WEBHOOK_URL, { text }, { timeout: 5000 });
    } catch (err) {
        console.warn('[slack-shipstation] post failed (non-fatal):', err.message);
    }
}

/**
 * Order successfully created in ShipStation. Fires once per order — the
 * dedup key (`${quoteId}-sent`) prevents the same notification from firing
 * if the caller retries.
 */
function notifyOrderSent({ quoteId, shipstationOrderId, customerName, carrierCode, serviceCode, total }) {
    const carrierLabel = [carrierCode, serviceCode].filter(Boolean).join(' / ') || 'no carrier preset';
    const totalLabel = (typeof total === 'number') ? ` · $${total.toFixed(2)}` : '';
    const text = `🚢 *${quoteId}* sent to ShipStation\n` +
        `*Customer:* ${customerName || '(unknown)'}\n` +
        `*ShipStation #:* ${shipstationOrderId || '(unknown)'}\n` +
        `*Carrier:* ${carrierLabel}${totalLabel}`;
    return postSlack(text, `${quoteId}-sent`);
}

/**
 * Label was bought + tracking number generated. Fires from the inbound
 * SHIP_NOTIFY webhook handler.
 */
function notifyLabelShipped({ quoteId, trackingNumber, carrierCode, serviceCode, labelCost, trackingUrl }) {
    const carrierLabel = [carrierCode, serviceCode].filter(Boolean).join(' / ') || 'unknown carrier';
    const costLabel = (typeof labelCost === 'number') ? ` · $${labelCost.toFixed(2)} postage` : '';
    const trackingLine = trackingUrl
        ? `<${trackingUrl}|${trackingNumber}>`
        : trackingNumber;
    const text = `📦 *${quoteId}* shipped\n` +
        `*Carrier:* ${carrierLabel}${costLabel}\n` +
        `*Tracking:* ${trackingLine}`;
    return postSlack(text, `${quoteId}-${trackingNumber}-shipped`);
}

/**
 * ShipStation rejected the push (validation error, auth fail, etc.).
 * Fires from the proxy's /api/shipstation/create-order error path. No dedup
 * on this — every failure is potentially actionable.
 */
function notifyPushFailed({ quoteId, error, status, details }) {
    const text = `⚠️ *${quoteId}* push to ShipStation FAILED\n` +
        `*Status:* ${status || 'unknown'}\n` +
        `*Error:* ${error || 'unknown error'}` +
        (details ? `\n\`\`\`${typeof details === 'string' ? details : JSON.stringify(details).slice(0, 500)}\`\`\`` : '');
    return postSlack(text); // no dedup — every failure needs eyes on it
}

/**
 * SW-cascade deleted the order in ShipStation. Fires from the
 * DELETE /api/shipstation/orders/:id route, invoked by pricing-index's
 * sync-from-shopworks when it detects the order was removed in OnSite.
 * Warehouse should see this so they don't pick a phantom order.
 */
function notifyOrderDeleted({ shipstationOrderId, quoteId, reason }) {
    const text = `🗑 ShipStation order ${quoteId ? `*${quoteId}* ` : ''}deleted\n` +
        `*ShipStation #:* ${shipstationOrderId}\n` +
        `*Reason:* ${reason || 'SW cascade'}`;
    return postSlack(text, `${shipstationOrderId}-deleted`);
}

module.exports = {
    notifyOrderSent,
    notifyLabelShipped,
    notifyPushFailed,
    notifyOrderDeleted,
};
