const express = require('express');
const router = express.Router();
const { fetchInventoryLevels } = require('../utils/manageorders');

// Default colors for PC54 (fallback only)
const DEFAULT_COLORS = [
  'Jet Black',
  'Navy',
  'White',
  'Dk Hthr Grey',
  'Ath Heather'
];

// Color discovery cache configuration
const COLOR_DISCOVERY_CACHE_DURATION = 15 * 60 * 1000; // 15 minutes
let colorDiscoveryCache = {
  colors: null,
  timestamp: 0
};

// Size mapping from ManageOrders fields to standard sizes
const SIZE_MAPPING = {
  // PC54 (base SKU)
  'PC54': {
    'Size01': 'S',
    'Size02': 'M',
    'Size03': 'L',
    'Size04': 'XL'
  },
  // PC54_2X
  'PC54_2X': {
    'Size05': '2XL'
  },
  // PC54_3X
  'PC54_3X': {
    'Size06': '3XL'
  }
};

// Standard size order for display
const SIZE_ORDER = ['S', 'M', 'L', 'XL', '2XL', '3XL'];

// Cache configuration
const CACHE_DURATION = 5 * 60 * 1000; // 5 minutes
const cache = new Map();

// Cache cleanup interval
setInterval(() => {
  const now = Date.now();
  for (const [key, value] of cache.entries()) {
    if (now - value.timestamp > CACHE_DURATION) {
      cache.delete(key);
      console.log(`[PC54 CACHE CLEANUP] Removed expired entry: ${key}`);
    }
  }
}, CACHE_DURATION);

/**
 * Aggregate inventory data by color
 * @param {Array} inventoryResults - Raw inventory results from ManageOrders API
 * @returns {Object} - Aggregated data by color
 */
function aggregateByColor(inventoryResults) {
  const colorMap = {};

  // Process each inventory record
  for (const record of inventoryResults) {
    const color = record.Color;
    const partNumber = record.PartNumber;

    // Initialize color entry if it doesn't exist
    if (!colorMap[color]) {
      colorMap[color] = {
        total: 0,
        sizes: {},
        skus: {}
      };
      // Initialize all sizes to 0
      SIZE_ORDER.forEach(size => {
        colorMap[color].sizes[size] = 0;
      });
    }

    // Initialize SKU entry if it doesn't exist
    if (!colorMap[color].skus[partNumber]) {
      colorMap[color].skus[partNumber] = {};
    }

    // Map size fields to standard sizes
    const sizeMap = SIZE_MAPPING[partNumber] || {};

    for (const [sizeField, sizeName] of Object.entries(sizeMap)) {
      const quantity = parseInt(record[sizeField]) || 0;

      // Store raw SKU data
      colorMap[color].skus[partNumber][sizeField] = quantity;

      // Add to aggregated size totals
      colorMap[color].sizes[sizeName] = (colorMap[color].sizes[sizeName] || 0) + quantity;

      // Add to total
      colorMap[color].total += quantity;
    }
  }

  return colorMap;
}

/**
 * Discover all available PC54 colors from ManageOrders
 * Uses 15-minute cache to reduce API calls
 * @param {boolean} forceRefresh - Force refresh the cache
 * @returns {Promise<Array<string>>} - Array of color names
 */
async function discoverPC54Colors(forceRefresh = false) {
  const now = Date.now();
  const cacheAge = now - colorDiscoveryCache.timestamp;

  // Check if cache is valid
  if (!forceRefresh && colorDiscoveryCache.colors && cacheAge < COLOR_DISCOVERY_CACHE_DURATION) {
    console.log(`[PC54 COLOR DISCOVERY] Using cached colors (age: ${Math.round(cacheAge / 1000)}s)`);
    return colorDiscoveryCache.colors;
  }

  console.log('[PC54 COLOR DISCOVERY] Fetching fresh color list from ManageOrders...');

  try {
    // Fetch all PC54 inventory without color filter to discover all colors
    const inventoryData = await fetchInventoryLevels({ PartNumber: 'PC54' });

    // Extract unique colors
    const uniqueColors = [...new Set(inventoryData.map(record => record.Color))].filter(Boolean);

    if (uniqueColors.length === 0) {
      console.warn('[PC54 COLOR DISCOVERY] No colors found, using fallback');
      return DEFAULT_COLORS;
    }

    console.log(`[PC54 COLOR DISCOVERY] Found ${uniqueColors.length} colors: ${uniqueColors.join(', ')}`);

    // Update cache
    colorDiscoveryCache = {
      colors: uniqueColors,
      timestamp: Date.now()
    };

    return uniqueColors;

  } catch (error) {
    console.error('[PC54 COLOR DISCOVERY ERROR]', error.message);
    console.warn('[PC54 COLOR DISCOVERY] Falling back to default colors');
    return DEFAULT_COLORS;
  }
}

/**
 * GET /api/manageorders/pc54-inventory
 *
 * Optimized endpoint for fetching PC54 inventory across all SKUs and colors
 *
 * Query Parameters:
 * - colors: Optional comma-separated list of colors (e.g., "Jet Black,Navy")
 * - refresh: Set to "true" to bypass cache
 *
 * Response:
 * {
 *   partNumber: "PC54",
 *   lastUpdated: "2025-11-17T10:30:00Z",
 *   colors: {
 *     "Jet Black": {
 *       total: 137,
 *       sizes: { S: 4, M: 10, L: 11, XL: 79, "2XL": 27, "3XL": 6 },
 *       skus: {
 *         "PC54": { Size01: 4, Size02: 10, Size03: 11, Size04: 79 },
 *         "PC54_2X": { Size05: 27 },
 *         "PC54_3X": { Size06: 6 }
 *       }
 *     }
 *   }
 * }
 */
router.get('/manageorders/pc54-inventory', async (req, res) => {
  try {
    // Parse color filter - if not provided, discover all colors dynamically
    let requestedColors;
    if (req.query.colors) {
      // User specified colors explicitly
      requestedColors = req.query.colors.split(',').map(c => c.trim());
      console.log(`[PC54] Using user-specified colors: ${requestedColors.join(', ')}`);
    } else {
      // Discover colors dynamically from ManageOrders
      requestedColors = await discoverPC54Colors(req.query.refresh === 'true');
      console.log(`[PC54] Using ${requestedColors.length} discovered colors`);
    }

    // Check for cache bypass
    const bypassCache = req.query.refresh === 'true';

    // Create cache key
    const cacheKey = JSON.stringify({ colors: requestedColors });

    // Check cache
    if (!bypassCache && cache.has(cacheKey)) {
      const cachedData = cache.get(cacheKey);
      const age = Date.now() - cachedData.timestamp;

      if (age < CACHE_DURATION) {
        console.log(`[PC54 CACHE HIT] Age: ${Math.round(age / 1000)}s, Colors: ${requestedColors.length}`);
        return res.json({
          ...cachedData.data,
          cached: true,
          cacheAge: Math.round(age / 1000)
        });
      }
    }

    console.log(`[PC54 CACHE MISS] Fetching fresh data for ${requestedColors.length} colors`);

    // Build parallel fetch promises for all SKU/color combinations
    const skus = ['PC54', 'PC54_2X', 'PC54_3X'];
    const fetchPromises = [];

    for (const color of requestedColors) {
      for (const sku of skus) {
        fetchPromises.push(
          fetchInventoryLevels({ PartNumber: sku, Color: color })
            .then(results => ({
              color,
              sku,
              records: results
            }))
            .catch(error => {
              console.error(`[PC54 FETCH ERROR] SKU: ${sku}, Color: ${color}, Error: ${error.message}`);
              return { color, sku, records: [] }; // Return empty on error
            })
        );
      }
    }

    // Execute all fetches in parallel
    const startTime = Date.now();
    const fetchResults = await Promise.all(fetchPromises);
    const fetchDuration = Date.now() - startTime;

    console.log(`[PC54 PARALLEL FETCH] Completed ${fetchPromises.length} requests in ${fetchDuration}ms`);

    // Flatten results into single array
    const allInventoryRecords = fetchResults.flatMap(result => result.records);

    console.log(`[PC54 AGGREGATION] Processing ${allInventoryRecords.length} inventory records`);

    // Aggregate by color
    const colorData = aggregateByColor(allInventoryRecords);

    // Build response
    const response = {
      partNumber: 'PC54',
      lastUpdated: new Date().toISOString(),
      colors: colorData,
      cached: false
    };

    // Add warnings if no data found
    if (Object.keys(colorData).length === 0) {
      response.warnings = ['No inventory data found for the requested colors'];
    }

    // Cache the response
    cache.set(cacheKey, {
      data: response,
      timestamp: Date.now()
    });

    console.log(`[PC54 CACHE STORED] Key: ${cacheKey}, Colors: ${Object.keys(colorData).length}`);

    res.json(response);

  } catch (error) {
    console.error('[PC54 ERROR]', error);
    res.status(500).json({
      error: 'Failed to fetch PC54 inventory',
      message: error.message
    });
  }
});

/**
 * GET /api/manageorders/pc54-inventory/cache-stats
 *
 * Debug endpoint to view cache statistics
 */
router.get('/manageorders/pc54-inventory/cache-stats', (req, res) => {
  const stats = {
    totalEntries: cache.size,
    entries: []
  };

  for (const [key, value] of cache.entries()) {
    const age = Date.now() - value.timestamp;
    stats.entries.push({
      key,
      age: Math.round(age / 1000),
      colorCount: Object.keys(value.data.colors || {}).length,
      expires: Math.round((CACHE_DURATION - age) / 1000)
    });
  }

  res.json(stats);
});

/**
 * POST /api/manageorders/pc54-inventory/cache-clear
 *
 * Clear the PC54 inventory cache
 */
router.post('/manageorders/pc54-inventory/cache-clear', (req, res) => {
  const sizeBefore = cache.size;
  cache.clear();
  console.log(`[PC54 CACHE CLEARED] Removed ${sizeBefore} entries`);

  res.json({
    message: 'PC54 inventory cache cleared',
    entriesRemoved: sizeBefore
  });
});

/**
 * GET /api/manageorders/pc54-inventory/colors
 *
 * Debug endpoint to view discovered colors and cache status
 */
router.get('/manageorders/pc54-inventory/colors', async (req, res) => {
  const forceRefresh = req.query.refresh === 'true';

  try {
    const colors = await discoverPC54Colors(forceRefresh);
    const cacheAge = Date.now() - colorDiscoveryCache.timestamp;

    res.json({
      colors: colors,
      count: colors.length,
      cached: !forceRefresh && cacheAge < COLOR_DISCOVERY_CACHE_DURATION,
      cacheAge: Math.round(cacheAge / 1000),
      cacheExpires: Math.round((COLOR_DISCOVERY_CACHE_DURATION - cacheAge) / 1000),
      cacheDuration: COLOR_DISCOVERY_CACHE_DURATION / 1000,
      fallbackColors: DEFAULT_COLORS
    });
  } catch (error) {
    res.status(500).json({
      error: 'Failed to discover colors',
      message: error.message,
      fallbackColors: DEFAULT_COLORS
    });
  }
});

module.exports = router;
