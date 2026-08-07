// shopify-orchestrator.js — the create sequence's guards.
//
// The first block exists because I shipped a malformed Q_PRODUCT_FULL in this file:
// a stray brace closed `product` early, putting `variants` outside it. Shopify would
// have rejected every status read, every binding verification and every publish
// check. Nothing in a unit test that mocks the client would have noticed, so the
// documents get checked structurally.

jest.mock('../../src/utils/shopify-client', () => ({
    gql: jest.fn(),
    rest: jest.fn(),
    getToken: jest.fn().mockResolvedValue('fake'),
    resetTokenCache: jest.fn(),
    tokenSecondsRemaining: jest.fn().mockReturnValue(80000),
    isConfigured: jest.fn().mockReturnValue(true),
    storefrontOrigin: jest.fn().mockReturnValue('https://253gear.com'),
    shopDomain: jest.fn().mockReturnValue('nw-custom-apparel.myshopify.com'),
    redactShopify: (v) => String(v && v.message ? v.message : v)
}));
jest.mock('../../src/utils/caspio', () => ({
    getCaspioAccessToken: jest.fn().mockResolvedValue('caspio-token'),
    fetchAllCaspioPages: jest.fn()
}));
jest.mock('axios');

const fs = require('fs');
const path = require('path');
const shopify = require('../../src/utils/shopify-client');
const orch = require('../../src/utils/shopify-orchestrator');

const SRC = fs.readFileSync(
    path.join(__dirname, '..', '..', 'src', 'utils', 'shopify-orchestrator.js'), 'utf8'
);

beforeEach(() => {
    shopify.gql.mockReset();
    shopify.rest.mockReset();
    orch._jobs.clear();
    orch._idempotencyIndex.clear();
});

describe('the GraphQL documents are structurally sound', () => {
    // Pull every template literal assigned to a Q_* / M_* const.
    const docs = [...SRC.matchAll(/const\s+([QM]_[A-Z_]+)\s*=\s*`([\s\S]*?)`;/g)]
        .map(([, name, body]) => ({ name, body }));

    test('found the documents to check', () => {
        expect(docs.length).toBeGreaterThanOrEqual(8);
    });

    test.each(docs.map((d) => [d.name, d.body]))('%s has balanced braces', (_name, body) => {
        let depth = 0;
        for (const ch of body) {
            if (ch === '{') depth++;
            else if (ch === '}') depth--;
            expect(depth).toBeGreaterThanOrEqual(0);   // never closes more than it opened
        }
        expect(depth).toBe(0);
    });

    test.each(docs.map((d) => [d.name, d.body]))('%s has balanced parentheses', (_name, body) => {
        let depth = 0;
        for (const ch of body) {
            if (ch === '(') depth++;
            else if (ch === ')') depth--;
            expect(depth).toBeGreaterThanOrEqual(0);
        }
        expect(depth).toBe(0);
    });

    test('the full-product read keeps variants INSIDE product', () => {
        // The exact bug: `media{...} }` closed product, so variants sat at query level.
        const doc = docs.find((d) => d.name === 'Q_PRODUCT_FULL').body;
        const productAt = doc.indexOf('product(id:$id)');
        let depth = 0;
        let variantsDepth = null;
        for (let i = productAt; i < doc.length; i++) {
            if (doc[i] === '{') depth++;
            else if (doc[i] === '}') depth--;
            if (variantsDepth === null && doc.startsWith('variants(', i)) variantsDepth = depth;
        }
        expect(variantsDepth).toBe(1);   // 1 = inside product's selection set
    });

    test('every mutation document requests userErrors', () => {
        // A 200 with userErrors is a failure; the client can only throw on errors it
        // was given. Forgetting to select them makes a rejection look like a success.
        for (const d of docs.filter((x) => x.name.startsWith('M_'))) {
            expect(d.body).toMatch(/[uU]serErrors\s*\{/);
        }
    });
});

describe('idempotency', () => {
    const payload = { designNumber: '34293' };
    const cfg = { prices: {}, styles: [] };

    test('the same Idempotency-Key returns the SAME job, flagged as a replay', () => {
        shopify.gql.mockResolvedValue({ products: { nodes: [] } });

        const first = orch.startCreate(payload, cfg, { idempotencyKey: 'key-abc' });
        const second = orch.startCreate(payload, cfg, { idempotencyKey: 'key-abc' });

        expect(first.replay).toBe(false);
        expect(second.replay).toBe(true);
        expect(second.job.designNumber).toBe(first.job.designNumber);
        expect(orch._jobs.size).toBe(1);
    });

    test('a double-click without a key still yields one in-flight job per design', () => {
        shopify.gql.mockResolvedValue({ products: { nodes: [] } });

        orch.startCreate(payload, cfg, {});
        const second = orch.startCreate(payload, cfg, {});

        expect(second.replay).toBe(true);
        expect(orch._jobs.size).toBe(1);
    });
});

describe('finding an existing product', () => {
    test('matches only a title ENDING in that design number', () => {
        shopify.gql.mockResolvedValue({
            products: { nodes: [
                { id: 'gid://p/1', title: 'Something 34293 Else' },   // number mid-title, not ours
                { id: 'gid://p/2', title: 'Retro Sumner #34293' }
            ] }
        });
        return orch.findExistingProduct('34293').then((p) => {
            expect(p.id).toBe('gid://p/2');
        });
    });

    test('a near-miss number does not count as found', async () => {
        shopify.gql.mockResolvedValue({ products: { nodes: [{ id: 'gid://p/1', title: 'Other #342930' }] } });
        expect(await orch.findExistingProduct('34293')).toBeNull();
    });

    test('a malformed design number never reaches Shopify', async () => {
        expect(await orch.findExistingProduct('abc')).toBeNull();
        expect(shopify.gql).not.toHaveBeenCalled();
    });
});

describe('media must be READY before binding', () => {
    test('a FAILED image stops the sequence and reports Shopify\'s reason', async () => {
        shopify.gql.mockResolvedValue({
            product: { media: { nodes: [
                { id: 'gid://m/1', status: 'READY' },
                { id: 'gid://m/2', status: 'FAILED', mediaErrors: [{ code: 'INVALID', details: 'Image too small' }] }
            ] } }
        });

        await expect(orch.waitForMediaReady('gid://p/1', 2, null))
            .rejects.toMatchObject({ code: 'MEDIA_FAILED' });
        await expect(orch.waitForMediaReady('gid://p/1', 2, null))
            .rejects.toThrow(/Image too small/);
    });

    test('polls past PROCESSING and returns once every image is READY', async () => {
        // Persistent READY after the first PROCESSING, so an extra poll can never
        // fall off the end of the mock queue and mask what is being tested.
        shopify.gql
            .mockResolvedValueOnce({ product: { media: { nodes: [{ id: 'gid://m/1', status: 'PROCESSING' }] } } })
            .mockResolvedValue({ product: { media: { nodes: [{ id: 'gid://m/1', status: 'READY' }] } } });

        const ready = await orch.waitForMediaReady('gid://p/1', 1, null);

        expect(ready).toHaveLength(1);
        expect(ready[0].status).toBe('READY');
        expect(shopify.gql.mock.calls.length).toBeGreaterThanOrEqual(2);   // it did wait
    });

    test('a job object receives live media progress while polling', async () => {
        const job = { media: [], heartbeatAt: 0, step: 'media_ready', stepsDone: [], progress: {} };
        shopify.gql.mockResolvedValue({ product: { media: { nodes: [{ id: 'gid://m/1', status: 'READY' }] } } });

        await orch.waitForMediaReady('gid://p/1', 1, job);

        expect(job.media).toEqual([{ id: 'gid://m/1', status: 'READY' }]);
        expect(job.heartbeatAt).toBeGreaterThan(0);
    });
});

describe('variant binding refuses to half-finish', () => {
    const variants = [
        { id: 'gid://v/1', sku: 'A-L', selectedOptions: [
            { name: 'Style', value: 'T-Shirt' }, { name: 'Size', value: 'L' }, { name: 'Color', value: 'Black' }] },
        { id: 'gid://v/2', sku: 'B-L', selectedOptions: [
            { name: 'Style', value: 'Hoodie' }, { name: 'Size', value: 'L' }, { name: 'Color', value: 'Black' }] }
    ];

    test('a missing image stops BEFORE any mutation runs', async () => {
        await expect(orch.bindVariantMedia('gid://p/1', variants, [
            { styleOption: 'T-Shirt', catalogColor: 'Black', mediaId: 'gid://m/1' }
        ], null)).rejects.toMatchObject({ code: 'UNBOUND_VARIANTS' });

        expect(shopify.gql).not.toHaveBeenCalled();   // nothing written to a live store
    });

    test('the re-read is what decides success, not the mutation response', async () => {
        shopify.gql
            .mockResolvedValueOnce({ productVariantsBulkUpdate: { productVariants: [{ id: 'gid://v/1' }, { id: 'gid://v/2' }] } })
            // Shopify says it worked; the re-read says one variant has no image.
            .mockResolvedValueOnce({ product: { id: 'gid://p/1', variants: { nodes: [
                { id: 'gid://v/1', image: { id: 'gid://m/1' } },
                { id: 'gid://v/2', image: null }
            ] } } });

        await expect(orch.bindVariantMedia('gid://p/1', variants, [
            { styleOption: 'T-Shirt', catalogColor: 'Black', mediaId: 'gid://m/1' },
            { styleOption: 'Hoodie', catalogColor: 'Black', mediaId: 'gid://m/2' }
        ], null)).rejects.toMatchObject({ code: 'BINDING_INCOMPLETE' });
    });

    test('a fully bound product reports bound === total', async () => {
        shopify.gql
            .mockResolvedValueOnce({ productVariantsBulkUpdate: { productVariants: [] } })
            .mockResolvedValueOnce({ product: { id: 'gid://p/1', variants: { nodes: [
                { id: 'gid://v/1', image: { id: 'gid://m/1' } },
                { id: 'gid://v/2', image: { id: 'gid://m/2' } }
            ] } } });

        const result = await orch.bindVariantMedia('gid://p/1', variants, [
            { styleOption: 'T-Shirt', catalogColor: 'Black', mediaId: 'gid://m/1' },
            { styleOption: 'Hoodie', catalogColor: 'Black', mediaId: 'gid://m/2' }
        ], null);

        expect(result).toMatchObject({ bound: 2, total: 2 });
    });
});

describe('publish is not complete until publishedAt is real', () => {
    test('ACTIVE with a null publishedAt throws — that is the storefront 404', async () => {
        shopify.gql
            .mockResolvedValueOnce({ productUpdate: { product: { id: 'gid://p/1', status: 'ACTIVE' } } })
            .mockResolvedValueOnce({ publishablePublish: { publishable: { publishedAt: null } } })
            .mockResolvedValueOnce({ product: { id: 'gid://p/1', status: 'ACTIVE', publishedAt: null, handle: 'x' } });
        shopify.rest.mockResolvedValue({ product: { published_at: null } });

        await expect(orch.publish('gid://p/1', { publicationId: 'gid://pub/1' }))
            .rejects.toMatchObject({ code: 'PUBLISH_INCOMPLETE' });
    });

    test('falls back to REST when publishablePublish returns nothing', async () => {
        shopify.gql
            .mockResolvedValueOnce({ productUpdate: { product: { id: 'gid://p/1', status: 'ACTIVE' } } })
            .mockResolvedValueOnce({ publishablePublish: { publishable: { publishedAt: null } } })
            .mockResolvedValueOnce({ product: {
                id: 'gid://p/1', status: 'ACTIVE', publishedAt: '2026-08-08T00:00:00Z', handle: 'retro-sumner' } });
        shopify.rest.mockResolvedValue({ product: { published_at: '2026-08-08T00:00:00Z' } });

        const result = await orch.publish('gid://p/1', { publicationId: 'gid://pub/1' });

        expect(shopify.rest).toHaveBeenCalled();
        expect(result.method).toBe('rest');
        expect(result.publishedAt).toBeTruthy();
        expect(result.storefrontUrl).toBe('https://253gear.com/products/retro-sumner');
    });
});

describe('never-delete is enforced by the source, not by intent', () => {
    test('the orchestrator cannot delete a product or a collection', () => {
        expect(SRC).not.toMatch(/productDelete\b/);
        expect(SRC).not.toMatch(/collectionDelete\b/);
    });

    test('deleting media is only reachable behind an explicit opt-in', () => {
        const hasDeleteMedia = /productDeleteMedia/.test(SRC);
        if (hasDeleteMedia) expect(SRC).toMatch(/replaceFailedMedia/);
    });
});
