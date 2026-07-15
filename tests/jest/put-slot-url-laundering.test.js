/**
 * Lock: BOTH generic PUT routes that can write Box mockup-slot URLs must
 * launder them through resolveToProxyUrl before the Caspio write.
 *
 * History: the chokepoint was added to PUT /api/mockups/:id (Ruth) on
 * 2026-05-06 but MISSED on PUT /api/artrequests/:id (Steve) — so the
 * art-request detail page's Box picker kept saving raw
 * box.com/shared/static/{token} links for two more months (found by the
 * 2026-07-07 broken-mockups audit). These are source-level assertions in the
 * style of the push-button-binding locks: they fail if someone removes the
 * laundering loop or reverts the route to writing req.body verbatim.
 */
const fs = require('fs');
const path = require('path');

const read = (p) => fs.readFileSync(path.join(__dirname, '..', '..', p), 'utf8');

describe('PUT slot-URL laundering chokepoints (box-url-rules.md golden rule)', () => {
    describe('art.js — PUT /api/artrequests/:id (Steve/ArtRequests)', () => {
        const src = read('src/routes/art.js');

        test('imports resolveToProxyUrl and the canonical slot-field list', () => {
            expect(src).toMatch(/require\(['"]\.\.\/utils\/box-client['"]\)/);
            expect(src).toMatch(/VALID_SLOT_FIELDS\s*}?\s*=\s*require\(['"]\.\.\/utils\/recover-broken-mockup['"]\)/);
        });

        test('PUT handler launders every slot field before the Caspio write', () => {
            const putStart = src.indexOf("router.put('/artrequests/:id'");
            expect(putStart).toBeGreaterThan(-1);
            const handler = src.slice(putStart, putStart + 3500);
            expect(handler).toMatch(/for\s*\(const slotField of VALID_SLOT_FIELDS\)/);
            expect(handler).toMatch(/await resolveToProxyUrl\(/);
        });

        test('PUT handler sends the laundered copy, not raw req.body', () => {
            const putStart = src.indexOf("router.put('/artrequests/:id'");
            const handler = src.slice(putStart, putStart + 3500);
            // the laundered object is spread from req.body once...
            expect(handler).toMatch(/const data = \{ \.\.\.req\.body \}/);
            // ...and the axios config must use it — never `data: req.body`
            expect(handler).toMatch(/data:\s*data/);
            expect(handler).not.toMatch(/data:\s*req\.body/);
        });
    });

    describe('mockup-routes.js — PUT /api/mockups/:id (Ruth/Digitizing_Mockups)', () => {
        const src = read('src/routes/mockup-routes.js');

        test('PUT handler launders every Ruth slot field before the Caspio write', () => {
            const putStart = src.indexOf("router.put('/mockups/:id'");
            expect(putStart).toBeGreaterThan(-1);
            const handler = src.slice(putStart, putStart + 3500);
            expect(handler).toMatch(/for\s*\(const slotField of RUTH_MOCKUP_SLOT_FIELDS\)/);
            expect(handler).toMatch(/await resolveToProxyUrl\(/);
        });
    });
});
