/**
 * Quote-plane gate (2026-08-26 lockdown) — behavior + wiring drift-lock.
 *
 * The quote surface (sessions/items/analytics/change-log/sequence/push) is
 * secret-only behind quotePlaneGate, mode-switched by the QUOTE_PLANE_GATE
 * config var (off → log → enforce, flippable without a deploy). This test
 * pins the middleware's semantics AND that server.js actually mounts it on
 * all eight prefixes — "reviewing the gates that exist will never find the
 * one that doesn't" (2026-08-17 review).
 */

const fs = require('fs');
const path = require('path');
const { quotePlaneGate } = require('../../src/middleware');

function run(gate, { mode, secret, headers = {} }) {
    const oldMode = process.env.QUOTE_PLANE_GATE;
    const oldSecret = process.env.CRM_API_SECRET;
    if (mode === undefined) delete process.env.QUOTE_PLANE_GATE;
    else process.env.QUOTE_PLANE_GATE = mode;
    process.env.CRM_API_SECRET = secret;

    const req = { method: 'GET', originalUrl: '/api/quote_sessions', ip: '1.2.3.4', headers };
    let status = null, body = null, nexted = false;
    const res = { status: (s) => { status = s; return res; }, json: (b) => { body = b; return res; } };
    gate(req, res, () => { nexted = true; });

    if (oldMode === undefined) delete process.env.QUOTE_PLANE_GATE;
    else process.env.QUOTE_PLANE_GATE = oldMode;
    if (oldSecret === undefined) delete process.env.CRM_API_SECRET;
    else process.env.CRM_API_SECRET = oldSecret;

    return { status, body, nexted };
}

describe('quotePlaneGate modes', () => {
    test('unset/off mode passes everything (safe to deploy dormant)', () => {
        expect(run(quotePlaneGate, { mode: undefined, secret: 's3cret' }).nexted).toBe(true);
        expect(run(quotePlaneGate, { mode: 'off', secret: 's3cret' }).nexted).toBe(true);
    });

    test('log mode passes but never 401s (observation phase)', () => {
        const r = run(quotePlaneGate, { mode: 'log', secret: 's3cret', headers: {} });
        expect(r.nexted).toBe(true);
        expect(r.status).toBeNull();
    });

    test('enforce mode 401s without the secret', () => {
        const r = run(quotePlaneGate, { mode: 'enforce', secret: 's3cret', headers: {} });
        expect(r.nexted).toBe(false);
        expect(r.status).toBe(401);
    });

    test('enforce mode passes WITH the secret', () => {
        const r = run(quotePlaneGate, {
            mode: 'enforce', secret: 's3cret',
            headers: { 'x-crm-api-secret': 's3cret' },
        });
        expect(r.nexted).toBe(true);
    });

    test('enforce mode 401s a WRONG secret', () => {
        const r = run(quotePlaneGate, {
            mode: 'enforce', secret: 's3cret',
            headers: { 'x-crm-api-secret': 'wrong' },
        });
        expect(r.status).toBe(401);
    });
});

describe('server.js wiring', () => {
    const serverSrc = fs.readFileSync(path.join(__dirname, '..', '..', 'server.js'), 'utf8');
    const PREFIXES = [
        '/api/quote_sessions', '/api/quote_items', '/api/quote_analytics',
        '/api/quote_change_log', '/api/quote-sequence',
        '/api/embroidery-push', '/api/dtf-push', '/api/scp-push',
    ];

    test.each(PREFIXES)('%s is mounted behind the quote-plane gate', (prefix) => {
        const re = new RegExp(`app\\.use\\('${prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}',\\s*quotePlaneGateAllMethods\\)`);
        expect({ prefix, gated: re.test(serverSrc) }).toEqual({ prefix, gated: true });
    });

    test('the gate mounts BEFORE the quotes router (registration order is the access control)', () => {
        const gateIdx = serverSrc.indexOf("app.use('/api/quote_sessions', quotePlaneGateAllMethods)");
        const routerIdx = serverSrc.indexOf("app.use('/api', quotesRoutes)");
        expect(gateIdx).toBeGreaterThan(-1);
        expect(routerIdx).toBeGreaterThan(-1);
        expect(gateIdx).toBeLessThan(routerIdx);
    });
});
