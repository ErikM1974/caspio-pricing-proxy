# Online Store Developer Guide - ManageOrders PUSH API

**Version:** 1.0.1
**Last Updated:** October 27, 2025
**For:** NWCA Team & Claude Agents
**Purpose:** Build an online store that sends orders directly to OnSite ERP

---

## Table of Contents

1. [Overview](#overview)
2. [Quick Start](#quick-start)
3. [API Endpoints](#api-endpoints)
4. [Building Checkout Integration](#building-checkout-integration)
5. [Complete Field Reference](#complete-field-reference)
6. [Size Translation Guide](#size-translation-guide)
7. [Code Examples](#code-examples)
8. [Testing Guide](#testing-guide)
9. [Production Checklist](#production-checklist)
10. [Troubleshooting](#troubleshooting)

---

## Overview

### What is ManageOrders PUSH API?

The ManageOrders PUSH API allows your online store to send orders directly from your website into ShopWorks OnSite ERP system for production. Orders are automatically imported into OnSite every hour.

### Order Flow

```
Customer Checkout → Your Website → NWCA Proxy API → ManageOrders → OnSite ERP
     (Step 1)          (Step 2)         (Step 3)         (Step 4)      (Step 5)
```

1. **Customer completes checkout** on your webstore
2. **Your website sends order** to NWCA Proxy API endpoint
3. **Proxy transforms & pushes** order to ManageOrders
4. **ManageOrders stores** order in database
5. **OnSite auto-imports** order hourly into Order Entry

### Why Use This Integration?

- ✅ **No manual order entry** - Orders go directly to production
- ✅ **Automatic size translation** - Webstore sizes → OnSite sizes
- ✅ **Automatic date formatting** - YYYY-MM-DD → MM/DD/YYYY
- ✅ **Customer tracking** - All customer info stored and accessible
- ✅ **Design upload** - Attach design files/thumbnails
- ✅ **Payment integration** - Track payment status
- ✅ **Fast processing** - Orders in OnSite within 1 hour

---

## Quick Start

### Step 1: Your First Test Order

Send a POST request to create an order:

**Endpoint:** `https://caspio-pricing-proxy-ab30a049961a.herokuapp.com/api/manageorders/orders/create`

**Request:**
```javascript
fetch('https://caspio-pricing-proxy-ab30a049961a.herokuapp.com/api/manageorders/orders/create', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json'
  },
  body: JSON.stringify({
    "orderNumber": "TEST-001",
    "isTest": true,  // Mark as test order
    "orderDate": "2025-10-27",
    "customer": {
      "firstName": "John",
      "lastName": "Doe",
      "email": "john@example.com",
      "phone": "360-555-1234"
    },
    "lineItems": [
      {
        "partNumber": "PC54",
        "description": "Port & Company Core Cotton Tee",
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
      "zip": "98101",
      "country": "USA"
    }
  })
})
.then(response => response.json())
.then(data => console.log('Order created:', data))
.catch(error => console.error('Error:', error));
```

**Expected Response:**
```json
{
  "success": true,
  "extOrderId": "NWCA-TEST-TEST-001",
  "message": "Order successfully pushed to ManageOrders",
  "timestamp": "2025-10-27T10:30:00.000Z",
  "onsiteImportExpected": "2025-10-27T11:30:00.000Z",
  "details": {
    "result": "ExtOrderID \"NWCA-TEST-TEST-001\" has been uploaded."
  }
}
```

### Step 2: Verify It Worked

Check the order was received:

```javascript
fetch('https://caspio-pricing-proxy-ab30a049961a.herokuapp.com/api/manageorders/orders/verify/NWCA-TEST-TEST-001')
  .then(response => response.json())
  .then(data => console.log('Verification:', data));
```

### Step 3: Check OnSite

Wait for the next hourly import (check "Last Server Import" in OnSite Order Entry), then search for order: `NWCA-TEST-TEST-001`

---

## API Endpoints

### Base URL

```
Production: https://caspio-pricing-proxy-ab30a049961a.herokuapp.com
```

### Authentication

**No API keys needed!** Authentication is handled automatically by the proxy server using server-side credentials.

---

### 1. Create Order

**Push a new order to OnSite**

**Endpoint:** `POST /api/manageorders/orders/create`

**Headers:**
```
Content-Type: application/json
```

**Request Body:** (See [Complete Field Reference](#complete-field-reference))

**Response (Success):**
```json
{
  "success": true,
  "extOrderId": "NWCA-12345",
  "message": "Order successfully pushed to ManageOrders",
  "timestamp": "2025-10-27T10:30:00.000Z",
  "onsiteImportExpected": "2025-10-27T11:30:00.000Z",
  "details": {
    "result": "ExtOrderID \"NWCA-12345\" has been uploaded."
  }
}
```

**Response (Error):**
```json
{
  "success": false,
  "error": "orderNumber is required",
  "message": "Failed to push order to ManageOrders",
  "timestamp": "2025-10-27T10:30:00.000Z"
}
```

**Error Codes:**
- `400` - Bad request (missing fields, invalid data)
- `500` - Server error (contact support)

---

### 2. Verify Order

**Check if order was received by ManageOrders**

**Endpoint:** `GET /api/manageorders/orders/verify/:extOrderId`

**Parameters:**
- `:extOrderId` - External order ID (e.g., "NWCA-12345")

**Example:**
```
GET /api/manageorders/orders/verify/NWCA-12345
```

**Response (Found):**
```json
{
  "success": true,
  "found": true,
  "extOrderId": "NWCA-12345",
  "uploadedAt": "2025-10-27",
  "orderData": {
    "ExtOrderID": "NWCA-12345",
    "ContactNameFirst": "John",
    "ContactNameLast": "Doe",
    "date_OrderPlaced": "10/27/2025"
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

**Note:** "Not found" doesn't mean the order failed - it may still be processing. Check the create order response for confirmation.

---

### 3. Test Authentication

**Verify API credentials are working**

**Endpoint:** `POST /api/manageorders/auth/test`

**No request body needed**

**Response (Success):**
```json
{
  "success": true,
  "message": "Authentication successful",
  "tokenExpires": "2025-10-27T11:30:00.000Z",
  "tokenLength": 1042
}
```

**Response (Failure):**
```json
{
  "success": false,
  "message": "Authentication failed",
  "error": "Authentication failed: 401 - Invalid credentials"
}
```

---

### 4. Health Check

**Verify API endpoints are available**

**Endpoint:** `GET /api/manageorders/push/health`

**Response:**
```json
{
  "status": "healthy",
  "service": "ManageOrders PUSH API",
  "timestamp": "2025-10-27T10:30:00.000Z",
  "endpoints": {
    "createOrder": "POST /api/manageorders/orders/create",
    "verifyOrder": "GET /api/manageorders/orders/verify/:extOrderId",
    "testAuth": "POST /api/manageorders/auth/test"
  }
}
```

---

## Building Checkout Integration

### Complete Checkout Flow

Here's how to integrate order submission into your checkout process:

#### Step 1: Collect Order Data

During checkout, collect:
- Order number (unique ID from your system)
- Customer information (name, email, phone, company)
- Line items (products, sizes, quantities, prices)
- Shipping address
- Payment information (optional but recommended)

#### Step 2: Format the Order

```javascript
// Build order object
const order = {
  // REQUIRED: Unique order number from your system
  orderNumber: "WEB-12345",

  // REQUIRED: Customer information
  customer: {
    firstName: customerData.firstName,     // Required
    lastName: customerData.lastName,       // Required
    email: customerData.email,             // Optional but recommended
    phone: customerData.phone,             // Optional but recommended
    company: customerData.company          // Optional
  },

  // REQUIRED: At least one line item
  lineItems: cartItems.map(item => ({
    partNumber: item.sku,                  // Required
    quantity: item.quantity,               // Required
    description: item.name,                // Optional but recommended
    color: item.color,                     // Optional but recommended
    size: item.size,                       // Optional (see Size Guide)
    price: item.price                      // Optional but recommended
  })),

  // OPTIONAL: Shipping address
  shipping: {
    company: shippingData.company,
    address1: shippingData.street,         // Required if shipping included
    address2: shippingData.apt,
    city: shippingData.city,               // Required if shipping included
    state: shippingData.state,             // Required if shipping included
    zip: shippingData.zip,                 // Required if shipping included
    country: shippingData.country || 'USA',
    method: shippingData.method            // e.g., "UPS Ground"
  },

  // OPTIONAL: Payment details
  payments: [{
    date: new Date().toISOString().split('T')[0], // YYYY-MM-DD format
    amount: orderTotal,
    status: "success",                     // "success", "failed", "pending"
    gateway: "Stripe",                     // Your payment gateway
    authCode: paymentResult.transactionId,
    accountNumber: paymentResult.last4,    // e.g., "****4242"
    cardCompany: paymentResult.cardBrand   // e.g., "Visa"
  }],

  // OPTIONAL: Order notes
  notes: [{
    type: "Notes On Order",
    text: "Customer requested rush delivery"
  }],

  // OPTIONAL: Dates (always use YYYY-MM-DD format)
  orderDate: new Date().toISOString().split('T')[0],
  requestedShipDate: requestedDate,
  dropDeadDate: deadlineDate,

  // OPTIONAL: Test flag (for testing, not production)
  isTest: false  // Set to true for testing only
};
```

#### Step 3: Send to API

```javascript
async function submitOrderToOnSite(order) {
  try {
    const response = await fetch(
      'https://caspio-pricing-proxy-ab30a049961a.herokuapp.com/api/manageorders/orders/create',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(order)
      }
    );

    const result = await response.json();

    if (result.success) {
      // Order successfully sent!
      console.log('Order ID:', result.extOrderId);
      console.log('Will be in OnSite by:', result.onsiteImportExpected);

      // Show success message to customer
      return {
        success: true,
        orderNumber: result.extOrderId,
        message: 'Order submitted successfully!'
      };
    } else {
      // API returned an error
      console.error('Order submission failed:', result.error);

      // Show error to customer
      return {
        success: false,
        error: result.error,
        message: 'Unable to submit order. Please try again.'
      };
    }
  } catch (error) {
    // Network or other error
    console.error('Error submitting order:', error);

    return {
      success: false,
      error: error.message,
      message: 'Connection error. Please try again.'
    };
  }
}
```

#### Step 4: Handle Response

```javascript
const result = await submitOrderToOnSite(order);

if (result.success) {
  // Order submitted successfully
  // - Show confirmation page
  // - Send confirmation email
  // - Store order number
  showConfirmation(result.orderNumber);
} else {
  // Order submission failed
  // - Show error message
  // - Allow customer to retry
  // - Contact support if needed
  showError(result.message);
}
```

---

## Complete Field Reference

### Required Fields

| Field | Type | Description | Example |
|-------|------|-------------|---------|
| `orderNumber` | string | Unique order ID from your system | "WEB-12345" |
| `customer` | object | Customer information | See below |
| `customer.firstName` | string | Customer first name | "John" |
| `customer.lastName` | string | Customer last name | "Doe" |
| `lineItems` | array | Array of products (min 1) | See below |
| `lineItems[].partNumber` | string | Product SKU/part number | "PC54" |
| `lineItems[].quantity` | number | Quantity ordered (> 0) | 12 |

### Optional Fields

#### Order Level

| Field | Type | Description | Format | Default |
|-------|------|-------------|--------|---------|
| `orderDate` | string | Order date | YYYY-MM-DD | Today |
| `requestedShipDate` | string | Requested ship date | YYYY-MM-DD | null |
| `dropDeadDate` | string | Drop-dead/deadline date | YYYY-MM-DD | null |
| `purchaseOrderNumber` | string | Customer PO number | Any | "" |
| `salesRep` | string | Sales representative name | Any | "" |
| `terms` | string | Payment terms | Any | "" |
| `shippingAmount` | number | Shipping cost | 12.50 | 0 |
| `isTest` | boolean | Mark as test order | true/false | false |

#### Customer Fields

| Field | Type | Description | Example |
|-------|------|-------------|---------|
| `customer.email` | string | Email address | "john@example.com" |
| `customer.phone` | string | Phone number | "360-555-1234" |
| `customer.company` | string | Company name | "ABC Company" |

#### Line Item Fields

| Field | Type | Description | Example |
|-------|------|-------------|---------|
| `lineItems[].description` | string | Product description | "Port & Company Tee" |
| `lineItems[].color` | string | Product color | "Red" |
| `lineItems[].size` | string | Product size (see Size Guide) | "L" |
| `lineItems[].price` | number | Unit price | 8.50 |
| `lineItems[].displayPartNumber` | string | Display SKU override | "CUSTOM-PC54" |
| `lineItems[].displayDescription` | string | Display name override | "Custom Shirt" |
| `lineItems[].notes` | string | Line item notes | "Left chest logo" |
| `lineItems[].workOrderNotes` | string | Production notes | "Use red thread" |
| `lineItems[].playerName` | object | For personalization | See below |
| `lineItems[].playerName.first` | string | Player first name | "Mike" |
| `lineItems[].playerName.last` | string | Player last name | "Johnson" |

#### Shipping Address

| Field | Type | Description | Required if shipping? |
|-------|------|-------------|----------------------|
| `shipping.company` | string | Company name | No |
| `shipping.address1` | string | Street address | Yes |
| `shipping.address2` | string | Apt/Suite | No |
| `shipping.city` | string | City | Yes |
| `shipping.state` | string | State (2-letter) | Yes |
| `shipping.zip` | string | ZIP code | Yes |
| `shipping.country` | string | Country | No (defaults to USA) |
| `shipping.method` | string | Shipping method | No |

#### Designs (Optional)

```javascript
designs: [
  {
    name: "Team Logo",                    // Design name
    externalId: "DESIGN-001",             // Your design ID
    imageUrl: "https://example.com/logo.jpg",  // Design thumbnail
    productColor: "Red",                  // Product color for this design
    vendorId: "VENDOR-123",               // Vendor design ID
    locations: [
      {
        location: "Left Chest",           // Print location
        colors: "2",                      // Number of colors
        flashes: "3",                     // Number of flashes (screen print)
        stitches: "8000",                 // Stitch count (embroidery)
        code: "LC-001",                   // Location code
        imageUrl: "https://...",          // Location-specific image
        notes: "3 inch logo"              // Location notes
      }
    ]
  }
]
```

#### Payments (Optional)

```javascript
payments: [
  {
    date: "2025-10-27",                   // Payment date (YYYY-MM-DD)
    amount: 306.00,                       // Payment amount
    status: "success",                    // "success", "failed", "pending", "refunded"
    gateway: "Stripe",                    // Payment gateway name
    authCode: "ch_1234567890",            // Authorization code
    accountNumber: "****4242",            // Last 4 of card
    cardCompany: "Visa",                  // Card brand
    responseCode: "approved",             // Gateway response code
    reasonCode: "00",                     // Gateway reason code
    reasonText: "Approved",               // Gateway reason text
    feeOther: 0,                          // Other fees
    feeProcessing: 7.65                   // Processing fee
  }
]
```

#### Notes (Optional)

```javascript
notes: [
  {
    type: "Notes On Order",               // Note type (see below)
    text: "Customer requested rush"       // Note text
  }
]
```

**Valid Note Types:**
- `"Notes On Order"` - General order notes
- `"Notes To Art"` - Notes for art department
- `"Notes To Purchasing"` - Notes for purchasing
- `"Notes To Subcontract"` - Notes for subcontractors
- `"Notes To Production"` - Notes for production
- `"Notes To Receiving"` - Notes for receiving
- `"Notes To Shipping"` - Notes for shipping
- `"Notes To Accounting"` - Notes for accounting

---

## Size Translation Guide

### How Sizes Work

Your webstore can use common size names (like "Large", "Extra Large", etc.), and they will be automatically translated to OnSite's size system.

### Complete Size Mapping

| Your Size | OnSite Size | Also Accepts |
|-----------|-------------|--------------|
| **Small** | S | "S", "SM", "Small", "SMALL" |
| **Medium** | M | "M", "MD", "Medium", "MEDIUM" |
| **Large** | L | "L", "LG", "Large", "LARGE" |
| **Extra Large** | XL | "XL", "X-Large", "X-LARGE", "XLarge", "1XL" |
| **2X Large** | 2XL | "2XL", "2X", "XX-Large", "XX-LARGE", "XXL" |
| **3X Large** | 3XL | "3XL", "XXXL", "3X", "XXX-Large", "XXX-LARGE" |
| **4X Large** | 4XL | "4XL", "XXXXL", "4X", "XXXX-Large" |
| **5X Large** | 5XL | "5XL", "XXXXXL", "5X", "XXXXX-Large" |
| **6X Large** | 6XL | "6XL", "XXXXXXL", "6X", "XXXXXX-Large" |
| **Extra Small** | XS | "XS", "X-Small", "X-SMALL", "Extra Small", "EXTRA SMALL" |
| **One Size** | OSFA | "OSFA", "OS", "One Size", "ONE SIZE", "One Size Fits All", "ONE SIZE FITS ALL" |

### Size Validation

If you send an invalid size, you'll get a clear error:

```json
{
  "success": false,
  "error": "Line item 1: Invalid size: \"10XL\". Not found in size mapping. Valid sizes include: S, SM, Small, SMALL, M, MD, Medium, MEDIUM, L, LG, Large, LARGE, XL, X-Large...",
  "message": "Failed to push order to ManageOrders"
}
```

### Best Practices

1. **Use standard size names** - "S", "M", "L", "XL", "2XL", "3XL", etc.
2. **Validate sizes in your UI** - Show only valid sizes in dropdown
3. **Handle validation errors** - Show clear message to customer if size is invalid
4. **Omit size if not applicable** - Some products don't have sizes (leave blank)

---

## Code Examples

### JavaScript/Node.js (Frontend)

```javascript
// In your checkout page
async function submitOrder() {
  const order = {
    orderNumber: generateOrderNumber(),  // Your function to generate unique ID
    customer: {
      firstName: document.getElementById('firstName').value,
      lastName: document.getElementById('lastName').value,
      email: document.getElementById('email').value,
      phone: document.getElementById('phone').value
    },
    lineItems: cart.items.map(item => ({
      partNumber: item.sku,
      description: item.name,
      color: item.color,
      size: item.size,
      quantity: item.quantity,
      price: item.price
    })),
    shipping: {
      address1: document.getElementById('address').value,
      city: document.getElementById('city').value,
      state: document.getElementById('state').value,
      zip: document.getElementById('zip').value,
      country: 'USA'
    },
    orderDate: new Date().toISOString().split('T')[0]
  };

  try {
    const response = await fetch(
      'https://caspio-pricing-proxy-ab30a049961a.herokuapp.com/api/manageorders/orders/create',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(order)
      }
    );

    const result = await response.json();

    if (result.success) {
      // Show confirmation
      window.location.href = `/confirmation?order=${result.extOrderId}`;
    } else {
      // Show error
      alert('Error: ' + result.error);
    }
  } catch (error) {
    console.error('Error submitting order:', error);
    alert('Unable to submit order. Please try again.');
  }
}
```

### JavaScript/Node.js (Backend)

```javascript
const axios = require('axios');

async function submitOrderToOnSite(orderData) {
  try {
    const response = await axios.post(
      'https://caspio-pricing-proxy-ab30a049961a.herokuapp.com/api/manageorders/orders/create',
      orderData,
      {
        headers: { 'Content-Type': 'application/json' },
        timeout: 30000  // 30 second timeout
      }
    );

    if (response.data.success) {
      console.log('Order submitted:', response.data.extOrderId);
      return {
        success: true,
        orderNumber: response.data.extOrderId
      };
    } else {
      console.error('Order failed:', response.data.error);
      return {
        success: false,
        error: response.data.error
      };
    }
  } catch (error) {
    console.error('API error:', error.message);
    return {
      success: false,
      error: error.message
    };
  }
}

// Usage
const result = await submitOrderToOnSite({
  orderNumber: "WEB-12345",
  customer: { firstName: "John", lastName: "Doe", email: "john@example.com" },
  lineItems: [{ partNumber: "PC54", quantity: 12, price: 8.50 }],
  shipping: { address1: "123 Main St", city: "Seattle", state: "WA", zip: "98101" }
});
```

### Python

```python
import requests
import json
from datetime import datetime

def submit_order_to_onsite(order_data):
    """
    Submit order to OnSite via ManageOrders PUSH API
    """
    url = 'https://caspio-pricing-proxy-ab30a049961a.herokuapp.com/api/manageorders/orders/create'

    headers = {
        'Content-Type': 'application/json'
    }

    try:
        response = requests.post(url, json=order_data, headers=headers, timeout=30)
        result = response.json()

        if result.get('success'):
            print(f"Order submitted: {result.get('extOrderId')}")
            return {
                'success': True,
                'order_number': result.get('extOrderId')
            }
        else:
            print(f"Order failed: {result.get('error')}")
            return {
                'success': False,
                'error': result.get('error')
            }

    except requests.exceptions.RequestException as e:
        print(f"API error: {str(e)}")
        return {
            'success': False,
            'error': str(e)
        }

# Usage
order = {
    'orderNumber': 'WEB-12345',
    'orderDate': datetime.now().strftime('%Y-%m-%d'),
    'customer': {
        'firstName': 'John',
        'lastName': 'Doe',
        'email': 'john@example.com'
    },
    'lineItems': [
        {
            'partNumber': 'PC54',
            'quantity': 12,
            'price': 8.50
        }
    ],
    'shipping': {
        'address1': '123 Main St',
        'city': 'Seattle',
        'state': 'WA',
        'zip': '98101'
    }
}

result = submit_order_to_onsite(order)
```

### PHP

```php
<?php
function submitOrderToOnSite($orderData) {
    $url = 'https://caspio-pricing-proxy-ab30a049961a.herokuapp.com/api/manageorders/orders/create';

    $ch = curl_init($url);
    curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
    curl_setopt($ch, CURLOPT_POST, true);
    curl_setopt($ch, CURLOPT_POSTFIELDS, json_encode($orderData));
    curl_setopt($ch, CURLOPT_HTTPHEADER, array('Content-Type: application/json'));
    curl_setopt($ch, CURLOPT_TIMEOUT, 30);

    $response = curl_exec($ch);
    $httpCode = curl_getinfo($ch, CURLINFO_HTTP_CODE);
    curl_close($ch);

    $result = json_decode($response, true);

    if ($result['success']) {
        error_log("Order submitted: " . $result['extOrderId']);
        return array(
            'success' => true,
            'orderNumber' => $result['extOrderId']
        );
    } else {
        error_log("Order failed: " . $result['error']);
        return array(
            'success' => false,
            'error' => $result['error']
        );
    }
}

// Usage
$order = array(
    'orderNumber' => 'WEB-12345',
    'orderDate' => date('Y-m-d'),
    'customer' => array(
        'firstName' => 'John',
        'lastName' => 'Doe',
        'email' => 'john@example.com'
    ),
    'lineItems' => array(
        array(
            'partNumber' => 'PC54',
            'quantity' => 12,
            'price' => 8.50
        )
    ),
    'shipping' => array(
        'address1' => '123 Main St',
        'city' => 'Seattle',
        'state' => 'WA',
        'zip' => '98101'
    )
);

$result = submitOrderToOnSite($order);
?>
```

---

## Testing Guide

### Test vs Production Orders

**Test Orders:**
- Set `isTest: true`
- ExtOrderID will have "TEST-" prefix: `NWCA-TEST-12345`
- Imported into OnSite like normal orders
- Easy to identify and delete

**Production Orders:**
- Set `isTest: false` (or omit - defaults to false)
- ExtOrderID: `NWCA-12345`
- Normal production orders

### Testing Workflow

#### 1. Start with Test Orders

```javascript
const testOrder = {
  orderNumber: "TEST-001",
  isTest: true,  // Mark as test
  // ... rest of order
};
```

#### 2. Verify Response

Check the response:
```javascript
if (result.success && result.extOrderId.includes('TEST')) {
  console.log('Test order created successfully');
}
```

#### 3. Verify in ManageOrders

```javascript
const verification = await fetch(
  `https://caspio-pricing-proxy-ab30a049961a.herokuapp.com/api/manageorders/orders/verify/${result.extOrderId}`
);
const verifyResult = await verification.json();
console.log('Verification:', verifyResult);
```

#### 4. Check OnSite

1. Wait for next hourly import (check "Last Server Import" in OnSite)
2. Open Order Entry in OnSite
3. Search for your ExtOrderID (e.g., `NWCA-TEST-001`)
4. Verify all data is correct:
   - Customer info in Contact fields
   - Line items (products, sizes, quantities)
   - Shipping address
   - Order dates

#### 5. Delete Test Orders

After verifying, delete test orders from OnSite to keep the system clean.

### Common Test Scenarios

**Test 1: Minimal Order**
```javascript
{
  orderNumber: "MIN-001",
  isTest: true,
  customer: { firstName: "Test", lastName: "User" },
  lineItems: [{ partNumber: "PC54", quantity: 1 }]
}
```

**Test 2: Complete Order**
```javascript
{
  orderNumber: "FULL-001",
  isTest: true,
  orderDate: "2025-10-27",
  customer: { firstName: "Test", lastName: "User", email: "test@test.com" },
  lineItems: [
    { partNumber: "PC54", size: "L", quantity: 12, price: 8.50 },
    { partNumber: "PC54", size: "XL", quantity: 6, price: 8.50 }
  ],
  shipping: {
    address1: "123 Test St",
    city: "Seattle",
    state: "WA",
    zip: "98101"
  },
  payments: [{ date: "2025-10-27", amount: 153.00, status: "success" }]
}
```

**Test 3: Invalid Size (Should Fail)**
```javascript
{
  orderNumber: "INVALID-001",
  isTest: true,
  customer: { firstName: "Test", lastName: "User" },
  lineItems: [{ partNumber: "PC54", size: "10XL", quantity: 1 }]
}
// Expected: Error about invalid size
```

**Test 4: Missing Required Field (Should Fail)**
```javascript
{
  isTest: true,
  customer: { firstName: "Test", lastName: "User" },
  lineItems: [{ partNumber: "PC54", quantity: 1 }]
}
// Expected: Error "orderNumber is required"
```

---

## Production Checklist

### Before Going Live

- [ ] **Test thoroughly** - Run all test scenarios
- [ ] **Verify OnSite import** - Confirm test orders appear correctly
- [ ] **Check customer data** - Verify Contact fields are populated
- [ ] **Test error handling** - Ensure errors are handled gracefully
- [ ] **Review size validation** - Confirm only valid sizes in UI
- [ ] **Set up monitoring** - Log all API requests/responses
- [ ] **Document order numbers** - Keep a record of ExtOrderIDs
- [ ] **Remove test flag** - Set `isTest: false` for production
- [ ] **Add user feedback** - Show clear success/error messages
- [ ] **Test payment flow** - Ensure payments are recorded

### Security Best Practices

1. **Never expose API credentials** - Authentication is server-side only
2. **Validate user input** - Check all fields before sending
3. **Use HTTPS** - Always use secure connection (https://)
4. **Sanitize data** - Remove special characters that could cause issues
5. **Rate limiting** - Don't spam the API (wait for response)
6. **Error handling** - Don't expose sensitive error details to users

### Performance Tips

1. **Send orders async** - Don't block user during submission
2. **Show loading state** - Indicate order is being processed
3. **Timeout handling** - Set 30-second timeout for API calls
4. **Retry logic** - Allow retry on network errors (not validation errors)
5. **Cache confirmation** - Store order number for reference

### Customer Communication

1. **Order confirmation** - Show ExtOrderID to customer
2. **Expected timeline** - "Your order will be processed within 1 hour"
3. **Order tracking** - "You'll receive an email when your order is in production"
4. **Error messages** - Clear, actionable error messages
5. **Support contact** - Provide support info if order fails

---

## Troubleshooting

### Common Errors

#### Error: "orderNumber is required"

**Cause:** Missing `orderNumber` field

**Solution:**
```javascript
// Add orderNumber
const order = {
  orderNumber: generateUniqueId(),  // Required!
  // ... rest of order
};
```

---

#### Error: "Invalid size: 'XXX'"

**Cause:** Size not in size mapping table

**Solution:**
- Check [Size Translation Guide](#size-translation-guide)
- Use standard sizes: S, M, L, XL, 2XL, 3XL, etc.
- Or omit size if not applicable

**Example:**
```javascript
// Before (wrong)
lineItems: [{ partNumber: "PC54", size: "10XL", quantity: 1 }]

// After (correct)
lineItems: [{ partNumber: "PC54", size: "3XL", quantity: 1 }]
```

---

#### Error: "Date_OrderPlaced is not in a valid format"

**Cause:** Wrong date format

**Solution:** Always use YYYY-MM-DD format

```javascript
// Wrong
orderDate: "10/27/2025"  // ❌

// Correct
orderDate: "2025-10-27"  // ✅

// Easy way to get today's date
orderDate: new Date().toISOString().split('T')[0]  // ✅
```

---

#### Error: "lineItems array is required"

**Cause:** Missing or empty line items

**Solution:**
```javascript
// Must have at least one line item
lineItems: [
  {
    partNumber: "PC54",
    quantity: 1
  }
]
```

---

#### Error: "Authentication failed"

**Cause:** Server-side credentials issue (not your fault)

**Solution:** Contact NWCA support - this means the proxy server can't authenticate with ManageOrders

---

#### Response: "Order not found" (verification)

**Cause:** Order may still be processing, or verification endpoint limitation

**Solution:**
- Check the create order response first (that's the source of truth)
- If create returned success, the order was uploaded successfully
- "Not found" in verification doesn't mean failure

---

#### Network Error / Timeout

**Cause:** Connection issue or server taking too long

**Solution:**
```javascript
// Add timeout and retry logic
async function submitWithRetry(order, maxRetries = 3) {
  for (let i = 0; i < maxRetries; i++) {
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(order),
        signal: AbortSignal.timeout(30000)  // 30 second timeout
      });

      return await response.json();
    } catch (error) {
      if (i === maxRetries - 1) throw error;
      await new Promise(resolve => setTimeout(resolve, 1000 * (i + 1)));
    }
  }
}
```

---

### Debugging Tips

**1. Log Everything**
```javascript
console.log('Sending order:', JSON.stringify(order, null, 2));
console.log('Response:', JSON.stringify(result, null, 2));
```

**2. Check Response Status**
```javascript
const response = await fetch(url, options);
console.log('HTTP Status:', response.status);
const result = await response.json();
```

**3. Validate Before Sending**
```javascript
function validateOrder(order) {
  if (!order.orderNumber) return 'Order number is required';
  if (!order.customer) return 'Customer is required';
  if (!order.lineItems || order.lineItems.length === 0) return 'At least one line item required';
  return null;  // Valid
}

const error = validateOrder(order);
if (error) {
  alert(error);
  return;
}
```

**4. Test API Health First**
```javascript
async function checkAPIHealth() {
  const response = await fetch(
    'https://caspio-pricing-proxy-ab30a049961a.herokuapp.com/api/manageorders/push/health'
  );
  const health = await response.json();
  console.log('API Status:', health.status);
  return health.status === 'healthy';
}
```

---

## Support

### Getting Help

**For API Issues:**
- Check this documentation first
- Review error message carefully
- Test with minimal order first
- Contact NWCA support with:
  - Order number
  - Error message
  - Request/response JSON

**For OnSite Issues:**
- Check "Last Server Import" timestamp in OnSite
- Verify ManageOrders integration is enabled
- Search for ExtOrderID in Order Entry
- Contact ShopWorks support if orders not importing

### Additional Resources

- **Full Integration Guide:** `memory/MANAGEORDERS_PUSH_INTEGRATION.md`
- **Test Scenarios:** `examples/push-api/test-scenarios.md`
- **Example Orders:** `examples/push-api/minimal-order.json`, `complete-order.json`
- **Postman Collection:** `docs/NWCA-API.postman_collection.json`

---

## Quick Reference

### Endpoints
```
Production: https://caspio-pricing-proxy-ab30a049961a.herokuapp.com

POST   /api/manageorders/orders/create          Create order
GET    /api/manageorders/orders/verify/:id      Verify order
POST   /api/manageorders/auth/test              Test credentials
GET    /api/manageorders/push/health            Health check
```

### Minimal Order Example
```json
{
  "orderNumber": "WEB-001",
  "customer": {
    "firstName": "John",
    "lastName": "Doe"
  },
  "lineItems": [{
    "partNumber": "PC54",
    "quantity": 12
  }]
}
```

### Date Format
```javascript
// Always use YYYY-MM-DD
orderDate: "2025-10-27"

// Get today's date
orderDate: new Date().toISOString().split('T')[0]
```

### Standard Sizes
```
S, M, L, XL, 2XL, 3XL, 4XL, 5XL, 6XL, XS, OSFA
```

### Test Orders
```javascript
{
  "orderNumber": "TEST-001",
  "isTest": true,  // Adds "TEST-" prefix to ExtOrderID
  // ... rest of order
}
```

---

**End of Guide** - Happy coding! 🚀
