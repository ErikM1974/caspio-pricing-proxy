// slack-art-reopen-notify.js — POST a Slack incoming-webhook when an art
// request is reopened (Status transitions from a closed state back to
// "In Progress"). Targets #art-notifications channel (Steve, Erik, AEs).
//
// Replaces the "Steve Art - Reopen Art" Zap which had:
//   - `event_sources:["Datasheet"]` — missed dashboard UI reopen actions
//   - `new_updated_record_hook` — re-fired on every edit to an "In Progress"
//     record (notes added, mockup uploaded), causing duplicate DMs
//
// We narrow the trigger to true reopens (transition from Completed/Cancelled/
// On Hold/Awaiting Approval → In Progress), which is the original semantic
// the Zap intended.
//
// Activation: set `SLACK_ART_NOTIFICATIONS_WEBHOOK_URL` env. Unset = no-op.

const axios = require('axios');

const WEBHOOK_URL = process.env.SLACK_ART_NOTIFICATIONS_WEBHOOK_URL || '';
const SITE_ORIGIN = process.env.SITE_ORIGIN || 'https://www.teamnwca.com';
const DEDUP_TTL_MS = 24 * 60 * 60 * 1000; // 24h — reopens are rare; one ping per day per record is fine
const MAX_DEDUP_ENTRIES = 500;

// Statuses that, when transitioned away from to "In Progress", count as a reopen.
const CLOSED_LIKE_STATUSES = new Set([
    'Completed',
    'Cancelled',
    'On Hold',
    'Awaiting Approval'
]);

const dedupCache = new Map();

function pruneDedupCache(now) {
    for (const [key, expiresAt] of dedupCache.entries()) {
        if (expiresAt <= now) dedupCache.delete(key);
    }
}

function shouldSkipDedup(idDesign) {
    if (idDesign == null) return false;
    const key = String(idDesign);
    const now = Date.now();
    const expiresAt = dedupCache.get(key);
    if (expiresAt && expiresAt > now) return true;
    if (dedupCache.size >= MAX_DEDUP_ENTRIES) pruneDedupCache(now);
    dedupCache.set(key, now + DEDUP_TTL_MS);
    return false;
}

function buildText(record) {
    const idDesign = record.ID_Design != null ? String(record.ID_Design) : '';
    const company = record.CompanyName || '';
    const designNum = record.Design_Num_SW || '';
    const detailUrl = SITE_ORIGIN + '/art-request/' + encodeURIComponent(idDesign);

    const lines = [
        `🔁 *Art Request Reopened*`,
        company ? `*Company:* ${company}` : '',
        designNum ? `*Design #:* ${designNum}` : '',
        idDesign ? `\n<${detailUrl}|View art request>` : ''
    ];

    return lines.filter(Boolean).join('\n');
}

/**
 * Send an "art request reopened" Slack message.
 *
 * @param {object} record       — ArtRequests row (post-update). Required: ID_Design.
 * @param {string} prevStatus   — The status BEFORE this update. Used to gate
 *                                on true reopens (closed-like → In Progress).
 *                                If unknown/null, the gate skips and the call no-ops.
 * @returns {Promise<{sent, skipped?, error?}>} — resolves rather than throws.
 */
async function notifyArtRequestReopen(record, prevStatus) {
    if (!WEBHOOK_URL) {
        console.log('[SLACK_ART_REOPEN_SKIP]', 'no-webhook');
        return { sent: false, skipped: 'no-webhook' };
    }
    if (!record || record.ID_Design == null) {
        console.log('[SLACK_ART_REOPEN_SKIP]', 'missing-id-design');
        return { sent: false, skipped: 'missing-id-design' };
    }
    // Only fire on true reopens.
    if (!prevStatus || !CLOSED_LIKE_STATUSES.has(prevStatus)) {
        console.log('[SLACK_ART_REOPEN_SKIP]', record.ID_Design, 'not-a-reopen', 'prev=' + JSON.stringify(prevStatus));
        return { sent: false, skipped: 'not-a-reopen' };
    }

    if (shouldSkipDedup(record.ID_Design)) {
        console.log('[SLACK_ART_REOPEN_SKIP]', record.ID_Design, 'dedup');
        return { sent: false, skipped: 'dedup' };
    }

    const text = buildText(record);

    try {
        await axios.post(WEBHOOK_URL, { text }, {
            timeout: 8000,
            headers: { 'Content-Type': 'application/json' }
        });
        console.log('[SLACK_ART_REOPEN_OK]', record.ID_Design, 'prev=' + prevStatus);
        return { sent: true };
    } catch (err) {
        const msg = err && err.message ? err.message : String(err);
        console.warn('[SLACK_ART_REOPEN_FAIL]', record.ID_Design, msg);
        dedupCache.delete(String(record.ID_Design));
        return { sent: false, error: msg };
    }
}

module.exports = {
    notifyArtRequestReopen,
    __test__: {
        clearDedup: () => dedupCache.clear(),
        getDedupSize: () => dedupCache.size,
        DEDUP_TTL_MS,
        CLOSED_LIKE_STATUSES,
        buildText
    }
};
