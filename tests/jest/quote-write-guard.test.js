/**
 * quote-write-guard — pricing-app roadmap 1.5 lock.
 *
 * The write boundary for quote_sessions/quote_items: real builder payloads
 * pass untouched; unknown fields, PK_ID smuggling, megabyte notes, and
 * non-numeric money are rejected 400 BEFORE Caspio sees them.
 */

const { validateQuoteWrite } = require('../../src/utils/quote-write-guard');

// Shape-accurate EMB save payload (embroidery-quote-service.js sessionData).
const REAL_SESSION = {
    QuoteID: 'EMB-2026-777',
    SessionID: 'emb_sess_1751990000000',
    Status: 'Open',
    CustomerName: 'E2E Test',
    CustomerEmail: 'rep@nwcustomapparel.com',
    CompanyName: 'Port & Co Test',
    Phone: '(253) 922-5793',
    TotalQuantity: 24,
    SubtotalAmount: 442.5,
    LTMFeeTotal: 0,
    TotalAmount: 487.66,
    TaxRate: 10.2,
    TaxAmount: 45.16,
    Notes: JSON.stringify({ logos: [{ position: 'Left Chest', stitches: 8000 }] }),
    ExpiresAt: '2026-08-07T00:00:00',
    SalesRepEmail: 'sales@nwcustomapparel.com',
};

const REAL_ITEM = {
    QuoteID: 'EMB-2026-777',
    LineNumber: 1,
    StyleNumber: 'PC54',
    ProductName: 'Port & Co Core Cotton Tee',
    Color: 'Candy Pink',
    ColorCode: 'CandyPink',
    Quantity: 24,
    FinalUnitPrice: 18.44,
    LineTotal: 442.56,
    SizeBreakdown: JSON.stringify({ M: 24 }),
    PricingTier: '24-47',
    EmbellishmentType: 'embroidery',
    HasLTM: 'No',
};

describe('legit payloads pass', () => {
    test('real EMB session shape', () => {
        expect(validateQuoteWrite('quote_sessions', REAL_SESSION)).toEqual({ ok: true });
    });
    test('real EMB item shape', () => {
        expect(validateQuoteWrite('quote_items', REAL_ITEM)).toEqual({ ok: true });
    });
    test('numeric fields as numeric STRINGS pass (legacy callers send both)', () => {
        expect(validateQuoteWrite('quote_sessions', { ...REAL_SESSION, TotalAmount: '487.66' })).toEqual({ ok: true });
    });
    test('null / empty-string numerics pass (Caspio-blankable)', () => {
        expect(validateQuoteWrite('quote_sessions', { ...REAL_SESSION, TaxAmount: null, LTMFeeTotal: '' })).toEqual({ ok: true });
    });
});

describe('rejections (the 1.5 done-when list)', () => {
    test('unknown/extra field → 400 naming it', () => {
        const v = validateQuoteWrite('quote_sessions', { ...REAL_SESSION, DropTable: 'x' });
        expect(v.ok).toBe(false);
        expect(v.status).toBe(400);
        expect(v.error).toContain('DropTable');
    });

    test('PK_ID smuggling → 400 (Caspio-managed)', () => {
        const v = validateQuoteWrite('quote_sessions', { ...REAL_SESSION, PK_ID: 1 });
        expect(v.ok).toBe(false);
        expect(v.error).toContain('PK_ID');
    });

    test('a ~1MB Notes field → 400, not persisted', () => {
        const v = validateQuoteWrite('quote_sessions', { ...REAL_SESSION, Notes: 'x'.repeat(1024 * 1024) });
        expect(v.ok).toBe(false);
        expect(v.error).toMatch(/Notes exceeds 60000/);
    });

    test('oversize SHORT field (CustomerName 5k) → 400', () => {
        const v = validateQuoteWrite('quote_sessions', { ...REAL_SESSION, CustomerName: 'x'.repeat(5000) });
        expect(v.ok).toBe(false);
        expect(v.error).toMatch(/CustomerName exceeds 2000/);
    });

    test('non-numeric money → 400', () => {
        const v = validateQuoteWrite('quote_sessions', { ...REAL_SESSION, TotalAmount: '12.5abc' });
        expect(v.ok).toBe(false);
        expect(v.error).toContain('TotalAmount');
        const v2 = validateQuoteWrite('quote_items', { ...REAL_ITEM, Quantity: {} });
        expect(v2.ok).toBe(false);
    });

    test('non-object bodies → 400', () => {
        expect(validateQuoteWrite('quote_sessions', [1, 2]).ok).toBe(false);
        expect(validateQuoteWrite('quote_sessions', null).ok).toBe(false);
        expect(validateQuoteWrite('quote_sessions', 'QuoteID=X').ok).toBe(false);
    });

    test('string fields (OrderNumber etc.) are NOT numeric-checked', () => {
        expect(validateQuoteWrite('quote_sessions', { ...REAL_SESSION, PurchaseOrderNumber: 'PO-2026-ABC' })).toEqual({ ok: true });
        expect(validateQuoteWrite('quote_sessions', { ...REAL_SESSION, TrackingNumber: '1Z999AA10123456784' })).toEqual({ ok: true });
    });
});
