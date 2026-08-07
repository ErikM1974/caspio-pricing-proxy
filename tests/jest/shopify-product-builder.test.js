// shopify-product-builder.js — pricing, options, variants, and the config-not-code rule.
//
// The prices below live in THIS file on purpose. In production they come from the
// Erik-editable Shopify_Config_2026 Caspio table; the builder module must contain no
// money literal at all, and the last test in this file enforces that by reading the
// module's source.

const fs = require('fs');
const path = require('path');
const B = require('../../src/utils/shopify-product-builder');

const CONFIG = {
    prices: { 'T-Shirt': 22.50, 'Hoodie': 43.75, 'Crewneck': 39.00 },
    sizeLadder: { '2XL': 2, '3XL': 3, '4XL': 4 },
    sizeOrder: ['S', 'M', 'L', 'XL', '2XL', '3XL', '4XL'],
    styles: [
        { option: 'T-Shirt', sanmarStyle: 'PC54', weightOz: 5.4, filterTag: 'tee' },
        { option: 'Hoodie', sanmarStyle: 'PC78H', weightOz: 12.5, filterTag: 'hoodie' },
        { option: 'Crewneck', sanmarStyle: 'PC78', weightOz: 11.5, filterTag: 'crewneck' }
    ],
    tagVocabulary: ['tacoma', 'puyallup', 'fife', 'edgewood', 'milton', 'sumner', 'spanaway', 'washington-pnw'],
    baseTags: ['253-gear'],
    vendor: '253 Gear',
    productType: 'Apparel'
};

const COLORS = [
    { colorName: 'Jet Black', catalogColor: 'Jet Black' },
    { colorName: 'Navy', catalogColor: 'Navy' }
];

function payload(overrides = {}) {
    return {
        designNumber: '34293',
        designName: 'Retro Sumner',
        designDescription: 'Retro Sumner arch, one-colour white on dark garments.',
        city: 'sumner',
        styles: ['T-Shirt', 'Hoodie'],
        sizes: ['S', 'M', 'L', 'XL', '2XL', '3XL', '4XL'],
        colors: COLORS,
        descriptionHtml: '<p>A hook.</p><p>Real local history.</p>',
        seoTitle: 'Retro Sumner Tee',
        seoDescription: 'A retro Sumner design printed to order in Milton, Washington.',
        ...overrides
    };
}

describe('title and the theme contract', () => {
    test('title carries the design number in the form the theme splits on', () => {
        const title = B.buildTitle('Retro Sumner', '34293');
        expect(title).toBe('Retro Sumner #34293');
        expect(title).toMatch(/#\d{4,6}$/);
        // The live theme does: product.title | split: ' #' | first
        expect(B.displayTitle(title)).toBe('Retro Sumner');
    });

    test('a design name containing " #" cannot truncate the storefront H1', () => {
        // Left alone, "Pier #7 Tacoma" would render an H1 of just "Pier".
        const title = B.buildTitle('Pier #7 Tacoma', '40749');
        expect(B.displayTitle(title)).toBe('Pier 7 Tacoma');
        expect(title).toBe('Pier 7 Tacoma #40749');
    });

    test('a design number outside 4-6 digits is rejected', () => {
        expect(() => B.buildTitle('X', '123')).toThrow(/4-6 digits/);
        expect(() => B.buildTitle('X', '1234567')).toThrow(/4-6 digits/);
        expect(() => B.buildTitle('X', 'ABCD')).toThrow(/4-6 digits/);
        expect(() => B.buildTitle('X', '')).toThrow(/4-6 digits/);
    });
});

describe('price ladder', () => {
    test('base prices come straight from config', () => {
        expect(B.priceFor('T-Shirt', 'L', CONFIG)).toBe('22.50');
        expect(B.priceFor('Hoodie', 'L', CONFIG)).toBe('43.75');
    });

    test('the size ladder adds on top', () => {
        expect(B.priceFor('T-Shirt', '2XL', CONFIG)).toBe('24.50');
        expect(B.priceFor('T-Shirt', '3XL', CONFIG)).toBe('25.50');
        expect(B.priceFor('T-Shirt', '4XL', CONFIG)).toBe('26.50');
        expect(B.priceFor('Hoodie', '2XL', CONFIG)).toBe('45.75');
        expect(B.priceFor('Hoodie', '4XL', CONFIG)).toBe('47.75');
    });

    test('a style with no configured price throws rather than guessing', () => {
        expect(() => B.priceFor('Crewneck', 'L', { ...CONFIG, prices: { 'T-Shirt': 22.50 } }))
            .toThrow(/No retail price configured/);
    });

    test('a price off the ladder is rejected server-side', () => {
        expect(() => B.assertPriceOnLadder('T-Shirt', 'L', '0.01', CONFIG)).toThrow(/not on the configured ladder/);
        expect(B.assertPriceOnLadder('T-Shirt', 'L', '22.50', CONFIG)).toBe(true);
    });

    test('changing config changes every price — nothing is baked in', () => {
        const raised = { ...CONFIG, prices: { ...CONFIG.prices, 'T-Shirt': 25.00 } };
        expect(B.priceFor('T-Shirt', 'L', raised)).toBe('25.00');
        expect(B.priceFor('T-Shirt', '3XL', raised)).toBe('28.00');
    });
});

describe('options — Shopify caps at three', () => {
    test('Style + Size + Color is exactly three', () => {
        const options = B.buildOptions({ styles: ['T-Shirt', 'Hoodie'], sizes: ['S', 'M'], colors: COLORS });
        expect(options).toHaveLength(3);
        expect(options.map((o) => o.name)).toEqual(['Style', 'Size', 'Color']);
    });

    test('a seasonal design swaps Style for Season', () => {
        const options = B.buildOptions({
            styles: ['T-Shirt'], sizes: ['S'], colors: COLORS, seasonal: true, seasons: ['Winter', 'Summer', 'Fall']
        });
        expect(options.map((o) => o.name)).toEqual(['Season', 'Size', 'Color']);
        expect(options).toHaveLength(B.MAX_SHOPIFY_OPTIONS);
    });

    test('a seasonal design with two garments is refused, not silently truncated', () => {
        // Season + Style + Size + Color is four. Shopify would drop one.
        expect(() => B.buildOptions({
            styles: ['T-Shirt', 'Hoodie'], sizes: ['S'], colors: COLORS, seasonal: true, seasons: ['Winter']
        })).toThrow(/only one garment style/);
    });

    test('missing sizes or colours throw instead of producing an empty axis', () => {
        expect(() => B.buildOptions({ styles: ['T-Shirt'], sizes: [], colors: COLORS })).toThrow(/size is required/);
        expect(() => B.buildOptions({ styles: ['T-Shirt'], sizes: ['S'], colors: [] })).toThrow(/colour is required/);
    });
});

describe('variants', () => {
    const variants = B.buildVariants(
        { styles: ['T-Shirt', 'Hoodie'], sizes: ['L', '2XL'], colors: COLORS }, CONFIG
    );

    test('the matrix is complete: styles x colours x sizes', () => {
        expect(variants).toHaveLength(2 * 2 * 2);
    });

    test('EVERY variant has inventory tracking OFF', () => {
        // 19 products on this store were unbuyable until tracking was turned off
        // catalogue-wide. These are printed to order; a tracked variant ships sold-out.
        expect(variants.every((v) => v.inventoryItem.tracked === false)).toBe(true);
        expect(variants.every((v) => v.inventoryPolicy === 'CONTINUE')).toBe(true);
    });

    test('every variant has a price, a SKU and a weight', () => {
        for (const v of variants) {
            expect(v.price).toMatch(/^\d+\.\d{2}$/);
            expect(v.sku).toBeTruthy();
            expect(v.inventoryItem.measurement.weight.value).toBeGreaterThan(0);
            expect(v.inventoryItem.measurement.weight.unit).toBe('OUNCES');
        }
    });

    test('SKU and weight follow the SanMar style, not the display name', () => {
        const hoodie2xl = variants.find((v) =>
            v.optionValues.some((o) => o.name === 'Hoodie') && v.optionValues.some((o) => o.name === '2XL'));
        expect(hoodie2xl.sku).toBe('PC78H-JETBLACK-2XL');
        expect(hoodie2xl.inventoryItem.measurement.weight.value).toBe(12.5);
        expect(hoodie2xl.price).toBe('45.75');
    });

    test('a seasonal product still prices and SKUs off its one real garment', () => {
        const seasonal = B.buildVariants(
            { styles: ['T-Shirt'], sizes: ['L'], colors: [COLORS[0]], seasonal: true, seasons: ['Winter', 'Fall'] },
            CONFIG
        );
        expect(seasonal).toHaveLength(2);
        expect(seasonal.every((v) => v.price === '22.50')).toBe(true);
        expect(seasonal.every((v) => v.sku.startsWith('PC54-'))).toBe(true);
        expect(seasonal.map((v) => v.optionValues[0].name)).toEqual(['Winter', 'Fall']);
    });
});

describe('tags drive categorisation', () => {
    test('city, garment filter and the house tag are all emitted', () => {
        const tags = B.buildTags({ city: 'Sumner', styles: ['T-Shirt', 'Hoodie'] }, CONFIG);
        expect(tags).toEqual(expect.arrayContaining(['253-gear', 'sumner', 'tee', 'hoodie']));
    });

    test('a city no collection files on is a build error, not a silently unfiled product', () => {
        expect(() => B.buildTags({ city: 'Seattle', styles: ['T-Shirt'] }, CONFIG))
            .toThrow(/is not a tag any collection files on/);
    });

    test('multi-word cities slugify to the collection handle', () => {
        const tags = B.buildTags({ city: 'Washington PNW', styles: [] }, CONFIG);
        expect(tags).toContain('washington-pnw');
    });
});

describe('buildProductSetInput', () => {
    test('assembles a complete DRAFT product', () => {
        const input = B.buildProductSetInput(payload(), CONFIG);

        expect(input.status).toBe('DRAFT');           // publishing is always a separate, human step
        expect(input.title).toBe('Retro Sumner #34293');
        expect(input.handle).toBe('retro-sumner');    // city already in the name
        expect(input.productOptions).toHaveLength(3);
        expect(input.variants).toHaveLength(2 * 2 * 7);
        expect(input.tags).toEqual(expect.arrayContaining(['253-gear', 'sumner', 'tee', 'hoodie']));
        expect(input.seo.title).toBeTruthy();
        expect(input.seo.description).toBeTruthy();
    });

    test('the design number and description ride along as metafields', () => {
        const input = B.buildProductSetInput(payload(), CONFIG);
        const byKey = Object.fromEntries(input.metafields.map((m) => [m.key, m.value]));
        expect(byKey.design_number).toBe('34293');
        expect(byKey.design_description).toMatch(/Retro Sumner arch/);
    });

    test('the internal binding key never leaks into the mutation payload', () => {
        const input = B.buildProductSetInput(payload(), CONFIG);
        expect(input.variants.every((v) => v._key === undefined)).toBe(true);
    });

    test('a missing ShopWorks description is refused server-side', () => {
        // The mandatory gate cannot live only in the form.
        expect(() => B.buildProductSetInput(payload({ designDescription: '' }), CONFIG))
            .toThrow(/design description is required/i);
        expect(() => B.buildProductSetInput(payload({ designDescription: '   ' }), CONFIG))
            .toThrow(/design description is required/i);
    });

    test('a missing design number is refused server-side', () => {
        expect(() => B.buildProductSetInput(payload({ designNumber: '' }), CONFIG)).toThrow(/4-6 digits/);
    });

    test('refuses to build at all without config rather than guessing prices', () => {
        expect(() => B.buildProductSetInput(payload(), null)).toThrow(/config is missing/i);
        expect(() => B.buildProductSetInput(payload(), { styles: [] })).toThrow(/config is missing/i);
    });
});

describe("Erik's rule as a build gate", () => {
    test('the builder source contains no money literal', () => {
        // Prices belong in Caspio so Erik changes one without a deploy. If a number
        // ever gets pasted in here, this fails rather than quietly diverging.
        const src = fs.readFileSync(
            path.join(__dirname, '..', '..', 'src', 'utils', 'shopify-product-builder.js'), 'utf8'
        );
        expect(src).not.toMatch(/\b22\.50?\b/);
        expect(src).not.toMatch(/\b43\.75\b/);
        expect(src).not.toMatch(/\b39\.00?\b/);
        // No bare decimal money anywhere (weights and prices alike come from config).
        expect(src).not.toMatch(/=\s*\d+\.\d{2}\s*[;,)]/);
    });
});
