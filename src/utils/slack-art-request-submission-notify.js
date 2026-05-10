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
const { formatCaspioDate } = require('./slack-date-format');

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

// Item_Type → header emoji + label + image-attachment caption.
// NULL/missing → Garment (matches the dashboard fallback in MEMORY.md).
const ITEM_TYPE_META = {
    Garment:  { emoji: '🎨',  label: 'Art Request',                  imageCaption: 'Reference artwork' },
    Sticker:  { emoji: '🏷️', label: 'Sticker Request',              imageCaption: 'Reference artwork' },
    Banner:   { emoji: '🪧',  label: 'Banner Request (Manual Quote)', imageCaption: 'Reference artwork' },
    JDS:      { emoji: '🔬',  label: 'JDS Laser Request',            imageCaption: 'Catalog / reference' }
};

function metaForItemType(itemType) {
    const key = itemType ? String(itemType).trim() : '';
    return ITEM_TYPE_META[key] || ITEM_TYPE_META.Garment;
}

function buildText(record) {
    const idDesign = record.ID_Design != null ? String(record.ID_Design) : '';
    const company = record.CompanyName || '';
    const designNum = record.Design_Num_SW || '';
    const placement = record.Garment_Placement || '';
    const due = formatCaspioDate(record.Due_Date);
    const orderNum = record.Order_Num_SW || '';
    const contact = record.Full_Name_Contact || '';
    const notes = record.NOTES || '';
    const specs = record.Item_Specs_Notes || '';
    const salesRep = record.Sales_Rep || '';
    const jdsSku = record.JDS_SKU || '';
    const meta = metaForItemType(record.Item_Type);
    const isGarment = meta === ITEM_TYPE_META.Garment;
    const detailUrl = SITE_ORIGIN + '/art-request/' + encodeURIComponent(idDesign);

    const headerSuffix = salesRep ? ` from ${salesRep}` : '';
    const lines = [
        `${meta.emoji} *New ${meta.label}${headerSuffix}*`,
        company ? `*Company:* ${company}` : '',
        designNum ? `*Design #:* ${designNum}` : '',
        // Garment-only field — placement makes no sense for stickers/banners/JDS
        isGarment && placement ? `*Placement:* ${placement}` : '',
        // JDS-only field — surfaces the laser SKU so Steve sees the product code
        !isGarment && jdsSku ? `*JDS SKU:* ${jdsSku}` : '',
        due ? `*Due:* ${due}` : '',
        orderNum ? `*Order #:* ${orderNum}` : '',
        contact ? `*Contact:* ${contact}` : '',
        // Sticker/Banner/JDS forms put the structured spec card here. Garment
        // forms leave it blank — fall back to NOTES for those.
        !isGarment && specs ? `*Specs:*\n${String(specs).trim()}` : '',
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
        const meta = metaForItemType(record.Item_Type);
        payload.attachments = [{ image_url: imageUrl, text: meta.imageCaption }];
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
        buildPayload,
        ITEM_TYPE_META,
        metaForItemType
    }
};
