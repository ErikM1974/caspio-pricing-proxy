/**
 * JDS Industries API Routes
 *
 * Provides endpoints for accessing JDS product data, pricing tiers, and inventory levels.
 *
 * Endpoints:
 * - POST /api/jds/products - Batch search products by SKUs
 * - GET /api/jds/products/:sku - Get single product details
 * - GET /api/jds/inventory/:sku - Get inventory levels only
 * - GET /api/jds/health - Health check
 *
 * Features:
 * - 1-hour caching for product data
 * - Parameter-aware caching (different SKUs = different cache)
 * - Cache bypass with ?refresh=true
 * - Partial results (returns found products, skips missing SKUs)
 */

const express = require('express');
const router = express.Router();
const { searchProducts, getProductDetails, getInventoryLevels } = require('../utils/jds');
const config = require('../../config');

// Cache management (parameter-aware using Map)
let productsCache = new Map();
const CACHE_DURATION = config.jds.cacheDuration; // 1 hour

/**
 * POST /api/jds/products
 *
 * Search for multiple products by SKUs (batch query)
 *
 * Request Body:
 * {
 *   "skus": ["SKU1", "SKU2", "SKU3"]
 * }
 *
 * Query Parameters:
 * - refresh (boolean): Force cache refresh (default: false)
 *
 * Response:
 * {
 *   "result": [...products...],
 *   "count": 3,
 *   "requested": 3,
 *   "cached": false,
 *   "cacheDate": "2025-11-06T10:30:00Z"
 * }
 *
 * Notes:
 * - Returns partial results if some SKUs don't exist (no error)
 * - SKUs are case-sensitive
 * - Cache is shared for identical SKU sets (order doesn't matter)
 */
router.post('/products', async (req, res) => {
  try {
    console.log('[JDS Route] POST /api/jds/products requested');

    const { skus } = req.body;
    const forceRefresh = req.query.refresh === 'true';

    // Validate input
    if (!skus || !Array.isArray(skus) || skus.length === 0) {
      return res.status(400).json({
        error: 'Request body must contain "skus" array with at least one SKU',
        example: {
          skus: ["LPB004", "LWB101", "SKU123"]
        },
        timestamp: new Date().toISOString()
      });
    }

    // Create cache key from sorted SKUs (order-independent)
    const cacheKey = skus.slice().sort().join('|');
    const now = Date.now();

    // Check cache
    const cached = productsCache.get(cacheKey);
    if (!forceRefresh && cached && (now - cached.timestamp) < CACHE_DURATION) {
      console.log(`[JDS Route] Returning cached results for ${skus.length} SKUs`);
      return res.json({
        result: cached.data,
        count: cached.data.length,
        requested: skus.length,
        cached: true,
        cacheDate: new Date(cached.timestamp).toISOString()
      });
    }

    // Fetch from JDS API
    console.log(`[JDS Route] Fetching fresh data for ${skus.length} SKUs...`);
    const products = await searchProducts(skus);

    // Update cache
    productsCache.set(cacheKey, {
      data: products,
      timestamp: now
    });

    console.log(`[JDS Route] Successfully returned ${products.length} products`);

    res.json({
      result: products,
      count: products.length,
      requested: skus.length,
      cached: false
    });

  } catch (error) {
    console.error('[JDS Route] POST /products error:', error.message);

    // Determine appropriate status code
    const statusCode = error.message.includes('not configured') ? 500 : 400;

    res.status(statusCode).json({
      error: 'Failed to search JDS products',
      details: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

/**
 * GET /api/jds/products/:sku
 *
 * Get details for a single product by SKU
 *
 * URL Parameters:
 * - sku: Product SKU (e.g., "LPB004")
 *
 * Query Parameters:
 * - refresh (boolean): Force cache refresh (default: false)
 *
 * Response:
 * {
 *   "result": {...product...},
 *   "cached": false
 * }
 *
 * Returns 404 if product not found
 */
router.get('/products/:sku', async (req, res) => {
  try {
    const { sku } = req.params;
    const forceRefresh = req.query.refresh === 'true';

    console.log(`[JDS Route] GET /api/jds/products/${sku} requested`);

    if (!sku) {
      return res.status(400).json({
        error: 'SKU parameter is required',
        timestamp: new Date().toISOString()
      });
    }

    // Check cache (single SKU cache key)
    const cacheKey = `product:${sku}`;
    const now = Date.now();
    const cached = productsCache.get(cacheKey);

    if (!forceRefresh && cached && (now - cached.timestamp) < CACHE_DURATION) {
      console.log(`[JDS Route] Returning cached product: ${sku}`);
      return res.json({
        result: cached.data,
        cached: true,
        cacheDate: new Date(cached.timestamp).toISOString()
      });
    }

    // Fetch from JDS API
    console.log(`[JDS Route] Fetching fresh data for SKU: ${sku}`);
    const product = await getProductDetails(sku);

    if (!product) {
      return res.status(404).json({
        error: 'Product not found',
        sku: sku,
        timestamp: new Date().toISOString()
      });
    }

    // Update cache
    productsCache.set(cacheKey, {
      data: product,
      timestamp: now
    });

    console.log(`[JDS Route] Successfully returned product: ${sku}`);

    res.json({
      result: product,
      cached: false
    });

  } catch (error) {
    console.error(`[JDS Route] GET /products/${req.params.sku} error:`, error.message);
    res.status(500).json({
      error: 'Failed to fetch product details',
      details: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

/**
 * GET /api/jds/inventory/:sku
 *
 * Get inventory levels for a single product (quick stock check)
 *
 * URL Parameters:
 * - sku: Product SKU
 *
 * Query Parameters:
 * - refresh (boolean): Force cache refresh (default: false)
 *
 * Response:
 * {
 *   "result": {
 *     "sku": "LPB004",
 *     "availableQuantity": 4272,
 *     "localQuantity": 3154,
 *     "caseQuantity": 12,
 *     "inStock": true
 *   },
 *   "cached": false
 * }
 *
 * Use this for quick "Add to Cart" availability checks without full product data.
 */
router.get('/inventory/:sku', async (req, res) => {
  try {
    const { sku } = req.params;
    const forceRefresh = req.query.refresh === 'true';

    console.log(`[JDS Route] GET /api/jds/inventory/${sku} requested`);

    if (!sku) {
      return res.status(400).json({
        error: 'SKU parameter is required',
        timestamp: new Date().toISOString()
      });
    }

    // Check cache (inventory cache key)
    const cacheKey = `inventory:${sku}`;
    const now = Date.now();
    const cached = productsCache.get(cacheKey);

    if (!forceRefresh && cached && (now - cached.timestamp) < CACHE_DURATION) {
      console.log(`[JDS Route] Returning cached inventory: ${sku}`);
      return res.json({
        result: cached.data,
        cached: true,
        cacheDate: new Date(cached.timestamp).toISOString()
      });
    }

    // Fetch from JDS API
    console.log(`[JDS Route] Fetching fresh inventory for SKU: ${sku}`);
    const inventory = await getInventoryLevels(sku);

    if (!inventory) {
      return res.status(404).json({
        error: 'Product not found',
        sku: sku,
        timestamp: new Date().toISOString()
      });
    }

    // Update cache
    productsCache.set(cacheKey, {
      data: inventory,
      timestamp: now
    });

    console.log(`[JDS Route] Successfully returned inventory: ${sku} (${inventory.availableQuantity} available)`);

    res.json({
      result: inventory,
      cached: false
    });

  } catch (error) {
    console.error(`[JDS Route] GET /inventory/${req.params.sku} error:`, error.message);
    res.status(500).json({
      error: 'Failed to fetch inventory levels',
      details: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

/**
 * GET /api/jds/health
 *
 * Health check endpoint for monitoring
 *
 * Response:
 * {
 *   "status": "healthy",
 *   "service": "JDS Industries API",
 *   "timestamp": "2025-11-06T10:30:00Z",
 *   "config": {
 *     "cacheEnabled": true,
 *     "cacheDuration": "1 hour",
 *     "rateLimit": "60 req/min"
 *   },
 *   "endpoints": {...}
 * }
 */
router.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    service: 'JDS Industries API Proxy',
    timestamp: new Date().toISOString(),
    config: {
      cacheEnabled: true,
      cacheDuration: `${CACHE_DURATION / 1000 / 60} minutes`,
      rateLimit: `${config.jds.rateLimitPerMinute} req/min`
    },
    endpoints: {
      search: 'POST /api/jds/products',
      details: 'GET /api/jds/products/:sku',
      inventory: 'GET /api/jds/inventory/:sku',
      health: 'GET /api/jds/health'
    },
    cache: {
      totalEntries: productsCache.size,
      maxAge: `${CACHE_DURATION / 1000 / 60} minutes`
    }
  });
});

module.exports = router;
