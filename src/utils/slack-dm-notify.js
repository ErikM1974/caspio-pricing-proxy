// slack-dm-notify.js — DM an individual Slack user via the Web API
// (chat.postMessage). UNLIKE the incoming-webhook utils in this directory
// (slack-art-status-notify.js, etc.) which post to ONE fixed channel, this
// sends a DIRECT MESSAGE to a specific user. Used to alert the AE-of-record
// directly when their artwork is completed — channel pings to #art-notifications
// only reach members (Steve/Ruth), so AEs were never notified.
//
// Activation: set `SLACK_BOT_TOKEN` (xoxb-…) on the proxy with the `chat:write`
// scope (and `users:read.email` if you want the email→id lookup fallback to
// cover anyone not in EMAIL_TO_SLACK_ID). Unset = no-op (returns skipped:'no-token').
//
// Email → Slack user-id resolution order:
//   1. EMAIL_TO_SLACK_ID hardcoded map (fast, no extra scope needed).
//   2. users.lookupByEmail fallback (needs users:read.email) for unmapped AEs.
//
// RESOLVES, NEVER THROWS — the caller fires this fire-and-forget alongside the
// status update, which must succeed even if Slack is down.

const axios = require('axios');

// Read the token at call time (not module load) so tests can set it per-case.
function botToken() {
    return process.env.SLACK_BOT_TOKEN || '';
}

// Internal email → Slack user ID. Add AEs here as they join (keep in sync with
// rep-email-map.js REP_EMAIL_MAP). IDs verified 2026-06-26.
const EMAIL_TO_SLACK_ID = {
    'nika@nwcustomapparel.com':     'UFR8DAZAP',
    'taneisha@nwcustomapparel.com': 'U099VV5A52T'
};

/**
 * Resolve an internal email to a Slack user ID. Map first, then live lookup.
 * @returns {Promise<string|null>}
 */
async function resolveSlackUserId(email) {
    if (!email) return null;
    const lower = String(email).trim().toLowerCase();
    if (EMAIL_TO_SLACK_ID[lower]) return EMAIL_TO_SLACK_ID[lower];

    const token = botToken();
    if (!token) return null;
    try {
        const resp = await axios.get('https://slack.com/api/users.lookupByEmail', {
            params: { email: lower },
            headers: { Authorization: `Bearer ${token}` },
            timeout: 8000
        });
        if (resp.data && resp.data.ok && resp.data.user && resp.data.user.id) {
            return resp.data.user.id;
        }
        return null;
    } catch (err) {
        return null;
    }
}

/**
 * DM a Slack user identified by their internal email address.
 *
 * @param {string} email — internal @nwcustomapparel.com address of the recipient.
 * @param {string} text  — Slack mrkdwn message body.
 * @returns {Promise<{sent:boolean, skipped?:string, error?:string}>} resolves, never throws.
 */
async function sendSlackDM(email, text) {
    const token = botToken();
    if (!token) return { sent: false, skipped: 'no-token' };
    if (!email || !text) return { sent: false, skipped: 'missing-args' };

    const userId = await resolveSlackUserId(email);
    if (!userId) {
        console.log('[SLACK_DM_SKIP]', 'unresolved', email);
        return { sent: false, skipped: 'unresolved-user' };
    }

    try {
        // chat.postMessage with a user ID as `channel` opens/uses the IM with
        // that user — no separate conversations.open needed for workspace members.
        const resp = await axios.post('https://slack.com/api/chat.postMessage',
            { channel: userId, text },
            {
                headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
                timeout: 8000
            }
        );
        if (resp.data && resp.data.ok) {
            console.log('[SLACK_DM_OK]', email, userId);
            return { sent: true };
        }
        // Slack returns 200 with {ok:false, error} for auth/scope/channel issues.
        const errText = (resp.data && resp.data.error) || 'unknown';
        console.warn('[SLACK_DM_FAIL]', email, userId, errText);
        return { sent: false, error: errText };
    } catch (err) {
        const msg = (err && err.message) ? err.message : String(err);
        console.warn('[SLACK_DM_FAIL]', email, msg);
        return { sent: false, error: msg };
    }
}

module.exports = {
    sendSlackDM,
    resolveSlackUserId,
    __test__: { EMAIL_TO_SLACK_ID, botToken }
};
