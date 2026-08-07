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

const { baseStyleOption } = require('./shopify-product-builder');

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
 * ⚠️ Matches on the city's NAME ("Tacoma"), never on its tag. The tags are prefixed —
 * `city:Tacoma` — so tokenising the tag would try to match the literal word "city" in
 * the artwork and hit on every design that happens to print it.
 *
 * @param cities  config.cities — [{ name, tag, collection }]
 * @returns { method, city, confidence, reason, candidates }
 *   method 'text'      — one match; settled
 *   method 'ambiguous' — several; a human picks, we do NOT guess
 *   method 'none'      — no match; the caller may ask the model
 */
function classifyFromText(designText, cities) {
    const list = (cities || []).filter((c) => c && c.name);
    if (!list.length) {
        return { method: 'unavailable', city: null, confidence: 'none', candidates: [],
            reason: 'The collection rules have not been read yet, so there is no city list to match against.' };
    }

    const tokens = new Set(tokenize(designText));
    if (!tokens.size) {
        return { method: 'none', city: null, confidence: 'none', candidates: [],
            reason: 'No readable text in the design.' };
    }

    const matches = list
        .filter((c) => tokens.has(String(c.name).toLowerCase()))
        .map((c) => c.name);

    if (matches.length === 1) {
        return {
            method: 'text',
            city: matches[0],
            confidence: 'high',
            candidates: matches,
            reason: `The design text says "${matches[0].toUpperCase()}".`
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
 * Try the DESIGN NAME first, then the artwork text.
 *
 * The name is the better signal of the two and was going unused. It comes from the
 * ShopWorks Designs record — typed by a person, e.g. "Spanaway Speedway Logo
 * (Distressed)" — whereas design_text is OCR'd off a photo of a garment and can be
 * stylised, partly obscured, or absent entirely. A design whose artwork carries no
 * readable words at all still classifies correctly from its name.
 *
 * Both paths are the same deterministic string match, so both produce a reason a
 * person can check; the reason says which source settled it.
 */
function classifyFromSources({ designName, designText }, cities) {
    const byName = classifyFromText(designName, cities);
    if (byName.method === 'text') {
        return { ...byName, source: 'design name', reason: `The design name says "${byName.city}".` };
    }
    // An ambiguous NAME is not fatal — the artwork may still name one place.
    const byArtwork = classifyFromText(designText, cities);
    if (byArtwork.method === 'text') {
        return { ...byArtwork, source: 'artwork text' };
    }
    // Prefer whichever gave the more informative non-answer.
    if (byName.method === 'ambiguous') return { ...byName, source: 'design name' };
    if (byArtwork.method === 'ambiguous') return { ...byArtwork, source: 'artwork text' };
    if (byName.method === 'unavailable') return { ...byName, source: 'none' };
    return { ...byArtwork, source: 'none' };
}

/**
 * Fold a model suggestion in, but only if it names a place the collections actually
 * file on. A suggestion outside the vocabulary is discarded — a tag that matches no
 * rule silently files nothing, which looks like success and is not.
 */
function acceptModelSuggestion(suggestion, cities) {
    const list = (cities || []).filter((c) => c && c.name);
    const wanted = String((suggestion && suggestion.city) || '').trim().toLowerCase();

    if (!wanted) {
        return { method: 'none', city: null, confidence: 'none', candidates: [],
            reason: 'No place could be identified from the artwork — needs a human.' };
    }
    const hit = list.find((c) => String(c.name).toLowerCase() === wanted);
    if (!hit) {
        return {
            method: 'none', city: null, confidence: 'none', candidates: [],
            reason: `Suggested "${suggestion.city}", which no collection files on — needs a human.`
        };
    }
    const city = hit.name;

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
/**
 * Assemble the tag set.
 *
 * 🔴 Tags are emitted EXACTLY as the collection rules spell them — `city:Tacoma`,
 * `T-Shirt`, `253`. Never lowercased, never slugified. An earlier version slugified
 * everything, which produced tags matching no rule at all: the product would have
 * published into zero collections, invisible to anyone browsing by town, with nothing
 * reporting a problem.
 */
function buildTagSet({ city, styles = [] }, cfg) {
    const cities = cfg.cities || [];
    const tags = new Set((cfg.baseTags || []).map((t) => String(t).trim()));
    const rejected = [];

    const wanted = String(city || '').trim().toLowerCase();
    if (wanted) {
        const hit = cities.find((c) =>
            String(c.name).toLowerCase() === wanted ||
            String(c.tag).toLowerCase() === wanted ||
            String(c.collection).toLowerCase() === wanted);
        if (hit) tags.add(hit.tag);
        else rejected.push(city);
    }

    for (const option of styles) {
        // Same fallback the price / SKU / weight lookups use. A Style that names its colour
        // ("T-Shirt - Royal", used where a garment sells in exactly one colour) matches no
        // config entry on its own, so the product would publish with NO garment tag — absent
        // from the T-Shirt and Hoodie collections, with nothing reporting it. Unreachable
        // from the publisher today, which builds from config names; wired anyway so one
        // concept keeps one rule. baseStyleOption() lives in shopify-product-builder.js.
        const def = (cfg.styles || []).find((s) => s.option === option)
                 || (cfg.styles || []).find((s) => s.option === baseStyleOption(option));
        if (def && def.filterTag) tags.add(String(def.filterTag).trim());
    }

    return { tags: Array.from(tags), rejected };
}

/**
 * Which collections a tag set will actually land in, so the review pane shows the
 * consequence rather than just the tags. Comparison is case-insensitive because
 * Shopify matches tags that way.
 */
function collectionsForTags(tags, cfg) {
    const cities = cfg.cities || [];
    if (!cities.length) return { known: false, handles: [] };

    const lower = new Set((tags || []).map((t) => String(t).toLowerCase()));
    const handles = cities
        .filter((c) => lower.has(String(c.tag).toLowerCase()))
        .map((c) => c.collection);
    return { known: true, handles };
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
    classifyFromSources,
    acceptModelSuggestion,
    buildTagSet,
    collectionsForTags,
    tokenize,
    primaryToken,
    trimToWidth,
    STOPWORDS
};
