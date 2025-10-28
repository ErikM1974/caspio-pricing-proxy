# New Products Management API

**Last Updated:** 2025-10-28
**Status:** Production Ready
**Version:** 1.0.0
**Base URL:** `https://caspio-pricing-proxy-ab30a049961a.herokuapp.com`

## Table of Contents
- [Overview](#overview)
- [Quick Start](#quick-start)
- [Endpoints](#endpoints)
  - [Query New Products (Public)](#1-get-apiproductsnew)
  - [Add IsNew Field (Admin)](#2-post-apiadminproductsadd-isnew-field)
  - [Mark Products as New (Admin)](#3-post-apiadminproductsmark-as-new)
- [Implementation Notes](#implementation-notes)
- [Usage Examples](#usage-examples)
- [Testing](#testing)
- [Troubleshooting](#troubleshooting)

---

## Overview

The New Products Management API provides endpoints to manage and display featured or "new" products in your catalog. This feature allows you to:

- **Dynamically mark products as new** without database schema changes
- **Query new products** for displaying on your website
- **Batch update multiple products** at once
- **Cache results** for optimal performance

### Key Features

✅ **Idempotent Operations** - Safe to run multiple times
✅ **Batch Processing** - Update multiple products simultaneously
✅ **Smart Caching** - 5-minute cache reduces API calls
✅ **Flexible Filtering** - Filter by category, brand, or limit
✅ **Admin Controls** - Separate admin endpoints for management

---

## Quick Start

### 1. One-Time Setup (Admin)

```bash
# Create the IsNew field (run once)
curl -X POST https://caspio-pricing-proxy-ab30a049961a.herokuapp.com/api/admin/products/add-isnew-field \
  -H "Content-Type: application/json"
```

### 2. Mark Products as New (Admin)

```bash
# Mark 15 featured products
curl -X POST https://caspio-pricing-proxy-ab30a049961a.herokuapp.com/api/admin/products/mark-as-new \
  -H "Content-Type: application/json" \
  -d '{
    "styles": ["EB120", "EB121", "PC54", "ST350", "OG734"]
  }'
```

### 3. Display New Products (Public)

```bash
# Get 10 newest products
curl "https://caspio-pricing-proxy-ab30a049961a.herokuapp.com/api/products/new?limit=10"
```

---

## Endpoints

### 1. GET /api/products/new

**Description:** Query products marked as new (IsNew=1). Results are cached for 5 minutes.

**Access:** Public (no authentication required)

**Query Parameters:**

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `limit` | integer | No | 20 | Maximum number of results (1-100) |
| `category` | string | No | - | Filter by category name (e.g., "Sweatshirts/Fleece") |
| `brand` | string | No | - | Filter by brand name (e.g., "Eddie Bauer") |

**Request:**

```bash
GET /api/products/new?limit=5&category=Sweatshirts/Fleece
```

**Response (200 OK):**

```json
{
  "products": [
    {
      "PK_ID": 169935,
      "STYLE": "EB120",
      "PRODUCT_TITLE": "Eddie Bauer Adventurer 1/4-Zip EB120",
      "BRAND_NAME": "Eddie Bauer",
      "CATEGORY": "Sweatshirts/Fleece",
      "COLOR_NAME": "Deep Black",
      "SIZE": "XS",
      "PIECE_PRICE": 26,
      "CASE_PRICE": 22,
      "IsNew": true,
      "Display_Image_URL": "https://cdnm.sanmar.com/imglib/mresjpg/...",
      ... (full product data)
    }
  ],
  "count": 5,
  "cached": false
}
```

**Response Fields:**

- `products` (array) - Array of product objects with full details
- `count` (integer) - Number of products returned
- `cached` (boolean) - Whether results came from cache

**Caching Behavior:**

- Results cached for **5 minutes**
- Cache key includes all query parameters
- First request: `cached: false`
- Subsequent requests (within 5 min): `cached: true`

**Usage Examples:**

```bash
# Get 20 newest products (default)
curl "https://caspio-pricing-proxy-ab30a049961a.herokuapp.com/api/products/new"

# Get 10 new Eddie Bauer products
curl "https://caspio-pricing-proxy-ab30a049961a.herokuapp.com/api/products/new?limit=10&brand=Eddie%20Bauer"

# Get new sweatshirts/fleece
curl "https://caspio-pricing-proxy-ab30a049961a.herokuapp.com/api/products/new?category=Sweatshirts%2FFleece"
```

---

### 2. POST /api/admin/products/add-isnew-field

**Description:** Creates the `IsNew` boolean field in the products table. This is a one-time setup operation and is idempotent (safe to run multiple times).

**Access:** Admin endpoint (consider adding authentication in production)

**Request Body:** None required

**Request:**

```bash
POST /api/admin/products/add-isnew-field
Content-Type: application/json
```

**Response (201 Created) - Field Created:**

```json
{
  "success": true,
  "message": "IsNew field created successfully",
  "fieldName": "IsNew"
}
```

**Response (200 OK) - Field Already Exists:**

```json
{
  "success": true,
  "message": "IsNew field already exists",
  "fieldName": "IsNew",
  "alreadyExists": true
}
```

**Response (500 Error) - Failed:**

```json
{
  "success": false,
  "message": "Failed to create IsNew field",
  "error": "Error details..."
}
```

**Usage Notes:**

- **Run this ONCE** before marking products as new
- Idempotent - safe to run multiple times
- Returns success even if field already exists
- Creates a `YES/NO` (boolean) field in Caspio

**Usage Example:**

```bash
curl -X POST https://caspio-pricing-proxy-ab30a049961a.herokuapp.com/api/admin/products/add-isnew-field \
  -H "Content-Type: application/json"
```

---

### 3. POST /api/admin/products/mark-as-new

**Description:** Batch updates multiple products to set `IsNew=true` based on style numbers. Updates ALL variants (colors, sizes) for each style.

**Access:** Admin endpoint (consider adding authentication in production)

**Request Body:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `styles` | array[string] | Yes | Array of style numbers to mark as new |

**Request:**

```bash
POST /api/admin/products/mark-as-new
Content-Type: application/json

{
  "styles": ["EB120", "EB121", "PC54", "ST350"]
}
```

**Response (200 OK):**

```json
{
  "success": true,
  "message": "Successfully marked 96 records as new",
  "recordsAffected": 96,
  "styles": ["EB120", "EB121", "PC54", "ST350"],
  "styleCount": 4
}
```

**Response (400 Bad Request) - Invalid Input:**

```json
{
  "success": false,
  "message": "styles array is required and must not be empty"
}
```

**Response (404 Not Found) - No Products Found:**

```json
{
  "success": false,
  "message": "No products found matching the provided style numbers"
}
```

**Response (500 Error) - Server Error:**

```json
{
  "success": false,
  "message": "Failed to mark products as new",
  "error": "Error details..."
}
```

**Important Notes:**

- **Updates ALL variants** - Each style has multiple records (one per color+size combination)
- A single style may have 10-30 variants
- `recordsAffected` = total individual records updated
- `styleCount` = number of unique styles

**Usage Example (15 Featured Products):**

```bash
curl -X POST https://caspio-pricing-proxy-ab30a049961a.herokuapp.com/api/admin/products/mark-as-new \
  -H "Content-Type: application/json" \
  -d '{
    "styles": [
      "EB120",
      "EB121",
      "EB122",
      "EB123",
      "EB124",
      "EB125",
      "EB130",
      "EB131",
      "OG734",
      "OG735",
      "PC54",
      "PC55",
      "LPC54",
      "ST350",
      "LST350"
    ]
  }'
```

---

## Implementation Notes

### Architecture

**Admin Endpoints:**
- Prefix: `/api/admin/products/`
- Consider adding authentication for production use
- Write operations (no caching)

**Public Endpoints:**
- Prefix: `/api/products/`
- No authentication required
- Read operations with caching

### Caching Strategy

| Endpoint | Cache Duration | Cache Key |
|----------|---------------|-----------|
| GET /api/products/new | 5 minutes | `{limit, category, brand}` |
| POST /api/admin/* | No cache | N/A (write operations) |

### Database Schema

**Field Name:** `IsNew`
**Field Type:** `YES/NO` (Caspio boolean)
**Table:** `Sanmar_Bulk_251816_Feb2024`

**SQL Query Syntax:**
- Set value: `IsNew = true` (JavaScript boolean in request body)
- Query value: `IsNew = 1` (SQL Server syntax in WHERE clause)

### Performance Considerations

- **Batch updates are efficient** - Single API call updates all variants
- **Caching reduces load** - 5-minute cache minimizes Caspio API calls
- **Parameter-aware caching** - Different query params = different cache entries

---

## Usage Examples

### JavaScript (Node.js / Browser)

```javascript
const BASE_URL = 'https://caspio-pricing-proxy-ab30a049961a.herokuapp.com';

// 1. Query new products
async function getNewProducts(limit = 20, category = null) {
  const params = new URLSearchParams({ limit });
  if (category) params.append('category', category);

  const response = await fetch(`${BASE_URL}/api/products/new?${params}`);
  const data = await response.json();

  console.log(`Found ${data.count} new products (cached: ${data.cached})`);
  return data.products;
}

// 2. Mark products as new (admin)
async function markProductsAsNew(styles) {
  const response = await fetch(`${BASE_URL}/api/admin/products/mark-as-new`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ styles })
  });

  const data = await response.json();
  console.log(`Marked ${data.recordsAffected} records as new`);
  return data;
}

// Usage
await getNewProducts(10, 'Sweatshirts/Fleece');
await markProductsAsNew(['EB120', 'PC54', 'ST350']);
```

### Python

```python
import requests

BASE_URL = 'https://caspio-pricing-proxy-ab30a049961a.herokuapp.com'

# 1. Query new products
def get_new_products(limit=20, category=None, brand=None):
    params = {'limit': limit}
    if category:
        params['category'] = category
    if brand:
        params['brand'] = brand

    response = requests.get(f'{BASE_URL}/api/products/new', params=params)
    data = response.json()

    print(f"Found {data['count']} new products (cached: {data['cached']})")
    return data['products']

# 2. Mark products as new (admin)
def mark_products_as_new(styles):
    response = requests.post(
        f'{BASE_URL}/api/admin/products/mark-as-new',
        json={'styles': styles}
    )
    data = response.json()

    print(f"Marked {data['recordsAffected']} records as new")
    return data

# Usage
products = get_new_products(limit=10, category='Sweatshirts/Fleece')
result = mark_products_as_new(['EB120', 'PC54', 'ST350'])
```

### cURL

```bash
# Get new products
curl "https://caspio-pricing-proxy-ab30a049961a.herokuapp.com/api/products/new?limit=5"

# Mark products as new
curl -X POST https://caspio-pricing-proxy-ab30a049961a.herokuapp.com/api/admin/products/mark-as-new \
  -H "Content-Type: application/json" \
  -d '{"styles": ["EB120", "PC54"]}'

# Add IsNew field (one-time)
curl -X POST https://caspio-pricing-proxy-ab30a049961a.herokuapp.com/api/admin/products/add-isnew-field \
  -H "Content-Type: application/json"
```

---

## Testing

### Test Workflow

**Step 1: Create IsNew Field (One-Time)**

```bash
curl -X POST https://caspio-pricing-proxy-ab30a049961a.herokuapp.com/api/admin/products/add-isnew-field \
  -H "Content-Type: application/json"
```

Expected: `{"success": true, "message": "IsNew field created successfully"}`

**Step 2: Mark Test Products**

```bash
curl -X POST https://caspio-pricing-proxy-ab30a049961a.herokuapp.com/api/admin/products/mark-as-new \
  -H "Content-Type: application/json" \
  -d '{"styles": ["EB120", "PC54"]}'
```

Expected: `{"success": true, "recordsAffected": 48, "styleCount": 2}`

**Step 3: Query New Products**

```bash
curl "https://caspio-pricing-proxy-ab30a049961a.herokuapp.com/api/products/new?limit=5"
```

Expected: Returns 5 products with `"IsNew": true`

**Step 4: Test Caching**

```bash
# First request (cache miss)
curl "https://caspio-pricing-proxy-ab30a049961a.herokuapp.com/api/products/new?limit=5"
# Returns: "cached": false

# Second request within 5 minutes (cache hit)
curl "https://caspio-pricing-proxy-ab30a049961a.herokuapp.com/api/products/new?limit=5"
# Returns: "cached": true
```

### Test Script

A comprehensive test script is available:

```bash
# Run the test script
node test-new-products-endpoints.js
```

This will test all 3 endpoints and verify expected behavior.

---

## Troubleshooting

### Common Issues

**Issue: Field creation returns error**

```json
{"success": false, "message": "Failed to create IsNew field"}
```

**Solution:** Check if field already exists. If error persists, verify Caspio API credentials are configured correctly.

---

**Issue: Mark as new returns 0 records affected**

```json
{"recordsAffected": 0}
```

**Solutions:**
- Verify style numbers exist in the database
- Check spelling of style numbers (case-sensitive)
- Ensure products have `PRODUCT_STATUS = 'Active'` or `'New'`

---

**Issue: Query returns empty array**

```json
{"products": [], "count": 0}
```

**Solutions:**
- Verify products have been marked as new (run mark-as-new endpoint first)
- Check query parameters (category/brand may be too restrictive)
- Verify IsNew field exists (run add-isnew-field endpoint)

---

**Issue: Cache not working**

**Symptoms:** `cached` always returns `false`

**Solutions:**
- Cache is parameter-specific - different params = different cache
- Wait 5 minutes for cache to populate on first request
- Check server logs for cache hit/miss messages

---

**Issue: Too many records returned**

**Solution:** Use the `limit` parameter to control result size:

```bash
curl "https://caspio-pricing-proxy-ab30a049961a.herokuapp.com/api/products/new?limit=10"
```

---

## Production Checklist

Before deploying to production:

- [ ] Run `add-isnew-field` endpoint once to create the field
- [ ] Test marking a few products as new
- [ ] Verify query endpoint returns expected results
- [ ] Test caching behavior (first request vs. subsequent)
- [ ] Consider adding authentication to admin endpoints
- [ ] Update your website/app to display new products
- [ ] Set up monitoring for endpoint performance
- [ ] Document which products are currently marked as new

---

## Support

For issues or questions:

- Check the [troubleshooting section](#troubleshooting)
- Review test script: `test-new-products-endpoints.js`
- Check implementation spec: `memory/NEW_PRODUCTS_ENDPOINT_SPEC.md`
- Review Postman collection: "Product Search" folder

---

**Last Updated:** 2025-10-28
**Version:** 1.0.0
**Changelog:** See [API_CHANGELOG.md](API_CHANGELOG.md)
