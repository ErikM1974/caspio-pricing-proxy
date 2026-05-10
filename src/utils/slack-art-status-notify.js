// slack-art-status-notify.js — POST a Slack incoming-webhook on key art-request
// status transitions that previously fired email-only via EmailJS:
//
//   Status → Awaiting Approval     (Send Mockup to customer)            📤
//   Status → Customer Approved     (Customer signed off)                ✅
//   Status → Completed             (Steve marked artwork done)          🎯
//   Is_On_Hold flipped false→true  (Art on hold, separate field)        ⏸️
//
// Targets #art-notifications — same channel as submission/revision/reopen,
// distinguished by emoji prefix to keep visual scanability without splitting
// into more channels (per Erik's "stick to existing channels" rule).
//
// Activation: set `SLACK_ART_NOTIFICATIONS_WEBHOOK_URL` env (already in use).
// Unset = no-op.

const axios = require('axios');
const { __test__: { metaForItemType } } = require('./slack-art-request-submission-notify');

const WEBHOOK_URL = process.env.SLACK_ART_NOTIFICATIONS_WEBHOOK_URL || '';
const SITE_ORIGIN = process.env.SITE_ORIGIN || 'https://www.teamnwca.com';
const DEDUP_TTL_MS = 5 * 60 * 1000;
const MAX_DEDUP_ENTRIES = 1000;

// Status transitions we fire on, with their visual + label.
// Keys are post-clean Status values (REST normalizes; emoji stripped, trimmed).
const TRANSITIONS = {
    'Awaiting Approval':  { emoji: '📤', label: 'Mockup Sent for Customer Approval' },
    'Customer Approved':  { emoji: '✅', label: 'Customer Approved' },
    'Completed':          { emoji: '🎯', label: 'Artwork Completed' }
};

const ON_HOLD_TRANSITION = { emoji: '⏸️', label: 'Art On Hold' };

const dedupCache = new Map();

function pruneDedupCache(now) {
    for (const [key, expiresAt] of dedupCache.entries()) {
        if (expiresAt <= now) dedupCache.delete(key);
    }
}

function shouldSkipDedup(idDesign, transitionKey) {
    if (idDesign == null) return false;
    // (id|transition) so each distinct transition for a design gets its own ping.
    // Re-firing the same (id|transition) within 5 min is squelched (e.g. retries,
    // double-clicks, dashboard refresh racing with the PUT response).
    const key = `${idDesign}|${transitionKey}`;
    const now = Date.now();
    const expiresAt = dedupCache.get(key);
    if (expiresAt && expiresAt > now) return true;
    if (dedupCache.size >= MAX_DEDUP_ENTRIES) pruneDedupCache(now);
    dedupCache.set(key, now + DEDUP_TTL_MS);
    return false;
}

function buildText(record, transitionKey) {
    const trans = transitionKey === '__on_hold__'
        ? ON_HOLD_TRANSITION
        : TRANSITIONS[transitionKey];
    if (!trans) return '';

    const idDesign = record.ID_Design != null ? String(record.ID_Design) : '';
    const company = record.CompanyName || '';
    const designNum = record.Design_Num_SW || '';
    const itemMeta = metaForItemType(record.Item_Type);
    const isGarment = itemMeta.label === 'Art Request';
    const itemTypeLabel = isGarment ? '' : itemMeta.label.replace(/ \(Manual Quote\)$/, '');
    const actor = record.Actor || '';
    const note = record.On_Hold_Note || '';
    const detailUrl = SITE_ORIGIN + '/art-request/' + encodeURIComponent(idDesign);

    const headerSuffix = actor ? ` by ${actor}` : '';
    const lines = [
        `${trans.emoji} *${trans.label}${headerSuffix}*`,
        company ? `*Company:* ${company}` : '',
        designNum ? `*Design #:* ${designNum}` : '',
        itemTypeLabel ? `*Item Type:* ${itemTypeLabel}` : '',
        // On Hold: surface the reason if the dashboard captured one.
        transitionKey === '__on_hold__' && note ? `*Reason:* ${String(note).trim()}` : '',
        idDesign ? `\n<${detailUrl}|View art request>` : ''
    ];

    return lines.filter(Boolean).join('\n');
}

/**
 * Fire a Slack notification for an art-request status transition.
 *
 * @param {object} record       — ArtRequests row (post-update). Required: ID_Design, Status (or transitionKey).
 *   Optional: CompanyName, Design_Num_SW, Item_Type, Actor, On_Hold_Note.
 * @param {string} transitionKey — One of the keys in TRANSITIONS, or '__on_hold__'
 *   for the Is_On_Hold flip path. Pass record.Status as the key for the standard
 *   status transitions; pass '__on_hold__' explicitly for the On Hold flow.
 * @returns {Promise<{sent, skipped?, error?}>} — resolves rather than throws.
 */
async function notifyArtStatusTransition(record, transitionKey) {
    if (!WEBHOOK_URL) {
        return { sent: false, skipped: 'no-webhook' };
    }
    if (!record || record.ID_Design == null) {
        console.log('[SLACK_ART_STATUS_SKIP]', 'missing-id-design');
        return { sent: false, skipped: 'missing-id-design' };
    }
    const isOnHold = transitionKey === '__on_hold__';
    if (!isOnHold && !TRANSITIONS[transitionKey]) {
        // Not a transition we ping on (e.g. In Progress, Revision Requested,
        // Submitted) — silent skip, no log to keep heroku quiet.
        return { sent: false, skipped: 'transition-not-watched' };
    }

    if (shouldSkipDedup(record.ID_Design, transitionKey)) {
        console.log('[SLACK_ART_STATUS_SKIP]', record.ID_Design, transitionKey, 'dedup');
        return { sent: false, skipped: 'dedup' };
    }

    const text = buildText(record, transitionKey);

    try {
        await axios.post(WEBHOOK_URL, { text }, {
            timeout: 8000,
            headers: { 'Content-Type': 'application/json' }
        });
        console.log('[SLACK_ART_STATUS_OK]', record.ID_Design, transitionKey);
        return { sent: true };
    } catch (err) {
        const msg = err && err.message ? err.message : String(err);
        console.warn('[SLACK_ART_STATUS_FAIL]', record.ID_Design, transitionKey, msg);
        dedupCache.delete(`${record.ID_Design}|${transitionKey}`);
        return { sent: false, error: msg };
    }
}

module.exports = {
    notifyArtStatusTransition,
    __test__: {
        clearDedup: () => dedupCache.clear(),
        getDedupSize: () => dedupCache.size,
        DEDUP_TTL_MS,
        TRANSITIONS,
        ON_HOLD_TRANSITION,
        buildText
    }
};
