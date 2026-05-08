// slack-art-request-submission-notify.js — POST a Slack incoming-webhook
// when an AE submits a new art request. Targets #art-notifications channel
// (Steve, Erik, AEs).
//
// Replaces the "New Art Request Submission → Slack Steve + AE" Zap which had
// `event_sources:["Datasheet"]` and silently missed every form submission
// that came through POST /api/artrequests.
//
// Original Zap had a 3-action chain: DM Steve+Erik, find_user_by_email,
// DM dynamic AE + Erik. We collapse to a channel post — Steve + Erik + AEs
// all see it.
//
// Activation: set `SLACK_ART_NOTIFICATIONS_WEBHOOK_URL` env. Unset = no-op.

const axios = require('axios');

const WEBHOOK_URL = process.env.SLACK_ART_NOTIFICATIONS_WEBHOOK_URL || '';
const SITE_ORIGIN = process.env.SITE_ORIGIN || 'https://teamnwca.com';
const DEDUP_TTL_MS = 5 * 60 * 1000;
const MAX_DEDUP_ENTRIES = 1000;

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
    const placement = record.Garment_Placement || '';
    const due = record.Due_Date || '';
    const orderNum = record.Order_Num_SW || '';
    const contact = record.Full_Name_Contact || '';
    const notes = record.NOTES || '';
    const salesRep = record.Sales_Rep || '';
    const detailUrl = SITE_ORIGIN + '/art-request/' + encodeURIComponent(idDesign);

    const lines = [
        salesRep ? `🎨 *New Art Request from ${salesRep}*` : `🎨 *New Art Request*`,
        company ? `*Company:* ${company}` : '',
        designNum ? `*Design #:* ${designNum}` : '',
        placement ? `*Placement:* ${placement}` : '',
        due ? `*Due:* ${due}` : '',
        orderNum ? `*Order #:* ${orderNum}` : '',
        contact ? `*Contact:* ${contact}` : '',
        notes ? `*Notes:* ${String(notes).trim()}` : '',
        idDesign ? `\n<${detailUrl}|View art request>` : ''
    ];

    return lines.filter(Boolean).join('\n');
}

function buildPayload(record) {
    const text = buildText(record);
    const imageUrl = record.CDN_Link || '';
    const payload = { text };
    if (imageUrl && /^https?:\/\//i.test(imageUrl)) {
        payload.attachments = [{ image_url: imageUrl, text: 'Reference artwork' }];
    }
    return payload;
}

/**
 * Send a "new art request submission" Slack message.
 *
 * @param {object} record  — ArtRequests row (post-create). Required: ID_Design.
 *   Optional: CompanyName, Design_Num_SW, Garment_Placement, Due_Date,
 *   Order_Num_SW, Full_Name_Contact, NOTES, Sales_Rep, CDN_Link, Status.
 * @returns {Promise<{sent, skipped?, error?}>} — resolves rather than throws.
 */
async function notifyArtRequestSubmission(record) {
    if (!WEBHOOK_URL) {
        console.log('[SLACK_ART_SUBMISSION_SKIP]', 'no-webhook');
        return { sent: false, skipped: 'no-webhook' };
    }
    if (!record || record.ID_Design == null) {
        console.log('[SLACK_ART_SUBMISSION_SKIP]', 'missing-id-design');
        return { sent: false, skipped: 'missing-id-design' };
    }
    // Defensive: Zap filter required Status='Submitted'. New records typically
    // come in with Status='Submitted' but skip if explicitly something else.
    if (record.Status && record.Status !== 'Submitted') {
        console.log('[SLACK_ART_SUBMISSION_SKIP]', record.ID_Design, 'not-submitted', 'status=' + JSON.stringify(record.Status));
        return { sent: false, skipped: 'not-submitted' };
    }

    if (shouldSkipDedup(record.ID_Design)) {
        console.log('[SLACK_ART_SUBMISSION_SKIP]', record.ID_Design, 'dedup');
        return { sent: false, skipped: 'dedup' };
    }

    const payload = buildPayload(record);

    try {
        await axios.post(WEBHOOK_URL, payload, {
            timeout: 8000,
            headers: { 'Content-Type': 'application/json' }
        });
        console.log('[SLACK_ART_SUBMISSION_OK]', record.ID_Design);
        return { sent: true };
    } catch (err) {
        const msg = err && err.message ? err.message : String(err);
        console.warn('[SLACK_ART_SUBMISSION_FAIL]', record.ID_Design, msg);
        dedupCache.delete(String(record.ID_Design));
        return { sent: false, error: msg };
    }
}

module.exports = {
    notifyArtRequestSubmission,
    __test__: {
        clearDedup: () => dedupCache.clear(),
        getDedupSize: () => dedupCache.size,
        DEDUP_TTL_MS,
        buildText,
        buildPayload
    }
};
