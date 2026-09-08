// Every vision route must have an explicit authentication classification.
// Supacolor browser calls now use staff-session relays; ship those callers first.
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const SERVER = fs.readFileSync(path.join(__dirname, '../../server.js'), 'utf8');
const VISION_ROUTE = fs.readFileSync(path.join(__dirname, '../../src/routes/vision.js'), 'utf8');
const GATED = ['/extract-shopworks', '/extract-supacolor', '/extract-supacolor-jobs-list', '/extract-supacolor-job-detail'];
const OPEN_BY_DESIGN = { '/extract-mockup-info': 'existing transfer extraction boundary, outside this caller migration' };
const gateLines = SERVER.split('\n').filter(line => /^app\.use\(/.test(line) && line.includes('/api/vision/') && line.includes('requireCrmApiSecret'));
const strictGate = Symbol('requireCrmApiSecret');
const registered = [];
vm.runInNewContext(gateLines.join('\n'), { requireCrmApiSecret: strictGate, app: { use(paths, ...handlers) {
    for (const route of [paths].flat()) registered.push({ route, handlers });
} } });

describe.each(GATED)('%s is secret-gated', route => {
    test('the production registration applies the strict secret check', () => {
        expect(registered).toContainEqual({ route: '/api/vision' + route, handlers: [strictGate] });
    });
    test('the gate runs before the router can handle a request', () => {
        const line = gateLines.find(value => value.includes("'/api/vision" + route + "'"));
        expect(line).toBeDefined();
        const mountAt = SERVER.indexOf("app.use('/api/vision', visionLimiter");
        expect(mountAt).toBeGreaterThan(-1);
        expect(SERVER.indexOf(line)).toBeLessThan(mountAt);
    });
});

describe('remaining extraction boundary', () => {
    test('there is no blanket secret gate over /api/vision', () => {
        expect(SERVER).not.toMatch(/app\.use\(\s*['"]\/api\/vision['"]\s*,\s*requireCrmApiSecret/);
    });
    test.each(Object.keys(OPEN_BY_DESIGN))('%s remains outside this migration', route => {
        expect(registered.map(item => item.route)).not.toContain('/api/vision' + route);
    });
    test('the deployment order and remaining boundary are documented at the mount', () => {
        const context = SERVER.slice(SERVER.indexOf('// SECURITY (2026-08-07)'), SERVER.indexOf("app.use('/api/vision', visionLimiter"));
        expect(context).toMatch(/staff-session relays/);
        expect(context).toMatch(/FIRST/);
        expect(context).toMatch(/extract-mockup-info/);
    });
    test('every declared vision route has an explicit classification', () => {
        const declared = [...VISION_ROUTE.matchAll(/router\.(get|post|put|patch|delete)\(\s*['"]([^'"]+)['"]/g)].map(match => match[2]);
        expect(declared.length).toBeGreaterThan(0);
        const classified = new Set([...GATED, ...Object.keys(OPEN_BY_DESIGN)]);
        expect(declared.filter(route => !classified.has(route))).toEqual([]);
    });
    test('all extraction routes retain their rate limiter', () => {
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
    const originalSecret = process.env.CRM_API_SECRET;
    let server;
    let port;

    beforeAll((done) => {
        process.env.CRM_API_SECRET = SECRET;

        const app = express();
        app.use(express.json({ limit: '10mb' }));
        // Execute the real gates rather than a copied registration.
        vm.runInNewContext(gateLines.join('\n'), { app, requireCrmApiSecret });
        app.use('/api/vision', visionRoutes);

        server = http.createServer(app);
        server.listen(0, '127.0.0.1', () => { port = server.address().port; done(); });
    });

    afterAll((done) => {
        if (originalSecret === undefined) delete process.env.CRM_API_SECRET;
        else process.env.CRM_API_SECRET = originalSecret;
        server.close(done);
    });

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

    test('the remaining unmodified extraction boundary still reaches its validation', async () => {
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
