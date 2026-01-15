# ManageOrders PUSH API - Complete Template Guide

**Version:** 1.0.0
**Created:** January 11, 2026
**Purpose:** Master template for creating ManageOrders PUSH integrations from ANY source

---

## Quick Start

```javascript
// Minimum viable order - just these fields required
const order = {
  orderNumber: "12345",
  customer: { firstName: "John", lastName: "Doe" },
  lineItems: [{ partNumber: "PC54", quantity: 12 }]
};

// POST to create order
fetch('https://caspio-pricing-proxy-ab30a049961a.herokuapp.com/api/manageorders/orders/create', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(order)
});
```

---

## Table of Contents

1. [API Endpoints](#api-endpoints)
2. [Complete Order Schema](#complete-order-schema)
3. [Field Reference](#field-reference)
4. [Size Translation](#size-translation)
5. [Note Types](#note-types)
6. [Critical Patterns](#critical-patterns)
7. [Code Templates](#code-templates)
8. [Troubleshooting](#troubleshooting)
9. [Quick Reference Card](#quick-reference-card)

---

## API Endpoints

### Base URL
```
Production: https://caspio-pricing-proxy-ab30a049961a.herokuapp.com
Local:      http://localhost:3002
```

### Order Endpoints

| Method | Endpoint | Purpose |
|--------|----------|---------|
| POST | `/api/manageorders/orders/create` | Create new order |
| GET | `/api/manageorders/orders/verify/:extOrderId` | Verify order received |
| POST | `/api/manageorders/auth/test` | Test authentication |
| GET | `/api/manageorders/push/health` | Health check |

### Tracking Endpoints

| Method | Endpoint | Purpose |
|--------|----------|---------|
| POST | `/api/manageorders/tracking/push` | Push tracking numbers |
| GET | `/api/manageorders/tracking/pull` | Pull tracking by date |
| GET | `/api/manageorders/tracking/verify/:extOrderId` | Verify tracking |

---

## Complete Order Schema

### Full Structure (ExternalOrderJson)

```javascript
{
  // ═══════════════════════════════════════════════════════════════
  // ORDER-LEVEL FIELDS
  // ═══════════════════════════════════════════════════════════════

  orderNumber: "12345",                    // REQUIRED - Your order ID
  orderDate: "2026-01-11",                 // YYYY-MM-DD (auto-converts to MM/DD/YYYY)
  requestedShipDate: "2026-01-15",         // Optional - requested ship date
  dropDeadDate: "2026-01-20",              // Optional - hard deadline
  isTest: false,                           // If true, adds "TEST-" prefix

  // Optional order fields
  terms: "Prepaid",                        // "Prepaid", "Net 10", "Net 30", etc.
  salesRep: "erik@nwcustomapparel.com",    // Sales representative email
  customerPurchaseOrder: "PO-2026-001",    // Customer's PO number

  // Financial (optional)
  taxTotal: 12.50,                         // Tax amount (OnSite usually calculates)
  taxPartNumber: "WATAX",                  // Tax line item part number
  taxPartDescription: "WA Sales Tax",      // Tax line item description
  totalDiscounts: 10.00,                   // Discount total
  discountPartNumber: "DISCOUNT",          // Discount line item part number
  discountPartDescription: "10% off",      // Discount description
  cur_Shipping: 15.00,                     // Shipping cost

  // Status IDs (optional - OnSite usually sets these)
  salesStatus: 0,
  receivingStatus: 0,
  shippingStatus: 0,

  // ═══════════════════════════════════════════════════════════════
  // CUSTOMER OBJECT - REQUIRED
  // ═══════════════════════════════════════════════════════════════

  customer: {
    // Required
    firstName: "John",                     // REQUIRED
    lastName: "Doe",                       // REQUIRED

    // Contact (optional)
    email: "john@example.com",
    phone: "360-555-1234",
    company: "ABC Company",
    website: "https://abccompany.com",

    // Tax info (optional)
    taxExempt: "Y",                        // "Y" or "N"
    taxExemptNumber: "EX-12345",

    // Business classification (optional)
    source: "Website",                     // How they found you
    type: "Corporate",                     // Customer type
    salesGroup: "Northwest",               // Sales territory

    // Notes (optional)
    invoiceNotes: "Net 30 terms approved",
    reminderNotes: "Send reminder 7 days before due",

    // Custom fields (optional)
    customField01: "",
    customField02: "",
    customField03: "",
    customField04: "",
    customField05: "",
    customField06: "",
    customDateField01: "",                 // Date fields
    customDateField02: "",
    customDateField03: "",
    customDateField04: ""
  },

  // ═══════════════════════════════════════════════════════════════
  // BILLING ADDRESS (Optional)
  // ═══════════════════════════════════════════════════════════════

  billing: {
    company: "ABC Company",
    address1: "123 Main St",
    address2: "Suite 400",
    city: "Seattle",
    state: "WA",
    zip: "98101",
    country: "USA"
  },

  // ═══════════════════════════════════════════════════════════════
  // SHIPPING ADDRESS (Optional but recommended)
  // ═══════════════════════════════════════════════════════════════

  shipping: {
    company: "ABC Company Warehouse",
    address1: "456 Oak Ave",
    address2: "Building B",
    city: "Tacoma",
    state: "WA",
    zip: "98402",
    country: "USA",
    method: "UPS Ground"                   // Shipping method
  },

  // ═══════════════════════════════════════════════════════════════
  // LINE ITEMS - REQUIRED (at least 1)
  // ═══════════════════════════════════════════════════════════════

  lineItems: [
    {
      // Required
      partNumber: "PC54",                  // REQUIRED - Product part number
      quantity: 12,                        // REQUIRED - Must be > 0

      // Product details (optional)
      description: "Port & Company Core Cotton Tee",
      color: "Red",
      size: "Large",                       // Auto-translated (see Size Translation)
      price: 8.50,                         // Unit price

      // Display overrides (optional)
      displayPartNumber: "TEAM-TEE",       // Override on invoice
      displayDescription: "Team T-Shirt",  // Override on invoice

      // Personalization (optional)
      playerName: {
        first: "Mike",
        last: "Smith"
      },

      // Notes (optional)
      notes: "Customer requested specific shade",
      workOrderNotes: "Rush production",

      // Custom fields (optional)
      customField01: "",
      customField02: "",
      customField03: "",
      customField04: "",
      customField05: "",

      // Design linking (optional)
      extDesignIdBlock: "DESIGN-1",        // Links to Designs.ExtDesignID
      designIdBlock: "12345"               // Links to OnSite design ID
    }
  ],

  // ═══════════════════════════════════════════════════════════════
  // DESIGNS (Optional)
  // ═══════════════════════════════════════════════════════════════

  designs: [
    {
      name: "Team Logo",                   // Design name
      externalId: "DESIGN-1",              // Your design ID (for linking)
      idDesign: 0,                         // Existing OnSite design ID (if known)
      designTypeId: 3,                     // Design type ID
      artistId: 224,                       // Artist employee ID
      productColor: "Red",                 // For color-specific designs
      vendorId: "",                        // Vendor's design ID

      // Custom fields (optional)
      customField01: "",
      customField02: "",
      customField03: "",
      customField04: "",
      customField05: "",

      // Locations array
      locations: [
        {
          location: "Left Chest",          // Body location
          colors: "2",                     // Number of ink colors
          flashes: "",                     // Flashes (screen print)
          stitches: "8500",                // Stitch count (embroidery)
          code: "",                        // Secondary design code
          imageUrl: "https://...",         // Thumbnail URL (max 2MB)
          notes: "3 inch logo",            // Location-specific notes

          // Custom fields (optional)
          customField01: "",
          customField02: "",
          customField03: "",
          customField04: "",
          customField05: "",

          // Location details (for thread colors, etc.)
          details: [
            {
              color: "Navy Blue",          // Ink/thread color
              threadBreak: "",             // Thread break description
              paramLabel: "",              // Digital print parameter
              paramValue: "",              // Digital print value
              text: ""                     // Text for text designs
            }
          ]
        }
      ]
    }
  ],

  // ═══════════════════════════════════════════════════════════════
  // PAYMENTS (Optional)
  // ═══════════════════════════════════════════════════════════════

  payments: [
    {
      date: "2026-01-11",                  // Payment date (YYYY-MM-DD)
      amount: 102.00,                      // Payment amount
      status: "success",                   // MUST be "success" to record
      gateway: "Stripe",                   // Payment gateway
      authCode: "ch_abc123",               // Authorization code
      accountNumber: "****1234",           // Last 4 digits
      cardCompany: "Visa",                 // Card type
      responseCode: "1",                   // Gateway response
      reasonCode: "",                      // Reason code
      reasonText: "",                      // Reason text
      feeOther: 0,                         // Other fees
      feeProcessing: 2.95                  // Processing fees
    }
  ],

  // ═══════════════════════════════════════════════════════════════
  // NOTES (Optional)
  // ═══════════════════════════════════════════════════════════════

  notes: [
    {
      type: "Notes On Order",              // See Note Types section
      text: "Customer requested rush production"
    },
    {
      type: "Notes To Production",
      text: "Use PMS 286 blue"
    }
  ],

  // ═══════════════════════════════════════════════════════════════
  // FILE UPLOADS (Optional)
  // ═══════════════════════════════════════════════════════════════

  files: [
    {
      fileName: "logo.ai",                 // File name
      fileData: "data:application/...;base64,...",  // Base64 encoded
      category: "artwork",                 // "artwork" or "document"
      decorationLocation: "Left Chest",    // For artwork files
      description: "Vector logo file"      // Description
    }
  ],

  // ═══════════════════════════════════════════════════════════════
  // DIRECT ATTACHMENTS (Alternative to file uploads)
  // ═══════════════════════════════════════════════════════════════

  attachments: [
    {
      mediaUrl: "https://...",             // Direct URL to file
      mediaName: "logo.png",               // File name
      linkUrl: "",                         // External link (if Link=1)
      linkNote: "Company logo",            // Description
      link: 0                              // 0=media file, 1=external link
    }
  ]
}
```

---

## Field Reference

### Required vs Optional

| Field | Required | Default |
|-------|----------|---------|
| `orderNumber` | ✅ YES | - |
| `customer.firstName` | ✅ YES | - |
| `customer.lastName` | ✅ YES | - |
| `lineItems[]` | ✅ YES (1+) | - |
| `lineItems[].partNumber` | ✅ YES | - |
| `lineItems[].quantity` | ✅ YES | - |
| `orderDate` | No | Today |
| `customer.email` | No | '' |
| `shipping` | No | null |
| `designs` | No | [] |
| `payments` | No | [] |
| `notes` | No | [] |

### Field Transformation (Your Input → ManageOrders API)

```
Your Input                    ManageOrders API
──────────────────────────────────────────────────────────────
orderNumber                → ExtOrderID (with NWCA- prefix)
orderDate                  → date_OrderPlaced (MM/DD/YYYY)
requestedShipDate          → date_OrderRequestedToShip
customer.firstName         → ContactNameFirst
customer.lastName          → ContactNameLast
customer.email             → ContactEmail
customer.phone             → ContactPhone
customer.company           → Customer.CompanyName
billing.address1           → Customer.BillingAddress01
shipping.address1          → ShippingAddresses[].ShipAddress01
lineItems[].partNumber     → LinesOE[].PartNumber
lineItems[].size           → LinesOE[].Size (translated)
lineItems[].quantity       → LinesOE[].Qty
payments[].status          → Payments[].Status
notes[].type               → Notes[].Type
notes[].text               → Notes[].Note
```

---

## Size Translation

### How It Works

1. You send: `"size": "Large"` or `"size": "3XL"` or `"size": "YM"`
2. Proxy normalizes: `"Large"` → `"L"`, `"3XL"` → `"3XL"`, `"YM"` → `"YM"`
3. OnSite maps to inventory column via Size Translation Table

### Complete Size Mapping (90+ supported)

#### Standard Sizes
| Input Variations | Normalized |
|-----------------|------------|
| S, SM, Small, SMALL | S |
| M, MD, Medium, MEDIUM | M |
| L, LG, Large, LARGE | L |
| XL, X-Large, X-LARGE, XLarge, 1XL | XL |

#### Extended Sizes
| Input Variations | Normalized |
|-----------------|------------|
| 2XL, 2X, XX-Large, XX-LARGE | 2XL |
| XXL | XXL |
| 3XL, XXXL, 3X, XXX-Large | 3XL |
| 4XL, XXXXL, 4X | 4XL |
| 5XL, XXXXXL, 5X | 5XL |
| 6XL, XXXXXXL, 6X | 6XL |
| 7XL, 8XL, 9XL, 10XL | 7XL-10XL |

#### Small Sizes
| Input Variations | Normalized |
|-----------------|------------|
| XS, X-Small, X-SMALL, Extra Small | XS |
| XXS | XXS |
| 2XS | 2XS |

#### One Size
| Input Variations | Normalized |
|-----------------|------------|
| OSFA, OS, One Size, ONE SIZE | OSFA |

#### Tall Sizes
| Input | Normalized | Modifier |
|-------|------------|----------|
| ST | ST | _ST |
| MT | MT | _MT |
| LT | LT | _LT |
| XLT | XLT | _XLT |
| 2XLT | 2XLT | _2XLT |
| 3XLT | 3XLT | _3XLT |
| 4XLT | 4XLT | _4XLT |
| XST | XST | _XST |

#### Youth Sizes
| Input | Normalized | Modifier |
|-------|------------|----------|
| YXS | YXS | _YXS |
| YS | YS | _YS |
| YM | YM | _YM |
| YL | YL | _YL |
| YXL | YXL | _YXL |

#### Toddler Sizes
| Input | Normalized |
|-------|------------|
| 2T | 2T |
| 3T | 3T |
| 4T | 4T |
| 5T | 5T |
| 6T | 6T |
| 5/6T | 5/6T |

#### Flex-Fit Cap Sizes
| Input | Normalized |
|-------|------------|
| S/M | S/M |
| L/XL | L/XL |
| XS/S | XS/S |
| M/L | M/L |
| X/2X | X/2X |
| S/XL | S/XL |

### Unmapped Sizes

If a size isn't in the mapping, it passes through as-is. OnSite will map it to "Other XXXL" column.

---

## Note Types

### Valid Note Types (9 total)

| Type | Department | Use Case |
|------|------------|----------|
| `"Notes On Order"` | General | Order-wide notes, customer requests |
| `"Notes To Art"` | Art Dept | Design instructions, colors, revisions |
| `"Notes To Purchasing"` | Purchasing | Vendor info, special orders |
| `"Notes To Subcontract"` | Subcontract | Instructions for subcontractors |
| `"Notes To Production"` | Production | Production instructions, PMS colors |
| `"Notes To Receiving"` | Receiving | Incoming shipment notes |
| `"Notes To Shipping"` | Shipping | Shipping instructions, split shipments |
| `"Notes To Accounting"` | Accounting | Billing notes, payment terms |
| `"Notes On Customer"` | Customer Record | Only for NEW customer creation |

### Examples

```javascript
notes: [
  {
    type: "Notes On Order",
    text: "Customer requested rush production - ship by Friday"
  },
  {
    type: "Notes To Production",
    text: "Use PMS 286 blue, customer approved proof on 1/10/26"
  },
  {
    type: "Notes To Shipping",
    text: "Split shipment - 50% to warehouse, 50% to HQ"
  },
  {
    type: "Notes To Art",
    text: "Logo needs to be vectorized - customer sent JPG only"
  }
]
```

---

## Critical Patterns

### 1. Date Format Conversion

**You send:** `YYYY-MM-DD` (ISO format)
**API converts to:** `MM/DD/YYYY` (OnSite format)

```javascript
// You send
{ orderDate: "2026-01-11" }

// API transforms to
{ date_OrderPlaced: "01/11/2026" }
```

### 2. Payment Status MUST be "success"

```javascript
// CORRECT - Payment will be recorded
payments: [{ status: "success", amount: 100.00, ... }]

// WRONG - Payment will NOT be recorded
payments: [{ status: "pending", amount: 100.00, ... }]
```

### 3. Tax Flags (Python Inksoft Pattern)

If you need tax calculation on line items, set these 5 flags:

```javascript
// For each line item (Python Inksoft does this automatically)
{
  sts_EnableTax01: 1,
  sts_EnableTax02: 1,
  sts_EnableTax03: 1,
  sts_EnableTax04: 1,
  sts_TaxOverride: 1
}
```

Note: The caspio-pricing-proxy does NOT set these flags - it relies on OnSite's configuration.

### 4. Gift Certificate Handling (Python Inksoft Pattern)

Gift certificates should NOT go in Payments array (routes to wrong GL account).

**Recommended approach:**
```javascript
notes: [
  {
    type: "Notes On Order",
    text: "Gift Certificate Applied: $125.51"
  }
]
```

### 5. id_Integration (For Custom Integrations)

If building a Python Inksoft-style integration with per-store configs:

```python
# Every store MUST have valid id_Integration
# Without it, ALL items default to Adult/S column
STORE_CONFIGS = {
  "arrow-lumber": {
    "id_Customer": 1821,
    "id_Integration": 131,  # CRITICAL - from ShopWorks Tools > Config > Order API Integrations
    ...
  }
}
```

### 6. ExtOrderID Format

**Your input:** `"orderNumber": "12345"`
**Generated:** `"ExtOrderID": "NWCA-12345"`

**Test orders:** `"isTest": true` → `"ExtOrderID": "NWCA-TEST-12345"`

---

## Code Templates

### JavaScript (Browser)

```javascript
async function createOrder(orderData) {
  try {
    const response = await fetch(
      'https://caspio-pricing-proxy-ab30a049961a.herokuapp.com/api/manageorders/orders/create',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(orderData)
      }
    );

    const result = await response.json();

    if (result.success) {
      console.log('Order created:', result.extOrderId);
      console.log('OnSite import expected:', result.onsiteImportExpected);
      return result;
    } else {
      throw new Error(result.error);
    }
  } catch (error) {
    console.error('Order creation failed:', error);
    throw error;
  }
}

// Usage
const order = {
  orderNumber: "12345",
  customer: { firstName: "John", lastName: "Doe", email: "john@example.com" },
  lineItems: [{ partNumber: "PC54", color: "Red", size: "L", quantity: 12, price: 8.50 }],
  shipping: { address1: "123 Main St", city: "Seattle", state: "WA", zip: "98101" }
};

createOrder(order).then(result => {
  // Order created successfully
});
```

### Node.js (Server)

```javascript
const axios = require('axios');

async function pushOrderToOnSite(orderData) {
  const response = await axios.post(
    'https://caspio-pricing-proxy-ab30a049961a.herokuapp.com/api/manageorders/orders/create',
    orderData,
    {
      headers: { 'Content-Type': 'application/json' },
      timeout: 30000
    }
  );

  return response.data;
}

// With tracking
async function pushTrackingToOnSite(trackingData) {
  const response = await axios.post(
    'https://caspio-pricing-proxy-ab30a049961a.herokuapp.com/api/manageorders/tracking/push',
    trackingData,
    {
      headers: { 'Content-Type': 'application/json' },
      timeout: 30000
    }
  );

  return response.data;
}
```

### PHP

```php
<?php
function createOrder($orderData) {
    $url = 'https://caspio-pricing-proxy-ab30a049961a.herokuapp.com/api/manageorders/orders/create';

    $ch = curl_init($url);
    curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
    curl_setopt($ch, CURLOPT_POST, true);
    curl_setopt($ch, CURLOPT_POSTFIELDS, json_encode($orderData));
    curl_setopt($ch, CURLOPT_HTTPHEADER, ['Content-Type: application/json']);
    curl_setopt($ch, CURLOPT_TIMEOUT, 30);

    $response = curl_exec($ch);
    $httpCode = curl_getinfo($ch, CURLINFO_HTTP_CODE);
    curl_close($ch);

    $result = json_decode($response, true);

    if ($httpCode === 200 && $result['success']) {
        return $result;
    } else {
        throw new Exception($result['error'] ?? 'Unknown error');
    }
}
?>
```

### cURL

```bash
# Create order
curl -X POST https://caspio-pricing-proxy-ab30a049961a.herokuapp.com/api/manageorders/orders/create \
  -H "Content-Type: application/json" \
  -d '{
    "orderNumber": "12345",
    "orderDate": "2026-01-11",
    "customer": {
      "firstName": "John",
      "lastName": "Doe",
      "email": "john@example.com"
    },
    "lineItems": [
      {
        "partNumber": "PC54",
        "description": "Port & Company Tee",
        "color": "Red",
        "size": "L",
        "quantity": 12,
        "price": 8.50
      }
    ],
    "shipping": {
      "address1": "123 Main St",
      "city": "Seattle",
      "state": "WA",
      "zip": "98101"
    }
  }'

# Verify order
curl https://caspio-pricing-proxy-ab30a049961a.herokuapp.com/api/manageorders/orders/verify/NWCA-12345

# Push tracking
curl -X POST https://caspio-pricing-proxy-ab30a049961a.herokuapp.com/api/manageorders/tracking/push \
  -H "Content-Type: application/json" \
  -d '{
    "extOrderId": "NWCA-12345",
    "trackingNumber": "1Z999AA10123456784",
    "shippingMethod": "UPS Ground"
  }'

# Test authentication
curl -X POST https://caspio-pricing-proxy-ab30a049961a.herokuapp.com/api/manageorders/auth/test
```

---

## Troubleshooting

### Issue: "Authentication failed"

**Cause:** Invalid/expired credentials
**Solution:**
1. Check `MANAGEORDERS_USERNAME` and `MANAGEORDERS_PASSWORD` env vars
2. Test: `POST /api/manageorders/auth/test`
3. Contact ShopWorks support if credentials invalid

### Issue: "Invalid size: 'XXX' not in size mapping"

**Cause:** Size not recognized
**Solution:**
1. Check [Size Translation](#size-translation) table
2. Use supported size values
3. Or add to `config/manageorders-push-config.js`

### Issue: Order not appearing in OnSite

**Causes:**
1. Hourly import delay (wait up to 1 hour)
2. Order push failed (check logs)
3. APISource filter in OnSite

**Solutions:**
1. Wait for next hourly import
2. Verify: `GET /api/manageorders/orders/verify/:extOrderId`
3. Check OnSite ManageOrders settings

### Issue: "No response from ManageOrders API"

**Cause:** Network/API down
**Solution:**
1. Check internet connection
2. Test: `curl https://manageordersapi.com/onsite/signin`
3. Contact ShopWorks support

### Issue: Date format error

**Cause:** Wrong date format sent to OnSite
**Solution:** Proxy auto-converts YYYY-MM-DD to MM/DD/YYYY - verify your input format

### Issue: Payment not recorded in OnSite

**Cause:** Missing or wrong status
**Solution:** Ensure `payments[].status: "success"` (exact string)

---

## Quick Reference Card

### Minimum Order
```javascript
{
  orderNumber: "12345",
  customer: { firstName: "John", lastName: "Doe" },
  lineItems: [{ partNumber: "PC54", quantity: 12 }]
}
```

### API URLs
```
Create:   POST /api/manageorders/orders/create
Verify:   GET  /api/manageorders/orders/verify/:extOrderId
Track:    POST /api/manageorders/tracking/push
Health:   GET  /api/manageorders/push/health
Auth:     POST /api/manageorders/auth/test
```

### Required Fields
- `orderNumber` (string)
- `customer.firstName` (string)
- `customer.lastName` (string)
- `lineItems[]` (array with 1+ items)
- `lineItems[].partNumber` (string)
- `lineItems[].quantity` (number > 0)

### Common Sizes
```
S, M, L, XL, 2XL, 3XL, 4XL, 5XL, 6XL
XS, XXS, OSFA
YS, YM, YL, YXL (youth)
LT, XLT, 2XLT (tall)
S/M, L/XL (flex-fit)
```

### Note Types
```
Notes On Order, Notes To Art, Notes To Purchasing,
Notes To Subcontract, Notes To Production, Notes To Receiving,
Notes To Shipping, Notes To Accounting, Notes On Customer
```

### Response Format
```javascript
// Success
{
  success: true,
  extOrderId: "NWCA-12345",
  message: "Order successfully pushed to ManageOrders",
  timestamp: "2026-01-11T10:30:00Z",
  onsiteImportExpected: "2026-01-11T11:30:00Z"
}

// Error
{
  success: false,
  error: "Error message",
  message: "Failed to push order to ManageOrders",
  timestamp: "2026-01-11T10:30:00Z"
}
```

---

## Related Documentation

| Document | Location |
|----------|----------|
| **API Integration Guide** | `memory/MANAGEORDERS_PUSH_INTEGRATION.md` |
| **OnSite Field Schema** | Python Inksoft `memories/OnSite_API_Schema.md` |
| **Field Mapping Details** | Python Inksoft `memories/JSON_Transform_Memory.md` |
| **Size Modifiers** | Python Inksoft `memories/Size_Translation_Memory.md` |
| **Tracking API** | `lib/manageorders-tracking-client.js` |
| **Transformer Code** | `lib/manageorders-push-client.js` |

---

*Last Updated: January 11, 2026*
