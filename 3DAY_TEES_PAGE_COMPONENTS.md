# 3-Day Tees Page - Existing Components & Resources

## Project Overview
This is an Express.js API proxy server that integrates with Caspio's database for product pricing, inventory, and order management. The project uses modular routing architecture with separate files for each API domain.

**Key Directory Structure:**
```
/home/user/caspio-pricing-proxy/
├── src/
│   ├── routes/           # API endpoint handlers
│   ├── utils/            # Helper functions (Caspio API, field mapping)
│   ├── middleware/       # Express middleware
│   └── config/           # Configuration management
├── memory/               # Documentation & guides
├── examples/             # Code examples (JavaScript, Python, cURL)
├── tests/                # Test files and manual HTML tests
└── server.js            # Main Express application
```

---

## 1. DTG PRICING PAGE/COMPONENTS

### 1.1 DTG Route Handler
**File:** `/home/user/caspio-pricing-proxy/src/routes/dtg.js`

**Key Endpoint:** `GET /api/dtg/product-bundle`

**Description:** Optimized single-request endpoint that combines product details, colors, pricing tiers, costs, and size information for DTG printing.

**What It Returns:**
- Product information (title, description, style number)
- Available colors with color square images and main product images
- DTG pricing tiers (1-23, 24-47, 48-71, 72+ quantities)
- Print costs by location (Left Chest, Full Front, Full Back, Pocket, Sleeve)
- Size-specific base prices and upcharges

**Example Usage:**
```
GET /api/dtg/product-bundle?styleNumber=PC54&color=Red
```

**Response Structure:**
```json
{
  "product": {
    "styleNumber": "PC54",
    "title": "Port & Company Essential T-Shirt",
    "description": "...",
    "colors": [
      {
        "COLOR_NAME": "Red",
        "CATALOG_COLOR": "RED",
        "COLOR_SQUARE_IMAGE": "...",
        "MAIN_IMAGE_URL": "..."
      }
    ],
    "selectedColor": { ... }
  },
  "pricing": {
    "tiers": [
      {
        "TierLabel": "1-23",
        "MinQuantity": 1,
        "MaxQuantity": 23,
        "MarginDenominator": 0.6,
        "TargetMargin": 0,
        "LTM_Fee": 50
      }
    ],
    "costs": [
      {
        "PrintLocationCode": "LC",
        "TierLabel": "1-23",
        "PrintCost": 2.50
      }
    ],
    "sizes": [
      {
        "size": "S",
        "maxCasePrice": 3.45
      }
    ],
    "upcharges": {
      "3XL": 0.50,
      "4XL": 1.00
    },
    "locations": [
      {
        "code": "LC",
        "name": "Left Chest"
      }
    ]
  },
  "metadata": {
    "cachedAt": "...",
    "ttl": 300,
    "source": "dtg-bundle-v1"
  }
}
```

### 1.2 Pricing Routes (Related DTG Endpoints)
**File:** `/home/user/caspio-pricing-proxy/src/routes/pricing.js`

**DTG-Specific Endpoints:**

1. **GET /api/pricing-tiers?method=DTG**
   - Returns all DTG pricing tiers

2. **GET /api/dtg-costs**
   - Returns all DTG print location costs

3. **GET /api/pricing-bundle?method=DTG&styleNumber=PC54**
   - Comprehensive pricing data for a specific style
   - Includes tiers, rules, locations, costs, and size data

4. **GET /api/pricing-bundle?method=BLANK**
   - For blank products with no decoration

5. **GET /api/max-prices-by-style?styleNumber=PC54**
   - Maximum garment costs by size

6. **GET /api/size-pricing?styleNumber=PC54&color=Red**
   - Size-specific pricing with upcharges

---

## 2. PRODUCT & INVENTORY DATA

### 2.1 Product Routes
**File:** `/home/user/caspio-pricing-proxy/src/routes/products.js`

**Key Endpoints:**

1. **GET /api/stylesearch?term=PC**
   - Search for products by style number
   - Returns matching styles with product titles

2. **GET /api/product-details?styleNumber=PC54&color=Red**
   - Full product details including images, prices, category
   - Returns: STYLE, PRODUCT_TITLE, PRODUCT_DESCRIPTION, COLOR_NAME, CATALOG_COLOR, BRAND_NAME, FRONT_MODEL, BACK_MODEL, FRONT_FLAT, BACK_FLAT, PIECE_PRICE, DOZEN_PRICE, CASE_PRICE, CATEGORY_NAME, SUBCATEGORY_NAME, PRODUCT_STATUS, PRODUCT_IMAGE, COLOR_SQUARE_IMAGE

3. **GET /api/color-swatches?styleNumber=PC54**
   - Get all available colors for a style with color square images

4. **GET /api/product-colors?styleNumber=PC54**
   - Product colors with images (model and flat)

### 2.2 PC54 Product Data
**About PC54:**
- Port & Company Essential T-Shirt
- Currently used in most test cases
- Has multiple colors available (Red, Blue, Black, White, etc.)
- Available in sizes: XS, S, M, L, XL, 2XL, 3XL, 4XL, 5XL, 6XL

**Data Source:**
- Caspio table: `Sanmar_Bulk_251816_Feb2024`
- Contains inventory data including: STYLE, PRODUCT_TITLE, PRODUCT_DESCRIPTION, COLOR_NAME, CATALOG_COLOR, BRAND_NAME, FRONT_MODEL, FRONT_FLAT, BACK_MODEL, BACK_FLAT, SIZE, CASE_PRICE, PIECE_PRICE, DOZEN_PRICE, CATEGORY_NAME, SUBCATEGORY_NAME, PRODUCT_STATUS, PRODUCT_IMAGE, COLOR_SQUARE_IMAGE

### 2.3 Inventory Routes
**File:** `/home/user/caspio-pricing-proxy/src/routes/inventory.js`

**Endpoints:**
- **GET /api/inventory?styleNumber=PC54**
- **GET /api/inventory?styleNumber=PC54&color=Red**
- Check available stock levels

---

## 3. ORDER FORMS & SAMPLE FORMS

### 3.1 Cart Management System
**File:** `/home/user/caspio-pricing-proxy/src/routes/cart.js`

**Core Endpoints:**

1. **POST /api/cart-sessions** - Create new shopping session
   ```json
   {
     "SessionID": "unique-session-id",
     "UserID": "optional-user-id",
     "IsActive": true
   }
   ```

2. **POST /api/cart-items** - Add item to cart
   ```json
   {
     "SessionID": "session-123",
     "StyleNumber": "PC54",
     "Color": "Red",
     "Size": "L",
     "Quantity": 12,
     "ImprintType": "DTG",
     "ImprintLocations": "Front",
     "CartStatus": "Active",
     "imageUrl": "optional-image-url"
   }
   ```

3. **POST /api/cart-item-sizes** - Add size-specific quantity breakdown
   ```json
   {
     "CartItemID": "item-123",
     "SizeDesignation": "M",
     "QuantityForSize": 6
   }
   ```

4. **GET /api/cart-items** - Retrieve cart items
5. **PUT /api/cart-items/:id** - Update cart item
6. **DELETE /api/cart-items/:id** - Remove from cart

### 3.2 Manual Test HTML Forms
**Location:** `/home/user/caspio-pricing-proxy/tests/manual/`

**Key Test Files:**

1. **cart-items-test.html** - Full cart item testing interface
   - Form for creating/updating cart items
   - Table display of all cart items
   - Supports: StyleNumber, Color, Size, Quantity, ImprintType, ImageUrl

2. **quote-endpoints-test.html** - Quote/pricing test interface
   - Create and manage quotes
   - Add quote items with details
   - Track analytics

3. **cart-sessions-test.html** - Session management testing

### 3.3 Quote System
**File:** `/home/user/caspio-pricing-proxy/src/routes/quotes.js`

**Endpoints:**
- **POST /api/quotes** - Create new quote
- **GET /api/quotes** - List quotes
- **POST /api/quote-items** - Add items to quote
- **POST /api/quote-analytics** - Track quote interactions

---

## 4. PRICING LOGIC & CALCULATION ENDPOINTS

### 4.1 Pricing Bundle Endpoint
**File:** `/home/user/caspio-pricing-proxy/src/routes/pricing.js`

**GET /api/pricing-bundle**

**Supported Decoration Methods:**
- `DTG` - Direct-to-Garment printing
- `EMB` - Embroidery (shirts)
- `CAP` - Embroidery (caps)
- `ScreenPrint` - Screen printing
- `DTF` - Direct-to-Film transfer
- `EMB-AL` - Additional Logo Embroidery
- `CAP-AL` - Additional Logo Cap Embroidery
- `BLANK` - Blank products (no decoration)

**Returns:**
- Pricing tiers with margin denominators
- Decoration cost tables
- Print location definitions
- Size-specific pricing (if styleNumber provided)
- Size upcharges

### 4.2 Base Pricing Data
**Endpoints:**

1. **GET /api/base-item-costs?styleNumber=PC54**
   - Returns base garment costs by size

2. **GET /api/max-prices-by-style?styleNumber=PC54**
   - Maximum price per size across all colors

3. **GET /api/size-pricing?styleNumber=PC54&color=Red**
   - Complete size pricing with upcharges

### 4.3 Caspio Database Tables Used

**Product Table:**
- Table Name: `Sanmar_Bulk_251816_Feb2024`
- Contains product catalog with colors, sizes, and prices

**Pricing Tables:**
- `Pricing_Tiers` - Tier definitions (quantity ranges, margins)
- `Pricing_Rules` - Rounding and calculation rules
- `DTG_Costs` - DTG print location costs
- `Embroidery_Costs` - Embroidery item costs
- `Screenprint_Costs` - Screenprint costs
- `DTF_Pricing` - DTF costs
- `Standard_Size_Upcharges` - Size premiums

**Location Table:**
- `location` - Print location definitions (Left Chest, Full Front, etc.)

**Size Table:**
- `Size_Display_Order` - Size ordering/display sequence

---

## 5. FRONTEND PAGES & EXISTING IMPLEMENTATIONS

### 5.1 Manual Test Pages
**Location:** `/home/user/caspio-pricing-proxy/`

1. **test-quote-integration.html** - Comprehensive quote system test
   - Quote analytics tracking
   - Quote items management
   - Session handling

2. **quote-endpoints-test.html** - Extended quote endpoint testing

### 5.2 API Health Check
**GET /api/health**

Returns:
- Server status and port info
- WSL IP address
- Caspio domain info
- Ready-to-use test URLs

Example URLs in response:
```
http://[WSL-IP]:3002/api/order-dashboard
http://[WSL-IP]:3002/api/products/PC54
http://[WSL-IP]:3002/api/health
```

### 5.3 Static File Serving
The server serves static files from the current directory using:
```javascript
app.use(express.static('.'));
```

This means you can create HTML pages and they'll be accessible at the root.

---

## 6. IMAGE DATA & CDN REFERENCES

### 6.1 Image Fields in Responses
**Key Image Fields:**

1. **FRONT_MODEL** - Model photo of product from front
2. **BACK_MODEL** - Model photo from back
3. **FRONT_FLAT** - Flat lay photo from front
4. **BACK_FLAT** - Flat lay from back
5. **COLOR_SQUARE_IMAGE** - Small swatch image for color selection
6. **PRODUCT_IMAGE** - Generic product photo
7. **MAIN_IMAGE_URL** - Primary image (fallback chain: FRONT_MODEL → FRONT_FLAT → PRODUCT_IMAGE)

### 6.2 Field Mapping Utility
**File:** `/home/user/caspio-pricing-proxy/src/utils/field-mapper.js`

**Functions:**
- `mapFieldsForBackwardCompatibility()` - Maps new field names to original API format
- `createProductColorsResponse()` - Formats colors response
- `createColorSwatchesResponse()` - Formats color swatches

**Handles backward compatibility** for existing apps expecting original field names.

---

## 7. KEY API FEATURES & OPTIMIZATIONS

### 7.1 Performance Features
- **Server-side caching** - 5-minute cache on DTG bundle
- **Pagination handling** - `fetchAllCaspioPages` function handles multi-page results
- **Parallel requests** - Uses `Promise.allSettled()` for concurrent API calls
- **Rate limiting** - Built-in express-rate-limit support

### 7.2 Error Handling
- Graceful fallbacks for missing data
- Clear error messages
- Empty arrays returned for "not found" (200 status, not 404)

### 7.3 Data Refresh
All endpoints support `?refresh=true` parameter to bypass cache (where applicable).

---

## 8. CODE EXAMPLES

### 8.1 JavaScript Examples
**File:** `/home/user/caspio-pricing-proxy/examples/javascript/examples.js`

Includes:
- Product search with filters
- Cart session management
- Cart item operations
- Price calculations
- Order creation and tracking

### 8.2 cURL Examples
**File:** `/home/user/caspio-pricing-proxy/examples/curl/examples.sh`

Command-line examples for all endpoints.

---

## 9. CONFIGURATION & ENVIRONMENT

### 9.1 Server Configuration
**File:** `/home/user/caspio-pricing-proxy/config.js`

Key settings:
- Port: 3002 (development) or process.env.PORT
- Caspio domain and credentials
- CORS settings
- Pagination limits
- Token caching
- Timeout values

### 9.2 Environment Variables Required
```
CASPIO_DOMAIN=c0esh141.caspio.com
CASPIO_CLIENT_ID=your_client_id
CASPIO_CLIENT_SECRET=your_client_secret
PORT=3002 (optional)
```

---

## 10. ROUTE REGISTRATION

**File:** `/home/user/caspio-pricing-proxy/server.js` (lines 241-302)

All routes are loaded as modular files:
```
/api → orders, misc, pricing, inventory, products, cart, quotes, pricing-matrix, transfers, art, production-schedules
/api/dtg → dtg-specific routes
```

---

## RECOMMENDED TECH STACK FOR 3-DAY TEES PAGE

Based on existing infrastructure:

**Frontend:**
- HTML/CSS/JavaScript (vanilla or React)
- Fetch API or Axios for API calls

**Backend:**
- Already provided by this Express server

**Components to Build:**

1. **Product Display Component**
   - Use: `/api/dtg/product-bundle?styleNumber=PC54&color=Red`
   - Display colors, main image, product info

2. **Pricing Display**
   - Use: Same DTG bundle response for tier pricing and costs
   - Show price by quantity and location

3. **Order Form**
   - Create cart session: `POST /api/cart-sessions`
   - Add cart items: `POST /api/cart-items`
   - Add size breakdown: `POST /api/cart-item-sizes`

4. **Size Selector**
   - Use: Product details endpoint to get available sizes
   - Use: Size upcharges from pricing bundle

5. **Color Selector**
   - Use: DTG bundle colors array
   - Display: Color swatches from COLOR_SQUARE_IMAGE

---

## PRODUCTION URLS

**Base:** `https://caspio-pricing-proxy-ab30a049961a.herokuapp.com`

Example:
- Products: `https://caspio-pricing-proxy-ab30a049961a.herokuapp.com/api/dtg/product-bundle?styleNumber=PC54&color=Red`
- Pricing: `https://caspio-pricing-proxy-ab30a049961a.herokuapp.com/api/pricing-bundle?method=DTG&styleNumber=PC54`

---

## NEXT STEPS

To build the 3-Day Tees page:

1. Create HTML template with product display area
2. Add color/size selectors using product data APIs
3. Implement quantity input and tier pricing display
4. Add cart functionality using Cart API
5. Create order form with artwork upload support
6. Implement checkout process

All necessary API endpoints and data are already available!
