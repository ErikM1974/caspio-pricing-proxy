// slack-art-note-notify.js — POST a Slack incoming-webhook when a note is
// added to an art request. Targets the #art-notifications channel (Steve,
// Erik, AEs) — same webhook as the new-submission notifier.
//
// Replaces the silent gap on POST /api/design-notes, which today is a pure
// Caspio write with zero notifications. The only alert was a frontend
// EmailJS call hardwired to the sales-rep-of-record and mislabeled "from
// Steve". Notification now lives on the backend and is DIRECTION-AWARE:
//
//   direction='ae'     — an AE / sales rep wrote the note → Steve needs it.
//   direction='artist' — Steve/Ruth (art dept) wrote the note → the rep
//                        needs it.
//
// A channel post means Steve + Erik + AEs all see it regardless of
// direction; the header line just makes the intended audience explicit.
//
// Activation: set `SLACK_ART_NOTIFICATIONS_WEBHOOK_URL` env. Unset = no-op.

const axios = require('axios');

const WEBHOOK_URL = process.env.SLACK_ART_NOTIFICATIONS_WEBHOOK_URL || '';
const SITE_ORIGIN = process.env.SITE_ORIGIN || 'https://teamnwca.com';
const DEDUP_TTL_MS = 5 * 60 * 1000;
const MAX_DEDUP_ENTRIES = 1000;
const MAX_NOTE_CHARS = 600;

const dedupCache = new Map();

function pruneDedupCache(now) {
    for (const [key, expiresAt] of dedupCache.entries()) {
        if (expiresAt <= now) dedupCache.delete(key);
    }
}

// Dedup on Note_ID. If the caller doesn't have one (null/undefined), skip
// dedup entirely rather than crashing — a missing id just means we can't
// collapse a double-fire, which is acceptable.
function shouldSkipDedup(noteId) {
    if (noteId == null) return false;
    const key = String(noteId);
    const now = Date.now();
    const expiresAt = dedupCache.get(key);
    if (expiresAt && expiresAt > now) return true;
    if (dedupCache.size >= MAX_DEDUP_ENTRIES) pruneDedupCache(now);
    dedupCache.set(key, now + DEDUP_TTL_MS);
    return false;
}

function truncateNote(text) {
    const trimmed = String(text == null ? '' : text).trim();
    if (trimmed.length <= MAX_NOTE_CHARS) return trimmed;
    return trimmed.slice(0, MAX_NOTE_CHARS) + '…';
}

function buildText(opts) {
    opts = opts || {};
    const idDesign = opts.idDesign != null ? String(opts.idDesign) : '';
    const company = opts.company || '';
    const designNum = opts.designNum || '';
    const noteType = opts.noteType || '';
    const noteText = truncateNote(opts.noteText);
    const noteBy = opts.noteBy || 'someone';
    const detailUrl = SITE_ORIGIN + '/art-request/' + encodeURIComponent(idDesign);

    // Header depends on who wrote the note (and therefore who needs it).
    const header = opts.direction === 'artist'
        ? `📝 *Art Dept note — from ${noteBy}*`
        : `📝 *New note for Steve — from ${noteBy}*`;

    const lines = [
        header,
        company ? `*Company:* ${company}` : '',
        designNum ? `*Design #:* ${designNum}` : '',
        noteType ? `*Type:* ${noteType}` : '',
        noteText ? `*Note:* ${noteText}` : '',
        idDesign ? `\n<${detailUrl}|View art request>` : ''
    ];

    return lines.filter(Boolean).join('\n');
}

function buildPayload(opts) {
    const text = buildText(opts);
    return { text };
}

/**
 * Send a "note added to art request" Slack message.
 *
 * @param {object} opts
 * @param {number|string} opts.idDesign  — ID_Design of the art request (for the link).
 * @param {number|string} [opts.noteId]  — Note_ID for dedup; missing → no dedup.
 * @param {string} [opts.noteType]       — note type label.
 * @param {string} [opts.noteText]       — note body (truncated to 600 chars).
 * @param {string} [opts.noteBy]         — who wrote the note.
 * @param {'ae'|'artist'} [opts.direction] — drives the header line.
 * @param {string} [opts.company]        — company name.
 * @param {string} [opts.designNum]      — Design_Num_SW.
 * @returns {Promise<{sent, skipped?, error?}>} — resolves rather than throws.
 */
async function notifyArtNote(opts) {
    opts = opts || {};
    if (!WEBHOOK_URL) {
        console.log('[SLACK_ART_NOTE_SKIP]', 'no-webhook');
        return { sent: false, skipped: 'no-webhook' };
    }

    if (shouldSkipDedup(opts.noteId)) {
        console.log('[SLACK_ART_NOTE_SKIP]', opts.noteId, 'dedup');
        return { sent: false, skipped: 'dedup' };
    }

    const payload = buildPayload(opts);

    try {
        await axios.post(WEBHOOK_URL, payload, {
            timeout: 8000,
            headers: { 'Content-Type': 'application/json' }
        });
        console.log('[SLACK_ART_NOTE_OK]', opts.idDesign != null ? opts.idDesign : '(no-id-design)');
        return { sent: true };
    } catch (err) {
        const msg = err && err.message ? err.message : String(err);
        console.warn('[SLACK_ART_NOTE_FAIL]', opts.idDesign != null ? opts.idDesign : '(no-id-design)', msg);
        if (opts.noteId != null) dedupCache.delete(String(opts.noteId));
        return { sent: false, error: msg };
    }
}

module.exports = {
    notifyArtNote,
    __test__: {
        clearDedup: () => dedupCache.clear(),
        getDedupSize: () => dedupCache.size,
        DEDUP_TTL_MS,
        buildText,
        buildPayload
    }
};
