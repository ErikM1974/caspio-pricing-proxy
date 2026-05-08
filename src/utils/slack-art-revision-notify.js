// slack-art-revision-notify.js — POST a Slack incoming-webhook when an AE
// requests a revision on an art request. Targets the #art-notifications
// channel (Steve, Erik, AEs).
//
// Replaces the "Mockup Revision → Slack Steve" Zap which despite its name
// watched the ArtRequests table. The Zap had `event_sources:["Datasheet"]`
// which silently missed every revision request that came through the
// dashboard UI (PUT /api/art-requests/:designId/status via REST API).
//
// Activation: set `SLACK_ART_NOTIFICATIONS_WEBHOOK_URL` env. Unset = no-op.

const axios = require('axios');

const WEBHOOK_URL = process.env.SLACK_ART_NOTIFICATIONS_WEBHOOK_URL || '';
const SITE_ORIGIN = process.env.SITE_ORIGIN || 'https://www.teamnwca.com';
const DEDUP_TTL_MS = 5 * 60 * 1000; // 5 min — defensive against retries within a single PUT
const MAX_DEDUP_ENTRIES = 1000;

const dedupCache = new Map();

function pruneDedupCache(now) {
    for (const [key, expiresAt] of dedupCache.entries()) {
        if (expiresAt <= now) dedupCache.delete(key);
    }
}

function shouldSkipDedup(idDesign, revCount) {
    // Dedup key combines designId + revision count so revisions #1, #2, #3 each
    // get their own ping, but accidental retries within 5 min of the same rev
    // are squelched.
    const key = `${idDesign}|${revCount}`;
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
    const revCount = record.Revision_Count != null ? String(record.Revision_Count) : '?';
    const detailUrl = SITE_ORIGIN + '/art-request/' + encodeURIComponent(idDesign);

    const lines = [
        `🔄 *Art Revision Requested*`,
        company ? `*Company:* ${company}` : '',
        designNum ? `*Design #:* ${designNum}` : '',
        `*Rev #:* ${revCount}`,
        idDesign ? `\n<${detailUrl}|View art request>` : ''
    ];

    return lines.filter(Boolean).join('\n');
}

/**
 * Send an "art revision requested" Slack message.
 *
 * @param {object} record  — ArtRequests row (post-update). Required fields:
 *   ID_Design, Revision_Count. Optional: CompanyName, Design_Num_SW.
 * @returns {Promise<{sent, skipped?, error?}>} — resolves rather than throws.
 */
async function notifyArtRequestRevision(record) {
    if (!WEBHOOK_URL) {
        console.log('[SLACK_ART_REVISION_SKIP]', 'no-webhook');
        return { sent: false, skipped: 'no-webhook' };
    }
    if (!record || record.ID_Design == null) {
        console.log('[SLACK_ART_REVISION_SKIP]', 'missing-id-design');
        return { sent: false, skipped: 'missing-id-design' };
    }

    if (shouldSkipDedup(record.ID_Design, record.Revision_Count)) {
        console.log('[SLACK_ART_REVISION_SKIP]', record.ID_Design, 'dedup');
        return { sent: false, skipped: 'dedup' };
    }

    const text = buildText(record);

    try {
        await axios.post(WEBHOOK_URL, { text }, {
            timeout: 8000,
            headers: { 'Content-Type': 'application/json' }
        });
        console.log('[SLACK_ART_REVISION_OK]', record.ID_Design, 'rev=' + record.Revision_Count);
        return { sent: true };
    } catch (err) {
        const msg = err && err.message ? err.message : String(err);
        console.warn('[SLACK_ART_REVISION_FAIL]', record.ID_Design, msg);
        // Roll back so transient outage doesn't silence next legitimate revision
        dedupCache.delete(`${record.ID_Design}|${record.Revision_Count}`);
        return { sent: false, error: msg };
    }
}

module.exports = {
    notifyArtRequestRevision,
    __test__: {
        clearDedup: () => dedupCache.clear(),
        getDedupSize: () => dedupCache.size,
        DEDUP_TTL_MS,
        buildText
    }
};
