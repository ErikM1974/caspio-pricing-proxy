// shopify-client.js — token caching, throttle math, and error disposition.
//
// Every assertion here maps to a failure mode named in the 253Gear Publisher plan:
//   - N tokens minted on a cold dyno (no single-flight)
//   - a mutation blind-retried on 5xx, producing a duplicate product on a store
//     whose standing rule is "never delete"
//   - a 200 OK carrying userErrors read as success (the gap in the reference
//     sh.py:50-52, which only checks top-level `errors`)
//   - a live admin write-token leaking into a log line or an error message
//
// No network: axios is mocked.

jest.mock('axios', () => {
    const fn = jest.fn();
    fn.post = jest.fn();
    return fn;
});

const axios = require('axios');
const client = require('../../src/utils/shopify-client');

const FAKE_TOKEN = 'shpat_THIS_IS_A_FAKE_TOKEN_0123456789';
const FAKE_SECRET = 'fake_client_secret_abcdefghijklmnop';

function tokenResponse(expiresIn = 86400) {
    return { data: { access_token: FAKE_TOKEN, expires_in: expiresIn } };
}

function gqlResponse(data, extras = {}) {
    return { status: 200, data: { data, ...extras }, headers: {} };
}

beforeEach(() => {
    process.env.SHOPIFY_SHOP_DOMAIN = 'nw-custom-apparel.myshopify.com';
    process.env.SHOPIFY_CLIENT_ID = 'fake_client_id_1234567890';
    process.env.SHOPIFY_CLIENT_SECRET = FAKE_SECRET;
    process.env.SHOPIFY_API_VERSION = '2025-01';
    client.resetTokenCache();
    axios.mockReset();
    axios.post.mockReset();
});

describe('token cache', () => {
    test('ten concurrent cold callers mint exactly ONE token (single-flight)', async () => {
        axios.post.mockImplementation(() => new Promise((r) => setTimeout(() => r(tokenResponse()), 10)));

        const tokens = await Promise.all(Array.from({ length: 10 }, () => client.getToken()));

        expect(axios.post).toHaveBeenCalledTimes(1);
        expect(new Set(tokens).size).toBe(1);
        expect(tokens[0]).toBe(FAKE_TOKEN);
    });

    test('a warm cache does not re-mint', async () => {
        axios.post.mockResolvedValue(tokenResponse());
        await client.getToken();
        await client.getToken();
        await client.getToken();
        expect(axios.post).toHaveBeenCalledTimes(1);
    });

    test('caches to 90% of expires_in, not to expiry', async () => {
        axios.post.mockResolvedValue(tokenResponse(1000));
        await client.getToken();
        const remaining = client.tokenSecondsRemaining();
        // 90% of 1000 = 900. Allow a second of clock drift.
        expect(remaining).toBeLessThanOrEqual(900);
        expect(remaining).toBeGreaterThan(890);
    });

    test('missing credentials report which ones, and never throw a network call', async () => {
        delete process.env.SHOPIFY_CLIENT_SECRET;
        client.resetTokenCache();
        expect(client.isConfigured()).toBe(false);
        expect(client.missingConfig()).toContain('SHOPIFY_CLIENT_SECRET');
        await expect(client.gql('{shop{name}}')).rejects.toMatchObject({ code: 'NOT_CONFIGURED' });
        expect(axios).not.toHaveBeenCalled();
    });
});

describe('secret redaction', () => {
    test('the token and client secret never survive redactShopify', async () => {
        axios.post.mockResolvedValue(tokenResponse());
        await client.getToken();

        const leaky = `X-Shopify-Access-Token: ${FAKE_TOKEN} secret=${FAKE_SECRET} Bearer ${FAKE_TOKEN}`;
        const safe = client.redactShopify(leaky);

        expect(safe).not.toContain(FAKE_TOKEN);
        expect(safe).not.toContain(FAKE_SECRET);
        expect(safe).toContain('[redacted]');
    });

    test('minting a token logs nothing containing the token', async () => {
        const logged = [];
        const spies = ['log', 'warn', 'error'].map((level) =>
            jest.spyOn(console, level).mockImplementation((...args) => logged.push(args.join(' '))));

        axios.post.mockResolvedValue(tokenResponse());
        await client.getToken();

        spies.forEach((s) => s.mockRestore());
        expect(logged.join('\n')).not.toContain(FAKE_TOKEN);
    });

    test('an HTTP error message carries no secret', async () => {
        axios.post.mockResolvedValue(tokenResponse());
        axios.mockResolvedValue({ status: 422, data: { note: `token ${FAKE_TOKEN} rejected` }, headers: {} });

        await expect(client.gql('{shop{name}}')).rejects.toThrow(/\[redacted\]/);
        await expect(client.gql('{shop{name}}')).rejects.not.toThrow(new RegExp(FAKE_TOKEN));
    });
});

describe('userErrors are failures even on HTTP 200', () => {
    test('gql throws when a mutation returns userErrors', async () => {
        axios.post.mockResolvedValue(tokenResponse());
        axios.mockResolvedValue(gqlResponse({
            productSet: { product: { id: 'gid://shopify/Product/1' }, userErrors: [{ field: ['handle'], message: 'Handle taken' }] }
        }));

        await expect(client.gql('mutation { productSet { id } }')).rejects.toMatchObject({ code: 'USER_ERRORS' });
    });

    test('collectUserErrors finds NESTED, differently-named error arrays', () => {
        // productCreateMedia uses `mediaUserErrors`, not `userErrors`. Naming each
        // mutation's variant by hand guarantees the next new one is missed.
        const found = client.collectUserErrors({
            productCreateMedia: {
                media: [{ id: 'gid://shopify/MediaImage/1' }],
                mediaUserErrors: [{ code: 'INVALID', message: 'Unsupported image' }]
            }
        });
        expect(found).toHaveLength(1);
        expect(found[0].message).toBe('Unsupported image');
        expect(found[0].at).toContain('mediaUserErrors');
    });

    test('an empty userErrors array is success, not failure', async () => {
        axios.post.mockResolvedValue(tokenResponse());
        axios.mockResolvedValue(gqlResponse({ productSet: { product: { id: 'gid://x/1' }, userErrors: [] } }));

        const data = await client.gql('mutation { productSet { id } }');
        expect(data.productSet.product.id).toBe('gid://x/1');
    });
});

describe('error disposition', () => {
    test('5xx on a MUTATION is reconcile, never retry', () => {
        // The mutation may have applied before the connection died. Replaying it is
        // how one design becomes two permanent products.
        expect(client.classifyShopifyError({ status: 500 }, { isMutation: true })).toBe('reconcile');
        expect(client.classifyShopifyError({ status: 503 }, { isMutation: true })).toBe('reconcile');
        expect(client.classifyShopifyError({ code: 'ECONNRESET' }, { isMutation: true })).toBe('reconcile');
    });

    test('5xx on a READ is safely retryable', () => {
        expect(client.classifyShopifyError({ status: 500 }, { isMutation: false })).toBe('retry');
    });

    test('throttling retries, userErrors do not', () => {
        expect(client.classifyShopifyError({ code: 'THROTTLED' })).toBe('retry');
        expect(client.classifyShopifyError({ status: 429 })).toBe('retry');
        expect(client.classifyShopifyError({ code: 'USER_ERRORS' }, { isMutation: true })).toBe('fatal');
        expect(client.classifyShopifyError({ code: 'NOT_CONFIGURED' })).toBe('fatal');
        expect(client.classifyShopifyError({ status: 400 })).toBe('fatal');
    });

    test('401/403 asks for a re-auth', () => {
        expect(client.classifyShopifyError({ status: 401 })).toBe('auth');
        expect(client.classifyShopifyError({ status: 403 })).toBe('auth');
    });
});

describe('throttle math', () => {
    test('waits for exactly the shortfall at the restore rate', () => {
        // Need 1000, have 200, refills 50/sec -> 800/50 = 16s, capped at 10s.
        expect(client.computeThrottleWaitMs(
            { requestedQueryCost: 1000 }, { currentlyAvailable: 200, restoreRate: 50 }
        )).toBe(10000);

        // Need 300, have 200, refills 50/sec -> 100/50 = 2s.
        expect(client.computeThrottleWaitMs(
            { requestedQueryCost: 300 }, { currentlyAvailable: 200, restoreRate: 50 }
        )).toBe(2000);
    });

    test('no wait when the bucket already covers the request', () => {
        expect(client.computeThrottleWaitMs(
            { requestedQueryCost: 100 }, { currentlyAvailable: 900, restoreRate: 50 }
        )).toBe(0);
    });

    test('a missing restoreRate falls back rather than dividing by zero', () => {
        const ms = client.computeThrottleWaitMs({ requestedQueryCost: 200 }, { currentlyAvailable: 100 });
        expect(Number.isFinite(ms)).toBe(true);
        expect(ms).toBeGreaterThan(0);
    });
});

describe('401 re-auth', () => {
    test('a single 401 refreshes the token and retries exactly once', async () => {
        axios.post.mockResolvedValue(tokenResponse());
        axios
            .mockResolvedValueOnce({ status: 401, data: {}, headers: {} })
            .mockResolvedValueOnce(gqlResponse({ shop: { name: '253 Gear' } }));

        const data = await client.gql('{shop{name}}');

        expect(data.shop.name).toBe('253 Gear');
        expect(axios).toHaveBeenCalledTimes(2);
        expect(axios.post).toHaveBeenCalledTimes(2); // original mint + re-mint
    });

    test('a persistent 401 gives up instead of looping', async () => {
        axios.post.mockResolvedValue(tokenResponse());
        axios.mockResolvedValue({ status: 401, data: {}, headers: {} });

        await expect(client.gql('{shop{name}}')).rejects.toMatchObject({ status: 401 });
        expect(axios).toHaveBeenCalledTimes(2);
    });
});
