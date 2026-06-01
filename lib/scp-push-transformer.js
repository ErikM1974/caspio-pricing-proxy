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
  getQuoteYear,
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
/**
 * Normalize a tax rate to a decimal fraction. The SCP quote-service stores the
 * rate as a percentage (10.1); getTaxAccount + the EMB/DTF pattern expect a
 * decimal (0.101). Accept either — values > 1 are treated as percentages.
 * Mirrors the identical helper in dtf-push-transformer.js.
 */
function toRateDecimal(raw) {
  const n = parseFloat(raw) || 0;
  return n > 1 ? n / 100 : n;
}

function transformQuoteToOrder(session, items, options = {}) {
  const { isTest = false } = options;
  const extOrderId = generateScpExtOrderID(session.QuoteID, isTest, getQuoteYear(session));

  const { firstName, lastName } = splitName(session.CustomerName || '');

  // Order-level fees: the SCP quote-service stores shipping + discount as SESSION
  // fields (NOT as SHIP/DISCOUNT fee line items the way EMB does), so read them
  // from the session. extractOrderLevelFees(items) is kept as a fallback for the
  // rare case a future SCP save emits real fee rows.
  const { shippingTotal: itemShip, discountTotal: itemDisc } = extractOrderLevelFees(items);
  const shippingTotal = (parseFloat(session.ShippingFee) || 0) || itemShip;
  const discountTotal = (parseFloat(session.Discount) || 0) || itemDisc;

  // Garment lines + synthesized fee lines (setup / LTM / art / design / rush).
  // The SCP quote-service does NOT persist these as quote_items, so they are
  // rebuilt from session fields here — otherwise the pushed order under-bills.
  const designBlock = `G-${String(session.QuoteID || '').split('-').pop() || '0'}`;
  const { lines: garmentLines, skippedFeeNotes } = buildLinesOE(session, items);
  const feeLines = buildFeeLines(session, designBlock);
  const linesOE = [...garmentLines, ...feeLines];
  const designs = buildDesigns(session, items);
  const shippingAddresses = buildShippingAddresses(session);

  // The SCP quote-service stores TaxRate as a PERCENT (e.g. 10.1). getTaxAccount()
  // and the tax note both expect a DECIMAL (0.101). toRateDecimal() mirrors the
  // DTF transformer's helper so the two behave identically.
  const taxRate = toRateDecimal(session.TaxRate);
  const taxAmount = parseFloat(session.TaxAmount) || 0;
  const shipState = session.ShipToState || '';
  const { accountCode: taxAccountCode, description: taxAccountDesc } =
    getTaxAccount(taxRate, shipState);

  const notes = buildNotes(session, items, skippedFeeNotes, {
    taxAccountCode,
    taxAccountDesc,
    taxRate,
    taxAmount,
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
    // ManageOrders /onsite/order-push reads order-level notes under `Notes`
    // (proven by manageorders-push-client.js:241 + the EMB transformer). The
    // earlier `NotesOnOrders` key was silently dropped by the API — tax account,
    // NO-DESIGN-LINKED flag, screen-print spec + special instructions never
    // reached the SW operator. (Fixed 2026-06-01.)
    Notes: notes,
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

/**
 * Synthesize fee LinesOE from saved SESSION fields.
 *
 * The SCP quote-service stores setup, LTM, art, graphic-design and rush as
 * session columns / Notes JSON — NOT as quote_items fee rows (unlike EMB). So
 * the push has to rebuild them here, or the ShopWorks order total comes out
 * lower than the customer quote. PartNumbers match EMB's KNOWN_FEE_PNS so they
 * land on configured OnSite service records and itemize consistently with EMB.
 *
 * Pricing-model note: in LTM_Display_Mode='builtin' (the default) the LTM is
 * already distributed into each garment's FinalUnitPrice, so the LTM line is
 * emitted ONLY in 'separate' mode — emitting it in builtin mode would double-bill.
 */
function buildFeeLines(session, designBlock) {
  const lines = [];

  let notes = {};
  try {
    notes = typeof session.Notes === 'string' ? JSON.parse(session.Notes || '{}') : (session.Notes || {});
  } catch (_) {
    notes = {};
  }

  // 1. Screen setup (SPSU) — $30 per screen. Prefer the authoritative values the
  //    SCP service writes into Notes; fall back to deriving from the color counts.
  const setupTotal = parseFloat(notes.setupFeeTotal) || 0;
  let screens = parseInt(notes.totalScreens, 10) || 0;
  if (!screens && setupTotal > 0) screens = Math.round(setupTotal / 30);
  if (!screens) screens = deriveScreenCountFromNotes(notes);
  if (screens > 0) {
    lines.push(buildLineOE({
      partNumber: 'SPSU',
      description: `New Screen Set Up Charge (${screens} screen${screens === 1 ? '' : 's'} × $30)`,
      color: '', size: '', qty: screens, price: 30, designBlock,
    }));
  }

  // 2. LTM — separate-line mode only (builtin already baked into garment price).
  const ltmMode = String(session.LTM_Display_Mode || 'builtin').toLowerCase();
  const ltmTotal = parseFloat(session.LTMFeeTotal) || 0;
  if (ltmMode === 'separate' && ltmTotal > 0) {
    lines.push(buildLineOE({
      partNumber: 'LTM', description: 'Less Than Minimum Fee',
      color: '', size: '', qty: 1, price: ltmTotal, designBlock,
    }));
  }

  // 3. Art charge (Logo Mockup & Review).
  const art = parseFloat(session.ArtCharge) || 0;
  if (art > 0) {
    lines.push(buildLineOE({
      partNumber: 'Art', description: 'Logo Mockup & Review',
      color: '', size: '', qty: 1, price: art, designBlock,
    }));
  }

  // 4. Graphic design ($75/hr). Qty=1 at the full charge avoids fractional-hour
  //    quantities (e.g. 0.5 hr) that OnSite line items reject; hours go in the desc.
  const gdCharge = parseFloat(session.GraphicDesignCharge) || 0;
  const gdHours = parseFloat(session.GraphicDesignHours) || 0;
  if (gdCharge > 0) {
    lines.push(buildLineOE({
      partNumber: 'GRT-75',
      description: gdHours > 0 ? `Graphic Design (${gdHours} hr × $75)` : 'Graphic Design',
      color: '', size: '', qty: 1, price: gdCharge, designBlock,
    }));
  }

  // 5. Rush fee.
  const rush = parseFloat(session.RushFee) || 0;
  if (rush > 0) {
    lines.push(buildLineOE({
      partNumber: 'RUSH', description: 'Rush Fee',
      color: '', size: '', qty: 1, price: rush, designBlock,
    }));
  }

  return lines;
}

/**
 * Fallback screen-count derivation from the Notes print-setup block when the
 * SCP service did not persist setupFeeTotal/totalScreens (older saved quotes).
 * Each ink color = 1 screen; a dark garment adds 1 underbase screen per printed
 * location.
 */
function deriveScreenCountFromNotes(notes) {
  const fc = parseInt(notes.frontColors, 10) || 0;
  const bc = parseInt(notes.backColors, 10) || 0;
  let screens = fc + bc;
  if (notes.isDarkGarment) screens += (fc > 0 ? 1 : 0) + (bc > 0 ? 1 : 0);
  return screens;
}

/**
 * Build a human-readable screen-print spec line from the Notes JSON for the SW
 * operator (locations, colors, dark-garment underbase, safety stripes).
 * Returns '' when nothing useful can be parsed.
 */
function formatScreenPrintSpec(rawNotes) {
  if (!rawNotes) return '';
  let n = {};
  try {
    n = typeof rawNotes === 'string' ? JSON.parse(rawNotes || '{}') : (rawNotes || {});
  } catch (_) {
    return '';
  }
  const parts = [];
  const fc = parseInt(n.frontColors, 10) || 0;
  const bc = parseInt(n.backColors, 10) || 0;
  if (n.frontLocation || fc) parts.push(`Front: ${n.frontLocation || '?'} (${fc}c)`);
  if (n.backLocation || bc) parts.push(`Back: ${n.backLocation} (${bc}c)`);
  if (!parts.length) return '';
  let spec = `Screen Print — ${parts.join(', ')}`;
  if (n.isDarkGarment) spec += ' • dark garment (white underbase)';
  if (n.hasSafetyStripes) spec += ' • safety stripes';
  return spec;
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
    // Ink-color count for the SW operator (front + back), from the saved Notes.
    const totalColors = (parseInt(notes.frontColors, 10) || 0) + (parseInt(notes.backColors, 10) || 0);
    const seq = String(session.QuoteID || '').split('-').pop() || '0';
    const locations = hostedFiles.map((f, i) => ({
      Location: f.placement || 'Front',
      ImageURL: f.hostedUrl,
      DesignCode: `SCP-${i + 1}`,
      TotalColors: totalColors ? String(totalColors) : '',
      Notes: f.fileName || '',
    }));
    return [{
      DesignName: newName.substring(0, 100), // MO reads `DesignName`, not `name` (push-client:446) — fixed 2026-06-01
      // Stable ref so the garment lines (ExtDesignIDBlock 'G-<seq>') link to this
      // new design instead of a dead reference (2026-06-01).
      ExtDesignID: `G-${seq}`,
      // Screen Print design type ID in ShopWorks's taxonomy (1 — per server.js
      // DESIGN_TYPE_ID at pricing-indexfile-2025/server.js:2798).
      id_DesignType: 1,
      Locations: locations,
    }];
  }

  // === Branch 3: nothing linked ===
  return [];
}

/**
 * Build ShippingAddresses array.
 *
 * Schema + source columns MUST match the EMB/DTF transformers and the
 * ManageOrders /onsite schema: the API reads `ShipAddress01/ShipCity/...`,
 * NOT `Address/City/...`, and the SCP quote-service saves the address under
 * `ShipToAddress/ShipToCity/ShipToState/ShipToZip` + `ShipMethod`
 * (screenprint-quote-service.js:142-146). The earlier version read
 * `session.ShippingAddress/Address` (columns that don't exist) and emitted the
 * wrong field names — so every SCP order imported with a blank ship-to.
 * (Fixed 2026-06-01.)
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

function buildNotes(session, items, skippedFeeNotes, { taxAccountCode, taxAccountDesc, taxRate = 0, taxAmount = 0 }) {
  const notes = [];

  // 1. Tax info (taxRate arrives already normalized to a decimal from the caller)
  notes.push({
    Type: NOTE_TYPES.ORDER,
    Note:
      `Sales tax: ${(taxRate * 100).toFixed(2)}% = $${taxAmount.toFixed(2)}\n` +
      `Tax account: ${taxAccountCode || 'MANUAL REVIEW'} (${taxAccountDesc})`,
  });

  // 2. Screen-print spec summary parsed from the Notes JSON (locations, colors,
  //    dark-garment underbase, safety stripes). Falls back silently if unparsable.
  const spec = formatScreenPrintSpec(session.Notes);
  if (spec) {
    notes.push({ Type: NOTE_TYPES.ORDER, Note: spec });
  }

  // 3. Skipped fee items
  if (skippedFeeNotes.length > 0) {
    notes.push({
      Type: NOTE_TYPES.ORDER,
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
      Type: NOTE_TYPES.ART,
      Note:
        '** NO DESIGN LINKED ** — design number not provided in SCP quote. ' +
        'Operator must assign design + screen films in SW before production.',
    });
  }

  // 5. Customer-facing special instructions
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
  splitName,
  extractOrderLevelFees,
  buildLinesOE,
  buildFeeLines,
  buildDesigns,
  buildNotes,
};
