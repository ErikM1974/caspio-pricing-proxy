/**
 * SCP (Screen Print) Push Transformer
 *
 * Transforms saved SCP quote data (quote_sessions + quote_items) into
 * ManageOrders ExternalOrderJson format for the PUSH API.
 *
 * Same pattern as DTF transformer but routes 'screenprint' EmbellishmentType
 * and recognizes SCP-specific service codes (SPSU = new screen, SPRESET =
 * reused screen, LTM) that the SCP builder may save as separate fee rows.
 *
 * Pricing model for the line items (matches what reps see on the quote):
 *   - Garment row → expanded into per-size LinesOE at FinalUnitPrice
 *     (all-in: shirt + print + flash + per-piece distributed setup +
 *     per-piece distributed LTM, already rounded by the pricing service)
 *   - Setup fee row (PartNumber: SPSU or SPRESET) → its own LineOE
 *     (Qty = color count, Price = $30 per screen — itemized so the SW
 *     operator sees the setup cost broken out, matches the customer quote)
 *   - LTM fee row (PartNumber: LTM) → its own LineOE
 *     (Qty=1, Price = $75 at qty 13-36 or $50 at qty 37-71)
 *   - TAX / SHIP / DISCOUNT → order-level fields
 *
 * Created 2026-05-23 — Phase 8.
 */

const {
  SCP_ONSITE_DEFAULTS,
  ORDER_LEVEL_FEES,
  getTaxAccount,
  generateScpExtOrderID,
  getSalesRepName,
  formatDateForAPI,
  translateSize,
  NOTE_TYPES,
} = require('../config/manageorders-scp-config');

// Reuse fee-routing logic from EMB config (shared service codes)
// SPSU + SPRESET + LTM are already in EMB's KNOWN_FEE_PNS.
const { isKnownFeeCode } = require('../config/manageorders-emb-config');

const { getPartNumber } = require('../config/size-suffix-config');

/**
 * Transform a saved SCP quote into ManageOrders ExternalOrderJson.
 *
 * @param {Object} session — quote_sessions record from Caspio
 * @param {Array<Object>} items — quote_items records from Caspio
 * @param {Object} options
 * @param {boolean} options.isTest — Prefix ExtOrderID with TEST-
 * @returns {Object} ExternalOrderJson ready for ManageOrders PUSH API
 */
function transformQuoteToOrder(session, items, options = {}) {
  const { isTest = false } = options;
  const extOrderId = generateScpExtOrderID(session.QuoteID, isTest);

  const { firstName, lastName } = splitName(session.CustomerName || '');
  const { shippingTotal, discountTotal } = extractOrderLevelFees(items);
  const { lines: linesOE, skippedFeeNotes } = buildLinesOE(session, items);
  const designs = buildDesigns(session, items);
  const shippingAddresses = buildShippingAddresses(session);

  const taxRate = parseFloat(session.TaxRate) || 0;
  const taxAmount = parseFloat(session.TaxAmount) || 0;
  const shipState = session.ShipToState || '';
  const { accountCode: taxAccountCode, description: taxAccountDesc } =
    getTaxAccount(taxRate, shipState);

  const notes = buildNotes(session, items, skippedFeeNotes, {
    taxAccountCode,
    taxAccountDesc,
  });

  return {
    ExtOrderID: extOrderId,
    ExtSource: SCP_ONSITE_DEFAULTS.ExtSource,
    ExtCustomerID: String(session.CustomerNumber || ''),
    ExtCustomerPref: SCP_ONSITE_DEFAULTS.ExtCustomerPref,

    date_OrderPlaced: formatDateForAPI(session.DateOrderPlaced),
    date_OrderRequestedToShip: formatDateForAPI(session.ReqShipDate),
    date_OrderDropDead: formatDateForAPI(session.DropDeadDate),

    id_OrderType: SCP_ONSITE_DEFAULTS.id_OrderType,
    id_EmpCreatedBy: SCP_ONSITE_DEFAULTS.id_EmpCreatedBy,
    id_Customer: parseInt(session.CustomerNumber, 10) || SCP_ONSITE_DEFAULTS.id_Customer,
    id_CompanyLocation: SCP_ONSITE_DEFAULTS.id_CompanyLocation,

    ContactEmail: session.CustomerEmail || '',
    ContactNameFirst: firstName,
    ContactNameLast: lastName,
    ContactPhone: session.Phone || '',

    CustomerPurchaseOrder: session.PurchaseOrderNumber || '',
    CustomerServiceRep: getSalesRepName(session.SalesRepEmail),
    OnHold: SCP_ONSITE_DEFAULTS.AutoHold,
    Terms: session.PaymentTerms || '',

    TaxTotal: 0,
    coa_AccountSalesTax01: taxAccountCode,
    cur_Shipping: shippingTotal,
    TotalDiscounts: Math.abs(discountTotal),

    Designs: designs,
    LinesOE: linesOE,
    NotesOnOrders: notes,
    ShippingAddresses: shippingAddresses,
  };
}

// ──────────────────────────────────────────────────────────────────────────
// Helpers (same pattern as DTF transformer)
// ──────────────────────────────────────────────────────────────────────────

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
 * Build LinesOE entries for SCP.
 *
 * Garment rows (EmbellishmentType='screenprint'):
 *   - Parse SizeBreakdown JSON
 *   - One LineOE per size at FinalUnitPrice (all-in)
 *
 * Fee rows (EmbellishmentType='fee'):
 *   - TAX/SHIP/DISCOUNT → handled at order level, skip here
 *   - Known service codes (incl. SPSU, SPRESET, LTM) → LinesOE
 *   - Unknown PNs → collected as note text
 */
function buildLinesOE(session, items) {
  const lines = [];
  const skippedFeeNotes = [];
  const seq = String(session.QuoteID || '').split('-').pop() || '0';
  const designBlock = `G-${seq}`;

  let lineCounter = 1;

  for (const item of items) {
    const type = item.EmbellishmentType;

    // SCP garment row — expand by size
    if (type === 'screenprint') {
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

    // Fee row routing
    if (type === 'fee') {
      const pn = String(item.StyleNumber || '').toUpperCase();
      if (ORDER_LEVEL_FEES.includes(pn)) continue;

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

      skippedFeeNotes.push(
        `${item.ProductName || item.StyleNumber || 'Unknown service'}: ` +
        `qty ${item.Quantity || 1} × $${(parseFloat(item.FinalUnitPrice) || 0).toFixed(2)} ` +
        `= $${(parseFloat(item.LineTotal) || 0).toFixed(2)}`
      );
      continue;
    }
  }

  return { lines, skippedFeeNotes };
}

function buildLineOE({ lineCounter, partNumber, description, color, size, qty, price, designBlock }) {
  return {
    PartNumber: partNumber,
    Description: String(description).substring(0, 255),
    Color: color,
    Size: size,
    Qty: qty,
    Price: Math.round(price * 100) / 100,
    id_ProductClass: SCP_ONSITE_DEFAULTS.id_ProductClass,
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
 * Priority chain (matches DTF + DTG order form patterns):
 *   1. EXISTING design # → [{ id_Design: N }]
 *   2. NEW design with uploaded art (Notes.newDesignName + Notes.referenceArtwork[])
 *      → [{ name, id_DesignType: 1, Locations: [...] }]
 *      ShopWorks creates a new design record on import.
 *   3. NEITHER → []
 *
 * Phase 11.3 (2026-05-24).
 */
function buildDesigns(session, items) {
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
    const locations = hostedFiles.map((f, i) => ({
      Location: f.placement || 'Front',
      ImageURL: f.hostedUrl,
      DesignCode: `SCP-${i + 1}`,
      Notes: f.fileName || '',
    }));
    return [{
      name: newName.substring(0, 100),
      // Screen Print design type ID in ShopWorks's taxonomy (1 — per server.js
      // DESIGN_TYPE_ID at pricing-indexfile-2025/server.js:2798).
      id_DesignType: 1,
      Locations: locations,
    }];
  }

  // === Branch 3: nothing linked ===
  return [];
}

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

function buildNotes(session, items, skippedFeeNotes, { taxAccountCode, taxAccountDesc }) {
  const notes = [];

  // 1. Tax info
  const taxRate = parseFloat(session.TaxRate) || 0;
  const taxAmount = parseFloat(session.TaxAmount) || 0;
  notes.push({
    Type: NOTE_TYPES.Order,
    Note:
      `Sales tax: ${(taxRate * 100).toFixed(2)}% = $${taxAmount.toFixed(2)}\n` +
      `Tax account: ${taxAccountCode || 'MANUAL REVIEW'} (${taxAccountDesc})`,
  });

  // 2. SCP-specific breakdown (color count, locations, dark garment flag)
  // The SCP builder may have stored this in session.Notes
  if (session.Notes && String(session.Notes).trim()) {
    notes.push({
      Type: NOTE_TYPES.Order,
      Note: `Screen Print detail: ${String(session.Notes).trim().substring(0, 500)}`,
    });
  }

  // 3. Skipped fee items
  if (skippedFeeNotes.length > 0) {
    notes.push({
      Type: NOTE_TYPES.Order,
      Note:
        'Order notes (services with unrecognized part numbers — review manually):\n' +
        skippedFeeNotes.join('\n'),
    });
  }

  // 4. Missing design link — only fire when BOTH paths are empty (Phase 11.3).
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
      Type: NOTE_TYPES.Art,
      Note:
        '** NO DESIGN LINKED ** — design number not provided in SCP quote. ' +
        'Operator must assign design + screen films in SW before production.',
    });
  }

  // 5. Customer-facing special instructions
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
  splitName,
  extractOrderLevelFees,
  buildLinesOE,
  buildDesigns,
  buildNotes,
};
