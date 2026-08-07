// Pre-publish audit for one 253gear.com product.
//
// The first four checks are a direct port of Downloads/253gear-ops/shopify/audit.py:18-58,
// which exists because each of them has actually broken this store. Same names, same
// vocabulary, so the dashboard panel and the Python script can never disagree about
// what "ok" means. The remaining checks encode conventions from 253gear-ops/CLAUDE.md.
//
// PURE — takes a fetched product, returns a verdict. No network, no clock.
//
// `blocking: true` disables Publish. Nothing here auto-fixes anything: the store's
// standing rule is that Erik makes the destructive calls, so this reports and stops.

'use strict';

const { DESIGN_NUMBER_RE } = require('./shopify-product-builder');

const TITLE_DESIGN_NUMBER_RE = /#(\d{4,6})\s*$/;   // audit.py:35 uses #(\d{4,6})
const MAX_OPTIONS = 3;
const MIN_BODY_WORDS = 200;

function nodesOf(container) {
    if (!container) return [];
    if (Array.isArray(container)) return container;
    return Array.isArray(container.nodes) ? container.nodes : [];
}

function check(name, pass, detail, { blocking = true, items = [] } = {}) {
    return { name, pass: Boolean(pass), detail, blocking, items };
}

/**
 * Every variant must have an image bound.
 *
 * THE headline check — first in audit.py for a reason. It shipped broken twice: all
 * 644 variants after the tee/hoodie merge, then seven Fall variants of #40749. The
 * customer-visible symptom is a hoodie photo above a T-Shirt price.
 */
function checkVariantImageBinding(product) {
    const variants = nodesOf(product.variants);
    const unbound = variants.filter((v) => !(v.image && v.image.id) && !(v.media && nodesOf(v.media).length));
    return check(
        'variant_image_binding',
        unbound.length === 0,
        `${variants.length - unbound.length}/${variants.length} variants have an image bound`,
        { items: unbound.map((v) => v.sku || v.id) }
    );
}

/**
 * Every (Style x Colour) pair must resolve to its OWN photo.
 *
 * The binding check above only asks whether each variant has *an* image. It passes
 * cleanly when two colours share one — which is exactly what shipped: measured
 * 2026-08-07, six of the seven live multi-colour products bound by Style alone, so a
 * shopper picking Charcoal was shown Athletic Heather and bought on that photo. The
 * correct picture was already uploaded and bound to nothing.
 *
 * Size is deliberately excluded from the key: one photo serves all sizes of a pair, so
 * a shopper's size survives a thumbnail click.
 */
function checkColourImageDistinct(product) {
    const variants = nodesOf(product.variants);
    const opt = (v, n) => ((v.selectedOptions || []).find((o) => o.name === n) || {}).value;
    const imageOf = (v) => (v.image && (v.image.url || v.image.id)) || null;

    const byPair = {};
    for (const v of variants) {
        const colour = opt(v, 'Color');
        if (!colour) continue;
        const pair = `${opt(v, 'Style') || '(single)'} / ${colour}`;
        if (imageOf(v)) byPair[pair] = imageOf(v);
    }
    const pairs = Object.keys(byPair);
    if (pairs.length < 2) {
        return check('colour_image_distinct', true, 'Single colour — nothing to distinguish', { blocking: false });
    }

    const shared = {};
    for (const [pair, img] of Object.entries(byPair)) (shared[img] = shared[img] || []).push(pair);
    const clashes = Object.values(shared).filter((list) => list.length > 1);

    return check(
        'colour_image_distinct',
        clashes.length === 0,
        clashes.length
            ? `${clashes.length} photo(s) serve more than one colour — colour does not change the picture`
            : `${pairs.length} Style x Colour pair(s), each with its own photo`,
        { items: clashes.map((list) => list.join('  ==  ')) }
    );
}

/**
 * Every photo must reach a variant, or be declared product-level.
 *
 * The reciprocal of the binding check, and the gap that let the defect above hide: an
 * uploaded-but-unbound photo passes every existing check forever. It is also not inert
 * — the theme gives an unbound photo the options of the nearest preceding BOUND one
 * (product-template.CURRENT.liquid:393-402), so its meaning is its POSITION. A lifestyle
 * shot placed after the wrong flat-lay switches the shopper to the wrong colour on click.
 *
 * Non-blocking: product-level shots are legitimate. It reports them so the position is a
 * decision someone made rather than an accident.
 */
function checkOrphanMedia(product) {
    const variants = nodesOf(product.variants);
    const media = nodesOf(product.media).filter((m) => m.image || m.preview);
    if (!media.length) return check('orphan_media', true, 'No media to check', { blocking: false });

    const bound = new Set();
    for (const v of variants) {
        if (v.image && v.image.url) bound.add(String(v.image.url).split('?')[0]);
        if (v.image && v.image.id) bound.add(v.image.id);
    }
    const orphans = media.filter((m) => {
        const url = m.image && m.image.url ? String(m.image.url).split('?')[0] : null;
        return !(url && bound.has(url)) && !bound.has(m.id);
    });

    return check(
        'orphan_media',
        true,
        orphans.length
            ? `${orphans.length} product-level photo(s) — each inherits its options from the photo before it, so position matters`
            : 'Every photo is bound to a variant',
        { blocking: false, items: orphans.map((m, i) => `position ${media.indexOf(m) + 1}`) }
    );
}

/**
 * publishedAt, not status.
 *
 * Setting status ACTIVE leaves publishedAt null and the storefront 404s
 * (253gear CLAUDE.md gotcha 1). Informational while the product is a draft — it is
 * SUPPOSED to be unpublished then — and asserted after the publish call.
 */
function checkPublished(product, { expectPublished = false } = {}) {
    const isPublished = Boolean(product.publishedAt);
    if (!expectPublished) {
        return check('published', true, isPublished ? 'Published' : 'Draft (not yet published) — expected at this stage',
            { blocking: false });
    }
    return check('published', isPublished,
        isPublished ? `Published at ${product.publishedAt}` : 'status may be ACTIVE but publishedAt is null — the storefront will 404');
}

/** Alt text on every image. All 159 live images have it; keep it that way. */
function checkAltText(product) {
    const media = nodesOf(product.media);
    const missing = media.filter((m) => {
        const alt = m.alt !== undefined ? m.alt : (m.image && m.image.altText);
        return !String(alt || '').trim();
    });
    return check(
        'alt_text',
        missing.length === 0,
        `${media.length - missing.length}/${media.length} images have alt text`,
        { items: missing.map((m) => m.id) }
    );
}

/**
 * No two live products may carry the same ShopWorks design number.
 * `catalogue` is the list of other active products; omit it and the check reports
 * "not verified" rather than a false pass.
 */
function checkDuplicateDesignNumber(product, catalogue) {
    const mine = (String(product.title || '').match(TITLE_DESIGN_NUMBER_RE) || [])[1];
    if (!mine) {
        return check('duplicate_design_number', false, `Title "${product.title}" carries no #designnumber`);
    }
    if (!Array.isArray(catalogue)) {
        return check('duplicate_design_number', false, 'Catalogue not supplied — duplicate check not run', { blocking: false });
    }
    const clashes = catalogue.filter((p) => {
        if (!p || p.id === product.id) return false;
        const theirs = (String(p.title || '').match(TITLE_DESIGN_NUMBER_RE) || [])[1];
        return theirs === mine;
    });
    return check(
        'duplicate_design_number',
        clashes.length === 0,
        clashes.length ? `#${mine} is already used by: ${clashes.map((p) => p.title).join(', ')}` : `#${mine} is unique`,
        { items: clashes.map((p) => p.title) }
    );
}

// ── 253gear conventions beyond audit.py ──────────────────────────────────────

function checkOptionCount(product) {
    const options = product.options || [];
    return check('option_count', options.length <= MAX_OPTIONS,
        `${options.length} of a maximum ${MAX_OPTIONS} options (${options.map((o) => o.name).join(', ')})`);
}

function checkTitleFormat(product) {
    const ok = TITLE_DESIGN_NUMBER_RE.test(String(product.title || ''));
    return check('title_design_number', ok,
        ok ? `Title ends with a valid design number` : `Title "${product.title}" must end with " #" + 4-6 digits`);
}

function checkHandle(product) {
    const handle = String(product.handle || '');
    const carriesNumber = DESIGN_NUMBER_RE.test(handle.replace(/[^0-9]/g, '')) && /\d{4,6}/.test(handle);
    return check('handle_clean', Boolean(handle) && !carriesNumber,
        carriesNumber
            ? `Handle "${handle}" contains the design number — that is an admin key, not a shopper-facing URL`
            : `Handle "${handle}"`,
        { blocking: false });
}

/**
 * Inventory tracking must be OFF.
 * 19 products were unbuyable ("sold out") until tracking was disabled catalogue-wide.
 */
function checkInventoryUntracked(product) {
    const variants = nodesOf(product.variants);
    const tracked = variants.filter((v) => v.inventoryItem && v.inventoryItem.tracked === true);
    return check('inventory_untracked', tracked.length === 0,
        tracked.length ? `${tracked.length} variants have inventory tracking ON and will show sold out` : 'All variants untracked',
        { items: tracked.map((v) => v.sku || v.id) });
}

function checkPriceLadder(product, config) {
    const variants = nodesOf(product.variants);
    if (!config || !config.prices) {
        return check('price_ladder', false, 'Price config not supplied — ladder not verified', { blocking: false });
    }
    // Required lazily: the builder is the single definition of the ladder.
    const { priceFor } = require('./shopify-product-builder');
    const wrong = [];
    for (const v of variants) {
        const opts = v.selectedOptions || [];
        const styleOption = (opts.find((o) => o.name === 'Style') || {}).value;
        const size = (opts.find((o) => o.name === 'Size') || {}).value;
        if (!styleOption || !size) continue;      // seasonal products price off one garment; skipped here
        let expected;
        try { expected = priceFor(styleOption, size, config); } catch (_) { continue; }
        if (String(v.price) !== expected) wrong.push(`${v.sku || v.id}: ${v.price} (expected ${expected})`);
    }
    return check('price_ladder', wrong.length === 0,
        wrong.length ? `${wrong.length} variants are priced off the ladder` : 'All variant prices match the configured ladder',
        { items: wrong });
}

/**
 * At least one tag must be one a collection actually files on, or the product is
 * live and in no city collection — invisible to anyone browsing by town.
 */
function checkTags(product, config) {
    const tags = (product.tags || []).map((t) => String(t).toLowerCase());
    const vocabulary = (config && config.tagVocabulary) || [];
    if (!vocabulary.length) {
        return check('tags_match_collections', false, 'Collection rules not supplied — tag check not run', { blocking: false });
    }
    const matched = tags.filter((t) => vocabulary.includes(t));
    return check('tags_match_collections', matched.length > 0,
        matched.length ? `Files into: ${matched.join(', ')}` : 'No tag matches any collection rule — this product will not appear in a city collection',
        { blocking: false });
}

function checkBodyLength(product) {
    const text = String(product.descriptionHtml || product.description || '').replace(/<[^>]+>/g, ' ');
    const words = text.split(/\s+/).filter(Boolean).length;
    return check('body_word_count', words >= MIN_BODY_WORDS,
        `${words} words (target ${MIN_BODY_WORDS}+)`, { blocking: false });
}

// ── Runner ───────────────────────────────────────────────────────────────────

/**
 * @param product  a product fetched from Shopify (options, media, variants, tags)
 * @param opts     { config, catalogue, expectPublished }
 * @returns { pass, blockingFailures, checks[] }  — `pass` gates the Publish button
 */
function auditProduct(product, opts = {}) {
    const { config = null, catalogue = null, expectPublished = false } = opts;
    if (!product) {
        return { pass: false, blockingFailures: 1, checks: [check('product_exists', false, 'No product supplied')] };
    }

    const checks = [
        checkVariantImageBinding(product),
        checkColourImageDistinct(product),
        checkOrphanMedia(product),
        checkPublished(product, { expectPublished }),
        checkAltText(product),
        checkDuplicateDesignNumber(product, catalogue),
        checkOptionCount(product),
        checkTitleFormat(product),
        checkHandle(product),
        checkInventoryUntracked(product),
        checkPriceLadder(product, config),
        checkTags(product, config),
        checkBodyLength(product)
    ];

    const blockingFailures = checks.filter((c) => c.blocking && !c.pass).length;
    return { pass: blockingFailures === 0, blockingFailures, checks };
}

/** The audit.py-style report, for logs and CLI parity. */
function formatAudit(result) {
    return result.checks
        .map((c) => `${c.pass ? 'ok  ' : 'FAIL'}  ${c.name} — ${c.detail}` +
            (c.items && c.items.length ? `\n        ${c.items.slice(0, 10).join('\n        ')}` : ''))
        .join('\n');
}

module.exports = {
    auditProduct,
    formatAudit,
    checkVariantImageBinding,
    checkColourImageDistinct,
    checkOrphanMedia,
    checkPublished,
    checkAltText,
    checkDuplicateDesignNumber,
    checkOptionCount,
    checkTitleFormat,
    checkHandle,
    checkInventoryUntracked,
    checkPriceLadder,
    checkTags,
    checkBodyLength,
    TITLE_DESIGN_NUMBER_RE,
    MIN_BODY_WORDS
};
