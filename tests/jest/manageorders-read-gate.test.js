/**
 * The ManageOrders PII reads must stay secret-gated, and every route in
 * src/routes/manageorders.js must have an explicit auth decision.
 *
 * Before 2026-08-10 most of that file answered the public internet. The gates were
 * written per-sub-prefix — /orders, /lineitems, /tracking, /auth — but the router
 * itself mounts at '/api' (not '/api/manageorders'), so nothing else was covered.
 * `GET /api/manageorders/orders/142552` correctly 401'd, which is exactly why this
 * looked protected. Measured live, with no credentials:
 *
 *   GET  /api/manageorders/customers            200, ~85 KB — every customer with an
 *                                               order in the last 60 days, including
 *                                               ContactEmail and ContactPhone
 *                                               (src/utils/manageorders.js:425-426)
 *   GET  /api/manageorders/payments/142552      200 — a real order's payment records
 *   POST /api/manageorders/inventory-cache-clear reachable — an anonymous cache flush
 *
 * Two things this locks, both of which fail SILENTLY if broken:
 *   1. Express runs mount-path middleware in registration order, so a gate placed
 *      BELOW `app.use('/api', manageOrdersLimiter, manageOrdersRoutes)` never runs.
 *      The gate would read as present and do nothing.
 *   2. Coverage in BOTH directions — a path dropped from the gate silently re-opens
 *      the exposure, and a NEW route added to manageorders.js fails the build until
 *      someone makes an auth decision about it.
 */

const fs = require('fs');
const path = require('path');

const SERVER = fs.readFileSync(path.join(__dirname, '../../server.js'), 'utf8');
const ROUTES = fs.readFileSync(path.join(__dirname, '../../src/routes/manageorders.js'), 'utf8');

// Sub-prefixes that must carry requireCrmApiSecret.
const GATED = [
    '/api/manageorders/orders',
    '/api/manageorders/lineitems',
    '/api/manageorders/tracking',
    '/api/manageorders/auth',
    '/api/manageorders/customers',
    '/api/manageorders/payments',
    '/api/manageorders/order',                    // /order/:extOrderId/snapshot
    '/api/manageorders/cache-info',
    '/api/manageorders/inventory-cache-stats',
    '/api/manageorders/inventory-cache-clear',
];

// Deliberately public, each for a reason recorded next to the gates in server.js.
// Adding to this list is the explicit way to declare "this one stays open".
const INTENTIONALLY_OPEN = [
    '/manageorders/inventorylevels',   // customer-facing laser-tumbler calculator
    '/manageorders/getorderno',        // order-number lookup; ES-module caller, no forwarder yet
    '/manageorders/health',            // health check, no data
];

const mountIndex = SERVER.indexOf("app.use('/api', manageOrdersLimiter, manageOrdersRoutes)");

describe('ManageOrders PII reads are secret-gated', () => {
    test('the router mount is found (this test is meaningless otherwise)', () => {
        expect(mountIndex).toBeGreaterThan(-1);
    });

    test.each(GATED)('%s carries requireCrmApiSecret', (p) => {
        const re = new RegExp(`app\\.use\\('${p.replace(/\//g, '\\/')}',[^)]*requireCrmApiSecret`);
        expect(SERVER).toMatch(re);
    });

    test.each(GATED)('%s is gated ABOVE the router mount, so the gate actually runs', (p) => {
        const at = SERVER.indexOf(`app.use('${p}'`);
        expect(at).toBeGreaterThan(-1);
        expect(at).toBeLessThan(mountIndex);
    });

    // The regression that created this whole class of bug: gating a child prefix and
    // assuming the parent is covered.
    test('the gate list covers /customers and /payments specifically', () => {
        expect(GATED).toContain('/api/manageorders/customers');
        expect(GATED).toContain('/api/manageorders/payments');
    });
});

describe('every route in manageorders.js has an auth decision', () => {
    // Pull the declared paths straight out of the router so a newly added route
    // cannot slip through unnoticed.
    const declared = [...ROUTES.matchAll(/router\.(?:get|post|put|delete)\('(\/manageorders\/[^']*)'/g)]
        .map((m) => m[1]);

    test('the router declares routes (guards against a regex that silently matches nothing)', () => {
        expect(declared.length).toBeGreaterThan(8);
    });

    test.each(declared)('%s is either gated or on the intentionally-open list', (routePath) => {
        const full = '/api' + routePath;
        const gated = GATED.some((g) => full === g || full.startsWith(g + '/'));
        const open = INTENTIONALLY_OPEN.some((o) => routePath === o || routePath.startsWith(o + '/'));
        // If this fails on a route you just added: gate it in server.js, or add it to
        // INTENTIONALLY_OPEN with a comment saying why it is safe to leave public.
        expect(gated || open).toBe(true);
    });
});
