/**
 * mockup-read-gate.test.js — the mockup router's THREE prefixes are each gated.
 *
 * WHY THIS EXISTS
 * 2026-08-11: `GET /api/mockup-notes/:id` and `GET /api/mockup-versions/:id`
 * answered a bare anonymous curl with AE note text, author email addresses, thread
 * colours, file names and Box file ids. Verified live against production before
 * the fix: 200 + body, no secret, no session, no Origin.
 *
 * The cause was not a missing gate — it was a gate that covered less than it looked
 * like it did. `src/routes/mockup-routes.js` is ONE router serving THREE sibling
 * path prefixes (`/api/mockups`, `/api/mockup-notes`, `/api/mockup-versions`), and
 * the 2026-07-04 fix gated only the first. A path-prefix gate covers its prefix and
 * nothing beside it. This is the same shape as the four gated sub-prefixes that
 * once left the rest of `/api` anonymous for months.
 *
 * So this file locks the property that actually matters: EVERY prefix the mockup
 * router serves is gated, derived from the router source rather than from a list
 * someone has to remember to update. Add a fourth prefix to that router and this
 * test fails until an auth decision is made about it.
 *
 * It deliberately does NOT pin which middleware is used — reads moved from
 * secret-or-browser-origin to secret-only once the app forwarder shipped, and that
 * migration should not have to fight its own test. What must never regress is that
 * a prefix is gated at all, and that the gate is registered ABOVE the mount.
 */

const fs = require('fs');
const path = require('path');

const REPO = path.join(__dirname, '..', '..');
const SERVER = fs.readFileSync(path.join(REPO, 'server.js'), 'utf8');
const ROUTER = fs.readFileSync(path.join(REPO, 'src', 'routes', 'mockup-routes.js'), 'utf8');

/** Every distinct top-level prefix the mockup router actually serves. */
function routerPrefixes() {
    const out = new Set();
    for (const [, p] of ROUTER.matchAll(/router\.(?:get|post|put|delete|patch)\('\/([a-z0-9-]+)/gi)) {
        out.add('/api/' + p);
    }
    return [...out].sort();
}

/** Gate lines of the form app.use('<prefix>', <anything>); registered on the app. */
function gateLineFor(prefix) {
    const re = new RegExp(`^app\\.use\\('${prefix.replace(/\//g, '\\/')}',\\s*(.+)\\);\\s*$`, 'm');
    const m = SERVER.match(re);
    return m ? m[0] : null;
}

const MOUNT_RE = /^app\.use\('\/api', mockupRoutes\);/m;

describe('mockup router — prefix inventory', () => {
    test('the router still serves exactly the three prefixes we know about', () => {
        // A new prefix here is not a failure of the code — it is a prompt to decide
        // whether it carries PII and gate it. Update this list WITH a gate, never alone.
        expect(routerPrefixes()).toEqual([
            '/api/mockup-notes',
            '/api/mockup-notifications',
            '/api/mockup-versions',
            '/api/mockups',
            '/api/thread-colors',
        ]);
    });
});

describe('mockup reads are gated on EVERY PII prefix', () => {
    // Everything this router serves EXCEPT /api/thread-colors, which is a static RA
    // colour catalogue with no customer data in it.
    //
    // mockup-notifications is on this list because checking beat assuming: the feed
    // looks like transient toast plumbing, but each entry carries companyName and
    // designNumber (mockup-routes.js:1642-1650), and the handler only filters by
    // ?user= when that param is supplied — so an anonymous poll with no user returns
    // every queued notification. It is in-memory and usually empty, which is exactly
    // why it read as harmless.
    const PII_PREFIXES = [
        '/api/mockups',
        '/api/mockup-notes',
        '/api/mockup-versions',
        '/api/mockup-notifications',
    ];

    test.each(PII_PREFIXES)('%s has a gate', (prefix) => {
        expect(gateLineFor(prefix)).not.toBeNull();
    });

    test.each(PII_PREFIXES)('%s gate is registered ABOVE the router mount', (prefix) => {
        const gateIdx = SERVER.indexOf(gateLineFor(prefix));
        const mountIdx = SERVER.search(MOUNT_RE);
        expect(gateIdx).toBeGreaterThan(-1);
        expect(mountIdx).toBeGreaterThan(-1);
        // Express runs middleware in registration order — a gate below the mount
        // never executes, which is exactly how a "gated" route stays anonymous.
        expect(gateIdx).toBeLessThan(mountIdx);
    });

    test.each(PII_PREFIXES)('%s gate spares WRITES', (prefix) => {
        // The CUSTOMER approval view does PUT /api/mockups/:id/status and
        // POST /api/mockup-notes straight from the browser with no secret. Gating
        // every method on these prefixes breaks customer approve/revise, which is a
        // silent revenue path — it fails as a dead button, not an error anyone sees.
        expect(gateLineFor(prefix)).toContain('guardReadsOnly');
    });
});
