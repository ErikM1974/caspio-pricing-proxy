// Build the Shopify ProductSetInput for a new 253gear.com product.
//
// PURE. No network, no env, no clock. Every value that could ever change — retail
// prices, the size ladder, the Style -> SanMar style map, the tag vocabulary — arrives
// as the `config` argument, sourced from the Erik-editable Shopify_Config_2026 Caspio
// table. That is Erik's standing rule (CLAUDE.md, "Pricing = API, never hardcoded"):
// he changes a number in Caspio and the store reflects it with no deploy.
//
// The rule is enforced, not merely intended: tests/jest/shopify-product-builder.test.js
// greps this file's source and fails if a money literal appears in it.
//
// Each guard below stands in for something that actually went wrong on this store —
// see Downloads/253gear-ops/CLAUDE.md and notes/what-was-done.md.

'use strict';

const MAX_SHOPIFY_OPTIONS = 3;          // Shopify's hard cap (253gear CLAUDE.md gotcha 4)
const DESIGN_NUMBER_RE = /^\d{4,6}$/;   // matches audit.py:35
const SEO_TITLE_MAX = 60;
const SEO_DESCRIPTION_MAX = 155;
// GRAMS, matching every live variant on the store. The reference docs quote SanMar's
// fabric weight in ounces per square yard, which is a different quantity entirely —
// using it as a shipping weight would put a hoodie at ~12 oz instead of ~490 g.
const WEIGHT_UNIT = 'GRAMS';

class ProductBuildError extends Error {
    constructor(message, code, detail) {
        super(message);
        this.name = 'ProductBuildError';
        this.code = code;
        this.detail = detail;
        this.isValidation = true;
    }
}

// ── Identity ─────────────────────────────────────────────────────────────────

/**
 * "Retro Sumner" + "34293" -> "Retro Sumner #34293".
 *
 * The separator is load-bearing. The live theme derives the H1 as
 * `product.title | split: ' #' | first` (theme/product-template.CURRENT.liquid:118),
 * so a design name that itself contains " #" would truncate the H1 at the wrong
 * place. Strip it rather than trusting the input.
 */
function buildTitle(designName, designNumber) {
    const name = String(designName || '').replace(/\s+#/g, ' ').replace(/\s+/g, ' ').trim();
    if (!name) throw new ProductBuildError('Design name is required', 'MISSING_DESIGN_NAME');
    const number = String(designNumber || '').trim();
    if (!DESIGN_NUMBER_RE.test(number)) {
        throw new ProductBuildError(
            `Design number must be 4-6 digits (got "${number}")`, 'BAD_DESIGN_NUMBER', { designNumber: number }
        );
    }
    return `${name} #${number}`;
}

/** The H1 a shopper will actually see — same transform the theme applies. */
function displayTitle(title) {
    return String(title || '').split(' #')[0];
}

function slugify(text) {
    return String(text || '')
        .toLowerCase()
        .replace(/['’]/g, '')
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .replace(/-{2,}/g, '-');
}

/**
 * The product URL.
 *
 * Deliberately carries NO design number: that is an admin search key, not something
 * a shopper or Google should see. The city is appended when the name does not already
 * imply it, so the handle stays descriptive for search.
 */
function buildHandle(designName, city, options = {}) {
    let slug = slugify(String(designName || '').replace(/\s*#\d{4,6}\s*/g, ' '));
    if (!slug) throw new ProductBuildError('Cannot build a handle from an empty design name', 'MISSING_DESIGN_NAME');

    const citySlug = slugify(city);
    if (citySlug && !slug.includes(citySlug)) slug = `${slug}-${citySlug}`;
    if (options.suffix) slug = `${slug}-${slugify(options.suffix)}`;

    if (/\d{4,6}/.test(slug)) {
        // Defensive: a stray number in the name could look like a design number in the URL.
        slug = slug.replace(/-?\d{4,6}-?/g, '-').replace(/^-+|-+$/g, '').replace(/-{2,}/g, '-');
    }
    return slug;
}

// ── Money ────────────────────────────────────────────────────────────────────

/**
 * Retail price for a (style, size), as the decimal string Shopify wants.
 * Base price and the size ladder both come from config — no number lives here.
 * Integer-cent arithmetic so a ladder step can never introduce a float artefact.
 */
function priceFor(styleOption, size, config) {
    const base = config && config.prices ? config.prices[styleOption] : undefined;
    if (base === undefined || base === null || !Number.isFinite(Number(base))) {
        throw new ProductBuildError(
            `No retail price configured for style "${styleOption}"`, 'MISSING_PRICE', { styleOption }
        );
    }
    const ladder = (config.sizeLadder && config.sizeLadder[size]) || 0;
    const cents = Math.round(Number(base) * 100) + Math.round(Number(ladder) * 100);
    if (cents <= 0) {
        throw new ProductBuildError(`Computed a non-positive price for ${styleOption} ${size}`, 'BAD_PRICE');
    }
    return (cents / 100).toFixed(2);
}

/**
 * Reject any price that is not what the configured ladder produces.
 * Server-side guard so neither a fat finger nor an injected value can post a
 * variant at a price Erik never set.
 */
function assertPriceOnLadder(styleOption, size, price, config) {
    const expected = priceFor(styleOption, size, config);
    if (String(price) !== expected) {
        throw new ProductBuildError(
            `Price ${price} for ${styleOption} ${size} is not on the configured ladder (expected ${expected})`,
            'PRICE_OFF_LADDER', { styleOption, size, price, expected }
        );
    }
    return true;
}

// ── Style map ────────────────────────────────────────────────────────────────

function styleDefFor(styleOption, config) {
    const def = (config.styles || []).find((s) => s.option === styleOption);
    if (!def) {
        throw new ProductBuildError(
            `No SanMar style mapped for "${styleOption}"`, 'UNMAPPED_STYLE', { styleOption }
        );
    }
    return def;
}

/**
 * SKU, matching what the 47 live products already use.
 *
 * Base SanMar style for S-XL, with an underscore suffix for the upsizes:
 * PC54, then PC54_2XL / PC54_3XL / PC54_4XL. Colour is deliberately NOT in the SKU —
 * measured off the live catalogue, and the SanMar/ShopWorks size-suffix convention is
 * what downstream systems key on. A colour-bearing SKU would look tidier and be wrong.
 */
function skuFor(styleOption, size, config) {
    const def = styleDefFor(styleOption, config);
    const upsizes = config.upsizes || [];
    const sz = String(size || '').trim().toUpperCase();
    return upsizes.includes(sz) ? `${def.sanmarStyle}_${sz}` : def.sanmarStyle;
}

/**
 * Shipping weight in GRAMS, per SIZE.
 *
 * ⚠️ EVERY size has its own weight — not just the upsizes. Measured across the live
 * catalogue: a tee runs 159 / 181 / 200 / 222 / 231 / 272 / 295 g from S to 4XL, and a
 * hoodie 490 → 680 g. An earlier version of this carried one base weight plus an
 * upsize table, which quietly under-quoted every M, L and XL — up to 77 g light on an
 * XL hoodie. That is money lost on every order, and nothing surfaces it.
 *
 * `weightGrams` remains as a fallback for a size the table does not list, so a new
 * size (5XL, 6XL) degrades to something sane rather than throwing.
 */
function weightFor(styleOption, size, config) {
    const def = styleDefFor(styleOption, config);
    const sz = String(size || '').trim().toUpperCase();
    const bySize = def.weightBySize && def.weightBySize[sz];
    const grams = Number(bySize !== undefined ? bySize : def.weightGrams);
    if (!Number.isFinite(grams) || grams <= 0) {
        throw new ProductBuildError(
            `No usable weight for ${styleOption} ${sz} — set weightGrams in the config`,
            'MISSING_WEIGHT', { styleOption, size: sz }
        );
    }
    return grams;
}

// ── Options ──────────────────────────────────────────────────────────────────

/**
 * Style/Season + Size + Color — and never a fourth.
 *
 * Shopify caps a product at 3 options. Letting it truncate silently would drop a
 * whole axis of the catalogue, so this throws instead. A seasonal design swaps
 * Style for Season, which is why it can carry only one garment.
 */
function buildOptions({ styles = [], sizes = [], colors = [], seasonal = false, seasons = [] }) {
    const options = [];

    if (seasonal) {
        if (!seasons.length) throw new ProductBuildError('A seasonal design needs at least one season', 'MISSING_SEASONS');
        if (styles.length > 1) {
            throw new ProductBuildError(
                'A seasonal design can carry only one garment style — Season, Size and Color already fill Shopify\'s 3-option budget',
                'SEASONAL_MULTI_STYLE', { styles }
            );
        }
        options.push({ name: 'Season', values: seasons.map((v) => ({ name: v })) });
    } else {
        if (!styles.length) throw new ProductBuildError('At least one garment style is required', 'MISSING_STYLES');
        options.push({ name: 'Style', values: styles.map((v) => ({ name: v })) });
    }

    if (!sizes.length) throw new ProductBuildError('At least one size is required', 'MISSING_SIZES');
    if (!colors.length) throw new ProductBuildError('At least one colour is required', 'MISSING_COLORS');

    options.push({ name: 'Size', values: sizes.map((v) => ({ name: v })) });
    options.push({ name: 'Color', values: colors.map((c) => ({ name: c.colorName || c.name })) });

    if (options.length > MAX_SHOPIFY_OPTIONS) {
        throw new ProductBuildError(
            `Shopify allows ${MAX_SHOPIFY_OPTIONS} options; this product needs ${options.length}`,
            'TOO_MANY_OPTIONS', { count: options.length }
        );
    }
    return options;
}

// ── Variants ─────────────────────────────────────────────────────────────────

/**
 * The full variant matrix.
 *
 * `inventoryItem.tracked: false` is not a preference. 19 products on this store were
 * unbuyable — showing "sold out" — until inventory tracking was turned off across the
 * catalogue (notes/what-was-done.md:10). These are printed to order; there is no stock
 * to count. A tracked variant ships sold-out.
 */
function buildVariants({ styles, sizes, colors, seasonal = false, seasons = [] }, config) {
    const primaryValues = seasonal ? seasons : styles;
    const primaryName = seasonal ? 'Season' : 'Style';
    // A seasonal product still needs one real garment for price, SKU and weight.
    const garmentFor = (value) => (seasonal ? styles[0] : value);

    const variants = [];
    for (const primary of primaryValues) {
        const styleOption = garmentFor(primary);
        const def = styleDefFor(styleOption, config);
        for (const color of colors) {
            for (const size of sizes) {
                variants.push({
                    optionValues: [
                        { optionName: primaryName, name: primary },
                        { optionName: 'Size', name: size },
                        { optionName: 'Color', name: color.colorName || color.name }
                    ],
                    price: priceFor(styleOption, size, config),
                    sku: skuFor(styleOption, size, config),
                    inventoryPolicy: 'CONTINUE',
                    inventoryItem: {
                        tracked: false,
                        requiresShipping: true,
                        measurement: { weight: { value: weightFor(styleOption, size, config), unit: WEIGHT_UNIT } }
                    },
                    // Retained for binding; stripped before the mutation is sent.
                    _key: bindingKey(styleOption, color.catalogColor || color.colorName || color.name)
                });
            }
        }
    }
    return variants;
}

// ── Variant -> image binding ─────────────────────────────────────────────────

/**
 * The binding key: (Style, Color). Size is deliberately absent.
 *
 * The theme's photo-click handler treats an option as "decided" by a photo only when
 * every variant sharing that photo agrees on it. With one image per Style x Color,
 * a click sets Style and Color, and Size never qualifies — so a shopper's chosen size
 * survives clicking through the gallery (253gear CLAUDE.md:69-72). One image per
 * variant would break that; one per colour would stop a click setting Style.
 */
function bindingKey(styleOption, catalogColor) {
    return `${String(styleOption).trim().toLowerCase()}|||${String(catalogColor).trim().toLowerCase()}`;
}

/**
 * Map every variant to a mediaId.
 *
 * Returns { bindings, unbound }. The caller MUST refuse to advance while `unbound` is
 * non-empty: a variant with no bound image is the defect that shipped on this store
 * twice — once across all 644 variants, once on seven Fall variants
 * (notes/what-was-done.md:32-34, 84-86).
 */
function buildVariantMediaBindings(variants, images) {
    const mediaByKey = new Map();
    for (const img of images || []) {
        if (!img || !img.mediaId) continue;
        const key = bindingKey(img.styleOption, img.catalogColor);
        if (!mediaByKey.has(key)) mediaByKey.set(key, img.mediaId);
    }

    const bindings = [];
    const unbound = [];
    for (const v of variants || []) {
        const key = v._key || bindingKey(
            optionValue(v, 'Style') || optionValue(v, 'Season'),
            optionValue(v, 'Color')
        );
        const mediaId = mediaByKey.get(key);
        if (!mediaId) {
            unbound.push({ id: v.id, sku: v.sku, key, optionValues: v.optionValues });
        } else if (v.id) {
            bindings.push({ id: v.id, mediaId });
        }
    }
    return { bindings, unbound };
}

/**
 * Read one option's VALUE off a variant, in either shape Shopify uses.
 *
 * ⚠️ The two shapes collide on the key `name`, and getting this wrong is silent:
 *   input  (ProductVariantSetInput): { optionName: 'Style', name: 'T-Shirt' }  -> name is the VALUE
 *   output (variant.selectedOptions): { name: 'Style', value: 'T-Shirt' }      -> name is the OPTION
 * Reading `.name` off the output shape returns "Style" for every variant, so every
 * binding key collapses to the same string and the whole product binds to one image
 * — or to nothing. Disambiguate on the presence of `optionName`, never on `name`.
 */
function optionValue(variant, optionName) {
    const list = variant.optionValues || variant.selectedOptions || [];
    const isInputShape = (o) => o && o.optionName !== undefined;
    const found = list.find((o) => (isInputShape(o) ? o.optionName : o && o.name) === optionName);
    if (!found) return '';
    return isInputShape(found) ? found.name : found.value;
}

// ── Tags, SEO ────────────────────────────────────────────────────────────────

/**
 * Tags are the whole categorisation mechanism: the 8 city collections are automatic,
 * so a correct tag files the product AND puts it in the "Shop by City" menu with no
 * navigation access at all.
 *
 * `config.tagVocabulary` is derived from the live collections' ruleSet, so an emitted
 * tag that matches nothing is a build error rather than a silently unfiled product.
 */
/**
 * Resolve a city to the LITERAL Shopify tag its collection keys on.
 *
 * 🔴 The tag is not the collection handle and is not a slug. Read live from the
 * smart-collection ruleSets: the `tacoma` collection requires the tag `city:Tacoma` —
 * prefixed and capitalised. Emitting a slugified `tacoma` matches no rule, so the
 * product publishes into ZERO collections: invisible to anyone browsing by town and
 * absent from the "Shop by City" menu, with nothing anywhere reporting an error.
 *
 * Accepts a display name ("Tacoma"), a handle ("washington-pnw") or the literal tag,
 * because the classifier and the UI each hold a different one of those.
 */
function cityTagFor(city, config) {
    const wanted = String(city || '').trim().toLowerCase();
    if (!wanted) return null;
    const cities = config.cities || [];
    const hit = cities.find((c) =>
        String(c.name).toLowerCase() === wanted ||
        String(c.tag).toLowerCase() === wanted ||
        String(c.collection).toLowerCase() === wanted);
    return hit ? hit.tag : null;
}

function buildTags({ city, styles = [], extraTags = [], seasonal = false }, config) {
    const tags = new Set(config.baseTags || []);

    if (city) {
        const tag = cityTagFor(city, config);
        if (!tag) {
            throw new ProductBuildError(
                `"${city}" is not a city any collection files on`, 'UNKNOWN_CITY_TAG',
                { city, known: (config.cities || []).map((c) => c.name) }
            );
        }
        tags.add(tag);
    }

    // Garment filter tags are literal too — 'T-Shirt' and 'Hoodie', not slugs.
    for (const styleOption of styles) {
        const def = (config.styles || []).find((s) => s.option === styleOption);
        if (def && def.filterTag) tags.add(def.filterTag);
    }
    if (seasonal) tags.add('Seasonal');
    for (const t of extraTags) if (t) tags.add(String(t).trim());

    return Array.from(tags);
}

/**
 * Which collections a tag set will actually land in, per the discovered rules.
 * Tag comparison is case-insensitive because Shopify matches tags that way, even
 * though the rules are stored capitalised.
 */
function collectionsFor(tags, config) {
    const lower = new Set((tags || []).map((t) => String(t).toLowerCase()));
    return (config.cities || [])
        .filter((c) => lower.has(String(c.tag).toLowerCase()))
        .map((c) => c.collection);
}

function buildSeo({ seoTitle, seoDescription }) {
    const title = String(seoTitle || '').trim();
    const description = String(seoDescription || '').trim();
    if (!title) throw new ProductBuildError('An SEO title is required', 'MISSING_SEO_TITLE');
    if (!description) throw new ProductBuildError('An SEO description is required', 'MISSING_SEO_DESCRIPTION');
    return {
        title: title.slice(0, SEO_TITLE_MAX),
        description: description.slice(0, SEO_DESCRIPTION_MAX)
    };
}

/** Non-blocking warnings the review pane surfaces beside the Google preview. */
function seoWarnings({ seoTitle, seoDescription }) {
    const warnings = [];
    if (String(seoTitle || '').length > SEO_TITLE_MAX) {
        warnings.push(`SEO title is ${seoTitle.length} characters — Google truncates around ${SEO_TITLE_MAX}`);
    }
    if (String(seoDescription || '').length > SEO_DESCRIPTION_MAX) {
        warnings.push(`Meta description is ${seoDescription.length} characters — Google truncates around ${SEO_DESCRIPTION_MAX}`);
    }
    return warnings;
}

// ── The whole input ──────────────────────────────────────────────────────────

/**
 * Assemble the ProductSetInput.
 *
 * Always DRAFT. Publishing is a separate, explicit call after a human has reviewed
 * the preview and the audit has come back clean.
 */
function buildProductSetInput(payload, config) {
    if (!config || !config.prices || !config.styles) {
        throw new ProductBuildError('Product config is missing — refusing to guess prices', 'MISSING_CONFIG');
    }

    const {
        designNumber, designName, designDescription, city,
        styles = [], sizes = [], colors = [], seasonal = false, seasons = [],
        descriptionHtml, seoTitle, seoDescription, extraTags = [], handleSuffix
    } = payload || {};

    // Mandatory identity — enforced HERE, server-side, not only in the form.
    if (!String(designDescription || '').trim()) {
        throw new ProductBuildError(
            'A ShopWorks design description is required', 'MISSING_DESIGN_DESCRIPTION'
        );
    }

    const title = buildTitle(designName, designNumber);
    const options = buildOptions({ styles, sizes, colors, seasonal, seasons });
    const variants = buildVariants({ styles, sizes, colors, seasonal, seasons }, config);

    // productType follows the primary garment ('T-Shirt' / 'Sweatshirt'), matching the
    // live catalogue, rather than one blanket value for everything.
    const primaryStyle = styles[0];
    const primaryDef = (config.styles || []).find((s) => s.option === primaryStyle);
    const productType = (primaryDef && primaryDef.productType) || config.productType || '';

    for (const v of variants) {
        const styleOption = seasonal ? styles[0] : optionValue(v, 'Style');
        assertPriceOnLadder(styleOption, optionValue(v, 'Size'), v.price, config);
    }

    return {
        title,
        handle: buildHandle(designName, city, { suffix: handleSuffix }),
        descriptionHtml: String(descriptionHtml || ''),
        vendor: config.vendor || '',
        productType,
        status: 'DRAFT',
        tags: buildTags({ city, styles, extraTags, seasonal }, config),
        seo: buildSeo({ seoTitle, seoDescription }),
        metafields: [
            { namespace: 'nwca', key: 'design_number', type: 'number_integer', value: String(designNumber) },
            { namespace: 'nwca', key: 'design_description', type: 'multi_line_text_field', value: String(designDescription) }
        ],
        productOptions: options,
        variants: variants.map(({ _key, ...v }) => v)
    };
}

module.exports = {
    buildProductSetInput,
    buildTitle,
    displayTitle,
    buildHandle,
    buildOptions,
    buildVariants,
    buildTags,
    cityTagFor,
    collectionsFor,
    weightFor,
    buildSeo,
    seoWarnings,
    buildVariantMediaBindings,
    bindingKey,
    priceFor,
    assertPriceOnLadder,
    skuFor,
    slugify,
    ProductBuildError,
    MAX_SHOPIFY_OPTIONS,
    DESIGN_NUMBER_RE,
    SEO_TITLE_MAX,
    SEO_DESCRIPTION_MAX
};
