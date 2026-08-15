/**
 * Push-side locks for vendor (non-SanMar) garments and customer-supplied goods.
 *
 * 1. SizeBreakdown is an ALLOWLIST, not a size map. buildProductLines() treats every
 *    unlisted key as a SIZE, so any metadata key the frontend writes but the filter
 *    doesn't know about ships as a phantom LinesOE line — with Size/Qty set to the key
 *    name and a real Price on it. Nobody notices until the floor cuts it.
 * 2. Vendor provenance (LogoSpecs.ns) has to reach the order, or whoever raises the PO
 *    buys an S&S part from SanMar.
 * 3. A customer-supplied line must tell Receiving what is arriving; they are the ones
 *    counting the customer's boxes in.
 *
 * Pure-function tests: no Caspio, no network.
 */
const { transformQuoteToOrder } = require('../../lib/embroidery-push-transformer');

function baseSession(overrides = {}) {
  return {
    PK_ID: 1, QuoteID: 'EMB-2026-901',
    CustomerName: 'Jane Smith', CustomerNumber: '12345', CustomerEmail: 'jane@acme.com',
    CompanyName: 'Acme Co', Phone: '2535551212', SalesRepEmail: 'erik@nwcustomapparel.com',
    TaxRate: 0.101, TaxAmount: 10.1, ShipToState: 'WA', ShipMethod: 'Customer Pickup',
    SubtotalAmount: 100,
    ...overrides,
  };
}

function garment(overrides = {}) {
  return {
    EmbellishmentType: 'embroidery', StyleNumber: 'PC54',
    ProductName: 'Port & Company Core Cotton Tee', Color: 'Navy', ColorCode: 'Navy',
    Quantity: 24, SizeBreakdown: JSON.stringify({ S: 8, M: 8, L: 8 }),
    FinalUnitPrice: 20, LineTotal: 480,
    ...overrides,
  };
}

function customerSupplied(overrides = {}) {
  return {
    EmbellishmentType: 'customer-supplied', StyleNumber: 'DECG',
    ProductName: 'Customer-Supplied Garments',
    Quantity: 24, FinalUnitPrice: 24, LineTotal: 576,
    SizeBreakdown: JSON.stringify({ type: 'DECG', stitchCount: 8000, heavyweight: true }),
    ...overrides,
  };
}

const productLines = (order) => order.LinesOE.filter(l => l.PartNumber === 'PC54');

describe('SizeBreakdown allowlist — no phantom size lines', () => {
  test('a product carrying every metadata key we write still emits ONE line per real size', () => {
    const order = transformQuoteToOrder(baseSession(), [garment({
      SizeBreakdown: JSON.stringify({
        S: 8, M: 8, L: 8,
        // Everything the frontend has ever put in this column:
        type: 'DECG', serviceType: 'AL', logoPosition: 'Left Chest',
        stitchCount: 8000, heavyweight: true,
      }),
    })]);

    const lines = productLines(order);
    expect(lines).toHaveLength(3);
    expect(lines.map(l => l.Size).sort()).toEqual(['L', 'M', 'S']);
    // The failure mode this guards: Size:"heavyweight", Qty:"true", Price:"20".
    lines.forEach(l => expect(Number.isFinite(Number(l.Qty))).toBe(true));
  });

  test('heavyweight alone never becomes a line', () => {
    const order = transformQuoteToOrder(baseSession(), [garment({
      SizeBreakdown: JSON.stringify({ M: 12, heavyweight: true }),
    })]);
    const lines = productLines(order);
    expect(lines).toHaveLength(1);
    expect(lines[0].Size).toBe('M');
  });
});

describe('vendor (non-SanMar) provenance reaches the order', () => {
  const vendorItem = () => garment({
    StyleNumber: 'SS-B00760',
    ProductName: 'Gildan Heavy Cotton Tee',
    LogoSpecs: JSON.stringify({ ns: { v: 'SSA', mode: 'costPlus', cost: 8.42 } }),
  });

  test('every line names the vendor and keeps the real part number', () => {
    const order = transformQuoteToOrder(baseSession(), [vendorItem()]);
    const lines = order.LinesOE.filter(l => l.PartNumber === 'SS-B00760');

    expect(lines).toHaveLength(3);
    lines.forEach(l => {
      expect(l.LineItemNotes).toBe('VENDOR: S&S Activewear — not a SanMar part');
      expect(l.DisplayAsDescription).toBe('Gildan Heavy Cotton Tee (S&S Activewear)');
      // Held in reserve as the fallback if OnSite rejects unknown parts.
      expect(l.DisplayAsPartNumber).toBe('');
    });
  });

  test('an unknown vendor code still reads sensibly rather than vanishing', () => {
    const order = transformQuoteToOrder(baseSession(), [garment({
      LogoSpecs: JSON.stringify({ ns: { v: 'WEIRDCO', mode: 'fixed', cost: 0 } }),
    })]);
    expect(productLines(order)[0].LineItemNotes).toBe('VENDOR: WEIRDCO — not a SanMar part');
  });

  test('a SanMar product is completely unaffected', () => {
    const order = transformQuoteToOrder(baseSession(), [garment()]);
    productLines(order).forEach(l => {
      expect(l.LineItemNotes).toBe('');
      expect(l.DisplayAsDescription).toBe('');
    });
  });

  test('a MANUAL item carries no vendor note — the description carries the vendor instead', () => {
    // Decision, not a gap (Erik 2026-08-15). A manual vendor item is typed straight onto
    // the line and has no VendorCode, so ns.v is ''. The vendor travels in the rep's
    // description, which is already sent as Description. Confirmed live on the TEST push
    // EMB-TEST-2026-315, where LineItemNotes came back empty exactly as expected.
    const order = transformQuoteToOrder(baseSession(), [garment({
      StyleNumber: 'SS-LIVE-CHECK',
      ProductName: 'S&S Bella+Canvas Jersey Tee - Navy',
      SizeBreakdown: JSON.stringify({ L: 24 }),
      LogoSpecs: JSON.stringify({ ns: { v: '', mode: 'costPlus', cost: 8.42 } }),
    })]);

    const line = order.LinesOE.find(l => l.PartNumber === 'SS-LIVE-CHECK');
    expect(line).toBeTruthy();
    expect(line.LineItemNotes).toBe('');
    expect(line.DisplayAsDescription).toBe('');
    // …but the vendor still reaches the buyer, in the field they actually read.
    expect(line.Description).toBe('S&S Bella+Canvas Jersey Tee - Navy');
    // And the arbitrary vendor style goes through verbatim — OnSite accepted this.
    expect(line.PartNumber).toBe('SS-LIVE-CHECK');
  });

  test('malformed LogoSpecs never blocks a push', () => {
    const order = transformQuoteToOrder(baseSession(), [garment({ LogoSpecs: '{not json' })]);
    expect(productLines(order)).toHaveLength(3);
    expect(productLines(order)[0].LineItemNotes).toBe('');
  });
});

describe('customer-supplied goods tell Receiving what is arriving', () => {
  test('the rep description rides on the line Description', () => {
    const order = transformQuoteToOrder(baseSession(), [customerSupplied({
      ProductName: 'Customer-Supplied Garments — Carhartt CTK87 · Navy',
    })]);
    const line = order.LinesOE.find(l => l.PartNumber === 'DECG');
    expect(line).toBeTruthy();
    expect(line.Description).toBe('Customer-Supplied Garments — Carhartt CTK87 · Navy');
  });

  test('the sizes/details manifest becomes a Notes To Receiving entry', () => {
    const order = transformQuoteToOrder(baseSession(), [customerSupplied({
      ProductName: 'Customer-Supplied Garments — Carhartt CTK87 · Navy',
      Notes: 'S(4) M(10) L(8) XL(2)\nCustomer ships to us by Aug 22',
    })]);

    const receiving = order.Notes.filter(n => n.Type === 'Notes To Receiving');
    expect(receiving).toHaveLength(1);
    expect(receiving[0].Note).toContain('Carhartt CTK87');
    expect(receiving[0].Note).toContain('qty 24');
    expect(receiving[0].Note).toContain('S(4) M(10) L(8) XL(2)');
  });

  test('no manifest → no empty receiving note', () => {
    const order = transformQuoteToOrder(baseSession(), [customerSupplied()]);
    expect(order.Notes.filter(n => n.Type === 'Notes To Receiving')).toHaveLength(0);
  });

  test('a customer-supplied item still pushes as ONE billable line, not per size', () => {
    const order = transformQuoteToOrder(baseSession(), [customerSupplied()]);
    const lines = order.LinesOE.filter(l => l.PartNumber === 'DECG');
    expect(lines).toHaveLength(1);
    expect(lines[0].Qty).toBe('24');
    expect(Number(lines[0].Price)).toBe(24);
  });
});
