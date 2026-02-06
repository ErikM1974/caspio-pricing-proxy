// ==========================================
// Sanmar to ShopWorks Mapping API
// ==========================================
// Provides centralized mapping logic for:
// - SKU pattern detection (single-SKU vs multi-SKU variants)
// - Suffix-to-field mapping (_2XL → Size05, others → Size06)
// - Color normalization (COLOR_NAME ↔ CATALOG_COLOR)
// - Optional real-time inventory aggregation

const express = require('express');
const router = express.Router();

// Import Caspio utilities
const { fetchAllCaspioPages } = require('../utils/caspio');

// In-memory cache for mapping data (1-hour TTL)
const sanmarMappingCache = new Map();
const MAPPING_CACHE_TTL = 60 * 60 * 1000; // 1 hour

// Suffix to ShopWorks field mapping
// CRITICAL: _2XL and _2X use Size05 (ONLY exceptions)
// All other suffixes use Size06 (reuse pattern)
const SUFFIX_TO_FIELD_MAP = {
  '_2XL': 'Size05',  // Standard 2XL
  '_2X': 'Size05',   // Alternate format
  '_3XL': 'Size06',  // First use of Size06
  '_3X': 'Size06',
  '_4XL': 'Size06',  // Reuses Size06
  '_4X': 'Size06',
  '_5XL': 'Size06',  // Reuses Size06
  '_5X': 'Size06',
  '_6XL': 'Size06',  // Reuses Size06
  '_6X': 'Size06',
  '_XXL': 'Size06',  // Women's 2XL (different from _2XL!)
  '_OSFA': 'Size06', // One size fits all
  '_XS': 'Size06',   // Extra small (tall variants)
  '_LT': 'Size06',   // Large tall
  '_XLT': 'Size06',  // XL tall
  '_2XLT': 'Size06', // 2XL tall
  '_3XLT': 'Size06', // 3XL tall
  '_4XLT': 'Size06', // 4XL tall
  // Youth sizes also use Size06
  '_YXS': 'Size06',
  '_YS': 'Size06',
  '_YM': 'Size06',
  '_YL': 'Size06',
  '_YXL': 'Size06'
};

// Map extended sizes to ShopWorks SKU suffixes
const SIZE_TO_SUFFIX = {
  '2XL': '_2X', '3XL': '_3X', '4XL': '_4X', '5XL': '_5X', '6XL': '_6X',
  'XS': '_XS', 'XXL': '_XXL', 'OSFA': '_OSFA', 'OSFM': '_OSFM',
  'LT': '_LT', 'XLT': '_XLT', '2XLT': '_2XLT', '3XLT': '_3XLT', '4XLT': '_4XLT',
  'ST': '_ST', 'MT': '_MT', 'XST': '_XST',
  'YXS': '_YXS', 'YS': '_YS', 'YM': '_YM', 'YL': '_YL', 'YXL': '_YXL',
  '2T': '_2T', '3T': '_3T', '4T': '_4T', '5T': '_5T', '6T': '_6T',
  'LB': '_LB', 'XLB': '_XLB', '2XLB': '_2XLB',
  'S/M': '_SM', 'M/L': '_ML', 'L/XL': '_LXL', 'XS/S': '_XSS', 'X/2X': '_X2X', 'S/XL': '_SXL'
};

// Standard sizes that go into base SKU (Size01-Size04)
const STANDARD_SIZES = ['S', 'M', 'L', 'XL'];

/**
 * Get available sizes for a product from Sanmar_Bulk table
 * Returns map of size → CASE_PRICE
 */
async function getAvailableSizesFromBulk(styleNumber, catalogColor) {
  let whereClause = `STYLE='${styleNumber}'`;
  if (catalogColor) {
    whereClause += ` AND CATALOG_COLOR='${catalogColor}'`;
  }

  const records = await fetchAllCaspioPages(
    '/tables/Sanmar_Bulk_251816_Feb2024/records',
    {
      'q.where': whereClause,
      'q.select': 'SIZE, CASE_PRICE',
      'q.limit': 200
    }
  );

  // Build size→price map (deduplicate, take first price per size)
  const sizePricing = {};
  records.forEach(r => {
    if (r.SIZE && r.CASE_PRICE != null && sizePricing[r.SIZE] === undefined) {
      sizePricing[r.SIZE] = r.CASE_PRICE;
    }
  });

  return sizePricing;
}

/**
 * Detect SKU pattern for a product by querying available sizes from Sanmar_Bulk
 * Returns: single-sku, standard-multi-sku (2-3 SKUs), or extended-multi-sku (4+ SKUs)
 */
async function detectSKUPattern(styleNumber) {
  try {
    const sizePricing = await getAvailableSizesFromBulk(styleNumber, null);
    const availableSizes = Object.keys(sizePricing);

    if (availableSizes.length === 0) {
      return {
        type: 'not-found',
        skus: [],
        description: 'Product not found in Sanmar catalog'
      };
    }

    // Derive SKU list from available sizes
    const skus = [];
    const hasStandardSizes = availableSizes.some(s => STANDARD_SIZES.includes(s));
    if (hasStandardSizes) {
      skus.push(styleNumber);
    }

    const extendedSizes = availableSizes.filter(s => !STANDARD_SIZES.includes(s));
    extendedSizes.forEach(size => {
      const suffix = SIZE_TO_SUFFIX[size] || `_${size}`;
      skus.push(`${styleNumber}${suffix}`);
    });

    if (skus.length === 1) {
      return {
        type: 'single-sku',
        skus,
        description: 'All sizes in one SKU (e.g., hoodies, jackets)'
      };
    } else if (skus.length <= 3) {
      return {
        type: 'standard-multi-sku',
        skus,
        description: 'Base + extended size pattern (e.g., PC54)'
      };
    } else {
      return {
        type: 'extended-multi-sku',
        skus,
        description: `Extended pattern with ${skus.length} SKUs (e.g., PC61, J790)`
      };
    }
  } catch (error) {
    console.error('[detectSKUPattern] Error:', error);
    throw error;
  }
}

/**
 * Get ShopWorks size field mapping derived from available sizes
 * Returns the size field configuration for each SKU
 */
function getShopWorksSizeMappingFromSizes(skus, styleNumber, availableSizes, productTitle) {
  const sizeMap = {};

  skus.forEach(sku => {
    if (sku === styleNumber) {
      // Base SKU: standard sizes in Size01-Size04
      sizeMap[sku] = {
        Size01: availableSizes.includes('S'),
        Size02: availableSizes.includes('M'),
        Size03: availableSizes.includes('L'),
        Size04: availableSizes.includes('XL'),
        Size05: false,
        Size06: false,
        pricing: { case: null },
        description: productTitle
      };
    } else {
      // Extended SKU: determine which size field based on suffix
      const suffix = sku.replace(styleNumber, '');
      const field = SUFFIX_TO_FIELD_MAP[suffix] || 'Size06';
      const isTwoXL = suffix === '_2X' || suffix === '_2XL';

      sizeMap[sku] = {
        Size01: false,
        Size02: false,
        Size03: false,
        Size04: false,
        Size05: isTwoXL,
        Size06: !isTwoXL,
        pricing: { case: null },
        description: productTitle
      };
    }
  });

  return sizeMap;
}

/**
 * Map SKU to ShopWorks fields using derived size data
 */
function mapSKUToFieldsEnhanced(skus, styleNumber, availableSizes, productTitle) {
  const sizeMapping = getShopWorksSizeMappingFromSizes(skus, styleNumber, availableSizes, productTitle);

  return skus.map(sku => {
    const mapping = sizeMapping[sku];
    if (!mapping) {
      console.warn(`[mapSKUToFieldsEnhanced] No mapping found for ${sku}`);
      return {
        sku,
        type: 'unknown',
        sizeFields: {},
        pricing: null
      };
    }

    const enabledFields = Object.entries(mapping)
      .filter(([key, value]) => key.startsWith('Size') && value === true)
      .map(([key]) => key);

    return {
      sku,
      type: sku.includes('_') ? 'extended' : 'base',
      sizeFields: {
        Size01: mapping.Size01,
        Size02: mapping.Size02,
        Size03: mapping.Size03,
        Size04: mapping.Size04,
        Size05: mapping.Size05,
        Size06: mapping.Size06
      },
      enabledFields,
      pricing: mapping.pricing
    };
  });
}

/**
 * Map SKU to ShopWorks fields (Legacy - for backward compatibility)
 */
function mapSKUToFields(sku, styleNumber) {
  const suffix = sku.replace(styleNumber, '');

  if (!suffix) {
    // Base SKU
    return {
      sku,
      type: 'base',
      fields: ['Size01', 'Size02', 'Size03', 'Size04'],
      sizes: ['S', 'M', 'L', 'XL'],
      suffix: null
    };
  } else {
    // Suffix SKU
    const field = SUFFIX_TO_FIELD_MAP[suffix] || 'Size06';
    const size = suffix.replace('_', '');

    return {
      sku,
      type: 'extended',
      fields: [field],
      sizes: [size],
      suffix
    };
  }
}

/**
 * Get color mappings for a style
 */
async function getColorMappings(styleNumber) {
  try {
    const records = await fetchAllCaspioPages(
      '/tables/Sanmar_Bulk_251816_Feb2024/records',
      {
        'q.where': `STYLE='${styleNumber}'`,
        'q.select': 'COLOR_NAME, CATALOG_COLOR, COLOR_SQUARE_IMAGE',
        'q.groupBy': 'COLOR_NAME, CATALOG_COLOR, COLOR_SQUARE_IMAGE'
      }
    );

    return records.map(r => ({
      displayName: r.COLOR_NAME,
      catalogName: r.CATALOG_COLOR,
      imageUrl: r.COLOR_SQUARE_IMAGE
    }));
  } catch (error) {
    console.error('Error fetching color mappings:', error);
    throw error;
  }
}

/**
 * Get product information
 */
async function getProductInfo(styleNumber) {
  try {
    const records = await fetchAllCaspioPages(
      '/tables/Sanmar_Bulk_251816_Feb2024/records',
      {
        'q.where': `STYLE='${styleNumber}'`,
        'q.select': 'PRODUCT_TITLE, MILL',
        'q.limit': 1
      }
    );

    if (records.length === 0) {
      throw new Error(`Product not found: ${styleNumber}`);
    }

    return {
      productTitle: records[0].PRODUCT_TITLE,
      brand: records[0].MILL
    };
  } catch (error) {
    console.error('Error fetching product info:', error);
    throw error;
  }
}

/**
 * Get current SanMar pricing from Sanmar_Bulk table
 * Returns CASE_PRICE for the specified style and color
 */
async function getSanmarPricing(styleNumber, catalogColor) {
  try {
    console.log(`[getSanmarPricing] Querying pricing for ${styleNumber}, color: ${catalogColor}`);

    const records = await fetchAllCaspioPages(
      '/tables/Sanmar_Bulk_251816_Feb2024/records',
      {
        'q.where': `STYLE='${styleNumber}' AND CATALOG_COLOR='${catalogColor}'`,
        'q.select': 'SIZE, CASE_PRICE',
        'q.limit': 100
      }
    );

    if (records.length === 0) {
      console.warn(`[getSanmarPricing] No pricing found for ${styleNumber} in ${catalogColor}`);
      return null;
    }

    // Create a map of size to price
    const pricingMap = {};
    records.forEach(record => {
      if (record.SIZE && record.CASE_PRICE) {
        pricingMap[record.SIZE] = record.CASE_PRICE;
      }
    });

    console.log(`[getSanmarPricing] Found pricing for ${Object.keys(pricingMap).length} sizes`);
    return pricingMap;
  } catch (error) {
    console.error('[getSanmarPricing] Error:', error);
    return null;
  }
}

// ==========================================
// API ENDPOINTS
// ==========================================

/**
 * Primary mapping endpoint
 * GET /api/sanmar-shopworks/mapping?styleNumber=PC61&color=Forest
 *
 * Provides complete ShopWorks translation including:
 * - SKU structure (which SKUs to create)
 * - Size field mapping (which Size fields to populate)
 * - Color translations (display name → ShopWorks catalog name)
 * - Pricing for each SKU
 */
router.get('/sanmar-shopworks/mapping', async (req, res) => {
  try {
    const { styleNumber, color, includeInventory } = req.query;

    if (!styleNumber) {
      return res.status(400).json({ error: 'styleNumber parameter is required' });
    }

    // Check cache
    const cacheKey = `mapping_v2_${styleNumber}_${color}_${includeInventory}`;
    const cached = sanmarMappingCache.get(cacheKey);
    if (cached && (Date.now() - cached.timestamp < MAPPING_CACHE_TTL)) {
      console.log(`[Mapping] Cache hit for ${styleNumber}`);
      return res.json({...cached.data, cached: true});
    }

    console.log(`[Mapping] Fetching complete ShopWorks translation for ${styleNumber}`);

    // Get product info from Sanmar_Bulk
    const productInfo = await getProductInfo(styleNumber);

    // Detect SKU pattern from Sanmar_Bulk sizes
    const skuPattern = await detectSKUPattern(styleNumber);

    if (skuPattern.type === 'not-found') {
      return res.status(404).json({
        error: `Product ${styleNumber} not found in Sanmar catalog`,
        suggestion: 'This product may not exist in the current catalog data'
      });
    }

    // Get all available sizes for deriving field mappings
    const allSizePricing = await getAvailableSizesFromBulk(styleNumber, null);
    const allAvailableSizes = Object.keys(allSizePricing);

    // Get enhanced SKU mappings with derived size fields
    const shopworksInventoryEntries = mapSKUToFieldsEnhanced(skuPattern.skus, styleNumber, allAvailableSizes, productInfo.productTitle);

    // Get color mappings from Sanmar_Bulk
    const availableColors = await getColorMappings(styleNumber);

    // If color specified, find the selected color
    let selectedColor = null;
    let currentSanmarPricing = null;
    if (color) {
      selectedColor = availableColors.find(c =>
        c.displayName.toLowerCase().includes(color.toLowerCase()) ||
        c.catalogName.toLowerCase().includes(color.toLowerCase())
      );
      if (!selectedColor) {
        console.warn(`[Mapping] Color "${color}" not found for ${styleNumber}`);
      } else {
        // Get current SanMar pricing for this color
        currentSanmarPricing = await getSanmarPricing(styleNumber, selectedColor.catalogName);
      }
    }

    // Build comprehensive response
    const response = {
      styleNumber,
      productTitle: productInfo.productTitle,
      brand: productInfo.brand,
      skuPattern: skuPattern.type,
      skuCount: skuPattern.skus.length,
      availableColors: availableColors.map(c => ({
        displayName: c.displayName,
        shopworksColor: c.catalogName,
        imageUrl: c.imageUrl
      })),
      selectedColor: selectedColor ? {
        displayName: selectedColor.displayName,
        shopworksColor: selectedColor.catalogName
      } : null,
      currentSanmarPricing: currentSanmarPricing,
      shopworksInventoryEntries,
      usage: {
        instructions: 'Create inventory entries in ShopWorks using the data below',
        steps: [
          '1. For each SKU in shopworksInventoryEntries',
          '2. Create a new product with ID_Product = sku',
          '3. Set the color to shopworksColor (from selectedColor or choose from availableColors)',
          '4. Populate the Size fields where sizeFields[SizeXX] = true',
          '5. Use currentSanmarPricing[size] for current CASE_PRICE from SanMar',
          '6. shopworksInventoryEntries[].pricing.case shows ShopWorks reference pricing'
        ]
      },
      cached: false
    };

    // Optional: Include inventory data
    if (includeInventory === 'true' && selectedColor) {
      console.log(`[Mapping] Including inventory note for color: ${selectedColor.catalogName}`);
      response.inventoryNote = 'Use /api/manageorders/inventorylevels for real-time inventory levels';
    }

    // Cache the response
    sanmarMappingCache.set(cacheKey, {
      data: response,
      timestamp: Date.now()
    });

    // Limit cache size (keep last 100 entries)
    if (sanmarMappingCache.size > 100) {
      const firstKey = sanmarMappingCache.keys().next().value;
      sanmarMappingCache.delete(firstKey);
    }

    res.json(response);
  } catch (error) {
    console.error('[Mapping] Error:', error);
    res.status(500).json({
      error: 'Failed to fetch mapping data',
      details: error.message
    });
  }
});

/**
 * Helper endpoint: Get suffix mapping rules
 * GET /api/sanmar-shopworks/suffix-mapping
 */
router.get('/sanmar-shopworks/suffix-mapping', async (req, res) => {
  try {
    res.json({
      mappingRules: SUFFIX_TO_FIELD_MAP,
      notes: {
        Size05Exception: '_2XL and _2X are the ONLY suffixes using Size05',
        Size06Reuse: 'All other suffixes use Size06 (field reuse pattern)',
        Examples: {
          '_2XL': 'Size05 - Standard 2XL',
          '_XXL': 'Size06 - Womens 2XL (different from _2XL!)',
          '_3XL': 'Size06 - First use of Size06',
          '_4XL': 'Size06 - Reuses Size06 field',
          '_OSFA': 'Size06 - One size fits all'
        }
      }
    });
  } catch (error) {
    console.error('[Suffix Mapping] Error:', error);
    res.status(500).json({ error: 'Failed to fetch suffix mapping' });
  }
});

/**
 * Helper endpoint: Get color mapping for a style
 * GET /api/sanmar-shopworks/color-mapping?styleNumber=PC61
 */
router.get('/sanmar-shopworks/color-mapping', async (req, res) => {
  try {
    const { styleNumber } = req.query;

    if (!styleNumber) {
      return res.status(400).json({ error: 'styleNumber parameter is required' });
    }

    const colorMappings = await getColorMappings(styleNumber);

    res.json({
      styleNumber,
      colorCount: colorMappings.length,
      colors: colorMappings,
      usage: {
        displayName: 'Use for UI display',
        catalogName: 'Use for API queries and ShopWorks imports'
      }
    });
  } catch (error) {
    console.error('[Color Mapping] Error:', error);
    res.status(500).json({ error: 'Failed to fetch color mapping' });
  }
});

/**
 * ShopWorks import-ready format
 * GET /api/sanmar-shopworks/import-format?styleNumber=PC850&color=Cardinal
 *
 * Returns flat JSON array with one entry per SKU, ready for ShopWorks import
 * Each entry includes all size fields with actual size values where enabled
 * Color is optional — when omitted, returns sizes across all colors
 */
router.get('/sanmar-shopworks/import-format', async (req, res) => {
  try {
    const { styleNumber, color } = req.query;

    if (!styleNumber) {
      return res.status(400).json({ error: 'styleNumber parameter is required' });
    }

    console.log(`[Import Format] Generating ShopWorks import data for ${styleNumber} ${color || '(all colors)'}`);

    // Get product info
    const productInfo = await getProductInfo(styleNumber);

    // Resolve color to CATALOG_COLOR if provided
    let catalogColor = null;
    let displayColor = color || null;
    if (color) {
      const availableColors = await getColorMappings(styleNumber);
      const selectedColor = availableColors.find(c =>
        c.displayName.toLowerCase().includes(color.toLowerCase()) ||
        c.catalogName.toLowerCase().includes(color.toLowerCase())
      );

      if (!selectedColor) {
        return res.status(404).json({
          error: `Color "${color}" not found for ${styleNumber}`,
          availableColors: availableColors.map(c => c.displayName)
        });
      }

      catalogColor = selectedColor.catalogName;
      displayColor = selectedColor.displayName;
    }

    // Get available sizes and pricing from Sanmar_Bulk
    const sizePricing = await getAvailableSizesFromBulk(styleNumber, catalogColor);
    const availableSizes = Object.keys(sizePricing);

    if (availableSizes.length === 0) {
      return res.status(404).json({
        error: `No sizes found for ${styleNumber}${catalogColor ? ` in ${catalogColor}` : ''}`
      });
    }

    // Build import-ready entries from available sizes
    const importEntries = [];

    // Base SKU for standard sizes (S, M, L, XL)
    const hasStandardSizes = availableSizes.some(s => STANDARD_SIZES.includes(s));
    if (hasStandardSizes) {
      importEntries.push({
        ID_Product: styleNumber,
        CATALOG_COLOR: catalogColor,
        COLOR_NAME: displayColor,
        Description: productInfo.productTitle,
        Brand: productInfo.brand,
        CASE_PRICE: sizePricing['S'] || sizePricing['M'] || sizePricing['L'] || sizePricing['XL'],
        Size01: availableSizes.includes('S') ? 'S' : null,
        Size02: availableSizes.includes('M') ? 'M' : null,
        Size03: availableSizes.includes('L') ? 'L' : null,
        Size04: availableSizes.includes('XL') ? 'XL' : null,
        Size05: null,
        Size06: null
      });
    }

    // Extended sizes: each gets its own SKU entry
    const extendedSizes = availableSizes.filter(s => !STANDARD_SIZES.includes(s));
    extendedSizes.forEach(size => {
      const suffix = SIZE_TO_SUFFIX[size] || `_${size}`;
      const isTwoXL = size === '2XL';

      importEntries.push({
        ID_Product: `${styleNumber}${suffix}`,
        CATALOG_COLOR: catalogColor,
        COLOR_NAME: displayColor,
        Description: `${productInfo.productTitle} (${size})`,
        Brand: productInfo.brand,
        CASE_PRICE: sizePricing[size],
        Size01: null,
        Size02: null,
        Size03: null,
        Size04: null,
        Size05: isTwoXL ? size : null,
        Size06: !isTwoXL ? size : null
      });
    });

    // Sort by CASE_PRICE ascending (lowest to highest)
    importEntries.sort((a, b) => {
      if (a.CASE_PRICE === null) return 1;
      if (b.CASE_PRICE === null) return -1;
      return a.CASE_PRICE - b.CASE_PRICE;
    });

    console.log(`[Import Format] Returning ${importEntries.length} entries for ${styleNumber} (${availableSizes.length} sizes)`);
    res.json(importEntries);
  } catch (error) {
    console.error('[Import Format] Error:', error);
    res.status(500).json({
      error: 'Failed to generate import format',
      details: error.message
    });
  }
});

/**
 * Transform embroidery quote items to ShopWorks LinesOE format
 * POST /api/sanmar-shopworks/quote-to-linesoe
 *
 * Takes quote builder line items and transforms them into ShopWorks-ready format:
 * - Standard sizes (S/M/L/XL) grouped into single line item
 * - Each extended size (2XL, 3XL, etc.) becomes separate line item with suffix
 * - Proper Size01-Size06 field population
 * - Size limit flags set correctly
 */
router.post('/sanmar-shopworks/quote-to-linesoe', async (req, res) => {
  try {
    const { quoteId, items, embroideryConfig } = req.body;

    if (!items || !Array.isArray(items)) {
      return res.status(400).json({ error: 'items array is required' });
    }

    console.log(`[Quote to LinesOE] Processing ${items.length} items for quote ${quoteId || 'N/A'}`);

    const lineItems = [];

    for (const item of items) {
      const { styleNumber, color, catalogColor, description, sizes, unitPrice, sizeUpcharges } = item;

      if (!styleNumber || !sizes) {
        console.warn('[Quote to LinesOE] Skipping item with missing styleNumber or sizes');
        continue;
      }

      // Group sizes into standard (S/M/L/XL) and extended (2XL+)
      const standardSizes = ['S', 'M', 'L', 'XL'];
      const standardQty = {};
      const extendedSizes = {};

      for (const [size, qty] of Object.entries(sizes)) {
        if (qty > 0) {
          if (standardSizes.includes(size)) {
            standardQty[size] = qty;
          } else {
            extendedSizes[size] = qty;
          }
        }
      }

      // Create base line item for standard sizes
      const totalStandardQty = Object.values(standardQty).reduce((a, b) => a + b, 0);
      if (totalStandardQty > 0) {
        lineItems.push({
          PartNumber: styleNumber,
          Color: catalogColor || color,
          Description: description,
          Qty: totalStandardQty,
          Price: unitPrice,
          Size01: standardQty['S'] || null,
          Size02: standardQty['M'] || null,
          Size03: standardQty['L'] || null,
          Size04: standardQty['XL'] || null,
          Size05: null,
          Size06: null,
          sts_LimitSize01: null,
          sts_LimitSize02: null,
          sts_LimitSize03: null,
          sts_LimitSize04: null,
          sts_LimitSize05: 1,
          sts_LimitSize06: 1,
          sts_EnableTax01: 1,
          sts_EnableTax02: 1,
          sts_EnableTax03: 1,
          sts_EnableTax04: 1,
          sts_TaxOverride: 1
        });
      }

      // SIZE_MODIFIERS for correct ShopWorks suffix format (matches Python Inksoft app)
      const SIZE_MODIFIERS = {
        '2XL': '_2X', '3XL': '_3X', '4XL': '_4X', '5XL': '_5X', '6XL': '_6X'
      };

      // Create separate line items for each extended size
      for (const [size, qty] of Object.entries(extendedSizes)) {
        // Use SIZE_MODIFIERS for correct suffix (e.g., _2X not _2XL)
        const suffix = SIZE_MODIFIERS[size] || `_${size}`;
        const upcharge = sizeUpcharges?.[size] || 0;
        const isTwoXL = size === '2XL';

        lineItems.push({
          PartNumber: `${styleNumber}${suffix}`,
          Color: catalogColor || color,
          Description: `${description} (${size})`,
          Qty: qty,
          Price: unitPrice + upcharge,
          Size01: null,
          Size02: null,
          Size03: null,
          Size04: null,
          Size05: isTwoXL ? qty : null,
          Size06: !isTwoXL ? qty : null,
          sts_LimitSize01: 1,
          sts_LimitSize02: 1,
          sts_LimitSize03: 1,
          sts_LimitSize04: 1,
          sts_LimitSize05: isTwoXL ? null : 1,
          sts_LimitSize06: !isTwoXL ? null : 1,
          sts_EnableTax01: 1,
          sts_EnableTax02: 1,
          sts_EnableTax03: 1,
          sts_EnableTax04: 1,
          sts_TaxOverride: 1
        });
      }
    }

    // Calculate totals
    const totalQty = lineItems.reduce((sum, item) => sum + item.Qty, 0);
    const totalValue = lineItems.reduce((sum, item) => sum + (item.Qty * item.Price), 0);

    console.log(`[Quote to LinesOE] Generated ${lineItems.length} line items, total qty: ${totalQty}`);

    res.json({
      quoteId,
      lineItems,
      embroideryConfig,
      totals: {
        lineItemCount: lineItems.length,
        totalQty,
        totalValue: Math.round(totalValue * 100) / 100
      }
    });
  } catch (error) {
    console.error('[Quote to LinesOE] Error:', error);
    res.status(500).json({
      error: 'Failed to transform quote to LinesOE format',
      details: error.message
    });
  }
});

// Export functions for testing
module.exports = router;
