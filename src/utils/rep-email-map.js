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
    // Ruth's real inbox + Slack account is ruth@ (NOT ruthie@, which isn't a
    // real account). ArtRequests stores her Sales_Rep as "Ruthie"; alias "Ruth".
    'Ruthie':   'ruth@nwcustomapparel.com',
    'Ruth':     'ruth@nwcustomapparel.com',
    'Erik':     'erik@nwcustomapparel.com',
    // Added 2026-07-18 for the Leads CRM follow-up digest — leads carry FULL
    // display names ("Jim Mickelson") resolved via resolveAEEmailLoose.
    'Jim':      'jim@nwcustomapparel.com',
    'Bradley':  'bradley@nwcustomapparel.com',
    'Steve':    'art@nwcustomapparel.com',
    'General':  'sales@nwcustomapparel.com',  // "General Sales"
    'House':    'sales@nwcustomapparel.com'   // house-account CSR on some ShopWorks contacts
};

// Only the internal domain is allowed to receive AE digests. User_Email on
// ArtRequests is sometimes a CUSTOMER email (when Sales_Rep is blank and a
// customer-facing form populated it), so any string that's already an email
// must end in @nwcustomapparel.com or it's discarded as unsafe.
var INTERNAL_DOMAIN = '@nwcustomapparel.com';

// Former employees / disabled accounts → redirect to a still-active inbox.
// Their items still exist in Caspio (Sales_Rep field carries the old name),
// and someone has to chase them. Mapping them here lets the digest land in
// a real inbox without requiring a Caspio backfill of every old record.
var EMPLOYEE_REDIRECTS = {
    'taylar@nwcustomapparel.com': 'sales@nwcustomapparel.com'
};

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
    if (resolved && Object.prototype.hasOwnProperty.call(EMPLOYEE_REDIRECTS, resolved)) {
        return EMPLOYEE_REDIRECTS[resolved];
    }
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

/**
 * Looser variant of resolveAEEmail for free-text Note_By values, which are
 * often a FULL name ("Erik Mickelson", "Taneisha Clark") rather than the
 * bare first name the REP_EMAIL_MAP is keyed on. Used by the art-note
 * watcher fan-out where a stand-in who posted a reply ("Erik Mickelson"
 * covering Taneisha) must still resolve to an internal inbox with NO Caspio
 * schema change.
 *
 * Strategy:
 *   1. Try resolveAEEmail(value) verbatim (handles bare first names + emails).
 *   2. If that's null AND the value is a non-email string containing a space,
 *      retry with just the first-name token ("Erik Mickelson" -> "Erik").
 *
 * Like resolveAEEmail, this NEVER returns a non-internal/customer email —
 * the underlying resolveAEEmail enforces the @nwcustomapparel.com guard.
 *
 * Examples:
 *   resolveAEEmailLoose('Erik Mickelson')   -> 'erik@nwcustomapparel.com'
 *   resolveAEEmailLoose('Taneisha')         -> 'taneisha@nwcustomapparel.com'
 *   resolveAEEmailLoose('Jane Customer')    -> null  (no map hit on "Jane")
 *   resolveAEEmailLoose('foo@gmail.com')    -> null  (external email)
 */
function resolveAEEmailLoose(value) {
    var direct = resolveAEEmail(value);
    if (direct) return direct;
    if (!value || typeof value !== 'string') return null;
    var trimmed = value.trim();
    if (!trimmed || trimmed.indexOf('@') !== -1) return null;
    if (!/\s/.test(trimmed)) return null;
    var firstToken = trimmed.split(/\s+/)[0];
    if (!firstToken) return null;
    return resolveAEEmail(firstToken);
}

module.exports = { REP_EMAIL_MAP, resolveAEEmail, resolveAEName, resolveAEEmailLoose };
