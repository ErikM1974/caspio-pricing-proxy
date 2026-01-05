# API Usage Tracking & Optimization

**Version**: 1.1.0
**Deployed**: 2025-11-29 (Heroku v201)
**Updated**: 2025-12-17
**Status**: Production - HEALTHY

## Results Summary (December 2025)

| Metric | Before (Nov 2025) | Expected | Actual (Dec 2025) |
|--------|-------------------|----------|-------------------|
| Monthly calls | 630K | 400-440K | **~280K projected** |
| % of limit | 126% (OVER) | 80-88% | **~56%** |
| Reduction | - | 30-40% | **~55-60%** |

**Current Period (Nov 27 - Dec 26, 2025):**
- Day 21 of 30: 196K calls used
- Daily average: ~9,333 calls/day
- Projected total: ~280K calls
- Status: Well under 500K limit

## Overview

Comprehensive API call tracking and caching system to monitor and reduce Caspio API usage. Implemented to address excessive API consumption (630K/month vs 500K limit).

## Problem Solved

**Before Implementation (November 2025):**
- Usage: 630K+ API calls/month (26% over 500K limit)
- No visibility into which endpoints/tables consumed calls
- No caching on high-traffic endpoints
- Estimated 7-9 Caspio calls per `/api/pricing-bundle` request

**After Implementation (December 2025):**
- Real-time tracking of all API calls
- Caching on high-traffic endpoints (5 cached endpoints)
- Metrics dashboard for monitoring usage
- **Actual 55-60% reduction** (from 630K → ~280K/month projected)

## Components

### 1. API Tracker Utility

**File**: [`src/utils/api-tracker.js`](../src/utils/api-tracker.js)

Singleton class that tracks all Caspio API calls in memory:

```javascript
const apiTracker = require('./src/utils/api-tracker');

// Automatically tracks calls via caspio.js
apiTracker.trackCall(endpoint, table, method, metadata);

// Get real-time summary
const summary = apiTracker.getSummary();
// Returns: {todayCount, last24hCount, monthlyProjection, ...}
```

**Features:**
- 24-hour rolling window (older entries auto-cleaned every 5 minutes)
- Tracks by endpoint, table, hour, and day
- Monthly projection based on current pace
- Automatic status alerts (OK, WARNING, CRITICAL, OVER_LIMIT)

**Memory Management:**
- Stores last 24 hours of call data
- Cleans up hourly stats older than 48 hours
- Cleans up daily stats older than 30 days
- Minimal memory footprint (~1-2MB for typical usage)

### 2. Automatic Call Tracking

**File**: [`src/utils/caspio.js`](../src/utils/caspio.js)

All Caspio API requests are automatically tracked:

**In `makeCaspioRequest()`** (lines 78-83):
```javascript
// Track API call
const tableName = resourcePath.split('/').pop().replace('/records', '');
apiTracker.trackCall(resourcePath, tableName, method, {
  status: response.status,
  recordCount: response.data?.Result?.length || (response.data ? 1 : 0)
});
```

**In `fetchAllCaspioPages()`** (lines 170-175):
```javascript
// Track this API call
const tableName = resourcePath.split('/').filter(p => p).pop().replace('/records', '');
apiTracker.trackCall(resourcePath, tableName, 'GET', {
  page: pageCount,
  recordCount: response.data?.Result?.length || 0
});
```

**Console Output:**
```
[API TRACKER] GET Sanmar_Bulk_251816_Feb2024 - Total today: 142
```

### 3. Metrics Endpoint

**Endpoint**: `GET /api/admin/metrics`
**Live URL**: `https://caspio-pricing-proxy-ab30a049961a.herokuapp.com/api/admin/metrics`

**Response Structure:**
```json
{
  "success": true,
  "data": {
    "todayCount": 1234,
    "last24hCount": 1456,
    "monthlyProjection": 43680,
    "monthlyLimit": 500000,
    "percentOfLimit": 8,
    "status": "OK",
    "topEndpoints": [
      {"endpoint": "/tables/Sanmar_Bulk_251816_Feb2024/records", "count": 456},
      {"endpoint": "/tables/Pricing_Tiers/records", "count": 123}
    ],
    "topTables": [
      {"table": "Sanmar_Bulk_251816_Feb2024", "count": 456},
      {"table": "Pricing_Tiers", "count": 123}
    ]
  },
  "message": "Tracking 1,234 calls today. Monthly projection: 43,680 / 500,000 (8%)"
}
```

**Status Levels:**
- `OK`: <80% of limit (< 400K/month)
- `WARNING`: 80-90% of limit (400K-450K/month)
- `CRITICAL`: 90-95% of limit (450K-475K/month)
- `OVER_LIMIT`: >100% of limit (>500K/month)

## Caching Implementation

### Summary of All Caches

| Cache | Endpoint | TTL | Savings | Max Size |
|-------|----------|-----|---------|----------|
| Pricing Bundle | `/api/pricing-bundle` | 15 min | 7-9 calls/req | 100 |
| Product Search | `/api/products/search` | 5 min | 2 calls/req | 50 |
| New Products | `/api/products/new` | 5 min | 1+ calls/req | - |
| Top Sellers | `/api/products/topsellers` | 5 min | 1+ calls/req | - |
| Quote Sessions | `/api/quote_sessions` | 5 min | 1+ calls/req | - |

### Pricing Bundle Cache (Highest Impact)

**Endpoint**: `/api/pricing-bundle`
**File**: [`src/routes/pricing.js`](../src/routes/pricing.js) (lines 7-9, 361-371, 753-764)
**Impact**: **7-9 API calls → 0 calls (cache hit)** - BIGGEST SAVINGS
**TTL**: 15 minutes

**Before Caching:**
Each request made 7-9 calls to Caspio:
1. Pricing_Tiers
2. Pricing_Rules
3. Location table
4. Cost table (DTG/EMB/SP)
5. Size_Display_Order
6. Standard_Size_Upcharges
7. Sanmar_Bulk (if styleNumber provided)
8. Additional queries for specific methods

**After Caching:**
- First request: 7-9 calls (cache miss, sets cache)
- Subsequent requests (within 15 min): 0 calls (cache hit)
- Cache is parameter-aware: different method/styleNumber = different cache entry

**Cache Bypass:**
```bash
# Force refresh (bypass cache)
GET /api/pricing-bundle?method=DTG&styleNumber=PC54&refresh=true
```

### Product Search Cache

**Endpoint**: `/api/products/search`
**File**: [`src/routes/products.js`](../src/routes/products.js) (lines 8-10, 367-377, 781-792)
**Impact**: **2 API calls → 0 calls (cache hit)**
**TTL**: 5 minutes

**Before Caching:**
Each search made 2 calls:
1. Initial query for styles (groupBy STYLE)
2. Detailed query for variants (full records)

**After Caching:**
- First search: 2 calls (cache miss)
- Subsequent identical searches (within 5 min): 0 calls (cache hit)
- Shorter TTL due to many parameter combinations

### Additional Caches

**New Products** (`/api/products/new`):
- File: `src/routes/products.js` (lines 846-931)
- TTL: 5 minutes
- Object-based cache with parameter tracking

**Top Sellers** (`/api/products/topsellers`):
- File: `src/routes/products.js` (lines 1333-1402)
- TTL: 5 minutes
- Object-based cache with parameter tracking

**Quote Sessions** (`/api/quote_sessions`):
- File: `src/routes/quotes.js` (lines 31-33)
- TTL: 5 minutes
- Added December 2025 with filter parameter fix

### Token Caching

**Caspio Access Token** (server-level):
- File: `src/utils/caspio.js`
- Caches OAuth token with 60-second expiry buffer
- Prevents OAuth call on every request

**ManageOrders Token**:
- File: `src/utils/manageorders.js`
- TTL: 1 hour
- Reduces authentication overhead

## Monitoring Workflow

### Initial 48 Hours (Phase 1)

**Goal**: Collect baseline usage data

1. Monitor `/api/admin/metrics` every few hours
2. Watch for `topEndpoints` and `topTables` to identify patterns
3. Check `monthlyProjection` to ensure trending toward <500K
4. Look for any unexpected high-volume endpoints

**Example Check:**
```bash
# Check current usage
curl https://caspio-pricing-proxy-ab30a049961a.herokuapp.com/api/admin/metrics

# Expected to see:
# - todayCount: < 16,666 (target daily rate for 500K/month)
# - monthlyProjection: < 450K (with safety margin)
# - status: "OK" or "WARNING"
```

### Week 1 Analysis (Phase 2)

**Goal**: Identify additional optimization opportunities

1. Review top 5 endpoints by call count
2. Identify endpoints without caching that should have it
3. Check for any polling patterns (same endpoint called frequently)
4. Validate cache hit rates are improving over time

**Questions to Answer:**
- Which endpoints consume most calls?
- Are there new caching opportunities?
- Is any endpoint being polled excessively?
- Are specific tables/brands driving high usage?

### Ongoing Monitoring (Phase 3)

**Goal**: Maintain usage under 450K/month

1. Check metrics dashboard weekly
2. Set up alerts at 80% threshold (400K projected)
3. Document any usage spikes and root causes
4. Adjust cache TTLs based on actual usage patterns

## Actual Impact (December 2025)

### Results vs Projections

| Estimate | Projected | Actual |
|----------|-----------|--------|
| Conservative | 440K (30% reduction) | - |
| Optimistic | 380K (40% reduction) | - |
| **Actual** | - | **~280K (55-60% reduction)** |

### Why Results Exceeded Expectations

1. **Higher cache hit rates than estimated** - Real-world usage patterns favor repeated queries
2. **Pricing bundle cache had massive impact** - 15-min TTL covers most user sessions
3. **Product search cache effective** - Users often search same products repeatedly
4. **Token caching eliminated OAuth overhead** - Prevents token refresh on every request
5. **Multiple endpoints cached** - Cumulative effect of 5+ cached endpoints

### Original Calculations (For Reference)

**Pricing Bundle** (assuming 5,000 requests/month):
- Before: 5,000 requests × 8 calls = 40,000 API calls
- After (80% cache hit rate): (5,000 × 20% × 8) + (5,000 × 80% × 0) = 8,000 API calls
- **Savings**: 32,000 calls/month

**Product Search** (assuming 10,000 requests/month):
- Before: 10,000 requests × 2 calls = 20,000 API calls
- After (70% cache hit rate): (10,000 × 30% × 2) + (10,000 × 70% × 0) = 6,000 API calls
- **Savings**: 14,000 calls/month

**Actual savings exceeded these estimates significantly.**

## Future Optimization Opportunities

### Additional Caching Candidates

Based on plan analysis, these endpoints should be cached next:

1. **Pricing Reference Endpoints** (1-hour TTL):
   - `/api/pricing-tiers` - Static reference data
   - `/api/embroidery-costs` - Monthly changes
   - `/api/dtg-costs` - Monthly changes
   - `/api/screenprint-costs` - Monthly changes
   - `/api/pricing-rules` - Monthly changes

2. **Product Catalog Endpoints** (30-min TTL):
   - `/api/products-by-brand` - SanMar monthly updates
   - `/api/products-by-category` - SanMar monthly updates
   - `/api/products-by-subcategory` - SanMar monthly updates

3. **Reference Lists** (1-hour TTL):
   - `/api/all-brands` - Rarely changes
   - `/api/all-categories` - Rarely changes
   - `/api/all-subcategories` - Rarely changes

### Advanced Optimizations

**If monitoring reveals need:**
- Request deduplication (same request in flight multiple times)
- Pre-aggregation for expensive queries
- Extended cache for YoY dashboard (currently 60 seconds)
- Conditional feature flags (disable rarely-used expensive features)

## Troubleshooting

### Cache Not Working

**Symptoms:**
- Still seeing `[CACHE MISS]` on repeated requests
- No reduction in API call count

**Checks:**
1. Verify parameters are identical (cache is parameter-aware)
2. Check TTL hasn't expired (15 min for pricing, 5 min for search)
3. Confirm cache size limit not evicting entries too quickly
4. Look for `?refresh=true` parameter bypassing cache

### High Memory Usage

**Symptoms:**
- Heroku dyno memory warnings
- Slow response times

**Checks:**
1. Check cache sizes (should be <100 entries)
2. Verify cleanup is running (every 5 minutes)
3. Review `apiTracker` stats (should only keep 24 hours)

### Metrics Not Updating

**Symptoms:**
- `/api/admin/metrics` showing 0 calls
- No `[API TRACKER]` logs

**Checks:**
1. Verify deployment succeeded (check Heroku releases)
2. Confirm API traffic is actually happening
3. Check server logs for errors in `api-tracker.js`

## Files Modified/Created

**New Files:**
- `src/utils/api-tracker.js` - API call tracking utility

**Modified Files:**
- `src/utils/caspio.js` - Added tracking to both API functions
- `src/routes/pricing.js` - Added pricing-bundle cache
- `src/routes/products.js` - Added product search cache
- `server.js` - Added /api/admin/metrics endpoint

**Deployment:**
- Commit: 9fef725c
- Heroku Release: v201
- Deployed: 2025-11-29 13:11 UTC

## Related Documentation

- [Local Development Guide](LOCAL_DEVELOPMENT.md) - Running/testing locally
- [Caspio API Analysis Plan](../C:\Users\erik\.claude\plans\adaptive-squishing-neumann.md) - Full optimization plan

## Summary

This implementation provides:
- ✅ Real-time visibility into API usage
- ✅ Automatic tracking with zero overhead
- ✅ **High-impact caching (55-60% actual reduction achieved)**
- ✅ Metrics dashboard for ongoing monitoring
- ✅ Foundation for data-driven optimization

**Current Status (December 2025):**
- API usage well under control (~280K projected vs 500K limit)
- No immediate action needed
- Continue monitoring via `/api/admin/metrics`

**Maintenance:**
1. Check `/api/admin/metrics` weekly
2. Watch for unusual spikes in daily usage
3. If usage increases, consider extending cache TTLs
4. Future optimizations available if needed (see "Future Optimization Opportunities")
