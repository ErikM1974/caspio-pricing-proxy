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
    upsizes: ['2XL', '3XL', '4XL'],
    styles: [
        { option: 'T-Shirt', sanmarStyle: 'PC54', productType: 'T-Shirt', filterTag: 'T-Shirt',
          price: 22.50, weightGrams: 159, weightBySize: { S: 159, M: 181, L: 200, XL: 222, '2XL': 231, '3XL': 272, '4XL': 295 } },
        { option: 'Hoodie', sanmarStyle: 'PC78H', productType: 'Sweatshirt', filterTag: 'Hoodie',
          price: 43.75, weightGrams: 490, weightBySize: { S: 490, M: 490, L: 558, XL: 567, '2XL': 644, '3XL': 680, '4XL': 680 } },
        { option: 'Crewneck', sanmarStyle: 'PC78', productType: 'Sweatshirt', filterTag: 'Crewneck',
          price: 39.00, weightGrams: 422, weightBySize: { S: 422, M: 454, L: 454, XL: 485, '2XL': 485, '3XL': 581, '4XL': 590 } }
    ],
    cities: [
        { name: 'Tacoma', tag: 'city:Tacoma', collection: 'tacoma' },
        { name: 'Sumner', tag: 'city:Sumner', collection: 'sumner' },
        { name: 'Washington', tag: 'city:Washington', collection: 'washington-pnw' }
    ],
    baseTags: ['253'],
    vendor: 'Northwest Custom Apparel',
    productType: 'T-Shirt'
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

    test('every variant has a price, a SKU and a weight in GRAMS', () => {
        // Grams, not ounces — matching all 47 live products. The ounce figures in the
        // reference docs are SanMar's FABRIC weight (oz/yd²), a different quantity.
        for (const v of variants) {
            expect(v.price).toMatch(/^\d+\.\d{2}$/);
            expect(v.sku).toBeTruthy();
            expect(v.inventoryItem.measurement.weight.value).toBeGreaterThan(0);
            expect(v.inventoryItem.measurement.weight.unit).toBe('GRAMS');
        }
    });

    test('SKU is the SanMar style with an upsize suffix, and carries no colour', () => {
        // Measured off the live catalogue: PC54 / PC54_2XL, never PC54-JETBLACK-2XL.
        const hoodie2xl = variants.find((v) =>
            v.optionValues.some((o) => o.name === 'Hoodie') && v.optionValues.some((o) => o.name === '2XL'));
        const hoodieL = variants.find((v) =>
            v.optionValues.some((o) => o.name === 'Hoodie') && v.optionValues.some((o) => o.name === 'L'));

        expect(hoodie2xl.sku).toBe('PC78H_2XL');
        expect(hoodieL.sku).toBe('PC78H');
        expect(hoodie2xl.sku).not.toMatch(/JETBLACK|NAVY/);
        expect(hoodie2xl.price).toBe('45.75');
    });

    test('two colours of the same garment+size share one SKU, as the live store does', () => {
        const black = variants.find((v) => v.optionValues.some((o) => o.name === 'Jet Black')
            && v.optionValues.some((o) => o.name === 'T-Shirt') && v.optionValues.some((o) => o.name === 'L'));
        const navy = variants.find((v) => v.optionValues.some((o) => o.name === 'Navy')
            && v.optionValues.some((o) => o.name === 'T-Shirt') && v.optionValues.some((o) => o.name === 'L'));
        expect(black.sku).toBe(navy.sku);
        expect(black.sku).toBe('PC54');
    });

    test('EVERY size has its own weight, not just the upsizes', () => {
        // The first version keyed only 2XL/3XL/4XL off a base, so M/L/XL all shipped at
        // the S weight — up to 77 g light on an XL hoodie, on every order, silently.
        expect(B.weightFor('T-Shirt', 'S', CONFIG)).toBe(159);
        expect(B.weightFor('T-Shirt', 'M', CONFIG)).toBe(181);
        expect(B.weightFor('T-Shirt', 'XL', CONFIG)).toBe(222);
        expect(B.weightFor('Hoodie', 'L', CONFIG)).toBe(558);
        expect(B.weightFor('Hoodie', 'XL', CONFIG)).toBe(567);
        expect(B.weightFor('T-Shirt', 'L', CONFIG)).toBe(200);
        expect(B.weightFor('T-Shirt', '4XL', CONFIG)).toBe(295);
        expect(B.weightFor('Hoodie', '3XL', CONFIG)).toBe(680);
        expect(B.weightFor('Crewneck', 'L', CONFIG)).toBe(454);
    });

    test('a style with no weight refuses rather than shipping at 0 g', () => {
        const noWeight = { ...CONFIG, styles: [{ option: 'T-Shirt', sanmarStyle: 'PC54', price: 22.50 }] };
        expect(() => B.weightFor('T-Shirt', 'L', noWeight)).toThrow(/No usable weight/);
    });

    test('a seasonal product still prices and SKUs off its one real garment', () => {
        const seasonal = B.buildVariants(
            { styles: ['T-Shirt'], sizes: ['L'], colors: [COLORS[0]], seasonal: true, seasons: ['Winter', 'Fall'] },
            CONFIG
        );
        expect(seasonal).toHaveLength(2);
        expect(seasonal.every((v) => v.price === '22.50')).toBe(true);
        expect(seasonal.every((v) => v.sku === 'PC54')).toBe(true);   // L is not an upsize
        expect(seasonal.map((v) => v.optionValues[0].name)).toEqual(['Winter', 'Fall']);
    });
});

describe('tags drive categorisation — and the exact string matters', () => {
    test('emits the LITERAL tags the collection rules key on', () => {
        // 🔴 city:Sumner, not sumner. 253, not 253-gear. T-Shirt, not tee.
        // These were all wrong before the live rules were read, and a wrong tag files
        // the product into NO collection while reporting success.
        const tags = B.buildTags({ city: 'Sumner', styles: ['T-Shirt', 'Hoodie'] }, CONFIG);
        expect(tags.sort()).toEqual(['253', 'Hoodie', 'T-Shirt', 'city:Sumner']);
    });

    test('tags are never slugified or lowercased', () => {
        const tags = B.buildTags({ city: 'Tacoma', styles: ['T-Shirt'] }, CONFIG);
        expect(tags).toContain('city:Tacoma');
        expect(tags).not.toContain('city:tacoma');
        expect(tags).not.toContain('tacoma');
    });

    test('a city is accepted by name, by tag, or by collection handle', () => {
        // The classifier holds a name, the UI a handle, a resume payload the tag.
        expect(B.cityTagFor('Washington', CONFIG)).toBe('city:Washington');
        expect(B.cityTagFor('city:Washington', CONFIG)).toBe('city:Washington');
        expect(B.cityTagFor('washington-pnw', CONFIG)).toBe('city:Washington');
    });

    test('a city no collection files on is a build error, not a silently unfiled product', () => {
        expect(() => B.buildTags({ city: 'Seattle', styles: ['T-Shirt'] }, CONFIG))
            .toThrow(/is not a city any collection files on/);
    });

    test('the emitted tags resolve to the collections they claim', () => {
        const tags = B.buildTags({ city: 'Tacoma', styles: ['T-Shirt'] }, CONFIG);
        expect(B.collectionsFor(tags, CONFIG)).toEqual(['tacoma']);
        // A garment tag files nothing on its own.
        expect(B.collectionsFor(['T-Shirt'], CONFIG)).toEqual([]);
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
        expect(input.tags).toEqual(expect.arrayContaining(['253', 'city:Sumner', 'T-Shirt', 'Hoodie']));
        expect(input.vendor).toBe('Northwest Custom Apparel');
        expect(input.productType).toBe('T-Shirt');   // follows the primary garment
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
