// slack-date-format.js — shared Caspio-date formatter for Slack messages.
//
// Caspio sends date-only fields as `"YYYY-MM-DDT00:00:00"` (no Z, no offset).
// We want human-friendly `"Fri, May 15, 2026"` in Slack messages.
//
// Why parse manually instead of `new Date(isoString)`:
//   `new Date("2026-05-15T00:00:00")` interprets as LOCAL time in JS. Heroku
//   runs in UTC, so the resulting Date object is "May 15 00:00 UTC". When
//   `toLocaleDateString` renders that in a different timezone, we'd get the
//   previous day. Parsing components directly avoids the timezone shift —
//   the date stays as-typed regardless of where the script runs.
//
// Defensive: returns the raw input string if parsing fails, empty string if
// input is empty/null. Never throws.

function formatCaspioDate(isoString) {
    if (!isoString) return '';
    const m = String(isoString).match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (!m) return String(isoString); // fallback to raw if parse fails
    const date = new Date(parseInt(m[1], 10), parseInt(m[2], 10) - 1, parseInt(m[3], 10));
    return date.toLocaleDateString('en-US', {
        weekday: 'short',
        year: 'numeric',
        month: 'short',
        day: 'numeric'
    });
    // Result: "Fri, May 15, 2026"
}

module.exports = {
    formatCaspioDate
};
