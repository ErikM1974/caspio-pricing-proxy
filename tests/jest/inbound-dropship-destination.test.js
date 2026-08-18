/**
 * The inbound board must tell a drop-ship from an arrival.
 *
 * WHY (2026-08-18). PO 113977 (Inland Beef Company) was drop-shipped straight to the
 * customer at 530 N Priest Rd, Sequim WA, and still appeared on the receiving sheet as
 * freight arriving at 2025 Freeman Rd. SanMar reports the destination on every shipment;
 * we stored only the street, and 83 of 174 recent cartons had even that blank.
 *
 * Three things this locks, each of which failed silently before:
 *   1. ZIP is the key, not the street. Our own address is stored as BOTH
 *      '2025 Freeman Rd' and '2025 FREEMAN RD E' — a street comparison is wrong on our
 *      own data before it ever meets a customer address.
 *   2. A missing destination is 'unknown', NOT 'dropship', and the board keeps showing
 *      those. Hiding a carton because we do not know where it is going is how a real
 *      delivery goes missing; the opposite error only costs a wasted look.
 *   3. The full destination is persisted. The route can only classify what the writer
 *      stored, so the write paths must carry city/state/zip, not just address1.
 */
const fs = require('fs');
const path = require('path');

const SRC = fs.readFileSync(path.join(__dirname, '../../src/routes/sanmar-orders.js'), 'utf8');

// Mirror of the route's classifier, so the RULE is tested rather than the prose.
const OUR_ZIP = '98354';
const OUR_STREET_RE = /2025\s+freeman/i;
function classifyDestination(row) {
    const zip = String(row.Ship_To_Zip || '').trim();
    if (zip) return zip.slice(0, 5) === OUR_ZIP ? 'ours' : 'dropship';
    const addr = String(row.Ship_To_Address || '').trim();
    const city = String(row.Ship_To_City || '').trim();
    if (!addr && !city) return 'unknown';
    if (OUR_STREET_RE.test(addr)) return 'ours';
    if (city && city.toLowerCase() === 'milton') return 'ours';
    return 'dropship';
}

describe('destination classification', () => {
    test('our Milton ZIP is an arrival', () => {
        expect(classifyDestination({ Ship_To_Zip: '98354-8819' })).toBe('ours');
        expect(classifyDestination({ Ship_To_Zip: '98354' })).toBe('ours');
    });

    test('PO 113977 — Sequim — is a drop-ship, the exact regression', () => {
        expect(classifyDestination({
            Ship_To_Address: '530 N Priest Rd', Ship_To_City: 'Sequim',
            Ship_To_State: 'WA', Ship_To_Zip: '98382-3223',
        })).toBe('dropship');
    });

    test('a missing destination is unknown, never dropship', () => {
        // The safe direction: unknown rows stay on the board.
        expect(classifyDestination({})).toBe('unknown');
        expect(classifyDestination({ Ship_To_Zip: '', Ship_To_Address: '', Ship_To_City: '' })).toBe('unknown');
    });

    test('both spellings of our own street fall back to ours when the ZIP is absent', () => {
        // Real stored values — this is why the street cannot be the key.
        expect(classifyDestination({ Ship_To_Address: '2025 Freeman Rd' })).toBe('ours');
        expect(classifyDestination({ Ship_To_Address: '2025 FREEMAN RD E' })).toBe('ours');
    });

    test('ZIP wins over a misleading street', () => {
        // A customer street that happens to contain our words must not beat the ZIP.
        expect(classifyDestination({ Ship_To_Address: '2025 Freeman Rd', Ship_To_Zip: '98119' })).toBe('dropship');
    });

    test('a Seattle drop-ship with only a city still classifies', () => {
        expect(classifyDestination({ Ship_To_Address: 'ATTN JIM RAGSDALE', Ship_To_City: 'SEATTLE' })).toBe('dropship');
    });
});

describe('the route and the writers implement it', () => {
    test('classifyDestination exists and keys on the ZIP', () => {
        expect(SRC).toMatch(/function classifyDestination/);
        expect(SRC).toMatch(/const OUR_ZIP = '98354'/);
    });

    test("an absent destination returns 'unknown', not 'dropship'", () => {
        const fn = SRC.slice(SRC.indexOf('function classifyDestination'), SRC.indexOf("router.get('/inbound-today'"));
        expect(fn).toMatch(/return 'unknown'/);
    });

    test('inbound-today SELECTs the destination columns — it cannot classify what it did not read', () => {
        const block = SRC.slice(SRC.indexOf("router.get('/inbound-today'"), SRC.indexOf("router.get('/label-data/:identifier'"));
        expect(block).toMatch(/Ship_To_Zip/);
        expect(block).toMatch(/dest: classifyDestination\(s\)/);
        expect(block).toMatch(/destination: sh\.dest/);
    });

    test('a PO with ANY carton coming here stays an arrival', () => {
        // A split between our dock and a customer must not hide the box we do receive.
        const block = SRC.slice(SRC.indexOf("router.get('/inbound-today'"), SRC.indexOf("router.get('/label-data/:identifier'"));
        expect(block).toMatch(/if \(c\.dest === 'ours'\) cur\.dest = 'ours'/);
    });

    test('totals.dropship reaches the PAYLOAD, not just the reducer', () => {
        // The payload lists totals keys explicitly instead of spreading, so a new counter
        // is computed and then silently dropped. It shipped that way once: the per-order
        // flag was right while totals.dropship came back undefined.
        const block = SRC.slice(SRC.indexOf("router.get('/inbound-today'"), SRC.indexOf("router.get('/label-data/:identifier'"));
        expect(block).toMatch(/dropship: totals\.dropship/);
    });

    test('BOTH shipment writers persist city/state/zip, not just the street', () => {
        // The route can only classify what the writer stored.
        expect((SRC.match(/Ship_To_Zip: /g) || []).length).toBeGreaterThanOrEqual(2);
        expect((SRC.match(/Ship_To_City: /g) || []).length).toBeGreaterThanOrEqual(2);
    });
});
