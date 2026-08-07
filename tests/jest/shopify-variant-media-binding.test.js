// Variant -> image binding. This is the defect that shipped on 253gear.com TWICE:
// once across all 644 variants after the tee/hoodie merge, and again on seven Fall
// variants of #40749 (Downloads/253gear-ops/notes/what-was-done.md:32-34, 84-86).
// Symptom: a hoodie photo sitting above "T-Shirt / $22.50" on a live product page.
//
// The rule under test: one image per (Style, Color); Size never decides an image.
// That is what makes the theme's photo-click handler set Style and Color while
// leaving a shopper's chosen size alone (253gear CLAUDE.md:69-72).

const B = require('../../src/utils/shopify-product-builder');

/** Variants in the shape Shopify hands back from productSet — id + selectedOptions. */
function shopifyVariants(styles, colors, sizes) {
    const out = [];
    let n = 1;
    for (const style of styles) {
        for (const color of colors) {
            for (const size of sizes) {
                out.push({
                    id: `gid://shopify/ProductVariant/${n++}`,
                    sku: `${style}-${color}-${size}`.toUpperCase().replace(/\s+/g, ''),
                    selectedOptions: [
                        { name: 'Style', value: style },
                        { name: 'Size', value: size },
                        { name: 'Color', value: color }
                    ]
                });
            }
        }
    }
    return out;
}

function media(styles, colors) {
    const out = [];
    let n = 1;
    for (const styleOption of styles) {
        for (const catalogColor of colors) {
            out.push({ styleOption, catalogColor, mediaId: `gid://shopify/MediaImage/${n++}` });
        }
    }
    return out;
}

const STYLES = ['T-Shirt', 'Hoodie'];
const COLORS = ['Jet Black', 'Navy'];
const SIZES = ['S', 'M', 'L', 'XL', '2XL', '3XL', '4XL'];

describe('a complete image set binds every variant', () => {
    const variants = shopifyVariants(STYLES, COLORS, SIZES);
    const { bindings, unbound } = B.buildVariantMediaBindings(variants, media(STYLES, COLORS));

    test('nothing is left unbound', () => {
        expect(unbound).toEqual([]);
    });

    test('there is exactly one binding per variant — no exceptions', () => {
        expect(variants).toHaveLength(2 * 2 * 7);
        expect(bindings).toHaveLength(variants.length);
        expect(new Set(bindings.map((b) => b.id)).size).toBe(variants.length);
    });

    test('every binding carries a real mediaId', () => {
        expect(bindings.every((b) => typeof b.mediaId === 'string' && b.mediaId.startsWith('gid://'))).toBe(true);
    });

    test('4 images cover 28 variants — the store binds few images to many variants', () => {
        // 159 images across 47 live products is ~3.4 per product, not one per variant.
        expect(new Set(bindings.map((b) => b.mediaId)).size).toBe(4);
    });
});

describe('Size never decides an image', () => {
    const variants = shopifyVariants(STYLES, COLORS, SIZES);
    const { bindings } = B.buildVariantMediaBindings(variants, media(STYLES, COLORS));
    const byId = Object.fromEntries(bindings.map((b) => [b.id, b.mediaId]));

    test('two variants differing ONLY by size share one mediaId', () => {
        // If they differed, every variant would be alone on its photo, the click
        // handler would treat Size as "decided", and clicking a thumbnail would
        // reset the shopper's size.
        const small = variants.find((v) => v.sku === 'T-SHIRT-JETBLACK-S');
        const fourXl = variants.find((v) => v.sku === 'T-SHIRT-JETBLACK-4XL');
        expect(byId[small.id]).toBe(byId[fourXl.id]);
    });

    test('changing Color changes the image', () => {
        const black = variants.find((v) => v.sku === 'T-SHIRT-JETBLACK-L');
        const navy = variants.find((v) => v.sku === 'T-SHIRT-NAVY-L');
        expect(byId[black.id]).not.toBe(byId[navy.id]);
    });

    test('changing Style changes the image', () => {
        const tee = variants.find((v) => v.sku === 'T-SHIRT-JETBLACK-L');
        const hoodie = variants.find((v) => v.sku === 'HOODIE-JETBLACK-L');
        expect(byId[tee.id]).not.toBe(byId[hoodie.id]);
    });
});

describe('a missing image is caught, loudly and specifically', () => {
    const variants = shopifyVariants(STYLES, COLORS, SIZES);
    const incomplete = media(STYLES, COLORS).filter(
        (m) => !(m.styleOption === 'Hoodie' && m.catalogColor === 'Navy')
    );
    const { bindings, unbound } = B.buildVariantMediaBindings(variants, incomplete);

    test('every affected variant is named, not just counted', () => {
        expect(unbound).toHaveLength(SIZES.length);          // all 7 Navy hoodies
        expect(unbound.every((u) => /HOODIE-NAVY/.test(u.sku))).toBe(true);
        expect(unbound[0]).toHaveProperty('optionValues');   // enough to show the user which cell to fill
    });

    test('the variants that DO have an image still bind — the report is per-variant', () => {
        expect(bindings).toHaveLength(variants.length - SIZES.length);
    });

    test('this is exactly the seven-variant shape of the #40749 incident', () => {
        // Seven Fall variants of one design shipped with no bound image.
        expect(unbound).toHaveLength(7);
    });
});

describe('binding key normalisation', () => {
    test('case and surrounding whitespace do not create a phantom mismatch', () => {
        expect(B.bindingKey('T-Shirt', 'Jet Black')).toBe(B.bindingKey('  t-shirt ', 'JET BLACK'));
    });

    test('media without a mediaId is ignored rather than binding to undefined', () => {
        const variants = shopifyVariants(['T-Shirt'], ['Jet Black'], ['L']);
        const { bindings, unbound } = B.buildVariantMediaBindings(variants, [
            { styleOption: 'T-Shirt', catalogColor: 'Jet Black', mediaId: null }
        ]);
        expect(bindings).toEqual([]);
        expect(unbound).toHaveLength(1);
    });

    test('the first image for a pair wins when duplicates are supplied', () => {
        const variants = shopifyVariants(['T-Shirt'], ['Jet Black'], ['L']);
        const { bindings } = B.buildVariantMediaBindings(variants, [
            { styleOption: 'T-Shirt', catalogColor: 'Jet Black', mediaId: 'gid://shopify/MediaImage/first' },
            { styleOption: 'T-Shirt', catalogColor: 'Jet Black', mediaId: 'gid://shopify/MediaImage/second' }
        ]);
        expect(bindings[0].mediaId).toBe('gid://shopify/MediaImage/first');
    });
});

describe('seasonal products bind on Season x Color', () => {
    test('a Season option binds the same way Style does', () => {
        const variants = [
            { id: 'gid://v/1', sku: 'W-BLK-L', selectedOptions: [
                { name: 'Season', value: 'Winter' }, { name: 'Size', value: 'L' }, { name: 'Color', value: 'Jet Black' }] },
            { id: 'gid://v/2', sku: 'W-BLK-XL', selectedOptions: [
                { name: 'Season', value: 'Winter' }, { name: 'Size', value: 'XL' }, { name: 'Color', value: 'Jet Black' }] },
            { id: 'gid://v/3', sku: 'F-BLK-L', selectedOptions: [
                { name: 'Season', value: 'Fall' }, { name: 'Size', value: 'L' }, { name: 'Color', value: 'Jet Black' }] }
        ];
        const { bindings, unbound } = B.buildVariantMediaBindings(variants, [
            { styleOption: 'Winter', catalogColor: 'Jet Black', mediaId: 'gid://m/winter' },
            { styleOption: 'Fall', catalogColor: 'Jet Black', mediaId: 'gid://m/fall' }
        ]);

        expect(unbound).toEqual([]);
        const byId = Object.fromEntries(bindings.map((b) => [b.id, b.mediaId]));
        expect(byId['gid://v/1']).toBe('gid://m/winter');
        expect(byId['gid://v/2']).toBe('gid://m/winter');   // size-invariant
        expect(byId['gid://v/3']).toBe('gid://m/fall');
    });
});

// ── The gap that let the defect sit live for months ───────────────────────────────────
//
// Every check above asks whether a variant has AN image. None asked whether two colours
// share ONE. Measured on the live store 2026-08-07: six of the seven multi-colour
// products bound by Style alone, so choosing Charcoal showed Athletic Heather — and the
// correct photo was already uploaded, bound to nothing. Both existing audits passed.

const AUDIT = require('../../src/utils/shopify-audit');

/** Variants as the audit sees them: selectedOptions + a featured image. */
function auditVariants(pairs, sizes = ['S', 'M', 'L']) {
    const nodes = [];
    for (const [style, color, imageUrl] of pairs) {
        for (const size of sizes) {
            nodes.push({
                sku: `${style}-${color}-${size}`,
                selectedOptions: [
                    { name: 'Style', value: style },
                    { name: 'Size', value: size },
                    { name: 'Color', value: color }
                ],
                image: imageUrl ? { id: `gid://img/${imageUrl}`, url: `https://cdn/${imageUrl}` } : null
            });
        }
    }
    return { nodes };
}

describe('colour must change the picture', () => {
    const find = (product, name) =>
        AUDIT.auditProduct(product).checks.find((c) => c.name === name);

    test('two colours sharing one photo FAILS, and names the pair', () => {
        const product = {
            variants: auditVariants([
                ['T-Shirt', 'Athletic Heather', 'heather-tee.jpg'],
                ['T-Shirt', 'Charcoal', 'heather-tee.jpg'],      // ← the live defect
                ['Hoodie', 'Athletic Heather', 'heather-hoodie.jpg'],
                ['Hoodie', 'Charcoal', 'heather-hoodie.jpg']
            ]),
            media: { nodes: [] }
        };
        const c = find(product, 'colour_image_distinct');
        expect(c.pass).toBe(false);
        expect(c.blocking).toBe(true);
        expect(c.items.join(' ')).toContain('Charcoal');
        // The old check is blind to it — that is precisely why this one exists.
        expect(find(product, 'variant_image_binding').pass).toBe(true);
    });

    test('one photo per pair PASSES, and sizes sharing a photo is not a clash', () => {
        const c = find({
            variants: auditVariants([
                ['T-Shirt', 'Athletic Heather', 'heather-tee.jpg'],
                ['T-Shirt', 'Charcoal', 'charcoal-tee.jpg'],
                ['Hoodie', 'Athletic Heather', 'heather-hoodie.jpg'],
                ['Hoodie', 'Charcoal', 'charcoal-hoodie.jpg']
            ], ['S', 'M', 'L', 'XL', '2XL', '3XL', '4XL']),
            media: { nodes: [] }
        }, 'colour_image_distinct');
        expect(c.pass).toBe(true);
    });

    // A single-colour product is still checked, because the key is the PAIR: two styles
    // sharing one photo is the original 644-variant defect, colour or no colour.
    test('single colour, two styles — still blocking, and still catches a shared photo', () => {
        const good = find({
            variants: auditVariants([
                ['T-Shirt', 'Black', 'tee.jpg'],
                ['Hoodie', 'Black', 'hoodie.jpg']
            ]),
            media: { nodes: [] }
        }, 'colour_image_distinct');
        expect(good.pass).toBe(true);
        expect(good.blocking).toBe(true);

        const bad = find({
            variants: auditVariants([
                ['T-Shirt', 'Black', 'same.jpg'],
                ['Hoodie', 'Black', 'same.jpg']
            ]),
            media: { nodes: [] }
        }, 'colour_image_distinct');
        expect(bad.pass).toBe(false);
    });

    test('nothing to distinguish — one pair — is a non-blocking pass', () => {
        const c = find({
            variants: auditVariants([['T-Shirt', 'Black', 'tee.jpg']]),
            media: { nodes: [] }
        }, 'colour_image_distinct');
        expect(c.pass).toBe(true);
        expect(c.blocking).toBe(false);
    });
});

describe('an uploaded-but-unbound photo is reported, not silently ignored', () => {
    test('the orphan is surfaced with its position, non-blocking', () => {
        const product = {
            variants: auditVariants([
                ['T-Shirt', 'Maroon', 'maroon-tee.jpg'],
                ['T-Shirt', 'Charcoal', 'charcoal-tee.jpg']
            ]),
            media: {
                nodes: [
                    { id: 'gid://m/1', image: { url: 'https://cdn/maroon-tee.jpg' } },
                    { id: 'gid://m/2', image: { url: 'https://cdn/lifestyle.png' } },   // product-level
                    { id: 'gid://m/3', image: { url: 'https://cdn/charcoal-tee.jpg' } }
                ]
            }
        };
        const c = AUDIT.auditProduct(product).checks.find((x) => x.name === 'orphan_media');
        // Legitimate — lifestyle shots exist — so it must not block a publish...
        expect(c.blocking).toBe(false);
        // ...but its POSITION is what gives it meaning in the theme, so it must be named.
        expect(c.items).toEqual(['position 2']);
        expect(c.detail).toMatch(/position matters/);
    });

    test('a fully bound gallery reports no orphans', () => {
        const c = AUDIT.auditProduct({
            variants: auditVariants([['T-Shirt', 'Black', 'tee.jpg']]),
            media: { nodes: [{ id: 'gid://m/1', image: { url: 'https://cdn/tee.jpg' } }] }
        }).checks.find((x) => x.name === 'orphan_media');
        expect(c.items).toEqual([]);
    });
});

// ── Defects an adversarial review found in the FIRST version of these two checks ───────
//
// All six were real, and every one made a check quietly weaker rather than noisy: the
// failure mode of a bad gate is that it reports success. Each test below fails against
// the original implementation.

describe('the checks survive the shapes Shopify actually returns', () => {
    const colour = (product) =>
        AUDIT.auditProduct(product).checks.find((c) => c.name === 'colour_image_distinct');
    const orphan = (product) =>
        AUDIT.auditProduct(product).checks.find((c) => c.name === 'orphan_media');

    test('sizes inside ONE colour pointing at different photos is caught', () => {
        // Original kept only the LAST variant per pair, so this passed clean — and it is
        // the "photo jumps when you change size" defect.
        const c = colour({
            variants: {
                nodes: [
                    { selectedOptions: [{ name: 'Style', value: 'Tee' }, { name: 'Size', value: 'S' }, { name: 'Color', value: 'Red' }],
                      image: { url: 'https://cdn/red-a.jpg' } },
                    { selectedOptions: [{ name: 'Style', value: 'Tee' }, { name: 'Size', value: 'M' }, { name: 'Color', value: 'Red' }],
                      image: { url: 'https://cdn/red-b.jpg' } },   // ← different photo, same colour
                    { selectedOptions: [{ name: 'Style', value: 'Tee' }, { name: 'Size', value: 'S' }, { name: 'Color', value: 'Blue' }],
                      image: { url: 'https://cdn/blue.jpg' } }
                ]
            },
            media: { nodes: [] }
        });
        expect(c.pass).toBe(false);
        expect(c.items.join(' ')).toMatch(/sizes point at 2 different photos/);
    });

    test('a CDN ?v= that differs between reads is not mistaken for a different photo', () => {
        const c = colour({
            variants: {
                nodes: [
                    { selectedOptions: [{ name: 'Style', value: 'Tee' }, { name: 'Color', value: 'Red' }],
                      image: { url: 'https://cdn/shared.jpg?v=111' } },
                    { selectedOptions: [{ name: 'Style', value: 'Tee' }, { name: 'Color', value: 'Blue' }],
                      image: { url: 'https://cdn/shared.jpg?v=999' } }   // same file, different ?v=
                ]
            },
            media: { nodes: [] }
        });
        expect(c.pass).toBe(false);   // it IS one photo serving two colours
    });

    test("Shopify's INPUT option shape does not degrade to a silent pass", () => {
        // {optionName, name} vs {name, value} — both use `name`, for different things.
        const c = colour({
            options: [{ name: 'Color' }],
            variants: {
                nodes: [
                    { optionValues: [{ optionName: 'Style', name: 'Tee' }, { optionName: 'Color', name: 'Red' }],
                      image: { url: 'https://cdn/same.jpg' } },
                    { optionValues: [{ optionName: 'Style', name: 'Tee' }, { optionName: 'Color', name: 'Blue' }],
                      image: { url: 'https://cdn/same.jpg' } }
                ]
            },
            media: { nodes: [] }
        });
        expect(c.pass).toBe(false);
    });

    test('a declared Color option that no variant reports FAILS rather than passing quietly', () => {
        const c = colour({
            options: [{ name: 'Color' }],
            variants: { nodes: [{ selectedOptions: [{ name: 'Whatever', value: 'x' }], image: { url: 'https://cdn/a.jpg' } }] },
            media: { nodes: [] }
        });
        expect(c.pass).toBe(false);
        expect(c.detail).toMatch(/option shape not understood/);
    });

    test('media GIDs are NOT compared against variant image GIDs', () => {
        // A MediaImage GID and a ProductImage GID are different namespaces for one picture.
        // The original compared them, so a fully bound gallery read as 100% orphaned.
        const o = orphan({
            variants: { nodes: [{ selectedOptions: [], image: { id: 'gid://shopify/ProductImage/1', url: 'https://cdn/a.jpg?v=2' } }] },
            media: { nodes: [{ id: 'gid://shopify/MediaImage/9', image: { url: 'https://cdn/a.jpg?v=7' } }] }
        });
        expect(o.items).toEqual([]);           // bound, despite every id differing
        expect(o.detail).toMatch(/Every photo is bound/);
    });

    test('a query that omits image{url} reports "cannot verify", never "no orphans"', () => {
        // The publish gate's query really did omit it, making the check inert. Silence on
        // data we never received must not read as success.
        const o = orphan({
            variants: { nodes: [{ selectedOptions: [], image: { id: 'gid://shopify/ProductImage/1' } }] },
            media: { nodes: [{ id: 'gid://shopify/MediaImage/9', alt: 'x', status: 'READY' }] }
        });
        expect(o.detail).toMatch(/Cannot verify/);
    });

    test('orphan position is the GALLERY position, not an index into a filtered list', () => {
        const o = orphan({
            variants: { nodes: [{ selectedOptions: [], image: { url: 'https://cdn/c.jpg' } }] },
            media: {
                nodes: [
                    { id: 'gid://m/1', image: { url: 'https://cdn/a.jpg' } },
                    { id: 'gid://m/2', image: { url: 'https://cdn/b.jpg' } },
                    { id: 'gid://m/3', image: { url: 'https://cdn/c.jpg' } }
                ]
            }
        });
        expect(o.items).toEqual(['position 1', 'position 2']);
    });
});

describe('the audit callers fetch the fields the checks need', () => {
    const fs = require('fs');
    const path = require('path');
    const read = (f) => fs.readFileSync(path.join(__dirname, '../../', f), 'utf8');

    // A check is only as good as the query feeding it. This is the drift-lock: change the
    // query and drop image{url}, and orphan_media silently becomes decoration again.
    // Scoped to the queries whose RESULT is handed to auditProduct. Q_MEDIA_STATUS is the
    // media-readiness poll and never reaches the audit, so requiring url there would be
    // noise — and a drift-lock that cries wolf is one everybody learns to bypass.
    test('every query feeding auditProduct requests image { url } on media', () => {
        const orch = read('src/utils/shopify-orchestrator.js');
        const qProductFull = orch.slice(orch.indexOf('const Q_PRODUCT_FULL'), orch.indexOf('const M_PRODUCT_SET'));
        expect(qProductFull).toMatch(/media\(first:\s*\d+\)[\s\S]*?image\{\s*url/);

        // Both route queries: the audit panel AND the publish gate.
        const routes = read('src/routes/shopify-products.js');
        const mediaSels = routes.match(/media\(first:\s*\d+\)\s*\{[^}]*\{[^}]*\}[^}]*\}/g) || [];
        expect(mediaSels.length).toBeGreaterThanOrEqual(2);
        for (const sel of mediaSels) expect(sel).toMatch(/image\{\s*url\s*\}/);
    });

    // The URL is the ONLY thing that joins a variant's ProductImage to a media node's
    // MediaImage - two GID namespaces for one picture. Ask for id alone and the check
    // cannot answer on that path.
    test('every query feeding auditProduct asks for variant image url, not just the GID', () => {
        for (const f of ['src/utils/shopify-orchestrator.js', 'src/routes/shopify-products.js']) {
            const src = read(f);
            const variantSels = src.match(/variants\(first:\s*\d+\)\{[^}]*image\{[^}]*\}/g) || [];
            expect(variantSels.length).toBeGreaterThan(0);
            for (const sel of variantSels) expect(sel).toMatch(/image\{\s*id url\s*\}/);
        }
    });
});
