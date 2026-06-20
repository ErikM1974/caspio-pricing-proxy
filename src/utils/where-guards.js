// Pure input guards for Caspio routes — no dependencies, no side effects, so
// they unit-test in isolation. Used by src/routes/art.js (WHERE-clause filters
// + designId/PK_ID) and src/routes/files-simple.js (external file keys).
'use strict';

// Validate a value as a positive integer id. Returns the int, or null if the
// value isn't a clean positive integer (e.g. "1 OR 1=1" → null), so it can never
// be used for WHERE-clause injection.
function reqInt(v) {
    if (v === undefined || v === null) return null;
    const s = String(v).trim();
    const n = parseInt(s, 10);
    return (Number.isInteger(n) && n > 0 && String(n) === s) ? n : null;
}

// Escape single quotes for a string interpolated into a Caspio q.where clause.
function escWhere(v) {
    return String(v).replace(/'/g, "''");
}

// Caspio external file keys are GUID/token-shaped. Validate before interpolating
// into a Caspio URL (blocks path-traversal / SSRF via a crafted key).
function isValidFileKey(k) {
    return typeof k === 'string' && /^[A-Za-z0-9_-]{8,}$/.test(k);
}

module.exports = { reqInt, escWhere, isValidFileKey };
