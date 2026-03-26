// ==========================================
// SanMar PromoStandards Product Data API
// ==========================================
// Provides product color status (active/closeout) from SanMar's
// PromoStandards Product Data Service V2.0.0
// Used to identify discontinued colors for catalog filtering

const express = require('express');
const router = express.Router();
const https = require('https');
const NodeCache = require('node-cache');

// Cache: 30-minute TTL to avoid hammering SanMar API
const sanmarCache = new NodeCache({ stdTTL: 1800, checkperiod: 300 });

// SanMar PromoStandards endpoint
const SANMAR_ENDPOINT = 'https://ws.sanmar.com:8080/promostandards/ProductDataServiceBindingV2';
const PS_NS = 'http://www.promostandards.org/WSDL/ProductDataService/2.0.0/';
const PS_SHARED_NS = 'http://www.promostandards.org/WSDL/ProductDataService/2.0.0/SharedObjects/';

// Auth from env vars
function getAuth() {
  return {
    id: process.env.SANMAR_USERNAME || '',
    password: process.env.SANMAR_PASSWORD || ''
  };
}

// Make SOAP request to SanMar
function makeSoapRequest(soapBody, soapAction) {
  return new Promise((resolve, reject) => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:ns="${PS_NS}" xmlns:shar="${PS_SHARED_NS}">
  <soapenv:Body>
    ${soapBody}
  </soapenv:Body>
</soapenv:Envelope>`;

    const url = new URL(SANMAR_ENDPOINT);
    const options = {
      hostname: url.hostname,
      port: url.port || 8080,
      path: url.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'text/xml; charset=utf-8',
        'SOAPAction': soapAction,
        'Content-Length': Buffer.byteLength(xml)
      },
      timeout: 30000
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => resolve(data));
    });

    req.on('error', (err) => reject(err));
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('SanMar API request timed out'));
    });

    req.write(xml);
    req.end();
  });
}

// XML-escape user inputs before SOAP interpolation (prevents XML injection)
function xmlEscape(str) {
  if (!str) return '';
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

// Parse XML — extract tag values (simple regex, no dependency needed)
function extractAll(xml, tagName) {
  const regex = new RegExp(`<(?:[\\w:]*:)?${tagName}>([^<]*)<\\/(?:[\\w:]*:)?${tagName}>`, 'g');
  const results = [];
  let match;
  while ((match = regex.exec(xml)) !== null) {
    results.push(match[1]);
  }
  return results;
}

// ── GET /api/sanmar/product-colors/:style ──
// Returns all colors for a style with isCloseout status
router.get('/product-colors/:style', async (req, res) => {
  const style = req.params.style.toUpperCase();
  const cacheKey = `sanmar-colors-${style}`;

  // Check cache
  const cached = sanmarCache.get(cacheKey);
  if (cached) {
    return res.json({ ...cached, cached: true });
  }

  try {
    const auth = getAuth();
    if (!auth.id || !auth.password) {
      return res.status(500).json({ error: 'SanMar credentials not configured' });
    }

    const soapBody = `
    <ns:GetProductRequest>
      <shar:wsVersion>2.0.0</shar:wsVersion>
      <shar:id>${xmlEscape(auth.id)}</shar:id>
      <shar:password>${xmlEscape(auth.password)}</shar:password>
      <shar:localizationCountry>US</shar:localizationCountry>
      <shar:localizationLanguage>en</shar:localizationLanguage>
      <shar:productId>${xmlEscape(style)}</shar:productId>
    </ns:GetProductRequest>`;

    const xml = await makeSoapRequest(soapBody, 'getProduct');

    // Check for errors
    if (xml.includes('Authentication Credentials failed')) {
      return res.status(401).json({ error: 'SanMar authentication failed' });
    }
    if (xml.includes('<code>110</code>') || xml.includes('No Product found')) {
      return res.json({ style, colors: [], message: 'Product not found in SanMar' });
    }

    // Parse: extract colorName and isCloseout pairs from ProductPart sections
    // Each ProductPart has a colorName and isCloseout field
    const colorNames = extractAll(xml, 'colorName');
    const closeoutFlags = extractAll(xml, 'isCloseout');
    const partIds = extractAll(xml, 'partId');

    // Build unique color map (multiple sizes per color)
    const colorMap = new Map();
    for (let i = 0; i < colorNames.length; i++) {
      const color = colorNames[i];
      const isCloseout = closeoutFlags[i] === 'true';
      if (!colorMap.has(color)) {
        colorMap.set(color, { colorName: color, isCloseout: isCloseout });
      }
      // If ANY size of this color is closeout, mark the whole color as closeout
      if (isCloseout) {
        colorMap.get(color).isCloseout = true;
      }
    }

    const colors = Array.from(colorMap.values());
    const activeColors = colors.filter(c => !c.isCloseout);
    const closeoutColors = colors.filter(c => c.isCloseout);

    const result = {
      style,
      totalColors: colors.length,
      activeCount: activeColors.length,
      closeoutCount: closeoutColors.length,
      colors,
      activeColors: activeColors.map(c => c.colorName),
      closeoutColors: closeoutColors.map(c => c.colorName)
    };

    // Cache the result
    sanmarCache.set(cacheKey, result);

    res.json(result);
  } catch (error) {
    console.error(`Error fetching SanMar product colors for ${style}:`, error.message);
    res.status(500).json({ error: 'Failed to fetch SanMar product data', details: error.message });
  }
});

// ── GET /api/sanmar/closeout-styles ──
// Returns all discontinued/closeout product style numbers
router.get('/closeout-styles', async (req, res) => {
  const cacheKey = 'sanmar-closeout-styles';

  const cached = sanmarCache.get(cacheKey);
  if (cached) {
    return res.json({ ...cached, cached: true });
  }

  try {
    const auth = getAuth();
    if (!auth.id || !auth.password) {
      return res.status(500).json({ error: 'SanMar credentials not configured' });
    }

    const soapBody = `
    <ns:GetProductCloseOutRequest>
      <shar:wsVersion>2.0.0</shar:wsVersion>
      <shar:id>${xmlEscape(auth.id)}</shar:id>
      <shar:password>${xmlEscape(auth.password)}</shar:password>
    </ns:GetProductCloseOutRequest>`;

    const xml = await makeSoapRequest(soapBody, 'getProductCloseOut');

    if (xml.includes('Authentication Credentials failed')) {
      return res.status(401).json({ error: 'SanMar authentication failed' });
    }

    const productIds = extractAll(xml, 'productId');
    const uniqueStyles = [...new Set(productIds)].sort();

    const result = {
      totalCloseoutStyles: uniqueStyles.length,
      styles: uniqueStyles
    };

    sanmarCache.set(cacheKey, result);
    res.json(result);
  } catch (error) {
    console.error('Error fetching SanMar closeout styles:', error.message);
    res.status(500).json({ error: 'Failed to fetch closeout styles', details: error.message });
  }
});

// ── GET /api/sanmar/sellable/:style ──
// Returns sellable partIds for a style
router.get('/sellable/:style', async (req, res) => {
  const style = req.params.style.toUpperCase();
  const cacheKey = `sanmar-sellable-${style}`;

  const cached = sanmarCache.get(cacheKey);
  if (cached) {
    return res.json({ ...cached, cached: true });
  }

  try {
    const auth = getAuth();
    if (!auth.id || !auth.password) {
      return res.status(500).json({ error: 'SanMar credentials not configured' });
    }

    const soapBody = `
    <ns:GetProductSellableRequest>
      <shar:wsVersion>2.0.0</shar:wsVersion>
      <shar:id>${xmlEscape(auth.id)}</shar:id>
      <shar:password>${xmlEscape(auth.password)}</shar:password>
      <shar:productId>${xmlEscape(style)}</shar:productId>
      <shar:isSellable>true</shar:isSellable>
    </ns:GetProductSellableRequest>`;

    const xml = await makeSoapRequest(soapBody, 'getProductSellable');

    if (xml.includes('Authentication Credentials failed')) {
      return res.status(401).json({ error: 'SanMar authentication failed' });
    }

    const partIds = extractAll(xml, 'partId');

    const result = {
      style,
      sellablePartCount: partIds.length,
      partIds
    };

    sanmarCache.set(cacheKey, result);
    res.json(result);
  } catch (error) {
    console.error(`Error fetching SanMar sellable parts for ${style}:`, error.message);
    res.status(500).json({ error: 'Failed to fetch sellable parts', details: error.message });
  }
});

// ── GET /api/sanmar/discontinued-colors/:style ──
// Compares SanMar API colors vs our Caspio table to find discontinued colors
// This is the most useful endpoint for the catalog filter
router.get('/discontinued-colors/:style', async (req, res) => {
  const style = req.params.style.toUpperCase();
  const cacheKey = `sanmar-disc-colors-${style}`;

  const cached = sanmarCache.get(cacheKey);
  if (cached) {
    return res.json({ ...cached, cached: true });
  }

  try {
    // Get colors from SanMar API
    const auth = getAuth();
    if (!auth.id || !auth.password) {
      return res.status(500).json({ error: 'SanMar credentials not configured' });
    }

    const soapBody = `
    <ns:GetProductRequest>
      <shar:wsVersion>2.0.0</shar:wsVersion>
      <shar:id>${xmlEscape(auth.id)}</shar:id>
      <shar:password>${xmlEscape(auth.password)}</shar:password>
      <shar:localizationCountry>US</shar:localizationCountry>
      <shar:localizationLanguage>en</shar:localizationLanguage>
      <shar:productId>${xmlEscape(style)}</shar:productId>
    </ns:GetProductRequest>`;

    const xml = await makeSoapRequest(soapBody, 'getProduct');

    if (xml.includes('Authentication Credentials failed')) {
      return res.status(401).json({ error: 'SanMar authentication failed' });
    }

    // Extract active colors from API
    const colorNames = extractAll(xml, 'colorName');
    const closeoutFlags = extractAll(xml, 'isCloseout');

    const activeApiColors = new Set();
    const closeoutApiColors = new Set();

    for (let i = 0; i < colorNames.length; i++) {
      if (closeoutFlags[i] === 'true') {
        closeoutApiColors.add(colorNames[i]);
      } else {
        activeApiColors.add(colorNames[i]);
      }
    }

    const result = {
      style,
      apiActiveColors: [...activeApiColors].sort(),
      apiCloseoutColors: [...closeoutApiColors].sort(),
      activeCount: activeApiColors.size,
      closeoutCount: closeoutApiColors.size,
      message: activeApiColors.size === 0 && closeoutApiColors.size === 0
        ? 'Product not found in SanMar API — may be fully discontinued'
        : `${activeApiColors.size} active, ${closeoutApiColors.size} closeout colors`
    };

    sanmarCache.set(cacheKey, result);
    res.json(result);
  } catch (error) {
    console.error(`Error checking discontinued colors for ${style}:`, error.message);
    res.status(500).json({ error: 'Failed to check discontinued colors', details: error.message });
  }
});

// ── Exported helper: getActiveColors(style) ──
// Returns Set of active color names for a style, or null if API fails (fail-open)
// Used by products.js to filter discontinued colors from /api/product-colors
async function getActiveColors(style) {
  const cacheKey = `sanmar-active-colors-${style.toUpperCase()}`;

  const cached = sanmarCache.get(cacheKey);
  if (cached) return cached;

  try {
    const auth = getAuth();
    if (!auth.id || !auth.password) return null;

    const soapBody = `
    <ns:GetProductRequest>
      <shar:wsVersion>2.0.0</shar:wsVersion>
      <shar:id>${xmlEscape(auth.id)}</shar:id>
      <shar:password>${xmlEscape(auth.password)}</shar:password>
      <shar:localizationCountry>US</shar:localizationCountry>
      <shar:localizationLanguage>en</shar:localizationLanguage>
      <shar:productId>${xmlEscape(style.toUpperCase())}</shar:productId>
    </ns:GetProductRequest>`;

    const xml = await makeSoapRequest(soapBody, 'getProduct');

    if (xml.includes('Authentication Credentials failed')) return null;

    const colorNames = extractAll(xml, 'colorName');
    const closeoutFlags = extractAll(xml, 'isCloseout');

    // Build set of active colors (not closeout)
    const activeColors = new Set();
    for (let i = 0; i < colorNames.length; i++) {
      if (closeoutFlags[i] !== 'true') {
        activeColors.add(colorNames[i].toLowerCase());
      }
    }

    // If API returned no data at all, product might not exist — fail open
    if (colorNames.length === 0) return null;
    // If all colors are closeout (activeColors empty but colorNames exist), still return null
    // so the fail-open filter in products.js shows all colors rather than hiding everything
    if (activeColors.size === 0) return null;

    sanmarCache.set(cacheKey, activeColors);
    return activeColors;
  } catch (error) {
    console.error(`getActiveColors(${style}) failed:`, error.message);
    return null; // Fail open — show all colors
  }
}

// ── PromoStandards Inventory Service ──
const INVENTORY_ENDPOINT = 'https://ws.sanmar.com:8080/promostandards/InventoryServiceBindingV2final';
const INV_NS = 'http://www.promostandards.org/WSDL/Inventory/2.0.0/';
const INV_SHARED_NS = 'http://www.promostandards.org/WSDL/Inventory/2.0.0/SharedObjects/';

// Inventory cache: 5-minute TTL (inventory changes more frequently)
const inventoryCache = new NodeCache({ stdTTL: 300, checkperiod: 60 });

// Make SOAP request to inventory endpoint (different URL from product data)
function makeInventoryRequest(soapBody) {
  return new Promise((resolve, reject) => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:ns="${INV_NS}" xmlns:shar="${INV_SHARED_NS}">
  <soapenv:Body>
    ${soapBody}
  </soapenv:Body>
</soapenv:Envelope>`;

    const url = new URL(INVENTORY_ENDPOINT);
    const options = {
      hostname: url.hostname,
      port: url.port || 8080,
      path: url.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'text/xml; charset=utf-8',
        'Content-Length': Buffer.byteLength(xml)
      },
      timeout: 30000
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => resolve(data));
    });

    req.on('error', (err) => reject(err));
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('SanMar Inventory API request timed out'));
    });

    req.write(xml);
    req.end();
  });
}

// ── GET /api/sanmar/inventory/:style ──
// Returns real-time inventory from SanMar warehouses
// Query params: color (optional, uses CATALOG_COLOR), size (optional)
router.get('/inventory/:style', async (req, res) => {
  const style = req.params.style.toUpperCase();
  const color = req.query.color || '';
  const size = req.query.size || '';
  const cacheKey = `sanmar-inv-${style}-${color}-${size}`.toLowerCase();

  const cached = inventoryCache.get(cacheKey);
  if (cached) {
    return res.json({ ...cached, cached: true });
  }

  try {
    const auth = getAuth();
    if (!auth.id || !auth.password) {
      return res.status(500).json({ error: 'SanMar credentials not configured' });
    }

    // Build filter section
    let filterXml = '';
    if (color || size) {
      filterXml = '<shar:Filter>';
      if (color) {
        filterXml += `<shar:PartColorArray><shar:partColor>${xmlEscape(color)}</shar:partColor></shar:PartColorArray>`;
      }
      if (size) {
        filterXml += `<shar:LabelSizeArray><shar:labelSize>${xmlEscape(size)}</shar:labelSize></shar:LabelSizeArray>`;
      }
      filterXml += '</shar:Filter>';
    }

    const soapBody = `
    <ns:GetInventoryLevelsRequest>
      <shar:wsVersion>2.0.0</shar:wsVersion>
      <shar:id>${xmlEscape(auth.id)}</shar:id>
      <shar:password>${xmlEscape(auth.password)}</shar:password>
      <shar:productId>${xmlEscape(style)}</shar:productId>
      ${filterXml}
    </ns:GetInventoryLevelsRequest>`;

    let xml = await makeInventoryRequest(soapBody);

    // Check for auth errors
    if (xml.includes('Authentication Credentials failed')) {
      return res.status(401).json({ error: 'SanMar authentication failed' });
    }

    // If color filter returned error/no data, retry WITHOUT color and filter server-side
    // This handles CATALOG_COLOR vs COLOR_NAME mismatches (e.g., "Biscuit/TB" vs "Biscuit/ True Blue")
    let serverSideColorFilter = null;
    if (color && (xml.includes('Data not found') || !xml.includes('<PartInventory>'))) {
      console.log(`Inventory: Color "${color}" not found for ${style}, retrying without color filter`);
      const retryBody = `
      <ns:GetInventoryLevelsRequest>
        <shar:wsVersion>2.0.0</shar:wsVersion>
        <shar:id>${xmlEscape(auth.id)}</shar:id>
        <shar:password>${xmlEscape(auth.password)}</shar:password>
        <shar:productId>${xmlEscape(style)}</shar:productId>
      </ns:GetInventoryLevelsRequest>`;
      xml = await makeInventoryRequest(retryBody);
      serverSideColorFilter = color.toLowerCase();
    }

    if (xml.includes('<code>') && xml.includes('Error') && !xml.includes('<PartInventory>')) {
      const errDesc = (xml.match(/<description>([^<]+)<\/description>/) || [])[1] || 'Unknown error';
      return res.status(400).json({ error: errDesc });
    }

    // Parse inventory XML into structured JSON
    const inventory = [];
    const partRegex = /<PartInventory>([\s\S]*?)<\/PartInventory>/g;
    let partMatch;

    while ((partMatch = partRegex.exec(xml)) !== null) {
      const partXml = partMatch[1];

      const partColor = (partXml.match(/<partColor>([^<]*)<\/partColor>/) || [])[1] || '';
      const labelSize = (partXml.match(/<labelSize>([^<]*)<\/labelSize>/) || [])[1] || '';
      const totalQty = parseInt((partXml.match(/<quantityAvailable>[\s\S]*?<value>(\d+)<\/value>/) || [])[1] || '0', 10);
      const partId = (partXml.match(/<partId>([^<]*)<\/partId>/) || [])[1] || '';

      // Server-side color filtering: match by partial/fuzzy when original color didn't match API format
      if (serverSideColorFilter) {
        const apiColor = partColor.toLowerCase();
        const searchColor = serverSideColorFilter;
        // Match if: exact, starts-with, or the API abbreviation is contained in the full name
        const isMatch = apiColor === searchColor ||
                        searchColor.startsWith(apiColor.split('/')[0]) ||
                        apiColor.startsWith(searchColor.split('/')[0]);
        if (!isMatch) continue; // Skip non-matching colors
      }

      // Parse warehouse quantities
      const warehouses = [];
      const locRegex = /<InventoryLocation>([\s\S]*?)<\/InventoryLocation>/g;
      let locMatch;

      while ((locMatch = locRegex.exec(partXml)) !== null) {
        const locXml = locMatch[1];
        const locId = parseInt((locXml.match(/<inventoryLocationId>(\d+)<\/inventoryLocationId>/) || [])[1] || '0', 10);
        const locName = (locXml.match(/<inventoryLocationName>([^<]*)<\/inventoryLocationName>/) || [])[1] || '';
        const qty = parseInt((locXml.match(/<inventoryLocationQuantity>[\s\S]*?<value>(\d+)<\/value>/) || [])[1] || '0', 10);

        warehouses.push({ id: locId, name: locName, qty });
      }

      inventory.push({
        partId,
        color: partColor,
        size: labelSize,
        totalQty,
        warehouses
      });
    }

    // Sort by size order
    const sizeOrder = ['XS', 'S', 'M', 'L', 'XL', '2XL', '3XL', '4XL', '5XL', '6XL', 'OSFA'];
    inventory.sort((a, b) => {
      const aIdx = sizeOrder.indexOf(a.size);
      const bIdx = sizeOrder.indexOf(b.size);
      return (aIdx === -1 ? 99 : aIdx) - (bIdx === -1 ? 99 : bIdx);
    });

    const result = {
      style,
      color: color || 'all',
      totalSizes: inventory.length,
      grandTotal: inventory.reduce((sum, item) => sum + item.totalQty, 0),
      inventory
    };

    inventoryCache.set(cacheKey, result);
    res.json(result);
  } catch (error) {
    console.error(`Error fetching SanMar inventory for ${style}:`, error.message);
    res.status(500).json({ error: 'Failed to fetch inventory', details: error.message });
  }
});

module.exports = router;
module.exports.getActiveColors = getActiveColors;
