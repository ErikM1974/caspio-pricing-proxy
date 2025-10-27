# ManageOrders PUSH API Integration

**Version:** 1.0.1
**Last Updated:** October 27, 2025
**Purpose:** Send orders FROM our system TO ShopWorks OnSite via ManageOrders PUSH API

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
    "company": "ABC Company"
  },

  "shipping": {
    "company": "ABC Company",
    "address1": "123 Main St",
    "address2": "Suite 100",
    "city": "Seattle",
    "state": "WA",
    "zip": "98101",
    "country": "USA",
    "method": "UPS Ground"
  },

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
    "testAuth": "POST /api/manageorders/auth/test"
  }
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

## Changelog

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
