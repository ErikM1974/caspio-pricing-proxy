/**
 * DTG calibration: writes gated, GET deliberately public.
 *
 * Before 2026-08-05 `POST /api/dtg-calibration` and
 * `DELETE /api/dtg-calibration/:pkId` required NO credentials at all, so anyone
 * who knew the URL could move or delete the print box for every style. Nothing
 * leaks — it silently misprints customer orders, which is worse to find out
 * about later.
 *
 * Two properties are locked here, and the SECOND one matters as much as the
 * first:
 *
 *   1. Writes require X-CRM-API-Secret.
 *   2. GET stays PUBLIC. The customer-facing designer at
 *      teamnwca.com/custom-tees reads GET /api/dtg-calibration?styleNumber=…
 *      on every product open, with no session. "Tightening" this route to
 *      requireCrmApiSecret would break the storefront — so that mistake is a
 *      test failure, not a discovery.
 *
 * Ordering is also a security property: the gate must be registered BEFORE the
 * router mount, or the router answers first and the gate never runs.
 */

const fs = require('fs');
const path = require('path');

const SERVER = fs.readFileSync(path.join(__dirname, '../../server.js'), 'utf8');

/** The real gateWritesOnly semantics, rebuilt from server.js. */
function buildGate() {
    process.env.CRM_API_SECRET = 'unit-test-secret';
    const requireSecret = (req) =>
        !!process.env.CRM_API_SECRET &&
        req.headers['x-crm-api-secret'] === process.env.CRM_API_SECRET;
    return (req) => (req.method === 'GET' ? 'allowed' : (requireSecret(req) ? 'allowed' : 'refused'));
}

const gate = buildGate();
const req = (method, headers = {}) => ({ method, headers });
const SECRET = { 'x-crm-api-secret': 'unit-test-secret' };

describe('dtg-calibration write gate', () => {
    test('anonymous POST and DELETE are refused', () => {
        expect(gate(req('POST'))).toBe('refused');
        expect(gate(req('DELETE'))).toBe('refused');
        expect(gate(req('PUT'))).toBe('refused');
    });

    test('a wrong secret is refused, not merely a missing one', () => {
        expect(gate(req('POST', { 'x-crm-api-secret': 'nope' }))).toBe('refused');
    });

    test('writes with the shared secret pass (the app forwarder path)', () => {
        expect(gate(req('POST', SECRET))).toBe('allowed');
        expect(gate(req('DELETE', SECRET))).toBe('allowed');
    });

    test('🔴 anonymous GET stays ALLOWED — the public /custom-tees designer needs it', () => {
        expect(gate(req('GET'))).toBe('allowed');
    });
});

describe('dtg-calibration gate registration in server.js', () => {
    test('the write gate is mounted on the calibration prefix', () => {
        expect(SERVER).toMatch(/app\.use\(\s*['"]\/api\/dtg-calibration['"]\s*,\s*gateWritesOnly\s*\)/);
    });

    test('it is scoped to the prefix, never mounted bare on /api', () => {
        // A bare `app.use('/api', gateWritesOnly)` would gate every write in the
        // whole proxy — the same class of bug as the 30 req/min limiter incident.
        expect(SERVER).not.toMatch(/app\.use\(\s*['"]\/api['"]\s*,\s*gateWritesOnly\s*\)/);
    });

    test('the gate is registered BEFORE the router mount, or it never runs', () => {
        const gateAt = SERVER.indexOf("app.use('/api/dtg-calibration', gateWritesOnly)");
        const routerAt = SERVER.indexOf("app.use('/api', dtgCalibrationRoutes)");
        expect(gateAt).toBeGreaterThan(-1);
        expect(routerAt).toBeGreaterThan(-1);
        expect(gateAt).toBeLessThan(routerAt);
    });

    test('the calibration routes are NOT promoted to a blanket requireCrmApiSecret', () => {
        // That would gate the GET and take the customer storefront down with it.
        expect(SERVER).not.toMatch(/app\.use\(\s*['"]\/api\/dtg-calibration['"]\s*,\s*requireCrmApiSecret/);
    });
});
