// slack-art-reminder-notify.js — POST a Slack incoming-webhook when an AE
// hits "Send Reminder" on an art request that's in Awaiting Approval. Targets
// #art-notifications so the team has shared visibility that a customer was
// nudged (the customer-facing email goes via EmailJS as before).
//
// Send-Reminder is a soft event: it doesn't change Caspio Status, only logs a
// note + sends an email. So the existing status-transition notify won't fire
// — this module is the one and only Slack signal for that action.
//
// Activation: set `SLACK_ART_NOTIFICATIONS_WEBHOOK_URL` env (already in use).
// Unset = no-op.

const axios = require('axios');

const WEBHOOK_URL = process.env.SLACK_ART_NOTIFICATIONS_WEBHOOK_URL || '';
const SITE_ORIGIN = process.env.SITE_ORIGIN || 'https://www.teamnwca.com';
// Reminders are deliberately permitted multiple times per design across days
// (an AE may need to nudge twice). 30-min dedup is just protection against
// double-clicks / accidental dupes within a session.
const DEDUP_TTL_MS = 30 * 60 * 1000;
const MAX_DEDUP_ENTRIES = 1000;

const dedupCache = new Map();

function pruneDedupCache(now) {
    for (const [key, expiresAt] of dedupCache.entries()) {
        if (expiresAt <= now) dedupCache.delete(key);
    }
}

function shouldSkipDedup(idDesign, sentAt) {
    if (idDesign == null) return false;
    // Bucket key by the minute so a true legitimate retry from the AE clicking
    // again 30 min later still gets through.
    const bucket = Math.floor((sentAt || Date.now()) / DEDUP_TTL_MS);
    const key = `${idDesign}|${bucket}`;
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
    const aeName = record.AE_Name || '';
    const recipient = record.Recipient_Email || '';
    const detailUrl = SITE_ORIGIN + '/art-request/' + encodeURIComponent(idDesign);

    const headerSuffix = aeName ? ` by ${aeName}` : '';
    const lines = [
        `🔔 *Approval Reminder Sent${headerSuffix}*`,
        company ? `*Company:* ${company}` : '',
        designNum ? `*Design #:* ${designNum}` : '',
        recipient ? `*To:* ${recipient}` : '',
        idDesign ? `\n<${detailUrl}|View art request>` : ''
    ];

    return lines.filter(Boolean).join('\n');
}

/**
 * Send a "reminder sent" Slack message.
 *
 * @param {object} record  — { ID_Design, CompanyName?, Design_Num_SW?, AE_Name?, Recipient_Email? }
 * @returns {Promise<{sent, skipped?, error?}>} — resolves rather than throws.
 */
async function notifyArtReminder(record) {
    if (!WEBHOOK_URL) {
        return { sent: false, skipped: 'no-webhook' };
    }
    if (!record || record.ID_Design == null) {
        console.log('[SLACK_ART_REMINDER_SKIP]', 'missing-id-design');
        return { sent: false, skipped: 'missing-id-design' };
    }

    if (shouldSkipDedup(record.ID_Design, Date.now())) {
        console.log('[SLACK_ART_REMINDER_SKIP]', record.ID_Design, 'dedup');
        return { sent: false, skipped: 'dedup' };
    }

    const text = buildText(record);

    try {
        await axios.post(WEBHOOK_URL, { text }, {
            timeout: 8000,
            headers: { 'Content-Type': 'application/json' }
        });
        console.log('[SLACK_ART_REMINDER_OK]', record.ID_Design);
        return { sent: true };
    } catch (err) {
        const msg = err && err.message ? err.message : String(err);
        console.warn('[SLACK_ART_REMINDER_FAIL]', record.ID_Design, msg);
        // Don't roll back this dedup — Slack outage shouldn't enable rapid retries.
        return { sent: false, error: msg };
    }
}

module.exports = {
    notifyArtReminder,
    __test__: {
        clearDedup: () => dedupCache.clear(),
        getDedupSize: () => dedupCache.size,
        DEDUP_TTL_MS,
        buildText
    }
};
