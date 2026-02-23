#!/usr/bin/env node
/**
 * Batch 3 Push Script
 *
 * Parses ShopWorks order text, creates quote_sessions + quote_items in Caspio,
 * then pushes each to ManageOrders via the embroidery-push endpoint.
 *
 * Usage: node scripts/batch3-push.js [--dry-run]
 */

const fs = require('fs');
const path = require('path');

const BASE_URL = 'https://caspio-pricing-proxy-ab30a049961a.herokuapp.com';
const DELAY_MS = 3000; // 3s between orders to avoid rate limits

// ============================================================
// ORDER PARSER — parse ShopWorks text format into structured data
// ============================================================

function parseOrders(text) {
  // Split on "== ORDER N ==" markers, keeping everything after each marker
  const orderBlocks = text.split(/={10,}\s*ORDER\s+\d+\s*={10,}/);
  const orders = [];

  for (const block of orderBlocks) {
    const trimmed = block.trim();
    if (!trimmed) continue;
    if (trimmed.includes('SHOPWORKS ORDER EXPORT')) continue;

    // Remove END OF SAMPLE DATA footer if present
    const cleaned = block.replace(/={10,}\s*END OF SAMPLE DATA.*$/s, '');
    if (!cleaned.trim()) continue;

    const order = parseOneOrder(cleaned);
    if (order && order.orderNumber) {
      orders.push(order);
    }
  }

  return orders;
}

function parseOneOrder(block) {
  const lines = block.split('\n').map(l => l.trim()).filter(l => l && !l.match(/^\*+$/));

  const order = {
    orderNumber: '',
    salesperson: '',
    salesEmail: '',
    customerNumber: '',
    companyName: '',
    dateOrderPlaced: '',
    reqShipDate: '',
    dropDeadDate: '',
    purchaseOrder: '',
    terms: '',
    orderedBy: '',
    phone: '',
    email: '',
    shipMethod: '',
    shipAddress: '',
    carrier: '',
    trackingNumber: '',
    designs: [],
    items: [],
    subtotal: 0,
    salesTax: 0,
    shipping: 0,
    total: 0,
    paidToDate: 0,
    balance: 0,
  };

  let section = 'header';

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const [key, ...valueParts] = line.split(':');
    const value = valueParts.join(':').trim();

    // Section detection
    if (line === 'Your Company Information') { section = 'customer'; continue; }
    if (line === 'Order Information') { section = 'order'; continue; }
    if (line === 'Shipping Information') { section = 'shipping'; continue; }
    if (line === 'Package Tracking Information') { section = 'tracking'; continue; }
    if (line === 'Design Information') { section = 'design'; continue; }
    if (line === 'Items Purchased') { section = 'items'; continue; }
    if (line === 'Order Summary') { section = 'summary'; continue; }

    if (section === 'header') {
      if (key.trim() === 'Order #') order.orderNumber = value;
      if (key.trim() === 'Salesperson') order.salesperson = value;
      if (key.trim() === 'Email') order.salesEmail = value;
    }

    if (section === 'customer') {
      if (key.trim() === 'Customer #') order.customerNumber = value;
      if (key.trim() === 'Company') order.companyName = value;
    }

    if (section === 'order') {
      if (key.trim() === 'Date Order Placed') order.dateOrderPlaced = value;
      if (key.trim() === 'Req. Ship Date') order.reqShipDate = value;
      if (key.trim() === 'Drop Dead Date') order.dropDeadDate = value;
      if (key.trim() === 'Purchase Order #') order.purchaseOrder = value;
      if (key.trim() === 'Terms') order.terms = value;
      if (key.trim() === 'Ordered by') order.orderedBy = value;
      if (key.trim() === 'Phone' && value) order.phone = value;
      if (key.trim() === 'Email' && value) order.email = value;
    }

    if (section === 'shipping') {
      if (key.trim() === 'Ship Method') order.shipMethod = value;
      if (key.trim() === 'Ship Address') order.shipAddress = value;
    }

    if (section === 'tracking') {
      if (key.trim() === 'Carrier') order.carrier = value;
      if (key.trim() === 'Tracking #') order.trackingNumber = value;
    }

    if (section === 'design') {
      if (key.trim() === 'Design #') order.designs.push(value);
    }

    if (section === 'items') {
      if (line.match(/^Item \d+ of \d+$/)) {
        // Start new item — look ahead to parse it
        const item = parseItem(lines, i + 1);
        if (item) order.items.push(item);
      }
    }

    if (section === 'summary') {
      if (key.trim() === 'Subtotal') order.subtotal = parseNumber(value);
      if (key.trim() === 'Sales Tax') order.salesTax = parseNumber(value);
      if (key.trim() === 'Shipping') order.shipping = parseNumber(value);
      if (key.trim() === 'Total') order.total = parseNumber(value);
      if (key.trim() === 'Paid To Date') order.paidToDate = parseNumber(value);
      if (key.trim() === 'Balance') order.balance = parseNumber(value);
    }
  }

  return order;
}

function parseItem(lines, startIdx) {
  const item = {
    partNumber: '',
    description: '',
    unitPrice: 0,
    lineTotal: 0,
    quantity: 0,
    sizes: {},
  };

  for (let i = startIdx; i < lines.length; i++) {
    const line = lines[i];
    if (line.match(/^Item \d+ of \d+$/) || line.match(/^\*+$/) || line === 'Order Summary') break;

    const [key, ...valueParts] = line.split(':');
    const value = valueParts.join(':').trim();

    if (key.trim() === 'Part Number') item.partNumber = value;
    if (key.trim() === 'Description') item.description = value;
    if (key.trim() === 'Unit Price') item.unitPrice = parseNumber(value);
    if (key.trim() === 'Line Item Price') item.lineTotal = parseNumber(value);
    if (key.trim() === 'Item Quantity') item.quantity = parseInt(value) || 0;

    // Size lines: "LG:1", "XL:5", "S (Other):2", "XXXL (Other):18", "M:2"
    if (key.trim() === 'Adult') continue; // Skip "Adult:Quantity" header
    const sizeMatch = line.match(/^(S \(Other\)|M|LG|XL|XXL|XXXL \(Other\)|2XL|3XL|4XL|OSFA):(\d+)$/);
    if (sizeMatch) {
      const sizeName = normalizeSizeName(sizeMatch[1]);
      item.sizes[sizeName] = parseInt(sizeMatch[2]);
    }
  }

  return item;
}

function normalizeSizeName(raw) {
  const map = {
    'S (Other)': 'S',
    'M': 'M',
    'LG': 'L',
    'XL': 'XL',
    'XXL': 'XXL',
    'XXXL (Other)': 'OSFA', // For caps/beanies, XXXL(Other) usually means OSFA
    '2XL': '2XL',
    '3XL': '3XL',
    '4XL': '4XL',
    'OSFA': 'OSFA',
  };
  return map[raw] || raw;
}

function parseNumber(str) {
  if (!str) return 0;
  return parseFloat(str.replace(/,/g, '').replace(/\$/g, '')) || 0;
}

// ============================================================
// SHIPPING ADDRESS PARSER
// ============================================================

function parseShipAddress(shipAddressStr) {
  if (!shipAddressStr) return { address: '', city: '', state: '', zip: '' };

  // Format: "Company, Street, City, ST ZIP-XXXX" or "Company, Street"
  const parts = shipAddressStr.split(',').map(s => s.trim());
  if (parts.length < 3) return { address: shipAddressStr, city: '', state: '', zip: '' };

  // Last part should be "ST ZIP" or "ST ZIP-XXXX"
  const lastPart = parts[parts.length - 1].trim();
  const stateZipMatch = lastPart.match(/^([A-Z]{2})\s+(\d{5}(?:-\d{4})?)$/);

  if (stateZipMatch) {
    return {
      address: parts.slice(1, parts.length - 2).join(', ').trim(),
      city: parts[parts.length - 2].trim(),
      state: stateZipMatch[1],
      zip: stateZipMatch[2],
    };
  }

  // Try simpler format: "Company, Address, City, ST ZIP-XXXX, Country"
  // or "Company, Address"
  return { address: parts.slice(1).join(', ').trim(), city: '', state: '', zip: '' };
}

// ============================================================
// DESIGN NUMBER EXTRACTION
// ============================================================

function extractDesignNumber(designStr) {
  // "38864 - Smith Brothers FB - Full Logo" → "38864"
  // "1549.06 - Petersen Bros. Inc" → "1549"
  const match = designStr.match(/^(\d+)(?:\.\d+)?/);
  return match ? match[1] : '';
}

// ============================================================
// CLASSIFY ITEMS INTO EMBELLISHMENT TYPES
// ============================================================

function classifyItem(item) {
  const pn = (item.partNumber || '').toUpperCase();
  const desc = (item.description || '').toLowerCase();

  // Empty PN description-only lines (separators/notes) — skip
  if (!pn && !item.unitPrice && !item.quantity) return 'skip';

  // Empty PN but has price/qty — treat as note (e.g., "DTF - Transfer" annotation)
  // These are order annotations, not billable line items → go to Notes On Order
  if (!pn && item.unitPrice > 0 && item.quantity > 0) return 'note';

  // DECG/DECC
  if (pn === 'DECG' || pn.startsWith('DECG')) return 'customer-supplied';
  if (pn === 'DECC' || pn.startsWith('DECC')) return 'customer-supplied';

  // AL (Additional Logo)
  if (pn === 'AL') return 'embroidery-additional';

  // Service items as fees
  if (['WEIGHT', 'NAME', 'MONOGRAM', 'DD', 'DDE', 'DDT', 'DT', 'GRT-50', 'GRT-75',
       'RUSH', 'SAMPLE', 'SEG', 'SECC', 'AS-GARM', 'AS-CAP', 'CTR-GARMT', 'CTR-CAP',
       '3D-EMB', 'LASER PATCH'].includes(pn)) return 'fee';

  // Products with actual part numbers and quantities
  if (pn && item.quantity > 0) return 'embroidery';

  // Description-only items that are notes/separators
  return 'skip';
}

// ============================================================
// SALES REP EMAIL MAPPING
// ============================================================

function getSalesRepEmail(name) {
  const map = {
    'taylar hanson': 'taylar@nwcustomapparel.com',
    'nika lao': 'nika@nwcustomapparel.com',
    'taneisha jones': 'taneisha@nwcustomapparel.com',
    'erik mickelson': 'erik@nwcustomapparel.com',
    'ruthie mickelson': 'ruthie@nwcustomapparel.com',
  };
  return map[(name || '').toLowerCase().trim()] || '';
}

// ============================================================
// API HELPERS
// ============================================================

async function fetchJSON(url, options = {}) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const resp = await fetch(url, { timeout: 30000, ...options });
      if (resp.status === 429) {
        const wait = (attempt + 1) * 5000;
        console.log(`  ⏳ Rate limited, waiting ${wait/1000}s...`);
        await sleep(wait);
        continue;
      }
      if (!resp.ok) {
        const text = await resp.text();
        throw new Error(`HTTP ${resp.status}: ${text.substring(0, 200)}`);
      }
      return await resp.json();
    } catch (err) {
      if (attempt === 2) throw err;
      console.log(`  ⚠ Retry ${attempt + 1}: ${err.message}`);
      await sleep(2000);
    }
  }
}

async function postJSON(url, data) {
  return fetchJSON(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ============================================================
// GENERATE QUOTE ID
// ============================================================

async function getNextQuoteId() {
  const resp = await fetchJSON(`${BASE_URL}/api/quote-sequence/EMB`);
  // Response: { prefix: "EMB", year: 2026, sequence: 238 }
  return `${resp.prefix}-${resp.year}-${resp.sequence}`;
}

// ============================================================
// DATE FORMATTING
// ============================================================

function toISODate(dateStr) {
  if (!dateStr) return null;
  try {
    const d = new Date(dateStr);
    if (isNaN(d.getTime())) return null;
    return d.toISOString();
  } catch {
    return null;
  }
}

// ============================================================
// BUILD QUOTE SESSION + ITEMS FROM PARSED ORDER
// ============================================================

function buildSessionNotes(order) {
  const parts = [`ShopWorks Order #${order.orderNumber}`];
  for (const d of order.designs) {
    parts.push(`Design #${d}`);
  }
  // Append note-classified items (empty-PN annotations like "DTF - Transfer")
  for (const item of order.items) {
    if (classifyItem(item) === 'note') {
      const desc = item.description || 'Note';
      const price = item.unitPrice > 0 ? ` ($${item.unitPrice} x ${item.quantity})` : '';
      parts.push(`Order note: ${desc.trim()}${price}`);
    }
  }
  return parts.join('\n');
}

function buildQuoteSession(order, quoteId) {
  const shipParts = parseShipAddress(order.shipAddress);
  const salesRepEmail = order.salesEmail || getSalesRepEmail(order.salesperson);

  // Extract design numbers for the fields
  const designNumbers = order.designs.map(d => extractDesignNumber(d)).filter(Boolean);
  const garmentDesignNumber = designNumbers[0] || '';
  // If there are cap items and multiple designs, second design is cap
  const hasCapItems = order.items.some(i => {
    const pn = (i.partNumber || '').toUpperCase();
    return /^(CP|NE\d|C8\d|C9\d|STC)/i.test(pn);
  });
  const capDesignNumber = hasCapItems && designNumbers.length > 1 ? designNumbers[1] : '';

  // Calculate tax rate from subtotal and tax
  const taxableAmount = order.subtotal + order.shipping;
  const taxRate = taxableAmount > 0 && order.salesTax > 0 ?
    Math.round((order.salesTax / taxableAmount) * 1000) / 1000 : 0;

  // Count quantities
  const productItems = order.items.filter(i => classifyItem(i) === 'embroidery');
  const totalQty = productItems.reduce((sum, i) => sum + i.quantity, 0) +
    order.items.filter(i => classifyItem(i) === 'customer-supplied').reduce((sum, i) => sum + i.quantity, 0);

  return {
    QuoteID: quoteId,
    SessionID: `batch3_push_${Date.now()}_${order.orderNumber}`,
    CustomerEmail: order.email || '',
    CustomerName: order.orderedBy || '',
    CompanyName: order.companyName || '',
    Phone: order.phone || '',
    TotalQuantity: totalQty,
    SubtotalAmount: order.subtotal,
    LTMFeeTotal: 0,
    TotalAmount: order.total,
    Status: 'Open',
    CreatedAt_Quote: new Date().toISOString(),
    ExpiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
    SalesRepEmail: salesRepEmail,
    SalesRepName: order.salesperson,
    Notes: buildSessionNotes(order),
    PrintLocation: 'Left Chest',
    StitchCount: 8000,
    DigitizingFee: 0,
    CapPrintLocation: '',
    CapStitchCount: 0,
    CapDigitizingFee: 0,
    CapEmbellishmentType: '',
    GarmentStitchCharge: 0,
    CapStitchCharge: 0,
    AdditionalStitchCharge: 0,
    ALChargeGarment: 0,
    ALChargeCap: 0,
    ALGarmentQty: 0,
    ALCapQty: 0,
    ALGarmentUnitPrice: 0,
    ALCapUnitPrice: 0,
    ALGarmentDesc: '',
    ALCapDesc: '',
    GarmentDigitizing: 0,
    CapDigitizing: 0,
    AdditionalStitchUnitPrice: 0,
    ArtCharge: 0,
    GraphicDesignHours: 0,
    GraphicDesignCharge: 0,
    RushFee: 0,
    SampleFee: 0,
    SampleQty: 0,
    LTM_Garment: 0,
    LTM_Cap: 0,
    Discount: 0,
    DiscountPercent: 0,
    DiscountReason: '',
    OrderNumber: order.orderNumber,
    CustomerNumber: order.customerNumber,
    PurchaseOrderNumber: order.purchaseOrder || '',
    ShipToAddress: shipParts.address,
    ShipToCity: shipParts.city,
    ShipToState: shipParts.state,
    ShipToZip: shipParts.zip,
    ShipMethod: order.shipMethod || '',
    DateOrderPlaced: toISODate(order.dateOrderPlaced),
    ReqShipDate: toISODate(order.reqShipDate),
    DropDeadDate: toISODate(order.dropDeadDate),
    PaymentTerms: order.terms || '',
    DesignNumbers: JSON.stringify(order.designs),
    DigitizingCodes: '',
    TaxRate: taxRate,
    TaxAmount: order.salesTax,
    ImportNotes: '[]',
    PaidToDate: order.paidToDate,
    BalanceAmount: order.balance,
    OrderNotes: '',
    SWTotal: order.total,
    SWSubtotal: order.subtotal,
    PriceAuditJSON: '',
    Carrier: order.carrier || '',
    TrackingNumber: order.trackingNumber || '',
    GarmentDesignNumber: garmentDesignNumber,
    CapDesignNumber: capDesignNumber,
  };
}

function buildQuoteItems(order, quoteId) {
  const items = [];
  let lineNumber = 1;

  // First embroidery product item gets LogoSpecs
  let firstProduct = true;

  for (const item of order.items) {
    const type = classifyItem(item);
    if (type === 'skip' || type === 'note') continue;

    const sizeBreakdown = Object.keys(item.sizes).length > 0 ?
      JSON.stringify(item.sizes) : '';

    // Build LogoSpecs for first product only
    let logoSpecs = '';
    if (type === 'embroidery' && firstProduct) {
      const logos = [{ pos: 'Left Chest', stitch: 8000, digit: 0, primary: 1 }];
      logoSpecs = JSON.stringify({ logos, tier: '8-23', setup: 0 });
      firstProduct = false;
    }

    // Use PN as-is; for empty PN fee items, use a cleaned description as style
    let styleNumber = item.partNumber;
    if (!styleNumber && type === 'fee') {
      // "DTF - Transfer " → "DT" (closest ShopWorks code) or use description
      styleNumber = item.description.trim().replace(/\s+/g, '-').substring(0, 30);
    }

    items.push({
      QuoteID: quoteId,
      LineNumber: lineNumber++,
      StyleNumber: styleNumber,
      ProductName: item.description || '',
      Color: extractColor(item.description),
      ColorCode: '',
      EmbellishmentType: type,
      PrintLocation: type === 'embroidery' ? 'Left Chest' : '',
      PrintLocationName: type === 'embroidery' ? 'Left Chest' : '',
      Quantity: item.quantity || 1,
      HasLTM: 'No',
      BaseUnitPrice: item.unitPrice || 0,
      LTMPerUnit: 0,
      FinalUnitPrice: item.unitPrice || 0,
      LineTotal: item.lineTotal || (item.unitPrice * item.quantity) || 0,
      SizeBreakdown: sizeBreakdown,
      PricingTier: '',
      ImageURL: '',
      LogoSpecs: logoSpecs,
    });
  }

  // Add TAX fee item if there's sales tax
  if (order.salesTax > 0) {
    const taxRate = order.subtotal > 0 ?
      Math.round((order.salesTax / (order.subtotal + order.shipping)) * 1000) / 10 : 10.1;
    items.push({
      QuoteID: quoteId,
      LineNumber: lineNumber++,
      StyleNumber: 'TAX',
      ProductName: `Sales Tax (${taxRate}%)`,
      Color: '',
      ColorCode: '',
      EmbellishmentType: 'fee',
      PrintLocation: '',
      PrintLocationName: '',
      Quantity: 1,
      HasLTM: 'No',
      BaseUnitPrice: taxRate,
      LTMPerUnit: 0,
      FinalUnitPrice: taxRate,
      LineTotal: order.salesTax,
      SizeBreakdown: '',
      PricingTier: '',
      ImageURL: '',
      LogoSpecs: '',
    });
  }

  // Add SHIP fee item if there's shipping
  if (order.shipping > 0) {
    items.push({
      QuoteID: quoteId,
      LineNumber: lineNumber++,
      StyleNumber: 'SHIP',
      ProductName: 'Shipping',
      Color: '',
      ColorCode: '',
      EmbellishmentType: 'fee',
      PrintLocation: '',
      PrintLocationName: '',
      Quantity: 1,
      HasLTM: 'No',
      BaseUnitPrice: order.shipping,
      LTMPerUnit: 0,
      FinalUnitPrice: order.shipping,
      LineTotal: order.shipping,
      SizeBreakdown: '',
      PricingTier: '',
      ImageURL: '',
      LogoSpecs: '',
    });
  }

  return items;
}

function extractColor(description) {
  if (!description) return '';
  // "Port Authority Challenger Jacket, Tr.Black/Tr.Bk" → "Tr.Black/Tr.Bk"
  const parts = description.split(',');
  if (parts.length >= 2) return parts[parts.length - 1].trim();
  return '';
}

// ============================================================
// MAIN: Parse → Create in Caspio → Push to ManageOrders
// ============================================================

async function main() {
  const isDryRun = process.argv.includes('--dry-run');
  const inputFile = path.join(__dirname, '..', '..', '..', 'erik', 'Downloads', 'shopworks_orders_batch3.txt');
  // Fallback paths
  const paths = [
    'C:\\Users\\erik\\Downloads\\shopworks_orders_batch3.txt',
    inputFile,
  ];

  let text;
  for (const p of paths) {
    try { text = fs.readFileSync(p, 'utf8'); break; } catch { /* try next */ }
  }
  if (!text) {
    console.error('❌ Could not find shopworks_orders_batch3.txt');
    process.exit(1);
  }

  console.log('='.repeat(60));
  console.log('BATCH 3 PUSH — Parse → Caspio → ManageOrders');
  console.log('='.repeat(60));
  if (isDryRun) console.log('🏃 DRY RUN MODE — no records will be created\n');

  // 1. Parse all orders
  const orders = parseOrders(text);
  console.log(`\n📋 Parsed ${orders.length} orders:\n`);
  for (const o of orders) {
    const productCount = o.items.filter(i => classifyItem(i) === 'embroidery').length;
    const feeCount = o.items.filter(i => ['fee', 'embroidery-additional', 'customer-supplied'].includes(classifyItem(i))).length;
    console.log(`  Order #${o.orderNumber} — ${o.companyName} — ${productCount} products, ${feeCount} services — $${o.total}`);
  }

  if (isDryRun) {
    console.log('\n--- DRY RUN: showing what would be created ---\n');
    for (const order of orders) {
      const quoteId = `EMB-2026-DRY-${order.orderNumber}`;
      const session = buildQuoteSession(order, quoteId);
      const items = buildQuoteItems(order, quoteId);
      console.log(`\n📦 ${quoteId} (Order #${order.orderNumber})`);
      console.log(`   Customer: ${session.CustomerNumber} — ${session.CompanyName}`);
      console.log(`   Rep: ${session.SalesRepName} (${session.SalesRepEmail})`);
      console.log(`   Designs: ${order.designs.length} — GarmentDesign: ${session.GarmentDesignNumber}, CapDesign: ${session.CapDesignNumber || 'none'}`);
      console.log(`   Ship: ${session.ShipMethod || 'none'} → ${session.ShipToCity || 'no city'}, ${session.ShipToState || 'no state'}`);
      console.log(`   Items (${items.length}):`);
      for (const it of items) {
        console.log(`     ${it.LineNumber}. [${it.EmbellishmentType}] ${it.StyleNumber || '(no PN)'} — ${it.ProductName} — qty:${it.Quantity} @ $${it.FinalUnitPrice} = $${it.LineTotal}`);
        if (it.SizeBreakdown) console.log(`        sizes: ${it.SizeBreakdown}`);
      }
      console.log(`   Totals: sub=$${session.SubtotalAmount}, tax=$${session.TaxAmount} (${(session.TaxRate*100).toFixed(1)}%), ship=$${order.shipping}, total=$${session.TotalAmount}`);
    }
    console.log('\n✅ Dry run complete. Run without --dry-run to create records.');
    return;
  }

  // 2. Process each order
  const results = [];
  for (let i = 0; i < orders.length; i++) {
    const order = orders[i];
    console.log(`\n${'─'.repeat(50)}`);
    console.log(`📦 [${i+1}/${orders.length}] Order #${order.orderNumber} — ${order.companyName}`);
    console.log(`${'─'.repeat(50)}`);

    try {
      // 2a. Get next quote ID
      const quoteId = await getNextQuoteId();
      console.log(`  ✅ Quote ID: ${quoteId}`);

      // 2b. Build session + items
      const session = buildQuoteSession(order, quoteId);
      const items = buildQuoteItems(order, quoteId);
      console.log(`  📝 ${items.length} line items built (Customer #${session.CustomerNumber})`);

      // 2c. Create quote_sessions record
      console.log(`  ⬆ Creating quote_sessions...`);
      const sessionResp = await postJSON(`${BASE_URL}/api/quote_sessions`, session);
      console.log(`  ✅ Session created`);

      // 2d. Create quote_items records (with small delay between each)
      console.log(`  ⬆ Creating ${items.length} quote_items...`);
      for (const item of items) {
        await postJSON(`${BASE_URL}/api/quote_items`, item);
        await sleep(300); // Small delay to avoid rate limits
      }
      console.log(`  ✅ All items created`);

      // 2e. Push to ManageOrders
      console.log(`  🚀 Pushing to ManageOrders...`);
      const pushResp = await postJSON(`${BASE_URL}/api/embroidery-push/push-quote`, {
        quoteId,
        isTest: false,
        force: false,
      });
      console.log(`  ✅ PUSHED: ${pushResp.extOrderId} — ${pushResp.lineItemCount} lines, ${pushResp.designCount} designs`);

      results.push({
        orderNumber: order.orderNumber,
        quoteId,
        extOrderId: pushResp.extOrderId,
        lineItemCount: pushResp.lineItemCount,
        status: 'SUCCESS',
      });

    } catch (err) {
      console.error(`  ❌ FAILED: ${err.message}`);
      results.push({
        orderNumber: order.orderNumber,
        status: 'FAILED',
        error: err.message,
      });
    }

    // Delay between orders
    if (i < orders.length - 1) {
      console.log(`  ⏳ Waiting ${DELAY_MS/1000}s...`);
      await sleep(DELAY_MS);
    }
  }

  // 3. Summary
  console.log(`\n${'='.repeat(60)}`);
  console.log('BATCH 3 RESULTS');
  console.log(`${'='.repeat(60)}`);
  const successes = results.filter(r => r.status === 'SUCCESS');
  const failures = results.filter(r => r.status === 'FAILED');
  console.log(`✅ ${successes.length} pushed successfully`);
  if (failures.length > 0) console.log(`❌ ${failures.length} failed`);
  console.log('');
  for (const r of results) {
    if (r.status === 'SUCCESS') {
      console.log(`  ✅ Order #${r.orderNumber} → ${r.quoteId} → ${r.extOrderId} (${r.lineItemCount} lines)`);
    } else {
      console.log(`  ❌ Order #${r.orderNumber}: ${r.error}`);
    }
  }
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
