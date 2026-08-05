/**
 * The Box READ routes must stay secret-gated, and the gate must stay ABOVE the
 * router mount.
 *
 * Before 2026-08-05 these were anonymous in production: /api/box/download/:fileId
 * served any file the Box service account could see, /api/box/thumbnail/:fileId
 * the same as an image, and /api/box/art-folders enumerated 9,147 customer
 * folders — no credential of any kind.
 *
 * They could not simply be gated: ~8 staff pages used box/thumbnail as <img>
 * URLs straight from the browser, and a browser cannot hold a secret. The app
 * now fronts them with a session-gated same-origin forwarder, so the SAML cookie
 * authorises the request there and only the app adds the shared secret here.
 *
 * The four WRITE routes joined them on 2026-08-05 (app v2026.08.05.19) — every
 * page calling those was already SAML-gated, so there was no public caller to
 * migrate. All 11 Box routes are now covered.
 *
 * Two things this locks, both of which fail SILENTLY if broken:
 *   1. Express runs mount-path middleware in registration order, so a gate
 *      registered BELOW `app.use('/api', boxUploadRoutes)` never runs — the
 *      routes answer first. The gate would look present and do nothing.
 *   2. Coverage in both directions: a route dropped from the gate silently
 *      re-opens the exposure, and the router-coverage test fails the build if a
 *      NEW Box route appears without an auth decision.
 */

const fs = require('fs');
const path = require('path');

const SERVER = fs.readFileSync(path.join(__dirname, '../../server.js'), 'utf8');

const READ_PATHS = [
    '/api/box/thumbnail',
    '/api/box/download',
    '/api/box/art-folders',
    '/api/box/mockup-folders',
    '/api/box/folder-files',
    '/api/box/search',
    '/api/box/shared-image',
];

// Gated too since 2026-08-05 (app v2026.08.05.19). Every page calling these was
// already SAML-gated, so there was no public caller to migrate first.
const WRITE_PATHS = [
    '/api/box/shared-link',
    '/api/box/create-mockup-folder',
    '/api/box/upload-to-folder',
    '/api/box/file',
];

/** The single `app.use([...], requireCrmApiSecret)` block guarding Box reads. */
function gateBlock() {
    const m = SERVER.match(/app\.use\(\[([^\]]*\/api\/box\/[^\]]*)\],\s*requireCrmApiSecret\s*\)/);
    return m ? m[1] : null;
}

describe('Box read routes are secret-gated', () => {
    test('a gate block for /api/box exists at all', () => {
        expect(gateBlock()).not.toBeNull();
    });

    test.each(READ_PATHS)('%s is inside the gate', (p) => {
        expect(gateBlock()).toContain(`'${p}'`);
    });

    test.each(WRITE_PATHS)('%s is inside the gate too', (p) => {
        expect(gateBlock()).toContain(`'${p}'`);
    });

    test('every Box route in the router is covered by the gate', () => {
        const router = fs.readFileSync(
            path.join(__dirname, '../../src/routes/box-upload.js'), 'utf8');
        const declared = [...router.matchAll(/router\.(?:get|post|put|delete)\('\/box\/([a-z-]+)/g)]
            .map(m => m[1]);
        const gated = new Set([...READ_PATHS, ...WRITE_PATHS].map(p => p.replace('/api/box/', '')));
        const uncovered = [...new Set(declared)].filter(r => !gated.has(r));
        // If this fails, a Box route was added without deciding its auth story.
        expect(uncovered).toEqual([]);
    });

    test('the gate is registered ABOVE the box router mount, or it never runs', () => {
        // Anchor both to line-start so the prose in the comment above the gate
        // (which quotes the mount line verbatim) can't be mistaken for the code.
        const gateIdx = SERVER.search(/^app\.use\(\[[^\]]*\/api\/box\/[^\]]*\],\s*requireCrmApiSecret\s*\);/m);
        const mountIdx = SERVER.search(/^app\.use\('\/api', boxUploadRoutes\);/m);
        expect(gateIdx).toBeGreaterThan(-1);
        expect(mountIdx).toBeGreaterThan(-1);
        expect(gateIdx).toBeLessThan(mountIdx);
    });

    test('every gated path is a real route in the box router', () => {
        const router = fs.readFileSync(
            path.join(__dirname, '../../src/routes/box-upload.js'), 'utf8');
        for (const p of READ_PATHS) {
            const suffix = p.replace('/api', '');           // '/box/thumbnail'
            expect(router).toContain(`'${suffix}`);          // matches '/box/thumbnail/:fileId' too
        }
    });
});

/**
 * ManageOrders tracking (2026-08-05). GET /api/manageorders/tracking returned
 * ~911 KB of customer tracking records to anyone, and /tracking/push WRITES
 * tracking numbers into OnSite. One prefix covers both routers.
 *
 * The ordering assertion matters as much as the gate: registered below either
 * router mount it never runs, and the routes answer first.
 */
describe('ManageOrders tracking is secret-gated', () => {
    const gateRe = /^app\.use\('\/api\/manageorders\/tracking', requireCrmApiSecret\);/m;

    test('the tracking gate exists', () => {
        expect(SERVER).toMatch(gateRe);
    });

    test('it gates EVERY method — /tracking/push writes into OnSite', () => {
        // guardReadsOnly would leave POST open, which is what left
        // /orders/create anonymous for months.
        const line = SERVER.match(gateRe)[0];
        expect(line).not.toContain('guardReadsOnly');
    });

    test.each([
        ["app.use('/api', manageOrdersLimiter, manageOrdersRoutes);", 'manageorders router'],
        ["app.use('/api/manageorders', manageOrdersPushRoutes);", 'push router'],
    ])('the gate is registered above the %s', (mount) => {
        const gateIdx = SERVER.search(gateRe);
        const mountIdx = SERVER.indexOf(mount);
        expect(gateIdx).toBeGreaterThan(-1);
        expect(mountIdx).toBeGreaterThan(-1);
        expect(gateIdx).toBeLessThan(mountIdx);
    });
});

/**
 * POST /api/manageorders/auth/test (2026-08-05).
 *
 * Gated for what it DOES, not what it returns: testAuth() discloses only
 * success/expiry/token LENGTH — never the token or the credentials — but it
 * calls getToken(true), forcing a fresh signin against ManageOrders on every
 * request. Anonymously that let anyone trigger upstream credential operations
 * on demand and churn the shared token cache real order pushes depend on.
 */
describe('ManageOrders auth/test is secret-gated', () => {
    const gateRe = /^app\.use\('\/api\/manageorders\/auth', requireCrmApiSecret\);/m;

    test('the auth gate exists', () => {
        expect(SERVER).toMatch(gateRe);
    });

    test('it is registered above the push router mount, or it never runs', () => {
        const gateIdx = SERVER.search(gateRe);
        const mountIdx = SERVER.indexOf("app.use('/api/manageorders', manageOrdersPushRoutes);");
        expect(gateIdx).toBeGreaterThan(-1);
        expect(mountIdx).toBeGreaterThan(-1);
        expect(gateIdx).toBeLessThan(mountIdx);
    });

    test('/push/health stays OPEN — a health check with no data is deliberate', () => {
        // Guards the reverse mistake: gating the whole push prefix would take
        // the health endpoint with it.
        expect(SERVER).not.toMatch(/^app\.use\('\/api\/manageorders\/push', requireCrmApiSecret\);/m);
    });
});
