# Caspio Pricing Proxy API Developer Guide

## Table of Contents
1. [Getting Started](#getting-started)
2. [Authentication](#authentication)
3. [Making Requests](#making-requests)
4. [Pagination](#pagination)
5. [Error Handling](#error-handling)
6. [Rate Limiting](#rate-limiting)
7. [Best Practices](#best-practices)
8. [Common Integration Patterns](#common-integration-patterns)
9. [Performance Optimization](#performance-optimization)
10. [Troubleshooting](#troubleshooting)

---

## Getting Started

### Quick Setup

The Caspio Pricing Proxy API provides access to Northwest Custom Apparel's product catalog, pricing, orders, and more. Here's how to get started:

#### Base URLs
```
Production: https://caspio-pricing-proxy-ab30a049961a.herokuapp.com/api
Development: http://localhost:3002/api
```

#### Your First Request
```bash
# Health check
curl https://caspio-pricing-proxy-ab30a049961a.herokuapp.com/api/health

# Search for products
curl "https://caspio-pricing-proxy-ab30a049961a.herokuapp.com/api/products/search?q=polo"
```

### Required Headers
Most endpoints accept JSON and return JSON responses:
```
Content-Type: application/json
Accept: application/json
```

### Response Format
All successful responses return JSON. The structure varies by endpoint but generally follows:
```json
{
  "data": [...],     // For collections
  "field": "value"   // For single resources
}
```

---

## Authentication

Currently, the API is **publicly accessible** and does not require authentication tokens. This may change in future versions.

### Future Authentication (Planned)
When authentication is implemented, it will likely use:
- API key authentication
- OAuth 2.0 for user-specific operations
- JWT tokens for session management

---

## Making Requests

### HTTP Methods
- **GET**: Retrieve resources
- **POST**: Create new resources
- **PUT**: Update existing resources
- **DELETE**: Remove resources

### Request Parameters

#### Query Parameters (GET requests)
```bash
# Single parameter
GET /api/products/search?q=shirt

# Multiple parameters
GET /api/products/search?q=shirt&category=T-Shirts&limit=10

# Array parameters
GET /api/products/search?category[]=T-Shirts&category[]=Polos
```

#### Request Body (POST/PUT requests)
```javascript
POST /api/cart-items
Content-Type: application/json

{
  "SessionID": "session_123",
  "ProductID": "456",
  "StyleNumber": "PC61",
  "Color": "Navy"
}
```

### Common Parameters

| Parameter | Type | Description | Example |
|-----------|------|-------------|---------|
| `limit` | integer | Max results to return | `limit=50` |
| `page` | integer | Page number for pagination | `page=2` |
| `sort` | string | Sort order | `sort=price_asc` |
| `q` | string | Search query | `q=polo` |
| `q.where` | string | SQL-like filter | `q.where=Status='Active'` |
| `q.orderBy` | string | SQL-like sort | `q.orderBy=Date DESC` |

---

## Pagination

### Understanding Caspio Pagination

The API uses Caspio's backend, which implements pagination automatically. **IMPORTANT**: Always use endpoints that handle pagination internally.

### Pagination Strategies

#### 1. Limit-Based Pagination
Most endpoints support a `limit` parameter:
```bash
GET /api/products/search?limit=50
```

#### 2. Page-Based Pagination
Some endpoints support page numbers:
```bash
GET /api/products/search?page=2&limit=25
```

#### 3. Caspio Query Parameters
For direct Caspio table access:
```bash
GET /api/order-odbc?q.limit=100
```

### Pagination Response Format
```json
{
  "data": [...],
  "pagination": {
    "page": 1,
    "limit": 25,
    "totalPages": 10,
    "totalRecords": 250
  }
}
```

### Best Practices for Pagination
1. **Always specify a limit** to avoid overwhelming responses
2. **Default limits** are typically 100 records
3. **Maximum limits** are usually 1000 records
4. **Use appropriate page sizes** - 25-50 for UI display, 100-500 for batch processing

---

## Error Handling

### HTTP Status Codes

| Code | Meaning | Description |
|------|---------|-------------|
| 200 | OK | Request successful |
| 201 | Created | Resource created successfully |
| 400 | Bad Request | Invalid parameters or request body |
| 404 | Not Found | Resource not found |
| 500 | Internal Server Error | Server error - check error message |
| 503 | Service Unavailable | Caspio API temporarily unavailable |

### Error Response Format
```json
{
  "error": "ValidationError",
  "message": "Missing required field: StyleNumber",
  "errorId": "err_12345",
  "timestamp": "2025-01-15T10:30:00Z"
}
```

### Error Handling Examples

#### JavaScript
```javascript
try {
  const response = await fetch(`${API_URL}/product-details?styleNumber=PC61`);
  
  if (!response.ok) {
    const error = await response.json();
    console.error(`Error ${response.status}: ${error.message}`);
    
    // Handle specific errors
    switch(response.status) {
      case 404:
        console.log('Product not found');
        break;
      case 400:
        console.log('Invalid request parameters');
        break;
      default:
        console.log('Unexpected error occurred');
    }
  }
  
  const data = await response.json();
} catch (error) {
  console.error('Network error:', error);
}
```

#### Python
```python
import requests

try:
    response = requests.get(f'{API_URL}/product-details', 
                           params={'styleNumber': 'PC61'})
    response.raise_for_status()
    data = response.json()
    
except requests.exceptions.HTTPError as e:
    if e.response.status_code == 404:
        print('Product not found')
    elif e.response.status_code == 400:
        error_data = e.response.json()
        print(f'Bad request: {error_data.get("message")}')
    else:
        print(f'HTTP error: {e}')
        
except requests.exceptions.RequestException as e:
    print(f'Request failed: {e}')
```

---

## Rate Limiting

### Current Limits
The API currently does not enforce strict rate limits, but please follow these guidelines:

- **Recommended**: 100 requests per minute
- **Burst**: Up to 10 concurrent requests
- **Large queries**: Space out by 1-2 seconds

### Best Practices
1. **Implement exponential backoff** for retries
2. **Cache responses** when appropriate
3. **Batch operations** where possible
4. **Use webhooks** for real-time updates (when available)

### Rate Limit Headers (Future)
When rate limiting is implemented, look for these headers:
```
X-RateLimit-Limit: 1000
X-RateLimit-Remaining: 999
X-RateLimit-Reset: 1640995200
```

---

## Best Practices

### 1. Use Appropriate Endpoints
```javascript
// ❌ Don't make multiple requests
const details = await fetch('/product-details?styleNumber=PC61');
const inventory = await fetch('/inventory?styleNumber=PC61');
const prices = await fetch('/base-item-costs?styleNumber=PC61');

// ✅ Use combined endpoints when available
const product = await fetch('/products/search?q=PC61&includeFacets=true');
```

### 2. Handle Pagination Properly
```javascript
// ❌ Don't fetch everything at once
const allProducts = await fetch('/products/search?limit=10000');

// ✅ Paginate through results
async function getAllProducts() {
  let page = 1;
  let allProducts = [];
  let hasMore = true;
  
  while (hasMore) {
    const response = await fetch(`/products/search?page=${page}&limit=100`);
    const data = await response.json();
    allProducts = [...allProducts, ...data.products];
    hasMore = data.pagination.page < data.pagination.totalPages;
    page++;
  }
  
  return allProducts;
}
```

### 3. Cache Frequently Used Data
```javascript
class APICache {
  constructor(ttl = 60000) { // 1 minute default
    this.cache = new Map();
    this.ttl = ttl;
  }
  
  async get(key, fetcher) {
    const cached = this.cache.get(key);
    
    if (cached && Date.now() - cached.timestamp < this.ttl) {
      return cached.data;
    }
    
    const data = await fetcher();
    this.cache.set(key, { data, timestamp: Date.now() });
    return data;
  }
}

const cache = new APICache();
const brands = await cache.get('brands', 
  () => fetch('/api/all-brands').then(r => r.json())
);
```

### 4. Validate Input
```javascript
function validateStyleNumber(styleNumber) {
  // Style numbers are typically alphanumeric
  const pattern = /^[A-Z0-9]+$/i;
  if (!pattern.test(styleNumber)) {
    throw new Error('Invalid style number format');
  }
  return styleNumber;
}

// Use validation before API calls
try {
  const style = validateStyleNumber(userInput);
  const response = await fetch(`/api/product-details?styleNumber=${style}`);
} catch (error) {
  console.error('Validation failed:', error);
}
```

---

## Common Integration Patterns

### 1. Product Catalog Integration
```javascript
class ProductCatalog {
  constructor(apiUrl) {
    this.apiUrl = apiUrl;
  }
  
  async searchProducts(query, filters = {}) {
    const params = new URLSearchParams({ q: query, ...filters });
    const response = await fetch(`${this.apiUrl}/products/search?${params}`);
    return response.json();
  }
  
  async getProductWithDetails(styleNumber, color) {
    const [details, inventory, pricing] = await Promise.all([
      fetch(`${this.apiUrl}/product-details?styleNumber=${styleNumber}&color=${color}`),
      fetch(`${this.apiUrl}/inventory?styleNumber=${styleNumber}&color=${color}`),
      fetch(`${this.apiUrl}/base-item-costs?styleNumber=${styleNumber}`)
    ]);
    
    return {
      details: await details.json(),
      inventory: await inventory.json(),
      pricing: await pricing.json()
    };
  }
}
```

### 2. Shopping Cart Workflow
```javascript
class ShoppingCart {
  async createOrder(cartSession, customerInfo) {
    // 1. Get cart items
    const items = await fetch(`/api/cart-items?sessionID=${cartSession}`);
    
    // 2. Create/find customer
    let customer = await fetch(`/api/customers?email=${customerInfo.email}`);
    if (!customer) {
      customer = await fetch('/api/customers', {
        method: 'POST',
        body: JSON.stringify(customerInfo)
      });
    }
    
    // 3. Create order
    const order = await fetch('/api/orders', {
      method: 'POST',
      body: JSON.stringify({
        CustomerID: customer.id,
        SessionID: cartSession,
        OrderStatus: 'Pending'
      })
    });
    
    // 4. Update cart items with order ID
    for (const item of items) {
      await fetch(`/api/cart-items/${item.id}`, {
        method: 'PUT',
        body: JSON.stringify({ OrderID: order.id })
      });
    }
    
    return order;
  }
}
```

### 3. Real-time Inventory Check
```javascript
async function checkAvailability(styleNumber, color, quantities) {
  // Get current inventory
  const inventory = await fetch(
    `/api/inventory?styleNumber=${styleNumber}&color=${color}`
  ).then(r => r.json());
  
  // Check each size
  const availability = {};
  for (const [size, needed] of Object.entries(quantities)) {
    const stock = inventory.find(i => i.SIZE === size);
    availability[size] = {
      requested: needed,
      available: stock?.QTY_AVAILABLE || 0,
      inStock: (stock?.QTY_AVAILABLE || 0) >= needed
    };
  }
  
  return availability;
}
```

### 4. Dashboard Analytics
```javascript
class AnalyticsDashboard {
  async getComprehensiveMetrics() {
    const [week, month, year] = await Promise.all([
      fetch('/api/order-dashboard?days=7').then(r => r.json()),
      fetch('/api/order-dashboard?days=30&includeDetails=true').then(r => r.json()),
      fetch('/api/order-dashboard?days=365&compareYoY=true').then(r => r.json())
    ]);
    
    return {
      weekly: {
        orders: week.summary.totalOrders,
        sales: week.summary.totalSales,
        today: week.todayStats
      },
      monthly: {
        orders: month.summary.totalOrders,
        sales: month.summary.totalSales,
        topCSR: month.breakdown.byCsr[0],
        recentOrders: month.recentOrders
      },
      yearly: {
        growth: year.yoyComparison?.salesGrowthPercent,
        totalSales: year.summary.totalSales
      }
    };
  }
}
```

---

## Performance Optimization

### 1. Use Optimized Bundle Endpoints (🚀 RECOMMENDED)
The API provides optimized bundle endpoints that consolidate multiple requests:

```javascript
// ❌ Multiple API calls - slow (DTG pricing scenario)
const [colors, tiers, costs, pricing] = await Promise.all([
  fetch(`/api/product-colors?styleNumber=${styleNumber}`),
  fetch('/api/pricing-tiers?method=DTG'),
  fetch('/api/dtg-costs'),
  fetch(`/api/max-prices-by-style?styleNumber=${styleNumber}`)
]);

// ✅ Single optimized bundle - 2-3x faster
const dtgBundle = await fetch(
  `/api/dtg/product-bundle?styleNumber=${styleNumber}&color=${color}`
);

// Complete DTG data in one request:
const data = await dtgBundle.json();
const {
  product,    // Product details and colors
  pricing: {
    tiers,    // DTG pricing tiers
    costs,    // Print costs by location
    sizes,    // Size-based pricing
    upcharges // Size upcharges
  }
} = data;
```

**Performance Benefits:**
- ✅ **2-3x faster** loading for DTG pricing pages
- ✅ **Atomic consistency** - all data from same moment
- ✅ **Server-side cache** - 5-minute cache reduces load
- ✅ **Reduced overhead** - Single HTTP request vs 4 requests

### 2. Batch Requests
Instead of multiple sequential requests, batch them:
```javascript
// ❌ Sequential - slow
const product1 = await fetch('/api/product-details?styleNumber=PC61');
const product2 = await fetch('/api/product-details?styleNumber=PC54');
const product3 = await fetch('/api/product-details?styleNumber=PC55');

// ✅ Parallel - fast
const [product1, product2, product3] = await Promise.all([
  fetch('/api/product-details?styleNumber=PC61'),
  fetch('/api/product-details?styleNumber=PC54'),
  fetch('/api/product-details?styleNumber=PC55')
]);
```

### 3. Use Field Selection
When available, request only needed fields:
```bash
# Request specific fields only
GET /api/artrequests?select=PK_ID,Status,CompanyName,Date_Created
```

### 3. Implement Client-Side Caching
```javascript
class CachedAPIClient {
  constructor() {
    this.cache = new Map();
    this.cacheTime = 5 * 60 * 1000; // 5 minutes
  }
  
  async fetchWithCache(url) {
    const cached = this.cache.get(url);
    
    if (cached && Date.now() - cached.time < this.cacheTime) {
      return cached.data;
    }
    
    const response = await fetch(url);
    const data = await response.json();
    
    this.cache.set(url, { data, time: Date.now() });
    return data;
  }
}
```

### 4. Optimize Search Queries
```javascript
// ❌ Broad search - returns too much data
const results = await fetch('/api/products/search?q=s');

// ✅ Specific search with filters
const results = await fetch(
  '/api/products/search?q=shirt&category=T-Shirts&limit=25&includeFacets=false'
);
```

### 5. Connection Pooling
For Node.js applications:
```javascript
const https = require('https');
const agent = new https.Agent({
  keepAlive: true,
  maxSockets: 10
});

// Reuse connections
fetch(url, { agent });
```

---

## Troubleshooting

### Common Issues and Solutions

#### 1. Empty Response
**Problem**: API returns empty array or null
```javascript
// Check if parameters are correct
console.log('Request URL:', url);
console.log('Parameters:', params);

// Verify data exists
const testResponse = await fetch('/api/products/search?q=PC61');
```

#### 2. 500 Internal Server Error
**Possible causes:**
- Invalid characters in parameters (use URL encoding)
- Caspio backend temporarily unavailable
- Malformed request body

**Solution:**
```javascript
// Properly encode parameters
const params = new URLSearchParams({
  styleNumber: 'PC61',
  color: 'Navy & White' // Will be encoded properly
});
```

#### 3. Slow Response Times
**Optimize your queries:**
```javascript
// Add specific filters
// Reduce limit
// Use caching
// Avoid wildcards in searches
```

#### 4. Data Inconsistencies
**Handle dynamic fields:**
```javascript
// Caspio tables may have dynamic fields
const processRecord = (record) => {
  return {
    id: record.PK_ID || record.ID || null,
    status: record.Status || 'Unknown',
    // Handle potentially missing fields
    invoiced: record.Invoiced ?? false,
    invoicedDate: record.Invoiced_Date || null
  };
};
```

### Debug Mode
Enable detailed logging:
```javascript
class DebugAPIClient {
  async request(url, options = {}) {
    console.log('📤 Request:', { url, ...options });
    
    const start = Date.now();
    const response = await fetch(url, options);
    const duration = Date.now() - start;
    
    console.log('📥 Response:', {
      status: response.status,
      duration: `${duration}ms`,
      headers: Object.fromEntries(response.headers)
    });
    
    if (!response.ok) {
      const error = await response.text();
      console.error('❌ Error:', error);
    }
    
    return response;
  }
}
```

### Getting Help

1. **Check the API documentation**: Review endpoint specifications
2. **Test with cURL**: Verify the API is working
3. **Check server status**: `GET /api/health`
4. **Review error messages**: They often indicate the exact issue
5. **Contact support**: support@nwcustomapparel.com

---

## Appendix

### Useful Resources
- [OpenAPI Specification](./api-specification.yaml)
- [SDK Examples](./sdk-examples/)
- [Postman Collection](./postman-collection.json)
- [API Changelog](./CHANGELOG.md)

### Environment Variables
For local development:
```bash
API_BASE_URL=http://localhost:3002/api
TIMEOUT=30000
RETRY_ATTEMPTS=3
CACHE_TTL=300000
```

### Testing Tools
- **Postman**: Import the collection for interactive testing
- **cURL**: Command-line testing (see examples)
- **HTTPie**: User-friendly command-line HTTP client
- **Insomnia**: Alternative to Postman

### Version History
- **v1.0.0** (Current): Initial public release
- **v1.1.0** (Planned): Authentication implementation
- **v1.2.0** (Planned): WebSocket support for real-time updates