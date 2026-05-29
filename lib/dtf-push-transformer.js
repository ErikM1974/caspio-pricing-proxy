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
  getTaxAccount,
  generateDtfExtOrderID,
  getSalesRepName,
  formatDateForAPI,
  translateSize,
  NOTE_TYPES,
} = require('../config/manageorders-dtf-config');

const { getPartNumber } = require('../config/size-suffix-config');

/**
 * Normalize a tax rate to a decimal fraction. DTF stores the rate as a
 * percentage (10.1); getTaxAccount + the EMB pattern expect a decimal
 * (0.101). Accept either — values > 1 are treated as percentages.
 */
function toRateDecimal(raw) {
  const n = parseFloat(raw) || 0;
  return n > 1 ? n / 100 : n;
}

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

  // Order-level financials (shipping + discount). DTF stores these on the
  // session (ShippingFee / Discount), NOT as fee line items — read the session.
  const { shippingTotal, discountTotal } = extractOrderLevelFees(session);

  // Line items: garment rows (one per size) + session service charges
  // (rush / art / graphic-design) as LinesOE.
  const { lines: linesOE, skippedFeeNotes } = buildLinesOE(session, items);

  // DTF design linking — uses GarmentDesignNumber column on Quote_Sessions
  // if present; otherwise Designs: [] + a note flagging no design
  const designs = buildDesigns(session, items);

  // Shipping address
  const shippingAddresses = buildShippingAddresses(session);

  // Tax account lookup
  const taxRate = toRateDecimal(session.TaxRate);
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
    TotalDiscounts: discountTotal,

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
 * Read shipping + discount from the session for the order-level fields.
 * DTF stores these as session columns (ShippingFee / Discount), not as fee
 * line items. TotalDiscounts is positive (matches the EMB transformer).
 */
function extractOrderLevelFees(session) {
  const shippingTotal = parseFloat(session.ShippingFee) || 0;
  const discountTotal = Math.abs(parseFloat(session.Discount) || 0);
  return { shippingTotal, discountTotal };
}

/**
 * Build LinesOE entries.
 *
 * Garment rows (EmbellishmentType='dtf'):
 *   - Parse SizeBreakdown JSON, expand into one LineOE per size
 *   - Price = FinalUnitPrice (already includes transfer + labor + freight +
 *     margin + LTM)
 *
 * Service charges (rush / art / graphic-design) live on the SESSION, not as
 * items. They map to recognized ShopWorks service part numbers (RUSH, Art) so
 * they land on real service parts in OnSite. SHIP / DISCOUNT / TAX are
 * order-level and handled elsewhere.
 */
function buildLinesOE(session, items) {
  const lines = [];
  const skippedFeeNotes = [];
  const seq = String(session.QuoteID || '').split('-').pop() || '0';
  const designBlock = `G-${seq}`; // Single design block for all garment lines

  let lineCounter = 1;

  // ── Garment rows → one LineOE per size ────────────────────────────
  for (const item of items) {
    if (item.EmbellishmentType !== 'dtf') continue; // DTF quotes store only garment rows as items

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
  }

  // ── Session service charges → LinesOE ─────────────────────────────
  // 'RUSH' and 'Art' are recognized ShopWorks service part numbers
  // (manageorders-emb-config KNOWN_FEE_PNS). Graphic design bills as 'Art'
  // too (distinct description) until a dedicated SW code is confirmed.
  const serviceCharges = [
    { pn: 'RUSH', label: 'Rush Fee', amount: parseFloat(session.RushFee) || 0 },
    { pn: 'Art', label: 'Art Charge', amount: parseFloat(session.ArtCharge) || 0 },
    { pn: 'Art', label: 'Graphic Design', amount: parseFloat(session.GraphicDesignCharge) || 0 },
  ];
  for (const charge of serviceCharges) {
    if (charge.amount <= 0) continue;
    lines.push(buildLineOE({
      lineCounter: lineCounter++,
      partNumber: charge.pn,
      description: charge.label,
      color: '',
      size: '',
      qty: 1,
      price: charge.amount,
      designBlock,
    }));
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
 * Priority chain (matches DTG order form pattern at server.js:2889+):
 *   1. EXISTING DESIGN — session.GarmentDesignNumber (legacy column) OR
 *      Notes.designNumber (Phase 11.1 — picked from combobox). Returns
 *      [{ id_Design: N }]; SW links the order to the existing design.
 *   2. NEW DESIGN with artwork — Notes.newDesignName + Notes.referenceArtwork[]
 *      (Phase 11.3 — uploaded via the rich-mode artwork widget). Returns
 *      [{ name, Locations[{Location, ImageURL, DesignCode, Notes}] }]; SW
 *      creates a brand-new design record with the metadata + images on import.
 *   3. NEITHER — returns []; buildNotes() emits a "** NO DESIGN LINKED **"
 *      flag for the SW operator to assign manually.
 *
 * The two paths are mutually exclusive — the DTF builder's UI gates this:
 * picking an existing # disables the upload widget. If both somehow show up
 * (defensive), the existing # wins (lower risk than fabricating a new design
 * record that conflicts with a real one).
 */
function buildDesigns(session, items) {
  // Parse Notes JSON once for both branches
  let notes = {};
  try {
    notes = typeof session.Notes === 'string' ? JSON.parse(session.Notes || '{}') : (session.Notes || {});
  } catch (_) {
    notes = {};
  }

  // === Branch 1: existing design # ===
  let designNum = parseInt(session.GarmentDesignNumber, 10);
  if (!designNum || designNum <= 0) {
    const n = parseInt(notes.designNumber, 10);
    if (n && n > 0) designNum = n;
  }
  if (designNum && designNum > 0) {
    return [{ id_Design: designNum }];
  }

  // === Branch 2: new design with uploaded artwork ===
  const newName = String(notes.newDesignName || '').trim();
  const refArt = Array.isArray(notes.referenceArtwork) ? notes.referenceArtwork : [];
  const hostedFiles = refArt.filter(f => f && f.hostedUrl);

  if (newName && hostedFiles.length > 0) {
    // One Design[] entry with Locations[] = one entry per uploaded file.
    // ManageOrders / ShopWorks reads Locations[].ImageURL as the artwork
    // attachment and Location as the print position label. DesignCode is
    // the per-location reference the production floor sees (DTF-1, DTF-2,…).
    const locations = hostedFiles.map((f, i) => ({
      Location: f.placement || 'Left Chest',
      ImageURL: f.hostedUrl,
      DesignCode: `DTF-${i + 1}`,
      Notes: f.fileName || '',
    }));

    return [{
      name: newName.substring(0, 100),
      // DTF design type ID — single source of truth is the config default
      // (DTF_ONSITE_DEFAULTS.id_DesignType) so Erik confirms it in ONE place.
      id_DesignType: DTF_ONSITE_DEFAULTS.id_DesignType,
      Locations: locations,
    }];
  }

  // === Branch 3: nothing linked ===
  return [];
}

/**
 * Build ShippingAddresses array. ManageOrders expects at least one entry.
 * Schema mirrors the live EMB transformer so OnSite/ShopWorks reads the
 * address correctly. Falls back to Customer Pickup when no address is given.
 */
function buildShippingAddresses(session) {
  const hasAddress = !!(session.ShipToAddress || session.ShipToCity);
  return [{
    ShipCompany: session.CompanyName || '',
    ShipMethod: session.ShipMethod || 'Customer Pickup',
    ShipAddress01: hasAddress ? (session.ShipToAddress || '') : '',
    ShipAddress02: '',
    ShipCity: hasAddress ? (session.ShipToCity || '') : '',
    ShipState: hasAddress ? (session.ShipToState || '') : '',
    ShipZip: hasAddress ? (session.ShipToZip || '') : '',
    ShipCountry: 'USA',
    ExtShipID: 'SHIP-1',
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
  const taxRate = toRateDecimal(session.TaxRate);
  const taxAmount = parseFloat(session.TaxAmount) || 0;
  const taxText = [
    `Sales tax: ${(taxRate * 100).toFixed(2)}% = $${taxAmount.toFixed(2)}`,
    `Tax account: ${taxAccountCode || 'MANUAL REVIEW'} (${taxAccountDesc})`,
  ].join('\n');
  notes.push({ Type: NOTE_TYPES.ORDER, Note: taxText });

  // 2. Project name + customer special instructions (stored inside the Notes
  // JSON blob). Surface them as clean, separate notes — never raw JSON.
  let blob = {};
  try {
    blob = typeof session.Notes === 'string' ? JSON.parse(session.Notes || '{}') : (session.Notes || {});
  } catch (_) {
    blob = {};
  }
  const projectName = String(blob.projectName || '').trim();
  if (projectName) {
    notes.push({ Type: NOTE_TYPES.ORDER, Note: `Project: ${projectName}` });
  }
  const specialNotes = String(blob.specialNotes || '').trim();
  if (specialNotes) {
    notes.push({ Type: NOTE_TYPES.PRODUCTION, Note: specialNotes.substring(0, 500) });
  }

  // 3. Skipped fee items (unrecognized PNs)
  if (skippedFeeNotes.length > 0) {
    notes.push({
      Type: NOTE_TYPES.ORDER,
      Note: 'Order notes (services with unrecognized part numbers — review manually):\n' +
            skippedFeeNotes.join('\n'),
    });
  }

  // 4. Missing design link — only fire when BOTH paths are empty:
  //    - no existing design # (column or Notes.designNumber), AND
  //    - no new-design name + uploaded artwork (Phase 11.3 path)
  // Otherwise buildDesigns() emitted a valid Designs[] entry and SW is happy.
  let parsedNotes = {};
  try {
    parsedNotes = typeof session.Notes === 'string' ? JSON.parse(session.Notes || '{}') : (session.Notes || {});
  } catch (_) {
    parsedNotes = {};
  }
  const hasExistingDesignNum =
    (parseInt(session.GarmentDesignNumber, 10) > 0) ||
    (parseInt(parsedNotes.designNumber, 10) > 0);
  const hasNewDesignWithArt =
    !!String(parsedNotes.newDesignName || '').trim() &&
    Array.isArray(parsedNotes.referenceArtwork) &&
    parsedNotes.referenceArtwork.some(f => f && f.hostedUrl);
  if (!hasExistingDesignNum && !hasNewDesignWithArt) {
    notes.push({
      Type: NOTE_TYPES.ART,
      Note: '** NO DESIGN LINKED ** — design number not provided in DTF quote. ' +
            'Operator must assign design in SW before production.',
    });
  }

  // 5. Customer-facing special instructions (if present)
  if (session.SpecialInstructions && String(session.SpecialInstructions).trim()) {
    notes.push({
      Type: NOTE_TYPES.PRODUCTION,
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
