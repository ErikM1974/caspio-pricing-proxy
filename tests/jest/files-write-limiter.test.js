/**
 * /api/files write limiter — scope lock (2026-09-15).
 *
 * The 120 / 15 min per-IP writeLimiter used to count EVERY method under
 * /api/files and exempt nobody. Two consequences, both hit on 2026-09-15:
 *   • The office NAT puts every staff browser behind ONE client IP, and
 *     GET /api/files/:key is the <img src> on every quote, invoice and Policies
 *     Hub page — a few people reading slide-heavy policies spent the whole
 *     office's upload budget on image reads (a GET answered
 *     RateLimit-Policy: 120;w=900).
 *   • A secret-bearing internal batch upload (Policies Hub slide pipeline)
 *     429'd 100% under the same bucket, while five other limiters already
 *     exempt CRM-secret callers.
 *
 * Locks, behaviourally on the real helpers: reads are never metered, anonymous
 * writes still are, secret-bearing writes are exempt, a WRONG secret is still
 * metered. Then a source lock that server.js actually wires both helpers onto
 * writeLimiter ABOVE the files router — mount order is what makes it real
 * (same shape as box-read-gate.test.js).
 */

const fs = require('fs');
const path = require('path');
const express = require('express');
const rateLimit = require('express-rate-limit');
const { hasCrmSecret, meterWritesOnly } = require('../../src/middleware');

const SECRET = 'test-secret-files-limiter-2026-09-15';
const MAX = 2;

let server;
let base;
let savedSecret;

beforeAll(async () => {
    savedSecret = process.env.CRM_API_SECRET;
    process.env.CRM_API_SECRET = SECRET;

    const app = express();
    const limiter = rateLimit({
        windowMs: 60 * 1000,
        max: MAX,
        standardHeaders: true,
        legacyHeaders: false,
        skip: hasCrmSecret,
        message: { error: 'Too many requests — please slow down and try again shortly.' }
    });
    app.use('/api/files', meterWritesOnly(limiter));
    app.get('/api/files/:key', (req, res) => res.json({ ok: 'read' }));
    app.post('/api/files/upload', (req, res) => res.json({ ok: 'write' }));

    await new Promise((resolve) => { server = app.listen(0, resolve); });
    base = `http://127.0.0.1:${server.address().port}`;
});

afterAll(async () => {
    if (savedSecret === undefined) delete process.env.CRM_API_SECRET;
    else process.env.CRM_API_SECRET = savedSecret;
    await new Promise((resolve) => server.close(resolve));
});

const read = () => fetch(`${base}/api/files/8b0239d0-0cd1-4f8a-a024-22bdf17bc7e8`);
const write = (headers) => fetch(`${base}/api/files/upload`, { method: 'POST', headers });

describe('meterWritesOnly + hasCrmSecret on the files limiter', () => {
    test('GET reads are never counted and never carry limiter headers', async () => {
        for (let i = 0; i < MAX * 5; i++) {
            const res = await read();
            expect(res.status).toBe(200);
            expect(res.headers.get('ratelimit-limit')).toBeNull();
            expect(res.headers.get('ratelimit-policy')).toBeNull();
        }
        // The bucket is still untouched after all those reads.
        const probe = await write();
        expect(probe.status).toBe(200);
        expect(probe.headers.get('ratelimit-remaining')).toBe(String(MAX - 1));
    });

    test('anonymous writes are still metered and 429 past the cap', async () => {
        // One anonymous write was spent by the probe above.
        const second = await write();
        expect(second.status).toBe(200);
        const third = await write();
        expect(third.status).toBe(429);
        expect(await third.json()).toEqual({ error: 'Too many requests — please slow down and try again shortly.' });
        expect(third.headers.get('retry-after')).not.toBeNull();
    });

    test('a write carrying the CRM secret is exempt even with the bucket exhausted', async () => {
        const res = await write({ 'X-CRM-API-Secret': SECRET });
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ ok: 'write' });
        expect(res.headers.get('ratelimit-limit')).toBeNull();
    });

    test('a WRONG secret is still metered (the exemption is not a header-presence check)', async () => {
        const res = await write({ 'X-CRM-API-Secret': 'not-the-secret-but-same-length!!!!!!' });
        expect(res.status).toBe(429);
    });

    test('reads stay open while the write bucket is exhausted', async () => {
        const res = await read();
        expect(res.status).toBe(200);
    });

    test('hasCrmSecret is false when the server has no secret configured', () => {
        const prev = process.env.CRM_API_SECRET;
        delete process.env.CRM_API_SECRET;
        try {
            expect(hasCrmSecret({ headers: { 'x-crm-api-secret': '' } })).toBe(false);
            expect(hasCrmSecret({ headers: { 'x-crm-api-secret': 'anything' } })).toBe(false);
        } finally {
            process.env.CRM_API_SECRET = prev;
        }
    });
});

describe('server.js wires the helpers onto writeLimiter (source lock)', () => {
    const SERVER = fs.readFileSync(path.join(__dirname, '../../server.js'), 'utf8');

    test('writeLimiter exempts CRM-secret callers via hasCrmSecret', () => {
        const block = SERVER.match(/const writeLimiter = rateLimit\(\{([\s\S]*?)\}\);/);
        expect(block).not.toBeNull();
        expect(block[1]).toMatch(/skip:\s*hasCrmSecret/);
        expect(block[1]).toMatch(/max:\s*120/);
    });

    test('/api/files mounts the limiter through meterWritesOnly; embroidery-push stays fully metered', () => {
        expect(SERVER).toMatch(/app\.use\('\/api\/files',\s*meterWritesOnly\(writeLimiter\)\);/);
        expect(SERVER).toMatch(/app\.use\('\/api\/embroidery-push',\s*writeLimiter\);/);
    });

    test('the limiter is mounted ABOVE the files router', () => {
        const limiterAt = SERVER.indexOf("app.use('/api/files', meterWritesOnly(writeLimiter));");
        const routerAt = SERVER.indexOf("require('./src/routes/files-simple')");
        expect(limiterAt).toBeGreaterThan(-1);
        expect(routerAt).toBeGreaterThan(limiterAt);
    });

    test('both helpers come from the middleware module, not an inline copy', () => {
        const imp = SERVER.match(/const \{([^}]*)\} = require\('\.\/src\/middleware'\);/);
        expect(imp).not.toBeNull();
        expect(imp[1]).toMatch(/\bhasCrmSecret\b/);
        expect(imp[1]).toMatch(/\bmeterWritesOnly\b/);
    });
});
