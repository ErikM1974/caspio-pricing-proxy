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

// Only the internal domain is allowed to receive AE digests. User_Email on
// ArtRequests is sometimes a CUSTOMER email (when Sales_Rep is blank and a
// customer-facing form populated it), so any string that's already an email
// must end in @nwcustomapparel.com or it's discarded as unsafe.
var INTERNAL_DOMAIN = '@nwcustomapparel.com';

// Former employees / disabled accounts. Their items still exist in Caspio
// (Sales_Rep field carries the old name), but we don't want digest emails
// piling up in an inbox nobody reads. Listing them here makes the items
// drop into the "unassigned" bucket so they show up in /scan output and
// someone can reassign Sales_Rep in Caspio.
var FORMER_EMPLOYEE_EMAILS = new Set([
    'taylar@nwcustomapparel.com'
]);

/**
 * Resolve a Sales_Rep value (or a User_Email fallback) to an internal email.
 * Returns null if we can't resolve OR if the input is an external email
 * (e.g. a customer address). Callers treat null as "skip cleanly + log".
 *
 * Examples:
 *   resolveAEEmail('Taneisha')                       → 'taneisha@nwcustomapparel.com'
 *   resolveAEEmail('taneisha@nwcustomapparel.com')   → same string (already internal email)
 *   resolveAEEmail('archterra@comcast.net')          → null  (customer leak — don't email)
 *   resolveAEEmail('Unknown')                        → null
 *   resolveAEEmail('')                               → null
 */
function resolveAEEmail(value) {
    if (!value || typeof value !== 'string') return null;
    var trimmed = value.trim();
    if (!trimmed) return null;
    var resolved = null;
    if (trimmed.indexOf('@') !== -1) {
        var lower = trimmed.toLowerCase();
        if (lower.endsWith(INTERNAL_DOMAIN)) resolved = lower;
    } else if (Object.prototype.hasOwnProperty.call(REP_EMAIL_MAP, trimmed)) {
        resolved = REP_EMAIL_MAP[trimmed];
    }
    if (resolved && FORMER_EMPLOYEE_EMAILS.has(resolved)) return null;
    return resolved;
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
