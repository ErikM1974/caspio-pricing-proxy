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

/**
 * Detect SKU pattern for a product by querying Shopworks_Integration table
 * Returns: single-sku, standard-multi-sku (2-3 SKUs), or extended-multi-sku (4+ SKUs)
 */
async function detectSKUPattern(styleNumber) {
  try {
    console.log(`[detectSKUPattern] Querying Shopworks_Integration for ${styleNumber}`);

    // Query Shopworks_Integration table for all SKU variants
    // This is the authoritative source for SKU structure
    // Match exact style or style with underscore suffix (PC850 or PC850_2XL, but not PC850H)
    const records = await fetchAllCaspioPages(
      '/tables/Shopworks_Integration/records',
      {
        'q.where': `ID_Product='${styleNumber}' OR ID_Product LIKE '${styleNumber}[_]%'`,
        'q.select': 'ID_Product',
        'q.limit': 50
      }
    );

    if (records.length === 0) {
      console.log(`[detectSKUPattern] No records found in Shopworks_Integration for ${styleNumber}`);
      return {
        type: 'not-found',
        skus: [],
        description: 'Product not found in ShopWorks integration table'
      };
    }

    // Extract SKU IDs
    const existingSKUs = records.map(r => r.ID_Product);
    console.log(`[detectSKUPattern] Found ${existingSKUs.length} SKUs:`, existingSKUs);

    // Determine pattern type based on number of SKUs
    if (existingSKUs.length === 1) {
      return {
        type: 'single-sku',
        skus: existingSKUs,
        description: 'All sizes in one SKU (e.g., hoodies, jackets)'
      };
    } else if (existingSKUs.length <= 3) {
      return {
        type: 'standard-multi-sku',
        skus: existingSKUs,
        description: 'Base + _2XL + _3XL pattern (e.g., PC54)'
      };
    } else {
      return {
        type: 'extended-multi-sku',
        skus: existingSKUs,
        description: `Extended pattern with ${existingSKUs.length} SKUs (e.g., PC61, J790)`
      };
    }
  } catch (error) {
    console.error('[detectSKUPattern] Error:', error);
    throw error;
  }
}

/**
 * Get ShopWorks size field mapping from Shopworks_Integration table
 * Returns the actual size field configuration for each SKU
 */
async function getShopWorksSizeMapping(skus) {
  try {
    const skuList = skus.map(s => `'${s}'`).join(',');
    const records = await fetchAllCaspioPages(
      '/tables/Shopworks_Integration/records',
      {
        'q.where': `ID_Product IN (${skuList})`,
        'q.select': 'ID_Product, sts_LimitSize01, sts_LimitSize02, sts_LimitSize03, sts_LimitSize04, sts_LimitSize05, sts_LimitSize06, Price_Unit_Case, Description',
        'q.limit': 100
      }
    );

    // Create a map of SKU to size fields
    // NOTE: sts_LimitSizeXX = 1 means BLOCKED, null means ENABLED
    // So we use single negation: !1 = false (blocked), !null = true (enabled)
    const sizeMap = {};
    records.forEach(record => {
      sizeMap[record.ID_Product] = {
        Size01: !record.sts_LimitSize01,
        Size02: !record.sts_LimitSize02,
        Size03: !record.sts_LimitSize03,
        Size04: !record.sts_LimitSize04,
        Size05: !record.sts_LimitSize05,
        Size06: !record.sts_LimitSize06,
        pricing: {
          case: record.Price_Unit_Case
        },
        description: record.Description
      };
    });

    return sizeMap;
  } catch (error) {
    console.error('[getShopWorksSizeMapping] Error:', error);
    throw error;
  }
}

/**
 * Map SKU to ShopWorks fields using actual Shopworks_Integration data
 */
async function mapSKUToFieldsEnhanced(skus) {
  const sizeMapping = await getShopWorksSizeMapping(skus);

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

    // Determine which size fields are enabled
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

    // Detect SKU pattern from Shopworks_Integration
    const skuPattern = await detectSKUPattern(styleNumber);

    if (skuPattern.type === 'not-found') {
      return res.status(404).json({
        error: `Product ${styleNumber} not found in ShopWorks integration table`,
        suggestion: 'This product may not be configured for ShopWorks import yet'
      });
    }

    // Get enhanced SKU mappings with actual size fields and pricing
    const shopworksInventoryEntries = await mapSKUToFieldsEnhanced(skuPattern.skus);

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
 */
router.get('/sanmar-shopworks/import-format', async (req, res) => {
  try {
    const { styleNumber, color } = req.query;

    if (!styleNumber) {
      return res.status(400).json({ error: 'styleNumber parameter is required' });
    }

    if (!color) {
      return res.status(400).json({ error: 'color parameter is required for import format' });
    }

    console.log(`[Import Format] Generating ShopWorks import data for ${styleNumber} ${color}`);

    // Get product info
    const productInfo = await getProductInfo(styleNumber);

    // Detect SKU pattern
    const skuPattern = await detectSKUPattern(styleNumber);

    if (skuPattern.type === 'not-found') {
      return res.status(404).json({
        error: `Product ${styleNumber} not found in ShopWorks integration table`
      });
    }

    // Get size mappings
    const sizeMapping = await getShopWorksSizeMapping(skuPattern.skus);

    // Get color mapping
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

    // Get current pricing
    const currentPricing = await getSanmarPricing(styleNumber, selectedColor.catalogName);

    // Map of size abbreviations to size field names
    const sizeFieldMap = {
      'XS': 'Size06',
      'S': 'Size01',
      'M': 'Size02',
      'L': 'Size03',
      'XL': 'Size04',
      '2XL': 'Size05',
      '3XL': 'Size06',
      '4XL': 'Size06'
    };

    // Build import-ready entries
    const importEntries = skuPattern.skus.map(sku => {
      const mapping = sizeMapping[sku];
      if (!mapping) return null;

      // Determine which sizes this SKU handles
      const sizes = {};
      if (mapping.Size01) sizes.Size01 = 'S';
      if (mapping.Size02) sizes.Size02 = 'M';
      if (mapping.Size03) sizes.Size03 = 'L';
      if (mapping.Size04) sizes.Size04 = 'XL';
      if (mapping.Size05) sizes.Size05 = '2XL';
      if (mapping.Size06) {
        // Size06 can be XS, 3XL, 4XL depending on SKU
        if (sku.includes('_XS')) sizes.Size06 = 'XS';
        else if (sku.includes('_4XL')) sizes.Size06 = '4XL';
        else if (sku.includes('_3XL')) sizes.Size06 = '3XL';
      }

      return {
        ID_Product: sku,
        Color_Catalog: selectedColor.catalogName,  // CATALOG_COLOR - for ShopWorks
        Color_Display: selectedColor.displayName,  // COLOR_NAME - for display
        Description: mapping.description || productInfo.productTitle,
        Brand: productInfo.brand,
        Price_Unit_Case: mapping.pricing.case,
        CurrentSanmarPrice: currentPricing ? Object.values(currentPricing)[0] : null,
        Size01: sizes.Size01 || null,
        Size02: sizes.Size02 || null,
        Size03: sizes.Size03 || null,
        Size04: sizes.Size04 || null,
        Size05: sizes.Size05 || null,
        Size06: sizes.Size06 || null
      };
    }).filter(Boolean);

    res.json(importEntries);
  } catch (error) {
    console.error('[Import Format] Error:', error);
    res.status(500).json({
      error: 'Failed to generate import format',
      details: error.message
    });
  }
});

// Export functions for testing
module.exports = router;
