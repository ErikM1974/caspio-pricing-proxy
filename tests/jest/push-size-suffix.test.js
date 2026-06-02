/**
 * Regression: push transformers must send the BASE part number, NOT a
 * pre-suffixed one. ShopWorks's Size Translation Table appends the per-size
 * modifier (_2X, _3XL, _OSFA, …) from the Size field on ingest, so emitting a
 * pre-suffixed PN (PC54_2X) double-stamps it (PC54_2X_2X).
 *
 * Bug found + fixed 2026-06-02 against the live ShopWorks Size Translation Table.
 * Order-form path (manageorders-push-client) never pre-suffixed; the 3
 * quote-builder transformers did via getPartNumber(style,size).
 */
const scp = require('../../lib/scp-push-transformer');
const dtf = require('../../lib/dtf-push-transformer');
const emb = require('../../lib/embroidery-push-transformer');

const baseSession = (over = {}) => ({
  QuoteID: 'TEST-1',
  CustomerName: 'Test Co',
  CustomerEmail: 'test@nwcustomapparel.com',
  CompanyName: 'Test Co',
  CustomerNumber: '',
  TaxRate: 10.1,
  SalesRepEmail: 'erik@nwcustomapparel.com',
  SalesRepName: 'Erik Mickelson',
  DateOrderPlaced: '2026-06-02T07:00:00',
  CreatedAt_Quote: '2026-06-02T00:00:00',
  CreatedAt: '2026-06-02T00:00:00',
  ShipMethod: 'Customer Pickup',
  ...over,
});

const garmentLines = (order) =>
  (order.LinesOE || []).filter((l) => l.Size && l.PartNumber && Number(l.Qty) > 0);
const lineFor = (order, size) => (order.LinesOE || []).find((l) => l.Size === size);

describe('Push transformers emit BASE part number (SW appends the size modifier)', () => {
  test('SCP: 2XL garment line keeps base PN (PC54), not PC54_2X', () => {
    const order = scp.transformQuoteToOrder(baseSession({ QuoteID: 'SP0602-T1' }), [
      {
        EmbellishmentType: 'screenprint', StyleNumber: 'PC54', Color: 'Navy',
        ProductName: 'Port & Company Core Cotton Tee',
        SizeBreakdown: '{"S":12,"2XL":4}', FinalUnitPrice: 10, LineNumber: 1,
      },
    ]);
    expect(lineFor(order, '2XL').PartNumber).toBe('PC54');
    expect(lineFor(order, 'S').PartNumber).toBe('PC54');
    // No pushed garment line should carry a size suffix
    expect(garmentLines(order).some((l) => /_\dX|_OSFA|_X|_\dXL/.test(l.PartNumber))).toBe(false);
  });

  test('DTF: 2XL garment line keeps base PN (29M), not 29M_2X', () => {
    const order = dtf.transformQuoteToOrder(baseSession({ QuoteID: 'DTF0602-T1' }), [
      {
        EmbellishmentType: 'dtf', StyleNumber: '29M', Color: 'Black',
        ProductName: 'Jerzees Dri-Power Tee',
        SizeBreakdown: '{"S":20,"2XL":25}', FinalUnitPrice: 15, LineNumber: 1,
      },
    ]);
    expect(lineFor(order, '2XL').PartNumber).toBe('29M');
    expect(lineFor(order, 'S').PartNumber).toBe('29M');
  });

  test('EMB: OSFA cap keeps base PN (C112), not C112_OSFA; 2XL garment base too', () => {
    const order = emb.transformQuoteToOrder(baseSession({ QuoteID: 'EMB-2026-T1', StitchCount: 8000, CapStitchCount: 8000 }), [
      {
        EmbellishmentType: 'embroidery', StyleNumber: 'C112', Color: 'Black',
        ProductName: 'Port Authority Cap', SizeBreakdown: '{"OSFA":24}',
        FinalUnitPrice: 12, LineNumber: 1,
      },
      {
        EmbellishmentType: 'embroidery', StyleNumber: 'PC61', Color: 'Black',
        ProductName: 'Port & Company Tee', SizeBreakdown: '{"L":6,"2XL":4}',
        FinalUnitPrice: 18, LineNumber: 2,
      },
    ]);
    expect(lineFor(order, 'OSFA').PartNumber).toBe('C112');
    expect(lineFor(order, '2XL').PartNumber).toBe('PC61');
    expect(garmentLines(order).some((l) => /_/.test(l.PartNumber))).toBe(false);
  });
});
