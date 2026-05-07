// zapier-screenprint-new-order-notify.js — fire a Zapier webhook when Steve
// submits a new screen-print order. Zapier formats the payload into Slack DMs
// to Bradley, art804, and erik.
//
// Same shape as zapier-broken-mockup-notify.js / zapier-supacolor-health-notify.js
// — read URL from env, no-op when unset, axios POST with timeout, resolves
// rather than throws so the order submission isn't blocked by a notify failure.
//
// Activation: set `ZAPIER_SCREENPRINT_NEW_ORDER_WEBHOOK_URL` env to the Zapier
// "Catch Hook" URL (e.g. https://hooks.zapier.com/hooks/catch/253710/4yh8g0f/).
// If unset, this module is a no-op — useful for local dev and for shipping
// the code before the Zap exists or after the Zap is paused.
//
// Dedup: lightweight 5-min Map<idTransfer, expiresAt> guards against any
// retry path firing the webhook twice for the same just-created order.
// Each new order has a unique ID_Transfer, so realistic dedup hits are zero
// — this is purely defensive.

const axios = require('axios');

const WEBHOOK_URL = process.env.ZAPIER_SCREENPRINT_NEW_ORDER_WEBHOOK_URL || '';
const SITE_ORIGIN = process.env.SITE_ORIGIN || 'https://www.teamnwca.com';
const DEDUP_TTL_MS = 5 * 60 * 1000; // 5 minutes — enough to catch retries, short enough to be invisible
const MAX_DEDUP_ENTRIES = 1000;

const dedupCache = new Map();

function pruneDedupCache(now) {
    for (const [key, expiresAt] of dedupCache.entries()) {
        if (expiresAt <= now) dedupCache.delete(key);
    }
}

function shouldSkipDedup(idTransfer) {
    if (!idTransfer) return false; // no ID = always send (shouldn't happen but defensive)
    const now = Date.now();
    const expiresAt = dedupCache.get(idTransfer);
    if (expiresAt && expiresAt > now) return true;
    if (dedupCache.size >= MAX_DEDUP_ENTRIES) pruneDedupCache(now);
    dedupCache.set(idTransfer, now + DEDUP_TTL_MS);
    return false;
}

/**
 * Coerce truthy boolean. Caspio Yes/No fields can come back as true|false|'true'|'Yes'|1.
 */
function isTruthy(v) {
    return v === true || v === 'true' || v === 'Yes' || v === 1;
}

/**
 * Normalize the SP_Notes free-text for Slack rendering. Returns empty string
 * (not null) when blank so the Slack template's `\r\n\r\n{spNotesPreview}`
 * slot just collapses to a clean blank line.
 */
function previewSpNotes(spNotes) {
    if (!spNotes) return '';
    return String(spNotes).trim();
}

/**
 * Send a "new screen print order" event to Zapier.
 *
 * @param {object} record   — the just-created Transfer_Orders row (record from POST insert)
 * @param {object} [opts]
 * @param {string} [opts.requestedByName] — overrides record.Requested_By_Name (frontend may send name)
 * @returns {Promise<{sent: boolean, skipped?: string, error?: string}>}
 *   Resolves rather than throws — caller (POST /transfer-orders) shouldn't
 *   have its response delayed or 500'd by a notify failure.
 */
async function notifyScreenprintNewOrder(record, opts) {
    if (!WEBHOOK_URL) {
        return { sent: false, skipped: 'no-webhook' };
    }
    if (!record || !record.ID_Transfer) {
        return { sent: false, skipped: 'missing-id-transfer' };
    }
    // Only fire for screen-print orders. Supacolor orders use their own flows.
    if (record.Method !== 'Screen Print') {
        return { sent: false, skipped: 'not-screen-print' };
    }

    if (shouldSkipDedup(record.ID_Transfer)) {
        return { sent: false, skipped: 'dedup' };
    }

    const isRush = isTruthy(record.Is_Rush);
    const requestedByName = (opts && opts.requestedByName)
        || record.Requested_By_Name
        || record.Requested_By
        || 'Steve Deland';

    const payload = {
        event: 'screenprint_new_order',
        idTransfer: record.ID_Transfer,
        designNumber: String(record.Design_Number || ''),
        companyName: String(record.Company_Name || ''),
        requestedByName: String(requestedByName),
        repName: String(record.Sales_Rep_Name || ''),
        repEmail: String(record.Sales_Rep_Email || ''),
        quantity: record.Quantity != null ? String(record.Quantity) : '',
        garmentInfo: '', // populated below from caller-supplied opts (vision-extracted, not on record)
        vendor: String(record.SP_Vendor || 'L&P Printing'),
        spNotesPreview: previewSpNotes(record.SP_Notes),
        detailUrl: SITE_ORIGIN + '/pages/transfer-detail.html?id=' + encodeURIComponent(record.ID_Transfer),
        rushSuffix: isRush ? ' 🚨 *RUSH*' : '',
        isRush: isRush,
        timestamp: new Date().toISOString()
    };

    // Garment info comes from mockup vision (not stored on Transfer_Orders).
    // Caller can pass it through opts.garmentInfo to enrich the Slack message.
    if (opts && opts.garmentInfo) {
        payload.garmentInfo = String(opts.garmentInfo);
    }

    // Total qty across all transfer lines if caller provides them, since the
    // top-level record.Quantity is NULL in the v3 paste-links flow.
    if (opts && Array.isArray(opts.lines) && opts.lines.length > 0) {
        const total = opts.lines.reduce((sum, l) => {
            const q = parseInt(l.Quantity, 10);
            return sum + (Number.isNaN(q) ? 0 : q);
        }, 0);
        if (total > 0) payload.quantity = String(total);
    }

    try {
        await axios.post(WEBHOOK_URL, payload, {
            timeout: 8000,
            headers: { 'Content-Type': 'application/json' }
        });
        return { sent: true };
    } catch (err) {
        const msg = err && err.message ? err.message : String(err);
        console.warn('[ZAPIER_SP_NEW_ORDER_NOTIFY_FAIL]', record.ID_Transfer, msg);
        // Roll back the dedup entry so a transient Zapier outage doesn't
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
        DEDUP_TTL_MS
    }
};
