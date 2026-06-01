/**
 * Unit tests for the SCP (Screen Print) push transformer.
 *
 * Pins the invariant that matters most: the pushed ShopWorks order total must
 * equal the customer's quoted pre-tax total. The SCP quote-service stores setup,
 * LTM, art, graphic-design and rush as SESSION fields (not as quote_items fee
 * rows like EMB), so the transformer rebuilds them — these tests guard against a
 * regression that would silently under-bill.
 *
 * Pure-function tests: no Caspio, no network.
 */
const {
  transformQuoteToOrder,
  buildFeeLines,
} = require('../../lib/scp-push-transformer');
const { NOTE_TYPES } = require('../../config/manageorders-push-config');

const VALID_NOTE_TYPES = Object.values(NOTE_TYPES);

/** pre-tax order total the way OnSite sums it: line items + shipping − discounts */
function orderPreTaxTotal(order) {
  const lineSum = order.LinesOE.reduce((s, l) => s + l.Price * l.Qty, 0);
  return Math.round((lineSum + (order.cur_Shipping || 0) - (order.TotalDiscounts || 0)) * 100) / 100;
}

function lineByPart(order, pn) {
  return order.LinesOE.filter((l) => l.PartNumber === pn);
}

/** Base SCP session as the quote-service persists it (TaxRate as a PERCENT). */
function baseSession(overrides = {}) {
  return {
    PK_ID: 1, QuoteID: 'SPC-0101-1',
    CustomerName: 'Jane Smith', CustomerNumber: '12345', CustomerEmail: 'jane@acme.com',
    CompanyName: 'Acme Co', Phone: '2535551212', SalesRepEmail: 'erik@nwcustomapparel.com',
    TaxRate: 10.1, ShipToState: 'WA',
    SubtotalAmount: 600, LTMFeeTotal: 0,
    ArtCharge: 0, GraphicDesignCharge: 0, GraphicDesignHours: 0, RushFee: 0,
    Discount: 0, ShippingFee: 0, LTM_Display_Mode: 'builtin',
    Notes: JSON.stringify({
      frontLocation: 'FF', frontColors: 2, backLocation: '', backColors: 0,
      isDarkGarment: true, hasSafetyStripes: false, setupFeeTotal: 90,
    }),
    ...overrides,
  };
}

function garment(overrides = {}) {
  return {
    EmbellishmentType: 'screenprint', StyleNumber: 'PC54',
    ProductName: 'Port & Company Core Cotton Tee', Color: 'Navy', ColorCode: 'Navy',
    Quantity: 60, SizeBreakdown: JSON.stringify({ S: 12, M: 12, L: 12, XL: 12, XXL: 12 }),
    FinalUnitPrice: 10, LineTotal: 600,
    ...overrides,
  };
}

describe('SCP push transformer — order total integrity', () => {
  test('A: setup + art + rush are itemized; total equals the quote (no LTM)', () => {
    const session = baseSession({ ArtCharge: 50, RushFee: 25 });
    const order = transformQuoteToOrder(session, [garment()], { isTest: true });

    // garments 600 + setup 90 + art 50 + rush 25 = 765
    expect(orderPreTaxTotal(order)).toBe(765);

    expect(lineByPart(order, 'SPSU')).toHaveLength(1);
    expect(lineByPart(order, 'SPSU')[0]).toMatchObject({ Qty: 3, Price: 30 }); // 2 ink + 1 dark underbase
    expect(lineByPart(order, 'Art')).toHaveLength(1);
    expect(lineByPart(order, 'Art')[0].Price).toBe(50);
    expect(lineByPart(order, 'RUSH')).toHaveLength(1);
    expect(lineByPart(order, 'RUSH')[0].Price).toBe(25);
  });

  test('B: builtin LTM is NOT re-added (already in garment price); setup still added', () => {
    const session = baseSession({
      LTMFeeTotal: 75, LTM_Display_Mode: 'builtin', SubtotalAmount: 171,
      Notes: JSON.stringify({ frontLocation: 'LC', frontColors: 1, isDarkGarment: false, setupFeeTotal: 30 }),
    });
    const items = [garment({ Quantity: 12, FinalUnitPrice: 14.25, LineTotal: 171,
      SizeBreakdown: JSON.stringify({ S: 4, M: 4, L: 4 }) })];
    const order = transformQuoteToOrder(session, items, { isTest: true });

    // garments 171 (LTM baked in) + setup 30 = 201; NO separate LTM line
    expect(orderPreTaxTotal(order)).toBe(201);
    expect(lineByPart(order, 'LTM')).toHaveLength(0);
    expect(lineByPart(order, 'SPSU')[0]).toMatchObject({ Qty: 1, Price: 30 });
  });

  test('C: separate-mode LTM IS added as its own line', () => {
    const session = baseSession({
      LTMFeeTotal: 75, LTM_Display_Mode: 'separate', SubtotalAmount: 96,
      Notes: JSON.stringify({ frontLocation: 'LC', frontColors: 1, isDarkGarment: false, setupFeeTotal: 30 }),
    });
    const items = [garment({ Quantity: 12, FinalUnitPrice: 8, LineTotal: 96,
      SizeBreakdown: JSON.stringify({ S: 4, M: 4, L: 4 }) })];
    const order = transformQuoteToOrder(session, items, { isTest: true });

    // garments 96 + setup 30 + LTM 75 = 201
    expect(orderPreTaxTotal(order)).toBe(201);
    expect(lineByPart(order, 'LTM')).toHaveLength(1);
    expect(lineByPart(order, 'LTM')[0].Price).toBe(75);
  });

  test('graphic design ($75/hr) is itemized at the full charge', () => {
    const session = baseSession({ GraphicDesignCharge: 150, GraphicDesignHours: 2 });
    const order = transformQuoteToOrder(session, [garment()], { isTest: true });
    const gd = lineByPart(order, 'GRT-75');
    expect(gd).toHaveLength(1);
    expect(gd[0].Price).toBe(150);
    expect(gd[0].Description).toMatch(/2 hr/);
    expect(orderPreTaxTotal(order)).toBe(600 + 90 + 150);
  });

  test('shipping and discount come through as order-level fields', () => {
    const session = baseSession({ ShippingFee: 30, Discount: 40 });
    const order = transformQuoteToOrder(session, [garment()], { isTest: true });
    expect(order.cur_Shipping).toBe(30);
    expect(order.TotalDiscounts).toBe(40);
    // garments 600 + setup 90 + shipping 30 − discount 40 = 680
    expect(orderPreTaxTotal(order)).toBe(680);
  });

  test('setup screens derive from colors when Notes lacks setupFeeTotal (older quotes)', () => {
    const session = baseSession({
      Notes: JSON.stringify({ frontColors: 3, backColors: 2, isDarkGarment: true }), // no setupFeeTotal
    });
    const order = transformQuoteToOrder(session, [garment()], { isTest: true });
    // 3 + 2 ink + 2 underbase (one per printed location) = 7 screens
    expect(lineByPart(order, 'SPSU')[0]).toMatchObject({ Qty: 7, Price: 30 });
  });
});

describe('SCP push transformer — notes & tax', () => {
  test('order-level notes use the API-recognized `Notes` key, not `NotesOnOrders`', () => {
    // ManageOrders /onsite/order-push reads order notes under `Notes` (see
    // manageorders-push-client.js:241 + the EMB transformer). A `NotesOnOrders`
    // key is silently dropped — this guard stops it from regressing.
    const order = transformQuoteToOrder(baseSession(), [garment()], { isTest: true });
    expect(Array.isArray(order.Notes)).toBe(true);
    expect(order.NotesOnOrders).toBeUndefined();
  });

  test('every note carries a valid OnSite note Type (no undefined .Order typos)', () => {
    const session = baseSession({ ArtCharge: 50 });
    const order = transformQuoteToOrder(session, [garment()], { isTest: true });
    expect(order.Notes.length).toBeGreaterThan(0);
    order.Notes.forEach((n) => {
      expect(VALID_NOTE_TYPES).toContain(n.Type);
    });
  });

  test('tax note shows the rate as a real percentage (TaxRate stored as 10.1, not 1010%)', () => {
    const session = baseSession();
    const order = transformQuoteToOrder(session, [garment()], { isTest: true });
    const taxNote = order.Notes.find((n) => /Sales tax/.test(n.Note));
    expect(taxNote).toBeTruthy();
    expect(taxNote.Note).toMatch(/10\.10%/);
    expect(taxNote.Note).not.toMatch(/1010/);
  });

  test('a decimal TaxRate (0.101) is also handled correctly', () => {
    const order = transformQuoteToOrder(baseSession({ TaxRate: 0.101 }), [garment()], { isTest: true });
    const taxNote = order.Notes.find((n) => /Sales tax/.test(n.Note));
    expect(taxNote.Note).toMatch(/10\.10%/);
  });

  test('no fee lines emitted when there are no fees and setup is zero', () => {
    const session = baseSession({ Notes: JSON.stringify({ frontColors: 0, isDarkGarment: false, setupFeeTotal: 0 }) });
    const feeLines = buildFeeLines(session, 'G-1');
    expect(feeLines).toHaveLength(0);
  });

  test('order carries the verified Screen Print order type 13 (not embroidery 21)', () => {
    const order = transformQuoteToOrder(baseSession(), [garment()], { isTest: true });
    expect(order.id_OrderType).toBe(13);
  });
});

describe('SCP push transformer — shipping address', () => {
  test('ship-to populates the OnSite ShipAddress01/ShipCity fields from ShipToAddress columns', () => {
    const session = baseSession({
      ShipToAddress: '2025 Freeman Rd E', ShipToCity: 'Milton',
      ShipToState: 'WA', ShipToZip: '98354', ShipMethod: 'UPS Ground',
    });
    const order = transformQuoteToOrder(session, [garment()], { isTest: true });
    const ship = order.ShippingAddresses[0];

    // Correct API schema (NOT the old Address/City/State/Zip keys)
    expect(ship.ShipAddress01).toBe('2025 Freeman Rd E');
    expect(ship.ShipCity).toBe('Milton');
    expect(ship.ShipState).toBe('WA');
    expect(ship.ShipZip).toBe('98354');
    expect(ship.ShipMethod).toBe('UPS Ground');
    expect(ship.ShipCompany).toBe('Acme Co');
    expect(ship.ExtShipID).toBe('SHIP-1');
    // Old broken keys must be gone
    expect(ship.Address).toBeUndefined();
    expect(ship.City).toBeUndefined();
  });

  test('no address → Customer Pickup with blank address fields (no crash)', () => {
    const order = transformQuoteToOrder(baseSession(), [garment()], { isTest: true });
    const ship = order.ShippingAddresses[0];
    expect(ship.ShipMethod).toBe('Customer Pickup');
    expect(ship.ShipAddress01).toBe('');
    expect(ship.ShipCity).toBe('');
  });
});

describe('SCP push transformer — design attachment', () => {
  test('new design with uploaded artwork uses DesignName (not `name`) so it lands in SW', () => {
    // ManageOrders reads the design name under `DesignName` (proven by
    // push-client.js transformDesigns:446). Emitting `name` made it land BLANK
    // in ShopWorks — confirmed live on EMB-TEST-2026-9001 (2026-06-01).
    const session = baseSession({
      Notes: JSON.stringify({
        frontLocation: 'Full Front', frontColors: 2, isDarkGarment: true, setupFeeTotal: 90,
        newDesignName: 'ACME Logo',
        referenceArtwork: [
          { hostedUrl: 'https://example.com/logo.png', placement: 'Front', fileName: 'logo.png' },
        ],
      }),
    });
    const order = transformQuoteToOrder(session, [garment()], { isTest: true });
    expect(order.Designs).toHaveLength(1);
    const d = order.Designs[0];
    expect(d.DesignName).toBe('ACME Logo'); // the fix
    expect(d.name).toBeUndefined();          // old (ignored) key gone
    expect(d.Locations[0].ImageURL).toBe('https://example.com/logo.png');

    // Enrichment (2026-06-01): ink colors + a stable ExtDesignID that the
    // garment lines reference, so the design and lines link in ShopWorks.
    expect(d.Locations[0].TotalColors).toBe('2'); // 2 front + 0 back
    expect(d.ExtDesignID).toBe('G-1');            // QuoteID SPC-0101-1 → seq 1
    const garmentLine = order.LinesOE.find((l) => l.PartNumber.startsWith('PC54'));
    expect(garmentLine.ExtDesignIDBlock).toBe(d.ExtDesignID); // line → design link
  });
});
