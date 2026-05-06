// zapier-broken-mockup-notify.js — fire a Zapier webhook when auto-recovery
// can't fix a broken Box mockup link. Zapier formats the payload into a Slack
// DM to Steve so he knows to re-upload manually.
//
// Why Zapier and not direct Slack: Erik already runs 6+ Caspio-driven Zaps
// (RUSH STEVE, RUSH RUTH, etc.) and prefers configuring notification routing
// in Zapier's UI rather than in our backend code. Keeps the message body
// editable without a deploy.
//
// Activation: set `ZAPIER_BROKEN_MOCKUP_WEBHOOK_URL` env to the Zapier
// "Catch Hook" URL. If unset, this module is a no-op — useful for local dev
// and for shipping the code before the Zap exists.
//
// Dedup: in-memory `Map<dedupKey, expiresAt>` with 24h TTL prevents Steve
// from getting paged twice for the same broken design (e.g. when his
// dashboard auto-refreshes and re-tries the same recovery). Process-local —
// if the proxy ever scales to multiple dynos, we accept up to N pings per
// design per 24h, which is acceptable noise.

const axios = require('axios');

const WEBHOOK_URL = process.env.ZAPIER_BROKEN_MOCKUP_WEBHOOK_URL || '';
const DEDUP_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const MAX_DEDUP_ENTRIES = 5000; // cheap memory cap — far more than realistic broken-design count

// Map<dedupKey:string, expiresAtMs:number>
const dedupCache = new Map();

/**
 * Compose a stable dedup key per (designNumber, slotField) pair. Two slots
 * broken on the same design fire two distinct pings (one per slot) so Steve
 * knows exactly which slot to re-upload.
 */
function makeDedupKey(designNumber, slotField) {
    return `${String(designNumber || '').trim()}|${String(slotField || '').trim()}`;
}

/**
 * Walk the dedup cache and drop expired entries. Cheap O(n) linear scan —
 * runs only when the cache exceeds MAX_DEDUP_ENTRIES (i.e. nearly never).
 */
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
 * Send a "broken mockup unrecoverable" event to Zapier.
 *
 * @param {object} opts
 * @param {string} opts.designNumber  — Design# (Steve's `Design_Num_SW` or Ruth's `Design_Number`)
 * @param {string} [opts.companyName] — Customer / company name for human-readable message
 * @param {string|number} [opts.pkId] — Caspio row identifier (PK_ID for ArtRequests, ID for Digitizing_Mockups)
 * @param {string} [opts.table]       — 'ArtRequests' | 'Digitizing_Mockups'
 * @param {string} [opts.slotField]   — e.g. 'Box_File_Mockup' or 'Box_Mockup_3'
 * @param {string} [opts.detailUrl]   — full clickable URL to the detail page
 * @param {string} [opts.reason]      — recovery util's status: 'no-folder'|'empty-folder'|'no-match'|'error'
 * @param {string} [opts.error]       — error message when reason === 'error'
 *
 * @returns {Promise<{sent: boolean, skipped?: 'no-webhook'|'dedup', error?: string}>}
 *   Resolves rather than throws — caller (recovery util) can't recover from
 *   a notify failure and shouldn't have its own behavior blocked by it.
 */
async function notifyBrokenMockup(opts) {
    opts = opts || {};

    if (!WEBHOOK_URL) {
        return { sent: false, skipped: 'no-webhook' };
    }
    if (!opts.designNumber) {
        return { sent: false, skipped: 'missing-design-number' };
    }

    const dedupKey = makeDedupKey(opts.designNumber, opts.slotField || '');
    if (shouldSkipDedup(dedupKey)) {
        return { sent: false, skipped: 'dedup' };
    }

    const payload = {
        event: 'broken_mockup_unrecoverable',
        designNumber: String(opts.designNumber),
        companyName: opts.companyName || '',
        pkId: opts.pkId != null ? String(opts.pkId) : '',
        table: opts.table || '',
        slotField: opts.slotField || '',
        detailUrl: opts.detailUrl || '',
        reason: opts.reason || 'unknown',
        error: opts.error || null,
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
        console.warn('[ZAPIER_NOTIFY_FAIL]', dedupKey, msg);
        // Roll back the dedup entry so a transient Zapier outage doesn't
        // permanently silence this design for 24h.
        dedupCache.delete(dedupKey);
        return { sent: false, error: msg };
    }
}

module.exports = {
    notifyBrokenMockup,
    // Exported for tests so they can reset state between cases.
    __test__: {
        clearDedup: () => dedupCache.clear(),
        getDedupSize: () => dedupCache.size,
        DEDUP_TTL_MS
    }
};
