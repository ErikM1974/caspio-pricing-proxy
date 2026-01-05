# SanMar → ShopWorks Import API

Complete API documentation for translating SanMar product data into ShopWorks-ready inventory format.

---

## Overview

This API endpoint translates SanMar product data into a format ready for ShopWorks inventory import. It combines data from multiple sources to provide complete product information with correct size mappings and current pricing.

**Purpose:** Help users understand how to import SanMar products into ShopWorks by providing exact SKU structures, size field mappings, and current pricing.

**Key Features:**
- Returns only exact style matches (PC850 returns 5 SKUs, not 22)
- Maps size fields from Shopworks_Integration table
- Provides current CASE_PRICE from Sanmar_Bulk
- Sorted by CASE_PRICE (lowest to highest)
- Uses SanMar column names (CATALOG_COLOR, COLOR_NAME)

---

## Endpoint

### ShopWorks Import Format
```
GET /api/sanmar-shopworks/import-format
```

**Base URL (Production):**
```
https://caspio-pricing-proxy-ab30a049961a.herokuapp.com
```

**Full URL:**
```
https://caspio-pricing-proxy-ab30a049961a.herokuapp.com/api/sanmar-shopworks/import-format?styleNumber=PC850&color=Cardinal
```

---

## Parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `styleNumber` | string | **Yes** | SanMar style number (e.g., PC850, PC54, J790) |
| `color` | string | **Yes** | Color name or catalog color (e.g., Cardinal, Navy, Forest) |

**Parameter Notes:**
- `styleNumber` must be exact style (PC850), not family (PC850H is separate)
- `color` can be partial match - searches both COLOR_NAME and CATALOG_COLOR
- Color matching is case-insensitive

---

## Response Structure

Returns an array of SKU entries, each containing:

```json
[
  {
    "ID_Product": "PC850_XS",
    "CATALOG_COLOR": "Team Cardinal",
    "COLOR_NAME": "Team Cardinal",
    "Description": "Port  Co Fan Favorite Fleece Crewneck Sweatshirt",
    "Brand": "Port & Company",
    "CASE_PRICE": 10.51,
    "Size01": null,
    "Size02": null,
    "Size03": null,
    "Size04": null,
    "Size05": null,
    "Size06": "XS"
  },
  {
    "ID_Product": "PC850",
    "CATALOG_COLOR": "Team Cardinal",
    "COLOR_NAME": "Team Cardinal",
    "Description": "Port  Co Fan Favorite Fleece Crewneck Sweatshirt",
    "Brand": "Port & Company",
    "CASE_PRICE": 10.51,
    "Size01": "S",
    "Size02": "M",
    "Size03": "L",
    "Size04": "XL",
    "Size05": null,
    "Size06": null
  }
]
```

---

## Field Descriptions

| Field | Source | Type | Description |
|-------|--------|------|-------------|
| **ID_Product** | Shopworks_Integration | string | ShopWorks SKU identifier (e.g., PC850, PC850_2XL) |
| **CATALOG_COLOR** | Sanmar_Bulk.CATALOG_COLOR | string | **ShopWorks uses this field** - Official catalog color name |
| **COLOR_NAME** | Sanmar_Bulk.COLOR_NAME | string | Display name for UI/customer-facing use |
| **Description** | Shopworks_Integration | string | Full product description |
| **Brand** | Sanmar_Bulk.MILL | string | Manufacturer/brand name (Port & Company, Gildan, etc.) |
| **CASE_PRICE** | Sanmar_Bulk.CASE_PRICE | number | Current SanMar case price for this size |
| **Size01** | Shopworks_Integration | string/null | Size S (if enabled for this SKU) |
| **Size02** | Shopworks_Integration | string/null | Size M (if enabled for this SKU) |
| **Size03** | Shopworks_Integration | string/null | Size L (if enabled for this SKU) |
| **Size04** | Shopworks_Integration | string/null | Size XL (if enabled for this SKU) |
| **Size05** | Shopworks_Integration | string/null | Size 2XL (if enabled for this SKU) |
| **Size06** | Shopworks_Integration | string/null | Size XS/3XL/4XL (if enabled for this SKU) |

---

## Size Field Mapping

### How Size Fields Work

ShopWorks uses 6 size fields (Size01-Size06). Each SKU enables only the size fields it handles:

| Size Field | Standard Mapping | Notes |
|------------|------------------|-------|
| **Size01** | S (Small) | Base SKUs only |
| **Size02** | M (Medium) | Base SKUs only |
| **Size03** | L (Large) | Base SKUs only |
| **Size04** | XL (Extra Large) | Base SKUs only |
| **Size05** | 2XL (2X Large) | Extended SKUs only |
| **Size06** | XS/3XL/4XL | Reused for different extended sizes |

### Example Size Configurations

**Base SKU (PC850):**
- Handles standard sizes (S, M, L, XL)
- Size01="S", Size02="M", Size03="L", Size04="XL"
- Size05=null, Size06=null

**Extended Size SKU (PC850_2XL):**
- Handles only 2XL
- Size01=null, Size02=null, Size03=null, Size04=null
- Size05="2XL"
- Size06=null

**Extended Size SKU (PC850_XS):**
- Handles only XS
- Size01=null through Size05=null
- Size06="XS"

---

## Sorting Logic

Results are sorted by **CASE_PRICE** in ascending order (lowest to highest):

1. **$10.51** - PC850_XS, PC850 (base)
2. **$11.58** - PC850_2XL
3. **$12.15** - PC850_3XL
4. **$12.67** - PC850_4XL

This allows you to quickly see the lowest-priced SKUs first.

---

## ShopWorks Integration Notes

### Which Color Field to Use?

**Use `CATALOG_COLOR` for ShopWorks imports.**

- `CATALOG_COLOR` = Official catalog color name (e.g., "Team Cardinal")
- `COLOR_NAME` = Display name for UI (same as CATALOG_COLOR in most cases)

ShopWorks expects the `CATALOG_COLOR` field for proper color matching.

### Size Field Population

When creating inventory entries in ShopWorks:
1. For each SKU in the response
2. Create a product with ID_Product as the SKU
3. Set color to CATALOG_COLOR value
4. Populate Size01-06 fields where the value is not null
5. Use CASE_PRICE for pricing

### null vs Actual Size Value

- **null** = This size field is DISABLED for this SKU (don't populate in ShopWorks)
- **"S", "M", "L", etc.** = This size field is ENABLED (populate in ShopWorks)

---

## Complete Examples

### Example 1: PC850 with Cardinal Color

**Request:**
```bash
GET /api/sanmar-shopworks/import-format?styleNumber=PC850&color=Cardinal
```

**Response:** Returns 5 SKUs
```json
[
  {
    "ID_Product": "PC850_XS",
    "CATALOG_COLOR": "Team Cardinal",
    "COLOR_NAME": "Team Cardinal",
    "Description": "Port  Co Fan Favorite Fleece Crewneck Sweatshirt",
    "Brand": "Port & Company",
    "CASE_PRICE": 10.51,
    "Size01": null,
    "Size02": null,
    "Size03": null,
    "Size04": null,
    "Size05": null,
    "Size06": "XS"
  },
  {
    "ID_Product": "PC850",
    "CATALOG_COLOR": "Team Cardinal",
    "COLOR_NAME": "Team Cardinal",
    "Description": "Port  Co Fan Favorite Fleece Crewneck Sweatshirt",
    "Brand": "Port & Company",
    "CASE_PRICE": 10.51,
    "Size01": "S",
    "Size02": "M",
    "Size03": "L",
    "Size04": "XL",
    "Size05": null,
    "Size06": null
  },
  {
    "ID_Product": "PC850_2XL",
    "CATALOG_COLOR": "Team Cardinal",
    "COLOR_NAME": "Team Cardinal",
    "Description": "Port  Co Fan Favorite Fleece Crewneck Sweatshirt",
    "Brand": "Port & Company",
    "CASE_PRICE": 11.58,
    "Size01": null,
    "Size02": null,
    "Size03": null,
    "Size04": null,
    "Size05": "2XL",
    "Size06": null
  },
  {
    "ID_Product": "PC850_3XL",
    "CATALOG_COLOR": "Team Cardinal",
    "COLOR_NAME": "Team Cardinal",
    "Description": "Port  Co Fan Favorite Fleece Crewneck Sweatshirt",
    "Brand": "Port & Company",
    "CASE_PRICE": 12.15,
    "Size01": null,
    "Size02": null,
    "Size03": null,
    "Size04": null,
    "Size05": null,
    "Size06": "3XL"
  },
  {
    "ID_Product": "PC850_4XL",
    "CATALOG_COLOR": "Team Cardinal",
    "COLOR_NAME": "Team Cardinal",
    "Description": "Port  Co Fan Favorite Fleece Crewneck Sweatshirt",
    "Brand": "Port & Company",
    "CASE_PRICE": 12.67,
    "Size01": null,
    "Size02": null,
    "Size03": null,
    "Size04": null,
    "Size05": null,
    "Size06": "4XL"
  }
]
```

### Example 2: PC54 (Standard Product)

**Request:**
```bash
GET /api/sanmar-shopworks/import-format?styleNumber=PC54&color=Black
```

**Response:** Returns 5 SKUs (PC54, PC54_XS, PC54_2XL, PC54_3XL, PC54_4XL)

### Example 3: J790 (Extended Multi-SKU)

**Request:**
```bash
GET /api/sanmar-shopworks/import-format?styleNumber=J790&color=Navy
```

**Response:** Returns 5 SKUs (J790, J790_XS, J790_2XL, J790_3XL, J790_4XL)

---

## Error Responses

### Missing Required Parameter

**Status:** 400 Bad Request

```json
{
  "error": "styleNumber parameter is required"
}
```

```json
{
  "error": "color parameter is required for import format"
}
```

### Product Not Found

**Status:** 404 Not Found

```json
{
  "error": "Product PC999 not found in ShopWorks integration table"
}
```

### Color Not Found

**Status:** 404 Not Found

```json
{
  "error": "Color \"Purple\" not found for PC850",
  "availableColors": ["Team Cardinal", "Athletic Gold", "Navy", ...]
}
```

---

## Technical Implementation

### Data Sources

This endpoint combines data from three Caspio tables:

1. **Shopworks_Integration** - SKU structure and size field mappings
   - Provides: ID_Product, Description, Size field configuration
   - Query: Exact style match (`ID_Product='PC850' OR ID_Product LIKE 'PC850[_]%'`)

2. **Sanmar_Bulk_251816_Feb2024** - Current pricing and color information
   - Provides: CATALOG_COLOR, COLOR_NAME, CASE_PRICE, MILL (brand)
   - Query: By STYLE and CATALOG_COLOR

3. **Size Field Logic** - Determined from `sts_LimitSizeXX` fields
   - `sts_LimitSize01 = 1` → Size01 is BLOCKED
   - `sts_LimitSize01 = null` → Size01 is ENABLED

### Query Logic

**Why "PC850[_]%" Pattern?**
- Matches: PC850, PC850_XS, PC850_2XL, PC850_3XL, PC850_4XL
- Excludes: PC850H, PC850Q, PC850YH, PC850ZH (different products)
- Uses SQL Server bracket syntax for literal underscore matching

### Size-Specific Pricing

Pricing is matched to the actual size each SKU handles:
- PC850_2XL gets 2XL price from Sanmar_Bulk
- PC850_3XL gets 3XL price from Sanmar_Bulk
- PC850 (base) gets S price (standard size pricing)

---

## Usage in Applications

### JavaScript Example

```javascript
async function getShopWorksData(styleNumber, color) {
  const url = `https://caspio-pricing-proxy-ab30a049961a.herokuapp.com/api/sanmar-shopworks/import-format?styleNumber=${styleNumber}&color=${encodeURIComponent(color)}`;

  const response = await fetch(url);
  const data = await response.json();

  // Process each SKU
  data.forEach(sku => {
    console.log(`SKU: ${sku.ID_Product}`);
    console.log(`Color: ${sku.CATALOG_COLOR} (${sku.COLOR_NAME})`);
    console.log(`Price: $${sku.CASE_PRICE}`);

    // Find enabled sizes
    const sizes = [];
    if (sku.Size01) sizes.push(sku.Size01);
    if (sku.Size02) sizes.push(sku.Size02);
    if (sku.Size03) sizes.push(sku.Size03);
    if (sku.Size04) sizes.push(sku.Size04);
    if (sku.Size05) sizes.push(sku.Size05);
    if (sku.Size06) sizes.push(sku.Size06);

    console.log(`Sizes: ${sizes.join(', ')}`);
  });
}

// Usage
getShopWorksData('PC850', 'Cardinal');
```

### cURL Example

```bash
curl -X GET "https://caspio-pricing-proxy-ab30a049961a.herokuapp.com/api/sanmar-shopworks/import-format?styleNumber=PC850&color=Cardinal"
```

---

## Related Endpoints

### Other ShopWorks Endpoints

1. **Comprehensive Mapping** - `/api/sanmar-shopworks/mapping`
   - Returns more detailed mapping data with multiple color options
   - Shows all available colors for a style
   - Includes usage instructions

2. **Color Mapping** - `/api/sanmar-shopworks/color-mapping`
   - Returns all available colors for a style
   - Useful for displaying color options to users

3. **Suffix Mapping** - `/api/sanmar-shopworks/suffix-mapping`
   - Returns SKU suffix rules (_2XL, _3XL, etc.)
   - Useful for understanding SKU naming conventions

---

## Version History

### v1.0.0 (Current)
- Initial release of ShopWorks import format endpoint
- Exact style matching (excludes product families)
- Size-specific pricing from Sanmar_Bulk
- Sorted by CASE_PRICE (lowest to highest)
- Uses SanMar column names (CATALOG_COLOR, COLOR_NAME)

### Key Updates
- **2025-11-09**: Fixed underscore escape syntax for Caspio SQL (`[_]` pattern)
- **2025-11-09**: Added size-specific CASE_PRICE from Sanmar_Bulk
- **2025-11-09**: Changed to SanMar column names (CATALOG_COLOR, COLOR_NAME)
- **2025-11-09**: Added CASE_PRICE sorting (lowest to highest)

---

## Support

For questions or issues with this endpoint:
- Check the [main API documentation](./API_DOCUMENTATION.md)
- Review the [developer guide](./DEVELOPER_GUIDE.md)
- Contact: erik@northwestcustomapparel.com
