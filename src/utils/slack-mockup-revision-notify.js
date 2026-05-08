// slack-mockup-revision-notify.js — POST a Slack incoming-webhook when an AE
// requests a revision on a mockup. Targets #mockup-notifications channel
// (Ruth, Erik, AEs).
//
// Replaces the "Mockup Revision → Slack Ruth" Zap which had
// `event_sources:["Datasheet"]` and missed every revision request that came
// through PUT /api/mockups/:id/status (the actual dashboard UI path). Also
// fixes a typo in the original Zap that used Design_Name (the design name
// string) where Design_Number was intended.
//
// Activation: set `SLACK_MOCKUP_NOTIFICATIONS_WEBHOOK_URL` env. Unset = no-op.

const axios = require('axios');

const WEBHOOK_URL = process.env.SLACK_MOCKUP_NOTIFICATIONS_WEBHOOK_URL || '';
const SITE_ORIGIN = process.env.SITE_ORIGIN || 'https://www.teamnwca.com';
const DEDUP_TTL_MS = 5 * 60 * 1000;
const MAX_DEDUP_ENTRIES = 1000;

const dedupCache = new Map();

function pruneDedupCache(now) {
    for (const [key, expiresAt] of dedupCache.entries()) {
        if (expiresAt <= now) dedupCache.delete(key);
    }
}

function shouldSkipDedup(id, revCount) {
    // Per-(id, revision-count) — revisions #1, #2, #3 each get their own ping.
    const key = `${id}|${revCount}`;
    const now = Date.now();
    const expiresAt = dedupCache.get(key);
    if (expiresAt && expiresAt > now) return true;
    if (dedupCache.size >= MAX_DEDUP_ENTRIES) pruneDedupCache(now);
    dedupCache.set(key, now + DEDUP_TTL_MS);
    return false;
}

function buildText(record) {
    const id = record.ID != null ? String(record.ID) : '';
    const company = record.Company_Name || '';
    const designNum = record.Design_Number || '';
    const revCount = record.Revision_Count != null ? String(record.Revision_Count) : '?';
    const detailUrl = SITE_ORIGIN + '/mockup/' + encodeURIComponent(id);

    const lines = [
        `🔄 *Mockup Revision Requested*`,
        company ? `*Company:* ${company}` : '',
        designNum ? `*Design #:* ${designNum}` : '',
        `*Rev #:* ${revCount}`,
        id ? `\n<${detailUrl}|View mockup>` : ''
    ];

    return lines.filter(Boolean).join('\n');
}

function buildPayload(record) {
    const text = buildText(record);
    const imageUrl = record.Box_Mockup_1 || '';
    const payload = { text };
    if (imageUrl && /^https?:\/\//i.test(imageUrl)) {
        payload.attachments = [{ image_url: imageUrl, text: 'Mockup' }];
    }
    return payload;
}

/**
 * Send a "mockup revision requested" Slack message.
 *
 * @param {object} record  — Digitizing_Mockups row (post-update). Required: ID.
 *   Optional: Company_Name, Design_Number, Revision_Count, Box_Mockup_1.
 * @returns {Promise<{sent, skipped?, error?}>} — resolves rather than throws.
 */
async function notifyMockupRevision(record) {
    if (!WEBHOOK_URL) {
        console.log('[SLACK_MOCKUP_REVISION_SKIP]', 'no-webhook');
        return { sent: false, skipped: 'no-webhook' };
    }
    if (!record || record.ID == null) {
        console.log('[SLACK_MOCKUP_REVISION_SKIP]', 'missing-id');
        return { sent: false, skipped: 'missing-id' };
    }

    if (shouldSkipDedup(record.ID, record.Revision_Count)) {
        console.log('[SLACK_MOCKUP_REVISION_SKIP]', record.ID, 'dedup');
        return { sent: false, skipped: 'dedup' };
    }

    const payload = buildPayload(record);

    try {
        await axios.post(WEBHOOK_URL, payload, {
            timeout: 8000,
            headers: { 'Content-Type': 'application/json' }
        });
        console.log('[SLACK_MOCKUP_REVISION_OK]', record.ID, 'rev=' + record.Revision_Count);
        return { sent: true };
    } catch (err) {
        const msg = err && err.message ? err.message : String(err);
        console.warn('[SLACK_MOCKUP_REVISION_FAIL]', record.ID, msg);
        dedupCache.delete(`${record.ID}|${record.Revision_Count}`);
        return { sent: false, error: msg };
    }
}

module.exports = {
    notifyMockupRevision,
    __test__: {
        clearDedup: () => dedupCache.clear(),
        getDedupSize: () => dedupCache.size,
        DEDUP_TTL_MS,
        buildText,
        buildPayload
    }
};
