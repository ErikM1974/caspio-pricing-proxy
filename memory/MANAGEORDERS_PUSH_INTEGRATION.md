# ManageOrders PUSH API Integration

**Version:** 1.2.0
**Last Updated:** January 11, 2026
**Purpose:** Send orders and tracking FROM our system TO ShopWorks OnSite via ManageOrders PUSH API

---

## Overview

The ManageOrders PUSH API allows us to send orders from our NWCA webstore/applications directly into ShopWorks OnSite for production processing. This is the companion to the ManageOrders PULL API (which retrieves data from OnSite).

### How It Works

```
Customer Order → NWCA Website → Caspio Pricing Proxy → ManageOrders PUSH API → OnSite ERP
     (1)              (2)                 (3)                    (4)              (5)
```

1. **Customer places order** on NWCA website/webstore
2. **Website sends order** to our Caspio Pricing Proxy
3. **Proxy transforms & pushes** order to ManageOrders PUSH API
4. **ManageOrders stores** order in database
5. **OnSite auto-imports** order every hour (into Order Entry system)

### Key Features

- ✅ **Automatic Size Translation** - "Large" → "L" → OnSite "LG" column
- ✅ **Customer Tracking** - All orders → Customer #2791, actual customer in Contact fields
- ✅ **Billing Address Support** - Separate billing and shipping addresses (NEW v1.1.0)
- ✅ **Full Customer Object** - 29 fields including tax info, custom fields, business data (NEW v1.1.0)
- ✅ **Multiple File Upload** - Unlimited artwork and document files (NEW v1.1.0)
- ✅ **Smart File Routing** - Artwork → Designs, All Files → Attachments (NEW v1.1.0)
- ✅ **Extended File Types** - AI, PSD, EPS, PDF, JPG, PNG, DOCX, ZIP, and more (NEW v1.1.0)
- ✅ **Tracking Number PUSH** - Send tracking to OnSite, single or batch (NEW v1.2.0)
- ✅ **Tracking Verification** - Verify tracking was received (NEW v1.2.0)
- ✅ **Design Support** - Upload design thumbnails via ImageURL
- ✅ **Payment Integration** - Send payment status and details
- ✅ **Shipping Integration** - Full shipping address support
- ✅ **Order Verification** - Check if order was received
- ✅ **Hourly Import** - Orders appear in OnSite within 1 hour

---

## Configuration

### OnSite Settings

**Location:** `Utilities > Company Setup > ManageOrders.com Settings`

**Current Configuration:**
```
Connection Settings:
  - Enabled: ✅ Yes
  - Name: "Manage Orders NW Custom Apparel"
  - Type: "ManageOrders"
  - TimeZone: -07:00 (Pacific)
  - URL: manageordersapi.com/onsite
  - Username: Erik@nwcustomapparel.com

Supplemental Settings:
  - Customer Number: 2791 (all orders go here)
  - Company Location ID: 2
  - Order Type ID: 6
  - Employee Created By: 2
  - AutoHold: No
  - DesignType ID: 3
  - Artist Created By: 224
  - ProductClass: 1

Auto Import Settings:
  - Auto Import via Server: ✅ Enabled (hourly sync)
  - Last Import: [Check OnSite for timestamp]
```

### Environment Variables

```bash
# Already configured in Heroku
MANAGEORDERS_USERNAME=Erik@nwcustomapparel.com
MANAGEORDERS_PASSWORD=<your-password>
```

### Size Translation Table

| Webstore Size | OnSite Size | OnSite Column | Modifier |
|---------------|-------------|---------------|----------|
| S, Small | S | S | - |
| M, Medium | M | M | - |
| L, Large | L | LG | - |
| XL, X-Large | XL | XL | - |
| 2XL, XXL | 2XL or XXL | XXL | `_2XL` |
| 3XL | 3XL | Other XXXL | `_3XL` |
| 4XL | 4XL | Other XXXL | `_4XL` |
| 5XL | 5XL | Other XXXL | `_5XL` |
| 6XL | 6XL | Other XXXL | `_6XL` |
| XS, Extra Small | XS | Other XXXL | `_XS` |
| OSFA, One Size | OSFA | Other XXXL | - |

---

## API Endpoints

### Base URL

```
Production: https://caspio-pricing-proxy-ab30a049961a.herokuapp.com
Local: http://localhost:3002
```

### 1. Create Order

**Endpoint:** `POST /api/manageorders/orders/create`

**Purpose:** Push a new order to ManageOrders PUSH API

**Request Body:**
```json
{
  "orderNumber": "12345",
  "orderDate": "2025-10-27",
  "requestedShipDate": "2025-11-01",
  "isTest": false,

  "customer": {
    "firstName": "John",
    "lastName": "Doe",
    "email": "john@example.com",
    "phone": "360-555-1234",
    "company": "ABC Company",
    "website": "https://abccompany.com",
    "taxExempt": "Y",
    "taxExemptNumber": "EX-12345"
  },

  "billing": {
    "company": "ABC Company",
    "address1": "123 Main St",
    "address2": "Suite 400",
    "city": "Seattle",
    "state": "WA",
    "zip": "98101",
    "country": "USA"
  },

  "shipping": {
    "company": "ABC Company - Warehouse",
    "address1": "456 Oak Ave",
    "address2": "Building B",
    "city": "Tacoma",
    "state": "WA",
    "zip": "98402",
    "country": "USA",
    "method": "UPS Ground"
  },

  "files": [
    {
      "fileName": "company-logo.ai",
      "fileData": "data:application/illustrator;base64,JVBERi0xLjUK...",
      "category": "artwork",
      "decorationLocation": "Left Chest",
      "description": "Vector logo for embroidery"
    },
    {
      "fileName": "purchase-order.pdf",
      "fileData": "data:application/pdf;base64,JVBERi0xLjQK...",
      "category": "document",
      "description": "Customer PO #2025-001"
    }
  ],

  "lineItems": [
    {
      "partNumber": "PC54",
      "description": "Port & Company Core Cotton Tee",
      "color": "Red",
      "size": "L",
      "quantity": 12,
      "price": 8.50,
      "playerName": {
        "first": "Mike",
        "last": "Smith"
      }
    }
  ],

  "designs": [
    {
      "name": "Team Logo",
      "imageUrl": "https://example.com/logo.jpg",
      "locations": [
        {
          "location": "Left Chest",
          "colors": "2",
          "notes": "3 inch logo"
        }
      ]
    }
  ],

  "payments": [
    {
      "date": "2025-10-27",
      "amount": 102.00,
      "status": "success",
      "gateway": "Stripe",
      "authCode": "ch_abc123",
      "accountNumber": "****1234"
    }
  ],

  "notes": [
    {
      "type": "Notes On Order",
      "text": "Customer requested rush production"
    }
  ]
}
```

**Response (Success):**
```json
{
  "success": true,
  "extOrderId": "NWCA-12345",
  "message": "Order successfully pushed to ManageOrders",
  "timestamp": "2025-10-27T10:30:00Z",
  "onsiteImportExpected": "2025-10-27T11:30:00Z"
}
```

**Response (Error):**
```json
{
  "success": false,
  "error": "Invalid size: '7XL' not in size mapping",
  "message": "Failed to push order to ManageOrders",
  "timestamp": "2025-10-27T10:30:00Z"
}
```

---

### 2. Verify Order

**Endpoint:** `GET /api/manageorders/orders/verify/:extOrderId`

**Purpose:** Verify that an order was received by ManageOrders

**Example:** `GET /api/manageorders/orders/verify/NWCA-12345`

**Response (Found):**
```json
{
  "success": true,
  "found": true,
  "extOrderId": "NWCA-12345",
  "uploadedAt": "2025-10-27",
  "orderData": {
    "ExtOrderID": "NWCA-12345",
    "ExtSource": "NWCA",
    "ContactNameFirst": "John",
    "ContactNameLast": "Doe",
    "LinesOE": [...]
  }
}
```

**Response (Not Found):**
```json
{
  "success": true,
  "found": false,
  "extOrderId": "NWCA-12345",
  "message": "Order not found in ManageOrders. It may still be processing or was uploaded on a different date."
}
```

---

### 3. Test Authentication

**Endpoint:** `POST /api/manageorders/auth/test`

**Purpose:** Test ManageOrders PUSH API credentials

**Response:**
```json
{
  "success": true,
  "message": "Authentication successful",
  "tokenExpires": "2025-10-27T11:30:00Z",
  "tokenLength": 1024
}
```

---

### 4. Health Check

**Endpoint:** `GET /api/manageorders/push/health`

**Purpose:** Check if PUSH API service is running

**Response:**
```json
{
  "status": "healthy",
  "service": "ManageOrders PUSH API",
  "timestamp": "2025-10-27T10:30:00Z",
  "endpoints": {
    "createOrder": "POST /api/manageorders/orders/create",
    "verifyOrder": "GET /api/manageorders/orders/verify/:extOrderId",
    "testAuth": "POST /api/manageorders/auth/test",
    "pushTracking": "POST /api/manageorders/tracking/push",
    "pullTracking": "GET /api/manageorders/tracking/pull",
    "verifyTracking": "GET /api/manageorders/tracking/verify/:extOrderId"
  }
}
```

---

### 5. Push Tracking (NEW v1.2.0)

**Endpoint:** `POST /api/manageorders/tracking/push`

**Purpose:** Send tracking numbers to ManageOrders for orders you've previously pushed

**Request Body (single tracking):**
```json
{
  "extOrderId": "NWCA-12345",
  "trackingNumber": "1Z999AA10123456784",
  "shippingMethod": "UPS Ground",
  "cost": 12.95,
  "weight": 2.5,
  "extShipId": "SHIP-1"
}
```

**Request Body (multiple tracking - array):**
```json
[
  { "extOrderId": "NWCA-12345", "trackingNumber": "1Z999AA10123456784", "shippingMethod": "UPS Ground" },
  { "extOrderId": "NWCA-12346", "trackingNumber": "1Z999AA10123456785", "shippingMethod": "UPS Ground" }
]
```

**Response:**
```json
{
  "success": true,
  "trackingCount": 1,
  "trackingNumbers": ["1Z999AA10123456784"],
  "extOrderIds": ["NWCA-12345"],
  "timestamp": "2025-01-11T10:30:00Z"
}
```

**Required Fields:**
- `extOrderId` - Must match an order you previously pushed
- `trackingNumber` - Carrier tracking number

**Optional Fields:**
- `shippingMethod` - e.g., "UPS Ground", "FedEx Home"
- `cost` - Shipping cost (number)
- `weight` - Package weight (number)
- `extShipId` - For split shipments (matches ShippingAddresses.ExtShipID)
- `customField01-05` - Custom tracking fields

---

### 6. Pull Tracking (NEW v1.2.0)

**Endpoint:** `GET /api/manageorders/tracking/pull`

**Purpose:** Retrieve tracking data you've pushed by date range

**Query Parameters:**
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `dateFrom` | string | Yes | Start date (YYYY-MM-DD) |
| `dateTo` | string | Yes | End date (YYYY-MM-DD) |
| `timeFrom` | string | No | Start time (HH-MM-SS) |
| `timeTo` | string | No | End time (HH-MM-SS) |
| `apiSource` | string | No | Filter: "all", "none", or specific source |

**Example:**
```
GET /api/manageorders/tracking/pull?dateFrom=2025-01-10&dateTo=2025-01-11&apiSource=NWCA
```

**Response:**
```json
{
  "success": true,
  "count": 5,
  "dateRange": { "from": "2025-01-10", "to": "2025-01-11" },
  "tracking": [...],
  "timestamp": "2025-01-11T10:30:00Z"
}
```

---

### 7. Verify Tracking (NEW v1.2.0)

**Endpoint:** `GET /api/manageorders/tracking/verify/:extOrderId`

**Purpose:** Verify tracking was pushed for a specific order

**URL Parameters:**
- `extOrderId` - External order ID (e.g., "NWCA-12345")

**Query Parameters (optional):**
- `dateFrom` - Start date to search (defaults to today)
- `dateTo` - End date to search (defaults to today)

**Example:**
```
GET /api/manageorders/tracking/verify/NWCA-12345
GET /api/manageorders/tracking/verify/NWCA-12345?dateFrom=2025-01-01&dateTo=2025-01-11
```

**Response (found):**
```json
{
  "success": true,
  "found": true,
  "extOrderId": "NWCA-12345",
  "trackingCount": 1,
  "tracking": [...]
}
```

**Response (not found):**
```json
{
  "success": true,
  "found": false,
  "extOrderId": "NWCA-12345",
  "message": "No tracking found for this order in the specified date range",
  "dateRange": { "from": "2025-01-11", "to": "2025-01-11" }
}
```

---

## Request Field Reference

### Required Fields

| Field | Type | Description |
|-------|------|-------------|
| `orderNumber` | string | Unique order number from your system |
| `customer` | object | Customer information object |
| `customer.firstName` | string | Customer first name |
| `customer.lastName` | string | Customer last name |
| `lineItems` | array | Array of line items (at least 1 required) |
| `lineItems[].partNumber` | string | Product part number |
| `lineItems[].quantity` | number | Quantity ordered (must be > 0) |

### Optional Fields

| Field | Type | Description | Default |
|-------|------|-------------|---------|
| `orderDate` | string (YYYY-MM-DD) | Order date | Today's date |
| `requestedShipDate` | string (YYYY-MM-DD) | Requested ship date | null |
| `dropDeadDate` | string (YYYY-MM-DD) | Drop-dead date | null |
| `isTest` | boolean | Mark as test order (adds "TEST-" to ExtOrderID) | false |
| `customer.email` | string | Customer email | '' |
| `customer.phone` | string | Customer phone | '' |
| `customer.company` | string | Customer company name | '' |
| `shipping` | object | Shipping address | null |
| `lineItems[].description` | string | Product description | '' |
| `lineItems[].color` | string | Product color | '' |
| `lineItems[].size` | string | Product size (translated via SIZE_MAPPING) | null |
| `lineItems[].price` | number | Unit price | 0 |
| `lineItems[].playerName` | object | Player name for personalization | null |
| `designs` | array | Design/artwork information | [] |
| `payments` | array | Payment information | [] |
| `notes` | array | Order notes | [] |

---

## Integration Examples

### JavaScript (Browser)

```javascript
// From your webstore checkout page
async function submitOrder(orderData) {
  try {
    const response = await fetch(
      'https://caspio-pricing-proxy-ab30a049961a.herokuapp.com/api/manageorders/orders/create',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(orderData)
      }
    );

    const result = await response.json();

    if (result.success) {
      console.log('Order created:', result.extOrderId);
      console.log('Expected in OnSite:', result.onsiteImportExpected);

      // Show success message to customer
      alert(`Order ${result.extOrderId} submitted successfully!`);

      // Optionally verify after a few seconds
      setTimeout(() => verifyOrder(result.extOrderId), 5000);
    } else {
      console.error('Order creation failed:', result.error);
      alert('Order submission failed. Please try again.');
    }
  } catch (error) {
    console.error('Network error:', error);
    alert('Network error. Please check your connection and try again.');
  }
}

async function verifyOrder(extOrderId) {
  const response = await fetch(
    `https://caspio-pricing-proxy-ab30a049961a.herokuapp.com/api/manageorders/orders/verify/${extOrderId}`
  );

  const result = await response.json();

  if (result.found) {
    console.log('Order verified in ManageOrders!');
  } else {
    console.log('Order not yet visible (may still be processing)');
  }
}
```

### Node.js (Server-Side)

```javascript
const axios = require('axios');

async function pushOrderToOnSite(orderData) {
  try {
    const response = await axios.post(
      'https://caspio-pricing-proxy-ab30a049961a.herokuapp.com/api/manageorders/orders/create',
      orderData,
      {
        headers: {
          'Content-Type': 'application/json'
        },
        timeout: 30000 // 30 second timeout
      }
    );

    console.log('Order pushed:', response.data.extOrderId);
    return response.data;
  } catch (error) {
    if (error.response) {
      console.error('API Error:', error.response.data);
      throw new Error(error.response.data.error);
    } else {
      console.error('Network Error:', error.message);
      throw error;
    }
  }
}
```

### PHP

```php
<?php
function pushOrderToOnSite($orderData) {
    $url = 'https://caspio-pricing-proxy-ab30a049961a.herokuapp.com/api/manageorders/orders/create';

    $ch = curl_init($url);
    curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
    curl_setopt($ch, CURLOPT_POST, true);
    curl_setopt($ch, CURLOPT_POSTFIELDS, json_encode($orderData));
    curl_setopt($ch, CURLOPT_HTTPHEADER, [
        'Content-Type: application/json'
    ]);

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
curl -X POST https://caspio-pricing-proxy-ab30a049961a.herokuapp.com/api/manageorders/orders/create \
  -H "Content-Type: application/json" \
  -d '{
    "orderNumber": "12345",
    "orderDate": "2025-10-27",
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
```

---

## Testing

### Step 1: Test Authentication

```bash
curl -X POST https://caspio-pricing-proxy-ab30a049961a.herokuapp.com/api/manageorders/auth/test
```

**Expected:** `{"success": true, "message": "Authentication successful", ...}`

### Step 2: Create Test Order

Use the `isTest: true` flag to mark the order as a test:

```json
{
  "orderNumber": "001",
  "isTest": true,
  "orderDate": "2025-10-27",
  "customer": {
    "firstName": "Test",
    "lastName": "Customer",
    "email": "test@example.com"
  },
  "lineItems": [
    {
      "partNumber": "TEST-PART",
      "description": "Test Product",
      "size": "M",
      "quantity": 1,
      "price": 10.00
    }
  ],
  "shipping": {
    "address1": "123 Test St",
    "city": "Seattle",
    "state": "WA",
    "zip": "98101"
  }
}
```

**Result:** Order will be created as `NWCA-TEST-001`

### Step 3: Verify Test Order

```bash
curl https://caspio-pricing-proxy-ab30a049961a.herokuapp.com/api/manageorders/orders/verify/NWCA-TEST-001
```

### Step 4: Check OnSite (After 1 Hour)

1. Wait for OnSite's hourly auto-import
2. Open OnSite Order Entry
3. Search for order: `NWCA-TEST-001`
4. Verify:
   - Customer: #2791
   - Contact: Test Customer (test@example.com)
   - Line items correct
   - Shipping address correct

---

## Sample Orders

Sample orders use the same endpoint and structure as regular webstore orders, with a few key differences for tracking and handling.

### Overview

**Purpose:** Free sample requests from Top Sellers Showcase or other promotional pages

**Key Characteristics:**
- No payment required (free samples)
- Order number format: `SAMPLE-MMDD-sequence`
- Tracked as pennies ($0.01 per item) for inventory
- Separate billing and shipping addresses supported (NEW v1.1.0)

### Sample Order Structure

```json
{
  "orderNumber": "SAMPLE-1029-1",
  "orderDate": "2025-10-29",
  "isTest": false,

  "customer": {
    "firstName": "Mike",
    "lastName": "Test",
    "email": "erik@go2shirt.com",
    "phone": "555-5555",
    "company": "Test Company LLC"
  },

  "billing": {
    "company": "Test Company LLC",
    "address1": "123 Billing St",
    "address2": "Suite 400",
    "city": "Seattle",
    "state": "WA",
    "zip": "98101",
    "country": "USA"
  },

  "shipping": {
    "company": "Test Company Warehouse",
    "address1": "456 Shipping Ave",
    "address2": "Building B",
    "city": "Tacoma",
    "state": "WA",
    "zip": "98402",
    "country": "USA",
    "method": "UPS Ground"
  },

  "lineItems": [
    {
      "partNumber": "PC54",
      "description": "Port & Company Core Cotton Tee",
      "color": "Forest",
      "size": "OSFA",
      "quantity": 1,
      "price": 0.01
    },
    {
      "partNumber": "NE100",
      "description": "North End Fleece Jacket",
      "color": "Black",
      "size": "OSFA",
      "quantity": 1,
      "price": 0.01
    }
  ],

  "notes": [
    {
      "type": "Notes On Order",
      "text": "FREE SAMPLE - Top Sellers Showcase - Test Company LLC"
    }
  ],

  "salesRep": "erik@nwcustomapparel.com",
  "terms": "FREE SAMPLE"
}
```

### Field Differences from Regular Orders

| Field | Regular Orders | Sample Orders |
|-------|---------------|---------------|
| **Order Number** | Customer's PO or generated ID | `SAMPLE-MMDD-sequence` |
| **Line Item Price** | Actual product price | $0.01 (penny for tracking) |
| **Payment** | Payment array with details | Omitted (no payment for free samples) |
| **Billing Address** | Optional (may match shipping) | Required (for company records) |
| **Shipping Address** | Required | Required (can be same as billing) |
| **Notes** | General notes | Include "FREE SAMPLE" designation |
| **Terms** | Customer terms (Net 30, etc.) | "FREE SAMPLE" |

### Separate Billing & Shipping (NEW v1.1.0)

Sample orders can now have separate billing and shipping addresses:

**Scenario 1: Same Address**
- User checks "Ship to the same address" checkbox
- Shipping address is automatically copied from billing
- Both addresses sent to API (identical values)

**Scenario 2: Different Addresses**
- User unchecks checkbox
- Separate shipping address form appears
- Different addresses sent to API
- Common for:
  - Company headquarters (billing) vs warehouse (shipping)
  - Home office (billing) vs retail location (shipping)

### Sample Order ExtOrderID Format

**Frontend Generates:**
```
SAMPLE-1029-1
```

**Proxy Adds NWCA Prefix:**
```
NWCA-SAMPLE-1029-1
```

**In OnSite:**
- ExtOrderID: `NWCA-SAMPLE-1029-1`
- CustomerPurchaseOrder: `SAMPLE-1029-1`

### Sample Request Form Integration

**Frontend Implementation** (Pricing Index File 2025):
```javascript
// pages/sample-cart.html
// Form collects:
// - Contact: firstName, lastName, email, phone, company
// - Billing: address1, address2, city, state, zip
// - Shipping: address1, address2, city, state, zip (or copied from billing)
// - Sales rep selection
// - Additional notes

// shared_components/js/sample-order-service.js
// Transforms form data into ManageOrders format
// Sends to proxy endpoint
```

**Field Mapping (Frontend → Proxy → ManageOrders):**

| Frontend Field | Proxy Field | ManageOrders Field | Block |
|----------------|-------------|-------------------|-------|
| `firstName` | `customer.firstName` | `ContactNameFirst` | Order |
| `lastName` | `customer.lastName` | `ContactNameLast` | Order |
| `email` | `customer.email` | `ContactEmail` | Order |
| `phone` | `customer.phone` | `ContactPhone` | Order |
| `company` | `customer.company` | `Customer.CompanyName` | Customer |
| `salesRep` | `salesRep` | `CustomerServiceRep` | Order |
| `billing_address1` | `billing.address1` | `Customer.BillingAddress01` | Customer |
| `billing_address2` | `billing.address2` | `Customer.BillingAddress02` | Customer |
| `billing_city` | `billing.city` | `Customer.BillingCity` | Customer |
| `billing_state` | `billing.state` | `Customer.BillingState` | Customer |
| `billing_zip` | `billing.zip` | `Customer.BillingZip` | Customer |
| `shipping_address1` | `shipping.address1` | `ShippingAddresses[0].ShipAddress01` | Shipping |
| `shipping_address2` | `shipping.address2` | `ShippingAddresses[0].ShipAddress02` | Shipping |
| `shipping_city` | `shipping.city` | `ShippingAddresses[0].ShipCity` | Shipping |
| `shipping_state` | `shipping.state` | `ShippingAddresses[0].ShipState` | Shipping |
| `shipping_zip` | `shipping.zip` | `ShippingAddresses[0].ShipZip` | Shipping |

### Sample Order Notes Best Practices

**Include in Order Notes:**
1. **Designation:** "FREE SAMPLE" (for production identification)
2. **Source:** Which page/feature generated the request
3. **Company:** Company name for tracking
4. **Customer Details:** Repeat key contact info for easy reference

**Example:**
```json
{
  "type": "Notes On Order",
  "text": "FREE SAMPLE - Top Sellers Showcase - ABC Company\n\nCustomer: John Smith\nEmail: john@abc.com\nPhone: 360-555-1234\nSales Rep: erik@nwcustomapparel.com"
}
```

### Testing Sample Orders

**Quick Test:**
```bash
curl -X POST https://caspio-pricing-proxy-ab30a049961a.herokuapp.com/api/manageorders/orders/create \
  -H "Content-Type: application/json" \
  -d '{
    "orderNumber": "SAMPLE-1029-TEST",
    "orderDate": "2025-10-29",
    "isTest": true,
    "customer": {
      "firstName": "Test",
      "lastName": "Sample",
      "email": "test@example.com",
      "phone": "555-5555",
      "company": "Test Company"
    },
    "billing": {
      "company": "Test Company HQ",
      "address1": "123 Billing St",
      "city": "Seattle",
      "state": "WA",
      "zip": "98101"
    },
    "shipping": {
      "company": "Test Company Warehouse",
      "address1": "456 Shipping Ave",
      "city": "Tacoma",
      "state": "WA",
      "zip": "98402"
    },
    "lineItems": [
      {
        "partNumber": "PC54",
        "description": "Sample Tee",
        "color": "Red",
        "size": "L",
        "quantity": 1,
        "price": 0.01
      }
    ],
    "notes": [
      {
        "type": "Notes On Order",
        "text": "FREE SAMPLE TEST - Billing/Shipping Separation"
      }
    ]
  }'
```

**Expected Response:**
```json
{
  "success": true,
  "extOrderId": "NWCA-TEST-SAMPLE-1029-TEST",
  "message": "Order successfully pushed to ManageOrders",
  "onsiteImportExpected": "2025-10-29T11:00:00.000Z"
}
```

### OnSite Verification for Sample Orders

**After Hourly Import:**

1. **Search for Order:** `NWCA-SAMPLE-1029-1`

2. **Verify Customer Block:**
   - Customer #2791 (all web orders)
   - Contact fields: Test User, test@example.com, 555-5555
   - **Billing address:**
     - BillingCompany: Test Company LLC
     - BillingAddress01: 123 Billing St
     - BillingAddress02: Suite 400
     - BillingCity: Seattle
     - BillingState: WA
     - BillingZip: 98101

3. **Verify Shipping Block:**
   - **If same address:**
     - ShipAddress01: 123 Billing St (same as billing)
   - **If different address:**
     - ShipAddress01: 456 Shipping Ave
     - ShipCity: Tacoma
     - ShipState: WA
     - ShipZip: 98402

4. **Verify Line Items:**
   - Products: PC54, NE100, etc.
   - Quantities: 1 each
   - Prices: $0.01 each
   - Sizes: OSFA (one size fits all for samples)

5. **Verify Notes:**
   - Should include "FREE SAMPLE" designation
   - Should include company name
   - Should include customer contact info

### Common Sample Order Issues

**Issue: Billing and shipping addresses are swapped**

**Solution:**
- Verify proxy version is v1.1.0 or later
- Check that Customer block receives `BillingAddress*` fields
- Check that ShippingAddresses array receives `ShipAddress*` fields

**Issue: Sample order shows as regular order in OnSite**

**Solution:**
- Ensure order number starts with `SAMPLE-`
- Verify notes include "FREE SAMPLE" designation
- Check line item prices are $0.01

**Issue: Order missing billing address in OnSite**

**Solution:**
- Verify `billing` object is sent in request payload
- Check proxy logs for Customer block population
- Confirm Customer block includes BillingAddress* fields

### Sample Order Enhancements (Future)

**Phase 1: Line Item Custom Fields**
```javascript
lineItems: [{
  partNumber: "PC54",
  // ... other fields ...
  customFields: {
    CustomField01: "FREE SAMPLE",
    CustomField02: "Top Sellers Showcase",
    CustomField03: "2025-10-29"
  }
}]
```

**Phase 2: Multiple Note Types**
```javascript
notes: [
  {
    type: "Notes On Order",
    text: "FREE SAMPLE - Top Sellers Showcase"
  },
  {
    type: "Notes To Shipping",
    text: "Sample order - No signature required"
  },
  {
    type: "Notes To Production",
    text: "Standard production schedule - Mark as FREE SAMPLE"
  }
]
```

**Phase 3: Design Block Integration**
```javascript
designs: [{
  name: "Sample Logo",
  imageUrl: "https://...",
  locations: [{
    location: "Left Chest",
    notes: "Standard placement for samples"
  }]
}]
```

### Complete Testing Guide

For comprehensive sample order testing procedures, see:
**[Sample Order Testing Guide](../../../Pricing%20Index%20File%202025/memory/SAMPLE_ORDER_TESTING_GUIDE.md)**

Includes:
- Step-by-step test scenarios
- Expected console logs
- OnSite verification procedures
- Troubleshooting guide
- Test results template

---

## Troubleshooting

### Issue: "Authentication failed"

**Cause:** Invalid credentials or expired token

**Solution:**
1. Check environment variables are set correctly
2. Test auth endpoint: `POST /api/manageorders/auth/test`
3. Contact ShopWorks support if credentials are invalid

### Issue: "Invalid size: 'XXX' not in size mapping"

**Cause:** Size not in SIZE_MAPPING configuration

**Solution:**
1. Check [Size Translation Table](#size-translation-table)
2. Use supported size values (S, M, L, XL, 2XL, 3XL, 4XL, 5XL, 6XL, XS, OSFA)
3. Or add new size to `config/manageorders-push-config.js`

### Issue: Order not appearing in OnSite

**Causes:**
1. **Hourly delay** - Wait up to 1 hour for auto-import
2. **Order not pushed** - Check logs for push errors
3. **APISource filter** - OnSite may be filtering by source
4. **Order on hold** - Check if AutoHold is enabled

**Solutions:**
1. Wait for next hourly import (check "Last Server Import" in OnSite)
2. Verify order was received: `GET /api/manageorders/orders/verify/:extOrderId`
3. Check OnSite ManageOrders settings
4. Contact ShopWorks support

### Issue: "No response from ManageOrders API"

**Cause:** Network connectivity issue or ManageOrders API down

**Solution:**
1. Check internet connection
2. Test with: `curl https://manageordersapi.com/onsite/signin`
3. Check ManageOrders API status
4. Contact ShopWorks support

### Issue: Order appears with wrong customer

**Expected Behavior:** All orders go to Customer #2791

**Actual Customer Info:** Stored in Contact fields (`ContactNameFirst`, `ContactNameLast`, `ContactEmail`, `ContactPhone`)

**Notes:** A note is automatically added to each order with full customer details

### Issue: "Date_OrderPlaced is not in a valid format"

**Cause:** OnSite/Caspio expects dates in MM/DD/YYYY format, not YYYY-MM-DD

**Solution:** ✅ Fixed in v1.0.1 - dates are now automatically converted

**Format Examples:**
- Input: `"2025-10-27"` → Output: `"10/27/2025"` ✅
- Input: `"2025-11-05"` → Output: `"11/05/2025"` ✅

**Affected Fields:**
- `date_OrderPlaced` (order date)
- `date_OrderRequestedToShip` (requested ship date)
- `date_OrderDropDead` (drop-dead date)
- `date_Payment` (payment date)

---

## Size Mapping Guide

### How to Add New Sizes

1. Open `config/manageorders-push-config.js`
2. Add to `SIZE_MAPPING` object:
   ```javascript
   'NewSize': 'OnSiteSize',
   ```
3. Update OnSite Size Translation Table
4. Restart server

### Example: Adding Youth Sizes

```javascript
// In SIZE_MAPPING
'YS': 'S',      // Youth Small → S
'YM': 'M',      // Youth Medium → M
'YL': 'L',      // Youth Large → L
'YXL': 'XL',    // Youth XL → XL
```

Then configure in OnSite Size Translation Table.

---

## Data Flow Details

### 1. Order Transformation

**Input (Your Format):**
```json
{
  "orderNumber": "12345",
  "customer": {"firstName": "John", "lastName": "Doe"},
  "lineItems": [{"partNumber": "PC54", "size": "Large", "quantity": 12}]
}
```

**Output (ManageOrders Format):**
```json
{
  "ExtOrderID": "NWCA-12345",
  "ExtSource": "NWCA",
  "id_Customer": 2791,
  "ContactNameFirst": "John",
  "ContactNameLast": "Doe",
  "LinesOE": [
    {
      "PartNumber": "PC54",
      "Size": "L",  // Translated from "Large"
      "Qty": 12,
      "id_ProductClass": 1
    }
  ]
}
```

### 2. OnSite Import Process

1. **Hourly Sync:** OnSite scheduled task runs every hour
2. **Query:** Pulls orders from ManageOrders with source "NWCA"
3. **Size Mapping:** OnSite maps "L" to "LG" column using Size Translation Table
4. **Part Number:** OnSite may append modifier (e.g., PC54 + _3XL = PC54_3XL)
5. **Customer:** Assigns to Customer #2791, stores actual customer in Contact fields
6. **Order Creation:** Creates order in Order Entry system

---

## API Response Codes

| Code | Meaning | Action |
|------|---------|--------|
| 200 | Success | Order pushed successfully |
| 400 | Bad Request | Check request format, required fields, size values |
| 401 | Unauthorized | Check credentials, test auth endpoint |
| 500 | Server Error | Check logs, retry, contact support |

---

## Rate Limiting

**Current Limit:** No specific limit for PUSH API (authentication has caching)

**Token Caching:** Tokens cached for 1 hour to reduce auth requests

**Recommendations:**
- Batch orders if sending many at once
- Implement retry logic with exponential backoff
- Monitor for 429 (Too Many Requests) responses

---

## Security Notes

- ✅ Authentication tokens cached for 1 hour
- ✅ Credentials stored in environment variables (not in code)
- ✅ HTTPS only (enforced by ManageOrders API)
- ✅ No sensitive data in ExtOrderID (just order number)
- ⚠️ Customer data sent in plain JSON (over HTTPS)

---

## Support

**Technical Issues:**
- Check this documentation
- Review example files in `examples/push-api/`
- Check server logs for detailed errors

**OnSite Configuration:**
- Contact ShopWorks Support: support@shopworx.com
- Phone: 800-526-6702

**Integration Questions:**
- Review [Integration Examples](#integration-examples)
- Check API endpoint responses for detailed error messages

---

---

## Billing Address Support (NEW v1.1.0)

### Overview

The API now supports separate billing and shipping addresses. Billing address fields are sent to the ManageOrders `Customer` object and appear in ShopWorks OnSite's Customer billing information.

### Billing Address Fields

| Field | Type | Description | Example |
|-------|------|-------------|---------|
| `billing.company` | string | Billing company name | "ABC Company" |
| `billing.address1` | string | Billing address line 1 | "123 Main St" |
| `billing.address2` | string | Billing address line 2 | "Suite 400" |
| `billing.city` | string | Billing city | "Seattle" |
| `billing.state` | string | Billing state (2-letter code) | "WA" |
| `billing.zip` | string | Billing ZIP code | "98101" |
| `billing.country` | string | Billing country | "USA" |

### Usage

**Same Billing and Shipping:**
```json
{
  "billing": {
    "company": "ABC Company",
    "address1": "123 Main St",
    "city": "Seattle",
    "state": "WA",
    "zip": "98101"
  },
  "shipping": {
    "company": "ABC Company",
    "address1": "123 Main St",
    "city": "Seattle",
    "state": "WA",
    "zip": "98101"
  }
}
```

**Different Billing and Shipping:**
```json
{
  "billing": {
    "company": "ABC Company HQ",
    "address1": "123 Main St",
    "city": "Seattle",
    "state": "WA",
    "zip": "98101"
  },
  "shipping": {
    "company": "ABC Company Warehouse",
    "address1": "456 Oak Ave",
    "city": "Tacoma",
    "state": "WA",
    "zip": "98402"
  }
}
```

### In ShopWorks OnSite

Billing address appears in:
- **Customer Block** → Billing Address fields
- Available for invoicing and accounting purposes

---

## File Upload Support (NEW v1.1.0)

### Overview

Upload unlimited files (artwork, documents, purchase orders, etc.) with each order. Files are automatically uploaded to Caspio and included in the ManageOrders order payload.

### Supported File Types

| Category | File Types | MIME Types |
|----------|------------|------------|
| **Images** | PNG, JPG, GIF, SVG, WebP | image/png, image/jpeg, image/gif, image/svg+xml, image/webp |
| **Documents** | PDF | application/pdf |
| **Design Files** | AI, PSD, EPS, INDD | application/illustrator, application/postscript, image/vnd.adobe.photoshop, image/x-eps |
| **Vector Files** | SVG, CDR | image/svg+xml, application/vnd.corel-draw |
| **Office Docs** | DOCX, XLSX, DOC, XLS | application/vnd.openxmlformats-officedocument.* |
| **Compressed** | ZIP, RAR | application/zip, application/x-rar-compressed |

**Max File Size:** 20MB per file
**File Limit:** Unlimited files per order

### File Categories

Files are routed to different locations in ShopWorks OnSite based on category:

| Category | Destination | Purpose | OnSite Display |
|----------|-------------|---------|----------------|
| `artwork` | Designs.Locations.ImageURL + Attachments | Production artwork | Designs section (production team) |
| `document` | Attachments only | Order documents | Attachments section (all departments) |

### File Upload Flow

```
1. Frontend: User uploads file → FileReader converts to base64
2. Frontend: Sends base64 in order payload (files array)
3. Proxy: Uploads to Caspio Files API → Gets externalKey
4. Proxy: Builds URL: https://caspio-pricing-proxy.../api/files/{externalKey}
5. Proxy: Adds to ManageOrders payload:
   - Artwork files → Designs.Locations.ImageURL
   - All files → Attachments array
6. ManageOrders: Receives order with file URLs
7. OnSite: Imports order with clickable file links
```

### Usage Examples

**Upload Artwork File:**
```json
{
  "files": [
    {
      "fileName": "team-logo.ai",
      "fileData": "data:application/illustrator;base64,JVBERi0xLjUK...",
      "category": "artwork",
      "decorationLocation": "Left Chest",
      "description": "Vector logo for embroidery"
    }
  ]
}
```

**Upload Document File:**
```json
{
  "files": [
    {
      "fileName": "purchase-order.pdf",
      "fileData": "data:application/pdf;base64,JVBERi0xLjQK...",
      "category": "document",
      "description": "Customer PO #2025-001"
    }
  ]
}
```

**Upload Multiple Files:**
```json
{
  "files": [
    {
      "fileName": "logo.ai",
      "fileData": "data:application/illustrator;base64,...",
      "category": "artwork",
      "decorationLocation": "Left Chest",
      "description": "Logo file"
    },
    {
      "fileName": "back-design.pdf",
      "fileData": "data:application/pdf;base64,...",
      "category": "artwork",
      "decorationLocation": "Full Back",
      "description": "Back print design"
    },
    {
      "fileName": "po-12345.pdf",
      "fileData": "data:application/pdf;base64,...",
      "category": "document",
      "description": "Purchase order"
    },
    {
      "fileName": "proof-approval.jpg",
      "fileData": "data:image/jpeg;base64,...",
      "category": "document",
      "description": "Approved proof"
    }
  ]
}
```

### Converting Files to Base64 (JavaScript)

```javascript
function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

// Usage:
const fileInput = document.getElementById('logoInput');
const file = fileInput.files[0];
const base64Data = await fileToBase64(file);

// Send in order
const order = {
  orderNumber: "12345",
  files: [{
    fileName: file.name,
    fileData: base64Data,
    category: "artwork",
    description: "Company logo"
  }],
  // ... rest of order
};
```

### File Storage

- **Location:** Caspio Artwork folder
- **Folder Key:** `b91133c3-4413-4cb9-8337-444c730754dd`
- **Access:** Files accessible via proxy URL for security
- **URL Format:** `https://caspio-pricing-proxy-ab30a049961a.herokuapp.com/api/files/{externalKey}`

### In ShopWorks OnSite

**Artwork Files:**
- Appear in **Designs** section
- Linked to specific decoration locations
- Production team sees them when creating screens/digitizing

**All Files:**
- Appear in **Attachments** section
- Accessible to all departments (sales, production, shipping, accounting)
- Clickable URLs to view/download

---

## Customer Object Reference (NEW v1.1.0)

### Overview

The API now sends a complete `Customer` object with 29 fields to ManageOrders, providing comprehensive customer information beyond basic contact fields.

### Customer Object Fields

| Field | Type | Description | Example |
|-------|------|-------------|---------|
| **Billing Address (7 fields)** ||||
| `BillingCompany` | string | Billing company name | "ABC Company" |
| `BillingAddress01` | string | Billing address line 1 | "123 Main St" |
| `BillingAddress02` | string | Billing address line 2 | "Suite 400" |
| `BillingCity` | string | Billing city | "Seattle" |
| `BillingState` | string | Billing state | "WA" |
| `BillingZip` | string | Billing ZIP code | "98101" |
| `BillingCountry` | string | Billing country | "USA" |
| **Company Info (3 fields)** ||||
| `CompanyName` | string | Company name | "ABC Company" |
| `MainEmail` | string | Company main email | "info@abccompany.com" |
| `WebSite` | string | Company website | "https://abccompany.com" |
| **Tax Info (2 fields)** ||||
| `TaxExempt` | string | Tax exempt status (Y/N) | "Y" |
| `TaxExemptNumber` | string | Tax exemption number | "EX-12345" |
| **Business Classification (3 fields)** ||||
| `CustomerSource` | string | Customer source | "Website", "Trade Show", "Referral" |
| `CustomerType` | string | Customer type | "Corporate", "Retail", "Wholesale" |
| `SalesGroup` | string | Sales group | "Northwest", "Enterprise" |
| **Notes (2 fields)** ||||
| `InvoiceNotes` | string | Invoice notes | "Net 30 terms approved" |
| `CustomerReminderInvoiceNotes` | string | Invoice reminder notes | "Send reminder 7 days before due" |
| **Custom Fields (10 fields)** ||||
| `CustomField01` - `CustomField06` | string | Custom text fields | Any custom data |
| `CustomDateField01` - `CustomDateField04` | string | Custom date fields | "2025-12-31" |

### Usage

```json
{
  "customer": {
    "firstName": "John",
    "lastName": "Doe",
    "email": "john@example.com",
    "phone": "360-555-1234",
    "company": "ABC Company",
    "website": "https://abccompany.com",
    "taxExempt": "Y",
    "taxExemptNumber": "EX-12345",
    "source": "Website",
    "type": "Corporate",
    "salesGroup": "Northwest",
    "invoiceNotes": "Net 30 terms approved",
    "customFields": {
      "CustomField01": "VIP Customer",
      "CustomField02": "Preferred Shipping: UPS"
    }
  },
  "billing": {
    "company": "ABC Company",
    "address1": "123 Main St",
    "city": "Seattle",
    "state": "WA",
    "zip": "98101"
  }
}
```

---

## Changelog

### Version 1.1.0 (October 29, 2025)
- ✨ **BILLING ADDRESS SUPPORT**: Separate billing and shipping addresses
  - Added 7 billing address fields to Customer object
  - Billing address appears in OnSite Customer billing information
  - Fallback to customer.company if billing.company not provided
- ✨ **MULTIPLE FILE UPLOAD SUPPORT**: Upload unlimited files per order
  - Artwork files → Designs.Locations.ImageURL (production team)
  - All files → Attachments array (all departments)
  - Automatic upload to Caspio Files API v3
  - File URLs: `https://caspio-pricing-proxy.../api/files/{externalKey}`
- ✨ **EXTENDED FILE TYPES**: Support for 20+ file types
  - Design files: AI, PSD, EPS, INDD
  - Office docs: DOCX, XLSX, DOC, XLS
  - Images: PNG, JPG, GIF, SVG, WebP
  - Compressed: ZIP, RAR
  - Max size: 20MB per file
- ✨ **FULL CUSTOMER OBJECT**: 29 customer fields
  - Company info (website, main email)
  - Tax information (exempt status, tax ID)
  - Business classification (source, type, sales group)
  - Custom fields (6 text + 4 date fields)
  - Invoice notes and reminders
- ✨ **ADDITIONAL ORDER FIELDS**: Status and financial fields
  - Status: id_SalesStatus, id_ReceivingStatus, id_ShippingStatus
  - Financial: TaxTotal, TotalDiscounts
  - Discount: DiscountPartNumber, DiscountPartDescription
- ✅ All new features fully backward compatible
- ✅ Updated documentation with comprehensive examples
- ✅ Updated complete-order.json example

### Version 1.0.1 (October 27, 2025)
- 🐛 **DATE FORMAT FIX**: All dates now converted to MM/DD/YYYY format
  - Fixed `date_OrderPlaced`, `date_OrderRequestedToShip`, `date_OrderDropDead`
  - Fixed `date_Payment` in payment records
  - Resolves Caspio validation error: "Date_OrderPlaced is not in a valid format"
- ✅ Successfully tested with orders NWCA-TEST-002 and NWCA-TEST-003

### Version 1.0.0 (October 27, 2025)
- ✅ Initial release
- ✅ Order creation endpoint
- ✅ Order verification endpoint
- ✅ Authentication testing endpoint
- ✅ Complete size translation (S, M, L, XL, 2XL, 3XL, 4XL, 5XL, 6XL, XS, OSFA)
- ✅ Design/artwork support
- ✅ Payment integration
- ✅ Shipping address support
- ✅ Customer contact field tracking
- ✅ Comprehensive documentation
