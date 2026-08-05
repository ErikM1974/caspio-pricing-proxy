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
 * Two things this locks, both of which fail SILENTLY if broken:
 *   1. Express runs mount-path middleware in registration order, so a gate
 *      registered BELOW `app.use('/api', boxUploadRoutes)` never runs — the
 *      routes answer first. The gate would look present and do nothing.
 *   2. The four WRITE routes are deliberately NOT gated (still called directly
 *      from the browser). Gating them here would break art submission; leaving
 *      a READ route out would silently re-open the customer-data exposure.
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
