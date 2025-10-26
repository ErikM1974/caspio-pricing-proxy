# ManageOrders API Integration

**Last Updated:** 2025-10-26
**Status:** Production Ready
**Version:** 1.0.0

## Table of Contents
- [Overview](#overview)
- [Current Implementation](#current-implementation)
- [Architecture](#architecture)
- [Security](#security)
- [Performance](#performance)
- [Deployment](#deployment)
- [Testing](#testing)
- [Troubleshooting](#troubleshooting)
- [Future Expansion](#future-expansion)

---

## Overview

The ManageOrders integration provides a secure server-side proxy to ShopWorks ManageOrders API, enabling customer data access for browser applications without exposing credentials.

### What is ManageOrders?

ManageOrders is ShopWorks' web-based application that presents OnSite ERP data to customers and sales teams. It syncs hourly with the OnSite system and provides a REST API for programmatic access.

### Why This Integration?

- **Security**: Credentials stored server-side only (never exposed to browsers)
- **Performance**: Intelligent caching reduces API calls (1-hour token cache, 1-day customer cache)
- **Rate Limiting**: Prevents API abuse (10 requests/minute)
- **Data Quality**: Automatic phone number cleaning and customer deduplication

---

## Current Implementation

### Endpoints

#### 1. GET /api/manageorders/customers

Fetches unique customers from the last 60 days of orders.

**Query Parameters:**
- `refresh` (boolean, optional): Force cache refresh (default: false)

**Response:**
```json
{
  "customers": [
    {
      "id_Customer": 12279,
      "CustomerName": "Washington State Housing Finance Commission",
      "ContactFirstName": "Tera",
      "ContactLastName": "Ahlborn",
      "ContactEmail": "Tera.Ahlborn@wshfc.org",
      "ContactPhone": "206-287-4470",
      "CustomerServiceRep": "Nika Lao",
      "lastOrderDate": "2025-10-01T00:00:00.000Z"
    }
  ],
  "cached": true,
  "cacheDate": "2025-10-26",
  "count": 389
}
```

**Usage Examples:**
```bash
# Get customers (uses cache if available)
curl https://caspio-pricing-proxy-ab30a049961a.herokuapp.com/api/manageorders/customers

# Force refresh
curl https://caspio-pricing-proxy-ab30a049961a.herokuapp.com/api/manageorders/customers?refresh=true
```

#### 2. GET /api/manageorders/cache-info

Debug endpoint showing cache status.

**Response:**
```json
{
  "cacheExists": true,
  "cacheValid": true,
  "cacheTimestamp": "2025-10-26T15:50:18.000Z",
  "cacheAgeMs": 300000,
  "cacheAgeMinutes": 5,
  "cacheDurationMs": 86400000,
  "customerCount": 389
}
```

---

## Architecture

### Data Flow

```
Browser Application
       ↓
caspio-pricing-proxy (Heroku)
       ↓
ManageOrders API (manageordersapi.com)
       ↓
ShopWorks OnSite (local/cloud)
```

### Caching Strategy

**Two-Level Cache:**

1. **Token Cache (1 hour)**
   - Stores `id_token` from ManageOrders authentication
   - Prevents repeated auth requests
   - Cleared on server restart

2. **Customer Cache (1 day)**
   - Stores deduplicated customer list
   - Parameter: `?refresh=true` forces refresh
   - Cleared on server restart

### Customer Deduplication Logic

**Process:**
1. Fetch orders from last 60 days
2. Extract customer data from each order
3. Group by `id_Customer`
4. Keep customer with most recent `lastOrderDate`
5. Sort alphabetically by `CustomerName`

**Fields Extracted:**
- `id_Customer` - Unique customer ID
- `CustomerName` - Company name
- `ContactFirstName` - Contact first name
- `ContactLastName` - Contact last name
- `ContactEmail` - Email address
- `ContactPhone` - Cleaned phone number (removes "W ", "C" prefixes)
- `ContactDepartment` - Department name
- `CustomerServiceRep` - Assigned sales rep
- `lastOrderDate` - Most recent order date

---

## Security

### Environment Variables

**Production (Heroku):**
```bash
MANAGEORDERS_USERNAME=Erik@nwcustomapparel.com
MANAGEORDERS_PASSWORD=%L[qT4h2
```

**Configuration:**
```javascript
// config.js
manageOrders: {
  baseUrl: 'https://manageordersapi.com/v1',
  username: process.env.MANAGEORDERS_USERNAME,
  password: process.env.MANAGEORDERS_PASSWORD,
  tokenCacheDuration: 3600000,      // 1 hour
  customerCacheDuration: 86400000,  // 1 day
  defaultDaysBack: 60
}
```

### Rate Limiting

**Configuration:**
```javascript
// server.js
const manageOrdersLimiter = rateLimit({
  windowMs: 60 * 1000,  // 1 minute
  max: 10,              // Max 10 requests per minute
  trustProxy: true,     // Trust Heroku's proxy
  message: {
    error: 'Too many requests to ManageOrders endpoints',
    retryAfter: '60 seconds'
  }
});
```

### Error Handling

**Credentials Never Exposed:**
```javascript
// ✅ GOOD - Generic error
throw new Error('ManageOrders authentication failed: 401');

// ❌ BAD - Exposes credentials
throw new Error(`Login failed for ${username} with ${password}`);
```

---

## Performance

### Metrics (60-Day Lookback)

**From Production Logs:**
- Orders fetched: 912
- Unique customers: 389
- Initial request time: ~2.3 seconds
- Cached response time: < 100ms

### Cache Durations

| Cache Type | Duration | Purpose |
|------------|----------|---------|
| Token | 1 hour | Prevent repeated authentication |
| Customers | 1 day | Reduce API calls, improve UX |

### Optimization Notes

- **60-day window** is optimal balance between data freshness and performance
- **Deduplication** reduces payload size from 912 to 389 records
- **Phone cleaning** happens during deduplication (no extra processing)

---

## Deployment

### Local Development

**1. Set Environment Variables (.env):**
```bash
MANAGEORDERS_USERNAME=Erik@nwcustomapparel.com
MANAGEORDERS_PASSWORD=%L[qT4h2
```

**2. Start Server:**
```bash
PORT=3002 node server.js
```

**3. Test Endpoint:**
```bash
curl http://localhost:3002/api/manageorders/customers
```

### Heroku Production

**1. Add Environment Variables:**
```bash
heroku config:set MANAGEORDERS_USERNAME=Erik@nwcustomapparel.com
heroku config:set MANAGEORDERS_PASSWORD=%L[qT4h2 --app caspio-pricing-proxy
```

**Or via Heroku Dashboard:**
1. Go to app settings
2. Click "Reveal Config Vars"
3. Add both variables

**2. Deploy:**
```bash
git push heroku main
```

**3. Verify:**
```bash
heroku logs --tail --app caspio-pricing-proxy | grep -i manageorders
```

---

## Testing

### Manual Testing

**1. Check Cache Info:**
```bash
curl https://caspio-pricing-proxy-ab30a049961a.herokuapp.com/api/manageorders/cache-info
```

**2. Fetch Customers:**
```bash
curl https://caspio-pricing-proxy-ab30a049961a.herokuapp.com/api/manageorders/customers
```

**3. Force Refresh:**
```bash
curl "https://caspio-pricing-proxy-ab30a049961a.herokuapp.com/api/manageorders/customers?refresh=true"
```

**4. Test Rate Limiting:**
```bash
# Make 11 requests quickly (should get rate limited on 11th)
for i in {1..11}; do curl -w "\n%{http_code}\n" https://caspio-pricing-proxy-ab30a049961a.herokuapp.com/api/manageorders/customers; done
```

### Expected Behaviors

**First Request:**
- Authenticates with ManageOrders
- Fetches orders
- Deduplicates customers
- Stores in cache
- Returns `"cached": false`

**Subsequent Requests:**
- Returns cached data instantly
- Returns `"cached": true`

**With `?refresh=true`:**
- Reuses token (if < 1 hour old)
- Fetches fresh orders
- Updates cache
- Returns `"cached": false`

---

## Troubleshooting

### Common Issues

#### 1. Rate Limiter Error (Heroku)

**Symptom:**
```
ERR_ERL_UNEXPECTED_X_FORWARDED_FOR
```

**Cause:** Rate limiter not configured for Heroku's proxy

**Solution:** Add `trustProxy: true` to rate limiter config
```javascript
const manageOrdersLimiter = rateLimit({
  trustProxy: true,  // ← Add this
  // ... other config
});
```

#### 2. Authentication Failure

**Symptom:**
```
Error: Could not authenticate with ManageOrders API
```

**Debug Steps:**
1. Check environment variables:
   ```bash
   heroku config --app caspio-pricing-proxy | grep MANAGEORDERS
   ```

2. Verify credentials in OnSite:
   - Navigate to: Utilities > Company Setup > ManageOrders.com Settings
   - Press "Test Connection"

3. Check Heroku logs:
   ```bash
   heroku logs --tail --app caspio-pricing-proxy | grep -i "manageorders"
   ```

#### 3. Empty Customer List

**Symptom:**
```json
{
  "customers": [],
  "count": 0
}
```

**Possible Causes:**
- No orders in last 60 days
- ManageOrders not synced with OnSite
- Date range issue

**Debug:**
```bash
# Check raw response structure
curl https://caspio-pricing-proxy-ab30a049961a.herokuapp.com/api/manageorders/customers | jq .
```

#### 4. Phone Numbers Not Cleaned

**Symptom:** Phone numbers still show "W 206-555-1234"

**Check:** `cleanPhoneNumber()` function in [src/utils/manageorders.js](../src/utils/manageorders.js:106-119)

**Valid Formats:**
- "W 206-555-1234" → "206-555-1234"
- "C 206-555-1234" → "206-555-1234"
- "206-555-1234" → "206-555-1234" (unchanged)

---

## Future Expansion

### Available API Endpoints

The ManageOrders API provides many additional endpoints beyond customer data. See [MANAGEORDERS_API_SPEC.yaml](./MANAGEORDERS_API_SPEC.yaml) for complete specification.

### PULL API Capabilities

**Orders:**
- `GET /manageorders/orders` - Get orders by date range
- `GET /manageorders/orders/{order_no}` - Get specific order
- `GET /manageorders/getorderno/{ext_order_id}` - Get order number by external ID

**Line Items:**
- `GET /manageorders/lineitems/{order_no}` - Get line items for order

**Payments:**
- `GET /manageorders/payments` - Get payments by date range
- `GET /manageorders/payments/{order_no}` - Get payments for order

**Tracking:**
- `GET /manageorders/tracking` - Get tracking by date range
- `GET /manageorders/tracking/{order_no}` - Get tracking for order

**Inventory:**
- `GET /manageorders/inventorylevels` - Get inventory levels with filters

### PUSH API Capabilities

**Order Submission:**
- `POST /order-push` - Upload complete orders with:
  - Customer information
  - Line items
  - Designs (with thumbnails)
  - Shipping addresses
  - Payments
  - Notes
  - Attachments

**Tracking Submission:**
- `POST https://manageordersapi.com/onsite/track-push` - Upload tracking numbers

### Future Endpoint Ideas

**High Priority:**
1. **Order History** - `/api/manageorders/orders`
   - Customer-specific order lookup
   - Date range filtering
   - Use case: Customer portals

2. **Order Tracking** - `/api/manageorders/tracking/{order_no}`
   - Real-time shipment tracking
   - Use case: Customer tracking pages

3. **Inventory Check** - `/api/manageorders/inventory`
   - Real-time stock levels
   - Use case: Product availability

**Medium Priority:**
4. **Payments** - `/api/manageorders/payments`
   - Payment history
   - Use case: Accounting integrations

5. **Line Items** - `/api/manageorders/lineitems/{order_no}`
   - Order detail breakdown
   - Use case: Order management

### Implementation Template

When adding new ManageOrders endpoints, follow this pattern:

```javascript
// src/routes/manageorders.js

router.get('/manageorders/orders', async (req, res) => {
  try {
    const token = await authenticateManageOrders();

    const response = await axios.get(
      `${config.manageOrders.baseUrl}/manageorders/orders`,
      {
        params: {
          date_Ordered_start: req.query.startDate,
          date_Ordered_end: req.query.endDate
        },
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        timeout: 30000
      }
    );

    res.json({
      orders: response.data.result || [],
      count: response.data.result?.length || 0
    });

  } catch (error) {
    console.error('Error fetching orders:', error.message);
    res.status(500).json({
      error: 'Failed to fetch orders from ManageOrders',
      details: error.message
    });
  }
});
```

---

## Integration Examples

### Browser Autocomplete (Customer Search)

```javascript
// Example: Customer autocomplete in screenprint-quote-builder.html
async function loadCustomers() {
  try {
    const response = await fetch(
      'https://caspio-pricing-proxy-ab30a049961a.herokuapp.com/api/manageorders/customers'
    );
    const data = await response.json();

    // Populate autocomplete
    const customerNames = data.customers.map(c => c.CustomerName);
    initializeAutocomplete('#customerInput', customerNames);

  } catch (error) {
    console.error('Failed to load customers:', error);
  }
}
```

### Customer Lookup by Name

```javascript
async function getCustomerByName(name) {
  const response = await fetch(
    'https://caspio-pricing-proxy-ab30a049961a.herokuapp.com/api/manageorders/customers'
  );
  const data = await response.json();

  return data.customers.find(c => c.CustomerName === name);
}
```

---

## References

### Documentation
- [ManageOrders API Swagger](https://app.swaggerhub.com/apis-docs/ShopWorks/ManageOrdersAPI/1.0.0)
- [ManageOrders API Specification](./MANAGEORDERS_API_SPEC.yaml)
- [ShopWorks Help Center](https://www.shopworkshelp.com/)

### Related Files
- [src/routes/manageorders.js](../src/routes/manageorders.js) - Route definitions
- [src/utils/manageorders.js](../src/utils/manageorders.js) - Utility functions
- [config.js](../config.js) - Configuration
- [server.js](../server.js) - Server setup with rate limiting

### Contact
- **ShopWorks Support:** support@shopworx.com
- **ShopWorks Sales:** sales@shopworx.com
- **Phone:** 800-526-6702

---

## Changelog

### v1.0.0 - 2025-10-26
- ✅ Initial implementation
- ✅ Customer endpoint with 60-day lookback
- ✅ Two-level caching (token + customers)
- ✅ Rate limiting (10 req/min)
- ✅ Phone number cleaning
- ✅ Customer deduplication
- ✅ Production deployment to Heroku
- ✅ Successfully tested with 389 unique customers from 912 orders
