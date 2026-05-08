// slack-transfer-received-notify.js — POST a Slack incoming-webhook when a
// Supacolor Purchase Order has been received (PurchaseOrders.date_Received
// gets filled in for vendor 2708). Targets the #supacolor-received channel.
//
// Replaces the "Mikalah Receives Transfers→ Slack Team" Zap (Caspio →
// Zapier filter → 8 Slack DMs). That Zap never fired because its trigger
// scoped to `event_sources: ["Datasheet"]` only — the actual write to
// date_Received comes from a non-Datasheet path (ShopWorks sync), so Zapier
// never saw the event. This utility is invoked by a backend polling cron
// (scripts/check-transfers-received.js) which polls Caspio directly and is
// agnostic to how date_Received gets set.
//
// Activation: set `SLACK_TRANSFER_RECEIVED_WEBHOOK_URL` env. Unset = no-op.
//
// Idempotency: dedup is enforced primarily at the cron-script level via the
// PurchaseOrders.Slack_Notified flag. This utility's in-memory dedup is just
// defensive against retry loops in a single process.

const axios = require('axios');

const WEBHOOK_URL = process.env.SLACK_TRANSFER_RECEIVED_WEBHOOK_URL || '';
const DEDUP_TTL_MS = 24 * 60 * 60 * 1000; // 24h — process-local backup to the Slack_Notified flag
const MAX_DEDUP_ENTRIES = 1000;

const dedupCache = new Map();

function pruneDedupCache(now) {
    for (const [key, expiresAt] of dedupCache.entries()) {
        if (expiresAt <= now) dedupCache.delete(key);
    }
}

function shouldSkipDedup(idPo) {
    if (!idPo) return false;
    const now = Date.now();
    const expiresAt = dedupCache.get(idPo);
    if (expiresAt && expiresAt > now) return true;
    if (dedupCache.size >= MAX_DEDUP_ENTRIES) pruneDedupCache(now);
    dedupCache.set(idPo, now + DEDUP_TTL_MS);
    return false;
}

/**
 * Format a Caspio date-only field for human readability.
 * Caspio sends "2026-05-07T00:00:00" — we want "Thu, May 7, 2026".
 *
 * Parses YYYY-MM-DD components manually to avoid timezone-shift on UTC-running
 * Heroku dynos (default `new Date('2026-05-07T00:00:00')` interprets as local
 * time, then toLocaleDateString could render as the previous day).
 */
function formatDateReceived(isoString) {
    if (!isoString) return '';
    const m = String(isoString).match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (!m) return String(isoString); // fallback to raw if parse fails
    const date = new Date(parseInt(m[1], 10), parseInt(m[2], 10) - 1, parseInt(m[3], 10));
    return date.toLocaleDateString('en-US', {
        weekday: 'short',
        year: 'numeric',
        month: 'short',
        day: 'numeric'
    });
}

function buildText(po) {
    const idPo = po.ID_PO != null ? String(po.ID_PO) : '';
    const idOrder = po.id_Order != null ? String(po.id_Order) : '';
    const customer = po.CustomerName || '';
    const rep = po.CustomerServiceRep || '';
    const dateReceived = formatDateReceived(po.date_Received);

    const lines = [
        `🚚 *Supacolor Transfer Received*`,
        `*PO #:* ${idPo}`,
        idOrder ? `*Work Order #:* ${idOrder}` : '',
        customer ? `*Customer:* ${customer}` : '',
        rep ? `*Sales Rep:* ${rep}` : '',
        `*Date Received:* ${dateReceived}`
    ];

    return lines.filter(Boolean).join('\n');
}

/**
 * Send a "transfer received" Slack message.
 *
 * @param {object} po
 * @param {string|number} po.ID_PO
 * @param {string|number} [po.id_Order]
 * @param {string} [po.date_Received]      — ISO date or Caspio formatted date
 * @param {string} [po.CustomerName]       — enrichment from /api/manageorders/orders/:no
 * @param {string} [po.CustomerServiceRep] — enrichment from /api/manageorders/orders/:no
 * @returns {Promise<{sent, skipped?, error?}>} — resolves rather than throws.
 */
async function notifyTransferReceived(po) {
    if (!WEBHOOK_URL) {
        console.log('[SLACK_TRANSFER_RECEIVED_SKIP]', 'no-webhook');
        return { sent: false, skipped: 'no-webhook' };
    }
    if (!po || po.ID_PO == null) {
        console.log('[SLACK_TRANSFER_RECEIVED_SKIP]', 'missing-id-po');
        return { sent: false, skipped: 'missing-id-po' };
    }

    if (shouldSkipDedup(po.ID_PO)) {
        console.log('[SLACK_TRANSFER_RECEIVED_SKIP]', po.ID_PO, 'dedup');
        return { sent: false, skipped: 'dedup' };
    }

    const text = buildText(po);

    try {
        await axios.post(WEBHOOK_URL, { text }, {
            timeout: 8000,
            headers: { 'Content-Type': 'application/json' }
        });
        console.log('[SLACK_TRANSFER_RECEIVED_OK]', po.ID_PO);
        return { sent: true };
    } catch (err) {
        const msg = err && err.message ? err.message : String(err);
        console.warn('[SLACK_TRANSFER_RECEIVED_FAIL]', po.ID_PO, msg);
        dedupCache.delete(po.ID_PO);
        return { sent: false, error: msg };
    }
}

module.exports = {
    notifyTransferReceived,
    __test__: {
        clearDedup: () => dedupCache.clear(),
        getDedupSize: () => dedupCache.size,
        DEDUP_TTL_MS,
        buildText,
        formatDateReceived
    }
};
