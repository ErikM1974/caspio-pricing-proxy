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
  KNOWN_FEE_PNS,
  generateEmbExtOrderID,
  getSalesRepName,
  formatDateForAPI,
  translateSize,
  NOTE_TYPES,
} = require('../config/manageorders-emb-config');

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

  // Build shipping address
  const shippingAddresses = buildShippingAddresses(session);

  // Build notes (includes any skipped fee descriptions)
  const notes = buildNotes(session, items, skippedFeeNotes);

  return {
    // Order identification
    ExtOrderID: extOrderId,
    ExtSource: EMB_ONSITE_DEFAULTS.ExtSource,
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

    // Financial — order-level (OnSite auto-creates line items from these)
    TaxTotal: parseFloat(session.TaxAmount) || 0,
    cur_Shipping: shippingTotal,
    TotalDiscounts: discountTotal,

    // Nested arrays
    Designs: designs,
    LinesOE: linesOE,
    Notes: notes,
    ShippingAddresses: shippingAddresses,
    Payments: [],
    Attachments: [],
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

  // Determine design ExtDesignIDs for linking
  const garmentDesignId = session.GarmentDesignNumber
    ? `EMB-G-${session.QuoteID}` : null;
  const capDesignId = session.CapDesignNumber
    ? `EMB-C-${session.QuoteID}` : null;

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
    } else if (type === 'fee') {
      // Fee items — skip order-level ones and duplicates of customer-supplied items
      const pn = (item.StyleNumber || '').toUpperCase();
      if (ORDER_LEVEL_FEES.includes(pn)) continue;
      if (customerSuppliedPNs.has(pn)) continue;

      // Unrecognized fee PNs → route to Notes On Order instead of LinesOE
      if (!KNOWN_FEE_PNS.has(pn)) {
        const desc = item.ProductName || item.StyleNumber || 'Unknown fee';
        const qty = parseInt(item.Quantity) || 1;
        const price = parseFloat(item.FinalUnitPrice) || 0;
        const note = price > 0 ? `${desc} ($${price} x ${qty})` : desc;
        skippedFeeNotes.push(note);
        continue;
      }

      lines.push(buildServiceLine(item, null, null));
    }
  }

  return { lines, skippedFeeNotes };
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
        PartNumber: item.StyleNumber || '',
        Description: item.ProductName || '',
        Color: item.Color || '',
        Size: translatedSize,
        Qty: String(qty),
        Price: String(parseFloat(item.FinalUnitPrice) || 0),
        id_ProductClass: EMB_ONSITE_DEFAULTS.id_ProductClass,
        ExtDesignIDBlock: designId || '',
        ExtShipID: 'SHIP-1',
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
    // No size breakdown — use Quantity as-is (e.g., OSFA items)
    lines.push({
      PartNumber: item.StyleNumber || '',
      Description: item.ProductName || '',
      Color: item.Color || '',
      Size: 'OSFA',
      Qty: String(parseInt(item.Quantity) || 1),
      Price: String(parseFloat(item.FinalUnitPrice) || 0),
      id_ProductClass: EMB_ONSITE_DEFAULTS.id_ProductClass,
      ExtDesignIDBlock: designId || '',
      ExtShipID: 'SHIP-1',
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
    PartNumber: item.StyleNumber || '',
    Description: item.ProductName || '',
    Color: '',
    Size: '',
    Qty: String(parseInt(item.Quantity) || 1),
    Price: String(parseFloat(item.FinalUnitPrice) || 0),
    id_ProductClass: EMB_ONSITE_DEFAULTS.id_ProductClass,
    ExtDesignIDBlock: designId,
    ExtShipID: 'SHIP-1',
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
 * Build the Designs array from LogoSpecs and session design numbers.
 * Creates separate garment and cap designs.
 */
function buildDesigns(session, items) {
  const designs = [];

  // Find LogoSpecs from first embroidery product item
  let logoSpecs = null;
  const firstProduct = items.find(i => i.EmbellishmentType === 'embroidery' && i.LogoSpecs);
  if (firstProduct) {
    try {
      logoSpecs = JSON.parse(firstProduct.LogoSpecs);
    } catch {
      logoSpecs = null;
    }
  }

  // Find first product color for ForProductColor
  const firstProductColor = firstProduct ? (firstProduct.Color || '') : '';

  // Build garment design
  const garmentDesignNumber = session.GarmentDesignNumber || '';
  const garmentDesign = buildSingleDesign({
    quoteId: session.QuoteID,
    designNumber: garmentDesignNumber,
    designType: 'garment',
    productColor: firstProductColor,
    logoSpecs,
    session,
  });
  if (garmentDesign) designs.push(garmentDesign);

  // Build cap design (if caps exist)
  const capDesignNumber = session.CapDesignNumber || '';
  if (capDesignNumber || hasCapItems(items)) {
    // Find first cap product color
    const capProduct = items.find(i =>
      i.EmbellishmentType === 'embroidery' && isCapProduct(i)
    );
    const capColor = capProduct ? (capProduct.Color || firstProductColor) : firstProductColor;

    const capDesign = buildSingleDesign({
      quoteId: session.QuoteID,
      designNumber: capDesignNumber,
      designType: 'cap',
      productColor: capColor,
      logoSpecs,
      session,
    });
    if (capDesign) designs.push(capDesign);
  }

  return designs;
}

/**
 * Build a single Design entry (garment or cap)
 */
function buildSingleDesign({ quoteId, designNumber, designType, productColor, logoSpecs, session }) {
  const isGarment = designType === 'garment';
  const extDesignId = isGarment ? `EMB-G-${quoteId}` : `EMB-C-${quoteId}`;
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
 */
function buildNotes(session, items, skippedFeeNotes = []) {
  const notes = [];

  // Notes On Order — order notes + PO + quote link + skipped fee descriptions
  const orderNoteParts = [];
  if (session.OrderNotes) orderNoteParts.push(session.OrderNotes);
  if (session.PurchaseOrderNumber) orderNoteParts.push(`PO: ${session.PurchaseOrderNumber}`);
  orderNoteParts.push(`Quote: ${session.QuoteID}`);
  if (session.Carrier) orderNoteParts.push(`Carrier: ${session.Carrier}`);
  if (session.TrackingNumber) orderNoteParts.push(`Tracking: ${session.TrackingNumber}`);

  // Append unrecognized fee item descriptions as order notes
  if (skippedFeeNotes.length > 0) {
    orderNoteParts.push(`Order notes: ${skippedFeeNotes.join(', ')}`);
  }

  // Parse ImportNotes if it's a JSON array
  let importNotes = '';
  if (session.ImportNotes) {
    try {
      const parsed = JSON.parse(session.ImportNotes);
      if (Array.isArray(parsed) && parsed.length > 0) {
        importNotes = parsed.join('; ');
      }
    } catch {
      importNotes = session.ImportNotes;
    }
  }
  if (importNotes) orderNoteParts.push(`Import Notes: ${importNotes}`);

  notes.push({
    Type: NOTE_TYPES.ORDER,
    Note: orderNoteParts.join('\n'),
  });

  // Notes To Art — design numbers, digitizing codes, stitch counts
  const artNoteParts = [];
  if (session.GarmentDesignNumber) artNoteParts.push(`Garment Design #${session.GarmentDesignNumber}`);
  if (session.CapDesignNumber) artNoteParts.push(`Cap Design #${session.CapDesignNumber}`);
  if (session.DigitizingCodes) artNoteParts.push(`Digitizing: ${session.DigitizingCodes}`);

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

  notes.push({
    Type: NOTE_TYPES.PRODUCTION,
    Note: prodNoteParts.join('\n'),
  });

  return notes;
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
  isCapProduct,
};
