/**
 * DTF Push Transformer
 *
 * Transforms saved DTF quote data (quote_sessions + quote_items) into
 * ManageOrders ExternalOrderJson format for the PUSH API.
 *
 * Simpler than EMB transformer:
 *   - No logos (no LogoSpecs JSON to parse)
 *   - No DECG/DECC/AL split — DTF has one EmbellishmentType ('dtf')
 *   - Transfer/labor/freight baked into FinalUnitPrice (one all-in line
 *     per size, with breakdown captured in Notes On Order for the SW
 *     operator)
 *
 * Data flow:
 *   Caspio quote_sessions + quote_items
 *     → transformQuoteToOrder()
 *       → ExternalOrderJson
 *         → POST /onsite/order-push
 *
 * Created 2026-05-23 — Phase 8.
 */

const {
  DTF_ONSITE_DEFAULTS,
  ORDER_LEVEL_FEES,
  getTaxAccount,
  generateDtfExtOrderID,
  getSalesRepName,
  formatDateForAPI,
  translateSize,
  NOTE_TYPES,
} = require('../config/manageorders-dtf-config');

// Reuse fee-routing logic from EMB config (shared service codes)
const { isKnownFeeCode } = require('../config/manageorders-emb-config');

const { getPartNumber } = require('../config/size-suffix-config');

/**
 * Transform a saved DTF quote into ManageOrders ExternalOrderJson.
 *
 * @param {Object} session — quote_sessions record from Caspio
 * @param {Array<Object>} items — quote_items records from Caspio
 * @param {Object} options
 * @param {boolean} options.isTest — Prefix ExtOrderID with TEST-
 * @returns {Object} ExternalOrderJson ready for ManageOrders PUSH API
 */
function transformQuoteToOrder(session, items, options = {}) {
  const { isTest = false } = options;
  const extOrderId = generateDtfExtOrderID(session.QuoteID, isTest);

  // Split name on last space
  const { firstName, lastName } = splitName(session.CustomerName || '');

  // Extract order-level financials (SHIP/DISCOUNT lines → top-level fields)
  const { shippingTotal, discountTotal } = extractOrderLevelFees(items);

  // Build line items: garment rows (one per size) + known fee services as LinesOE
  const { lines: linesOE, skippedFeeNotes } = buildLinesOE(session, items);

  // DTF design linking — uses GarmentDesignNumber column on Quote_Sessions
  // if present; otherwise Designs: [] + a note flagging no design
  const designs = buildDesigns(session, items);

  // Shipping address
  const shippingAddresses = buildShippingAddresses(session);

  // Tax account lookup
  const taxRate = parseFloat(session.TaxRate) || 0;
  const taxAmount = parseFloat(session.TaxAmount) || 0;
  const shipState = session.ShipToState || '';
  const { accountCode: taxAccountCode, description: taxAccountDesc } =
    getTaxAccount(taxRate, shipState);

  // Notes (skipped fees + tax info + DTF-specific breakdown)
  const notes = buildNotes(session, items, skippedFeeNotes, {
    taxAccountCode,
    taxAccountDesc,
  });

  return {
    // Order identification
    ExtOrderID: extOrderId,
    ExtSource: DTF_ONSITE_DEFAULTS.ExtSource,
    ExtCustomerID: String(session.CustomerNumber || ''),
    ExtCustomerPref: DTF_ONSITE_DEFAULTS.ExtCustomerPref,

    // Dates
    date_OrderPlaced: formatDateForAPI(session.DateOrderPlaced),
    date_OrderRequestedToShip: formatDateForAPI(session.ReqShipDate),
    date_OrderDropDead: formatDateForAPI(session.DropDeadDate),

    // Internal IDs
    id_OrderType: DTF_ONSITE_DEFAULTS.id_OrderType,
    id_EmpCreatedBy: DTF_ONSITE_DEFAULTS.id_EmpCreatedBy,
    id_Customer: parseInt(session.CustomerNumber, 10) || DTF_ONSITE_DEFAULTS.id_Customer,
    id_CompanyLocation: DTF_ONSITE_DEFAULTS.id_CompanyLocation,

    // Contact
    ContactEmail: session.CustomerEmail || '',
    ContactNameFirst: firstName,
    ContactNameLast: lastName,
    ContactPhone: session.Phone || '',

    // Order details
    CustomerPurchaseOrder: session.PurchaseOrderNumber || '',
    CustomerServiceRep: getSalesRepName(session.SalesRepEmail),
    OnHold: DTF_ONSITE_DEFAULTS.AutoHold,
    Terms: session.PaymentTerms || '',

    // Financial — order-level
    // TaxTotal: 0 always (OnSite calculates from sts_EnableTax01-04 flags on lines)
    TaxTotal: 0,
    coa_AccountSalesTax01: taxAccountCode,
    cur_Shipping: shippingTotal,
    TotalDiscounts: Math.abs(discountTotal),

    // Designs (empty array if no design number set)
    Designs: designs,

    // Line items
    LinesOE: linesOE,

    // Notes
    NotesOnOrders: notes,

    // Shipping addresses
    ShippingAddresses: shippingAddresses,
  };
}

// ──────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────

/**
 * Split full name on last space.
 * "Erik Mickelson" → { firstName: 'Erik', lastName: 'Mickelson' }
 * "Shantrell McCloud-Lacroix" → { firstName: 'Shantrell', lastName: 'McCloud-Lacroix' }
 */
function splitName(fullName) {
  const trimmed = String(fullName || '').trim();
  if (!trimmed) return { firstName: '', lastName: '' };
  const lastSpace = trimmed.lastIndexOf(' ');
  if (lastSpace === -1) return { firstName: trimmed, lastName: '' };
  return {
    firstName: trimmed.substring(0, lastSpace).trim(),
    lastName: trimmed.substring(lastSpace + 1).trim(),
  };
}

/**
 * Find SHIP and DISCOUNT fee items and return their dollar values for
 * the order-level fields. These do NOT become LinesOE.
 */
function extractOrderLevelFees(items) {
  let shippingTotal = 0;
  let discountTotal = 0;

  for (const item of items) {
    if (item.EmbellishmentType !== 'fee') continue;
    const pn = String(item.StyleNumber || '').toUpperCase();
    if (pn === 'SHIP') {
      shippingTotal += parseFloat(item.LineTotal) || 0;
    } else if (pn === 'DISCOUNT') {
      discountTotal += parseFloat(item.LineTotal) || 0;
    }
  }

  return { shippingTotal, discountTotal };
}

/**
 * Build LinesOE entries.
 *
 * For DTF garment rows (EmbellishmentType='dtf'):
 *   - Parse SizeBreakdown JSON
 *   - Expand into one LineOE per size
 *   - Price = FinalUnitPrice (already includes transfer + labor + freight + margin + LTM)
 *
 * For fee rows (EmbellishmentType='fee'):
 *   - TAX/SHIP/DISCOUNT → handled at order level, skip here
 *   - Known service codes (per isKnownFeeCode) → become LinesOE
 *   - Unknown PNs → collected for the order notes section
 */
function buildLinesOE(session, items) {
  const lines = [];
  const skippedFeeNotes = [];
  const seq = String(session.QuoteID || '').split('-').pop() || '0';
  const designBlock = `G-${seq}`; // Single design block for all garment lines

  let lineCounter = 1;

  for (const item of items) {
    const type = item.EmbellishmentType;

    // ── DTF garment row → expand by size ──────────────────────────
    if (type === 'dtf') {
      const sizes = parseSizeBreakdown(item.SizeBreakdown);
      const unitPrice = parseFloat(item.FinalUnitPrice) || 0;
      const colorCode = item.ColorCode || item.Color || '';

      for (const [size, qty] of Object.entries(sizes)) {
        if (!qty || qty <= 0) continue;
        const partNumber = getPartNumber(item.StyleNumber, size);
        const translatedSize = translateSize(size);
        lines.push(buildLineOE({
          lineCounter: lineCounter++,
          partNumber,
          description: item.ProductName || item.StyleNumber || '',
          color: colorCode,
          size: translatedSize,
          qty,
          price: unitPrice,
          designBlock,
        }));
      }
      continue;
    }

    // ── Fee row → route to LinesOE / order-level / notes ──────────
    if (type === 'fee') {
      const pn = String(item.StyleNumber || '').toUpperCase();

      // Order-level fees handled separately
      if (ORDER_LEVEL_FEES.includes(pn)) continue;

      // Known service codes → LinesOE
      if (isKnownFeeCode(item.StyleNumber)) {
        lines.push(buildLineOE({
          lineCounter: lineCounter++,
          partNumber: item.StyleNumber,
          description: item.ProductName || item.StyleNumber || '',
          color: '',
          size: '',
          qty: parseInt(item.Quantity, 10) || 1,
          price: parseFloat(item.FinalUnitPrice) || 0,
          designBlock,
        }));
        continue;
      }

      // Unknown PN → collect as note text
      skippedFeeNotes.push(
        `${item.ProductName || item.StyleNumber || 'Unknown service'}: ` +
        `qty ${item.Quantity || 1} × $${(parseFloat(item.FinalUnitPrice) || 0).toFixed(2)} ` +
        `= $${(parseFloat(item.LineTotal) || 0).toFixed(2)}`
      );
      continue;
    }

    // Unknown EmbellishmentType — skip silently (logged once at route level)
  }

  return { lines, skippedFeeNotes };
}

/**
 * Build a single LineOE record matching ManageOrders schema.
 */
function buildLineOE({ lineCounter, partNumber, description, color, size, qty, price, designBlock }) {
  return {
    PartNumber: partNumber,
    Description: description.substring(0, 255),
    Color: color,
    Size: size,
    Qty: qty,
    Price: Math.round(price * 100) / 100,
    id_ProductClass: DTF_ONSITE_DEFAULTS.id_ProductClass,
    ExtDesignIDBlock: designBlock,
    ExtShipID: 'SHIP-1',
    sts_EnableTax01: 1,
    sts_EnableTax02: 1,
    sts_EnableTax03: 1,
    sts_EnableTax04: 1,
    sts_TaxOverride: 1,
    CustomField01: '',
    CustomField02: '',
    CustomField03: '',
    CustomField04: '',
    CustomField05: '',
  };
}

/**
 * Parse SizeBreakdown JSON string into a {size: qty} object.
 * Returns {} if parsing fails (caller will skip with no lines).
 */
function parseSizeBreakdown(jsonStr) {
  if (!jsonStr) return {};
  try {
    const parsed = JSON.parse(jsonStr);
    return (parsed && typeof parsed === 'object') ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * Build Designs array.
 *
 * If session.GarmentDesignNumber is a valid integer → link via id_Design.
 * Otherwise return empty array (a note is added in buildNotes flagging it).
 */
function buildDesigns(session, items) {
  // Phase 11.1 (2026-05-24): also check Notes.designNumber (picked from
  // customer-design-combobox in the DTF builder), not just legacy
  // session.GarmentDesignNumber column.
  let designNum = parseInt(session.GarmentDesignNumber, 10);
  if (!designNum || designNum <= 0) {
    try {
      const notes = typeof session.Notes === 'string' ? JSON.parse(session.Notes || '{}') : (session.Notes || {});
      const n = parseInt(notes.designNumber, 10);
      if (n && n > 0) designNum = n;
    } catch (_) {
      // Notes might not be JSON for legacy quotes — silently skip
    }
  }
  if (designNum && designNum > 0) {
    return [{ id_Design: designNum }];
  }
  return [];
}

/**
 * Build ShippingAddresses array. ManageOrders expects at least one entry.
 */
function buildShippingAddresses(session) {
  return [{
    ExtShipID: 'SHIP-1',
    Address: session.ShippingAddress || session.Address || '',
    City: session.ShippingCity || session.City || '',
    State: session.ShippingState || session.State || '',
    Zip: session.ShippingZip || session.Zip || '',
    Country: 'US',
  }];
}

/**
 * Build NotesOnOrders array — one note per topic.
 *
 * Topics:
 *   - Sales tax breakdown (rate, amount, GL account)
 *   - DTF breakdown (transfer + labor + freight if session.Notes has it)
 *   - Skipped fee items (unknown PNs)
 *   - Missing design number (if Designs is empty)
 *   - Rep notes (session.SpecialInstructions or similar)
 */
function buildNotes(session, items, skippedFeeNotes, { taxAccountCode, taxAccountDesc }) {
  const notes = [];

  // 1. Tax info (always include for the SW operator)
  const taxRate = parseFloat(session.TaxRate) || 0;
  const taxAmount = parseFloat(session.TaxAmount) || 0;
  const taxText = [
    `Sales tax: ${(taxRate * 100).toFixed(2)}% = $${taxAmount.toFixed(2)}`,
    `Tax account: ${taxAccountCode || 'MANUAL REVIEW'} (${taxAccountDesc})`,
  ].join('\n');
  notes.push({ Type: NOTE_TYPES.Order, Note: taxText });

  // 2. DTF-specific breakdown (if session.Notes has it)
  // session.Notes is a free-text field where the DTF builder may have
  // stored transfer/labor/freight detail. Surface it to the operator.
  if (session.Notes && String(session.Notes).trim()) {
    notes.push({
      Type: NOTE_TYPES.Order,
      Note: `DTF detail: ${String(session.Notes).trim().substring(0, 500)}`,
    });
  }

  // 3. Skipped fee items (unrecognized PNs)
  if (skippedFeeNotes.length > 0) {
    notes.push({
      Type: NOTE_TYPES.Order,
      Note: 'Order notes (services with unrecognized part numbers — review manually):\n' +
            skippedFeeNotes.join('\n'),
    });
  }

  // 4. Missing design link
  if (!session.GarmentDesignNumber || parseInt(session.GarmentDesignNumber, 10) <= 0) {
    notes.push({
      Type: NOTE_TYPES.Art,
      Note: '** NO DESIGN LINKED ** — design number not provided in DTF quote. ' +
            'Operator must assign design in SW before production.',
    });
  }

  // 5. Customer-facing special instructions (if present)
  if (session.SpecialInstructions && String(session.SpecialInstructions).trim()) {
    notes.push({
      Type: NOTE_TYPES.Production,
      Note: String(session.SpecialInstructions).trim().substring(0, 500),
    });
  }

  return notes;
}

module.exports = {
  transformQuoteToOrder,
  // Exported for test / debug
  splitName,
  extractOrderLevelFees,
  buildLinesOE,
  buildDesigns,
  buildNotes,
};
