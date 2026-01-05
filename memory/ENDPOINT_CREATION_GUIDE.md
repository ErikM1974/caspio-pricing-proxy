# API Endpoint Creation Guide

Step-by-step guide for creating new Caspio API proxy endpoints in the caspio-pricing-proxy application.

## Overview

This guide walks through the standard process for adding new API endpoints that proxy Caspio table data. Most endpoints follow a simple pattern and can be created in 15-30 minutes.

## Before You Start

You'll need:
- Caspio Swagger API response for the table
- Understanding of the data being exposed
- Basic knowledge of Express.js routes

## Step-by-Step Process

### Step 1: Provide the Swagger Response

First, paste the complete Swagger response from Caspio, including:
- The endpoint path (e.g., `/v3/tables/{tableName}/records`)
- All available parameters
- Example curl command
- Sample response data

**Example Swagger URL**:
```
https://c3eku948.caspio.com/integrations/swagger/index.html
```

### Step 2: Determine Endpoint Path

**Question**: "What should the API endpoint path be?"

**Guidelines**:
- Look at the table name from Swagger
- Follow existing patterns (use kebab-case)
- Make it RESTful and intuitive

**Examples**:
- `Production_Schedules` → `/api/production-schedules`
- `ORDER_ODBC` → `/api/order-odbc`
- `Sanmar_Bulk_251816_Feb2024` → `/api/products/search` (semantic name)
- `Art_Invoices` → `/api/art-invoices`

**Tip**: Use semantic names for user-facing features, technical names for admin/internal APIs.

### Step 3: Choose Query Parameters

**Question**: "Which query parameters do you need?"

**Standard Three** (recommended for most endpoints):
- `q.where` - For filtering records (e.g., `status='Active'`)
- `q.orderBy` - For sorting results (e.g., `date_Created DESC`)
- `q.limit` - For controlling response size (default: 100, max: 1000)

**Ask**: "Do you want the standard three (where, orderBy, limit) or do you need something special?"

**Tips for recommendations based on data type**:

| Data Type | Recommended Parameters |
|-----------|------------------------|
| Orders/Transactions | where (date ranges, status), orderBy (date, amount), limit |
| Reference Data | limit only (maybe orderBy for alphabetical) |
| Reports/Analytics | where, orderBy, possibly groupBy |
| Products/Catalog | where, orderBy, limit, possibly custom filters |

**Example**:
```javascript
app.get('/api/order-odbc', async (req, res) => {
  const where = req.query.where;  // e.g., "date_OrderPlaced > '2025-01-01'"
  const orderBy = req.query.orderBy;  // e.g., "date_OrderPlaced DESC"
  const limit = parseInt(req.query.limit) || 100;  // default 100

  // ... implementation
});
```

### Step 4: Choose Response Format

**Question**: "How should the response be formatted?"

**Option A: Simple Array** (recommended for most cases)
- Return records exactly as they come from Caspio
- Same as production-schedules, pricing-tiers endpoints
- Example: `[{record1}, {record2}]`

**When to use**:
- Raw data access
- Client will handle formatting
- Data is already well-structured

**Example**:
```javascript
const records = await fetchAllCaspioPages(resourcePath, params);
return res.json(records);  // Simple array
```

**Option B: Transformed Object**
- Convert to a specific format
- Same as pricing-rules, embroidery-costs endpoints
- Example: `{ "key1": "value1", "key2": "value2" }`

**When to use**:
- Need to reshape data structure
- Aggregating/grouping results
- Creating lookup objects

**Example**:
```javascript
const records = await fetchAllCaspioPages(resourcePath, params);
const transformed = records.reduce((acc, record) => {
  acc[record.id] = record.value;
  return acc;
}, {});
return res.json(transformed);  // Object
```

### Step 5: Special Requirements

**Question**: "Any special requirements?"

**Common requirements**:
- Field validation or transformation
- Hide sensitive fields (passwords, internal IDs)
- Add business logic (calculations, enrichment)
- Custom error messages
- Or just "return everything as-is"? (most common)

**Example - Hide sensitive fields**:
```javascript
const records = await fetchAllCaspioPages(resourcePath, params);
const sanitized = records.map(r => {
  delete r.internal_id;
  delete r.password_hash;
  return r;
});
return res.json(sanitized);
```

## Critical: Caspio Pagination

**CRITICAL RULE**: Caspio API uses pagination. Results may be split across multiple pages.

### ALWAYS Use fetchAllCaspioPages

```javascript
// ✅ CORRECT - Gets ALL records across all pages
const records = await fetchAllCaspioPages(resourcePath, params);

// ❌ WRONG - Only gets first page (max 1000 records)
const response = await makeCaspioRequest('get', resourcePath, params);
```

### Why This Matters

**Real Example**: We had brands like "OGIO" on the second page that weren't being returned when using `makeCaspioRequest`. This caused incomplete data and bugs.

**How pagination works**:
1. Caspio returns max 1000 records per request
2. If there are more records, `NextPageUrl` is provided
3. `fetchAllCaspioPages` automatically follows all pages
4. `makeCaspioRequest` only gets the first page

### fetchAllCaspioPages Usage

```javascript
const { fetchAllCaspioPages } = require('./src/utils/caspio');

// Basic usage
const records = await fetchAllCaspioPages('/tables/MyTable/records', {
  'q.where': "status='Active'",
  'q.limit': 1000  // Per-page limit, not total limit
});

// With options
const records = await fetchAllCaspioPages('/tables/MyTable/records',
  { 'q.where': "status='Active'" },
  {
    maxPages: 10,  // Safety limit
    totalTimeout: 30000,  // 30 seconds max
    earlyExitCondition: (pageResults, allResults) => allResults.length >= 100
  }
);
```

## Standard Implementation Pattern

Most endpoints will follow this pattern:

1. **Add to routes file** (modular, not server.js directly)
2. **Use Caspio API v3** (or v2 for consistency with existing code)
3. **Public access** (no authentication unless specified)
4. **Standard error handling** (400 for bad params, 500 for server errors)
5. **ALWAYS use `fetchAllCaspioPages`** for pagination

## Complete Example

### Example: ORDER_ODBC Endpoint

**User provides**: Swagger response for ORDER_ODBC table

**Questions & Answers**:
1. **Endpoint path**? → `/api/order-odbc`
2. **Query parameters**? → Standard three (where, orderBy, limit)
3. **Response format**? → Simple array
4. **Special requirements**? → Return everything as-is

**Implementation** (`src/routes/orders.js`):

```javascript
const express = require('express');
const router = express.Router();
const { fetchAllCaspioPages } = require('../utils/caspio');

// GET /api/order-odbc
router.get('/order-odbc', async (req, res) => {
  try {
    // 1. Extract query parameters
    const where = req.query.where;
    const orderBy = req.query.orderBy;
    const limit = parseInt(req.query.limit) || 100;

    // 2. Validate parameters (optional)
    if (limit > 1000) {
      return res.status(400).json({
        success: false,
        error: 'Limit cannot exceed 1000'
      });
    }

    // 3. Build Caspio query parameters
    const params = {};
    if (where) params['q.where'] = where;
    if (orderBy) params['q.orderBy'] = orderBy;
    params['q.limit'] = limit;

    // 4. Fetch all records (handles pagination automatically!)
    const records = await fetchAllCaspioPages('/tables/ORDER_ODBC/records', params);

    // 5. Return simple array
    res.json(records);

  } catch (error) {
    console.error('Error fetching ORDER_ODBC:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

module.exports = router;
```

**Register in `server.js`**:
```javascript
const orderRoutes = require('./src/routes/orders');
app.use('/api', orderRoutes);
```

## Implementation Checklist

Before deploying, verify:

- [ ] Using `fetchAllCaspioPages` (NOT `makeCaspioRequest` for multi-record queries)
- [ ] Query parameters are validated
- [ ] Error handling is in place (try/catch)
- [ ] Response format is correct (array or object)
- [ ] Tested with Postman/curl locally
- [ ] Tested with pagination (>1000 records if applicable)
- [ ] Console logging for debugging
- [ ] Route is registered in server.js or main route file
- [ ] API documentation updated (if needed)
- [ ] Committed and deployed

## Common Patterns

### Pattern 1: Simple Passthrough

Just proxy Caspio data as-is:

```javascript
router.get('/my-endpoint', async (req, res) => {
  try {
    const records = await fetchAllCaspioPages('/tables/MyTable/records', {
      'q.where': req.query.where,
      'q.limit': 1000
    });
    res.json(records);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});
```

### Pattern 2: With Transformation

Transform Caspio data before returning:

```javascript
router.get('/my-endpoint', async (req, res) => {
  try {
    const records = await fetchAllCaspioPages('/tables/MyTable/records', {});

    // Transform to lookup object
    const lookup = records.reduce((acc, record) => {
      acc[record.id] = record.name;
      return acc;
    }, {});

    res.json(lookup);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});
```

### Pattern 3: With Caching

Add caching for high-traffic endpoints:

```javascript
const myCache = new Map();
const CACHE_TTL = 15 * 60 * 1000;  // 15 minutes

router.get('/my-endpoint', async (req, res) => {
  try {
    // Check cache
    const cacheKey = JSON.stringify(req.query);
    const cached = myCache.get(cacheKey);
    const forceRefresh = req.query.refresh === 'true';

    if (!forceRefresh && cached && Date.now() - cached.timestamp < CACHE_TTL) {
      console.log('[CACHE HIT] my-endpoint');
      return res.json(cached.data);
    }

    console.log('[CACHE MISS] my-endpoint');

    // Fetch from Caspio
    const records = await fetchAllCaspioPages('/tables/MyTable/records', {});

    // Cache the result
    myCache.set(cacheKey, {
      data: records,
      timestamp: Date.now()
    });

    // FIFO eviction
    if (myCache.size > 100) {
      const firstKey = myCache.keys().next().value;
      myCache.delete(firstKey);
    }

    res.json(records);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});
```

## Advanced Topics

### Custom Query Building

For complex queries, build the where clause programmatically:

```javascript
router.get('/advanced-search', async (req, res) => {
  try {
    const { status, minDate, maxDate, category } = req.query;

    // Build where clause
    const conditions = [];
    if (status) conditions.push(`status='${status}'`);
    if (minDate) conditions.push(`date_Created >= '${minDate}'`);
    if (maxDate) conditions.push(`date_Created <= '${maxDate}'`);
    if (category) conditions.push(`category='${category}'`);

    const where = conditions.join(' AND ');

    const records = await fetchAllCaspioPages('/tables/MyTable/records', {
      'q.where': where,
      'q.limit': 1000
    });

    res.json(records);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});
```

### Pagination for Client

If client wants to paginate results themselves:

```javascript
router.get('/my-endpoint', async (req, res) => {
  try {
    // Get ALL records from Caspio (handles Caspio pagination)
    const allRecords = await fetchAllCaspioPages('/tables/MyTable/records', {});

    // Client-side pagination
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const offset = (page - 1) * limit;

    const paginatedRecords = allRecords.slice(offset, offset + limit);

    res.json({
      data: paginatedRecords,
      pagination: {
        page,
        limit,
        total: allRecords.length,
        totalPages: Math.ceil(allRecords.length / limit)
      }
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});
```

## Testing Your Endpoint

### 1. Local Testing

```bash
# Start server
PORT=3002 node server.js

# Test endpoint
curl "http://localhost:3002/api/my-endpoint?where=status='Active'&limit=10"
```

### 2. Test Pagination

```bash
# Test with large dataset (should return >1000 records if available)
curl "http://localhost:3002/api/my-endpoint?limit=1000"

# Check logs for pagination messages:
# [Pagination] Page 1: Fetched 1000 records
# [Pagination] Page 2: Fetched 543 records
# Total records fetched: 1543 from 2 page(s)
```

### 3. Test Error Handling

```bash
# Invalid parameter
curl "http://localhost:3002/api/my-endpoint?limit=999999"

# Should return 400 error
```

### 4. Test Caching (if implemented)

```bash
# First request (cache miss)
curl "http://localhost:3002/api/my-endpoint"
# Logs: [CACHE MISS] my-endpoint

# Second request (cache hit)
curl "http://localhost:3002/api/my-endpoint"
# Logs: [CACHE HIT] my-endpoint

# Force refresh
curl "http://localhost:3002/api/my-endpoint?refresh=true"
# Logs: [CACHE MISS] my-endpoint
```

## Troubleshooting

### Incomplete Data Returned

**Symptom**: Only getting first 1000 records

**Fix**: Use `fetchAllCaspioPages` instead of `makeCaspioRequest`

### Slow Response Times

**Symptom**: Endpoint takes >5 seconds to respond

**Solutions**:
1. Add caching (see Pattern 3 above)
2. Add indexes in Caspio table
3. Reduce q.limit for pagination
4. Add early exit condition in fetchAllCaspioPages

### Cache Not Working

**Symptom**: Always seeing [CACHE MISS]

**Checks**:
1. Cache key includes all relevant parameters
2. TTL not too short
3. Cache not being evicted too quickly (increase size limit)

## Related Documentation

- [API Usage Tracking](API_USAGE_TRACKING.md) - Monitor API call usage
- [Local Development](LOCAL_DEVELOPMENT.md) - Running locally for testing
- [BLANK Pricing](BLANK_PRICING.md) - Example of complex endpoint implementation

## Summary

Creating new endpoints:

1. ✅ Get Swagger response from Caspio
2. ✅ Determine endpoint path (kebab-case, RESTful)
3. ✅ Choose query parameters (usually where/orderBy/limit)
4. ✅ Choose response format (array or object)
5. ✅ **ALWAYS use fetchAllCaspioPages** for pagination
6. ✅ Add error handling (try/catch, 400/500 status codes)
7. ✅ Test locally with curl/Postman
8. ✅ Deploy and monitor

Most endpoints can be created in **15-30 minutes** following this guide!
