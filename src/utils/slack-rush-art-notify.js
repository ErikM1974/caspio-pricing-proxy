// slack-rush-art-notify.js — POST a Slack incoming-webhook when an AE submits
// a rush art request. Targets #art-notifications (reused channel; rush
// messages stand out via 🔥 prefix).
//
// Replaces the "RUSH STEVE" Caspio-direct Zap. The Zap couldn't be configured
// to catch REST API event_sources in the current Caspio integration (Zapier
// blocked publish when those sources weren't "hooked up"), so it had been
// silently missing every AE-dashboard rush submission for months. Email via
// `sendRushConfirmation()` in art-actions-shared.js was the reliable channel;
// this fixes the Slack channel too.
//
// Activation: set `SLACK_ART_NOTIFICATIONS_WEBHOOK_URL` env (already in use
// for non-rush art notifications — no new env var needed). Unset = no-op.

const axios = require('axios');
const { formatCaspioDate } = require('./slack-date-format');

const WEBHOOK_URL = process.env.SLACK_ART_NOTIFICATIONS_WEBHOOK_URL || '';
const SITE_ORIGIN = process.env.SITE_ORIGIN || 'https://www.teamnwca.com';
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

/**
 * Caspio Is_Rush field can come back as boolean true/false, string 'true'/'Yes',
 * or numeric 1. Coerce defensively.
 */
function isTruthy(v) {
    return v === true || v === 'true' || v === 'Yes' || v === 1;
}

function buildText(record) {
    const idDesign = record.ID_Design != null ? String(record.ID_Design) : '';
    const company = record.CompanyName || '';
    const designNum = record.Design_Num_SW || '';
    const due = formatCaspioDate(record.Due_Date);
    const salesRep = record.Sales_Rep || '';
    const detailUrl = SITE_ORIGIN + '/art-request/' + encodeURIComponent(idDesign);

    const lines = [
        `🔥 *RUSH ART REQUEST*${company ? ' — ' + company : ''}`,
        designNum ? `*Design #:* ${designNum}` : '',
        due ? `*Due Date:* ${due}` : '',
        salesRep ? `*Submitted by:* ${salesRep}` : '',
        idDesign ? `\n<${detailUrl}|View art request>` : ''
    ];

    return lines.filter(Boolean).join('\n');
}

/**
 * Send a "rush art request" Slack message.
 *
 * Mirrors the original Zap's filter — only fires when Is_Rush is truthy on
 * the just-created record. Caller should invoke this on POST /artrequests
 * for every new record; this util gates internally on Is_Rush.
 *
 * @param {object} record  — ArtRequests row (post-create). Required: ID_Design.
 *   Optional: Is_Rush, CompanyName, Design_Num_SW, Due_Date, Sales_Rep.
 * @returns {Promise<{sent, skipped?, error?}>} — resolves rather than throws.
 */
async function notifyRushArtRequest(record) {
    if (!WEBHOOK_URL) {
        console.log('[SLACK_RUSH_ART_SKIP]', 'no-webhook');
        return { sent: false, skipped: 'no-webhook' };
    }
    if (!record || record.ID_Design == null) {
        console.log('[SLACK_RUSH_ART_SKIP]', 'missing-id-design');
        return { sent: false, skipped: 'missing-id-design' };
    }
    if (!isTruthy(record.Is_Rush)) {
        // Silent skip on most submissions (most aren't rush) — no log line to
        // keep heroku logs quiet for the common case.
        return { sent: false, skipped: 'not-rush' };
    }

    if (shouldSkipDedup(record.ID_Design)) {
        console.log('[SLACK_RUSH_ART_SKIP]', record.ID_Design, 'dedup');
        return { sent: false, skipped: 'dedup' };
    }

    const text = buildText(record);

    try {
        await axios.post(WEBHOOK_URL, { text }, {
            timeout: 8000,
            headers: { 'Content-Type': 'application/json' }
        });
        console.log('[SLACK_RUSH_ART_OK]', record.ID_Design);
        return { sent: true };
    } catch (err) {
        const msg = err && err.message ? err.message : String(err);
        console.warn('[SLACK_RUSH_ART_FAIL]', record.ID_Design, msg);
        dedupCache.delete(String(record.ID_Design));
        return { sent: false, error: msg };
    }
}

module.exports = {
    notifyRushArtRequest,
    __test__: {
        clearDedup: () => dedupCache.clear(),
        getDedupSize: () => dedupCache.size,
        DEDUP_TTL_MS,
        buildText,
        isTruthy
    }
};
