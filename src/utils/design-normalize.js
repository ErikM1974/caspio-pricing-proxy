/**
 * Shared name normalizers for cross-source design matching (design-search index
 * dup-clusters, company matching).
 *
 * normalizeCompanyName MUST stay byte-for-byte in step with the copy in
 * scripts/sync-design-lookup.js — the unified table's company matching and the
 * index's dup-cluster keys have to agree, or the same company clusters
 * differently in the two places.
 */
'use strict';

/** Normalize company name for matching: lowercase, trim, strip common punctuation */
function normalizeCompanyName(name) {
    if (!name) return '';
    return name
        .toLowerCase()
        .trim()
        .replace(/[.,;:!?'"()[\]{}]/g, '')  // strip punctuation
        .replace(/\s+/g, ' ')                // collapse whitespace
        .replace(/\b(inc|llc|ltd|corp|co|the|and)\b/g, '') // strip common suffixes
        .replace(/\s+/g, ' ')
        .trim();
}

/**
 * Normalize a design name for dup-cluster keys. Unlike company names, words
 * like "co"/"the"/"and" are part of the art title, not a legal suffix — only
 * casing, punctuation, and whitespace are folded.
 */
function normalizeDesignName(name) {
    if (!name) return '';
    return String(name)
        .toLowerCase()
        .trim()
        .replace(/[.,;:!?'"()[\]{}]/g, '')
        .replace(/\s+/g, ' ')
        .trim();
}

module.exports = { normalizeCompanyName, normalizeDesignName };
