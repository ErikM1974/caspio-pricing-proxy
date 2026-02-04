# Non-SanMar Products API

**Version:** 1.0.0
**Added:** 2026-02-03
**Base URL:** `https://caspio-pricing-proxy-ab30a049961a.herokuapp.com`

## Overview

CRUD API for products from vendors other than SanMar (Brooks Brothers, Carhartt direct, specialty items, etc.). Data stored in Caspio `Non_SanMar_Products` table.

## Endpoints

### GET /api/non-sanmar-products
Returns all non-SanMar products with optional filtering.

**Query Parameters:**
| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `brand` | string | - | Filter by Brand (partial match, case-insensitive) |
| `category` | string | - | Filter by Category (partial match, case-insensitive) |
| `vendor` | string | - | Filter by VendorCode (exact match, e.g., "BB", "CARH") |
| `active` | string | "true" | Filter by IsActive: "true", "false", or "all" |
| `refresh` | string | - | Set to "true" to bypass cache |

**Response:**
```json
{
  "success": true,
  "data": [...],
  "count": 7,
  "source": "caspio"
}
```

---

### GET /api/non-sanmar-products/:id
Get a single product by ID_Product (numeric primary key).

**Example:** `GET /api/non-sanmar-products/123`

**Response:**
```json
{
  "success": true,
  "data": {
    "ID_Product": 123,
    "StyleNumber": "BB18201",
    "Brand": "Brooks Brothers",
    ...
  }
}
```

---

### GET /api/non-sanmar-products/style/:style
Get a single product by StyleNumber.

**Example:** `GET /api/non-sanmar-products/style/BB18201`

**Response:**
```json
{
  "success": true,
  "data": {
    "ID_Product": 123,
    "StyleNumber": "BB18201",
    "Brand": "Brooks Brothers",
    ...
  }
}
```

---

### POST /api/non-sanmar-products
Create a new product.

**Required Fields:**
- `StyleNumber` (string) - Unique style identifier
- `Brand` (string) - Brand name
- `ProductName` (string) - Product display name

**Optional Fields:**
| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `Category` | string | "" | Product category (e.g., "Jackets", "Polos") |
| `DefaultCost` | number | 0 | Cost price |
| `DefaultSellPrice` | number | 0 | Sell price |
| `PricingMethod` | string | "FIXED" | Pricing method |
| `MarginPercent` | number | 0 | Margin percentage |
| `SizeUpchargeXL` | number | 0 | XL size upcharge |
| `SizeUpcharge2XL` | number | 0 | 2XL size upcharge |
| `SizeUpcharge3XL` | number | 0 | 3XL size upcharge |
| `AvailableSizes` | string | "" | Comma-separated sizes (e.g., "S,M,L,XL,2XL") |
| `DefaultColors` | string | "" | Comma-separated colors |
| `VendorCode` | string | "" | Vendor identifier (e.g., "BB", "CARH", "CS") |
| `VendorURL` | string | "" | Link to vendor product page |
| `ImageURL` | string | "" | Product image URL |
| `Notes` | string | "" | Internal notes |
| `IsActive` | boolean | true | Active status |

**Example Request:**
```json
{
  "StyleNumber": "BB18201",
  "Brand": "Brooks Brothers",
  "ProductName": "BB Mens Mid-Layer 1/2-Button",
  "Category": "Jackets",
  "DefaultCost": 45.00,
  "DefaultSellPrice": 95.00,
  "VendorCode": "BB",
  "AvailableSizes": "S,M,L,XL,2XL",
  "SizeUpcharge2XL": 5
}
```

**Response:**
```json
{
  "success": true,
  "message": "Product 'BB18201' created successfully",
  "data": {
    "ID_Product": 123,
    "StyleNumber": "BB18201",
    ...
  }
}
```

---

### PUT /api/non-sanmar-products/:id
Update an existing product by ID_Product.

**Example:** `PUT /api/non-sanmar-products/123`

**Body:** Any fields to update (cannot update ID_Product)

```json
{
  "DefaultSellPrice": 99.00,
  "Notes": "Updated pricing for 2026"
}
```

**Response:**
```json
{
  "success": true,
  "message": "Product ID_Product=123 updated successfully",
  "updatedFields": ["DefaultSellPrice", "Notes"]
}
```

---

### DELETE /api/non-sanmar-products/:id
Delete a product by ID_Product.

**Soft Delete (default):** Sets `IsActive = false`
```
DELETE /api/non-sanmar-products/123
```

**Hard Delete:** Permanently removes from database
```
DELETE /api/non-sanmar-products/123?hard=true
```

**Response (soft):**
```json
{
  "success": true,
  "message": "Product ID_Product=123 deactivated (soft delete)",
  "note": "Use ?hard=true to permanently delete"
}
```

---

### GET /api/non-sanmar-products/cache/clear
Clears the products cache (admin use).

**Response:**
```json
{
  "success": true,
  "message": "Non-SanMar products cache cleared"
}
```

---

### POST /api/non-sanmar-products/seed
Seeds the database with initial product data. Safe to run multiple times - only inserts records that don't exist.

**Response:**
```json
{
  "success": true,
  "message": "Seed complete: 7 inserted, 0 skipped (already exist), 0 failed",
  "results": {
    "inserted": 7,
    "skipped": 0,
    "failed": 0,
    "errors": []
  },
  "summary": {
    "expected": 7,
    "nowInDatabase": 7,
    "missing": 0
  }
}
```

## Data Schema

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `ID_Product` | int | auto | Primary key (Caspio auto-generated) |
| `StyleNumber` | string | YES | Unique style identifier |
| `Brand` | string | YES | Brand name |
| `ProductName` | string | YES | Display name |
| `Category` | string | no | Product category |
| `DefaultCost` | decimal | no | Cost price |
| `DefaultSellPrice` | decimal | no | Sell price |
| `PricingMethod` | string | no | "FIXED" or other |
| `MarginPercent` | decimal | no | Margin % |
| `SizeUpchargeXL` | decimal | no | XL upcharge |
| `SizeUpcharge2XL` | decimal | no | 2XL upcharge |
| `SizeUpcharge3XL` | decimal | no | 3XL upcharge |
| `AvailableSizes` | string | no | Comma-separated sizes |
| `DefaultColors` | string | no | Comma-separated colors |
| `VendorCode` | string | no | Vendor ID (BB, CARH, CS) |
| `VendorURL` | string | no | Vendor product URL |
| `ImageURL` | string | no | Product image URL |
| `Notes` | string | no | Internal notes |
| `IsActive` | boolean | no | Active status (default: true) |

## Vendor Codes

| Code | Vendor |
|------|--------|
| BB | Brooks Brothers |
| CARH | Carhartt (direct) |
| CS | CornerStone |

## Caching

- 5-minute TTL cache
- Auto-cleared on create/update/delete
- Bypass with `?refresh=true`
- Manual clear: `GET /api/non-sanmar-products/cache/clear`

## Initial Seed Data

The seed endpoint populates these products:
- Brooks Brothers: BB18200, BB18201, BB18202, BB18203 (polos and jackets)
- Carhartt: CTK87 (tee), CTJ140 (jacket)
- CornerStone: CSV400 (safety vest)

## Usage Examples

```javascript
// Get all active products
fetch('https://caspio-pricing-proxy-ab30a049961a.herokuapp.com/api/non-sanmar-products')

// Get only Brooks Brothers products
fetch('/api/non-sanmar-products?brand=Brooks')

// Get jackets only
fetch('/api/non-sanmar-products?category=Jackets')

// Get by style number
fetch('/api/non-sanmar-products/style/BB18201')

// Create new product
fetch('/api/non-sanmar-products', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    StyleNumber: 'NEW123',
    Brand: 'Custom Brand',
    ProductName: 'Custom Product',
    DefaultCost: 25.00,
    DefaultSellPrice: 50.00
  })
})

// Update product
fetch('/api/non-sanmar-products/123', {
  method: 'PUT',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ DefaultSellPrice: 55.00 })
})

// Soft delete (deactivate)
fetch('/api/non-sanmar-products/123', { method: 'DELETE' })

// Hard delete (permanent)
fetch('/api/non-sanmar-products/123?hard=true', { method: 'DELETE' })
```
