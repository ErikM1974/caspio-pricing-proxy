// Sales rep resolver — first-name → {name, email}.
//
// Data source: config/manageorders-emb-config.js SALES_REP_MAP (email → full name).
// We invert it at module load and also key by first-name / short-name.
//
// Used by:
//   - /api/transfer-orders/analyze-link + vision mockup info, so Steve's mockup
//     (which shows first names like "Nika") auto-populates the Sales_Rep_Email
//     field on Transfer_Orders, which in turn drives the transfer_ordered /
//     transfer_received notification chain.
//
// The map in manageorders-emb-config.js is the canonical NWCA sales-rep list
// (used by ShopWorks push). If a new rep is added there, this resolver picks
// it up automatically — no edits needed here.

const { SALES_REP_MAP } = require('../../config/manageorders-emb-config');

// Build first-name index at module load. Lowercased, with a second entry for
// common short-forms (e.g. "Ruth" → the row keyed "Ruthie Nhoung").
function buildIndex() {
    const idx = new Map();
    Object.entries(SALES_REP_MAP || {}).forEach(([email, fullName]) => {
        const entry = { name: fullName, email };
        if (!fullName) return;
        const tokens = fullName.split(/\s+/);
        const first = (tokens[0] || '').toLowerCase();
        if (first) idx.set(first, entry);
        // Short-form alias (e.g. Ruthie → Ruth)
        if (first === 'ruthie') idx.set('ruth', entry);
        if (first === 'erik') idx.set('erik', entry);
        if (first === 'nika') idx.set('nika', entry);
        if (first === 'taneisha') idx.set('taneisha', entry);
        if (first === 'taylar') idx.set('taylar', entry);
    });
    return idx;
}

const NAME_INDEX = buildIndex();

/**
 * Given a free-text name (typically a first name like "Nika" from a mockup OCR),
 * return { name, email } or null when no match.
 *
 * Matches are case-insensitive. Takes the first token of the input if a full
 * name was passed accidentally.
 */
function resolveSalesRep(input) {
    if (!input || typeof input !== 'string') return null;
    const first = String(input).trim().split(/\s+/)[0].toLowerCase();
    if (!first) return null;
    return NAME_INDEX.get(first) || null;
}

module.exports = {
    resolveSalesRep,
    // Exposed for debug / unit tests
    _index: NAME_INDEX
};
