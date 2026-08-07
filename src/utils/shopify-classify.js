// Work out which city collection a 253gear design belongs in.
//
// DETERMINISTIC FIRST, MODEL SECOND, HUMAN ALWAYS.
//
// A 253gear design usually has the place name in the artwork itself, and
// src/utils/mockup-vision.js already returns `design_text` — "all text visible on the
// design". When that text names a city the answer is settled by string match, with a
// reason a person can check: "the design says TACOMA". No model call, no confidence
// hand-waving, no way to be creatively wrong.
//
// Only the residue needs inference — designs with no place name, like the Nyholm
// windmill, Clyde's water slide, or the Piggly Wiggly floor. Those get a SUGGESTION
// carrying a reason and a confidence, and the route asks the model for it separately.
//
// Nothing here auto-applies. Collection membership is what shoppers browse, and the
// collections are automatic, so a wrong tag files itself the moment it is saved. A
// Puyallup shirt sitting in Fife is a wrong shelf that a customer finds before we do.
//
// 🔴 The tag vocabulary is DISCOVERED, not assumed. It comes from the live
// smart-collection ruleSets via POST /api/shopify/config/refresh-collections. Until
// that has run, `collectionsKnown` is false and this module says it cannot verify
// rather than emitting a tag that might file nothing.

'use strict';

/** Words that appear in artwork constantly and must never be read as a place. */
const STOPWORDS = new Set([
    'the', 'and', 'of', 'a', 'an', 'in', 'at', 'on', 'to', 'for', 'est', 'since',
    'washington', 'wa', 'usa', 'america', 'gear', 'co', 'company', 'inc'
]);

function tokenize(text) {
    return String(text || '')
        .toLowerCase()
        .replace(/[^a-z0-9\s-]/g, ' ')
        .split(/[\s-]+/)
        .filter(Boolean);
}

/**
 * A vocabulary tag's matchable tokens.
 * 'washington-pnw' -> ['washington','pnw']; the FIRST non-stopword token is what a
 * design would actually print, so that is what we match on.
 */
function tagTokens(tag) {
    return String(tag || '').toLowerCase().split('-').filter(Boolean);
}

function primaryToken(tag) {
    const parts = tagTokens(tag);
    const meaningful = parts.filter((p) => !STOPWORDS.has(p));
    return meaningful.length ? meaningful[0] : parts[0];
}

/**
 * Deterministic pass: does the artwork text name exactly one known place?
 *
 * @returns { method, city, confidence, reason, candidates }
 *   method 'text'      — one match; settled
 *   method 'ambiguous' — several; a human picks, we do NOT guess
 *   method 'none'      — no match; the caller may ask the model
 */
function classifyFromText(designText, vocabulary) {
    const vocab = (vocabulary || []).map((v) => String(v).toLowerCase());
    if (!vocab.length) {
        return { method: 'unavailable', city: null, confidence: 'none', candidates: [],
            reason: 'The collection rules have not been read yet, so there is no vocabulary to match against.' };
    }

    const tokens = new Set(tokenize(designText));
    if (!tokens.size) {
        return { method: 'none', city: null, confidence: 'none', candidates: [],
            reason: 'No readable text in the design.' };
    }

    const matches = vocab.filter((tag) => {
        const primary = primaryToken(tag);
        return primary && tokens.has(primary);
    });

    if (matches.length === 1) {
        return {
            method: 'text',
            city: matches[0],
            confidence: 'high',
            candidates: matches,
            reason: `The design text says "${primaryToken(matches[0]).toUpperCase()}".`
        };
    }

    if (matches.length > 1) {
        // Two places named in one design — e.g. "SOUTH OF TACOMA" on a Lakewood piece.
        // Picking the first would be a coin flip with a permanent consequence.
        return {
            method: 'ambiguous',
            city: null,
            confidence: 'none',
            candidates: matches,
            reason: `The design text names more than one place (${matches.join(', ')}) — needs a human.`
        };
    }

    return {
        method: 'none', city: null, confidence: 'none', candidates: [],
        reason: 'The design text does not name a place we have a collection for.'
    };
}

/**
 * Fold a model suggestion in, but only if it names a place the collections actually
 * file on. A suggestion outside the vocabulary is discarded — a tag that matches no
 * rule silently files nothing, which looks like success and is not.
 */
function acceptModelSuggestion(suggestion, vocabulary) {
    const vocab = (vocabulary || []).map((v) => String(v).toLowerCase());
    const city = String((suggestion && suggestion.city) || '').trim().toLowerCase();

    if (!city) {
        return { method: 'none', city: null, confidence: 'none', candidates: [],
            reason: 'No place could be identified from the artwork — needs a human.' };
    }
    if (!vocab.includes(city)) {
        return {
            method: 'none', city: null, confidence: 'none', candidates: [],
            reason: `Suggested "${city}", which no collection files on — needs a human.`
        };
    }

    const confidence = ['high', 'medium', 'low'].includes(String(suggestion.confidence).toLowerCase())
        ? String(suggestion.confidence).toLowerCase()
        : 'low';

    return {
        method: 'model',
        city,
        // A model inference is never reported as high confidence: the text pass is the
        // only path that produces a fact rather than a reading.
        confidence: confidence === 'high' ? 'medium' : confidence,
        candidates: [city],
        reason: String(suggestion.reason || '').trim() || 'Inferred from the artwork, with no stated reason.'
    };
}

/**
 * Assemble the tag set for a product.
 * Returns `{ tags, rejected }` — a city outside the vocabulary lands in `rejected`
 * rather than being emitted, so a tag can never claim membership it will not get.
 */
function buildTagSet({ city, styles = [] }, cfg) {
    const vocab = (cfg.tagVocabulary || []).map((v) => String(v).toLowerCase());
    const tags = new Set((cfg.baseTags || []).map((t) => String(t).toLowerCase()));
    const rejected = [];

    const wanted = String(city || '').trim().toLowerCase();
    if (wanted) {
        if (vocab.includes(wanted)) tags.add(wanted);
        else rejected.push(wanted);
    }

    for (const option of styles) {
        const def = (cfg.styles || []).find((s) => s.option === option);
        if (def && def.filterTag) tags.add(String(def.filterTag).toLowerCase());
    }

    return { tags: Array.from(tags), rejected };
}

/**
 * Which collections a tag set will actually land in, per the discovered rules.
 * Used by the review pane so Steve sees the consequence, not just the tags.
 */
function collectionsForTags(tags, cfg) {
    const rules = cfg.collectionRules || [];
    if (!rules.length) return { known: false, handles: [] };

    const lower = new Set((tags || []).map((t) => String(t).toLowerCase()));
    const handles = new Set();
    for (const r of rules) {
        if (String(r.column).toUpperCase() !== 'TAG') continue;
        if (lower.has(String(r.condition).trim().toLowerCase())) handles.add(r.handle);
    }
    return { known: true, handles: Array.from(handles) };
}

/** Trim an SEO field to Google's usable width without cutting mid-word. */
function trimToWidth(text, max) {
    const s = String(text || '').trim();
    if (s.length <= max) return s;
    const cut = s.slice(0, max);
    const lastSpace = cut.lastIndexOf(' ');
    return (lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut).trim();
}

module.exports = {
    classifyFromText,
    acceptModelSuggestion,
    buildTagSet,
    collectionsForTags,
    tokenize,
    primaryToken,
    trimToWidth,
    STOPWORDS
};
