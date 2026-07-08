// Maps a makeCaspioRequest('delete', ...) result to the HTTP response for the
// quote DELETE-by-PK endpoints (quote_sessions / quote_items / quote_analytics).
//
// Why this exists (2026-07-08): Caspio v3 returns 200 {"RecordsAffected": 0}
// when a DELETE's q.where matches nothing — the same status as a real delete.
// The old handlers replied "deleted successfully, recordsAffected: 0" for BOTH
// (and the util layer discarded the count anyway), so a miss was
// indistinguishable from a hit. A 0-affected delete now maps to 404 — never a
// fake success. Jest-locked: tests/jest/quote-delete-response.test.js
//
// Dependency-free on purpose so the jest lock never pulls src/config (which
// process.exit(1)s without Caspio env vars).

/**
 * @param {string} entity - Human label, e.g. 'Quote session'
 * @param {object} result - Return value of makeCaspioRequest('delete', ...)
 * @returns {{ httpStatus: number, body: object }}
 */
function deleteResponseFor(entity, result) {
  const affected = Number(result && result.RecordsAffected) || 0;
  if (affected <= 0) {
    return {
      httpStatus: 404,
      body: { error: `${entity} not found — nothing was deleted`, recordsAffected: 0 },
    };
  }
  return {
    httpStatus: 200,
    body: { message: `${entity} deleted successfully`, recordsAffected: affected },
  };
}

module.exports = { deleteResponseFor };
