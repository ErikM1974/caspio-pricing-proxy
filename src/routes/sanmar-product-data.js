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
      <shar:id>${auth.id}</shar:id>
      <shar:password>${auth.password}</shar:password>
      <shar:localizationCountry>US</shar:localizationCountry>
      <shar:localizationLanguage>en</shar:localizationLanguage>
      <shar:productId>${style}</shar:productId>
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
      <shar:id>${auth.id}</shar:id>
      <shar:password>${auth.password}</shar:password>
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
      <shar:id>${auth.id}</shar:id>
      <shar:password>${auth.password}</shar:password>
      <shar:productId>${style}</shar:productId>
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
      <shar:id>${auth.id}</shar:id>
      <shar:password>${auth.password}</shar:password>
      <shar:localizationCountry>US</shar:localizationCountry>
      <shar:localizationLanguage>en</shar:localizationLanguage>
      <shar:productId>${style}</shar:productId>
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
      <shar:id>${auth.id}</shar:id>
      <shar:password>${auth.password}</shar:password>
      <shar:localizationCountry>US</shar:localizationCountry>
      <shar:localizationLanguage>en</shar:localizationLanguage>
      <shar:productId>${style.toUpperCase()}</shar:productId>
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

    // If API returned no colors, product might not exist — fail open
    if (activeColors.size === 0 && colorNames.length === 0) return null;

    sanmarCache.set(cacheKey, activeColors);
    return activeColors;
  } catch (error) {
    console.error(`getActiveColors(${style}) failed:`, error.message);
    return null; // Fail open — show all colors
  }
}

module.exports = router;
module.exports.getActiveColors = getActiveColors;
