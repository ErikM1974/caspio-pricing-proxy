# ManageOrders API Integration

**Last Updated:** 2026-03-27
**Status:** Production Ready
**Version:** 1.2.0

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

#### 3. GET /api/manageorders/orders

Query orders by date range with multiple filter options.

**Query Parameters:**
- `date_Ordered_start` / `date_Ordered_end` - Order placement date range
- `date_Invoiced_start` / `date_Invoiced_end` - Invoice date range
- `date_RequestedToShip_start` / `date_RequestedToShip_end` - Requested ship date
- `date_Produced_start` / `date_Produced_end` - Production date range
- `date_Shipped_start` / `date_Shipped_end` - Ship date range
- `id_Customer` - Filter by specific customer
- `refresh` (boolean) - Force cache refresh

**Cache:** 4 hours (with stale-while-revalidate)
**Usage:**
```bash
# Get October orders
curl "https://caspio-pricing-proxy-ab30a049961a.herokuapp.com/api/manageorders/orders?date_Ordered_start=2025-10-01&date_Ordered_end=2025-10-31"

# Get 2025 orders for a specific customer
curl "https://caspio-pricing-proxy-ab30a049961a.herokuapp.com/api/manageorders/orders?date_Invoiced_start=2025-01-01&date_Invoiced_end=2025-12-31&id_Customer=1821"
```

#### 4. GET /api/manageorders/orders/:order_no

Get specific order details by order number.

**Cache:** 24 hours (historical data)
**Usage:**
```bash
curl https://caspio-pricing-proxy-ab30a049961a.herokuapp.com/api/manageorders/orders/138145
```

#### 5. GET /api/manageorders/getorderno/:ext_order_id

Map external order ID to ManageOrders order number.

**Cache:** 24 hours
**Usage:** Useful for integrations with other systems (Shopify, WooCommerce, etc.)

#### 6. GET /api/manageorders/lineitems/:order_no

Get line items (products, quantities, pricing) for a specific order.

**Cache:** 24 hours
**Usage:**
```bash
curl https://caspio-pricing-proxy-ab30a049961a.herokuapp.com/api/manageorders/lineitems/138145
```

**Response:** Array of line items with Size01-06 quantities, custom fields, pricing

#### 7. GET /api/manageorders/payments

Query payments by date range.

**Query Parameters:**
- `date_PaymentApplied_start` / `date_PaymentApplied_end` - Payment date range
- `refresh` (boolean) - Force cache refresh

**Cache:** 4 hours (with stale-while-revalidate)
**Returns:** Both OnSite and Web payments

#### 8. GET /api/manageorders/payments/:order_no

Get payments for a specific order.

**Cache:** 24 hours
**Usage:**
```bash
curl https://caspio-pricing-proxy-ab30a049961a.herokuapp.com/api/manageorders/payments/138146
```

#### 9. GET /api/manageorders/tracking

Query tracking information by date range.

**Query Parameters:**
- `date_Creation_start` / `date_Creation_end` - Tracking created date
- `date_Imported_start` / `date_Imported_end` - Tracking import date
- `refresh` (boolean) - Force cache refresh

**Cache:** 30 minutes (with stale-while-revalidate)

#### 10. GET /api/manageorders/tracking/:order_no

Get tracking information for a specific order.

**Cache:** 15 minutes
**Usage:**
```bash
curl https://caspio-pricing-proxy-ab30a049961a.herokuapp.com/api/manageorders/tracking/138152
```

**Response:** Tracking numbers, carrier info, addresses, weight, cost

#### 11. GET /api/manageorders/inventorylevels ⭐ CRITICAL FOR WEBSTORE

Get real-time inventory levels with filters.

**Query Parameters:**
- `PartNumber` - Product part number (e.g., "PC54")
- `ColorRange` - Color range filter
- `Color` - Specific color
- `SKU` - SKU filter
- `VendorName` - Filter by vendor (e.g., "SANMAR")
- `date_Modification_start` / `date_Modification_end` - Last modified date
- `refresh` (boolean) - Force cache refresh

**Cache:** 3 minutes (real-time stock critical)
**Usage:**
```bash
# Check PC54 inventory
curl "https://caspio-pricing-proxy-ab30a049961a.herokuapp.com/api/manageorders/inventorylevels?PartNumber=PC54"
```

**Response:** Size01-06 quantities, costs, vendor info for each color variant

**Use Cases:**
- Show "In Stock" / "Out of Stock" on product pages
- Real-time availability checks during checkout
- Low inventory alerts
- Size availability matrix

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

**Multi-Level Cache:**

1. **Token Cache (1 hour)**
   - Stores `id_token` from ManageOrders authentication
   - Prevents repeated auth requests
   - Cleared on server restart

2. **Inventory Cache (3 minutes)** ⭐
   - Real-time stock availability
   - Critical for preventing overselling
   - Fastest refresh for accurate inventory

3. **Tracking Cache (30 minutes)**
   - Shipment status updates frequently
   - Balances freshness with API efficiency

4. **Query Caches (4 hours, with stale-while-revalidate)**
   - Orders by date range
   - Payments by date range
   - Parameter-aware (different params = different cache)
   - SWR returns stale data instantly, refreshes in background

5. **Historical Data Caches (24 hours)**
   - Orders by ID
   - Line items
   - Payments by order
   - Customers
   - Rarely changes after creation

**All caches support `?refresh=true` to force refresh**

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
  tokenCacheDuration: 3600000,        // 1 hour
  customerCacheDuration: 86400000,    // 1 day
  defaultDaysBack: 60,
  retryAttempts: 2,                   // Retries on timeout/5xx
  retryDelays: [1000, 3000],          // 1s, 3s backoff
  ordersCacheDuration: 14400000,      // 4 hours
  trackingCacheDuration: 1800000,     // 30 minutes
  paymentsCacheDuration: 14400000,    // 4 hours
  inventoryCacheDuration: 180000      // 3 minutes
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

### Performance Optimizations (v1.2.0 - March 2026)

**Problem:** ManageOrders API (ShopWorks) is inherently slow — queries a live ERP database with no server-side caching. Frequent timeouts and 10-30 second response times.

**Root Cause:** The bottleneck is the ManageOrders API itself (`manageordersapi.com`), not our proxy. Their API queries the ShopWorks OnSite production database in real-time.

**Optimizations Applied:**

| Optimization | Impact | Details |
|-------------|--------|---------|
| HTTP Keep-Alive | ~100-300ms/request saved | Reuses TCP connections via `https.Agent({ keepAlive: true })` |
| Gzip compression | Smaller payloads | `Accept-Encoding: gzip` on all requests |
| Retry with backoff | 50-70% fewer visible timeouts | 2 retries at 1s/3s delays on timeout or 5xx |
| Extended cache TTLs | Fewer API calls | Orders 1h→4h, tracking 15m→30m, payments 1h→4h, inventory 1m→3m |
| Stale-while-revalidate | Near-instant responses | Returns expired cache immediately, refreshes in background |

**Shared Axios Client:** All ManageOrders calls now use `moClient` — a shared axios instance with keep-alive agent, gzip headers, and the ManageOrders base URL pre-configured.

**Retry Logic:** Wraps all fetch functions with `withRetry()`. Catches transient errors:
- `ECONNABORTED` (timeout)
- `ETIMEDOUT`
- `ECONNRESET`
- HTTP 5xx responses

### Cache Durations (Updated v1.2.0)

| Cache Type | Duration | Change | Purpose |
|------------|----------|--------|---------|
| Token | 1 hour | unchanged | Prevent repeated authentication |
| Customers | 24 hours | unchanged | Reduce API calls, improve UX |
| Orders (range) | 4 hours | was 1 hour | Order data doesn't change rapidly |
| Orders by ID | 24 hours | unchanged | Historical data |
| Line Items | 24 hours | unchanged | Historical data |
| Payments (range) | 4 hours | was 1 hour | Payments rarely change after posting |
| Payments by order | 24 hours | unchanged | Historical data |
| Tracking (range) | 30 minutes | was 15 min | Tracking updates aren't real-time anyway |
| Tracking by order | 30 minutes | was 15 min | Same |
| Inventory | 3 minutes | was 1 min | Balance freshness vs speed |

### Stale-While-Revalidate (SWR)

Endpoints with SWR return cached data instantly even when the cache has expired. The background refresh updates the cache for the next request. Applied to:
- `/api/manageorders/orders` (range queries)
- `/api/manageorders/payments` (range and per-order)
- `/api/manageorders/tracking` (range queries)

### Diagnostics Endpoint

`GET /api/manageorders/health` — Measures round-trip times to ManageOrders API. Tests:
1. Authentication (sign-in)
2. Orders query (7-day window)
3. Inventory query (PC54 test)

Returns response times in milliseconds with ratings (fast/normal/slow/very slow). Use this data when contacting ShopWorks support.

### ShopWorks Support Contact Info

When reporting performance issues, share the `/health` endpoint results. Questions to ask:
1. "Our API calls take 10-30 seconds. Is this expected?"
2. "Can you check for missing database indexes?"
3. "Is there a way to request only specific fields?"
4. "Are there rate limits or throttling on our account?"
5. "Is there a newer API version with better performance?"

### Optimization Notes

- **60-day window** is optimal balance between data freshness and performance
- **Deduplication** reduces payload size from 912 to 389 records
- **Phone cleaning** happens during deduplication (no extra processing)

### Future Consideration: Caspio Import

If performance is still insufficient after v1.2.0 optimizations, consider importing ManageOrders data into Caspio tables on a schedule (every 1-4 hours). This would make reads blazing fast but adds sync complexity. Best candidates: `/customers` and `/orders` (slowest endpoints).

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

### v1.2.0 - 2026-03-27
- ✅ **PERFORMANCE OVERHAUL** — Address slow ManageOrders API response times
- ✅ HTTP Keep-Alive agent for TCP connection reuse (~100-300ms savings)
- ✅ Gzip compression on all ManageOrders requests
- ✅ Shared axios client (`moClient`) with pre-configured base URL and headers
- ✅ Retry logic with exponential backoff (2 retries at 1s/3s on timeout/5xx)
- ✅ Extended cache TTLs (orders 4h, tracking 30m, payments 4h, inventory 3m)
- ✅ Stale-while-revalidate pattern on orders, payments, tracking endpoints
- ✅ **New diagnostics endpoint** `GET /api/manageorders/health` — measures API response times
- ✅ All cache durations now configurable via `config.js`

### v1.1.0 - 2025-10-26
- ✅ **9 NEW ENDPOINTS ADDED** - Complete ManageOrders API integration
- ✅ Orders: Query by date range, get by ID, external ID lookup
- ✅ Line Items: Full order details with quantities and pricing
- ✅ Payments: Query and order-specific payment information
- ✅ Tracking: Real-time shipment tracking (15min cache)
- ✅ **Inventory: Real-time stock levels** ⭐ CRITICAL FOR WEBSTORE
- ✅ Smart caching strategy (5min to 24hr based on data type)
- ✅ Rate limiting increased to 30 req/min
- ✅ Parameter-aware caching for query endpoints
- ✅ Empty arrays for "not found" (200 status, not 404)
- ✅ All endpoints tested and deployed to Heroku
- ✅ Postman collection auto-updated (177 total endpoints)

### v1.0.0 - 2025-10-26
- ✅ Initial implementation
- ✅ Customer endpoint with 60-day lookback
- ✅ Two-level caching (token + customers)
- ✅ Rate limiting (10 req/min)
- ✅ Phone number cleaning
- ✅ Customer deduplication
- ✅ Production deployment to Heroku
- ✅ Successfully tested with 389 unique customers from 912 orders
