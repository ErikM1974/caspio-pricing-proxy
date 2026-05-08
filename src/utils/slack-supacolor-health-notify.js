// slack-supacolor-health-notify.js — POST a Slack incoming-webhook when the
// 10-min Supacolor sync cron stops running or starts producing stuck jobs.
// Targets the #supacolor-health channel (Erik).
//
// Replaces zapier-supacolor-health-notify.js. Same shape, 4-hour dedup TTL,
// fire-and-forget. Env var renamed; payload is now Slack mrkdwn.
//
// Activation: set `SLACK_SUPACOLOR_HEALTH_WEBHOOK_URL` env. Unset = no-op.

const axios = require('axios');

const WEBHOOK_URL = process.env.SLACK_SUPACOLOR_HEALTH_WEBHOOK_URL || '';
const DEDUP_TTL_MS = 4 * 60 * 60 * 1000; // 4 hours — persistent outage paged once per 4h per dyno
const MAX_DEDUP_ENTRIES = 100;

const dedupCache = new Map();

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
    const reason = opts.reason || 'unknown';
    const lastSyncAgo = opts.lastSyncAgo_min != null ? `${opts.lastSyncAgo_min} min` : 'unknown';
    const stuckOpenCount = opts.stuckOpenCount != null ? opts.stuckOpenCount : 0;
    const totalApiRows = opts.totalApiRows != null ? opts.totalApiRows : 0;
    const dashboardUrl = 'https://www.teamnwca.com/dashboards/supacolor-orders.html';

    const lines = [
        `🚨 *Supacolor Sync Unhealthy*`,
        `*Reason:* ${reason}`,
        `*Last sync:* ${lastSyncAgo} ago`,
        `*Stuck open jobs:* ${stuckOpenCount}`,
        `*Total API rows:* ${totalApiRows}`,
        `\n<${dashboardUrl}|Open Supacolor dashboard>`
    ];

    return lines.filter(Boolean).join('\n');
}

/**
 * Send a "supacolor sync unhealthy" Slack message.
 *
 * @param {object} opts
 * @param {string} opts.reason — 'stale-cron' | 'stuck-open-jobs' | 'both'
 * @param {number|null} [opts.lastSyncAgo_min]
 * @param {number} [opts.stuckOpenCount]
 * @param {number} [opts.totalApiRows]
 * @returns {Promise<{sent, skipped?, error?}>} — resolves rather than throws.
 */
async function notifySupacolorHealth(opts) {
    opts = opts || {};

    if (!WEBHOOK_URL) {
        console.log('[SLACK_SUPACOLOR_HEALTH_SKIP]', 'no-webhook');
        return { sent: false, skipped: 'no-webhook' };
    }

    const dedupKey = `supacolor-health|${opts.reason || 'unknown'}`;
    if (shouldSkipDedup(dedupKey)) {
        console.log('[SLACK_SUPACOLOR_HEALTH_SKIP]', dedupKey, 'dedup');
        return { sent: false, skipped: 'dedup' };
    }

    const text = buildText(opts);

    try {
        await axios.post(WEBHOOK_URL, { text }, {
            timeout: 8000,
            headers: { 'Content-Type': 'application/json' }
        });
        console.log('[SLACK_SUPACOLOR_HEALTH_OK]', dedupKey);
        return { sent: true };
    } catch (err) {
        const msg = err && err.message ? err.message : String(err);
        console.warn('[SLACK_SUPACOLOR_HEALTH_FAIL]', dedupKey, msg);
        dedupCache.delete(dedupKey);
        return { sent: false, error: msg };
    }
}

module.exports = {
    notifySupacolorHealth,
    __test__: {
        clearDedup: () => dedupCache.clear(),
        getDedupSize: () => dedupCache.size,
        DEDUP_TTL_MS,
        buildText
    }
};
