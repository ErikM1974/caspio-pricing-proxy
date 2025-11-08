# 3-Day Tees Project Requirements Document

**Version:** 1.0
**Date:** November 8, 2025
**Status:** Draft - Pending Approval

---

## Executive Summary

Create a customer-facing "3-Day Tees" web page for fast-turnaround DTG (Direct-to-Garment) printed t-shirts using the PC54 style. The page will allow customers to select colors (based on real-time warehouse inventory), upload artwork, configure their order with print locations, and submit orders that integrate with the ShopWorks OnSite ERP system via ManageOrders.

**Key Differentiator:** 72-hour turnaround with premium pricing (25% markup over standard DTG pricing)

---

## Project Goals

1. **Customer Self-Service:** Enable customers to order custom printed t-shirts without sales rep intervention
2. **Inventory Integration:** Show only in-stock colors from warehouse inventory
3. **Fast Turnaround:** Guarantee 72-hour (3 business days) production time
4. **Order Automation:** Orders automatically flow to ShopWorks OnSite for production
5. **Payment Processing:** Accept payments via Stripe (Phase 2) or manual processing (Phase 1)

---

## Product Specifications

### Product Details
- **Style:** PC54 - Port & Company Essential T-Shirt
- **Decoration Method:** DTG (Direct-to-Garment) printing
- **Turnaround Time:** 72 hours or less (3 business days)
- **Available Sizes:** XS, S, M, L, XL, 2XL, 3XL, 4XL, 5XL, 6XL
- **Colors:** Limited to colors available in warehouse inventory (dynamically filtered)

### Pricing Structure
- **Base Pricing:** Standard DTG pricing from `/api/dtg/product-bundle?styleNumber=PC54`
- **Rush Markup:** 25% premium over standard pricing
- **Pricing Tiers:**
  - Tier 1: 1-23 pieces
  - Tier 2: 24-47 pieces
  - Tier 3: 48-71 pieces
  - Tier 4: 72+ pieces

### Print Locations (DTG)
Based on existing DTG costs endpoint, typical locations include:
- Front Center
- Full Front
- Back Center
- Full Back
- Left Chest
- Right Chest
- Sleeve (Left/Right)

---

## Existing Components (Assets)

### ✅ API Endpoints Available

#### 1. DTG Pricing & Product Bundle
**Endpoint:** `GET /api/dtg/product-bundle?styleNumber=PC54&color={color}`
- **File:** `/home/user/caspio-pricing-proxy/src/routes/dtg.js`
- **Returns:** Product info, all colors, pricing tiers, print location costs, sizes, upcharges
- **Cache:** 1 hour
- **Status:** ✅ Production Ready

#### 2. Inventory Levels (Real-time Stock)
**Endpoint:** `GET /api/manageorders/inventorylevels?PartNumber=PC54`
- **File:** `/home/user/caspio-pricing-proxy/src/routes/manageorders.js`
- **Returns:** On-hand quantities by color/size
- **Cache:** 5 minutes
- **Status:** ✅ Production Ready
- **Critical:** Use this to filter available colors

#### 3. Order Submission (Push to OnSite)
**Endpoint:** `POST /api/manageorders/orders/create`
- **File:** `/home/user/caspio-pricing-proxy/src/routes/manageorders-push.js`
- **Purpose:** Submit order to ManageOrders for auto-import into ShopWorks OnSite
- **Import Frequency:** Hourly (within 60 minutes)
- **Status:** ✅ Production Ready
- **Documentation:** `/home/user/caspio-pricing-proxy/memory/MANAGEORDERS_PUSH_INTEGRATION.md`

#### 4. File Upload (Artwork)
**Endpoint:** `POST /api/files/upload`
- **File:** `/home/user/caspio-pricing-proxy/src/routes/files.js`
- **Supported Types:** PNG, JPG, PDF, AI, PSD, EPS, SVG, ZIP
- **Max Size:** 20MB
- **Status:** ✅ Production Ready

#### 5. Product Details
**Endpoints:**
- `GET /api/product-details?styleNumber=PC54` - Full product info with images
- `GET /api/product-colors?styleNumber=PC54` - All available colors
- **File:** `/home/user/caspio-pricing-proxy/src/routes/products.js`
- **Status:** ✅ Production Ready

### ✅ Reference HTML Pages
- `/home/user/caspio-pricing-proxy/test-quote-integration.html` - Cart/quote testing
- `/home/user/caspio-pricing-proxy/tests/manual/cart-items-test.html` - Complete cart UI example
- `/home/user/caspio-pricing-proxy/tests/manual/api-test.html` - API integration examples

### ✅ Documentation
- **Online Store Developer Guide:** `/home/user/caspio-pricing-proxy/memory/ONLINE_STORE_DEVELOPER_GUIDE.md`
- **ManageOrders PUSH Guide:** `/home/user/caspio-pricing-proxy/memory/MANAGEORDERS_PUSH_INTEGRATION.md`
- **DTG Components Guide:** `/home/user/caspio-pricing-proxy/3DAY_TEES_PAGE_COMPONENTS.md`

---

## Required Components (To Be Built)

### ❌ New Components Needed

#### 1. 3-Day Tees Landing Page (`3day-tees.html`)
**Purpose:** Main customer-facing page for ordering 3-Day Tees

**Location:** `/home/user/caspio-pricing-proxy/3day-tees.html`

**Features:**
- Hero section with "3-Day Tees" branding
- Product showcase (PC54 with imagery)
- Color selector (filtered by inventory)
- Size quantity builder
- Print location selector with pricing preview
- Artwork upload interface
- Customer information form
- Order summary with pricing calculation
- Payment integration (Phase 2: Stripe / Phase 1: Manual)
- Terms and conditions acceptance

**Design Requirements:**
- Mobile-responsive (Bootstrap 5 or Tailwind CSS)
- Modern, clean UI following e-commerce best practices
- Real-time price updates as user configures order
- Progress indicator (Step 1: Product, Step 2: Design, Step 3: Details, Step 4: Payment)
- Image gallery for PC54 (front/back views, color swatches)

#### 2. Rush Pricing Calculator (`rush-pricing-calculator.js`)
**Purpose:** Calculate 25% markup on standard DTG pricing

**Location:** `/home/user/caspio-pricing-proxy/src/utils/rush-pricing-calculator.js`

**Functionality:**
- Take standard DTG pricing from `/api/dtg/product-bundle`
- Apply 25% markup to all tiers
- Apply to decoration costs (print locations)
- Round using existing rounding method from pricing rules
- Return modified pricing structure

**Input:**
```javascript
{
  tiersR: [...],           // Standard tiers
  allDtgCostsR: [...],    // Standard decoration costs
  sizes: [...],           // Size pricing
  sellingPriceDisplayAddOns: {...}  // Upcharges
}
```

**Output:**
```javascript
{
  tiersR: [...],           // Marked up 25%
  allDtgCostsR: [...],    // Marked up 25%
  sizes: [...],           // Marked up 25%
  sellingPriceDisplayAddOns: {...},  // Marked up 25%
  rushMarkupApplied: true,
  rushMarkupPercentage: 25
}
```

#### 3. 3-Day Tees API Endpoint
**Endpoint:** `GET /api/3day-tees/pricing?styleNumber=PC54&color={color}`

**Purpose:** Wrapper endpoint that combines DTG pricing + inventory + 25% markup

**Location:** `/home/user/caspio-pricing-proxy/src/routes/3day-tees.js`

**Functionality:**
1. Fetch DTG product bundle: `/api/dtg/product-bundle?styleNumber=PC54&color={color}`
2. Fetch inventory levels: `/api/manageorders/inventorylevels?PartNumber=PC54`
3. Filter colors to only in-stock items
4. Apply 25% rush markup to pricing
5. Return combined response

**Response:**
```json
{
  "product": {
    "styleNumber": "PC54",
    "brand": "Port & Company",
    "description": "Essential T-Shirt",
    "colors": [...],          // Only in-stock colors
    "sizes": [...]
  },
  "pricing": {
    "tiers": [...],           // With 25% markup
    "printLocations": [...],  // With 25% markup
    "sizeUpcharges": {...},   // With 25% markup
    "rushMarkup": "25%",
    "baseMethod": "DTG"
  },
  "inventory": {
    "inStock": true,
    "availableColors": ["Red", "Navy", "Black", ...],
    "stockLevels": {...}      // Quantities by color/size
  },
  "turnaround": {
    "businessDays": 3,
    "guarantee": "72 hours or less"
  }
}
```

#### 4. Order Submission Handler (`3day-tees-submit.js`)
**Purpose:** Handle form submission, validate, and push to ManageOrders

**Location:** `/home/user/caspio-pricing-proxy/public/js/3day-tees-submit.js` (frontend)

**Functionality:**
1. Validate all form fields
2. Upload artwork files via `/api/files/upload`
3. Format order data for ManageOrders PUSH API
4. Submit order via `POST /api/manageorders/orders/create`
5. Add special note: "3-DAY RUSH ORDER - 72 Hour Turnaround"
6. Display confirmation with order number
7. Send confirmation email (optional)

**Order Payload Structure:**
```json
{
  "orderNumber": "3DAY-{timestamp}",
  "orderDate": "2025-11-08",
  "isTest": false,
  "customer": {
    "firstName": "John",
    "lastName": "Doe",
    "email": "john@example.com",
    "phone": "360-555-1234",
    "company": "ABC Company"
  },
  "shipping": {
    "company": "ABC Company",
    "address1": "123 Main St",
    "city": "Seattle",
    "state": "WA",
    "zip": "98101"
  },
  "lineItems": [
    {
      "partNumber": "PC54",
      "description": "Port & Company Essential Tee - 3-Day Rush",
      "color": "Red",
      "size": "L",
      "quantity": 24,
      "price": 10.63,
      "imageURL": "https://caspio-files-url/artwork.png"
    }
  ],
  "designs": [
    {
      "location": "Front Center",
      "artworkURL": "https://caspio-files-url/artwork.png",
      "width": 12,
      "height": 14
    }
  ],
  "notes": [
    {
      "type": "Production",
      "text": "3-DAY RUSH ORDER - 72 Hour Turnaround - DTG Print"
    }
  ],
  "payments": [
    {
      "method": "Stripe",
      "amount": 255.12,
      "status": "Paid",
      "transactionId": "ch_3xyz123"
    }
  ]
}
```

#### 5. Stripe Payment Integration (Phase 2)
**Purpose:** Accept credit card payments for orders

**Location:** `/home/user/caspio-pricing-proxy/src/routes/payments.js` (new)

**Functionality:**
- **Not Started** - No existing Stripe integration found in codebase
- Create Stripe Checkout session
- Handle payment confirmation
- Update order with payment status
- Handle payment failures and refunds

**Required:**
- Stripe account setup
- API keys configuration
- Webhook endpoint for payment confirmation
- PCI compliance considerations

**Phase 1 Alternative:**
- Accept orders without immediate payment
- Add note: "Payment pending - Sales rep will contact"
- Manual credit card processing by sales team

---

## Technical Architecture

### Frontend Stack
**Recommendation:** Vanilla JavaScript + Bootstrap 5 (consistent with existing test pages)

**Key Libraries:**
- Bootstrap 5 (responsive grid, components)
- Axios (HTTP requests)
- jQuery (optional, if already in use)

**File Structure:**
```
/home/user/caspio-pricing-proxy/
├── 3day-tees.html                    # Main landing page
├── public/
│   ├── css/
│   │   └── 3day-tees.css            # Custom styles
│   └── js/
│       ├── 3day-tees-app.js         # Main application logic
│       ├── 3day-tees-pricing.js     # Pricing calculations
│       └── 3day-tees-submit.js      # Order submission
└── src/
    └── routes/
        └── 3day-tees.js              # Backend API routes
```

### Backend Stack
**Existing:** Node.js + Express.js + PostgreSQL (Caspio)

**New Routes:**
- `GET /api/3day-tees/pricing` - Combined pricing + inventory + markup
- `GET /api/3day-tees/inventory` - Available colors (shortcut to inventory API)
- `POST /api/3day-tees/orders` - Order submission (wrapper around ManageOrders PUSH)
- `POST /api/payments/stripe/create-session` - Stripe checkout (Phase 2)
- `POST /api/payments/stripe/webhook` - Payment confirmation (Phase 2)

### Data Flow

```
┌─────────────────┐
│  Customer       │
│  (Browser)      │
└────────┬────────┘
         │
         │ 1. Load page
         ▼
┌─────────────────────────────────────────────┐
│  3day-tees.html                             │
│  - Product showcase                         │
│  - Color selector (inventory-filtered)      │
│  - Size/quantity builder                    │
│  - Print location selector                  │
│  - Artwork upload                           │
│  - Customer form                            │
│  - Payment (Phase 2)                        │
└────────┬────────────────────────────────────┘
         │
         │ 2. Fetch pricing + inventory
         ▼
┌─────────────────────────────────────────────┐
│  GET /api/3day-tees/pricing                 │
│  - Combine DTG pricing + inventory          │
│  - Apply 25% markup                         │
│  - Filter to in-stock colors                │
└────────┬────────────────────────────────────┘
         │
         │ 3. Display available options
         ▼
┌─────────────────────────────────────────────┐
│  Customer configures order:                 │
│  - Selects color (Red)                      │
│  - Enters quantities (24 pcs)               │
│  - Chooses print location (Front Center)    │
│  - Uploads artwork (logo.png)               │
│  - Fills customer details                   │
└────────┬────────────────────────────────────┘
         │
         │ 4. Upload artwork
         ▼
┌─────────────────────────────────────────────┐
│  POST /api/files/upload                     │
│  - Validate file (type, size)               │
│  - Upload to Caspio Files API               │
│  - Return file URL                          │
└────────┬────────────────────────────────────┘
         │
         │ 5. Submit order
         ▼
┌─────────────────────────────────────────────┐
│  POST /api/manageorders/orders/create       │
│  - Format order data                        │
│  - Add "3-DAY RUSH" note                    │
│  - Push to ManageOrders                     │
│  - Return confirmation                      │
└────────┬────────────────────────────────────┘
         │
         │ 6. Auto-import (hourly)
         ▼
┌─────────────────────────────────────────────┐
│  ShopWorks OnSite ERP                       │
│  - Order appears in Order Entry             │
│  - Production team starts work              │
│  - Ship within 72 hours                     │
└─────────────────────────────────────────────┘
```

---

## User Experience Flow

### Step 1: Product Selection
1. Customer lands on "3-Day Tees" page
2. Sees hero image and product description (PC54)
3. Views available colors (filtered by inventory)
4. Selects desired color(s)

### Step 2: Configuration
1. **Size & Quantity:**
   - Grid of sizes (S, M, L, XL, etc.)
   - Input quantity for each size
   - Real-time total piece count
   - Pricing tier indicator (e.g., "You're in Tier 2: 24-47 pieces")

2. **Print Location:**
   - Visual diagram of t-shirt showing available locations
   - Click to select location(s)
   - Price per location displayed
   - Preview of total decoration cost

3. **Artwork Upload:**
   - Drag-and-drop or click to upload
   - Support multiple files
   - Preview thumbnails
   - File validation (type, size)

### Step 3: Customer Details
1. Contact information form:
   - First Name, Last Name
   - Email, Phone
   - Company Name (optional)

2. Shipping address:
   - Address line 1, 2
   - City, State, ZIP
   - Country (default: USA)

3. Special instructions (optional text area)

### Step 4: Review & Payment
1. **Order Summary:**
   - Product: PC54 - Port & Company Essential Tee
   - Colors and quantities
   - Print locations and costs
   - Subtotal, rush markup (25%), total

2. **Payment (Phase 2):**
   - Stripe checkout embed
   - Credit card fields
   - Submit payment

3. **Payment (Phase 1):**
   - Display total amount due
   - Message: "Our sales team will contact you to process payment"
   - Submit order button

### Step 5: Confirmation
1. Success message with order number
2. Expected ship date (3 business days from today)
3. Confirmation email sent to customer
4. Order automatically in ShopWorks queue

---

## Pricing Calculation Examples

### Example 1: 24 Red T-Shirts, Front Center Print

**Standard DTG Pricing:**
- Tier 2 (24-47 pcs): Base price = $8.50/shirt
- Front Center print: $2.00/shirt
- **Standard Total:** (24 × $8.50) + (24 × $2.00) = $204.00 + $48.00 = **$252.00**

**3-Day Tees Pricing (25% markup):**
- Tier 2: $8.50 × 1.25 = $10.63/shirt
- Front Center: $2.00 × 1.25 = $2.50/shirt
- **Rush Total:** (24 × $10.63) + (24 × $2.50) = $255.12 + $60.00 = **$315.12**

**Rush Premium:** $315.12 - $252.00 = **$63.12** (25% markup)

### Example 2: 72 Navy T-Shirts, Full Front + Back Center

**Standard DTG Pricing:**
- Tier 4 (72+ pcs): Base price = $7.00/shirt
- Full Front: $4.50/shirt
- Back Center: $2.00/shirt
- **Standard Total:** (72 × $7.00) + (72 × $4.50) + (72 × $2.00) = $504 + $324 + $144 = **$972.00**

**3-Day Tees Pricing (25% markup):**
- Tier 4: $7.00 × 1.25 = $8.75/shirt
- Full Front: $4.50 × 1.25 = $5.63/shirt
- Back Center: $2.00 × 1.25 = $2.50/shirt
- **Rush Total:** (72 × $8.75) + (72 × $5.63) + (72 × $2.50) = $630 + $405.36 + $180 = **$1,215.36**

**Rush Premium:** $1,215.36 - $972.00 = **$243.36** (25% markup)

---

## Implementation Phases

### Phase 1: MVP (Minimum Viable Product)
**Goal:** Functional order submission without Stripe integration
**Timeline:** 2-3 days development

**Deliverables:**
1. ✅ 3day-tees.html page with full UI
2. ✅ Inventory-filtered color selector
3. ✅ Size/quantity builder
4. ✅ Print location selector
5. ✅ Artwork upload integration
6. ✅ Customer information form
7. ✅ 25% rush pricing calculator
8. ✅ Order submission to ManageOrders
9. ✅ Order confirmation page
10. ⏸️ Manual payment processing (note added to order)

**Testing Checklist:**
- [ ] Load page and verify PC54 displays correctly
- [ ] Verify only in-stock colors appear
- [ ] Add quantities for multiple sizes
- [ ] Select print location and verify price updates
- [ ] Upload artwork file (test PNG, PDF, AI files)
- [ ] Fill out customer form completely
- [ ] Submit test order (with isTest: true)
- [ ] Verify order appears in ManageOrders
- [ ] Verify order imports into ShopWorks OnSite within 1 hour
- [ ] Test on mobile device (responsive design)

### Phase 2: Stripe Payment Integration
**Goal:** Automated payment processing
**Timeline:** 1-2 days development + Stripe setup

**Deliverables:**
1. ✅ Stripe account setup
2. ✅ Stripe Checkout integration
3. ✅ Payment confirmation webhook
4. ✅ Order status updates based on payment
5. ✅ Payment failure handling
6. ✅ Refund capability (if needed)

**Testing Checklist:**
- [ ] Test successful payment with test card
- [ ] Test declined card
- [ ] Test webhook receives payment confirmation
- [ ] Verify order submitted only after successful payment
- [ ] Test refund process

### Phase 3: Enhancements (Future)
**Potential Features:**
- [ ] Email notifications (order confirmation, shipping updates)
- [ ] SMS notifications
- [ ] Order tracking page (customer self-service)
- [ ] Re-order functionality
- [ ] Bulk pricing discounts
- [ ] Design templates/clipart library
- [ ] Live chat support
- [ ] Customer account system (save addresses, past orders)
- [ ] Rush shipping options (overnight, 2-day)

---

## Technical Specifications

### Browser Compatibility
- Chrome 90+
- Firefox 88+
- Safari 14+
- Edge 90+
- Mobile browsers (iOS Safari 14+, Chrome Android)

### Performance Requirements
- Page load time: < 3 seconds
- API response time: < 500ms (excluding file uploads)
- File upload: Progress indicator for files > 2MB
- Inventory refresh: Every 5 minutes (via cache)

### Security Considerations
- [ ] HTTPS only (already in place on Heroku)
- [ ] Input validation (client-side + server-side)
- [ ] File upload validation (type, size, malware scan)
- [ ] SQL injection prevention (parameterized queries)
- [ ] XSS protection (sanitize user inputs)
- [ ] CSRF tokens (if using sessions)
- [ ] Rate limiting (prevent abuse)
- [ ] PCI compliance (Stripe handles card data)

### Accessibility (WCAG 2.1 AA)
- [ ] Semantic HTML5 elements
- [ ] ARIA labels for interactive elements
- [ ] Keyboard navigation support
- [ ] Color contrast ratios > 4.5:1
- [ ] Alt text for images
- [ ] Form labels and error messages
- [ ] Focus indicators

---

## API Documentation

### New Endpoint: GET /api/3day-tees/pricing

**Purpose:** Fetch PC54 pricing with 25% markup + inventory filtering

**Query Parameters:**
- `styleNumber` (string, required): "PC54"
- `color` (string, optional): Specific color (e.g., "Red")

**Example Request:**
```bash
GET https://caspio-pricing-proxy-ab30a049961a.herokuapp.com/api/3day-tees/pricing?styleNumber=PC54&color=Red
```

**Example Response:**
```json
{
  "success": true,
  "product": {
    "styleNumber": "PC54",
    "brand": "Port & Company",
    "description": "Essential T-Shirt",
    "image_Front_Model": "https://...",
    "image_Back_Model": "https://...",
    "colors": [
      {
        "colorName": "Red",
        "colorSquareImage": "https://...",
        "inStock": true,
        "inventory": {
          "S": 50,
          "M": 120,
          "L": 200,
          "XL": 80,
          "2XL": 40
        }
      }
    ]
  },
  "pricing": {
    "method": "DTG",
    "rushMarkup": 0.25,
    "tiers": [
      {
        "minQuantity": 1,
        "maxQuantity": 23,
        "marginDenominator": 0.6,
        "displayName": "1-23 pcs"
      },
      {
        "minQuantity": 24,
        "maxQuantity": 47,
        "marginDenominator": 0.6,
        "displayName": "24-47 pcs"
      }
    ],
    "printLocations": [
      {
        "locationName": "Front Center",
        "cost": 2.50,
        "originalCost": 2.00,
        "markup": "25%"
      },
      {
        "locationName": "Full Front",
        "cost": 5.63,
        "originalCost": 4.50,
        "markup": "25%"
      }
    ],
    "sizes": [
      {
        "sizeName": "S",
        "basePrice": 10.63,
        "originalPrice": 8.50,
        "upcharge": 0
      },
      {
        "sizeName": "M",
        "basePrice": 10.63,
        "originalPrice": 8.50,
        "upcharge": 0
      },
      {
        "sizeName": "3XL",
        "basePrice": 12.50,
        "originalPrice": 10.00,
        "upcharge": 1.88
      }
    ]
  },
  "turnaround": {
    "businessDays": 3,
    "guarantee": "Ships within 72 hours"
  },
  "cached": true,
  "cacheDate": "2025-11-08T10:30:00Z"
}
```

---

## Testing Strategy

### Unit Tests
- Rush pricing calculator (25% markup accuracy)
- Inventory filtering logic
- Order payload formatter
- Form validation functions

### Integration Tests
- DTG pricing API + inventory API combination
- File upload → URL retrieval
- Order submission → ManageOrders confirmation
- Stripe payment → order creation

### User Acceptance Testing (UAT)
**Test Scenarios:**
1. Customer orders 24 red shirts with front logo
2. Customer orders mixed sizes (12 S, 24 M, 12 L)
3. Customer uploads multiple artwork files
4. Customer on mobile device completes order
5. Customer with international shipping address
6. Customer attempts invalid file upload (too large, wrong type)
7. Customer leaves required fields blank (validation)
8. Customer's selected color goes out of stock (edge case)

### Load Testing
- Concurrent users: 50 simultaneous orders
- File uploads: 10 concurrent uploads of 5MB files
- Inventory API: 100 requests/minute (verify caching)

---

## Deployment Plan

### Development Environment
- **URL:** http://[WSL-IP]:3002/3day-tees.html
- **Server:** Local Node.js on WSL
- **Database:** Caspio (production tables, test flag enabled)
- **Testing:** Use `isTest: true` in order submissions

### Staging Environment (Optional)
- **URL:** TBD (if separate Heroku app needed)
- **Purpose:** Client preview and UAT

### Production Environment
- **URL:** https://caspio-pricing-proxy-ab30a049961a.herokuapp.com/3day-tees.html
- **Server:** Heroku (existing app)
- **Deployment Method:** Git push to heroku/main branch
- **Monitoring:** Heroku logs, error tracking
- **Rollback Plan:** Git revert + redeploy

### Deployment Steps
1. ✅ Develop and test locally on WSL
2. ✅ Commit to branch: `claude/create-3day-tees-page-011CUvWDTfjf81za5gS18SMH`
3. ✅ Push to GitHub
4. ✅ Create Pull Request for review
5. ✅ Merge to `main` branch after approval
6. ✅ Deploy to Heroku: `git push heroku main`
7. ✅ Verify production URL loads correctly
8. ✅ Run production smoke tests
9. ✅ Monitor logs for errors
10. ✅ Notify stakeholders of go-live

---

## Risks and Mitigations

### Risk 1: Inventory Data Stale or Incorrect
**Impact:** Customer orders color that's out of stock
**Likelihood:** Medium
**Mitigation:**
- Use 5-minute cache on inventory API
- Add real-time inventory check during order submission
- Display warning if stock is low (< 10 units)
- Implement "Reserve stock" functionality (Phase 3)

### Risk 2: File Upload Fails or Corrupted
**Impact:** Order submitted without artwork
**Likelihood:** Low
**Mitigation:**
- Client-side file validation before upload
- Server-side validation (mime type, file size)
- Retry logic on upload failure
- Require successful upload before order submission
- Store file URL in order record for verification

### Risk 3: Pricing Calculation Error
**Impact:** Customer charged incorrect amount
**Likelihood:** Low
**Mitigation:**
- Extensive unit tests on pricing calculator
- Display itemized pricing breakdown to customer
- Log all pricing calculations server-side
- Manual review of first 10 production orders

### Risk 4: ManageOrders API Downtime
**Impact:** Orders not submitted to OnSite
**Likelihood:** Low
**Mitigation:**
- Queue failed orders for retry
- Email notification to admin on failure
- Display error message to customer with contact info
- Manual order entry as backup process

### Risk 5: Stripe Payment Issues (Phase 2)
**Impact:** Customer can't complete payment
**Likelihood:** Medium
**Mitigation:**
- Test Stripe integration thoroughly in test mode
- Provide alternative payment method (call sales rep)
- Clear error messages for payment failures
- Webhook to handle async payment confirmations

### Risk 6: Mobile Responsiveness Issues
**Impact:** Poor user experience on mobile devices
**Likelihood:** Medium
**Mitigation:**
- Use Bootstrap 5 responsive grid
- Test on multiple device sizes (phone, tablet)
- Simplify form for mobile (fewer fields per page)
- Touch-friendly buttons and inputs (min 44px)

---

## Success Metrics (KPIs)

### Primary Metrics
1. **Conversion Rate:** % of page visitors who complete an order
   - **Target:** > 15%
2. **Average Order Value (AOV):** Average $ per order
   - **Target:** > $300
3. **Orders Per Week:** Number of 3-Day Tees orders
   - **Target:** > 10 orders/week
4. **Cart Abandonment Rate:** % who start but don't complete order
   - **Target:** < 50%

### Secondary Metrics
5. **Page Load Time:** Time to interactive
   - **Target:** < 3 seconds
6. **Mobile vs Desktop:** % of orders from mobile
   - **Target:** > 30% mobile
7. **File Upload Success Rate:** % of successful artwork uploads
   - **Target:** > 95%
8. **Order Submission Success Rate:** % of orders that reach OnSite
   - **Target:** > 99%
9. **Payment Success Rate (Phase 2):** % of successful Stripe payments
   - **Target:** > 90%
10. **Customer Satisfaction (CSAT):** Post-order survey score
    - **Target:** > 4.5/5

### Business Metrics
11. **Revenue from 3-Day Tees:** Total sales
12. **Profit Margin:** After 25% markup vs production costs
13. **Repeat Customer Rate:** % who order again
14. **Sales Rep Time Saved:** Hours not spent on manual orders

---

## Maintenance and Support

### Ongoing Maintenance
- **Inventory Sync:** Monitor cache effectiveness (5-minute refresh)
- **API Monitoring:** Uptime checks on critical endpoints
- **Error Logging:** Review server logs weekly for issues
- **Performance Monitoring:** Page load times, API response times
- **Security Updates:** Keep dependencies updated (npm audit)

### Customer Support
- **FAQ Section:** Add to 3-Day Tees page
- **Contact Form:** For questions before ordering
- **Order Status:** Email confirmation with tracking info
- **Issue Resolution:** Sales rep contact info on confirmation page

### Documentation Updates
- Update API documentation when endpoints change
- Maintain changelog for version tracking
- Update this requirements doc as features evolve

---

## Open Questions & Clarifications Needed

### 1. Color Inventory Filtering
**Question:** Should the page show ALL PC54 colors with "Out of Stock" badges, or ONLY show in-stock colors?

**Options:**
- **A:** Show only in-stock colors (cleaner, simpler UX)
- **B:** Show all colors, mark out-of-stock (helps customer see full range)

**Recommendation:** Option A (only in-stock) for MVP, add Option B in Phase 3

---

### 2. Multiple Color Orders
**Question:** Can a customer order multiple colors in a single order (e.g., 12 red + 12 navy)?

**Options:**
- **A:** Single color per order (simpler implementation)
- **B:** Multiple colors allowed (more flexible, better UX)

**Current Assumption:** Single color per order for MVP

---

### 3. Minimum Order Quantity
**Question:** Is there a minimum number of shirts required for 3-Day Tees?

**Examples:**
- No minimum (even 1 shirt gets rush service)
- Minimum 12 pieces
- Minimum 24 pieces (Tier 2+)

**Current Assumption:** No minimum, follow standard tier pricing (1-23 pcs = Tier 1)

---

### 4. Rush Order Identification in OnSite
**Question:** How should production team identify rush orders in ShopWorks OnSite?

**Options:**
- **A:** Special note: "3-DAY RUSH ORDER - Priority Production"
- **B:** Order number prefix: "3DAY-12345"
- **C:** Both note and prefix
- **D:** Special customer field or flag

**Current Assumption:** Both note and prefix (Option C)

---

### 5. Payment Timing (Phase 1 MVP)
**Question:** Without Stripe integration, when/how is payment collected?

**Options:**
- **A:** Sales rep calls customer after order submitted
- **B:** Customer calls sales rep (number provided on confirmation page)
- **C:** Email invoice sent automatically (requires invoice generation)
- **D:** Order held until payment received (manual release to production)

**Current Assumption:** Option A (sales rep follows up)

---

### 6. Artwork Requirements & Validation
**Question:** Are there specific artwork requirements (resolution, file type, color mode)?

**Examples:**
- Minimum resolution: 300 DPI
- Preferred formats: Vector (AI, EPS, PDF) or high-res PNG
- Color mode: RGB for DTG
- Design size limits: Max 16" x 20"

**Current Assumption:** Accept all common formats, provide guidelines on page

---

### 7. Price Display During Configuration
**Question:** Should pricing update in real-time as customer configures order, or only show at final review?

**Options:**
- **A:** Live pricing (updates as they select options)
- **B:** Show pricing at review step only
- **C:** Hybrid (show tier pricing, calculate total at end)

**Recommendation:** Option A (live pricing for transparency)

---

### 8. Shipping Cost
**Question:** Is shipping cost included in the 3-Day Tees price, or added separately?

**Options:**
- **A:** Free shipping (included in rush markup)
- **B:** Standard shipping rates apply (added to total)
- **C:** Rush shipping required (overnight/2-day, added to total)

**Current Assumption:** To be clarified (critical for pricing display)

---

### 9. Design Proof Approval
**Question:** Does customer receive a proof for approval before production, or is it "as submitted"?

**Options:**
- **A:** No proof (customer's artwork used as-is, faster turnaround)
- **B:** Digital proof sent for approval (adds time, may exceed 72hr)
- **C:** Hybrid (proof only if artwork has issues)

**Impact on 72hr guarantee:** Proof approval could delay turnaround

**Current Assumption:** Option A (no proof) to meet 72hr guarantee

---

### 10. Return/Refund Policy
**Question:** What is the return policy for custom rush orders?

**Options:**
- **A:** No returns (custom printed items)
- **B:** Returns only for defects/errors (not customer's artwork issues)
- **C:** Standard return policy applies

**Current Assumption:** Option B (defects only)

---

### 11. Brand/Logo Display
**Question:** Should the page display Northwest Custom Apparel branding, or is it white-labeled?

**Current Assumption:** Display NWCA logo and contact info

---

### 12. Analytics & Tracking
**Question:** Should we add Google Analytics, Facebook Pixel, or other tracking for marketing?

**Current Assumption:** Add Google Analytics (if account available)

---

## Approval & Sign-Off

### Document Review
- [ ] Product Owner / Project Sponsor
- [ ] Lead Developer (Claude)
- [ ] Sales/Customer Service Representative
- [ ] Production/Operations Manager

### Approval
**Approved by:** ___________________________
**Date:** ___________________________
**Signature:** ___________________________

---

## Appendix

### A. Related Documentation
- **Online Store Developer Guide:** `/memory/ONLINE_STORE_DEVELOPER_GUIDE.md`
- **ManageOrders PUSH Guide:** `/memory/MANAGEORDERS_PUSH_INTEGRATION.md`
- **ManageOrders Integration Guide:** `/memory/MANAGEORDERS_INTEGRATION.md`
- **DTG Components Guide:** `/3DAY_TEES_PAGE_COMPONENTS.md`
- **API Changelog:** `/memory/API_CHANGELOG.md`

### B. API Base URLs
- **Production:** `https://caspio-pricing-proxy-ab30a049961a.herokuapp.com`
- **Local (WSL):** `http://[WSL-IP]:3002`

### C. Key Contact Information
- **Developer:** Claude (AI Agent)
- **Project Owner:** Erik (User)
- **Server Environment:** Heroku + WSL (Windows Subsystem for Linux)

### D. Technology Stack Summary
- **Backend:** Node.js 18+, Express.js 4.x
- **Database:** Caspio (PostgreSQL-based cloud DB)
- **Frontend:** HTML5, CSS3, JavaScript ES6+, Bootstrap 5
- **File Storage:** Caspio Files API v3
- **ERP Integration:** ShopWorks OnSite via ManageOrders API
- **Payment (Phase 2):** Stripe Checkout
- **Hosting:** Heroku (caspio-pricing-proxy app)
- **Version Control:** Git + GitHub

### E. Revision History
| Version | Date | Author | Changes |
|---------|------|--------|---------|
| 1.0 | 2025-11-08 | Claude | Initial requirements document |

---

**End of Requirements Document**
