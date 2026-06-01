/**
 * Preview the ShopWorks push payloads for EMB / SCP / DTF from representative
 * fixtures — no Caspio, no network, no live push. A review aid for the
 * 2026-06-01 quote-builder parity fixes: shows the exact ExternalOrderJson each
 * transformer now produces so the fixed fields can be eyeballed before deploy.
 *
 * Run:  node scripts/preview-push-payloads.js
 *       node scripts/preview-push-payloads.js --full   # also dump full JSON
 *
 * What to look for (the fixes):
 *   • Order notes live under `Notes` (NOT `NotesOnOrders`) for all three.
 *   • SCP ShippingAddresses[0] populates ShipAddress01/ShipCity from the quote.
 *   • ExtOrderID carries a 20xx year (SCP/DTF no longer collide daily).
 */

const emb = require('../lib/embroidery-push-transformer');
const scp = require('../lib/scp-push-transformer');
const dtf = require('../lib/dtf-push-transformer');

const full = process.argv.includes('--full');

// ── Shared, realistic session fields ──────────────────────────────────────
const baseSession = {
  PK_ID: 101,
  CustomerName: 'Jane Smith',
  CustomerNumber: '12345',
  CustomerEmail: 'jane@acme.com',
  CompanyName: 'Acme Co',
  Phone: '2535551212',
  SalesRepEmail: 'erik@nwcustomapparel.com',
  PurchaseOrderNumber: 'PO-7788',
  DateOrderPlaced: '2026-06-01',
  ReqShipDate: '2026-06-10',
  TaxRate: 10.1,
  TaxAmount: 30.25,
  ShipToAddress: '2025 Freeman Rd E',
  ShipToCity: 'Milton',
  ShipToState: 'WA',
  ShipToZip: '98354',
  ShipMethod: 'UPS Ground',
  ShippingFee: 15,
  Discount: 0,
};

// ── Per-method fixtures ───────────────────────────────────────────────────
const EMB = {
  session: { ...baseSession, QuoteID: 'EMB-2026-177', GarmentDesignNumber: '54321', PricingTier: '24-47', TotalQuantity: 30 },
  items: [{
    EmbellishmentType: 'embroidery', StyleNumber: 'PC54', ProductName: 'Core Cotton Tee',
    Color: 'Navy', ColorCode: 'Navy', Quantity: 30,
    SizeBreakdown: JSON.stringify({ S: 6, M: 12, L: 8, XL: 4 }),
    FinalUnitPrice: 12.5, LineTotal: 375,
  }],
};

const SCP = {
  session: {
    ...baseSession, QuoteID: 'SP0601-1', LTM_Display_Mode: 'builtin', LTMFeeTotal: 0,
    ArtCharge: 50, RushFee: 0, GraphicDesignCharge: 0,
    Notes: JSON.stringify({ frontLocation: 'FF', frontColors: 2, isDarkGarment: true, setupFeeTotal: 90 }),
  },
  items: [{
    EmbellishmentType: 'screenprint', StyleNumber: 'PC54', ProductName: 'Core Cotton Tee',
    Color: 'Navy', ColorCode: 'Navy', Quantity: 60,
    SizeBreakdown: JSON.stringify({ S: 12, M: 12, L: 12, XL: 12, '2XL': 12 }),
    FinalUnitPrice: 10, LineTotal: 600,
  }],
};

const DTF = {
  session: { ...baseSession, QuoteID: 'DTF0601-1', GarmentDesignNumber: '', RushFee: 50, ArtCharge: 0 },
  items: [{
    EmbellishmentType: 'dtf', StyleNumber: 'PC54', ProductName: 'Core Cotton Tee',
    Color: 'Navy', ColorCode: 'Navy', Quantity: 30,
    SizeBreakdown: JSON.stringify({ M: 24, '2XL': 6 }),
    FinalUnitPrice: 9.25, LineTotal: 277.5,
  }],
};

function summarize(label, order) {
  const lines = order.LinesOE || [];
  const ship = (order.ShippingAddresses || [])[0] || {};
  const notes = order.Notes || [];
  const lineSum = lines.reduce((s, l) => s + (parseFloat(l.Price) || 0) * (parseFloat(l.Qty) || 0), 0);
  const preTax = lineSum + (order.cur_Shipping || 0) - (order.TotalDiscounts || 0);

  console.log(`\n${'='.repeat(70)}\n${label}\n${'='.repeat(70)}`);
  console.log(`  ExtOrderID ............ ${order.ExtOrderID}        ${/-20\d\d-/.test(order.ExtOrderID) ? '✓ year-safe' : '⚠ no year'}`);
  console.log(`  id_OrderType .......... ${order.id_OrderType}`);
  console.log(`  id_Customer ........... ${order.id_Customer}`);
  console.log(`  Notes key present ..... ${Array.isArray(order.Notes) ? `✓ Notes[${notes.length}]` : '⚠ MISSING'}` +
              `${order.NotesOnOrders ? '   ⚠ stray NotesOnOrders!' : ''}`);
  console.log(`  Ship-to ............... ShipAddress01="${ship.ShipAddress01 || ''}" ShipCity="${ship.ShipCity || ''}" Method="${ship.ShipMethod || ''}"`);
  console.log(`  LinesOE ............... ${lines.length} lines, pre-tax total $${preTax.toFixed(2)}`);
  lines.forEach(l => console.log(`      ${(l.PartNumber || '').padEnd(12)} ${(l.Size || '-').padEnd(5)} x${String(l.Qty).padEnd(4)} $${l.Price}`));
  console.log(`  Designs ............... ${(order.Designs || []).length}`);
  console.log(`  Tax account (note) .... ${(notes.find(n => /Tax [Aa]ccount/.test(n.Note)) || {}).Note?.split('\n').pop() || '(in Notes)'}`);
  if (full) console.log('\n--- full ExternalOrderJson ---\n' + JSON.stringify(order, null, 2));
}

summarize('EMBROIDERY  (EMB-2026-177)', emb.transformQuoteToOrder(EMB.session, EMB.items, { isTest: true }));
summarize('SCREEN PRINT  (SP0601-1 → SCP-…)', scp.transformQuoteToOrder(SCP.session, SCP.items, { isTest: true }));
summarize('DTF  (DTF0601-1 → DTF-…)', dtf.transformQuoteToOrder(DTF.session, DTF.items, { isTest: true }));
console.log('\nDone. Re-run with --full to dump the complete payloads.\n');
