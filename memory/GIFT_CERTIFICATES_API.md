# Gift Certificates API

**Last Updated:** 2025-12-18
**Status:** Production Ready
**Version:** 1.0.0

## Overview

Two endpoints for managing gift certificate lookups - by certificate number (checkout flow) and by ShopWorks order ID (reverse lookup).

**Base URL:** `https://caspio-pricing-proxy-ab30a049961a.herokuapp.com`

---

## Endpoints

### 1. GET /api/gift-certificates

Look up gift certificates by certificate number, email, store, or balance status.

**Primary Use Case:** Staff enters gift certificate code at checkout to check balance and redemption history.

#### Query Parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `certificateNumber` | string | No | Exact match (e.g., `D5FC-5G57-J379-4DJA`) |
| `email` | string | No | Filter by customer email |
| `storeName` | string | No | Filter by store name |
| `hasBalance` | boolean | No | If `true`, only active certificates (balance > 0) |
| `refresh` | boolean | No | If `true`, bypass 5-minute cache |

#### Example Request

```bash
curl "https://caspio-pricing-proxy-ab30a049961a.herokuapp.com/api/gift-certificates?certificateNumber=D5FC-5G57-J379-4DJA"
```

#### Example Response (Single Certificate)

```json
{
  "id": 42,
  "certificateNumber": "D5FC-5G57-J379-4DJA",
  "status": "Active",
  "currentBalance": 35.5,
  "initialBalance": "$150.00",
  "customerEmail": "bradley@nwcustomapparel.com",
  "customerName": "Bradley Wright",
  "storeName": "Emerald Fire",
  "dateIssued": "12 December 2025",
  "issueReason": "Credit",
  "redemptions": [
    {
      "type": "Issued",
      "date": "12/12/25",
      "externalOrderId": null,
      "amount": 150,
      "shopworksOrderId": null,
      "orderTotal": null,
      "orderCustomer": null
    },
    {
      "type": "Redeemed",
      "date": "12/14/25",
      "externalOrderId": "52040",
      "amount": 114.5,
      "shopworksOrderId": 139936,
      "orderTotal": 114.5,
      "orderCustomer": "Emerald Fire"
    }
  ],
  "history": "Issued: 12/12/25 ($150)\nRedeemed: 12/14/25 Order #52040 ($114.5)",
  "dateUpdated": null
}
```

#### Response Fields

| Field | Type | Description |
|-------|------|-------------|
| `id` | number | Internal Caspio record ID |
| `certificateNumber` | string | Unique gift certificate code |
| `status` | string | `"Active"` (balance > 0) or `"Depleted"` (balance = 0/null) |
| `currentBalance` | number/null | Remaining balance (null if fully used) |
| `initialBalance` | string | Original value (e.g., "$150.00") |
| `customerEmail` | string | Customer's email address |
| `customerName` | string | Customer's name |
| `storeName` | string | Store that issued the certificate |
| `dateIssued` | string | Human-readable issue date |
| `issueReason` | string | Why it was issued (e.g., "Credit") |
| `redemptions` | array | Transaction history with ShopWorks order details |
| `history` | string | Raw history text from Caspio |

#### Redemption Object Fields

| Field | Type | Description |
|-------|------|-------------|
| `type` | string | `"Issued"`, `"Redeemed"`, `"Refunded"`, or `"Voided"` |
| `date` | string | Transaction date (MM/DD/YY) |
| `externalOrderId` | string/null | InkSoft order number (if applicable) |
| `amount` | number | Transaction amount |
| `shopworksOrderId` | number/null | ShopWorks order ID (auto-resolved) |
| `orderTotal` | number/null | Total invoice amount in ShopWorks |
| `orderCustomer` | string/null | Customer name on ShopWorks order |

---

### 2. GET /api/gift-certificates/by-order/:orderId

Reverse lookup: Find which gift certificates were used on a specific ShopWorks order.

**Primary Use Case:** Customer service needs to know which gift card was applied to an order (for refunds, audits, etc.).

#### Path Parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `orderId` | number | Yes | ShopWorks order ID (e.g., `139991`) |

#### Query Parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `refresh` | boolean | No | If `true`, bypass 5-minute cache |

#### Example Request

```bash
curl "https://caspio-pricing-proxy-ab30a049961a.herokuapp.com/api/gift-certificates/by-order/139991"
```

#### Example Response

```json
{
  "shopworksOrderId": 139991,
  "externalOrderId": "52089",
  "orderCustomer": "Emerald Fire",
  "orderTotal": 125.51,
  "giftCertificatesUsed": [
    {
      "certificateNumber": "J457-6555-JJJG-4H9A",
      "amountApplied": 125.51,
      "amountRefunded": 0,
      "netAmount": 125.51,
      "redemptionDate": "12/16/25",
      "currentBalance": 24.49,
      "status": "Active",
      "customerName": "Bradley Wright",
      "customerEmail": "bradley@nwcustomapparel.com",
      "storeName": "Emerald Fire",
      "initialBalance": "$150.00"
    }
  ],
  "totalGiftCertificateAmount": 125.51,
  "count": 1
}
```

#### Response Fields

| Field | Type | Description |
|-------|------|-------------|
| `shopworksOrderId` | number | The ShopWorks order ID queried |
| `externalOrderId` | string | InkSoft/external order number |
| `orderCustomer` | string | Customer name on the order |
| `orderTotal` | number | Total invoice amount |
| `giftCertificatesUsed` | array | List of gift certificates used on this order |
| `totalGiftCertificateAmount` | number | Sum of all gift card amounts applied |
| `count` | number | Number of gift certificates used |

#### Gift Certificate Object Fields

| Field | Type | Description |
|-------|------|-------------|
| `certificateNumber` | string | Gift certificate code |
| `amountApplied` | number | Amount redeemed on this order |
| `amountRefunded` | number | Amount refunded (if any) |
| `netAmount` | number | amountApplied - amountRefunded |
| `redemptionDate` | string | Date redeemed (MM/DD/YY) |
| `currentBalance` | number/null | Current remaining balance |
| `status` | string | `"Active"` or `"Depleted"` |
| `customerName` | string | Certificate holder name |
| `customerEmail` | string | Certificate holder email |
| `storeName` | string | Store that issued certificate |
| `initialBalance` | string | Original certificate value |

---

## Error Responses

### 400 Bad Request
```json
{
  "error": "Invalid certificate number format"
}
```

### 404 Not Found
```json
{
  "error": "Gift certificate not found"
}
```

```json
{
  "error": "Order not found in ShopWorks",
  "shopworksOrderId": 999999
}
```

### 500 Internal Server Error
```json
{
  "error": "Failed to fetch gift certificates",
  "details": "Error message here"
}
```

---

## Caching

- **TTL:** 5 minutes
- **Bypass:** Add `?refresh=true` to any request
- **Max entries:** 100 per endpoint

---

## Use Cases

### Checkout Flow
1. Staff scans/enters gift certificate code
2. Call `GET /api/gift-certificates?certificateNumber=XXXX-XXXX-XXXX-XXXX`
3. Display balance and status to staff
4. If `status: "Active"` and `currentBalance > 0`, allow redemption

### Customer Service - Order Inquiry
1. Customer asks about gift card on order #139991
2. Call `GET /api/gift-certificates/by-order/139991`
3. See which gift certificate(s) were applied and amounts

### Refund Processing
1. Order needs to be cancelled/refunded
2. Call `GET /api/gift-certificates/by-order/{orderId}`
3. Identify gift certificates to credit back
4. Process refund to appropriate certificate(s)

### Balance Check
1. Customer wants to check remaining balance
2. Call `GET /api/gift-certificates?certificateNumber=XXXX`
3. Show `currentBalance` and `status`

---

## Code Examples

### JavaScript/Node.js

```javascript
// Look up gift certificate by code
async function getGiftCertificate(certificateNumber) {
  const response = await fetch(
    `https://caspio-pricing-proxy-ab30a049961a.herokuapp.com/api/gift-certificates?certificateNumber=${certificateNumber}`
  );
  return response.json();
}

// Find gift certificates used on an order
async function getGiftCertsByOrder(shopworksOrderId) {
  const response = await fetch(
    `https://caspio-pricing-proxy-ab30a049961a.herokuapp.com/api/gift-certificates/by-order/${shopworksOrderId}`
  );
  return response.json();
}

// Get all active certificates for a store
async function getActiveCertificates(storeName) {
  const response = await fetch(
    `https://caspio-pricing-proxy-ab30a049961a.herokuapp.com/api/gift-certificates?storeName=${encodeURIComponent(storeName)}&hasBalance=true`
  );
  return response.json();
}
```

### Python

```python
import requests

BASE_URL = "https://caspio-pricing-proxy-ab30a049961a.herokuapp.com"

def get_gift_certificate(certificate_number):
    """Look up gift certificate by code"""
    response = requests.get(
        f"{BASE_URL}/api/gift-certificates",
        params={"certificateNumber": certificate_number}
    )
    return response.json()

def get_gift_certs_by_order(shopworks_order_id):
    """Find gift certificates used on an order"""
    response = requests.get(
        f"{BASE_URL}/api/gift-certificates/by-order/{shopworks_order_id}"
    )
    return response.json()

def get_active_certificates(store_name):
    """Get all active certificates for a store"""
    response = requests.get(
        f"{BASE_URL}/api/gift-certificates",
        params={"storeName": store_name, "hasBalance": "true"}
    )
    return response.json()
```

---

## Changelog

### v1.0.0 - 2025-12-18
- Initial release
- `GET /api/gift-certificates` - Certificate lookup with ShopWorks order resolution
- `GET /api/gift-certificates/by-order/:orderId` - Reverse lookup by ShopWorks order
- 5-minute caching with refresh bypass
- Auto-resolves external order IDs to ShopWorks order IDs
- Fetches order details (total, customer) for each redemption
