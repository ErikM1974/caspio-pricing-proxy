/**
 * Locks the /api/design-search gate: origin-or-secret on reads.
 * Drives the middleware directly (cors-allowlist mocked) — the same pattern
 * the mount uses: guardReadsOnly(requireCrmSecretOrBrowserOrigin).
 */

jest.mock('../../src/utils/cors-allowlist', () => ({
    isOriginAllowed: (origin) => origin === 'https://teamnwca.com'
}));

const { requireCrmSecretOrBrowserOrigin, guardReadsOnly } = require('../../src/middleware');

const SECRET = 'test-secret-123';

function run(mw, { method = 'GET', headers = {} } = {}) {
    const req = { method, headers, originalUrl: '/api/design-search/index' };
    const res = {
        statusCode: 0,
        body: null,
        status(c) { this.statusCode = c; return this; },
        json(b) { this.body = b; return this; }
    };
    let nexted = false;
    mw(req, res, () => { nexted = true; });
    return { res, nexted };
}

beforeAll(() => { process.env.CRM_API_SECRET = SECRET; });

describe('requireCrmSecretOrBrowserOrigin', () => {
    test('allowlisted Origin passes (staff browser)', () => {
        const { nexted } = run(requireCrmSecretOrBrowserOrigin, { headers: { origin: 'https://teamnwca.com' } });
        expect(nexted).toBe(true);
    });

    test('allowlisted Referer passes (same-origin fallback)', () => {
        const { nexted } = run(requireCrmSecretOrBrowserOrigin, {
            headers: { referer: 'https://teamnwca.com/dashboards/design-gallery.html' }
        });
        expect(nexted).toBe(true);
    });

    test('CRM secret passes (server-to-server)', () => {
        const { nexted } = run(requireCrmSecretOrBrowserOrigin, { headers: { 'x-crm-api-secret': SECRET } });
        expect(nexted).toBe(true);
    });

    test('bare curl (no origin, no secret) is blocked with 401', () => {
        const { res, nexted } = run(requireCrmSecretOrBrowserOrigin, {});
        expect(nexted).toBe(false);
        expect(res.statusCode).toBe(401);
    });

    test('unlisted Origin is blocked', () => {
        const { res, nexted } = run(requireCrmSecretOrBrowserOrigin, { headers: { origin: 'https://evil.example' } });
        expect(nexted).toBe(false);
        expect(res.statusCode).toBe(401);
    });

    test('wrong secret is blocked', () => {
        const { res, nexted } = run(requireCrmSecretOrBrowserOrigin, { headers: { 'x-crm-api-secret': 'nope' } });
        expect(nexted).toBe(false);
        expect(res.statusCode).toBe(401);
    });
});

describe('guardReadsOnly wrapper', () => {
    const gated = guardReadsOnly(requireCrmSecretOrBrowserOrigin);

    test('GET is enforced', () => {
        const { res, nexted } = run(gated, { method: 'GET' });
        expect(nexted).toBe(false);
        expect(res.statusCode).toBe(401);
    });

    test('non-GET bypasses this gate (writes carry their own limiters)', () => {
        const { nexted } = run(gated, { method: 'POST' });
        expect(nexted).toBe(true);
    });
});
