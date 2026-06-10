/**
 * Regression tests for EMB push fee routing + tax hardening (audit 2026-06-10).
 *
 * Pins the under-billing fixes:
 *   1+2. WEIGHT / Name/Number / standalone FB service rows must push as BILLABLE
 *        LinesOE (they used to demote to order notes — ShopWorks order billed short).
 *        SAMPLE has no confirmed ShopWorks part → stays a note, but an EXPLICIT
 *        "UNBILLED FEE — add manually" call-to-action, never a quiet blob.
 *   3.   Legacy 'monogram' EmbellishmentType items must produce a Monogram line
 *        (they used to be silently DROPPED — no line, no note).
 *   5.   Percent-shaped TaxRate (10.1) is normalized via toRateDecimal — no more
 *        'Tax Rate: 1010%' notes / MANUAL REVIEW account.
 *   6.   Fee PartNumbers are emitted in canonical ShopWorks casing
 *        ('CTR-GARMT' → 'CTR-Garmt') because SW part matching is case-sensitive.
 *
 * Pure-function tests: no Caspio, no network.
 */
const { transformQuoteToOrder, buildLinesOE } = require('../../lib/embroidery-push-transformer');
const { canonicalFeePN, isKnownFeeCode, toRateDecimal } = require('../../config/manageorders-emb-config');

/** Base EMB session the quote-service persists (TaxRate as a DECIMAL). */
function baseSession(overrides = {}) {
  return {
    PK_ID: 1, QuoteID: 'EMB-2026-177',
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

function fee(style, name, unit, qty = 1, overrides = {}) {
  return {
    EmbellishmentType: 'fee', StyleNumber: style, ProductName: name,
    Quantity: qty, FinalUnitPrice: unit, LineTotal: unit * qty,
    ...overrides,
  };
}

const lineByPart = (order, pn) => order.LinesOE.filter((l) => l.PartNumber === pn);
const noteText = (order) => order.Notes.map((n) => n.Note).join('\n');

describe('EMB push — service-bar fees bill as LinesOE, not notes (audit findings 1+2)', () => {
  test('WEIGHT fee row → billable WEIGHT line (real SW part per import parser)', () => {
    const order = transformQuoteToOrder(baseSession(), [garment(), fee('WEIGHT', 'Weight', 6.25, 4)], { isTest: true });
    const weight = lineByPart(order, 'WEIGHT');
    expect(weight).toHaveLength(1);
    expect(weight[0]).toMatchObject({ Qty: '4', Price: '6.25' });
    expect(noteText(order)).not.toContain('UNBILLED');
  });

  test("'Name/Number' fee row → billable line under the real 'Monogram' part (Name/Number verified absent from SW 2026-05-03)", () => {
    const order = transformQuoteToOrder(baseSession(), [garment(), fee('Name/Number', 'Name & Number', 15)], { isTest: true });
    const mono = lineByPart(order, 'Monogram');
    expect(mono).toHaveLength(1);
    expect(mono[0].Description).toBe('Name & Number'); // description still says what it is
    expect(lineByPart(order, 'Name/Number')).toHaveLength(0);
  });

  test("standalone 'FB' fee row → billable DECG-FB line (Full Back Embroidery)", () => {
    const order = transformQuoteToOrder(baseSession(), [garment(), fee('FB', 'Full Back Embroidery', 12.5, 24)], { isTest: true });
    const fb = lineByPart(order, 'DECG-FB');
    expect(fb).toHaveLength(1);
    expect(fb[0]).toMatchObject({ Qty: '24', Price: '12.5' });
  });

  test('SAMPLE fee (no confirmed SW part) → NOT a line, but an EXPLICIT UNBILLED note with the dollars', () => {
    const order = transformQuoteToOrder(baseSession(), [garment(), fee('SAMPLE', 'Sample Fee', 35)], { isTest: true });
    expect(lineByPart(order, 'SAMPLE')).toHaveLength(0);
    expect(noteText(order)).toContain('UNBILLED FEE — add manually: Sample Fee $35.00');
  });

  test('multi-qty unknown fee note carries qty x unit breakdown', () => {
    const order = transformQuoteToOrder(baseSession(), [garment(), fee('SAMPLE', 'Sample Fee', 17.5, 2)], { isTest: true });
    expect(noteText(order)).toContain('UNBILLED FEE — add manually: Sample Fee $35.00 (2 x $17.50)');
  });
});

describe("EMB push — legacy 'monogram' EmbellishmentType (audit finding 3)", () => {
  const monogramItem = {
    EmbellishmentType: 'monogram', StyleNumber: 'Monogram',
    ProductName: 'Monogram - Names on Garments', Quantity: 6, FinalUnitPrice: 12.5, LineTotal: 75,
  };

  test('monogram item produces a billable Monogram line (was silently dropped)', () => {
    const order = transformQuoteToOrder(baseSession(), [garment(), monogramItem], { isTest: true });
    const mono = lineByPart(order, 'Monogram');
    expect(mono).toHaveLength(1);
    expect(mono[0]).toMatchObject({ Qty: '6', Price: '12.5' });
  });

  test("legacy UPPERCASE 'MONOGRAM' StyleNumber emits canonical 'Monogram' casing", () => {
    const order = transformQuoteToOrder(baseSession(),
      [garment(), { ...monogramItem, StyleNumber: 'MONOGRAM' }], { isTest: true });
    expect(lineByPart(order, 'Monogram')).toHaveLength(1);
    expect(lineByPart(order, 'MONOGRAM')).toHaveLength(0);
  });

  test('an unrecognized EmbellishmentType can never vanish silently — explicit UNBILLED ITEM note', () => {
    const order = transformQuoteToOrder(baseSession(),
      [garment(), { EmbellishmentType: 'mystery-type', StyleNumber: 'XYZ', ProductName: 'Mystery Charge', Quantity: 1, FinalUnitPrice: 40, LineTotal: 40 }],
      { isTest: true });
    expect(lineByPart(order, 'XYZ')).toHaveLength(0);
    expect(noteText(order)).toContain('UNBILLED ITEM [mystery-type] — add manually: Mystery Charge $40.00');
  });
});

describe('EMB push — canonical-case PartNumbers (audit finding 6)', () => {
  test("builder Add-Service casing 'CTR-GARMT' is sent as SW part 'CTR-Garmt'", () => {
    const order = transformQuoteToOrder(baseSession(), [garment(), fee('CTR-GARMT', 'Contract Embroidered Garments', 8, 24)], { isTest: true });
    expect(lineByPart(order, 'CTR-Garmt')).toHaveLength(1);
    expect(lineByPart(order, 'CTR-GARMT')).toHaveLength(0);
  });

  test("'as-garm' lowercase passes the gate and emits 'AS-Garm'", () => {
    const order = transformQuoteToOrder(baseSession(), [garment(), fee('as-garm', 'Additional Stitches', 4, 24)], { isTest: true });
    expect(lineByPart(order, 'AS-Garm')).toHaveLength(1);
  });

  test('unknown PNs on service items pass through verbatim (no fabricated casing)', () => {
    const { lines } = buildLinesOE(baseSession(), [
      { EmbellishmentType: 'embroidery-additional', StyleNumber: 'CUSTOM-AL', ProductName: 'Custom AL', Quantity: 1, FinalUnitPrice: 7, LineTotal: 7 },
    ]);
    expect(lines).toHaveLength(1);
    expect(lines[0].PartNumber).toBe('CUSTOM-AL');
  });

  test('canonicalFeePN helper: aliases + casing + unknowns', () => {
    expect(canonicalFeePN('FB')).toBe('DECG-FB');
    expect(canonicalFeePN('name/number')).toBe('Monogram');
    expect(canonicalFeePN('NAME')).toBe('Monogram');
    expect(canonicalFeePN('ctr-cap')).toBe('CTR-Cap');
    expect(canonicalFeePN('WEIGHT')).toBe('WEIGHT');
    expect(canonicalFeePN('SAMPLE')).toBeNull();
    expect(canonicalFeePN('')).toBeNull();
    expect(canonicalFeePN(null)).toBeNull();
    expect(isKnownFeeCode('fb')).toBe(true);
    expect(isKnownFeeCode('SAMPLE')).toBe(false);
  });
});

describe('EMB push — TaxRate decimal hardening (audit finding 5)', () => {
  test('decimal-shaped TaxRate (0.101) renders 10.10% and routes to 2200.101', () => {
    const order = transformQuoteToOrder(baseSession({ TaxRate: 0.101 }), [garment()], { isTest: true });
    expect(order.coa_AccountSalesTax01).toBe('2200.101');
    expect(noteText(order)).toContain('Tax Rate: 10.10%');
    expect(noteText(order)).not.toContain('1010');
  });

  test("percent-shaped TaxRate (10.1, legacy/hand-edited row) no longer produces 'Tax Rate: 1010%' / MANUAL REVIEW", () => {
    const order = transformQuoteToOrder(baseSession({ TaxRate: 10.1 }), [garment()], { isTest: true });
    expect(order.coa_AccountSalesTax01).toBe('2200.101');
    expect(noteText(order)).toContain('Tax Rate: 10.10%');
    expect(noteText(order)).not.toContain('MANUAL REVIEW');
    expect(noteText(order)).not.toContain('1010');
  });

  test('toRateDecimal helper matches the DTF/SCP pattern', () => {
    expect(toRateDecimal(0.101)).toBe(0.101);
    expect(toRateDecimal(10.1)).toBeCloseTo(0.101, 10);
    expect(toRateDecimal('10.1')).toBeCloseTo(0.101, 10);
    expect(toRateDecimal(0)).toBe(0);
    expect(toRateDecimal(null)).toBe(0);
    expect(toRateDecimal('garbage')).toBe(0);
  });
});

describe('EMB push — order total integrity with the newly-billable fees', () => {
  test('garments + WEIGHT + Name/Number + FB all land in LinesOE and sum to the quoted subtotal', () => {
    const items = [
      garment(),                                            // 24 × $20  = 480
      fee('WEIGHT', 'Weight', 6.25, 4),                     //  4 × 6.25 =  25
      fee('Name/Number', 'Name & Number', 15),              //  1 × 15   =  15
      fee('FB', 'Full Back Embroidery', 12.5, 24),          // 24 × 12.5 = 300
    ];
    const order = transformQuoteToOrder(baseSession({ SubtotalAmount: 820 }), items, { isTest: true });
    const lineSum = order.LinesOE.reduce((s, l) => s + parseFloat(l.Price) * parseFloat(l.Qty), 0);
    expect(Math.round(lineSum * 100) / 100).toBe(820);
    expect(noteText(order)).not.toContain('UNBILLED');
  });
});
