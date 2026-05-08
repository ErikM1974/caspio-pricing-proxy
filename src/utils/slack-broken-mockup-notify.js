// slack-broken-mockup-notify.js — POST a Slack incoming-webhook when
// auto-recovery can't fix a broken Box mockup link. Targets the #mockup-alerts
// channel (Steve) so he knows to re-upload manually.
//
// Replaces zapier-broken-mockup-notify.js. Same fire-and-forget contract,
// same per-(designNumber, slotField) dedup with 24h TTL — message body and
// log prefix updated, env var renamed.
//
// Activation: set `SLACK_BROKEN_MOCKUP_WEBHOOK_URL` env to the Slack app's
// incoming-webhook URL (https://hooks.slack.com/services/...). Unset = no-op.

const axios = require('axios');

const WEBHOOK_URL = process.env.SLACK_BROKEN_MOCKUP_WEBHOOK_URL || '';
const DEDUP_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const MAX_DEDUP_ENTRIES = 5000;

const dedupCache = new Map();

function makeDedupKey(designNumber, slotField) {
    return `${String(designNumber || '').trim()}|${String(slotField || '').trim()}`;
}

function pruneDedupCache(now) {
    for (const [key, expiresAt] of dedupCache.entries()) {
        if (expiresAt <= now) dedupCache.delete(key);
    }
}

function shouldSkipDedup(dedupKey) {
    const now = Date.now();
    const expiresAt = dedupCache.get(dedupKey);
    if (expiresAt && expiresAt > now) return true;
    if (dedupCache.size >= MAX_DEDUP_ENTRIES) pruneDedupCache(now);
    dedupCache.set(dedupKey, now + DEDUP_TTL_MS);
    return false;
}

function buildText(opts) {
    const designNumber = String(opts.designNumber);
    const companyName = opts.companyName || '';
    const slotField = opts.slotField || '';
    const reason = opts.reason || 'unknown';
    const detailUrl = opts.detailUrl || '';
    const errorMsg = opts.error || '';

    const lines = [
        `⚠️ *Broken Mockup — auto-recovery failed*`,
        `*Design:* ${designNumber}`,
        companyName ? `*Company:* ${companyName}` : '',
        slotField ? `*Slot:* \`${slotField}\`` : '',
        `*Reason:* ${reason}`,
        errorMsg ? `*Error:* ${errorMsg}` : '',
        detailUrl ? `\n<${detailUrl}|Open detail page>` : ''
    ];

    return lines.filter(Boolean).join('\n');
}

/**
 * Send a "broken mockup unrecoverable" Slack message.
 *
 * @param {object} opts
 * @param {string} opts.designNumber
 * @param {string} [opts.companyName]
 * @param {string|number} [opts.pkId]
 * @param {string} [opts.table]
 * @param {string} [opts.slotField]
 * @param {string} [opts.detailUrl]
 * @param {string} [opts.reason]
 * @param {string} [opts.error]
 * @returns {Promise<{sent, skipped?, error?}>} — resolves rather than throws.
 */
async function notifyBrokenMockup(opts) {
    opts = opts || {};

    if (!WEBHOOK_URL) {
        console.log('[SLACK_BROKEN_MOCKUP_SKIP]', 'no-webhook');
        return { sent: false, skipped: 'no-webhook' };
    }
    if (!opts.designNumber) {
        console.log('[SLACK_BROKEN_MOCKUP_SKIP]', 'missing-design-number');
        return { sent: false, skipped: 'missing-design-number' };
    }

    const dedupKey = makeDedupKey(opts.designNumber, opts.slotField || '');
    if (shouldSkipDedup(dedupKey)) {
        console.log('[SLACK_BROKEN_MOCKUP_SKIP]', dedupKey, 'dedup');
        return { sent: false, skipped: 'dedup' };
    }

    const text = buildText(opts);

    try {
        await axios.post(WEBHOOK_URL, { text }, {
            timeout: 8000,
            headers: { 'Content-Type': 'application/json' }
        });
        console.log('[SLACK_BROKEN_MOCKUP_OK]', dedupKey);
        return { sent: true };
    } catch (err) {
        const msg = err && err.message ? err.message : String(err);
        console.warn('[SLACK_BROKEN_MOCKUP_FAIL]', dedupKey, msg);
        // Roll back so a transient Slack outage doesn't silence this design for 24h.
        dedupCache.delete(dedupKey);
        return { sent: false, error: msg };
    }
}

module.exports = {
    notifyBrokenMockup,
    __test__: {
        clearDedup: () => dedupCache.clear(),
        getDedupSize: () => dedupCache.size,
        DEDUP_TTL_MS,
        buildText
    }
};
