/**
 * The "past due" rule in buildDueDates(), and the company-wide branch beside it.
 *
 * WHY (2026-08-10)
 * The card in AE Mission Control headed "🔴 Past due — not shipped" dropped an order
 * only when sts_Shipped === 1. It SELECTed sts_Invoiced and reported it on every item,
 * but never filtered on it — so orders that were finished and billed kept showing as
 * late. Measured against live ORDER_ODBC on the day of the fix:
 *
 *     Nika Lao         42 late, 29 already invoiced   -> 69% wrong
 *     Taneisha Clark   34 late, 12 already invoiced   -> 35% wrong
 *     Ruthie Nhoung     3 late,  2 already invoiced   -> 67% wrong
 *
 * After: 13 / 22 / 1. Nika had been reading a list where two thirds of the entries were
 * done — which is how a report stops being read.
 *
 * No production status is consulted. produced ⊆ invoiced in every measured case
 * (29/29, 12/12, 2/2), consistent with produced orders being 99% invoiced, so
 * ORDER_ODBC alone decides it and the report stays single-source — no join to the
 * once-a-day ManageOrders mirror and no staleness to reason about.
 */

const fs = require('fs');
const path = require('path');

const SRC = fs.readFileSync(path.join(__dirname, '../../src/routes/ae-dashboard.js'), 'utf8');
const FN = SRC.slice(SRC.indexOf('async function buildDueDates'), SRC.indexOf("router.get('/due-dates-all'"));

// Mirror of the route's candidate filter, so the RULE is tested and not the prose.
function isStillOpen(o) {
    if (parseInt(o.sts_Shipped, 10) === 1) return false;
    if (parseInt(o.sts_Invoiced, 10) === 1) return false;
    return true;
}

describe('past due means unshipped AND uninvoiced', () => {
    test('an invoiced-but-unshipped order is NOT late — the exact 69% regression', () => {
        expect(isStillOpen({ sts_Shipped: 0, sts_Invoiced: 1 })).toBe(false);
    });

    test('a shipped order is not late', () => {
        expect(isStillOpen({ sts_Shipped: 1, sts_Invoiced: 0 })).toBe(false);
    });

    test('neither shipped nor invoiced IS late', () => {
        expect(isStillOpen({ sts_Shipped: 0, sts_Invoiced: 0 })).toBe(true);
    });

    test('flags arriving as strings still count (Caspio returns them as text)', () => {
        expect(isStillOpen({ sts_Shipped: '0', sts_Invoiced: '1' })).toBe(false);
        expect(isStillOpen({ sts_Shipped: '1', sts_Invoiced: '0' })).toBe(false);
        expect(isStillOpen({ sts_Shipped: '0', sts_Invoiced: '0' })).toBe(true);
    });

    test('the route implements it — both exclusions present', () => {
        expect(FN).toMatch(/parseInt\(o\.sts_Shipped, 10\) === 1\) continue/);
        expect(FN).toMatch(/parseInt\(o\.sts_Invoiced, 10\) === 1\) continue/);
    });

    test('sts_Invoiced is still SELECTed — filtering on an unselected column is silent', () => {
        expect(FN).toMatch(/q\.select'[^\n]*sts_Invoiced/);
    });
});

describe('one code path serves both a rep and the whole shop', () => {
    test('buildDueDates takes rep + lookbackDays', () => {
        expect(FN).toMatch(/async function buildDueDates\(rep, lookbackDays\)/);
    });

    test('rep = null drops the CustomerServiceRep clause rather than filtering to nobody', () => {
        expect(FN).toMatch(/const repClause = rep \?/);
        expect(FN).toMatch(/\$\{repClause\}date_OrderRequestedToShip/);
    });

    test('the rep name rides on every item, so ownership never has to be inferred', () => {
        expect(FN).toMatch(/rep: String\(o\.CustomerServiceRep \|\| ''\)/);
        expect(FN).toMatch(/q\.select'[^\n]*CustomerServiceRep/);
    });

    test('company-wide raises the page cap AND uses strict, so it cannot truncate silently', () => {
        // Every rep at once, and ORDER_ODBC repeats a row per design block. A quietly
        // capped past-due list is worse than no list.
        expect(FN).toMatch(/maxPages: 16, strict: true/);
    });

    test('company-wide is not truncated to DUE_LIMIT — that cap is for the card', () => {
        expect(FN).toMatch(/const limit = rep \? DUE_LIMIT :/);
    });

    test('the lookback window is bounded, not free-form', () => {
        expect(FN).toMatch(/Math\.min\(Math\.max\(parseInt\(lookbackDays, 10\)[^)]*\)[^)]*180\)/);
    });
});

describe('cache keys and registry', () => {
    test('the per-rep cache is keyed on the window too', () => {
        // Otherwise a ?days=30 call is served a cached 60-day payload, or poisons the
        // card's cache with a shorter list.
        expect(SRC).toMatch(/const key = `\$\{email\}:\$\{days\}`/);
        expect(SRC).toMatch(/const key = `__all__:\$\{days\}`/);
    });

    test('Ruth is registered, and spelled the way ORDER_ODBC spells her', () => {
        // Three spellings exist in this codebase: 'Ruthie Nhoung', 'Ruth Nhong',
        // 'Ruth Nhoung'. ORDER_ODBC holds 'Ruthie Nhoung' (190 orders under it, 0 under
        // the others, verified live). fullName is a string join — a near-miss returns an
        // empty list, not an error. Her inbox is ruth@; ruthie@ is not a real account.
        expect(SRC).toMatch(/'ruth@nwcustomapparel\.com':\s*\{\s*fullName:\s*'Ruthie Nhoung'/);
    });
});

describe('sts_Shipped is not a boolean', () => {
    // Erik, 2026-08-18: 0.5 means PARTIALLY shipped. Measured over 90 days —
    // 1 = 808, 0 = 212, 0.5 = 18, 8 = 13, 222 = 4 (a typo nobody had caught).
    // A partial belongs on the list, because the remainder really is late; it just
    // must not read as though nothing shipped. Two were on the live list when this
    // was written: WO 142207 (In Graphic Detail) and WO 142649 (New Dimension Lawn).
    test('a partial is still open — it is not filtered out', () => {
        expect(isStillOpen({ sts_Shipped: '0.5', sts_Invoiced: 0 })).toBe(true);
    });

    test('but it is flagged, so the sheet can say so', () => {
        expect(FN).toMatch(/partiallyShipped: String\(o\.sts_Shipped\)\.trim\(\) === '0\.5'/);
        expect(FN).toMatch(/PARTIALLY SHIPPED/);
    });

    test('only an exact 1 counts as shipped — 0.5, 8 and 222 must not', () => {
        for (const v of ['0.5', '8', '222', '0']) {
            expect(isStillOpen({ sts_Shipped: v, sts_Invoiced: 0 })).toBe(true);
        }
        expect(isStillOpen({ sts_Shipped: '1', sts_Invoiced: 0 })).toBe(false);
    });
});
