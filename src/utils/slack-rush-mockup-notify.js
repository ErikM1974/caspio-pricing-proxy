// slack-rush-mockup-notify.js — POST a Slack incoming-webhook when an AE
// submits a rush mockup. Targets #mockup-notifications (reused channel;
// rush messages stand out via 🔥 prefix).
//
// Replaces the "RUSH RUTH" Caspio-direct Zap. The Zap couldn't be configured
// to catch REST API event_sources in the current Caspio integration (Zapier
// blocked publish when those sources weren't "hooked up"), so it had been
// silently missing every AE-dashboard rush mockup submission for months.
//
// Activation: set `SLACK_MOCKUP_NOTIFICATIONS_WEBHOOK_URL` env (already in
// use for non-rush mockup notifications — no new env var needed). Unset = no-op.

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

function isTruthy(v) {
    return v === true || v === 'true' || v === 'Yes' || v === 1;
}

function buildText(record) {
    const id = record.ID != null ? String(record.ID) : '';
    const customer = record.Customer_Name || record.Company_Name || '';
    const designNum = record.Design_Number || '';
    const designName = record.Design_Name || '';
    const mockupType = record.Mockup_Type || '';
    const location = record.Print_Location || '';
    const due = record.Due_Date || '';
    const submittedBy = record.Submitted_By || record.Sales_Rep || '';
    const detailUrl = SITE_ORIGIN + '/mockup/' + encodeURIComponent(id);

    const designLine = [designNum, designName].filter(Boolean).join(' — ');

    const lines = [
        `🔥 *RUSH MOCKUP REQUEST*${customer ? ' — ' + customer : ''}`,
        designLine ? `*Design:* ${designLine}` : '',
        mockupType ? `*Type:* ${mockupType}` : '',
        location ? `*Location:* ${location}` : '',
        due ? `*Due Date:* ${due}` : '',
        submittedBy ? `*Submitted by:* ${submittedBy}` : '',
        id ? `\n<${detailUrl}|View mockup>` : ''
    ];

    return lines.filter(Boolean).join('\n');
}

/**
 * Send a "rush mockup request" Slack message.
 *
 * Mirrors the original RUSH RUTH Zap's filter — only fires when Is_Rush is
 * truthy on the just-created record. Caller invokes on every POST /mockups;
 * this util gates internally on Is_Rush.
 *
 * @param {object} record  — Digitizing_Mockups row (post-create). Required: ID.
 *   Optional: Is_Rush, Customer_Name/Company_Name, Design_Number, Design_Name,
 *   Mockup_Type, Print_Location, Due_Date, Submitted_By/Sales_Rep.
 * @returns {Promise<{sent, skipped?, error?}>} — resolves rather than throws.
 */
async function notifyRushMockup(record) {
    if (!WEBHOOK_URL) {
        console.log('[SLACK_RUSH_MOCKUP_SKIP]', 'no-webhook');
        return { sent: false, skipped: 'no-webhook' };
    }
    if (!record || record.ID == null) {
        console.log('[SLACK_RUSH_MOCKUP_SKIP]', 'missing-id');
        return { sent: false, skipped: 'missing-id' };
    }
    if (!isTruthy(record.Is_Rush)) {
        // Silent skip — most mockups aren't rush. Avoid log noise.
        return { sent: false, skipped: 'not-rush' };
    }

    if (shouldSkipDedup(record.ID)) {
        console.log('[SLACK_RUSH_MOCKUP_SKIP]', record.ID, 'dedup');
        return { sent: false, skipped: 'dedup' };
    }

    const text = buildText(record);

    try {
        await axios.post(WEBHOOK_URL, { text }, {
            timeout: 8000,
            headers: { 'Content-Type': 'application/json' }
        });
        console.log('[SLACK_RUSH_MOCKUP_OK]', record.ID);
        return { sent: true };
    } catch (err) {
        const msg = err && err.message ? err.message : String(err);
        console.warn('[SLACK_RUSH_MOCKUP_FAIL]', record.ID, msg);
        dedupCache.delete(String(record.ID));
        return { sent: false, error: msg };
    }
}

module.exports = {
    notifyRushMockup,
    __test__: {
        clearDedup: () => dedupCache.clear(),
        getDedupSize: () => dedupCache.size,
        DEDUP_TTL_MS,
        buildText,
        isTruthy
    }
};
