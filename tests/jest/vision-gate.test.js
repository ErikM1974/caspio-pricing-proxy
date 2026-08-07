// /api/vision auth posture.
//
// Every call here spends Anthropic tokens, so an unauthenticated route is an open tab
// on the bill as well as an open endpoint — the finding already written up for the AI
// chats. But a blanket gate would 401 four working staff tools, so the gating is
// deliberately surgical and this test pins BOTH halves of that decision:
//
//   - extract-shopworks IS gated, and the gate is registered ABOVE the router mount
//     (registered below, express never runs it and the gate silently does nothing).
//   - the four routes with live browser callers are NOT gated, on purpose.
//
// The last test is the important one: a NEW vision route fails this suite until
// somebody classifies it. That is how a route stops being accidentally anonymous.

const fs = require('fs');
const path = require('path');

const SERVER = fs.readFileSync(path.join(__dirname, '..', '..', 'server.js'), 'utf8');
const VISION_ROUTE = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'routes', 'vision.js'), 'utf8');

// Gated: no browser caller, reached only through the app's SAML forwarder.
const GATED = ['/extract-shopworks'];

// Deliberately open: each has a live browser caller that hits the proxy directly with
// API_BASE and carries no secret. Closing one means writing an app-side forwarder and
// repointing its caller FIRST.
const OPEN_BY_DESIGN = {
    '/extract-supacolor': 'pages/js/transfer-detail.js:1090',
    '/extract-supacolor-jobs-list': 'dashboards/js/supacolor-orders.js:280',
    '/extract-supacolor-job-detail': 'dashboards/js/supacolor-orders.js:303, pages/js/supacolor-job-detail.js:137',
    '/extract-mockup-info': 'transfer flow (see src/routes/transfer-orders.js:464)'
};

describe('extract-shopworks is gated', () => {
    test('a secret gate is registered for it', () => {
        expect(SERVER).toMatch(/app\.use\(\s*['"]\/api\/vision\/extract-shopworks['"]\s*,\s*requireCrmApiSecret\s*\)/);
    });

    test('the gate is registered ABOVE the router mount', () => {
        // Registered below the mount, express would reach the handler first and the
        // gate would be dead code that still reads as protection.
        const gateAt = SERVER.indexOf("app.use('/api/vision/extract-shopworks'");
        const mountAt = SERVER.indexOf("app.use('/api/vision', visionLimiter");
        expect(gateAt).toBeGreaterThan(-1);
        expect(mountAt).toBeGreaterThan(-1);
        expect(gateAt).toBeLessThan(mountAt);
    });

    test('the gate is the real secret check, not the softer origin check', () => {
        const line = SERVER.split('\n').find((l) => l.includes("app.use('/api/vision/extract-shopworks'"));
        expect(line).toContain('requireCrmApiSecret');
        // requireCrmSecretOrBrowserOrigin is explicitly not a cryptographic boundary.
        expect(line).not.toContain('requireCrmSecretOrBrowserOrigin');
        // guardReadsOnly would be wrong too: these are all POSTs.
        expect(line).not.toContain('guardReadsOnly');
    });
});

describe('the routes with live browser callers stay open, on purpose', () => {
    test('there is no blanket gate over the whole /api/vision prefix', () => {
        expect(SERVER).not.toMatch(/app\.use\(\s*['"]\/api\/vision['"]\s*,\s*requireCrmApiSecret/);
    });

    test.each(Object.entries(OPEN_BY_DESIGN))('%s is not individually gated (caller: %s)', (route) => {
        const gatePattern = new RegExp(`app\\.use\\(\\s*['"]/api/vision${route}['"]\\s*,\\s*require`);
        expect(SERVER).not.toMatch(gatePattern);
    });

    test('the reason they are open is written down where the next person will look', () => {
        const context = SERVER.slice(
            Math.max(0, SERVER.indexOf("app.use('/api/vision/extract-shopworks'") - 1600),
            SERVER.indexOf("app.use('/api/vision', visionLimiter")
        );
        expect(context).toMatch(/browser caller/i);
        expect(context).toMatch(/transfer-detail|supacolor-orders/);
    });
});

describe('no vision route may be accidentally anonymous', () => {
    test('every route declared in vision.js is classified as gated or open-by-design', () => {
        const declared = Array.from(VISION_ROUTE.matchAll(/router\.(get|post|put|patch|delete)\(\s*['"]([^'"]+)['"]/g))
            .map((m) => m[2]);

        expect(declared.length).toBeGreaterThan(0);

        const classified = new Set([...GATED, ...Object.keys(OPEN_BY_DESIGN)]);
        const unclassified = declared.filter((r) => !classified.has(r));

        // If this fails you added a vision route. Decide its auth story, then add it to
        // GATED (and gate it in server.js) or to OPEN_BY_DESIGN with the caller that
        // requires it to stay open. Do not just append it to the open list.
        expect(unclassified).toEqual([]);
    });

    test('every route named in GATED actually has a gate in server.js', () => {
        for (const route of GATED) {
            expect(SERVER).toContain(`app.use('/api/vision${route}', requireCrmApiSecret)`);
        }
    });

    test('the rate limiter is still mounted for the ungated routes', () => {
        // It is the only thing standing between an anonymous caller and the token spend.
        expect(SERVER).toMatch(/app\.use\(\s*['"]\/api\/vision['"]\s*,\s*visionLimiter\s*,\s*visionRoutes\s*\)/);
    });
});

// ── Runtime probe ────────────────────────────────────────────────────────────
//
// The tests above read server.js as text. Source says nothing about behaviour, and
// this repo has been bitten by a gate that read as protection and never ran. So this
// block stands the real middleware and the real vision router up on a socket and
// probes them.
//
// The probe is the one from the earlier anonymous-endpoint sweep: POST with an EMPTY
// body and read the status. 401 means the gate fired first. 400 means the request
// reached the handler and was rejected on its merits — i.e. the route is open.
//
// Deliberately NOT booting the whole proxy: server.js calls warmOnBoot(), which
// rebuilds the design-search index against Caspio. That is a real cost against a
// quota Erik watches, and it proves nothing this probe does not.

describe('runtime probe — the gate actually fires', () => {
    const express = require('express');
    const http = require('http');
    const { requireCrmApiSecret } = require('../../src/middleware');
    const visionRoutes = require('../../src/routes/vision');

    const SECRET = 'test-secret-for-the-gate-probe';
    let server;
    let port;

    beforeAll((done) => {
        process.env.CRM_API_SECRET = SECRET;

        const app = express();
        app.use(express.json({ limit: '10mb' }));
        // The SAME two lines as server.js, in the same order.
        app.use('/api/vision/extract-shopworks', requireCrmApiSecret);
        app.use('/api/vision', visionRoutes);

        server = http.createServer(app);
        server.listen(0, '127.0.0.1', () => { port = server.address().port; done(); });
    });

    afterAll((done) => { server.close(done); });

    function post(pathname, { secret } = {}) {
        return new Promise((resolve, reject) => {
            const body = JSON.stringify({});                 // empty payload — the probe
            const headers = { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) };
            if (secret) headers['x-crm-api-secret'] = secret;
            const req = http.request({ host: '127.0.0.1', port, path: pathname, method: 'POST', headers }, (res) => {
                let data = '';
                res.on('data', (c) => { data += c; });
                res.on('end', () => resolve({ status: res.statusCode, body: data }));
            });
            req.on('error', reject);
            req.end(body);
        });
    }

    test('anonymous POST to extract-shopworks is REJECTED (401)', async () => {
        const res = await post('/api/vision/extract-shopworks');
        expect(res.status).toBe(401);
    });

    test('a wrong secret is rejected too', async () => {
        const res = await post('/api/vision/extract-shopworks', { secret: 'not-the-secret-at-all-x' });
        expect(res.status).toBe(401);
    });

    test('the CORRECT secret passes THROUGH the gate and reaches the handler', async () => {
        // 400 "Missing image field" proves the request got past the gate and into the
        // route. Asserting only the 401 above would pass just as well against a gate
        // that rejected everything, including legitimate callers.
        const res = await post('/api/vision/extract-shopworks', { secret: SECRET });
        expect(res.status).toBe(400);
        expect(res.body).toMatch(/Missing image field/i);
    });

    test('the routes with browser callers are still reachable anonymously (400, not 401)', async () => {
        for (const route of Object.keys(OPEN_BY_DESIGN)) {
            const res = await post(`/api/vision${route}`);
            expect({ route, status: res.status }).toEqual({ route, status: 400 });
        }
    });
});

describe('the ShopWorks extraction prompt', () => {
    test('asks for the design description the 253gear publisher requires', () => {
        expect(VISION_ROUTE).toMatch(/"designDescription":\s*"string\|null"/);
        expect(VISION_ROUTE).toMatch(/Design description \/ notes/i);
    });

    test('forbids inventing a description when the field is absent', () => {
        // A guessed description becomes a permanent product record on a public store.
        const section = VISION_ROUTE.slice(
            VISION_ROUTE.indexOf('Design description / notes'),
            VISION_ROUTE.indexOf('Order type (shown as badge')
        );
        expect(section).toMatch(/verbatim/i);
        expect(section).toMatch(/do not invent|return\s*\n?\s*null/i);
    });

    test('the design number is still extracted (the mandatory identity field)', () => {
        expect(VISION_ROUTE).toMatch(/"designNumber":\s*"string\|null"/);
    });
});
