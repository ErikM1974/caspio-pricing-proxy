// aeo-push-transformer.test.js — locks the AE Order Intake → ShopWorks push
// contract: only SanMar-verified rows become line items (base PN + plain size,
// CATALOG_COLOR), everything else rides in notes, tax is never pushed, and the
// ExtOrderID seed carries the year.
'use strict';
const { buildAeoOrderData } = require('../../src/utils/aeo-push-transformer');

const SUBMISSION = {
  Submission_ID: 'AEO0711-2619',
  Form_ID: 'ae-order-intake',
  Company: 'Drain Pro Inc.',
  Contact_Name: 'Mike Rowe',
  Phone: '253-555-0142',
  Email: 'mike@drainpro.com',
  Customer_Number: '7740',
  Sales_Rep: 'Taneisha',
  Due_Date: '2026-07-24',
  Submitted_At: '2026-07-11T18:00:00.000Z',
};

function payload() {
  return {
    fields: [
      ['Subtotal', '666.00'], ['Tax', '67.93'], ['Order Total', '733.93'],
      ['Deposit', '300'], ['Balance Due', '433.93'],
      ['Ship Method', 'UPS Ground'], ['Decoration Location', 'Left chest'],
      ['PO # / Customer #', 'PO-4471'],
    ],
    checks: ['Embroidery', 'Proof required', 'Ship'],
    tables: [{
      title: 'Order Lines',
      columns: ['Style', 'Color', 'Catalog Color', 'Description', 'S', 'M', 'L', 'XL', '2XL', '3XL', 'Other', 'Qty', 'Unit Price', 'Line Total'],
      rows: [
        // verified: catalog color captured from the SanMar picker
        ['PC54', 'Navy', 'Navy', 'Port & Co Core Tee', '2', '4', '', '', '1', '', '', '7', '18.50', '129.50'],
        // NOT verified: hand-typed color (no catalog color)
        ['K87', 'dark heather-ish', '', 'Carhartt Pocket Tee', '', '3', '', '', '', '', '', '3', '25.00', '75.00'],
      ],
    }],
    notes: [['Production Notes', 'Rush if possible.']],
  };
}

describe('buildAeoOrderData', () => {
  test('verified row expands to one line per size with CATALOG color; unverified row is skipped into notes', () => {
    const { orderData, verifiedLines, skippedRows } = buildAeoOrderData(SUBMISSION, payload());

    expect(orderData.lineItems).toEqual([
      expect.objectContaining({ partNumber: 'PC54', catalogColor: 'Navy', size: 'S', quantity: 2, price: 18.5 }),
      expect.objectContaining({ partNumber: 'PC54', catalogColor: 'Navy', size: 'M', quantity: 4 }),
      expect.objectContaining({ partNumber: 'PC54', catalogColor: 'Navy', size: '2XL', quantity: 1 }),
    ]);
    expect(verifiedLines).toHaveLength(1);
    expect(skippedRows).toHaveLength(1);
    expect(skippedRows[0].reasons.join(' ')).toMatch(/catalog color/);

    const orderNote = orderData.notes[0].text;
    expect(orderNote).toContain('ROWS NOT PUSHED');
    expect(orderNote).toContain('K87');
  });

  test('tax is never pushed; money summary + SW-dropdown instruction ride in the notes', () => {
    const { orderData } = buildAeoOrderData(SUBMISSION, payload());
    expect(orderData.taxTotal).toBeUndefined();
    expect(orderData.notes[0].text).toContain('TAX NOT PUSHED');
    expect(orderData.notes[0].text).toContain('733.93');
  });

  test('orderNumber carries the submission id + year (ExtOrderID uniqueness rule)', () => {
    const { orderData } = buildAeoOrderData(SUBMISSION, payload());
    expect(orderData.orderNumber).toBe('AEO0711-2619-2026');
  });

  test('customer + fulfillment mapping: idCustomer from numeric Customer #, ship method, production note', () => {
    const { orderData } = buildAeoOrderData(SUBMISSION, payload());
    expect(orderData.idCustomer).toBe(7740);
    expect(orderData.customer).toEqual(expect.objectContaining({ firstName: 'Mike', lastName: 'Rowe', companyId: 7740 }));
    expect(orderData.shipping.method).toBe('UPS Ground');
    expect(orderData.notes[1]).toEqual({ type: 'Notes To Production', text: 'Rush if possible.' });
    expect(orderData.customerPurchaseOrder).toBe('PO-4471');
  });

  test('pickup wins over ship method; no customer # → warning about catch-all', () => {
    const p = payload();
    p.checks = ['Embroidery', 'Customer Pickup'];
    const sub = { ...SUBMISSION, Customer_Number: '' };
    const { orderData, warnings } = buildAeoOrderData(sub, p);
    expect(orderData.shipping.method).toBe('Customer Pickup');
    expect(orderData.idCustomer).toBeUndefined();
    expect(warnings.join(' ')).toMatch(/catch-all/);
  });

  test('v2 machine lines: dynamic sizes with upcharges — per-size price = base + Caspio upcharge, recomputed server-side', () => {
    const p = payload();
    p.lines = [{
      style: 'pc61', colorName: 'Dark Green', catalogColor: 'Dark Green', description: 'Essential Tee',
      basePrice: '10.00',
      sizes: [
        { size: 'M', qty: 2, upcharge: 0 },
        { size: '5XL', qty: 1, upcharge: 8 },   // extended size, different price
      ],
      otherSizes: '',
    }];
    const { orderData, verifiedLines } = buildAeoOrderData(SUBMISSION, p);
    expect(orderData.lineItems).toEqual([
      expect.objectContaining({ partNumber: 'PC61', size: 'M', quantity: 2, price: 10 }),
      expect.objectContaining({ partNumber: 'PC61', size: '5XL', quantity: 1, price: 18 }),
    ]);
    expect(verifiedLines[0].qty).toBe(3);
  });

  test('v2 design link: payload.designNumber → orderData.designs with id_Design + method design type', () => {
    const p = payload();
    p.designNumber = '39719';
    p.designName = 'Stella Jones signature logo';
    const { orderData } = buildAeoOrderData(SUBMISSION, p);
    expect(orderData.designs).toEqual([
      expect.objectContaining({ id_Design: 39719, name: 'Stella Jones signature logo', designTypeId: 2, productColor: 'Navy' }),
    ]);
    expect(orderData.notes[0].text).toContain('Design #39719 linked');
  });

  test('no designNumber → no designs key + the attach-by-hand note (legacy behavior)', () => {
    const { orderData } = buildAeoOrderData(SUBMISSION, payload());
    expect(orderData.designs).toBeUndefined();
    expect(orderData.notes[0].text).toContain('No design linked');
  });

  test('lines[].pricedVia (Quick Quote round-trip) rides into the order notes as pricing provenance', () => {
    const p = payload();
    p.lines = [{
      style: 'PC61', colorName: 'Navy', catalogColor: 'Navy', description: 'Essential Tee',
      basePrice: '21.00', sizes: [{ size: 'M', qty: 34, upcharge: 0 }], otherSizes: '',
      pricedVia: 'Quick Quote: Screen print — 2-col front, dark garment · 34 pcs (48 tier) → $21.00/pc',
    }];
    const { orderData } = buildAeoOrderData(SUBMISSION, p);
    expect(orderData.notes[0].text).toContain('— PRICING PROVENANCE —');
    expect(orderData.notes[0].text).toContain('PC61: Quick Quote: Screen print — 2-col front, dark garment');
  });

  test('no pricedVia on any line → no provenance section in the notes', () => {
    const { orderData } = buildAeoOrderData(SUBMISSION, payload());
    expect(orderData.notes[0].text).not.toContain('PRICING PROVENANCE');
  });

  test('all rows unverifiable → zero lineItems (endpoint 400s instead of pushing garbage)', () => {
    const p = payload();
    p.tables[0].rows = [['', 'Navy', '', 'Mystery tee', '', '', '', '', '', '', '', '5', '', '']];
    const { orderData, skippedRows } = buildAeoOrderData(SUBMISSION, p);
    expect(orderData.lineItems).toHaveLength(0);
    expect(skippedRows).toHaveLength(1);
  });
});
