// ==========================================
// Sanmar to ShopWorks Mapping API
// ==========================================
// Provides centralized mapping logic for:
// - SKU pattern detection (single-SKU vs multi-SKU variants)
// - Suffix-to-field mapping (_2XL → Size05, others → Size06)
// - Color normalization (COLOR_NAME ↔ CATALOG_COLOR)
// - Optional real-time inventory aggregation

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
 * Detect SKU pattern for a product
 * Returns: single-sku, standard-multi-sku (3 SKUs), or extended-multi-sku (4-6 SKUs)
 */
async function detectSKUPattern(styleNumber) {
  try {
    // Check for all potential SKU variants
    const potentialSKUs = [
      styleNumber,              // Base
      `${styleNumber}_XS`,      // Extra small
      `${styleNumber}_2XL`,     // Standard extension
      `${styleNumber}_3XL`,     // Additional size
      `${styleNumber}_4XL`,     // Extended
      `${styleNumber}_5XL`,     // Extended
      `${styleNumber}_6XL`,     // Extended
      `${styleNumber}_XXL`,     // Women's variant
    ];

    // Query Caspio to check which SKUs exist
    const existingSKUs = [];
    for (const sku of potentialSKUs) {
      const records = await fetchAllCaspioPages(
        '/tables/Sanmar_Bulk_251816_Feb2024/records',
        {
          'q.where': `STYLE='${sku}'`,
          'q.select': 'STYLE',
          'q.limit': 1
        }
      );
      if (records.length > 0) {
        existingSKUs.push(sku);
      }
    }

    // Determine pattern type
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
        description: 'Extended pattern with 4-6 SKUs (e.g., PC61)'
      };
    }
  } catch (error) {
    console.error('Error detecting SKU pattern:', error);
    throw error;
  }
}

/**
 * Map SKU to ShopWorks fields
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

// ==========================================
// API ENDPOINTS
// ==========================================

/**
 * Primary mapping endpoint
 * GET /api/sanmar-shopworks/mapping?styleNumber=PC61&includeInventory=true&colors=Forest,Black
 */
app.get('/api/sanmar-shopworks/mapping', async (req, res) => {
  try {
    const { styleNumber, includeInventory, colors } = req.query;

    if (!styleNumber) {
      return res.status(400).json({ error: 'styleNumber parameter is required' });
    }

    // Check cache
    const cacheKey = `mapping_${styleNumber}_${includeInventory}_${colors}`;
    const cached = sanmarMappingCache.get(cacheKey);
    if (cached && (Date.now() - cached.timestamp < MAPPING_CACHE_TTL)) {
      console.log(`[Mapping] Cache hit for ${styleNumber}`);
      return res.json(cached.data);
    }

    console.log(`[Mapping] Fetching mapping data for ${styleNumber}`);

    // Get product info
    const productInfo = await getProductInfo(styleNumber);

    // Detect SKU pattern
    const skuPattern = await detectSKUPattern(styleNumber);

    // Map each SKU to ShopWorks fields
    const skuMappings = skuPattern.skus.map(sku =>
      mapSKUToFields(sku, styleNumber)
    );

    // Get color mappings
    const colorMappings = await getColorMappings(styleNumber);

    // Filter colors if specified
    let selectedColors = colorMappings;
    if (colors) {
      const colorList = colors.split(',').map(c => c.trim());
      selectedColors = colorMappings.filter(cm =>
        colorList.includes(cm.catalogName) || colorList.includes(cm.displayName)
      );
    }

    // Build response
    const response = {
      styleNumber,
      productTitle: productInfo.productTitle,
      brand: productInfo.brand,
      skuPattern: skuPattern.type,
      skuCount: skuPattern.skus.length,
      skus: skuMappings,
      colors: selectedColors,
      mappingRules: SUFFIX_TO_FIELD_MAP,
      cached: false
    };

    // Optional: Include inventory
    if (includeInventory === 'true' && selectedColors.length > 0) {
      console.log(`[Mapping] Including inventory for ${selectedColors.length} colors`);
      // This would integrate with ManageOrders API
      // For now, we'll add a placeholder
      response.colors = response.colors.map(color => ({
        ...color,
        inventoryNote: 'Use /api/manageorders/inventorylevels for real-time inventory'
      }));
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
app.get('/api/sanmar-shopworks/suffix-mapping', async (req, res) => {
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
app.get('/api/sanmar-shopworks/color-mapping', async (req, res) => {
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

// Export functions for testing
module.exports = {
  SUFFIX_TO_FIELD_MAP,
  detectSKUPattern,
  mapSKUToFields,
  getColorMappings,
  getProductInfo
};
