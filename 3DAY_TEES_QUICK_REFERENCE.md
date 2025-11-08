# 3-Day Tees Page - Quick Reference Guide

## Absolute File Paths

### API Route Files
- DTG Routes: `/home/user/caspio-pricing-proxy/src/routes/dtg.js`
- Pricing Routes: `/home/user/caspio-pricing-proxy/src/routes/pricing.js`
- Product Routes: `/home/user/caspio-pricing-proxy/src/routes/products.js`
- Cart Routes: `/home/user/caspio-pricing-proxy/src/routes/cart.js`
- Order Routes: `/home/user/caspio-pricing-proxy/src/routes/orders.js`
- Inventory Routes: `/home/user/caspio-pricing-proxy/src/routes/inventory.js`
- Quotes Routes: `/home/user/caspio-pricing-proxy/src/routes/quotes.js`

### Utility Files
- Caspio API Helper: `/home/user/caspio-pricing-proxy/src/utils/caspio.js`
- Field Mapper: `/home/user/caspio-pricing-proxy/src/utils/field-mapper.js`
- Configuration: `/home/user/caspio-pricing-proxy/config.js`

### Main Server File
- Server Entry Point: `/home/user/caspio-pricing-proxy/server.js`

### Test/Example Files
- Quote Integration Test: `/home/user/caspio-pricing-proxy/test-quote-integration.html`
- Cart Items Test: `/home/user/caspio-pricing-proxy/tests/manual/cart-items-test.html`
- Cart Sessions Test: `/home/user/caspio-pricing-proxy/tests/manual/cart-sessions-test.html`
- JavaScript Examples: `/home/user/caspio-pricing-proxy/examples/javascript/examples.js`
- cURL Examples: `/home/user/caspio-pricing-proxy/examples/curl/examples.sh`

### Documentation
- BLANK Pricing: `/home/user/caspio-pricing-proxy/memory/BLANK_PRICING.md`
- Developer Guide: `/home/user/caspio-pricing-proxy/memory/DEVELOPER_GUIDE.md`
- API Documentation: `/home/user/caspio-pricing-proxy/memory/API_DOCUMENTATION.md`
- Online Store Guide: `/home/user/caspio-pricing-proxy/memory/ONLINE_STORE_DEVELOPER_GUIDE.md`

---

## Most Important API Endpoints for 3-Day Tees

### 1. GET Product Bundle (ALL IN ONE)
```
GET /api/dtg/product-bundle?styleNumber=PC54&color=Red
```
**Returns:** Product info, colors, tiers, costs, locations, sizes, upcharges
**Use:** Primary endpoint for product & pricing display

### 2. POST Create Cart Session
```
POST /api/cart-sessions
{
  "SessionID": "session-123",
  "UserID": "optional",
  "IsActive": true
}
```

### 3. POST Add to Cart
```
POST /api/cart-items
{
  "SessionID": "session-123",
  "StyleNumber": "PC54",
  "Color": "Red",
  "Size": "L",
  "Quantity": 12,
  "ImprintType": "DTG",
  "ImprintLocations": "Front",
  "CartStatus": "Active"
}
```

### 4. GET Product Colors
```
GET /api/product-colors?styleNumber=PC54
```
**Use:** For color selector dropdown

### 5. GET Product Details
```
GET /api/product-details?styleNumber=PC54&color=Red
```
**Use:** Full product info including images, prices, brand

### 6. GET Pricing Tiers
```
GET /api/pricing-tiers?method=DTG
```
**Use:** For tier display (1-23, 24-47, etc.)

### 7. GET Size Pricing
```
GET /api/size-pricing?styleNumber=PC54&color=Red
```
**Use:** Size-specific pricing with upcharges

---

## PC54 Product Information

**Product:** Port & Company Essential T-Shirt
**Style Number:** PC54
**Available Colors:** Red, Blue, Black, White, Navy, etc.
**Available Sizes:** XS, S, M, L, XL, 2XL, 3XL, 4XL, 5XL, 6XL
**Database Table:** Sanmar_Bulk_251816_Feb2024

---

## DTG Decoration Details

**Print Locations:**
- LC = Left Chest
- FF = Full Front
- FB = Full Back
- POCKET = Pocket
- SLEEVE = Sleeve

**Pricing Tiers:**
- Tier 1: 1-23 units
- Tier 2: 24-47 units
- Tier 3: 48-71 units
- Tier 4: 72+ units

---

## Image Field References

| Field | Usage | Example |
|-------|-------|---------|
| FRONT_MODEL | Model wearing product | Product photo |
| COLOR_SQUARE_IMAGE | Color swatch | Swatch picker |
| FRONT_FLAT | Flat lay photo | Product detail |
| PRODUCT_IMAGE | Generic photo | Fallback |

---

## Caspio Tables to Know

| Table | Purpose | Key Fields |
|-------|---------|-----------|
| Sanmar_Bulk_251816_Feb2024 | Product catalog | STYLE, COLOR_NAME, SIZE, CASE_PRICE, PRODUCT_TITLE, FRONT_MODEL |
| Pricing_Tiers | Quantity tiers | TierLabel, MinQuantity, MaxQuantity, MarginDenominator |
| DTG_Costs | Print costs | PrintLocationCode, TierLabel, PrintCost |
| location | Print locations | location_code, location_name, Type='DTG' |
| Standard_Size_Upcharges | Size premiums | SizeDesignation, StandardAddOnAmount |
| Size_Display_Order | Size sequence | size, sort_order |

---

## Production Deployment Info

**Base URL:** https://caspio-pricing-proxy-ab30a049961a.herokuapp.com

**Example Endpoints:**
```
https://caspio-pricing-proxy-ab30a049961a.herokuapp.com/api/dtg/product-bundle?styleNumber=PC54
https://caspio-pricing-proxy-ab30a049961a.herokuapp.com/api/pricing-bundle?method=DTG&styleNumber=PC54
https://caspio-pricing-proxy-ab30a049961a.herokuapp.com/api/product-colors?styleNumber=PC54
```

---

## Development Testing

**Local Port:** 3002
**Health Check:** GET http://localhost:3002/api/health

**WSL Testing:**
```bash
# Get your WSL IP
hostname -I | awk '{print $1}'

# Example: http://172.20.132.206:3002/api/dtg/product-bundle?styleNumber=PC54
```

---

## Code Patterns

### Fetch Product Bundle
```javascript
const response = await fetch('/api/dtg/product-bundle?styleNumber=PC54&color=Red');
const data = await response.json();
const { product, pricing } = data;
```

### Create Cart Session
```javascript
const response = await fetch('/api/cart-sessions', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    SessionID: `session_${Date.now()}`,
    UserID: userId,
    IsActive: true
  })
});
```

### Add Item to Cart
```javascript
const response = await fetch('/api/cart-items', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    SessionID: sessionId,
    StyleNumber: 'PC54',
    Color: 'Red',
    Size: 'L',
    Quantity: 12,
    ImprintType: 'DTG',
    ImprintLocations: 'Front',
    CartStatus: 'Active'
  })
});
```

---

## Error Handling Notes

- API returns 200 status even for "not found" (returns empty arrays)
- Use response.data.length to check if results exist
- Check for null/undefined on image fields
- All endpoints support optional ?refresh=true parameter

---

## Key Features

1. **DTG Bundle Endpoint** - Single request combines everything
2. **5-Minute Cache** - Performance optimization
3. **Pagination Support** - Handles large datasets
4. **Backward Compatibility** - Maps field names for legacy apps
5. **CORS Enabled** - Works from different origins
6. **Rate Limiting** - Built-in protection

---

## Related Documentation

- Full Components Guide: `3DAY_TEES_PAGE_COMPONENTS.md`
- BLANK Pricing: `/home/user/caspio-pricing-proxy/memory/BLANK_PRICING.md`
- Developer Guide: `/home/user/caspio-pricing-proxy/memory/DEVELOPER_GUIDE.md`
- API Specification: `/home/user/caspio-pricing-proxy/memory/API_SPECIFICATION.yaml`
