// slack-mockup-status-notify.js — POST a Slack incoming-webhook on key
// mockup status transitions that previously fired email-only:
//
//   Status → Awaiting Approval   (Ruth ready for AE/customer review)   📤
//   Status → Approved            (AE/customer approved digitizing)     ✅
//   Status → Completed           (Ruth marked digitizing fully done)   🎯
//
// Targets #mockup-notifications — same channel as submission/rush/revision,
// distinguished by emoji prefix.
//
// Activation: set `SLACK_MOCKUP_NOTIFICATIONS_WEBHOOK_URL` env (already in use).
// Unset = no-op.

const axios = require('axios');

const WEBHOOK_URL = process.env.SLACK_MOCKUP_NOTIFICATIONS_WEBHOOK_URL || '';
const SITE_ORIGIN = process.env.SITE_ORIGIN || 'https://www.teamnwca.com';
const DEDUP_TTL_MS = 5 * 60 * 1000;
const MAX_DEDUP_ENTRIES = 1000;

const TRANSITIONS = {
    'Awaiting Approval': { emoji: '📤', label: 'Mockup Ready for Approval' },
    'Approved':          { emoji: '✅', label: 'Mockup Approved' },
    'Completed':         { emoji: '🎯', label: 'Mockup Completed' }
};

const dedupCache = new Map();

function pruneDedupCache(now) {
    for (const [key, expiresAt] of dedupCache.entries()) {
        if (expiresAt <= now) dedupCache.delete(key);
    }
}

function shouldSkipDedup(id, transitionKey) {
    if (id == null) return false;
    const key = `${id}|${transitionKey}`;
    const now = Date.now();
    const expiresAt = dedupCache.get(key);
    if (expiresAt && expiresAt > now) return true;
    if (dedupCache.size >= MAX_DEDUP_ENTRIES) pruneDedupCache(now);
    dedupCache.set(key, now + DEDUP_TTL_MS);
    return false;
}

function buildText(record, transitionKey) {
    const trans = TRANSITIONS[transitionKey];
    if (!trans) return '';

    const id = record.ID != null ? String(record.ID) : '';
    const company = record.Company_Name || '';
    const designNum = record.Design_Number || '';
    const designName = record.Design_Name || '';
    const designLine = [designNum, designName].filter(Boolean).join(' — ');
    const actor = record.Actor || '';
    const detailUrl = SITE_ORIGIN + '/mockup/' + encodeURIComponent(id);

    const headerSuffix = actor ? ` by ${actor}` : '';
    const lines = [
        `${trans.emoji} *${trans.label}${headerSuffix}*`,
        company ? `*Company:* ${company}` : '',
        designLine ? `*Design #:* ${designLine}` : '',
        id ? `\n<${detailUrl}|View mockup>` : ''
    ];

    return lines.filter(Boolean).join('\n');
}

/**
 * Fire a Slack notification for a mockup status transition.
 *
 * @param {object} record       — Digitizing_Mockups row (post-update). Required: ID.
 *   Optional: Company_Name, Design_Number, Design_Name, Actor.
 * @param {string} transitionKey — Post-update Status. Only the keys in TRANSITIONS
 *   trigger a Slack post; everything else is a silent skip.
 * @returns {Promise<{sent, skipped?, error?}>} — resolves rather than throws.
 */
async function notifyMockupStatusTransition(record, transitionKey) {
    if (!WEBHOOK_URL) {
        return { sent: false, skipped: 'no-webhook' };
    }
    if (!record || record.ID == null) {
        console.log('[SLACK_MOCKUP_STATUS_SKIP]', 'missing-id');
        return { sent: false, skipped: 'missing-id' };
    }
    if (!TRANSITIONS[transitionKey]) {
        return { sent: false, skipped: 'transition-not-watched' };
    }

    if (shouldSkipDedup(record.ID, transitionKey)) {
        console.log('[SLACK_MOCKUP_STATUS_SKIP]', record.ID, transitionKey, 'dedup');
        return { sent: false, skipped: 'dedup' };
    }

    const text = buildText(record, transitionKey);

    try {
        await axios.post(WEBHOOK_URL, { text }, {
            timeout: 8000,
            headers: { 'Content-Type': 'application/json' }
        });
        console.log('[SLACK_MOCKUP_STATUS_OK]', record.ID, transitionKey);
        return { sent: true };
    } catch (err) {
        const msg = err && err.message ? err.message : String(err);
        console.warn('[SLACK_MOCKUP_STATUS_FAIL]', record.ID, transitionKey, msg);
        dedupCache.delete(`${record.ID}|${transitionKey}`);
        return { sent: false, error: msg };
    }
}

module.exports = {
    notifyMockupStatusTransition,
    __test__: {
        clearDedup: () => dedupCache.clear(),
        getDedupSize: () => dedupCache.size,
        DEDUP_TTL_MS,
        TRANSITIONS,
        buildText
    }
};
