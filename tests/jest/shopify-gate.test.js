// /api/shopify is secret-gated, and stays that way.
//
// Modelled on tests/jest/box-read-gate.test.js. Both directions matter:
//   - the gate must be registered ABOVE the router mount, or it silently never runs;
//   - EVERY route the router declares must be covered, so a route added next month
//     fails the build until somebody decides its auth story rather than shipping open.
//
// This surface can create and reprice products on a public storefront that takes real
// money, so it also asserts the two things that cap the blast radius: no generic
// GraphQL passthrough, and no delete path.

const fs = require('fs');
const path = require('path');

const SERVER = fs.readFileSync(path.join(__dirname, '..', '..', 'server.js'), 'utf8');
const ROUTER_PATH = path.join(__dirname, '..', '..', 'src', 'routes', 'shopify-products.js');
const ROUTER = fs.readFileSync(ROUTER_PATH, 'utf8');
const UTIL_DIR = path.join(__dirname, '..', '..', 'src', 'utils');
const SHOPIFY_UTILS = fs.readdirSync(UTIL_DIR)
    .filter((f) => /^shopify-.*\.js$/.test(f))
    .map((f) => ({ name: f, src: fs.readFileSync(path.join(UTIL_DIR, f), 'utf8') }));

describe('the mount is gated', () => {
    test('the router is mounted with requireCrmApiSecret ON THE SAME LINE', () => {
        // Gate and mount on one line cannot drift apart in a later edit.
        const mount = SERVER.split('\n').find((l) =>
            l.includes("app.use('/api/shopify'") && l.includes('shopifyProductsRoutes'));
        expect(mount).toBeTruthy();
        expect(mount).toMatch(/app\.use\(\s*'\/api\/shopify'\s*,\s*requireCrmApiSecret\s*,\s*shopifyProductsRoutes\s*\)/);
    });

    test('it is NOT gated with guardReadsOnly (HEAD sails past that)', () => {
        const mount = SERVER.split('\n').find((l) =>
            l.includes("app.use('/api/shopify'") && l.includes('shopifyProductsRoutes'));
        expect(mount).not.toMatch(/guardReadsOnly/);
    });

    test('nothing mounts /api/shopify anywhere else', () => {
        const lines = SERVER.split('\n');
        // Closing quote required. Express treats '/api/shopify' and
        // '/api/shopify-description-ai' as SEPARATE mounts (verified: a request to
        // the latter never enters the former), so a prefix match would wrongly count
        // the sibling AI route as a second mount of this surface.
        const mountIdx = lines
            .map((l, i) => ({ l, i }))
            .filter(({ l }) => /app\.use\(\s*'\/api\/shopify'/.test(l));

        // Exactly two: the write-limiter guard, then the gated router.
        expect(mountIdx).toHaveLength(2);

        // The limiter guard's method check wraps onto the following line, so read
        // the statement, not just the line the mount starts on.
        const limiterStatement = lines.slice(mountIdx[0].i, mountIdx[0].i + 4).join('\n');
        expect(limiterStatement).toMatch(/shopifyWriteLimiter/);
        expect(limiterStatement).toMatch(/req\.method/);

        expect(mountIdx[1].l).toMatch(/requireCrmApiSecret/);
    });

    test('the sibling copy-drafter is gated AND rate-limited', () => {
        // It spends Anthropic tokens on every call, so an open endpoint is also an
        // open tab on the bill — the finding already written up for the AI chats.
        const mount = SERVER.split('\n').find((l) => l.includes("app.use('/api/shopify-description-ai'"));
        expect(mount).toBeTruthy();
        expect(mount).toMatch(/aiChatLimiter/);
        expect(mount).toMatch(/requireCrmApiSecret/);
    });

    test('the gated mount is registered ABOVE every other /api router', () => {
        // Ordering IS the security property. A later mount could otherwise shadow it.
        const lines = SERVER.split('\n');
        const ours = lines.findIndex((l) =>
            l.includes("app.use('/api/shopify'") && l.includes('shopifyProductsRoutes'));
        expect(ours).toBeGreaterThan(-1);

        const otherApiMounts = lines
            .map((l, i) => ({ l, i }))
            .filter(({ l, i }) => i !== ours && /app\.use\(\s*'\/api[^']*'\s*,\s*\w*[Rr]outes?\b/.test(l));

        const above = otherApiMounts.filter(({ i }) => i < ours);
        expect(above).toEqual([]);
    });
});

describe('the write limiter is path-scoped', () => {
    test('it is mounted on /api/shopify, never bare on /api', () => {
        // A limiter mounted bare on '/api' runs for EVERY /api request — that is how
        // the whole proxy once ended up capped at 30 req/min.
        const decl = SERVER.match(/const shopifyWriteLimiter = rateLimit\(\{[\s\S]*?\}\);/);
        expect(decl).toBeTruthy();
        expect(SERVER).toMatch(/app\.use\('\/api\/shopify',\s*\(req, res, next\)/);
        expect(SERVER).not.toMatch(/app\.use\('\/api',\s*shopifyWriteLimiter/);
    });

    test('reads are never throttled by it', () => {
        const block = SERVER.slice(SERVER.indexOf('shopifyWriteLimiter'), SERVER.indexOf('shopifyProductsRoutes'));
        expect(block).toMatch(/GET/);
        expect(block).toMatch(/HEAD/);
        expect(block).toMatch(/OPTIONS/);
    });
});

describe('every declared route is covered by the gate', () => {
    const declared = [...ROUTER.matchAll(/router\.(get|post|put|patch|delete)\(\s*'([^']+)'/g)]
        .map(([, method, p]) => ({ method: method.toUpperCase(), path: p }));

    test('the router actually declares routes', () => {
        expect(declared.length).toBeGreaterThanOrEqual(8);
    });

    test('all of them are relative paths under the gated prefix', () => {
        // A route declared as '/api/…' inside a router mounted at '/api/shopify'
        // would resolve to /api/shopify/api/… — dead, and invisible until someone calls it.
        for (const r of declared) {
            expect(r.path.startsWith('/')).toBe(true);
            expect(r.path.startsWith('/api')).toBe(false);
        }
    });

    test('no route is declared on the bare router root without a method-safe path', () => {
        const roots = declared.filter((r) => r.path === '/');
        expect(roots).toEqual([]);
    });
});

describe('blast radius is capped by construction', () => {
    test('there is NO generic GraphQL passthrough', () => {
        // write_products is catalogue-wide. A passthrough would expose the entire
        // Shopify Admin API behind a staff cookie.
        expect(ROUTER).not.toMatch(/router\.(post|get)\(\s*'\/graphql/);
        expect(ROUTER).not.toMatch(/req\.body\.query/);
        expect(ROUTER).not.toMatch(/gql\(\s*(req|body)\./);
    });

    test('v1 exposes no route that edits an existing product', () => {
        const mutatingProductRoutes = [...ROUTER.matchAll(/router\.(put|patch)\(\s*'([^']+)'/g)];
        expect(mutatingProductRoutes).toEqual([]);
    });

    test('nothing in the Shopify surface can delete a product or collection', () => {
        for (const { name, src } of SHOPIFY_UTILS.concat([{ name: 'shopify-products.js', src: ROUTER }])) {
            expect(`${name}:${/productDelete\b/.test(src)}`).toBe(`${name}:false`);
            expect(`${name}:${/collectionDelete\b/.test(src)}`).toBe(`${name}:false`);
        }
    });

    test('a product id from the URL is validated before it becomes a GID', () => {
        // Stops a caller smuggling a path segment or a foreign resource type through.
        expect(ROUTER).toMatch(/\/\^\\d\{1,20\}\$\//);
        expect(ROUTER).toMatch(/gid:\/\/shopify\/Product\/\$\{id\}/);
    });
});

describe('failure modes are honest', () => {
    test('missing Shopify credentials refuse rather than call unauthenticated', () => {
        expect(ROUTER).toMatch(/isConfigured\(\)/);
        expect(ROUTER).toMatch(/NOT_CONFIGURED/);
        expect(ROUTER).toMatch(/status\(503\)/);
    });

    test('publish is blocked server-side when the audit fails', () => {
        // A disabled button in the browser is a courtesy, not the control.
        const publishBlock = ROUTER.slice(ROUTER.indexOf("'/products/:productId/publish'"));
        expect(publishBlock).toMatch(/AUDIT_FAILED/);
        expect(publishBlock).toMatch(/status\(409\)/);
        expect(publishBlock.indexOf('auditProduct')).toBeLessThan(publishBlock.indexOf('orchestrator.publish'));
    });

    test('the mandatory identity gate is enforced in the route, not only in the form', () => {
        const createBlock = ROUTER.slice(ROUTER.indexOf("router.post('/products'"));
        expect(createBlock).toMatch(/designDescription/);
        expect(createBlock).toMatch(/DESIGN_NUMBER_RE/);
        expect(createBlock).toMatch(/VALIDATION_FAILED/);
    });
});
