// shopify-audit.js — the pre-publish gate.
//
// One failing fixture per check. The first four mirror
// Downloads/253gear-ops/shopify/audit.py:41-46 exactly, so the dashboard panel and
// the Python script can never disagree about what "ok" means.

const A = require('../../src/utils/shopify-audit');

const CONFIG = {
    prices: { 'T-Shirt': 22.50, 'Hoodie': 43.75 },
    sizeLadder: { '2XL': 2, '3XL': 3, '4XL': 4 },
    styles: [
        { option: 'T-Shirt', sanmarStyle: 'PC54', weightOz: 5.4, filterTag: 'tee' },
        { option: 'Hoodie', sanmarStyle: 'PC78H', weightOz: 12.5, filterTag: 'hoodie' }
    ],
    tagVocabulary: ['tacoma', 'sumner', 'puyallup']
};

function variant(over = {}) {
    return {
        id: 'gid://shopify/ProductVariant/1',
        sku: 'PC54-JETBLACK-L',
        price: '22.50',
        image: { id: 'gid://shopify/MediaImage/1' },
        inventoryItem: { tracked: false },
        selectedOptions: [
            { name: 'Style', value: 'T-Shirt' },
            { name: 'Size', value: 'L' },
            { name: 'Color', value: 'Jet Black' }
        ],
        ...over
    };
}

function healthyProduct(over = {}) {
    return {
        id: 'gid://shopify/Product/100',
        title: 'Retro Sumner #34293',
        handle: 'retro-sumner',
        status: 'ACTIVE',
        publishedAt: '2026-08-07T00:00:00Z',
        options: [{ name: 'Style' }, { name: 'Size' }, { name: 'Color' }],
        tags: ['253-gear', 'sumner', 'tee'],
        descriptionHtml: `<p>Hook.</p><p>${'word '.repeat(240)}</p>`,
        media: { nodes: [{ id: 'gid://shopify/MediaImage/1', alt: 'Retro Sumner arch design' }] },
        variants: { nodes: [variant()] },
        ...over
    };
}

describe('a healthy product passes everything', () => {
    test('no blocking failures', () => {
        const result = A.auditProduct(healthyProduct(), { config: CONFIG, catalogue: [], expectPublished: true });
        const failed = result.checks.filter((c) => !c.pass).map((c) => `${c.name}: ${c.detail}`);
        expect(failed).toEqual([]);
        expect(result.pass).toBe(true);
        expect(result.blockingFailures).toBe(0);
    });
});

describe('the four checks ported from audit.py', () => {
    test('unbound variant image BLOCKS and names the variant', () => {
        const product = healthyProduct({
            variants: { nodes: [variant(), variant({ id: 'gid://v/2', sku: 'PC54-NAVY-L', image: null })] }
        });
        const c = A.checkVariantImageBinding(product);
        expect(c.pass).toBe(false);
        expect(c.blocking).toBe(true);
        expect(c.detail).toContain('1/2');
        expect(c.items).toContain('PC54-NAVY-L');
    });

    test('publishedAt null after a publish is a FAILURE, whatever status says', () => {
        // status ACTIVE with publishedAt null = storefront 404. Gotcha 1.
        const product = healthyProduct({ status: 'ACTIVE', publishedAt: null });
        const c = A.checkPublished(product, { expectPublished: true });
        expect(c.pass).toBe(false);
        expect(c.detail).toMatch(/storefront will 404/);
    });

    test('an unpublished DRAFT is expected, not a failure', () => {
        const c = A.checkPublished(healthyProduct({ publishedAt: null }), { expectPublished: false });
        expect(c.pass).toBe(true);
        expect(c.blocking).toBe(false);
    });

    test('missing alt text BLOCKS', () => {
        const product = healthyProduct({
            media: { nodes: [{ id: 'gid://m/1', alt: 'good' }, { id: 'gid://m/2', alt: '  ' }] }
        });
        const c = A.checkAltText(product);
        expect(c.pass).toBe(false);
        expect(c.items).toEqual(['gid://m/2']);
    });

    test('alt text is also read from the image.altText shape', () => {
        const product = healthyProduct({ media: { nodes: [{ id: 'gid://m/1', image: { altText: 'described' } }] } });
        expect(A.checkAltText(product).pass).toBe(true);
    });

    test('a duplicate design number BLOCKS and names the clash', () => {
        const c = A.checkDuplicateDesignNumber(healthyProduct(), [
            { id: 'gid://shopify/Product/999', title: 'Sumner Retro #34293' }
        ]);
        expect(c.pass).toBe(false);
        expect(c.detail).toContain('#34293');
        expect(c.items).toContain('Sumner Retro #34293');
    });

    test('the product does not clash with itself', () => {
        const me = healthyProduct();
        expect(A.checkDuplicateDesignNumber(me, [me]).pass).toBe(true);
    });

    test('no catalogue supplied reports "not run", never a false pass', () => {
        const c = A.checkDuplicateDesignNumber(healthyProduct(), null);
        expect(c.pass).toBe(false);
        expect(c.detail).toMatch(/not run/);
        expect(c.blocking).toBe(false);
    });
});

describe('253gear conventions', () => {
    test('a fourth option BLOCKS', () => {
        const c = A.checkOptionCount(healthyProduct({
            options: [{ name: 'Style' }, { name: 'Season' }, { name: 'Size' }, { name: 'Color' }]
        }));
        expect(c.pass).toBe(false);
        expect(c.detail).toContain('4 of a maximum 3');
    });

    test('a title with no design number BLOCKS', () => {
        expect(A.checkTitleFormat(healthyProduct({ title: 'Retro Sumner' })).pass).toBe(false);
        expect(A.checkTitleFormat(healthyProduct({ title: 'Retro Sumner #123' })).pass).toBe(false);
        expect(A.checkTitleFormat(healthyProduct()).pass).toBe(true);
    });

    test('a design number leaking into the URL is flagged', () => {
        const c = A.checkHandle(healthyProduct({ handle: 'retro-sumner-34293' }));
        expect(c.pass).toBe(false);
        expect(c.detail).toMatch(/admin key/);
    });

    test('tracked inventory BLOCKS — it would ship sold out', () => {
        const product = healthyProduct({
            variants: { nodes: [variant({ inventoryItem: { tracked: true } })] }
        });
        const c = A.checkInventoryUntracked(product);
        expect(c.pass).toBe(false);
        expect(c.detail).toMatch(/show sold out/);
    });

    test('a price off the ladder BLOCKS and shows the expected value', () => {
        const product = healthyProduct({ variants: { nodes: [variant({ price: '19.99' })] } });
        const c = A.checkPriceLadder(product, CONFIG);
        expect(c.pass).toBe(false);
        expect(c.items[0]).toContain('expected 22.50');
    });

    test('the ladder check follows the size, not just the base price', () => {
        const product = healthyProduct({
            variants: { nodes: [variant({
                sku: 'PC54-JETBLACK-3XL', price: '25.50',
                selectedOptions: [
                    { name: 'Style', value: 'T-Shirt' }, { name: 'Size', value: '3XL' }, { name: 'Color', value: 'Jet Black' }]
            })] }
        });
        expect(A.checkPriceLadder(product, CONFIG).pass).toBe(true);
    });

    test('no tag matching a collection rule warns but does not block', () => {
        const c = A.checkTags(healthyProduct({ tags: ['253-gear', 'tee'] }), CONFIG);
        expect(c.pass).toBe(false);
        expect(c.blocking).toBe(false);
        expect(c.detail).toMatch(/will not appear in a city collection/);
    });

    test('thin body copy warns but does not block', () => {
        const c = A.checkBodyLength(healthyProduct({ descriptionHtml: '<p>Short.</p>' }));
        expect(c.pass).toBe(false);
        expect(c.blocking).toBe(false);
        expect(c.detail).toContain('1 words');
    });
});

describe('the runner', () => {
    test('any blocking failure fails the whole audit', () => {
        const product = healthyProduct({ variants: { nodes: [variant({ image: null })] } });
        const result = A.auditProduct(product, { config: CONFIG, catalogue: [] });
        expect(result.pass).toBe(false);
        expect(result.blockingFailures).toBeGreaterThan(0);
    });

    test('warnings alone do not block Publish', () => {
        const product = healthyProduct({ descriptionHtml: '<p>Too short.</p>' });
        const result = A.auditProduct(product, { config: CONFIG, catalogue: [], expectPublished: true });
        expect(result.checks.find((c) => c.name === 'body_word_count').pass).toBe(false);
        expect(result.pass).toBe(true);
    });

    test('no product at all fails closed', () => {
        expect(A.auditProduct(null).pass).toBe(false);
    });

    test('formatAudit reads like audit.py output', () => {
        const result = A.auditProduct(healthyProduct(), { config: CONFIG, catalogue: [], expectPublished: true });
        const text = A.formatAudit(result);
        expect(text).toMatch(/^ok {2}/m);
        expect(text).toContain('variant_image_binding');
    });
});
