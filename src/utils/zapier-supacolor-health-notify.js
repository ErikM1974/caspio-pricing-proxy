// zapier-supacolor-health-notify.js — fire a Zapier webhook when the 10-min
// Supacolor sync cron stops running or starts producing stuck jobs. Zapier
// formats the payload into a Slack DM to Erik.
//
// Mirrors the shape of zapier-broken-mockup-notify.js. Same reason for going
// through Zapier instead of direct Slack: keeps the message body editable
// without a deploy.
//
// Activation: set `ZAPIER_SUPACOLOR_HEALTH_WEBHOOK_URL` env to the Zapier
// "Catch Hook" URL. Unset = no-op (safe for local dev).
//
// Dedup: in-memory `Map<dedupKey, expiresAt>` with 4-hour TTL. A persistent
// outage paged once per 4h per dyno — enough to nudge Erik without spam.

const axios = require('axios');

const WEBHOOK_URL = process.env.ZAPIER_SUPACOLOR_HEALTH_WEBHOOK_URL || '';
const DEDUP_TTL_MS = 4 * 60 * 60 * 1000; // 4 hours
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

/**
 * Send a "supacolor sync unhealthy" event to Zapier.
 *
 * @param {object} opts
 * @param {string} opts.reason       — 'stale-cron' | 'stuck-open-jobs' | 'both'
 * @param {number|null} [opts.lastSyncAgo_min]
 * @param {number} [opts.stuckOpenCount]
 * @param {number} [opts.totalApiRows]
 *
 * @returns {Promise<{sent, skipped?, error?}>} — resolves rather than throws.
 */
async function notifySupacolorHealth(opts) {
    opts = opts || {};

    if (!WEBHOOK_URL) {
        return { sent: false, skipped: 'no-webhook' };
    }

    const dedupKey = `supacolor-health|${opts.reason || 'unknown'}`;
    if (shouldSkipDedup(dedupKey)) {
        return { sent: false, skipped: 'dedup' };
    }

    const payload = {
        event: 'supacolor_sync_unhealthy',
        reason: opts.reason || 'unknown',
        lastSyncAgo_min: opts.lastSyncAgo_min != null ? opts.lastSyncAgo_min : null,
        stuckOpenCount: opts.stuckOpenCount != null ? opts.stuckOpenCount : 0,
        totalApiRows: opts.totalApiRows != null ? opts.totalApiRows : 0,
        dashboardUrl: 'https://www.teamnwca.com/dashboards/supacolor-orders.html',
        timestamp: new Date().toISOString()
    };

    try {
        await axios.post(WEBHOOK_URL, payload, {
            timeout: 8000,
            headers: { 'Content-Type': 'application/json' }
        });
        return { sent: true };
    } catch (err) {
        const msg = err && err.message ? err.message : String(err);
        console.warn('[ZAPIER_SUPACOLOR_HEALTH_FAIL]', dedupKey, msg);
        dedupCache.delete(dedupKey);
        return { sent: false, error: msg };
    }
}

module.exports = {
    notifySupacolorHealth,
    __test__: {
        clearDedup: () => dedupCache.clear(),
        getDedupSize: () => dedupCache.size,
        DEDUP_TTL_MS
    }
};
