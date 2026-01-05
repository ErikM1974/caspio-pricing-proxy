/**
 * JDS Industries API Client
 *
 * Handles communication with JDS Industries API for product data, pricing tiers,
 * and inventory levels.
 *
 * API Endpoint: POST https://api.jdsapp.com/get-product-details-by-skus
 * Authentication: Static token in request body
 *
 * Response includes:
 * - Product details (sku, name, description)
 * - Pricing tiers (case quantities and prices)
 * - Inventory levels (available and local quantities)
 * - Images (full, thumbnail, quick)
 */

const axios = require('axios');
const config = require('../../config');

/**
 * Validate JDS API configuration
 * @throws {Error} if configuration is missing
 */
function validateConfig() {
  if (!config.jds.apiToken) {
    throw new Error('JDS_API_TOKEN not configured in environment variables');
  }
  if (!config.jds.baseUrl) {
    throw new Error('JDS_API_URL not configured in environment variables');
  }
}

/**
 * Search for products by SKUs using JDS API
 *
 * @param {Array<string>} skus - Array of SKU strings to search for
 * @returns {Promise<Array>} Array of product objects with pricing and inventory
 * @throws {Error} if API request fails
 *
 * @example
 * const products = await searchProducts(['LPB004', 'LWB101']);
 * // Returns array of product objects with all details
 */
async function searchProducts(skus = []) {
  validateConfig();

  if (!Array.isArray(skus) || skus.length === 0) {
    throw new Error('SKUs array is required and must contain at least one SKU');
  }

  // Validate SKU format (non-empty strings)
  const validSkus = skus.filter(sku => typeof sku === 'string' && sku.trim().length > 0);
  if (validSkus.length === 0) {
    throw new Error('No valid SKUs provided (SKUs must be non-empty strings)');
  }

  const requestUrl = `${config.jds.baseUrl}${config.jds.endpoint}`;
  console.log(`[JDS API] Searching ${validSkus.length} SKUs...`);

  try {
    const response = await axios.post(
      requestUrl,
      {
        token: config.jds.apiToken,
        skus: validSkus
      },
      {
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'NWCA-Pricing-Proxy/1.0'
        },
        timeout: config.jds.requestTimeout
      }
    );

    // JDS API returns array directly or wrapped in a data property
    const products = Array.isArray(response.data) ? response.data : (response.data.products || []);

    console.log(`[JDS API] Successfully fetched ${products.length} products`);

    // Transform image fields for better usability
    const transformedProducts = products.map(product => ({
      ...product,
      images: {
        full: product.image,
        thumbnail: product.thumbnail,
        icon: product.quickImage
      }
    }));

    return transformedProducts;
  } catch (error) {
    console.error('[JDS API] Search error:', error.message);

    if (error.response) {
      // API returned an error response
      const status = error.response.status;
      const data = error.response.data;

      // Never expose token in error messages
      const safeErrorData = typeof data === 'object' ? JSON.stringify(data) : String(data);

      throw new Error(`JDS API error (${status}): ${safeErrorData}`);
    } else if (error.request) {
      // Request was made but no response received
      throw new Error('No response from JDS API server (timeout or network error)');
    } else {
      // Something else happened
      throw error;
    }
  }
}

/**
 * Get product details for a single SKU
 *
 * @param {string} sku - Single SKU to look up
 * @returns {Promise<Object|null>} Product object or null if not found
 *
 * @example
 * const product = await getProductDetails('LPB004');
 * if (product) {
 *   console.log(product.name, product.availableQuantity);
 * }
 */
async function getProductDetails(sku) {
  if (!sku || typeof sku !== 'string') {
    throw new Error('SKU must be a non-empty string');
  }

  const results = await searchProducts([sku]);
  return results.length > 0 ? results[0] : null;
}

/**
 * Get inventory levels for a single SKU
 * Returns only inventory-related fields for quick stock checks
 *
 * @param {string} sku - Single SKU to check
 * @returns {Promise<Object|null>} Inventory object or null if not found
 *
 * @example
 * const inventory = await getInventoryLevels('LPB004');
 * // Returns: { sku, availableQuantity, localQuantity, caseQuantity, inStock }
 */
async function getInventoryLevels(sku) {
  const product = await getProductDetails(sku);

  if (!product) {
    return null;
  }

  // Extract only inventory-related fields
  return {
    sku: product.sku,
    availableQuantity: product.availableQuantity || 0,
    localQuantity: product.localQuantity || 0,
    caseQuantity: product.caseQuantity || 0,
    inStock: (product.availableQuantity || 0) > 0
  };
}

module.exports = {
  searchProducts,
  getProductDetails,
  getInventoryLevels
};
