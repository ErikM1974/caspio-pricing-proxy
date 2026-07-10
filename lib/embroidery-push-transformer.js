/**
 * Embroidery Push Transformer
 *
 * Transforms saved embroidery quote data (quote_sessions + quote_items)
 * into ManageOrders ExternalOrderJson format for the PUSH API.
 *
 * Data flow:
 *   Caspio quote_sessions + quote_items
 *     → transformQuoteToOrder()
 *       → ExternalOrderJson
 *         → POST /onsite/order-push
 */

const {
  EMB_ONSITE_DEFAULTS,
  ORDER_LEVEL_FEES,
  isKnownFeeCode,
  canonicalFeePN,
  toRateDecimal,
  getTaxAccount,
  buildSalesTaxNote,
  buildAccountingTaxNote,
  extractSequence,
  generateEmbExtOrderID,
  getSalesRepName,
  formatDateForAPI,
  translateSize,
  NOTE_TYPES,
} = require('../config/manageorders-emb-config');
const { swImageUrl, artworkAttachments } = require('./sw-image-url');

const { getPartNumber } = require('../config/size-suffix-config');

/**
 * Transform a saved embroidery quote into ManageOrders ExternalOrderJson
 *
 * @param {Object} session - quote_sessions record from Caspio
 * @param {Array<Object>} items - quote_items records from Caspio
 * @param {Object} options - Optional settings
 * @param {boolean} options.isTest - Prefix ExtOrderID with TEST-
 * @returns {Object} ExternalOrderJson ready for ManageOrders PUSH API
 */
function transformQuoteToOrder(session, items, options = {}) {
  const { isTest = false } = options;
  const extOrderId = generateEmbExtOrderID(session.QuoteID, isTest);

  // Split name on last space: "Shantrell McCloud-Lacroix" → First:"Shantrell", Last:"McCloud-Lacroix"
  const { firstName, lastName } = splitName(session.CustomerName || '');

  // Extract order-level financial values from fee items
  const { shippingTotal, discountTotal } = extractOrderLevelFees(items);

  // Build line items (products, fees, AL, DECG — excluding TAX/SHIP/DISCOUNT)
  // Unrecognized fee PNs are collected as notes instead of line items
  const { lines: linesOE, skippedFeeNotes } = buildLinesOE(session, items);

  // Build design block from LogoSpecs on first product item
  const designs = buildDesigns(session, items);
  // P2 (2026-07-10): every uploaded file also lands in the SW Attachments tab
  const artworkAtts = artworkAttachments(parseImportNotes(session).referenceArtwork);

  // Build shipping address
  const shippingAddresses = buildShippingAddresses(session);

  // Resolve tax account from session data (mirrors InkSoft's get_tax_account pattern).
  // toRateDecimal: EMB saves TaxRate as a decimal (0.101), but a percent-shaped row
  // (hand-edited/imported/legacy) used to blow up as 'Tax Rate: 1010%' + MANUAL REVIEW —
  // same hardening the DTF/SCP transformers already had. (audit 2026-06-10)
  const taxRate = toRateDecimal(session.TaxRate);
  const taxAmount = parseFloat(session.TaxAmount) || 0;
  const shipState = session.ShipToState || '';
  // [2026-06-07] Wholesale / reseller (per-order IsWholesale checkbox) → 0 tax routed to the Wholesale Sales
  // account (2203), regardless of destination rate. A missing/blank field defaults to No (never auto-wholesale).
  const isWholesale = session.IsWholesale === true || session.IsWholesale === 'Yes' || session.IsWholesale === 1
    || session.IsWholesale === '1' || String(session.IsWholesale).toLowerCase() === 'true';
  const { accountCode: taxAccountCode, description: taxAccountDesc, partNumber: taxPartNumber } = isWholesale
    ? { accountCode: '2203', description: 'Wholesale Sales (WA reseller permit — no tax)', partNumber: '' }
    : getTaxAccount(taxRate, shipState);

  // Build notes (includes any skipped fee descriptions + tax account info)
  const notes = buildNotes(session, items, skippedFeeNotes, { taxAccountCode, taxAccountDesc });

  return {
    // Order identification
    ExtOrderID: extOrderId,
    ExtSource: EMB_ONSITE_DEFAULTS.ExtSource,
    // Routes to the OnSite "Manage Orders" integration, whose APISource filter is set
    // to "ManageOrders". That integration imports ONLY orders whose APISource matches
    // exactly — so this MUST be stamped on every push or the order is silently skipped
    // at import. Erik 2026-06-04: "ManageOrders" on everything we push to ShopWorks.
    APISource: 'ManageOrders',
    ExtCustomerID: String(session.CustomerNumber || ''),
    ExtCustomerPref: EMB_ONSITE_DEFAULTS.ExtCustomerPref,

    // Dates
    date_OrderPlaced: formatDateForAPI(session.DateOrderPlaced),
    date_OrderRequestedToShip: formatDateForAPI(session.ReqShipDate),
    date_OrderDropDead: formatDateForAPI(session.DropDeadDate),

    // Internal IDs
    id_OrderType: EMB_ONSITE_DEFAULTS.id_OrderType,
    id_EmpCreatedBy: EMB_ONSITE_DEFAULTS.id_EmpCreatedBy,
    id_Customer: parseInt(session.CustomerNumber) || EMB_ONSITE_DEFAULTS.id_Customer,
    id_CompanyLocation: EMB_ONSITE_DEFAULTS.id_CompanyLocation,

    // Contact
    ContactEmail: session.CustomerEmail || '',
    ContactNameFirst: firstName,
    ContactNameLast: lastName,
    ContactPhone: session.Phone || '',

    // Order details
    CustomerPurchaseOrder: session.PurchaseOrderNumber || '',
    CustomerServiceRep: getSalesRepName(session.SalesRepEmail),
    OnHold: EMB_ONSITE_DEFAULTS.AutoHold,
    Terms: session.PaymentTerms || '',

    // Financial — order-level
    // Tax: TaxTotal stays 0 so OnSite computes the tax from each line's sts_EnableTax flags × the tax part's
    // rate (matches the Python InkSoft pattern; TaxTotal>0 makes MO auto-create unwanted tax line items).
    // [2026-06-07] We now DRIVE the tax line item from the destination rate (TaxPartNumber = "Tax_<rate>",
    // derived in getTaxAccount; account in coa_AccountSalesTax01) instead of letting OnSite fall back to its
    // connection default (Tax_10.1 / Milton). REQUIRES the OnSite connection's "Tax Line Item" field BLANK so
    // our pushed part wins, AND the matching tax part to exist in ShopWorks. partNumber is '' for
    // out-of-state / unknown rate → no tax line (rep applies manually; rate + account are always in Notes).
    TaxTotal: 0,
    TaxPartNumber: taxPartNumber || '',
    TaxPartDescription: taxPartNumber ? taxAccountDesc : '',
    coa_AccountSalesTax01: taxAccountCode, // Auto-fill tax account dropdown in OnSite
    cur_Shipping: shippingTotal,
    TotalDiscounts: discountTotal,

    // Nested arrays
    Designs: designs,
    LinesOE: linesOE,
    Notes: notes,
    ShippingAddresses: shippingAddresses,
    Payments: [],
    Attachments: artworkAtts,
  };
}

/**
 * Split a full name into first and last name on the last space.
 * "Shantrell McCloud-Lacroix" → { firstName: "Shantrell", lastName: "McCloud-Lacroix" }
 * "Madonna" → { firstName: "Madonna", lastName: "" }
 */
function splitName(fullName) {
  const trimmed = (fullName || '').trim();
  if (!trimmed) return { firstName: '', lastName: '' };

  const lastSpace = trimmed.lastIndexOf(' ');
  if (lastSpace === -1) return { firstName: trimmed, lastName: '' };

  return {
    firstName: trimmed.substring(0, lastSpace).trim(),
    lastName: trimmed.substring(lastSpace + 1).trim(),
  };
}

/**
 * Extract SHIP and DISCOUNT totals from fee items (these become order-level fields, NOT LinesOE)
 */
function extractOrderLevelFees(items) {
  let shippingTotal = 0;
  let discountTotal = 0;

  for (const item of items) {
    if (item.EmbellishmentType !== 'fee') continue;
    const pn = (item.StyleNumber || '').toUpperCase();

    if (pn === 'SHIP') {
      shippingTotal += parseFloat(item.LineTotal) || 0;
    } else if (pn === 'DISCOUNT') {
      // Discount stored as negative in quote system, ManageOrders wants positive
      discountTotal += Math.abs(parseFloat(item.LineTotal) || 0);
    }
  }

  return { shippingTotal, discountTotal };
}

/**
 * Build LinesOE array from quote_items.
 * Products are expanded per-size from SizeBreakdown JSON.
 * Fee/AL/DECG items are passed through directly.
 * TAX, SHIP, DISCOUNT are skipped (handled at order level).
 * Unrecognized fee PNs are collected as notes instead of line items.
 *
 * @returns {{ lines: Array, skippedFeeNotes: string[] }}
 */
function buildLinesOE(session, items) {
  const lines = [];
  const skippedFeeNotes = [];

  // Designs attach to the ORDER via id_Design (see buildDesigns). The Designs[]
  // entries carry id_Design (existing designs) — NOT a matching ExtDesignID — so
  // a per-line ExtDesignIDBlock has nothing to resolve to. A live ShopWorks pull
  // (2026-05-29, EMB-TEST-99001) confirmed the design arrives with ExtDesignID=""
  // while lines referenced "G-99001" — a dead reference. Leave the line-level
  // block blank; ShopWorks links the design at the order level via id_Design.
  const garmentDesignId = null;
  const capDesignId = null;

  // Track customer-supplied PNs to avoid duplicates when fee items share the same PN
  const customerSuppliedPNs = new Set();

  for (const item of items) {
    const type = item.EmbellishmentType;

    if (type === 'embroidery') {
      // Product item — expand sizes into individual LinesOE
      const sizeLines = buildProductLines(item, garmentDesignId, capDesignId);
      lines.push(...sizeLines);
    } else if (type === 'embroidery-additional') {
      // AL item — single line
      lines.push(buildServiceLine(item, garmentDesignId, capDesignId));
    } else if (type === 'customer-supplied') {
      // DECG/DECC — single line, linked to design
      customerSuppliedPNs.add((item.StyleNumber || '').toUpperCase());
      lines.push(buildServiceLine(item, garmentDesignId, capDesignId));
    } else if (type === 'monogram') {
      // Legacy 'monogram' EmbellishmentType (embroidery-quote-service.js:541 still writes it
      // for monogram services) — was silently DROPPED from the push (no line, no note, no
      // warning). StyleNumber is already the SW 'Monogram' part; route it through
      // buildServiceLine like the other service items. (audit 2026-06-10)
      lines.push(buildServiceLine(item, garmentDesignId, capDesignId));
    } else if (type === 'fee') {
      // Fee items — skip order-level ones and duplicates of customer-supplied items
      const pn = (item.StyleNumber || '').toUpperCase();
      if (ORDER_LEVEL_FEES.includes(pn)) continue;
      if (customerSuppliedPNs.has(pn)) continue;

      // Unrecognized fee PNs → route to Notes On Order instead of LinesOE.
      // Case-insensitive: ShopWorks part numbers are mixed-case (AS-Garm,
      // Monogram, etc.) but legacy callers may upper/lowercase them.
      // The note is an EXPLICIT "UNBILLED FEE" call-to-action: the pushed order is
      // short by this amount until the rep hand-adds the line in OnSite. (audit 2026-06-10)
      if (!isKnownFeeCode(pn)) {
        skippedFeeNotes.push(buildUnbilledNote(item, 'UNBILLED FEE'));
        continue;
      }

      lines.push(buildServiceLine(item, null, null));
    } else if (type) {
      // Catch-all: an EmbellishmentType this transformer doesn't recognize must NEVER
      // vanish silently (the old switch dropped legacy 'monogram' items with no trace).
      // Surface it as an explicit UNBILLED note so the rep sees the missing dollars. (audit 2026-06-10)
      skippedFeeNotes.push(buildUnbilledNote(item, `UNBILLED ITEM [${type}]`));
    }
  }

  return { lines, skippedFeeNotes };
}

/**
 * Build an explicit "UNBILLED" note line for an item that could not be routed to
 * LinesOE (unknown fee PN / unrecognized EmbellishmentType). The wording is a
 * call-to-action — the pushed ShopWorks order is SHORT by this amount until the
 * rep adds the line manually in OnSite. (audit 2026-06-10)
 *
 * @param {Object} item - quote_items record
 * @param {string} label - e.g. 'UNBILLED FEE' or 'UNBILLED ITEM [monogram]'
 * @returns {string}
 */
function buildUnbilledNote(item, label) {
  const desc = item.ProductName || item.StyleNumber || 'Unknown fee';
  const qty = parseFloat(item.Quantity) || 1;
  const price = parseFloat(item.FinalUnitPrice) || 0;
  const total = parseFloat(item.LineTotal) || price * qty;
  const money = total > 0
    ? ` $${total.toFixed(2)}${qty > 1 ? ` (${qty} x $${price.toFixed(2)})` : ''}`
    : '';
  return `${label} — add manually: ${desc}${money}`;
}

/**
 * Build LinesOE entries for a product item by expanding SizeBreakdown JSON.
 * Each size gets its own LinesOE entry.
 *
 * SizeBreakdown format: {"S":6,"M":6,"L":6,"XL":4}
 */
function buildProductLines(item, garmentDesignId, capDesignId) {
  const lines = [];
  let sizeBreakdown = {};

  try {
    sizeBreakdown = JSON.parse(item.SizeBreakdown || '{}');
  } catch {
    // Fallback: if SizeBreakdown isn't valid JSON, create single entry with total qty
    sizeBreakdown = {};
  }

  // Determine if this is a cap product (for design linking)
  const isCap = isCapProduct(item);
  const designId = isCap ? capDesignId : garmentDesignId;

  const sizeEntries = Object.entries(sizeBreakdown).filter(
    ([key]) => !['type', 'serviceType', 'logoPosition', 'stitchCount'].includes(key)
  );

  if (sizeEntries.length > 0) {
    // Expand each size into a separate LinesOE entry
    for (const [size, qty] of sizeEntries) {
      if (!qty || qty <= 0) continue;

      let translatedSize;
      try {
        translatedSize = translateSize(size);
      } catch {
        translatedSize = size;
      }

      lines.push({
        // Base PN ONLY — SW Size Translation Table appends the modifier (_2X, _OSFA, …)
        // from Size on ingest; pre-suffixing double-stamps it (C112_OSFA_OSFA). Matches
        // the no-size fallback below. Verified vs the live SW table 2026-06-02.
        PartNumber: item.StyleNumber || '',
        Description: item.ProductName || '',
        Color: item.ColorCode || item.Color || '',
        Size: translatedSize,
        Qty: String(qty),
        Price: String(parseFloat(item.FinalUnitPrice) || 0),
        id_ProductClass: EMB_ONSITE_DEFAULTS.id_ProductClass,
        ExtDesignIDBlock: designId || '',
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
        NameFirst: '',
        NameLast: '',
        LineItemNotes: '',
        WorkOrderNotes: '',
        DesignIDBlock: '',
        DisplayAsPartNumber: '',
        DisplayAsDescription: '',
      });
    }
  } else {
    // No size breakdown — safety net for broken data
    // Real OSFA products have {"OSFA":5} in SizeBreakdown → go through normal loop above
    // Don't append _OSFA here — would create invalid PNs like J790_OSFA
    lines.push({
      PartNumber: item.StyleNumber || '',
      Description: item.ProductName || '',
      Color: item.ColorCode || item.Color || '',
      Size: 'OSFA',
      Qty: String(parseInt(item.Quantity) || 1),
      Price: String(parseFloat(item.FinalUnitPrice) || 0),
      id_ProductClass: EMB_ONSITE_DEFAULTS.id_ProductClass,
      ExtDesignIDBlock: designId || '',
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
      NameFirst: '',
      NameLast: '',
      LineItemNotes: '',
      WorkOrderNotes: '',
      DesignIDBlock: '',
      DisplayAsPartNumber: '',
      DisplayAsDescription: '',
    });
  }

  return lines;
}

/**
 * Build a single LinesOE entry for service/fee/AL/DECG items
 */
function buildServiceLine(item, garmentDesignId, capDesignId) {
  // Link service items to the appropriate design
  let designId = '';
  if (item.EmbellishmentType === 'embroidery-additional') {
    const pn = (item.StyleNumber || '').toUpperCase();
    const isCapAL = ['AL-CAP', 'CB', 'CS'].includes(pn);
    designId = isCapAL ? (capDesignId || '') : (garmentDesignId || '');
  } else if (item.EmbellishmentType === 'customer-supplied') {
    // DECG → garment design, DECC → cap design
    const pn = (item.StyleNumber || '').toUpperCase();
    if (pn.startsWith('DECC')) {
      designId = capDesignId || garmentDesignId || '';
    } else {
      designId = garmentDesignId || capDesignId || '';
    }
  }

  return {
    // Canonical-case PN: the isKnownFeeCode gate is case-insensitive, but ShopWorks part
    // matching is case-sensitive on the receiving end — 'CTR-GARMT' (builder Add Service
    // casing) must be SENT as 'CTR-Garmt' to land on the configured part record. Aliases
    // (FB → DECG-FB, Name/Number → Monogram) also resolve here. Unknown PNs (DECG/DECC
    // variants etc. that aren't in KNOWN_FEE_PNS) pass through verbatim. (audit 2026-06-10)
    PartNumber: canonicalFeePN(item.StyleNumber) || item.StyleNumber || '',
    Description: item.ProductName || '',
    Color: '',
    // Size 'S' (not '') so service/charge lines (AL, AL-CAP, fees) land in the Size-01 / "S" column in
    // ShopWorks instead of 3XL. OnSite's Size Translation Table routes empty/unmatched sizes via the
    // "All Other Sizes" row → XXXL; the "S" row has a BLANK part-number modifier, so the qty drops into
    // column 01 and the part number stays unchanged (no AL_S). Erik wants additional-logo + charge lines
    // in the small column (verified vs the live OnSite size-translation table 2026-06-07).
    Size: 'S',
    Qty: String(parseFloat(item.Quantity) || 1),  // parseFloat (not parseInt): fractional fee hours (e.g. 1.5 GRT-75) must not truncate to 1 → silent under-bill (review C1 2026-06-05)
    Price: String(parseFloat(item.FinalUnitPrice) || 0),
    id_ProductClass: EMB_ONSITE_DEFAULTS.id_ProductClass,
    ExtDesignIDBlock: designId,
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
    NameFirst: '',
    NameLast: '',
    LineItemNotes: '',
    WorkOrderNotes: '',
    DesignIDBlock: '',
    DisplayAsPartNumber: '',
    DisplayAsDescription: '',
  };
}

/**
 * Check if a product item is a cap (for design linking)
 */
function isCapProduct(item) {
  const name = (item.ProductName || '').toLowerCase();
  const style = (item.StyleNumber || '').toLowerCase();
  const location = (item.PrintLocation || '').toLowerCase();

  // Cap-specific locations
  if (location.includes('cap') || location.includes('hat')) return true;

  // Cap-specific part number patterns
  if (/^(c8\d{2}|ne\d{3}|cp\d{2}|stc\d{2}|c112|c865|c870|c922)/i.test(style)) return true;

  // Cap in product name (but not "capsule" or "escape")
  if (/\b(cap|hat|beanie|visor|snapback)\b/i.test(name) && !/capsule|escape/i.test(name)) {
    // Flat headwear (beanies, knit caps) uses garment pricing, NOT cap pricing
    // But for design linking purposes, they're still cap designs if they have cap locations
    return false;
  }

  return false;
}

/**
 * Build the Designs array from session design numbers.
 *
 * When a design number is known (from Digitized_Designs lookup), uses the simple
 * InkSoft pattern: just {id_Design: N}. ShopWorks links to the existing design
 * without creating a duplicate.
 *
 * When no design number is available, sends empty Designs: [].
 * The sales rep will manually link/create the design in ShopWorks.
 * ManageOrders accepts orders without designs.
 */
/**
 * Parse session.ImportNotes — handles BOTH shapes:
 *   - Legacy: `[]` (array of import warning strings)
 *   - Phase 11.3 (2026-05-24): `{importNotes:[], referenceArtwork:[], newDesignName:''}`
 * Returns the object form. Empty/missing → {importNotes:[], referenceArtwork:[], newDesignName:''}.
 */
function parseImportNotes(session) {
  const empty = { importNotes: [], referenceArtwork: [], newDesignName: '' };
  if (!session.ImportNotes) return empty;
  try {
    const parsed = typeof session.ImportNotes === 'string'
      ? JSON.parse(session.ImportNotes)
      : session.ImportNotes;
    if (Array.isArray(parsed)) {
      // Legacy: import warnings only, no artwork data
      return { importNotes: parsed, referenceArtwork: [], newDesignName: '' };
    }
    if (parsed && typeof parsed === 'object') {
      return {
        importNotes: Array.isArray(parsed.importNotes) ? parsed.importNotes : [],
        referenceArtwork: Array.isArray(parsed.referenceArtwork) ? parsed.referenceArtwork : [],
        newDesignName: String(parsed.newDesignName || ''),
      };
    }
    return empty;
  } catch (_) {
    return empty;
  }
}


/**
 * Design-level ForProductColor per the documented contract
 * (MANAGEORDERS_COMPLETE_REFERENCE §Designs, proven on OF-0025):
 * CATALOG_COLOR codes (not display names), comma-separated, listing ALL
 * distinct colors the design covers.
 */
function designProductColors(items) {
  return [...new Set(
    (items || [])
      .map((it) => String(it.ColorCode || it.Color || '').trim())
      .filter(Boolean)
  )].join(', ');
}

function buildDesigns(session, items) {
  const designs = [];

  const garmentDesignNumber = session.GarmentDesignNumber || '';
  const capDesignNumber = session.CapDesignNumber || '';

  // Branch 1: existing designs by # (garment + cap separately, since EMB
  // can have one design on the garment and another on caps in the same order).
  const hasGarmentDesignNum = garmentDesignNumber && /^\d+$/.test(garmentDesignNumber);
  const hasCapDesignNum = capDesignNumber && /^\d+$/.test(capDesignNumber);
  // P2-10 (audit 2026-06-06): dedup — when the SAME design # is on both garments and caps, pushing two
  // {id_Design} entries with the same value double-links the design in ShopWorks. Collect into a Set.
  const _designIds = new Set();
  if (hasGarmentDesignNum) _designIds.add(parseInt(garmentDesignNumber));
  if (hasCapDesignNum) _designIds.add(parseInt(capDesignNumber));
  _designIds.forEach((id) => designs.push({ id_Design: id }));

  // Branch 2: NEW design with uploaded artwork (Phase 11.3, 2026-05-24).
  // Only fires when the rep didn't pick an existing # AND uploaded files
  // through the rich-mode artwork widget AND typed a design name. The
  // newly-emitted design joins the existing-design entries above (an order
  // can have both — e.g. legacy garment design # + a new cap design).
  const notes = parseImportNotes(session);
  const newName = notes.newDesignName.trim();
  // P1-9 (audit 2026-06-06): MUTUAL EXCLUSION — when a surface already has an existing Design # (Branch 1),
  // drop the uploaded files for THAT surface, so a rep who set a Design # AND uploaded artwork doesn't push
  // BOTH an {id_Design} and a duplicate new {DesignName} for the same logo. Per-surface: a garment # covers
  // garment files, a cap # covers cap files (the legitimate "garment # + new cap design" still works).
  const _isCapFile = (f) => { const p = String(f.placement || '').toLowerCase(); return p.includes('cap') || p.includes('hat') || p.includes('beanie'); };
  const hostedFiles = notes.referenceArtwork
    .filter(f => f && f.hostedUrl)
    .filter(f => _isCapFile(f) ? !hasCapDesignNum : !hasGarmentDesignNum);

  if (newName && hostedFiles.length > 0) {
    // Carry the rep's stitch estimate onto the design so production sees it on
    // the design record, not just in a note. Cap placements use CapStitchCount.
    // (2026-06-01)
    const garmentStitches = String(session.StitchCount || '');
    const capStitches = String(session.CapStitchCount || session.StitchCount || '');
    const locations = hostedFiles.map((f, i) => {
      const pos = String(f.placement || '').toLowerCase();
      const isCapLoc = pos.includes('cap') || pos.includes('hat') || pos.includes('beanie');
      return {
        Location: f.placement || 'Left Chest',
        ImageURL: swImageUrl(f.hostedUrl), // P2: ≤2MB JPEG variant — OnSite drops >2MB silently
        DesignCode: `EMB-${i + 1}`,
        TotalStitches: isCapLoc ? capStitches : garmentStitches,
        Notes: f.fileName || '',
      };
    });
    designs.push({
      DesignName: newName.substring(0, 100), // MO reads `DesignName`, not `name` (push-client:446) — fixed 2026-06-01
      // Stable external ref for this new design (2026-06-01).
      ExtDesignID: `G-${String(session.QuoteID || '0')}`,
      // Embroidery design type ID in ShopWorks's taxonomy
      // (per pricing-indexfile-2025/server.js:2798 DESIGN_TYPE_ID).
      id_DesignType: 2,
      ForProductColor: designProductColors(items),
      Locations: locations,
    });
  }

  // If everything's empty, return []. Sales rep assigns design manually in SW.
  return designs;
}

// --- Retained for future use (no longer called by buildDesigns after 2026-02-23 simplification) ---

/**
 * Extract LogoSpecs and first product color from items
 */
function extractLogoInfo(items) {
  let logoSpecs = null;
  const firstProduct = items.find(i => i.EmbellishmentType === 'embroidery' && i.LogoSpecs);
  if (firstProduct) {
    try {
      logoSpecs = JSON.parse(firstProduct.LogoSpecs);
    } catch {
      logoSpecs = null;
    }
  }
  const firstProductColor = firstProduct ? (firstProduct.Color || '') : '';
  return { logoSpecs, firstProductColor };
}

/**
 * Build a single Design entry (garment or cap)
 */
function buildSingleDesign({ quoteId, designNumber, designType, productColor, logoSpecs, session }) {
  const isGarment = designType === 'garment';
  // Full QuoteID (not just the trailing sequence) so designs are globally
  // unique — extractSequence collided across methods/days (DTF0601-1 vs
  // DTF0602-1, EMB-2026-5 vs DTF0601-5 → all G-5), merging designs in SW
  // (a Transfer order showed an Embroidery design). Fixed 2026-06-02.
  const seq = String(quoteId || '0');
  const extDesignId = isGarment ? `G-${seq}` : `C-${seq}`;
  const label = isGarment ? 'Garment' : 'Cap';

  // Build locations from LogoSpecs
  const locations = [];

  if (logoSpecs && Array.isArray(logoSpecs.logos)) {
    for (const logo of logoSpecs.logos) {
      const pos = (logo.pos || '').toLowerCase();
      const isCapLocation = pos.includes('cap') || pos.includes('hat');

      // Filter: garment design gets non-cap locations, cap design gets cap locations
      if (isGarment && isCapLocation) continue;
      if (!isGarment && !isCapLocation) continue;

      locations.push({
        Location: logo.pos || '',
        TotalColors: '',
        TotalFlashes: '',
        TotalStitches: String(logo.stitch || 0),
        DesignCode: designNumber,
        CustomField01: '',
        CustomField02: '',
        CustomField03: '',
        CustomField04: '',
        CustomField05: '',
        ImageURL: '',
        Notes: '',
        LocationDetails: [],
      });
    }
  }

  // If no locations from LogoSpecs, create a default from session fields
  if (locations.length === 0) {
    const defaultLocation = isGarment
      ? (session.PrintLocation || 'Left Chest')
      : (session.CapPrintLocation || 'Cap Front');
    const defaultStitches = isGarment
      ? (session.StitchCount || 8000)
      : (session.CapStitchCount || 5000);

    locations.push({
      Location: defaultLocation,
      TotalColors: '',
      TotalFlashes: '',
      TotalStitches: String(defaultStitches),
      DesignCode: designNumber,
      CustomField01: '',
      CustomField02: '',
      CustomField03: '',
      CustomField04: '',
      CustomField05: '',
      ImageURL: '',
      Notes: '',
      LocationDetails: [],
    });
  }

  const designName = designNumber
    ? `${label} Design #${designNumber}`
    : `${label} Design - ${quoteId}`;

  return {
    DesignName: designName,
    ExtDesignID: extDesignId,
    id_Design: 0,
    id_DesignType: EMB_ONSITE_DEFAULTS.id_DesignType,
    id_Artist: EMB_ONSITE_DEFAULTS.id_Artist,
    ForProductColor: productColor,
    VendorDesignID: '',
    CustomField01: '',
    CustomField02: '',
    CustomField03: '',
    CustomField04: '',
    CustomField05: '',
    Locations: locations,
  };
}

/**
 * Check if any items are cap products
 */
function hasCapItems(items) {
  return items.some(i => i.EmbellishmentType === 'embroidery' && isCapProduct(i));
}

/**
 * Build ShippingAddresses array from session
 */
function buildShippingAddresses(session) {
  // Only include shipping if we have at least a city or address
  if (!session.ShipToAddress && !session.ShipToCity) {
    return [{
      ShipCompany: session.CompanyName || '',
      ShipMethod: session.ShipMethod || 'Customer Pickup',
      ShipAddress01: '',
      ShipAddress02: '',
      ShipCity: '',
      ShipState: '',
      ShipZip: '',
      ShipCountry: 'USA',
      ExtShipID: 'SHIP-1',
    }];
  }

  return [{
    ShipCompany: session.CompanyName || '',
    ShipMethod: session.ShipMethod || 'Customer Pickup',
    ShipAddress01: session.ShipToAddress || '',
    ShipAddress02: '',
    ShipCity: session.ShipToCity || '',
    ShipState: session.ShipToState || '',
    ShipZip: session.ShipToZip || '',
    ShipCountry: 'USA',
    ExtShipID: 'SHIP-1',
  }];
}

/**
 * Build Notes array from session data
 *
 * @param {Object} session - quote_sessions record
 * @param {Array<Object>} items - quote_items records
 * @param {string[]} skippedFeeNotes - Descriptions of unrecognized fee items
 * @param {Object} taxInfo - Tax account info from getTaxAccount()
 * @param {string} taxInfo.taxAccountCode - GL account code (e.g., '2200')
 * @param {string} taxInfo.taxAccountDesc - Description (e.g., 'WA Sales Tax 10.1%')
 */
function buildNotes(session, items, skippedFeeNotes = [], taxInfo = {}) {
  const notes = [];

  // Notes On Order — each item as separate note entry (visible without clicking)
  // Matches Python InkSoft pattern: separate { Note, Type } per piece of info
  if (session.OrderNotes) {
    notes.push({ Type: NOTE_TYPES.ORDER, Note: session.OrderNotes });
  }
  // Rep-typed quote notes (#notes textarea) — EMB saves these to session.Notes and shows them on the
  // invoice, but the push path was dropping them. Skip the JSON config blobs DTG/DTF/SP store in the
  // shared Notes column (mirror of the builder's own skip). (round-2 N5)
  if (typeof session.Notes === 'string' && session.Notes.trim()) {
    let repNote = session.Notes.trim();
    try { JSON.parse(repNote); repNote = ''; } catch (_) { /* plain text — keep */ }
    if (repNote) notes.push({ Type: NOTE_TYPES.ORDER, Note: repNote });
  }
  if (session.PurchaseOrderNumber) {
    notes.push({ Type: NOTE_TYPES.ORDER, Note: `PO: ${session.PurchaseOrderNumber}` });
  }
  notes.push({ Type: NOTE_TYPES.ORDER, Note: `Quote: ${session.QuoteID}` });
  if (session.Carrier) {
    notes.push({ Type: NOTE_TYPES.ORDER, Note: `Carrier: ${session.Carrier}` });
  }
  if (session.TrackingNumber) {
    notes.push({ Type: NOTE_TYPES.ORDER, Note: `Tracking: ${session.TrackingNumber}` });
  }

  // Tax block — DTG/order-form style, one fact per row (shared helper) so all
  //    four push paths read identically. Erik 2026-06-02.
  const { taxAccountCode, taxAccountDesc } = taxInfo;
  const taxRate = toRateDecimal(session.TaxRate); // EMB stores TaxRate as decimal (0.101); percent-shaped legacy rows normalized (audit 2026-06-10)
  const taxAmount = parseFloat(session.TaxAmount) || 0;
  // Shipping from the SHIP fee line (same source as cur_Shipping) so the note's total foots. (2026-06-07)
  const shippingForNote = items.reduce((s, i) =>
    (i.EmbellishmentType === 'fee' && String(i.StyleNumber || '').toUpperCase() === 'SHIP')
      ? s + (parseFloat(i.LineTotal) || 0) : s, 0);
  buildSalesTaxNote({
    subtotal: session.SubtotalAmount, shipping: shippingForNote, taxRate, taxAmount,
    accountCode: taxAccountCode, accountDesc: taxAccountDesc,
    shipState: session.ShipToState, shipMethod: session.ShipMethod,
  }).forEach(line => notes.push({ Type: NOTE_TYPES.ORDER, Note: line }));

  // [2026-06-07] Also drop the tax breakdown in Notes To Accounting (single note) so the accountant can
  // verify the rate / account / total ShopWorks shows after the rep selects the tax line. (Erik — for Bradley)
  notes.push({ Type: NOTE_TYPES.ACCOUNTING, Note: buildAccountingTaxNote({
    subtotal: session.SubtotalAmount, shipping: shippingForNote, taxRate, taxAmount,
    accountCode: taxAccountCode, accountDesc: taxAccountDesc,
    shipState: session.ShipToState, shipMethod: session.ShipMethod,
  }) });

  // Unrecognized fee items — each as its OWN Notes On Order row so the
  // "UNBILLED FEE — add manually: …" call-to-action can't hide inside a
  // comma-joined blob. The pushed order is short by these amounts until the
  // rep adds them in OnSite. (audit 2026-06-10)
  for (const skipped of skippedFeeNotes) {
    notes.push({ Type: NOTE_TYPES.ORDER, Note: skipped });
  }

  // Import notes — Phase 11.3 (2026-05-24) reads via parseImportNotes()
  // which understands BOTH legacy array shape AND the new object shape.
  const parsedImport = parseImportNotes(session);
  if (parsedImport.importNotes.length > 0) {
    notes.push({
      Type: NOTE_TYPES.ORDER,
      Note: `Import Notes: ${parsedImport.importNotes.join('; ')}`,
    });
  }

  // Notes To Art — design numbers, digitizing codes, stitch counts
  const artNoteParts = [];
  if (session.GarmentDesignNumber) artNoteParts.push(`Garment Design #${session.GarmentDesignNumber}`);
  if (session.CapDesignNumber) artNoteParts.push(`Cap Design #${session.CapDesignNumber}`);
  if (session.DigitizingCodes) artNoteParts.push(`Digitizing: ${session.DigitizingCodes}`);

  // Warn when no design is linked — sales rep must assign in ShopWorks.
  // Phase 11.3 (2026-05-24): also pass when the rep uploaded new artwork via
  // the rich-mode widget (newDesignName + referenceArtwork → buildDesigns()
  // emits a valid Designs[] entry; no manual assignment needed).
  const hasNewDesignWithArt =
    !!parsedImport.newDesignName.trim() &&
    parsedImport.referenceArtwork.some(f => f && f.hostedUrl);
  if (!session.GarmentDesignNumber && !session.CapDesignNumber && !hasNewDesignWithArt) {
    artNoteParts.push('** NO DESIGN LINKED - Assign design manually in ShopWorks **');
  }

  // Add stitch info from LogoSpecs
  const firstProduct = items.find(i => i.EmbellishmentType === 'embroidery' && i.LogoSpecs);
  if (firstProduct) {
    try {
      const specs = JSON.parse(firstProduct.LogoSpecs);
      if (Array.isArray(specs.logos)) {
        for (const logo of specs.logos) {
          artNoteParts.push(`${logo.pos}: ${logo.stitch} stitches`);
        }
      }
    } catch { /* skip */ }
  }

  // Parse DesignNumbers JSON for any additional design references
  if (session.DesignNumbers) {
    try {
      const designNums = JSON.parse(session.DesignNumbers);
      if (Array.isArray(designNums) && designNums.length > 0) {
        artNoteParts.push(`All designs: ${designNums.join(', ')}`);
      }
    } catch { /* skip */ }
  }

  if (artNoteParts.length > 0) {
    notes.push({
      Type: NOTE_TYPES.ART,
      Note: artNoteParts.join('\n'),
    });
  }

  // Notes To Production — quote ID, pricing tier
  const prodNoteParts = [];
  prodNoteParts.push(`Quote: ${session.QuoteID}`);
  if (session.PricingTier) prodNoteParts.push(`Pricing Tier: ${session.PricingTier}`);
  if (session.TotalQuantity) prodNoteParts.push(`Total Qty: ${session.TotalQuantity}`);
  // Placement(s) + stitch counts so the embroidery floor sees WHERE the logo
  // goes without flipping to Notes To Art (Erik 2026-06-02).
  if (session.PrintLocation) prodNoteParts.push(`Garment: ${session.PrintLocation}${session.StitchCount ? ` — ${session.StitchCount} stitches` : ''}`);
  if (session.CapPrintLocation) prodNoteParts.push(`Cap: ${session.CapPrintLocation}${session.CapStitchCount ? ` — ${session.CapStitchCount} stitches` : ''}`);

  // ADDITIONAL logos (Right Sleeve, Full Back, Cap Back, …) live as fee line items, NOT in
  // the session primary fields — so without this the floor only sees the 2 primaries and
  // misses every extra logo. Surface them all here as a LOGO MAP so production can run the
  // job from one note. Placement + stitch come from the line item (PrintLocationName +
  // SizeBreakdown.stitchCount on new quotes; ProductName has both as a fallback for older
  // quotes). (2026-06-04 audit)
  const AL_FEE_PNS = ['AL', 'AL-CAP', 'DECG-FB', 'CB', 'CS', 'FB'];
  const addlLogoLines = [];
  for (const it of (items || [])) {
    if (String(it.EmbellishmentType || '').toLowerCase() !== 'fee') continue;
    if (!AL_FEE_PNS.includes(it.StyleNumber)) continue;
    let stitch = '';
    try { const sb = JSON.parse(it.SizeBreakdown || '{}'); if (sb.stitchCount) stitch = ` — ${sb.stitchCount} stitches`; } catch { /* ignore */ }
    const place = it.PrintLocationName || it.PrintLocation || '';
    const desc = place ? `${place}${stitch}` : (it.ProductName || it.StyleNumber);
    addlLogoLines.push(`  ${desc} (${it.StyleNumber})${it.Quantity ? ` x${it.Quantity}` : ''}`);
  }
  if (addlLogoLines.length > 0) {
    prodNoteParts.push('Additional Logos:');
    prodNoteParts.push(...addlLogoLines);
  }
  // Cap decoration method changes hooping/backing (3D puff) or is a sewn patch (laser).
  if (session.CapEmbellishmentType && session.CapEmbellishmentType !== 'embroidery') {
    const methodLabel = session.CapEmbellishmentType === '3d-puff' ? '3D Puff'
      : session.CapEmbellishmentType === 'laser-patch' ? 'Laser Leatherette Patch'
      : session.CapEmbellishmentType;
    prodNoteParts.push(`Cap method: ${methodLabel}`);
  }

  notes.push({
    Type: NOTE_TYPES.PRODUCTION,
    Note: prodNoteParts.join('\n'),
  });

  // Notes To Purchasing — line item summary for purchasing team
  const purchasingNote = buildPurchasingNote(items);
  if (purchasingNote) {
    notes.push({
      Type: NOTE_TYPES.PURCHASING,
      Note: purchasingNote,
    });
  }

  // Notes To Shipping — customer contact and address info
  const shippingNote = buildShippingNote(session);
  if (shippingNote) {
    notes.push({
      Type: NOTE_TYPES.SHIPPING,
      Note: shippingNote,
    });
  }

  return notes;
}

/**
 * Build Notes To Purchasing content from product items.
 * Lists garment line items with PN, Color, Size, Qty for purchasing team.
 * Mirrors InkSoft's "Line Items:" note (transform.py:840-855).
 *
 * @param {Array<Object>} items - quote_items records
 * @returns {string|null} Note text or null if no products
 */
function buildPurchasingNote(items) {
  const productItems = items.filter(i => i.EmbellishmentType === 'embroidery');
  if (productItems.length === 0) return null;

  const parts = ['Line Items:'];

  for (const item of productItems) {
    const style = item.StyleNumber || 'Unknown';
    const color = item.ColorCode || item.Color || '';
    const price = parseFloat(item.FinalUnitPrice) || 0;

    let sizeBreakdown = {};
    try {
      sizeBreakdown = JSON.parse(item.SizeBreakdown || '{}');
    } catch {
      sizeBreakdown = {};
    }

    // Filter out metadata keys from SizeBreakdown
    const sizeEntries = Object.entries(sizeBreakdown).filter(
      ([key]) => !['type', 'serviceType', 'logoPosition', 'stitchCount'].includes(key)
    );

    if (sizeEntries.length > 0) {
      for (const [size, qty] of sizeEntries) {
        if (!qty || qty <= 0) continue;
        const pn = getPartNumber(style, size);
        parts.push(`${pn} - ${color} - ${size} x${qty} - $${price.toFixed(2)}`);
      }
    } else {
      // No size breakdown — use base PN (don't fabricate _OSFA suffix)
      const qty = parseInt(item.Quantity) || 1;
      parts.push(`${style} - ${color} - OSFA x${qty} - $${price.toFixed(2)}`);
    }
  }

  return parts.length > 1 ? parts.join('\n') : null;
}

/**
 * Build Notes To Shipping content from session data.
 * Provides customer contact and shipping context for the shipping team.
 * Mirrors InkSoft's Notes To Shipping (transform.py:749-762).
 *
 * @param {Object} session - quote_sessions record
 * @returns {string|null} Note text or null if insufficient data
 */
function buildShippingNote(session) {
  const parts = [];

  if (session.CustomerName) parts.push(`Customer: ${session.CustomerName}`);
  if (session.CompanyName) parts.push(`Company: ${session.CompanyName}`);
  if (session.Phone) parts.push(`Phone: ${session.Phone}`);
  if (session.CustomerEmail) parts.push(`Email: ${session.CustomerEmail}`);

  // Ship-to address block
  const addrParts = [
    session.ShipToAddress, session.ShipToCity, session.ShipToState, session.ShipToZip,
  ].filter(Boolean);
  if (addrParts.length > 0) {
    parts.push(`Ship To: ${addrParts.join(', ')}`);
  }

  if (session.ShipMethod) parts.push(`Ship Method: ${session.ShipMethod}`);
  if (session.PurchaseOrderNumber) parts.push(`PO: ${session.PurchaseOrderNumber}`);

  return parts.length > 0 ? parts.join('\n') : null;
}

module.exports = {
  transformQuoteToOrder,
  // Export helpers for testing
  splitName,
  extractOrderLevelFees,
  buildLinesOE,
  buildDesigns,
  buildShippingAddresses,
  buildNotes,
  buildPurchasingNote,
  buildShippingNote,
  isCapProduct,
  parseImportNotes,   // P2-12 (audit 2026-06-06): push route's artwork-but-no-name backstop
};
