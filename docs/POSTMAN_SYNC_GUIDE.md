# Postman Collection Auto-Sync Guide

## Overview

**NEW APPROACH**: The NWCA Production API Postman collection is now **auto-generated from your Express routes**! No more manual JSON construction - just write your routes and run `npm run update-postman`.

This guide explains how the automated sync works and how to use it when adding or editing API endpoints.

## How It Works

### Auto-Generation Workflow

```
1. Scan Express Routes        → Detects all endpoints in src/routes/*.js
   ↓
2. Generate Postman Collection → Converts routes to Postman format
   ↓
3. Intelligent Merge           → Preserves custom descriptions/examples
   ↓
4. Sync to Postman API         → Updates collection automatically
```

**Key Benefits:**
- ✅ **Single source of truth**: Server code drives Postman
- ✅ **Zero manual JSON**: Add route → auto-adds to Postman
- ✅ **Always in sync**: No drift between API and docs
- ✅ **CRUD-like experience**: Add/update/remove routes seamlessly
- ✅ **Preserves customizations**: Your descriptions and examples are kept

## Quick Start

### After Adding/Editing an Endpoint

```bash
# From project root
npm run update-postman
```

**That's it!** The system will:
1. ✅ Scan all 129+ endpoints from your route files
2. ✅ Generate Postman collection automatically
3. ✅ Merge with existing customizations
4. ✅ Sync to Postman API
5. ✅ Show detailed report of changes

### Example Output

```
🚀 NWCA API - Auto-Generate Postman Collection
============================================================

📝 Step 1: Scanning Express routes...
✅ Scanned 16 route files
📊 Found 129 total endpoints

📝 Step 2: Generating Postman collection...
✅ Generated collection with 129 endpoints

📝 Step 3: Merging with existing collection...
✨ New endpoints: 3
🔄 Updated endpoints: 126
📤 Merged collection: 163 endpoints

📝 Step 4: Syncing with Postman API...
✅ Connected successfully! User: erik1974
✅ Successfully updated collection in Postman
🎉 No manual JSON editing needed!
```

## Adding a New Endpoint

### Step 1: Write Your Route (As Usual)

```javascript
// src/routes/production.js

/**
 * Get production schedules with filtering and sorting
 */
router.get('/production-schedules', async (req, res) => {
  const { 'q.where': where, 'q.orderBy': orderBy, 'q.limit': limit } = req.query;

  // ... your route logic ...
});
```

### Step 2: Run Auto-Sync

```bash
npm run update-postman
```

The system automatically:
- **Detects** the new endpoint `GET /api/production-schedules`
- **Extracts** query parameters (`q.where`, `q.orderBy`, `q.limit`)
- **Generates** Postman endpoint with proper format
- **Categorizes** based on filename (production.js → 📅 Production)
- **Adds** to collection and syncs to Postman

### Step 3: Verify in Postman

1. Open Postman (no manual import needed!)
2. Refresh the collection (3 dots → Refresh)
3. Find your endpoint in the auto-categorized folder
4. Test it!

## How Routes Are Discovered

### What Gets Detected

The route scanner automatically extracts:

**1. Route Definition**
```javascript
router.get('/products/search', async (req, res) => { ... })
```
- ✅ Method: `GET`
- ✅ Path: `/api/products/search`
- ✅ Category: `🛍️ Product Search` (from filename)

**2. Query Parameters**
```javascript
const { q, category, brand, limit } = req.query;
```
- ✅ Detects all parameters accessed
- ✅ Marks optional vs required
- ✅ Adds helpful descriptions

**3. Request Body (POST/PUT/PATCH)**
```javascript
const { CompanyName, Status, Priority } = req.body;
```
- ✅ Extracts body fields
- ✅ Generates example JSON
- ✅ Adds Content-Type header

**4. JSDoc Comments**
```javascript
/**
 * Search products with advanced filtering and facets
 */
router.get('/products/search', ...)
```
- ✅ Uses as endpoint description
- ✅ Falls back to auto-generated description

### Categories from Filenames

Routes are automatically categorized based on their source file:

| File | Category | Example Endpoints |
|------|----------|------------------|
| `products.js` | 🛍️ Product Search | `/api/stylesearch`, `/api/products/search` |
| `pricing.js` | 💰 Pricing | `/api/pricing-tiers`, `/api/embroidery-costs` |
| `cart.js` | 🛒 Cart Management | `/api/cart-sessions`, `/api/cart-items` |
| `orders.js` | 📦 Orders | `/api/orders`, `/api/order-dashboard` |
| `art.js` | 🎨 Art & Invoicing | `/api/artrequests`, `/api/art-invoices` |
| `transfers.js` | 🎨 Transfers | `/api/transfers/lookup`, `/api/transfers/matrix` |

## Intelligent Merging

### What Gets Preserved

When merging with your existing collection, the system preserves:

**1. Custom Descriptions**
```javascript
// If you manually wrote a better description in Postman, it's kept
// Only updates description if you had none or used auto-generated one
```

**2. Example Responses**
```javascript
// All example responses you saved in Postman are preserved
```

**3. Custom Query Values**
```javascript
// If you set `q.where=Status='Active'` as default, it's kept
// Only structure is updated, your values remain
```

**4. Manual Additions**
```javascript
// Endpoints in Postman but not in code are preserved (not auto-deleted)
// You'll get a warning so you know they exist
```

### What Gets Updated

**1. Endpoint Structure**
- Method, path, headers updated from code
- Query parameters refreshed from route handler
- Body structure updated for POST/PUT/PATCH

**2. New Endpoints**
- Automatically added when found in code
- Categorized based on source file
- Generated with smart defaults

**3. Removed Endpoints**
- **NOT auto-deleted** (preserved for safety)
- Warning shown: "Endpoint in Postman but not in code"
- You decide whether to manually remove

## Configuration

### Environment Variables

Required in [.env](../.env):

```bash
# Postman API credentials
POSTMAN_API_KEY=PMAK-your-api-key-here
POSTMAN_COLLECTION_ID=5b21a5b0-891b-488e-84f3-dfadc79ef937
```

Get your API key: https://postman.co/settings/me/api-keys

### Collection Settings

Modify in [scripts/postman-generator.js](../scripts/postman-generator.js):

```javascript
const generator = new PostmanGenerator({
  collectionName: 'NWCA Production API - Complete',
  baseUrl: '{{baseUrl}}',
  description: 'Your custom description'
});
```

### Merge Behavior

Modify in [scripts/update-postman-collection.js](../scripts/update-postman-collection.js):

```javascript
const differ = new CollectionDiffer({
  preserveDescriptions: true,  // Keep custom descriptions
  preserveExamples: true,      // Keep example responses
  preserveQueryValues: true    // Keep custom query values
});
```

## Advanced Usage

### Manual Scan Only (No Sync)

```bash
# Just scan routes and show report
node scripts/route-scanner.js

# Output: .cache/scanned-routes.json
```

### Generate Without Sync

```bash
# Scan routes
node scripts/route-scanner.js

# Generate Postman collection
node scripts/postman-generator.js

# Output: docs/NWCA-API.postman_collection.AUTO.json
```

### Merge & Compare

```bash
# Compare existing vs generated
node scripts/collection-differ.js

# Output: docs/NWCA-API.postman_collection.MERGED.json
```

### Full Pipeline (Default)

```bash
# Runs all steps: scan → generate → merge → sync
npm run update-postman
```

## Troubleshooting

### Endpoint Not Detected

**Problem:** Route exists in code but not appearing in Postman

**Common Causes:**
1. Route not using `router.METHOD()` pattern
2. Dynamic routing not supported (e.g., regex routes)
3. Route not exported/mounted in server.js

**Solution:**
```bash
# Check what was scanned
node scripts/route-scanner.js

# Look for your endpoint in output
# If missing, check route syntax
```

### Wrong Category

**Problem:** Endpoint appears in wrong category

**Solution:** Categories are based on filename. Move route to correct file:
- Products → `src/routes/products.js`
- Orders → `src/routes/orders.js`
- etc.

### Custom Description Overwritten

**Problem:** Your custom Postman description was replaced

**Cause:** Auto-generated description is identical to custom one

**Solution:** Make your description more detailed/different from auto-generated text

### Collection ID Not Found (404)

**Problem:** `The specified item does not exist`

**Solution:** Verify collection ID in [.env](../.env):
```bash
# Correct ID for "NWCA Production API - Complete"
POSTMAN_COLLECTION_ID=5b21a5b0-891b-488e-84f3-dfadc79ef937
```

### Sync Failed But Local Updated

**Problem:** Postman API sync failed but JSON file updated

**Solution:** The local file is still valid. You can:
1. Fix API credentials and re-run
2. Manually import the JSON as fallback

## Files Reference

| File | Purpose |
|------|---------|
| [scripts/route-scanner.js](../scripts/route-scanner.js) | Scans Express routes, extracts metadata |
| [scripts/postman-generator.js](../scripts/postman-generator.js) | Converts routes → Postman format |
| [scripts/collection-differ.js](../scripts/collection-differ.js) | Intelligent merge with preservation |
| [scripts/update-postman-collection.js](../scripts/update-postman-collection.js) | Orchestrates full pipeline |
| [scripts/postman-api-client.js](../scripts/postman-api-client.js) | Postman API integration |
| [docs/NWCA-API.postman_collection.json](../docs/NWCA-API.postman_collection.json) | Current collection (auto-updated) |
| [.cache/scanned-routes.json](../.cache/scanned-routes.json) | Scanned routes metadata (temp) |

## Statistics

**Current Status:**
- 📊 **129 endpoints** auto-detected from code
- 📂 **14 categories** organized automatically
- 🔄 **163 total endpoints** in merged collection (includes manual additions)
- ✨ **60 new endpoints** discovered vs old manual approach

**Methods:**
- GET: 79 endpoints
- POST: 18 endpoints
- PUT: 15 endpoints
- DELETE: 17 endpoints

## Migration from Manual Approach

### Old Workflow (Before)
```javascript
// ❌ Had to manually construct ~50 lines of JSON per endpoint
const newEndpoint = {
  name: "Get Production Schedules",
  request: {
    method: "GET",
    url: {
      raw: "{{baseUrl}}/api/production-schedules?...",
      // ... 40 more lines ...
    }
  }
};
// Then manually add to collection
// Then manually sync to Postman
```

### New Workflow (Now)
```javascript
// ✅ Just write your route
router.get('/production-schedules', async (req, res) => {
  // Your logic here
});

// ✅ Run sync
// npm run update-postman

// That's it!
```

## Best Practices

### 1. Add JSDoc Comments
```javascript
/**
 * Search products with advanced filtering, facets, and pagination.
 * Supports brands, categories, colors, sizes, and price ranges.
 */
router.get('/products/search', async (req, res) => {
  // ... implementation ...
});
```

### 2. Use Consistent Parameter Names
```javascript
// ✅ Good - standard Caspio query params
const { 'q.where': where, 'q.orderBy': orderBy, 'q.limit': limit } = req.query;

// ❌ Avoid - custom names lose auto-description
const { filter, sort, max } = req.query;
```

### 3. Document Body Structure
```javascript
/**
 * Create a new art request
 * @body {string} CompanyName - Customer company name
 * @body {string} Status - Request status
 * @body {boolean} Priority - High priority flag
 */
router.post('/artrequests', async (req, res) => {
  const { CompanyName, Status, Priority } = req.body;
  // ...
});
```

### 4. Run Sync After Major Changes
```bash
# After adding multiple endpoints
npm run update-postman

# After refactoring routes
npm run update-postman

# Before deploying to Heroku
npm run update-postman
```

## Summary

### Before Auto-Generation
- ❌ Manual JSON construction (50+ lines per endpoint)
- ❌ Risk of drift between code and Postman
- ❌ Time-consuming updates
- ❌ Error-prone

### After Auto-Generation
- ✅ **Add route → Run sync → Done**
- ✅ Single source of truth (code)
- ✅ 129 endpoints discovered automatically
- ✅ Zero manual JSON editing
- ✅ Intelligent preservation of customizations
- ✅ "CRUD-like" experience

**Bottom Line:** Your Express routes ARE your API documentation. Keep them up to date, and Postman stays in sync automatically!
