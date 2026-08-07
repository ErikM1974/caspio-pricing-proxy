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
