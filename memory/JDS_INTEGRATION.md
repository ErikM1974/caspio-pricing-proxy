# JDS Industries API Integration

**Version 1.0.0** - November 6, 2025

## Overview

This integration provides access to JDS Industries product data, including engravable items like mugs, cutting boards, keychains, tumblers, and other laser-engravable/printable products. JDS operates multiple warehouses around the country and provides comprehensive product information including pricing tiers, inventory levels, and high-quality product images.

**Key Features:**
- ✅ **Batch Product Search** - Query multiple products at once for catalog pages
- ✅ **Single Product Details** - Get complete product information including pricing tiers
- ✅ **Real-time Inventory** - Check stock levels across JDS warehouses
- ✅ **1-hour Caching** - Optimized performance with parameter-aware caching
- ✅ **60 req/min Rate Limiting** - Prevents excessive API usage
- ✅ **Partial Results** - Returns available products even if some SKUs are invalid
- ✅ **Multiple Image Sizes** - Full, thumbnail, and icon sizes for different use cases

---

## Quick Start

### 1. Configuration

The integration is pre-configured with your JDS API credentials. Environment variables are set in `.env`:

```bash
JDS_API_URL=https://api.jdsapp.com
JDS_API_TOKEN=dlpzbspldspbthntvxEhddackumetbo
```

### 2. Test the Integration

```bash
# Health check
curl http://localhost:3002/api/jds/health

# Search for products (batch)
curl -X POST http://localhost:3002/api/jds/products \
  -H "Content-Type: application/json" \
  -d '{"skus": ["LPB004", "LWB101"]}'

# Get single product
curl http://localhost:3002/api/jds/products/LPB004

# Check inventory
curl http://localhost:3002/api/jds/inventory/LPB004
```

---

## API Endpoints

### 1. Batch Product Search (POST)

**Endpoint:** `POST /api/jds/products`

Search for multiple products by SKUs. Ideal for catalog pages, featured products, and bulk queries.

**Request:**
```bash
POST /api/jds/products
Content-Type: application/json

{
  "skus": ["LPB004", "LWB101", "SKU123"]
}
```

**Query Parameters:**
- `refresh` (boolean, optional) - Force cache refresh (default: `false`)

**Response:**
```json
{
  "result": [
    {
      "sku": "LPB004",
      "name": "Polar Camel 18 oz. Small Teal Pet Bowl",
      "description": "Sturdy and durable Polar Camel pet bowls...",
      "caseQuantity": 12,
      "lessThanCasePrice": 10.75,
      "oneCase": 9.25,
      "fiveCases": 8.75,
      "tenCases": 8.25,
      "twentyCases": 8.25,
      "fortyCases": 8.25,
      "image": "https://res.cloudinary.com/.../LPB004.png",
      "thumbnail": "https://res.cloudinary.com/.../w_300,h_300/LPB004.png",
      "quickImage": "https://res.cloudinary.com/.../w_60,h_60/LPB004.png",
      "availableQuantity": 4272,
      "localQuantity": 3154,
      "images": {
        "full": "https://res.cloudinary.com/.../LPB004.png",
        "thumbnail": "https://res.cloudinary.com/.../w_300,h_300/LPB004.png",
        "icon": "https://res.cloudinary.com/.../w_60,h_60/LPB004.png"
      }
    },
    {
      "sku": "LWB101",
      "name": "Polar Camel 20 oz. Stainless Steel Water Bottle",
      "description": "The superior hot & cold retention...",
      "caseQuantity": 24,
      "lessThanCasePrice": 8.85,
      "oneCase": 7.45,
      "fiveCases": 7.15,
      "tenCases": 6.85,
      "twentyCases": 6.85,
      "fortyCases": 6.85,
      "image": "https://res.cloudinary.com/.../LWB101.png",
      "thumbnail": "https://res.cloudinary.com/.../w_300,h_300/LWB101.png",
      "quickImage": "https://res.cloudinary.com/.../w_60,h_60/LWB101.png",
      "availableQuantity": 4346,
      "localQuantity": 520,
      "images": {
        "full": "https://res.cloudinary.com/.../LWB101.png",
        "thumbnail": "https://res.cloudinary.com/.../w_300,h_300/LWB101.png",
        "icon": "https://res.cloudinary.com/.../w_60,h_60/LWB101.png"
      }
    }
  ],
  "count": 2,
  "requested": 3,
  "cached": false
}
```

**Response Fields:**
- `result` - Array of product objects (see Product Object Structure below)
- `count` - Number of products returned
- `requested` - Number of SKUs requested (may differ if some SKUs not found)
- `cached` - Whether this response came from cache
- `cacheDate` - ISO timestamp of when cache was created (only if cached: true)

**Notes:**
- Returns partial results if some SKUs don't exist (no error thrown)
- SKUs are case-sensitive
- Cache is shared for identical SKU sets (order doesn't matter)
- Empty array returned if no SKUs found

---

### 2. Single Product Details (GET)

**Endpoint:** `GET /api/jds/products/:sku`

Get complete details for a single product. Ideal for product detail pages.

**Request:**
```bash
GET /api/jds/products/LPB004?refresh=false
```

**URL Parameters:**
- `sku` (required) - Product SKU (e.g., "LPB004")

**Query Parameters:**
- `refresh` (boolean, optional) - Force cache refresh (default: `false`)

**Response:**
```json
{
  "result": {
    "sku": "LPB004",
    "name": "Polar Camel 18 oz. Small Teal Pet Bowl",
    "description": "Sturdy and durable Polar Camel pet bowls are available in 3 sizes and in 6 colors...",
    "caseQuantity": 12,
    "lessThanCasePrice": 10.75,
    "oneCase": 9.25,
    "fiveCases": 8.75,
    "tenCases": 8.25,
    "twentyCases": 8.25,
    "fortyCases": 8.25,
    "image": "https://res.cloudinary.com/.../LPB004.png",
    "thumbnail": "https://res.cloudinary.com/.../w_300,h_300/LPB004.png",
    "quickImage": "https://res.cloudinary.com/.../w_60,h_60/LPB004.png",
    "availableQuantity": 4272,
    "localQuantity": 3154,
    "images": {
      "full": "https://res.cloudinary.com/.../LPB004.png",
      "thumbnail": "https://res.cloudinary.com/.../w_300,h_300/LPB004.png",
      "icon": "https://res.cloudinary.com/.../w_60,h_60/LPB004.png"
    }
  },
  "cached": false
}
```

**Error Response (404):**
```json
{
  "error": "Product not found",
  "sku": "INVALID123",
  "timestamp": "2025-11-06T10:30:00Z"
}
```

---

### 3. Inventory Levels (GET)

**Endpoint:** `GET /api/jds/inventory/:sku`

Get only inventory levels for quick stock checks. Ideal for "Add to Cart" availability validation.

**Request:**
```bash
GET /api/jds/inventory/LPB004
```

**URL Parameters:**
- `sku` (required) - Product SKU

**Query Parameters:**
- `refresh` (boolean, optional) - Force cache refresh (default: `false`)

**Response:**
```json
{
  "result": {
    "sku": "LPB004",
    "availableQuantity": 4272,
    "localQuantity": 3154,
    "caseQuantity": 12,
    "inStock": true
  },
  "cached": false
}
```

**Response Fields:**
- `sku` - Product SKU
- `availableQuantity` - Total available across all JDS warehouses
- `localQuantity` - Available in local/nearest warehouse
- `caseQuantity` - Number of units per case
- `inStock` - Boolean indicating if product is available (availableQuantity > 0)

**Use Cases:**
- Real-time "Add to Cart" stock validation
- Inventory warning messages ("Only 5 left in stock!")
- Bulk availability checks without full product data

---

### 4. Health Check (GET)

**Endpoint:** `GET /api/jds/health`

Health check and configuration information for monitoring.

**Request:**
```bash
GET /api/jds/health
```

**Response:**
```json
{
  "status": "healthy",
  "service": "JDS Industries API Proxy",
  "timestamp": "2025-11-06T10:30:00Z",
  "config": {
    "cacheEnabled": true,
    "cacheDuration": "60 minutes",
    "rateLimit": "60 req/min"
  },
  "endpoints": {
    "search": "POST /api/jds/products",
    "details": "GET /api/jds/products/:sku",
    "inventory": "GET /api/jds/inventory/:sku",
    "health": "GET /api/jds/health"
  },
  "cache": {
    "totalEntries": 42,
    "maxAge": "60 minutes"
  }
}
```

---

## Product Object Structure

All product endpoints return products with the following structure:

```json
{
  "sku": "LPB004",
  "name": "Polar Camel 18 oz. Small Teal Pet Bowl",
  "description": "Sturdy and durable Polar Camel pet bowls...",

  // Case quantity
  "caseQuantity": 12,

  // Pricing tiers (price per unit)
  "lessThanCasePrice": 10.75,   // 1-11 units
  "oneCase": 9.25,                // 12-59 units (1-4 cases)
  "fiveCases": 8.75,              // 60-119 units (5-9 cases)
  "tenCases": 8.25,               // 120-239 units (10-19 cases)
  "twentyCases": 8.25,            // 240-479 units (20-39 cases)
  "fortyCases": 8.25,             // 480+ units (40+ cases)

  // Images (original JDS fields)
  "image": "https://...",          // Full resolution
  "thumbnail": "https://...",      // 300x300
  "quickImage": "https://...",     // 60x60

  // Images (enhanced structure)
  "images": {
    "full": "https://...",         // Same as 'image'
    "thumbnail": "https://...",    // Same as 'thumbnail'
    "icon": "https://..."          // Same as 'quickImage'
  },

  // Inventory
  "availableQuantity": 4272,       // Total across all warehouses
  "localQuantity": 3154            // Local/nearest warehouse
}
```

### Pricing Tier Calculation

The pricing tiers are based on total quantity purchased:

| Quantity Range | Field Name | Example Price |
|----------------|------------|---------------|
| 1-11 units | `lessThanCasePrice` | $10.75 |
| 12-59 units (1-4 cases) | `oneCase` | $9.25 |
| 60-119 units (5-9 cases) | `fiveCases` | $8.75 |
| 120-239 units (10-19 cases) | `tenCases` | $8.25 |
| 240-479 units (20-39 cases) | `twentyCases` | $8.25 |
| 480+ units (40+ cases) | `fortyCases` | $8.25 |

**Example:** If `caseQuantity` is 12:
- Buy 1-11 units → $10.75 each
- Buy 12-59 units (1-4 cases) → $9.25 each
- Buy 60-119 units (5-9 cases) → $8.75 each

---

## Caching

The JDS integration uses **parameter-aware caching** with a **1-hour duration**.

### How Caching Works

1. **Different SKU sets = Different cache entries**
   - `["LPB004"]` and `["LWB101"]` are cached separately
   - `["LPB004", "LWB101"]` and `["LWB101", "LPB004"]` share the same cache (order doesn't matter)

2. **Cache Duration: 1 hour**
   - Product data, pricing, and inventory are cached for 60 minutes
   - Suitable for product catalog data that changes infrequently

3. **Cache Types:**
   - `product:{sku}` - Single product details
   - `inventory:{sku}` - Inventory levels only
   - `{sku1|sku2|...}` - Batch search results (sorted SKUs)

4. **Cache Bypass:**
   - Add `?refresh=true` to any request to bypass cache
   - Example: `GET /api/jds/products/LPB004?refresh=true`

5. **Cache Info in Response:**
   ```json
   {
     "result": [...],
     "cached": true,
     "cacheDate": "2025-11-06T10:30:00Z"
   }
   ```

### Why 1 Hour?

- Product pricing changes infrequently
- Inventory levels are approximate (not real-time critical)
- Reduces load on JDS API servers
- Faster response times for end users

**Note:** If you need more current inventory, use `?refresh=true` or reduce cache duration in `config.js`.

---

## Rate Limiting

**Limit:** 60 requests per minute
**Window:** 60 seconds (1 minute)

### How It Works

- Each IP address can make up to 60 requests per minute to JDS endpoints
- Requests are counted across all JDS endpoints combined
- After exceeding the limit, requests return `429 Too Many Requests`
- Counter resets every 60 seconds

### Rate Limit Response

When rate limit is exceeded:

```json
{
  "error": "Too many requests to JDS endpoints",
  "retryAfter": "60 seconds"
}
```

**HTTP Status:** `429 Too Many Requests`

**Headers:**
```
RateLimit-Limit: 60
RateLimit-Remaining: 0
RateLimit-Reset: 1699261800
```

### Best Practices

1. **Use Batch Endpoint** - Query multiple SKUs at once instead of making separate requests
2. **Leverage Caching** - Cached responses don't count toward rate limit
3. **Implement Retry Logic** - Wait and retry after receiving 429 errors
4. **Request Only What You Need** - Use inventory endpoint for stock checks instead of full product details

---

## Production URLs

### Base URL
```
https://caspio-pricing-proxy-ab30a049961a.herokuapp.com
```

### Example Endpoints

```bash
# Health check
https://caspio-pricing-proxy-ab30a049961a.herokuapp.com/api/jds/health

# Batch search (POST)
https://caspio-pricing-proxy-ab30a049961a.herokuapp.com/api/jds/products

# Single product (GET)
https://caspio-pricing-proxy-ab30a049961a.herokuapp.com/api/jds/products/LPB004

# Inventory check (GET)
https://caspio-pricing-proxy-ab30a049961a.herokuapp.com/api/jds/inventory/LPB004
```

---

## Code Examples

### JavaScript (Node.js / Browser)

```javascript
// Batch search
async function searchJDSProducts(skus) {
  const response = await fetch('https://caspio-pricing-proxy-ab30a049961a.herokuapp.com/api/jds/products', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ skus: skus })
  });

  const data = await response.json();
  return data.result; // Array of products
}

// Single product
async function getJDSProduct(sku) {
  const response = await fetch(`https://caspio-pricing-proxy-ab30a049961a.herokuapp.com/api/jds/products/${sku}`);
  const data = await response.json();
  return data.result; // Single product object
}

// Check inventory
async function checkJDSInventory(sku) {
  const response = await fetch(`https://caspio-pricing-proxy-ab30a049961a.herokuapp.com/api/jds/inventory/${sku}`);
  const data = await response.json();
  return data.result.inStock; // Boolean
}

// Usage
const products = await searchJDSProducts(['LPB004', 'LWB101', 'SKU123']);
console.log(`Found ${products.length} products`);

const product = await getJDSProduct('LPB004');
console.log(`${product.name}: $${product.oneCase} (case of ${product.caseQuantity})`);

const inStock = await checkJDSInventory('LPB004');
console.log(inStock ? 'In Stock' : 'Out of Stock');
```

### Python

```python
import requests

BASE_URL = 'https://caspio-pricing-proxy-ab30a049961a.herokuapp.com/api/jds'

# Batch search
def search_jds_products(skus):
    response = requests.post(
        f'{BASE_URL}/products',
        json={'skus': skus}
    )
    data = response.json()
    return data['result']

# Single product
def get_jds_product(sku):
    response = requests.get(f'{BASE_URL}/products/{sku}')
    data = response.json()
    return data['result']

# Check inventory
def check_jds_inventory(sku):
    response = requests.get(f'{BASE_URL}/inventory/{sku}')
    data = response.json()
    return data['result']['inStock']

# Usage
products = search_jds_products(['LPB004', 'LWB101'])
print(f'Found {len(products)} products')

product = get_jds_product('LPB004')
print(f"{product['name']}: ${product['oneCase']} (case of {product['caseQuantity']})")

in_stock = check_jds_inventory('LPB004')
print('In Stock' if in_stock else 'Out of Stock')
```

### cURL

```bash
# Batch search
curl -X POST https://caspio-pricing-proxy-ab30a049961a.herokuapp.com/api/jds/products \
  -H "Content-Type: application/json" \
  -d '{"skus": ["LPB004", "LWB101"]}'

# Single product
curl https://caspio-pricing-proxy-ab30a049961a.herokuapp.com/api/jds/products/LPB004

# Check inventory
curl https://caspio-pricing-proxy-ab30a049961a.herokuapp.com/api/jds/inventory/LPB004

# Force refresh
curl https://caspio-pricing-proxy-ab30a049961a.herokuapp.com/api/jds/products/LPB004?refresh=true
```

---

## Integration Use Cases

### 1. Product Catalog Page

```javascript
// Load featured JDS products
const featuredSkus = ['LPB004', 'LWB101', 'LTM7100SET'];
const products = await searchJDSProducts(featuredSkus);

products.forEach(product => {
  displayProduct({
    image: product.images.thumbnail,
    name: product.name,
    price: product.oneCase,
    inStock: product.availableQuantity > 0
  });
});
```

### 2. Product Detail Page

```javascript
// Load full product details
const sku = 'LPB004';
const product = await getJDSProduct(sku);

displayProductDetails({
  name: product.name,
  description: product.description,
  image: product.images.full,
  pricingTiers: {
    'Less than case': product.lessThanCasePrice,
    '1-4 cases': product.oneCase,
    '5-9 cases': product.fiveCases,
    '10+ cases': product.tenCases
  },
  availability: `${product.availableQuantity} available`,
  caseQuantity: product.caseQuantity
});
```

### 3. Add to Cart Validation

```javascript
// Quick inventory check before adding to cart
async function addToCart(sku, quantity) {
  const inventory = await fetch(`/api/jds/inventory/${sku}`).then(r => r.json());

  if (!inventory.result.inStock) {
    alert('This product is currently out of stock');
    return false;
  }

  if (quantity > inventory.result.availableQuantity) {
    alert(`Only ${inventory.result.availableQuantity} available`);
    return false;
  }

  // Add to cart
  cart.add(sku, quantity);
  return true;
}
```

### 4. Price Calculator

```javascript
// Calculate price based on quantity
function calculatePrice(product, quantity) {
  const caseQty = product.caseQuantity;

  if (quantity < caseQty) {
    return quantity * product.lessThanCasePrice;
  } else if (quantity < caseQty * 5) {
    return quantity * product.oneCase;
  } else if (quantity < caseQty * 10) {
    return quantity * product.fiveCases;
  } else if (quantity < caseQty * 20) {
    return quantity * product.tenCases;
  } else if (quantity < caseQty * 40) {
    return quantity * product.twentyCases;
  } else {
    return quantity * product.fortyCases;
  }
}

// Usage
const product = await getJDSProduct('LPB004');
const total = calculatePrice(product, 50);
console.log(`50 units: $${total.toFixed(2)}`);
```

---

## Error Handling

### Common Errors

| Status Code | Error | Cause | Solution |
|-------------|-------|-------|----------|
| 400 | Bad Request | Missing or invalid SKUs in request body | Ensure "skus" array is provided and non-empty |
| 404 | Not Found | Product SKU doesn't exist in JDS database | Check SKU spelling and availability with JDS |
| 429 | Too Many Requests | Rate limit exceeded (60 req/min) | Implement retry logic, use caching, batch requests |
| 500 | Internal Server Error | JDS API token not configured | Contact admin to verify JDS_API_TOKEN is set |
| 500 | Internal Server Error | JDS API is down or unreachable | Check JDS status, retry later |

### Error Response Format

```json
{
  "error": "Failed to search JDS products",
  "details": "JDS API error (403): Invalid token",
  "timestamp": "2025-11-06T10:30:00Z"
}
```

### Handling Errors in Code

```javascript
async function safeSearchProducts(skus) {
  try {
    const response = await fetch('/api/jds/products', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ skus })
    });

    if (!response.ok) {
      const error = await response.json();

      if (response.status === 429) {
        // Rate limited - wait and retry
        await new Promise(resolve => setTimeout(resolve, 60000));
        return safeSearchProducts(skus);
      }

      throw new Error(error.details || error.error);
    }

    const data = await response.json();
    return data.result;

  } catch (error) {
    console.error('JDS search failed:', error.message);
    return []; // Return empty array as fallback
  }
}
```

---

## Troubleshooting

### Issue: "JDS_API_TOKEN not configured"

**Cause:** Missing environment variable
**Solution:**
```bash
# Local (.env file)
echo "JDS_API_TOKEN=dlpzbspldspbthntvxEhddackumetbo" >> .env

# Production (Heroku)
heroku config:set JDS_API_TOKEN=dlpzbspldspbthntvxEhddackumetbo
```

### Issue: Rate limit exceeded (429)

**Cause:** More than 60 requests per minute
**Solutions:**
1. Use batch endpoint to query multiple SKUs at once
2. Leverage caching (cached responses don't count)
3. Implement exponential backoff retry logic
4. Reduce request frequency

### Issue: Product not found (404)

**Cause:** SKU doesn't exist in JDS database
**Solutions:**
1. Verify SKU spelling (case-sensitive)
2. Check if product is discontinued
3. Use batch endpoint (returns partial results, no 404)

### Issue: Slow response times

**Cause:** Cache expired or not used
**Solutions:**
1. Verify cache is enabled (check `/api/jds/health`)
2. Use batch requests instead of multiple single requests
3. Preload commonly accessed products
4. Check if `?refresh=true` is being used unnecessarily

---

## Configuration

### Environment Variables

Required variables in `.env` (local) or Heroku config (production):

```bash
# JDS Industries API
JDS_API_URL=https://api.jdsapp.com
JDS_API_TOKEN=dlpzbspldspbthntvxEhddackumetbo
```

### Configuration Options

Located in `config.js`:

```javascript
jds: {
  baseUrl: process.env.JDS_API_URL || 'https://api.jdsapp.com',
  apiToken: process.env.JDS_API_TOKEN,
  endpoint: '/get-product-details-by-skus',
  requestTimeout: 30000, // 30 seconds
  cacheDuration: 3600000, // 1 hour
  rateLimitPerMinute: 60 // 60 requests per minute
}
```

### Adjusting Cache Duration

To change cache duration, edit `config.js`:

```javascript
// Change from 1 hour to 30 minutes
cacheDuration: 1800000, // 30 minutes in milliseconds

// Change from 1 hour to 5 minutes (more real-time)
cacheDuration: 300000, // 5 minutes
```

Then restart the server.

---

## Deployment

### Heroku Configuration

1. **Set environment variables:**
```bash
heroku config:set JDS_API_URL=https://api.jdsapp.com
heroku config:set JDS_API_TOKEN=dlpzbspldspbthntvxEhddackumetbo
```

2. **Verify configuration:**
```bash
heroku config:get JDS_API_TOKEN
```

3. **Test production endpoint:**
```bash
curl https://caspio-pricing-proxy-ab30a049961a.herokuapp.com/api/jds/health
```

### Monitoring

Check JDS API health and cache status:

```bash
# Production
curl https://caspio-pricing-proxy-ab30a049961a.herokuapp.com/api/jds/health

# Local
curl http://localhost:3002/api/jds/health
```

Response includes:
- Service status
- Cache configuration
- Current cache size
- Available endpoints

---

## API Changelog

### Version 1.0.0 (November 6, 2025)

**Initial Release**

- ✅ POST /api/jds/products - Batch product search
- ✅ GET /api/jds/products/:sku - Single product details
- ✅ GET /api/jds/inventory/:sku - Inventory levels
- ✅ GET /api/jds/health - Health check
- ✅ 1-hour parameter-aware caching
- ✅ 60 req/min rate limiting
- ✅ Enhanced image structure with full/thumbnail/icon
- ✅ Partial result support (no errors for missing SKUs)
- ✅ Comprehensive documentation

---

## Support

For issues or questions:

1. Check the [Troubleshooting](#troubleshooting) section
2. Review [Error Handling](#error-handling) for common errors
3. Test with the health endpoint to verify configuration
4. Contact JDS Industries for SKU availability questions
5. For proxy issues, contact the integration team

---

## Related Documentation

- [ManageOrders Integration](MANAGEORDERS_INTEGRATION.md) - ERP integration for orders and inventory
- [API Documentation](API_DOCUMENTATION.md) - Complete API reference for all endpoints
- [Online Store Developer Guide](ONLINE_STORE_DEVELOPER_GUIDE.md) - Webstore integration guide
