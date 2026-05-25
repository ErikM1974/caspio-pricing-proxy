/**
 * company-name-normalize.js
 *
 * Shared helper for fuzzy-matching company names across NWCA's source files.
 * Empirically, ~29% of bridge-XLSX names don't exactly match the contacts CSV
 * — mostly trailing whitespace ("Absher Construction Company " with a space),
 * trailing punctuation, or capitalization drift. This module normalizes both
 * sides + provides a Levenshtein-≤2 fallback for the residual mismatches.
 *
 * Usage:
 *   const { normalize, buildMatchIndex, fuzzyMatch } = require('./lib/company-name-normalize');
 *
 *   // Build an index from the canonical source (contacts CSV)
 *   const index = buildMatchIndex(contactsRecords, r => r.CustomerCompanyName);
 *
 *   // Look up bridge XLSX company names
 *   const match = fuzzyMatch('Absher Construction Company ', index);
 *   // → { matched: 'Absher Construction Company', source: 'normalized', score: 0 }
 *
 * Created 2026-05-25 — EMB Smart E1 (Customer Profile 10yr ETL).
 */

'use strict';

/**
 * Normalize a company name into a join-safe key:
 *   - Lowercase
 *   - Trim leading/trailing whitespace
 *   - Collapse internal whitespace runs to single space
 *   - Strip trailing punctuation (., ,, !, ?, ;)
 *   - Strip trailing common suffixes that often differ between exports
 *     (Inc, LLC, Ltd, Corp, Co, Company) — both with and without periods
 *   - Strip non-printable / weird unicode
 */
function normalize(raw) {
    if (raw == null) return '';
    let s = String(raw);
    // Strip BOM, NBSP, zero-width chars
    s = s.replace(/[﻿ ​-‍]/g, ' ');
    s = s.toLowerCase().trim();
    // Collapse internal whitespace
    s = s.replace(/\s+/g, ' ');
    // Strip trailing punctuation
    s = s.replace(/[\.,;:!?]+$/, '');
    // Strip parenthetical suffixes — keep as a separate alias instead
    // (e.g. "RPD (Rickabaugh Pentecost Development)" → keep parens for now,
    // many companies use them as the only differentiator)
    return s.trim();
}

/**
 * Looser normalization that ALSO strips common business-entity suffixes.
 * Used as a secondary key when the basic normalize doesn't match — catches
 * "Absher Construction" vs "Absher Construction Company" mismatches.
 *
 * NOTE: lossy — multiple distinct companies can collapse to the same key
 * ("Acme LLC" + "Acme Inc" → "acme"). Only use as a fallback.
 */
const SUFFIX_RE = /\s+(inc|llc|ltd|corp|corporation|company|co|llp|lp|pllc|pa|pc|llbc)\.?$/i;
function normalizeStripSuffix(raw) {
    let s = normalize(raw);
    // Apply suffix-strip repeatedly (some names have "ABC Inc Company")
    let prev;
    do {
        prev = s;
        s = s.replace(SUFFIX_RE, '').trim();
    } while (prev !== s);
    return s;
}

/**
 * Levenshtein distance between two strings. Iterative DP, O(n*m) time/space.
 * Used as a final fallback only — we cap distance at maxDist for early exit
 * and only call this when an entry is short enough (< 80 chars) to be cheap.
 */
function levenshtein(a, b, maxDist = 2) {
    if (a === b) return 0;
    if (Math.abs(a.length - b.length) > maxDist) return maxDist + 1;
    const m = a.length, n = b.length;
    if (m === 0) return n;
    if (n === 0) return m;

    // Two-row DP (memory: O(n))
    let prev = new Array(n + 1);
    let curr = new Array(n + 1);
    for (let j = 0; j <= n; j++) prev[j] = j;

    for (let i = 1; i <= m; i++) {
        curr[0] = i;
        let rowMin = i;
        for (let j = 1; j <= n; j++) {
            const cost = a[i - 1] === b[j - 1] ? 0 : 1;
            curr[j] = Math.min(
                curr[j - 1] + 1,        // insertion
                prev[j] + 1,            // deletion
                prev[j - 1] + cost      // substitution
            );
            if (curr[j] < rowMin) rowMin = curr[j];
        }
        // Early exit — entire row exceeds maxDist
        if (rowMin > maxDist) return maxDist + 1;
        [prev, curr] = [curr, prev];
    }
    return prev[n];
}

/**
 * Build an index from a list of records, keyed by normalized company name.
 * Returns: { byNormalized: Map, byStripped: Map, allRecords: Array }
 *
 * @param {Array<Object>} records  - the source records (e.g. contacts CSV)
 * @param {Function} getNameFn      - function to extract the company name from a record
 */
function buildMatchIndex(records, getNameFn) {
    const byNormalized = new Map();   // normalize(name) → record (first wins on collision)
    const byStripped = new Map();     // normalizeStripSuffix(name) → record (fallback)
    const allNames = [];              // [{ normalized, stripped, record }] for fuzzy fallback

    for (const r of records) {
        const raw = getNameFn(r);
        if (!raw) continue;
        const n = normalize(raw);
        const s = normalizeStripSuffix(raw);
        if (!n) continue;

        // First-wins so the "more canonical" record (which usually appears
        // first in an alpha-sorted export) takes precedence over duplicates.
        if (!byNormalized.has(n)) byNormalized.set(n, r);
        if (s && !byStripped.has(s)) byStripped.set(s, r);
        allNames.push({ normalized: n, stripped: s, record: r });
    }

    return { byNormalized, byStripped, allNames };
}

/**
 * Match a raw company name against the index.
 * Returns { matched: <record> | null, source: 'exact' | 'normalized' | 'stripped' | 'fuzzy' | 'none', score: 0..2 }
 */
function fuzzyMatch(rawName, index) {
    if (!rawName) return { matched: null, source: 'none', score: -1 };
    const n = normalize(rawName);
    if (!n) return { matched: null, source: 'none', score: -1 };

    // Try 1: exact normalized match (catches whitespace + case + trailing punct)
    if (index.byNormalized.has(n)) {
        return { matched: index.byNormalized.get(n), source: 'normalized', score: 0 };
    }

    // Try 2: strip business-entity suffix on both sides
    const s = normalizeStripSuffix(rawName);
    if (s && index.byStripped.has(s)) {
        return { matched: index.byStripped.get(s), source: 'stripped', score: 1 };
    }

    // Try 3: Levenshtein ≤ 2 over candidates of similar length
    // (only scan candidates within ±3 chars to keep this cheap)
    let best = null;
    let bestDist = 3;
    const targetLen = n.length;
    // Don't fuzzy-match very short names — too many false positives
    if (targetLen < 6) return { matched: null, source: 'none', score: -1 };

    for (const entry of index.allNames) {
        if (Math.abs(entry.normalized.length - targetLen) > 2) continue;
        const d = levenshtein(n, entry.normalized, 2);
        if (d < bestDist) {
            best = entry.record;
            bestDist = d;
            if (d === 0) break; // already found exact (shouldn't happen — try 1 catches this)
        }
    }
    if (best && bestDist <= 2) {
        return { matched: best, source: 'fuzzy', score: bestDist };
    }
    return { matched: null, source: 'none', score: -1 };
}

module.exports = {
    normalize,
    normalizeStripSuffix,
    levenshtein,
    buildMatchIndex,
    fuzzyMatch,
};
