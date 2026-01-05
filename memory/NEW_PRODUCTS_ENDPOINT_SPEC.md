# New Products Management Endpoints - Implementation Spec

**Date:** 2025-01-03
**Request From:** Pricing Index File 2025 Claude
**For:** Caspio Pricing Proxy Claude
**Priority:** High

---

## Overview

The Pricing Index File system needs endpoints to manage the "new products" feature. This involves:

1. Adding an `IsNew` boolean field to the Sanmar products table
2. Batch updating products to mark them as new
3. Querying products marked as new for display on showcase page

---

## Background Context

### Current State
- **Table:** `Sanmar_Bulk_251816_Feb2024` (70+ fields)
- **Existing Pattern:** `IsTopSeller` boolean field (follow this pattern)
- **Products to Mark:** 15 Active products identified from validation script
- **Display:** New products showcase page (similar to top sellers)

### Why This Feature
Sales team wants to highlight new product arrivals on the website. Products should be marked as "new" in the database and displayed with green "NEW" badges on a dedicated showcase page.

---

## Required Endpoints

### 1. Add IsNew Field to Table (One-Time Setup)

**Endpoint:** `POST /api/admin/products/add-isnew-field`

**Purpose:** Add `IsNew` boolean field to products table (if doesn't exist)

**Request:**
```json
{
  "tableName": "Sanmar_Bulk_251816_Feb2024"
}
```

**Response (Success):**
```json
{
  "success": true,
  "message": "IsNew field added successfully",
  "field": {
    "Name": "IsNew",
    "Type": "Yes/No",
    "Description": "Flag for new products to display in showcase"
  }
}
```

**Response (Already Exists):**
```json
{
  "success": true,
  "message": "IsNew field already exists",
  "alreadyExists": true
}
```

**Implementation Notes:**
- Use Caspio REST API: `POST /v3/tables/{tableName}/fields`
- Field spec: `{ Name: 'IsNew', Type: 'Yes/No', DefaultValue: false }`
- Follow same pattern as `IsTopSeller` field
- Handle "already exists" gracefully (not an error)

---

### 2. Batch Update New Products

**Endpoint:** `POST /api/admin/products/mark-as-new`

**Purpose:** Mark multiple products as new in batch operation

**Request:**
```json
{
  "styleNumbers": [
    "EB120", "EB121", "CT100617", "CT103828", "CT104670",
    "CT104597", "DT620", "DT624", "NE410",
    "ST850", "ST851",
    "BB18200", "CS410", "CS415",
    "EB201"
  ],
  "isNew": true
}
```

**Response:**
```json
{
  "success": true,
  "updated": 15,
  "failed": 0,
  "results": [
    {
      "style": "EB120",
      "success": true,
      "title": "Eddie Bauer Adventurer 1/4-Zip EB120"
    },
    {
      "style": "EB121",
      "success": true,
      "title": "Eddie Bauer Women's Adventurer Full-Zip EB121"
    }
    // ... rest of products
  ]
}
```

**Implementation Notes:**
- Query each STYLE to get PK_ID (Caspio requires PK_ID for updates)
- Use Caspio REST API: `PUT /v3/tables/{tableName}/records`
- Batch update format: Update WHERE STYLE IN (...)
- Only update products with `PRODUCT_STATUS = 'Active'` (safety check)
- Skip any products marked as "DISCONTINUED" in title
- Return detailed results for each product

**Error Handling:**
- If product not found: Include in failed list with error message
- If product is discontinued: Skip and note in response
- If update fails: Include in failed list with error details

---

### 3. Query New Products (Optional - May Already Exist)

**Endpoint:** `GET /api/products/new`

**Purpose:** Retrieve all products marked as new for showcase page

**Query Parameters:**
- `limit` (optional, default: 50) - Max products to return
- `category` (optional) - Filter by category
- `brand` (optional) - Filter by brand

**Response:**
```json
{
  "products": [
    {
      "STYLE": "EB120",
      "PRODUCT_TITLE": "Eddie Bauer Adventurer 1/4-Zip EB120",
      "BRAND_NAME": "Eddie Bauer",
      "CATEGORY_NAME": "Outerwear/Jackets",
      "PRODUCT_STATUS": "Active",
      "IsNew": true,
      "thumbnailUrl": "...",
      "colors": [...]
    }
    // ... more products
  ],
  "total": 15
}
```

**Implementation Notes:**
- Query: `WHERE IsNew = true AND PRODUCT_STATUS = 'Active'`
- Additional safety: Exclude if title contains "DISCONTINUED"
- Return same structure as existing product endpoints
- Consider caching (5-minute TTL recommended)

---

## Products to Update

These 15 Active products should be marked with `IsNew=true`:

### Outerwear/Jackets (5 products)
- EB120 - Eddie Bauer Adventurer 1/4-Zip
- EB121 - Eddie Bauer Women's Adventurer Full-Zip
- CT100617 - Carhartt Rain Defender Paxton Sweatshirt
- CT103828 - Carhartt Waterproof Jacket
- CT104670 - Carhartt Rain Defender Jacket

### Headwear (4 products)
- CT104597 - Carhartt Knit Cap
- DT620 - District Thin Beanie
- DT624 - District Slouch Beanie
- NE410 - New Era Snapback Cap

### Fleece/Sweatshirts (2 products)
- ST850 - Sport-Tek Sport-Wick Stretch 1/4-Zip
- ST851 - Sport-Tek Sport-Wick Stretch Pullover

### Apparel (2 products)
- BB18200 - Brooks Brothers Non-Iron Stretch Shirt
- CS410 - CornerStone Select Snag-Proof Polo
- CS415 - CornerStone Select Lightweight Polo

### Bags (1 product)
- EB201 - Eddie Bauer Travex Carry-On

**Total:** 15 products

---

## Validation & Safety Checks

### Pre-Update Validation
1. **Field Existence:** Verify `IsNew` field exists before updating
2. **Product Existence:** Verify each STYLE exists in database
3. **Product Status:** Only update products with `PRODUCT_STATUS = 'Active'`
4. **Discontinued Check:** Skip if title contains "DISCONTINUED"

### Post-Update Verification
1. Query updated products to confirm `IsNew=true`
2. Return detailed results showing success/failure for each
3. Log all operations for audit trail

---

## Caspio REST API Details

### Authentication
- **Bearer Token:** Use existing Caspio credentials from environment
- **Account ID:** c3eku948
- **Base URL:** `https://c3eku948.caspio.com/rest/v3`

### Add Field API
```
POST /v3/tables/Sanmar_Bulk_251816_Feb2024/fields
Authorization: Bearer {token}
Content-Type: application/json

{
  "Name": "IsNew",
  "Type": "Yes/No",
  "Description": "Flag for new products to display in showcase",
  "DefaultValue": false,
  "Required": false
}
```

### Update Records API
```
PUT /v3/tables/Sanmar_Bulk_251816_Feb2024/records
Authorization: Bearer {token}
Content-Type: application/json

{
  "upsert": false,
  "filter": "STYLE IN ('EB120', 'EB121', ...)",
  "data": {
    "IsNew": true
  }
}
```

---

## Testing Plan

### Step 1: Test Field Creation
```bash
curl -X POST http://localhost:3000/api/admin/products/add-isnew-field \
  -H "Content-Type: application/json" \
  -d '{"tableName": "Sanmar_Bulk_251816_Feb2024"}'
```

**Expected:** `IsNew` field added to table

### Step 2: Test Batch Update
```bash
curl -X POST http://localhost:3000/api/admin/products/mark-as-new \
  -H "Content-Type: application/json" \
  -d '{
    "styleNumbers": ["EB120", "EB121"],
    "isNew": true
  }'
```

**Expected:** 2 products updated successfully

### Step 3: Verify via Product Details
```bash
curl http://localhost:3000/api/product-details?styleNumber=EB120
```

**Expected:** Response includes `"IsNew": true`

### Step 4: Test New Products Query
```bash
curl http://localhost:3000/api/products/new?limit=20
```

**Expected:** Returns 15 products with `IsNew=true`

---

## Error Scenarios to Handle

1. **Field Already Exists:** Return success with `alreadyExists: true`
2. **Product Not Found:** Include in failed list with clear message
3. **Product Discontinued:** Skip with note in response
4. **Caspio API Error:** Catch and return helpful error message
5. **Invalid Style Number:** Validate format before querying
6. **Empty Style List:** Return error for empty array
7. **Caspio Token Expired:** Handle 401 and refresh token

---

## Client Usage Example

Once endpoints are implemented, the Pricing Index File system will use them like this:

```javascript
// Step 1: Ensure field exists (one-time)
const fieldResult = await fetch('http://localhost:3000/api/admin/products/add-isnew-field', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ tableName: 'Sanmar_Bulk_251816_Feb2024' })
});

// Step 2: Mark products as new
const updateResult = await fetch('http://localhost:3000/api/admin/products/mark-as-new', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    styleNumbers: ['EB120', 'EB121', 'CT100617', /* ... */],
    isNew: true
  })
});

// Step 3: Fetch for showcase page
const newProducts = await fetch('http://localhost:3000/api/products/new?limit=50');
```

---

## Success Criteria

✅ **Endpoint 1:** Field creation works (handles already exists)
✅ **Endpoint 2:** Batch update marks 15 products successfully
✅ **Endpoint 3:** Query returns only Active products with IsNew=true
✅ **Safety:** Discontinued products never shown
✅ **Testing:** All endpoints tested and working
✅ **Documentation:** API endpoints documented in proxy README

---

## Additional Notes

### Why Admin Endpoints?
These are administrative operations (not customer-facing), so using `/api/admin/` prefix is appropriate. Consider adding basic auth or IP restrictions if needed.

### Caching Strategy
- **Field Creation:** No caching (one-time operation)
- **Batch Update:** No caching (write operation)
- **New Products Query:** 5-minute cache recommended (changes infrequently)

### Future Enhancements
- Bulk import of new products from vendor feeds
- Automatic "new" flag expiration after 90 days
- Admin UI for managing new products flags
- Analytics on new product views/conversions

---

## Questions for Implementation

1. **Auth:** Should admin endpoints require authentication? (recommend yes)
2. **Logging:** What level of detail for operation logs?
3. **Cache:** Confirm 5-minute TTL for new products query?
4. **Notifications:** Email notification when batch update completes?

---

**Implementation Priority:** High
**Estimated Complexity:** Medium (2-3 hours)
**Dependencies:** Caspio REST API credentials in environment
**Testing Required:** Full endpoint testing with 15 products

---

**Prepared by:** Pricing Index File 2025 Claude
**Date:** 2025-01-03
**Status:** Ready for Implementation
