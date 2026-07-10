/**
 * Unit tests for the DTF push transformer — first coverage for this transformer
 * (SCP and EMB were already jest-locked; DTF was not).
 *
 * Pins the 2026-06-11 audit fixes:
 *   1. The Notes On Order tax block passes SHIPPING into buildSalesTaxNote, so
 *      "Total with Tax" matches the builder's grand total and the note's own
 *      figures reconcile (TaxAmount is computed on the shipping-INCLUSIVE base
 *      by dtf-quote-service since 2026-06-08).
 *   2. A "Notes To Accounting" verification note is emitted (EMB parity,
 *      Erik 2026-06-07 — for Bradley).
 *   3. Garment line Color prefers ColorCode (CATALOG_COLOR), falling back to
 *      Color (display name) only for legacy rows.
 *
 * Pure-function tests: no Caspio, no network.
 */
const { transformQuoteToOrder } = require('../../lib/dtf-push-transformer');
const { NOTE_TYPES } = require('../../config/manageorders-push-config');

const VALID_NOTE_TYPES = Object.values(NOTE_TYPES);

/** Base DTF session as dtf-quote-service persists it.
 *  SubtotalAmount EXCLUDES shipping; TaxAmount is on the shipping-inclusive base.
 *  TaxRate is stored as a PERCENT (10.1). */
function baseSession(overrides = {}) {
  return {
    PK_ID: 1, QuoteID: 'DTF0611-1',
    CustomerName: 'Brad Wright', CustomerNumber: '12345',
    CustomerEmail: 'brad@acme.com', CompanyName: 'Acme Co',
    Phone: '2535551212', SalesRepEmail: 'sales@nwcustomapparel.com',
    TaxRate: 10.1, TaxAmount: 53.53, ShipToState: 'WA', ShipMethod: 'UPS Ground',
    SubtotalAmount: 500, TotalAmount: 500, LTMFeeTotal: 0,
    ArtCharge: 0, GraphicDesignCharge: 0, GraphicDesignHours: 0, RushFee: 0,
    Discount: 0, ShippingFee: 30, LTM_Display_Mode: 'builtin',
    Notes: JSON.stringify({ locations: ['left-chest', 'full-back'], projectName: 'Crew Tees' }),
    ...overrides,
  };
}

function garment(overrides = {}) {
  return {
    EmbellishmentType: 'dtf', StyleNumber: 'ST350',
    ProductName: 'Sport-Tek PosiCharge Competitor Tee - Brilliant Orange',
    Color: 'Brilliant Orange', ColorCode: 'BrillOrng',
    Quantity: 18, SizeBreakdown: JSON.stringify({ M: 6, L: 6, XL: 6 }),
    FinalUnitPrice: 39.5, LineTotal: 711,
    ...overrides,
  };
}

function notesOfType(order, type) {
  return order.Notes.filter((n) => n.Type === type).map((n) => n.Note);
}

describe('DTF push transformer — tax note reconciles with the quoted total', () => {
  test('shipped WA order: note includes shipping, taxable base, and the true total', () => {
    const order = transformQuoteToOrder(baseSession(), [garment()], { isTest: false });
    const orderNotes = notesOfType(order, NOTE_TYPES.ORDER).join('\n');

    expect(orderNotes).toContain('Subtotal: $500.00');
    expect(orderNotes).toContain('Shipping: $30.00');
    expect(orderNotes).toContain('Taxable: $530.00 (subtotal + shipping)');
    expect(orderNotes).toContain('Tax Amount: $53.53');
    // 500 + 30 + 53.53 — the builder's grand total, not the old $553.53
    expect(orderNotes).toContain('Total with Tax: $583.53');
  });

  test('accounting cross-check note exists and carries the same figures', () => {
    const order = transformQuoteToOrder(baseSession(), [garment()], { isTest: false });
    const acct = notesOfType(order, NOTE_TYPES.ACCOUNTING);
    expect(acct.length).toBeGreaterThanOrEqual(1);
    const note = acct.join('\n');
    expect(note).toContain('SALES TAX');
    expect(note).toContain('Taxable: $530.00');
  });

  test('pickup order (no shipping) keeps the unshipped figures', () => {
    const session = baseSession({
      ShippingFee: 0, ShipMethod: 'Customer Pickup', TaxAmount: 50.5,
    });
    const order = transformQuoteToOrder(session, [garment()], { isTest: false });
    const orderNotes = notesOfType(order, NOTE_TYPES.ORDER).join('\n');
    expect(orderNotes).toContain('Subtotal: $500.00');
    expect(orderNotes).not.toContain('Shipping: $');
    expect(orderNotes).toContain('Total with Tax: $550.50');
  });

  test('every note uses a valid ManageOrders note type', () => {
    const order = transformQuoteToOrder(baseSession(), [garment()], { isTest: false });
    for (const n of order.Notes) {
      expect(VALID_NOTE_TYPES).toContain(n.Type);
    }
  });
});

describe('DTF push transformer — garment lines', () => {
  test('Color prefers ColorCode (CATALOG_COLOR), never the display name', () => {
    const order = transformQuoteToOrder(baseSession(), [garment()], { isTest: false });
    const garmentLines = order.LinesOE.filter((l) => l.PartNumber === 'ST350');
    expect(garmentLines.length).toBeGreaterThan(0);
    for (const line of garmentLines) {
      expect(line.Color).toBe('BrillOrng');
    }
  });

  test('legacy item without ColorCode falls back to display Color', () => {
    const order = transformQuoteToOrder(
      baseSession(), [garment({ ColorCode: '' })], { isTest: false });
    const garmentLines = order.LinesOE.filter((l) => l.PartNumber === 'ST350');
    for (const line of garmentLines) {
      expect(line.Color).toBe('Brilliant Orange');
    }
  });

  test('pre-tax order total foots: lines + shipping = quoted pre-tax all-in', () => {
    const order = transformQuoteToOrder(baseSession(), [garment()], { isTest: false });
    const lineSum = order.LinesOE.reduce((s, l) => s + l.Price * l.Qty, 0);
    const total = Math.round((lineSum + (order.cur_Shipping || 0)) * 100) / 100;
    expect(total).toBe(741); // 18 × $39.50 + $30 shipping
  });

  test('order/design routing: DTF order type 18 (Transfers, rev acct 4005)', () => {
    const order = transformQuoteToOrder(baseSession(), [garment()], { isTest: false });
    expect(order.id_OrderType).toBe(18);
  });
});

describe('DTF push transformer — Swagger field enrichment (2026-07-10)', () => {
  test('location Notes carry the priced transfer size from Notes.transferBreakdown', () => {
    const session = baseSession({
      Notes: JSON.stringify({
        newDesignName: 'Team Art',
        transferBreakdown: [
          { location: 'full-front', locationName: 'Full Front', size: 'large', sizeName: 'Large (12" x 16.5")' },
          { location: 'left-chest', locationName: 'Left Chest', size: 'small', sizeName: 'Small (5" x 5")' },
        ],
        referenceArtwork: [
          { hostedUrl: 'https://example.com/big.png', placement: 'Full Front', fileName: 'big.png' },
          { hostedUrl: 'https://example.com/odd.png', placement: 'Sleeve', fileName: 'odd.png' },
        ],
      }),
    });
    const order = transformQuoteToOrder(session, [garment()], { isTest: true });
    const [big, odd] = order.Designs[0].Locations;
    expect(big.Notes).toBe('big.png · Large (12" x 16.5") transfer');
    expect(odd.Notes).toBe('odd.png'); // no breakdown match → filename only, as before
    // ForProductColor follows the SAME CATALOG_COLOR contract as LinesOE.Color
    // (MANAGEORDERS_COMPLETE_REFERENCE §Designs, proven on OF-0025).
    expect(order.Designs[0].ForProductColor).toBe('BrillOrng');
    expect(order.LinesOE[0].Color).toBe('BrillOrng');
  });
});
