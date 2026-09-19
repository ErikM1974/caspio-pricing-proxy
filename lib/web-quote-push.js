'use strict';

// WQ rows are frozen customer prices. Reuse the established EMB size/part
// mapping, but never interpret WQ's JSON Notes as a staff builder session.
const crypto = require('crypto');
const { transformQuoteToOrder, buildLinesOE } = require('./embroidery-push-transformer');
const { canonicalFeePN, NOTE_TYPES } = require('../config/manageorders-emb-config');
const { SIZE_MAPPING } = require('../config/manageorders-push-config');
const { artworkAttachments } = require('./sw-image-url');

function fail(message) { throw Object.assign(new Error(message), { status: 422 }); }
function cents(value, label) {
  if (value === '' || value == null || !Number.isFinite(Number(value)) || Number(value) < 0) fail(`Invalid ${label}.`);
  return Math.round(Number(value) * 100);
}

function buildPreview(session, items, customer) {
  const id = String(session.QuoteID || '');
  if (!/^WQ[\d-]+$/.test(id)) fail('Only saved WQ web quotes are supported.');
  if (/cancel|deleted|expired/i.test(session.Status || '')) fail('This quote is cancelled or expired.');
  let notes;
  try { notes = JSON.parse(session.Notes); } catch { fail('Web quote details are missing. Review this quote in the staff builder.'); }
  if (notes?.channel !== 'web-quote-cart' || !Array.isArray(notes.groups) || !notes.groups.length) fail('Web quote decoration details are missing.');
  if (notes.groups.some(g => !['EMB', 'CAP'].includes(g.method))) fail('Direct push currently supports embroidery web quotes only. Use the matching staff builder for other decoration methods.');
  if (!items.length || !items.some(i => ['embroidery', 'cap'].includes(i.EmbellishmentType))) fail('No embroidery garments found.');
  const customerNumber = String(customer.id_Customer || '');
  if (!/^[1-9]\d*$/.test(customerNumber)) fail('Select an active ShopWorks customer.');

  const lines = [];
  const summary = [];
  for (const item of items) {
    const quantity = Number(item.Quantity);
    if (!Number.isSafeInteger(quantity) || quantity <= 0) fail(`Invalid quantity for ${item.StyleNumber}.`);
    const total = cents(item.LineTotal, `line total for ${item.StyleNumber}`);
    if (!total) fail(`Review the zero-dollar line ${item.StyleNumber} in the staff builder.`);
    const product = ['embroidery', 'cap'].includes(item.EmbellishmentType);
    if (!product && (item.EmbellishmentType !== 'fee' || !canonicalFeePN(item.StyleNumber))) fail(`Unsupported service ${item.StyleNumber}; no line may be dropped.`);
    if (product) {
      if (!item.StyleNumber || !item.ColorCode) fail(`Catalog color is missing for ${item.StyleNumber}. Review inventory color before pushing.`);
      let sizes;
      try { sizes = JSON.parse(item.SizeBreakdown); } catch { fail(`Sizes are missing for ${item.StyleNumber}.`); }
      if (!sizes || Array.isArray(sizes) || typeof sizes !== 'object' || !Object.keys(sizes).length ||
          Object.entries(sizes).some(([size, qty]) => !Object.hasOwn(SIZE_MAPPING, size) || !Number.isSafeInteger(Number(qty)) || Number(qty) <= 0) ||
          Object.values(sizes).reduce((s, q) => s + Number(q), 0) !== quantity) fail(`Size quantities do not match for ${item.StyleNumber}.`);
      if (!item.PrintLocationName && !item.PrintLocation) fail(`Decoration location is missing for ${item.StyleNumber}.`);
    }
    const mapped = buildLinesOE({}, [{ ...item, EmbellishmentType: product ? 'embroidery' : 'fee' }]);
    if (mapped.skippedFeeNotes.length || !mapped.lines.length) fail(`Unable to map ${item.StyleNumber}.`);
    // Split a row between adjacent penny prices when necessary. This preserves
    // the authoritative row total without adding a made-up balancing charge.
    const unit = Math.floor(total / quantity);
    let extra = total % quantity;
    if (unit <= 0) fail(`Unit price is too small for ${item.StyleNumber}.`);
    for (const line of mapped.lines) {
      const qty = Number(line.Qty);
      const high = Math.min(qty, extra);
      extra -= high;
      const detail = product ? `Embroidery: ${item.PrintLocationName || item.PrintLocation}` : '';
      if (high) lines.push({ ...line, Qty: String(high), Price: ((unit + 1) / 100).toFixed(2), WorkOrderNotes: detail });
      if (qty > high) lines.push({ ...line, Qty: String(qty - high), Price: (unit / 100).toFixed(2), WorkOrderNotes: detail });
    }
    summary.push({ style: item.StyleNumber, description: item.ProductName, color: item.Color, catalogColor: item.ColorCode,
      sizes: product ? JSON.parse(item.SizeBreakdown) : null, quantity, total: total / 100,
      location: item.PrintLocationName || item.PrintLocation || '' });
  }
  const subtotal = items.reduce((s, i) => s + cents(i.LineTotal, 'line total'), 0);
  if (subtotal !== cents(session.TotalAmount, 'quote total') ||
      lines.reduce((s, l) => s + Math.round(Number(l.Price) * 100) * Number(l.Qty), 0) !== subtotal) fail('Saved quote totals do not match its lines. Review the quote before pushing.');
  // Do not invent payment records or reinterpret a paid deposit as unpaid.
  if ((Array.isArray(notes.payments) && notes.payments.length) || notes.deposit?.paidAt || notes.deposit?.balancePaidAt || notes.deposit?.status === 'paid' || Number(notes.deposit?.amountPaid) > 0) fail('This quote has an online payment. Use the payment reconciliation workflow before pushing.');
  const order = transformQuoteToOrder({ QuoteID: id, CustomerNumber: customerNumber,
    CustomerName: session.CustomerName, CustomerEmail: session.CustomerEmail, Phone: session.Phone,
    CompanyName: customer.Company_Name, SalesRepEmail: session.SalesRepEmail,
    PurchaseOrderNumber: session.PurchaseOrderNumber, PaymentTerms: session.PaymentTerms,
    ReqShipDate: session.ReqShipDate, DropDeadDate: session.DropDeadDate,
    ShipToAddress: session.ShipToAddress, ShipToCity: session.ShipToCity,
    ShipToState: session.ShipToState, ShipToZip: session.ShipToZip,
    DateOrderPlaced: session.CreatedAt_Quote }, []);
  // The staff EMB transformer defaults missing delivery to pickup. A web
  // request has not necessarily chosen pickup; leave that decision open.
  order.ShippingAddresses[0].ShipMethod = session.ShipMethod || (notes.acceptedDeliveryMethod === 'pickup' ? 'Customer Pickup' : '');
  Object.assign(order, { ExtOrderID: `NWCA-${id}`, LinesOE: lines, OnHold: 1,
    TaxTotal: 0, TaxPartNumber: '', TaxPartDescription: '', coa_AccountSalesTax01: '',
    Designs: [], Notes: [
      { Type: NOTE_TYPES.ORDER, Note: `Web quote ${id}. Saved subtotal: $${(subtotal / 100).toFixed(2)}. ON HOLD: confirm artwork, tax, shipping, payment and production details before releasing.` },
      { Type: NOTE_TYPES.ORDER, Note: `Customer request: ${notes.customerNotes || '(none)'}` },
      { Type: NOTE_TYPES.SHIPPING, Note: `Requested delivery: ${notes.acceptedDeliveryMethod || 'not yet confirmed'}. Confirm address and shipping charge before releasing.` },
      ...notes.groups.map(g => ({ Type: NOTE_TYPES.PRODUCTION, Note: `${g.method} ${g.groupId}: ${JSON.stringify(g.options || {})}` })),
      { Type: NOTE_TYPES.ACCOUNTING, Note: 'Web quote prices exclude unconfirmed tax and shipping. Reconcile any online payment in the quote before collecting payment in ShopWorks.' }
    ] });
  const artwork = Array.isArray(notes.artworkKeys) ? notes.artworkKeys : [];
  if (artwork.some(a => !/^https:\/\//i.test(a.url || ''))) fail('An artwork file is missing its hosted URL. Review the artwork before pushing.');
  order.Attachments = artworkAttachments(artwork.map(a => ({ hostedUrl: a.url, fileName: a.fileName, placement: a.groupId })));
  order.Notes.push(...artwork.map(a => ({ Type: NOTE_TYPES.ART, Note: `${a.groupId}: ${a.fileName || 'Artwork'} — ${a.url}` })));
  const preview = { quoteId: id, extOrderId: order.ExtOrderID, customerNumber, customerName: customer.Company_Name,
    subtotal: subtotal / 100, items: summary, artworkCount: artwork.length,
    warnings: ['Imported on hold. Confirm artwork/design assignment, tax, shipping and payment in ShopWorks before releasing the order.'], order };
  // Bind confirmation to the freshly fetched persisted quote and chosen account.
  preview.previewToken = crypto.createHash('sha256').update(JSON.stringify({ order, notes, summary, customerNumber })).digest('hex');
  return preview;
}

module.exports = { buildPreview };
