// slack-mockup-submission-notify.js — POST a Slack incoming-webhook when an
// AE submits a new mockup request. Targets #mockup-notifications channel
// (Ruth, Erik, AEs).
//
// Replaces the "New Mockup Submission → Slack Ruth + AE" Zap which had
// `event_sources:["Datasheet"]` and missed every form submission that came
// through POST /api/mockups (the actual workflow path).
//
// Original Zap had a 3-action chain: DM Ruth, find_user_by_email,
// DM that AE + Erik. We collapse that to a channel post where Ruth + AEs
// are members — same notification reach without the Slack Web API overhead.
//
// Activation: set `SLACK_MOCKUP_NOTIFICATIONS_WEBHOOK_URL` env. Unset = no-op.

const axios = require('axios');

const WEBHOOK_URL = process.env.SLACK_MOCKUP_NOTIFICATIONS_WEBHOOK_URL || '';
const SITE_ORIGIN = process.env.SITE_ORIGIN || 'https://teamnwca.com';
const DEDUP_TTL_MS = 5 * 60 * 1000;
const MAX_DEDUP_ENTRIES = 1000;

const dedupCache = new Map();

function pruneDedupCache(now) {
    for (const [key, expiresAt] of dedupCache.entries()) {
        if (expiresAt <= now) dedupCache.delete(key);
    }
}

function shouldSkipDedup(id) {
    if (id == null) return false;
    const key = String(id);
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
    const designName = record.Design_Name || '';
    const mockupType = record.Mockup_Type || '';
    const placement = record.Print_Location || '';
    const garment = record.Garment_Info || '';
    const due = record.Due_Date || '';
    const wo = record.Work_Order_Number || '';
    const salesRep = record.Sales_Rep || '';
    const detailUrl = SITE_ORIGIN + '/mockup/' + encodeURIComponent(id);

    const designLine = [designNum, designName].filter(Boolean).join(' — ');

    const lines = [
        salesRep ? `🎨 *New Mockup Request from ${salesRep}*` : `🎨 *New Mockup Request*`,
        company ? `*Company:* ${company}` : '',
        designLine ? `*Design #:* ${designLine}` : '',
        mockupType ? `*Type:* ${mockupType}` : '',
        placement ? `*Placement:* ${placement}` : '',
        garment ? `*Garment:* ${garment}` : '',
        due ? `*Due:* ${due}` : '',
        wo ? `*Work Order:* ${wo}` : '',
        id ? `\n<${detailUrl}|View mockup>` : ''
    ];

    return lines.filter(Boolean).join('\n');
}

/**
 * Build the Slack payload (text + optional image attachment).
 */
function buildPayload(record) {
    const text = buildText(record);
    const imageUrl = record.Box_Reference_File || '';
    const payload = { text };
    if (imageUrl && /^https?:\/\//i.test(imageUrl)) {
        payload.attachments = [{ image_url: imageUrl, text: 'Reference artwork' }];
    }
    return payload;
}

/**
 * Send a "new mockup submission" Slack message.
 *
 * Mirrors the original Zap filter: Status='Submitted' AND Revision_Count<1 AND !Is_Deleted.
 * Caller should only invoke this on POST /mockups (creation), where these conditions
 * are inherently satisfied — but we re-check defensively in case PUT paths invoke it.
 *
 * @param {object} record  — Digitizing_Mockups row (post-create). Required: ID.
 *   Optional: Company_Name, Design_Number, Design_Name, Mockup_Type, Print_Location,
 *   Garment_Info, Due_Date, Work_Order_Number, Sales_Rep, Box_Reference_File,
 *   Status, Revision_Count, Is_Deleted.
 * @returns {Promise<{sent, skipped?, error?}>} — resolves rather than throws.
 */
async function notifyMockupSubmission(record) {
    if (!WEBHOOK_URL) {
        console.log('[SLACK_MOCKUP_SUBMISSION_SKIP]', 'no-webhook');
        return { sent: false, skipped: 'no-webhook' };
    }
    if (!record || record.ID == null) {
        console.log('[SLACK_MOCKUP_SUBMISSION_SKIP]', 'missing-id');
        return { sent: false, skipped: 'missing-id' };
    }

    // Defensive filter mirroring the original Zap conditions.
    if (record.Status && record.Status !== 'Submitted') {
        console.log('[SLACK_MOCKUP_SUBMISSION_SKIP]', record.ID, 'not-submitted', 'status=' + JSON.stringify(record.Status));
        return { sent: false, skipped: 'not-submitted' };
    }
    if (record.Revision_Count != null && Number(record.Revision_Count) >= 1) {
        console.log('[SLACK_MOCKUP_SUBMISSION_SKIP]', record.ID, 'has-revisions');
        return { sent: false, skipped: 'has-revisions' };
    }
    if (record.Is_Deleted === true || record.Is_Deleted === 'true' || record.Is_Deleted === 1) {
        console.log('[SLACK_MOCKUP_SUBMISSION_SKIP]', record.ID, 'is-deleted');
        return { sent: false, skipped: 'is-deleted' };
    }

    if (shouldSkipDedup(record.ID)) {
        console.log('[SLACK_MOCKUP_SUBMISSION_SKIP]', record.ID, 'dedup');
        return { sent: false, skipped: 'dedup' };
    }

    const payload = buildPayload(record);

    try {
        await axios.post(WEBHOOK_URL, payload, {
            timeout: 8000,
            headers: { 'Content-Type': 'application/json' }
        });
        console.log('[SLACK_MOCKUP_SUBMISSION_OK]', record.ID);
        return { sent: true };
    } catch (err) {
        const msg = err && err.message ? err.message : String(err);
        console.warn('[SLACK_MOCKUP_SUBMISSION_FAIL]', record.ID, msg);
        dedupCache.delete(String(record.ID));
        return { sent: false, error: msg };
    }
}

module.exports = {
    notifyMockupSubmission,
    __test__: {
        clearDedup: () => dedupCache.clear(),
        getDedupSize: () => dedupCache.size,
        DEDUP_TTL_MS,
        buildText,
        buildPayload
    }
};
