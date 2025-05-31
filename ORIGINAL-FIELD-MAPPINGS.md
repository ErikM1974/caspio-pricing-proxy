# Original Field Mappings from server.js (Before Refactoring)

Based on analysis of the git history, here are the original field mappings used in the server.js endpoints before refactoring, compared with the current refactored implementation:

## `/api/product-details` Endpoint

### Caspio Query Fields:
- Table: `Sanmar_Bulk_251816_Feb2024`
- WHERE: `STYLE='${styleNumber}'` (and optionally color filters)
- SELECT for basic details: `PRODUCT_TITLE, PRODUCT_DESCRIPTION, COLOR_NAME, CATALOG_COLOR`
- SELECT for images: `FRONT_FLAT, FRONT_MODEL, BACK_FLAT, BACK_MODEL, COLOR_NAME, CATALOG_COLOR`

### Response Mapping:
```javascript
{
    PRODUCT_TITLE: productDetails.PRODUCT_TITLE,
    PRODUCT_DESCRIPTION: productDetails.PRODUCT_DESCRIPTION,
    FRONT_FLAT: imageRecord.FRONT_FLAT || '',
    FRONT_MODEL: imageRecord.FRONT_MODEL || '',
    BACK_FLAT: imageRecord.BACK_FLAT || '',
    BACK_MODEL: imageRecord.BACK_MODEL || '',
    COLOR_NAME: productDetails.COLOR_NAME || imageRecord.COLOR_NAME || '',
    CATALOG_COLOR: productDetails.CATALOG_COLOR || imageRecord.CATALOG_COLOR || ''
}
```

## `/api/product-colors` Endpoint

### Caspio Query Fields:
- Table: `Sanmar_Bulk_251816_Feb2024`
- WHERE: `STYLE='${styleNumber}'`
- SELECT: All fields (no specific selection)

### Response Mapping:
```javascript
{
    productTitle: records[0]?.PRODUCT_TITLE || `Product ${styleNumber}`,
    PRODUCT_DESCRIPTION: records[0]?.PRODUCT_DESCRIPTION || "Sample product description.",
    colors: [
        {
            COLOR_NAME: colorName,
            CATALOG_COLOR: record.CATALOG_COLOR || colorName,
            COLOR_SQUARE_IMAGE: record.COLOR_SQUARE_IMAGE || '',
            MAIN_IMAGE_URL: record.MAIN_IMAGE_URL || record.FRONT_MODEL || record.FRONT_FLAT || '',
            // Optional fields (added if they exist):
            FRONT_MODEL: record.FRONT_MODEL, // if exists
            FRONT_FLAT: record.FRONT_FLAT    // if exists
        }
    ]
}
```

### Color Priority for Main Image:
1. `MAIN_IMAGE_URL` (preferred)
2. `FRONT_MODEL` (fallback)
3. `FRONT_FLAT` (fallback)

## `/api/color-swatches` Endpoint

### Caspio Query Fields:
- Table: `Sanmar_Bulk_251816_Feb2024`
- WHERE: `STYLE='${styleNumber}'`
- SELECT: `COLOR_NAME, CATALOG_COLOR, COLOR_SQUARE_IMAGE`
- ORDERBY: `COLOR_NAME ASC`

### Response Mapping:
Returns an array of swatch objects:
```javascript
[
    {
        COLOR_NAME: swatch.COLOR_NAME,
        CATALOG_COLOR: swatch.CATALOG_COLOR,
        COLOR_SQUARE_IMAGE: swatch.COLOR_SQUARE_IMAGE
    }
]
```

### Filtering Logic:
- Only includes swatches where ALL three fields (COLOR_NAME, CATALOG_COLOR, COLOR_SQUARE_IMAGE) are present
- Deduplicates based on COLOR_NAME (first occurrence wins)
- Results are sorted alphabetically by COLOR_NAME

## Key Notes:

1. **Direct Field Mapping**: The original code used direct field names from Caspio without transformation
2. **Fallback Values**: Empty strings (`''`) were used as fallbacks for missing image fields
3. **Color Deduplication**: Both product-colors and color-swatches deduplicated colors based on COLOR_NAME
4. **Image URL Priority**: product-colors had a specific priority order for selecting the main image
5. **Required Fields**: color-swatches required all three fields to be present for a valid swatch

## Comparison with Current Refactored Implementation

### `/api/product-details` (Current)

**Key Changes:**
- Now in `src/routes/products.js`
- Different field names used:
  - `FRONT_MODEL_IMAGE_URL` instead of `FRONT_MODEL`
  - `BACK_MODEL_IMAGE` instead of `BACK_MODEL`
  - `FRONT_FLAT_IMAGE` instead of `FRONT_FLAT`
  - `BACK_FLAT_IMAGE` instead of `BACK_FLAT`
- Response structure changed to return array of unique styles with consolidated `images` array
- Added additional fields: `BRAND_NAME`, `SIDE_MODEL`, `THREE_Q_MODEL`, pricing fields (`PIECE_PRICE`, etc.), `CATEGORY_NAME`, `SUBCATEGORY_NAME`, `PRODUCT_STATUS`, `SIZE`

### `/api/product-colors` (Current)

**Key Changes:**
- Complete response structure overhaul:
  ```javascript
  // Original structure:
  {
    productTitle: string,
    PRODUCT_DESCRIPTION: string,
    colors: [{ COLOR_NAME, CATALOG_COLOR, COLOR_SQUARE_IMAGE, MAIN_IMAGE_URL, etc. }]
  }
  
  // Current structure:
  [
    {
      color: string,
      hexCode: string,
      imageUrl: string,
      inStock: boolean,
      totalQuantity: number
    }
  ]
  ```
- Lost fields: `productTitle`, `PRODUCT_DESCRIPTION`, `CATALOG_COLOR`
- New fields: `hexCode` (from `PMS_COLOR`), `inStock`, `totalQuantity`
- Different image field: `FRONT_MODEL_IMAGE_URL` instead of multiple image options

### `/api/color-swatches` (Current)

**Key Changes:**
- Response structure completely changed:
  ```javascript
  // Original: Array of { COLOR_NAME, CATALOG_COLOR, COLOR_SQUARE_IMAGE }
  // Current: Array of { color, hasInventory }
  ```
- Lost fields: `CATALOG_COLOR`, `COLOR_SQUARE_IMAGE`
- Different field name: `COLOR_SWATCH_IMAGE` queried but not returned
- Added inventory-based filtering with early exit condition
- Focus shifted from displaying swatches to checking inventory availability