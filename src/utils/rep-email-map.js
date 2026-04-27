// Sales rep name → email lookup. Mirrors the frontend REP_EMAIL_MAP in
// shared_components/js/art-actions-shared.js. Keep in sync — when a new AE
// joins, add them in both places.
//
// Used by digest emails that group ArtRequests / Digitizing_Mockups by
// `Sales_Rep || User_Email`. The Caspio `Sales_Rep` field is a free-text
// first name (e.g. "Taneisha"); `User_Email` is already an email address.

const REP_EMAIL_MAP = {
    'Taneisha': 'taneisha@nwcustomapparel.com',
    'Nika':     'nika@nwcustomapparel.com',
    'Ruthie':   'ruthie@nwcustomapparel.com',
    'Erik':     'erik@nwcustomapparel.com'
};

/**
 * Resolve a Sales_Rep value (or a User_Email fallback) to an email address.
 * Returns null if we can't resolve, so callers can skip cleanly and log.
 *
 * Examples:
 *   resolveAEEmail('Taneisha')                  → 'taneisha@nwcustomapparel.com'
 *   resolveAEEmail('taneisha@nwcustomapparel.com') → same string (already email)
 *   resolveAEEmail('Unknown')                   → null
 *   resolveAEEmail('')                          → null
 */
function resolveAEEmail(value) {
    if (!value || typeof value !== 'string') return null;
    var trimmed = value.trim();
    if (!trimmed) return null;
    if (trimmed.indexOf('@') !== -1) return trimmed.toLowerCase();
    if (Object.prototype.hasOwnProperty.call(REP_EMAIL_MAP, trimmed)) {
        return REP_EMAIL_MAP[trimmed];
    }
    return null;
}

/** Best-effort first name for greeting. Falls back to "there". */
function resolveAEName(value) {
    if (!value || typeof value !== 'string') return 'there';
    var trimmed = value.trim();
    if (!trimmed) return 'there';
    if (trimmed.indexOf('@') === -1) return trimmed;
    var local = trimmed.split('@')[0];
    return local.charAt(0).toUpperCase() + local.slice(1);
}

module.exports = { REP_EMAIL_MAP, resolveAEEmail, resolveAEName };
