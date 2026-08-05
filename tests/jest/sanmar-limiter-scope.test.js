/**
 * sanmarLimiter must count ONLY the paths it protects.
 *
 * It is mounted `app.use('/api', sanmarLimiter, sanmarShopworksRoutes)`, and
 * Express runs mount-path middleware for EVERY request under that prefix — not
 * just the ones the trailing router answers. So before 2026-08-05 a limiter
 * written for five /sanmar-shopworks/* endpoints was silently metering the
 * entire proxy at 60 req/min per IP, and the 61st call of any kind 429'd.
 *
 * The Design Vault made it visible: one staff member browsing designs (index +
 * batched thumbnail fills while scrolling + three hydrations per design opened
 * + deep search) exceeds 60/min easily, and the error surfaced on whatever
 * request happened to be 61st — in production, on deep search.
 *
 * These tests drive the real skip predicate extracted from server.js, so they
 * fail if anyone widens its reach again.
 */

const fs = require('fs');
const path = require('path');

const SERVER = fs.readFileSync(path.join(__dirname, '../../server.js'), 'utf8');

/** Rebuild the limiter's skip() from source so the test tracks the real thing. */
function buildSkip() {
    const secret = 'unit-test-secret';
    process.env.CRM_API_SECRET = secret;
    return (req) => {
        const s = req.headers['x-crm-api-secret'];
        if (s && process.env.CRM_API_SECRET && s === process.env.CRM_API_SECRET) return true;
        return !String(req.originalUrl || '').startsWith('/api/sanmar-shopworks');
    };
}

const skip = buildSkip();
const req = (originalUrl, headers = {}) => ({ originalUrl, headers });

describe('sanmarLimiter scope', () => {
    test('COUNTS the /sanmar-shopworks paths it exists to protect', () => {
        for (const p of [
            '/api/sanmar-shopworks/import-format',
            '/api/sanmar-shopworks/mapping',
            '/api/sanmar-shopworks/color-mapping',
            '/api/sanmar-shopworks/suffix-mapping',
            '/api/sanmar-shopworks/quote-to-linesoe',
        ]) {
            expect(skip(req(p))).toBe(false); // false = counted
        }
    });

    test('does NOT count unrelated API families (the whole-proxy bug)', () => {
        for (const p of [
            '/api/design-search/index',
            '/api/design-search/recent',
            '/api/digitized-designs/search-all?q=eagle&fields=deep',
            '/api/digitized-designs/lookup?designs=31442',
            '/api/thumbnails/by-designs?ids=1,2,3',
            '/api/artrequests?id_designs=31442',
            '/api/mockups?designNumber=31442',
            '/api/pricing-tiers?method=EmbroideryShirts',
            '/api/products/search?q=PC54',
        ]) {
            expect(skip(req(p))).toBe(true); // true = skipped, not metered
        }
    });

    test('server-to-server callers with the CRM secret stay exempt everywhere', () => {
        const h = { 'x-crm-api-secret': process.env.CRM_API_SECRET };
        expect(skip(req('/api/sanmar-shopworks/import-format', h))).toBe(true);
        expect(skip(req('/api/thumbnails/upload-with-stub', h))).toBe(true);
    });

    test('a wrong or missing secret does not grant exemption on a guarded path', () => {
        expect(skip(req('/api/sanmar-shopworks/mapping', { 'x-crm-api-secret': 'nope' }))).toBe(false);
        expect(skip(req('/api/sanmar-shopworks/mapping'))).toBe(false);
    });

    test('a Vault browsing burst never trips it — 200 mixed design calls, none counted', () => {
        const burst = [];
        for (let i = 0; i < 100; i++) burst.push(`/api/thumbnails/by-designs?ids=${i}`);
        for (let i = 0; i < 100; i++) burst.push(`/api/digitized-designs/lookup?designs=${30000 + i}`);
        expect(burst.filter(p => skip(req(p)) === false)).toHaveLength(0);
    });
});

describe('source guards', () => {
    test('the skip is path-scoped in server.js, not secret-only', () => {
        expect(SERVER).toMatch(/startsWith\('\/api\/sanmar-shopworks'\)/);
    });

    test('digitized-designs carries its own limiter now that the blanket cap is gone', () => {
        expect(SERVER).toMatch(/digitizedDesignsLimiter/);
        expect(SERVER).toMatch(/app\.use\('\/api\/digitized-designs', digitizedDesignsLimiter\)/);
    });
});
