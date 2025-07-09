## Memories

- Art_Request Invoice

## Production Status (July 2025)

### Deployment Information
- **Production URL**: https://caspio-pricing-proxy-ab30a049961a.herokuapp.com
- **Deployment Status**: ✅ LIVE - 52 critical endpoints working
- **Last Deployment**: July 8, 2025
- **Success Rate**: 83.3% (40/48 tested endpoints working)

## Local Development Setup

### Server Configuration (Modular Architecture - Completed July 2025)
- **Local Port**: 3002 (consistent across all configurations)
- **Production**: Uses Heroku's assigned port via `process.env.PORT`
- **Express Version**: 4.21.2 (stable version)
- **API Version**: Caspio v2 API (standardized)
- **Architecture**: ✅ Modular routes fully deployed (migration completed July 8, 2025)

### Starting the Server

#### Recommended Method - Enhanced Start Script
```bash
cd /mnt/c/Users/erik/OneDrive\ -\ Northwest\ Custom\ Apparel/2025/caspio-pricing-proxy
node start-server.js
```

Features:
- ✅ Port availability checking
- ✅ Automatic WSL IP detection
- ✅ Startup diagnostics
- ✅ Caspio credential validation
- ✅ Graceful shutdown handling
- ✅ Color-coded output

#### Quick Restart
```bash
./restart-server.sh
```
Or use the alias: `kill $(lsof -t -i:3002) 2>/dev/null && node start-server.js`

#### Manual Method
```bash
node server.js
```

### Testing with WSL
When running the server in WSL, you cannot use `localhost` from Windows. The enhanced start script automatically displays your WSL IP and ready-to-use URLs.

### Configuration
The server uses a unified configuration file (`config.js`) that:
- Validates all required environment variables on startup
- Uses consistent timeouts and pagination settings
- Standardizes on Caspio API v2
- Provides clear error messages for misconfiguration

**Note**: No `.env` file exists locally. All configuration is handled through `config.js` and environment variables.

### Server Features
- **Robust Error Handling**: Enhanced error middleware with error IDs and detailed logging
- **Startup Validation**: Checks Caspio credentials before accepting requests
- **Health Check Endpoint**: `/api/health` provides comprehensive diagnostics
- **Graceful Shutdown**: Handles SIGTERM and SIGINT properly
- **Modular Architecture**: All endpoints organized into logical route modules

### Quick Test
```bash
# Test server health
curl http://localhost:3002/api/health

# Test all 52 production endpoints on Heroku
node test-heroku-52-after-deploy.js
```

## IMPORTANT: Endpoint Migration COMPLETED (July 2025)

### Current Architecture
- **Migration Status**: ✅ COMPLETED - All critical endpoints migrated to modular routes
- **Production Status**: ✅ DEPLOYED - 52 endpoints live on Heroku
- **Code Cleanup**: ✅ COMPLETED - 6,000+ lines of dead code removed from server.js (July 9, 2025)

### Available Route Modules
All modules are located in `src/routes/`:
- `cart.js` - Cart sessions, items, and sizes management
- `inventory.js` - Inventory checking and management
- `misc.js` - Health check, announcements, and utility endpoints
- `orders.js` - Order management and dashboard
- `pricing-matrix.js` - Pricing matrix CRUD operations
- `pricing.js` - All pricing and cost calculations
- `products.js` - Product search, details, and categories
- `quotes.js` - Quote sessions, items, and analytics
- `transfers.js` - Transfer printing management

### Development Rules Going Forward
1. **✅ DO**: Add all new endpoints to the appropriate module in `src/routes/`
2. **❌ DON'T**: Add any new endpoints to server.js
3. **❌ DON'T**: Uncomment or modify the commented code in server.js

### Cleanup Status
**COMPLETED**: July 9, 2025
- ✅ All 6,000+ lines of commented code removed from server.js
- ✅ server.js reduced from 6,467 lines to 360 lines
- ✅ All functionality preserved in modular routes
- ✅ Production deployment stable with 52 working endpoints

### Quick Reference for New Endpoints

**🚨 CRITICAL: NEVER add new endpoints to server.js! Always use the modular route files.**

When adding a new endpoint:
1. **Choose the correct module** in `src/routes/`:
   - `cart.js` → Cart sessions, items, sizes
   - `inventory.js` → Stock checking, availability
   - `misc.js` → Health checks, utility endpoints
   - `orders.js` → Order management, dashboard
   - `pricing-matrix.js` → Matrix CRUD operations
   - `pricing.js` → Costs, tiers, rules
   - `products.js` → Search, categories, details
   - `quotes.js` → Quote sessions, analytics
   - `transfers.js` → Transfer printing

2. **Use Express Router syntax**:
   ```javascript
   router.get('/your-endpoint', async (req, res) => {
     // Your code here
   });
   ```

3. **Import shared utilities** from server.js:
   ```javascript
   const { fetchAllCaspioPages } = require('../../server');
   ```

4. **Test locally** at `/api/your-endpoint` (routes auto-prefixed with `/api`)

## Project Documentation

### Memory Folder
The `memory/` folder contains important project documentation and reference materials:

- **[API Documentation](memory/API_DOCUMENTATION.md)** - Comprehensive API endpoint documentation
- **[API Endpoints List](memory/API_ENDPOINTS.md)** - List of all 52 production endpoints used on teamnwca.com

### Testing Resources
- **Postman Collection**: `52-working-endpoints.postman_collection.json` - Import this for easy API testing
- **Heroku Test Script**: `test-heroku-52-after-deploy.js` - Tests all production endpoints

### Key APIs Available:
- Cart API (sessions, items, sizes)
- Pricing API (tiers, costs, rules)
- Product API (search, details, categories)
- Order API (orders, customers)
- Order ODBC API (detailed order records)
- **Order Dashboard API** (pre-calculated metrics for UI dashboards)
- Inventory API
- Pricing Matrix API
- Quotes API (analytics, items, sessions)
- Art Invoices API (full CRUD operations)
- Transfers API
- Production Schedules API
- Misc API utilities

## Creating New API Endpoints

### 🚨 IMPORTANT: Module-First Architecture

**DO NOT add any new endpoints to server.js!** The server.js file should remain at ~360 lines and only contain:
- Express server setup
- Helper functions (getCaspioAccessToken, fetchAllCaspioPages)
- Route module imports
- Error handling middleware
- Server startup code

All new endpoints MUST be added to the appropriate module in `src/routes/`.

When creating a new API endpoint, follow this step-by-step process:

### Step 1: Provide the Swagger Response
First, paste the complete Swagger response from Caspio, including:
- The endpoint path (e.g., `/v3/tables/{tableName}/records`)
- All available parameters
- Example curl command
- Sample response data

### Step 2: Endpoint Path
**Question:** "What should the API endpoint path be?"
- Look at the table name from Swagger
- Follow existing patterns (e.g., `Production_Schedules` → `/api/production-schedules`)
- Use kebab-case and make it RESTful

### Step 3: Query Parameters
**Question:** "Which query parameters do you need?"

For most endpoints, recommend these essential parameters:
- `q.where` - For filtering records
- `q.orderBy` - For sorting results  
- `q.limit` - For controlling response size (default: 100, max: 1000)

Ask: "Do you want the standard three (where, orderBy, limit) or do you need something special?"

**Tips for recommendations based on data type:**
- **Orders/Transactions:** Definitely need where (date ranges, status), orderBy (date, amount)
- **Reference Data:** Maybe just limit
- **Reports/Analytics:** Might need groupBy

### Step 4: Response Format
**Question:** "How should the response be formatted?"

Options:
- **Option A: Simple array** (recommended for most cases)
  - Return records exactly as they come from Caspio
  - Same as production-schedules, pricing-tiers endpoints
  - Example: `[{record1}, {record2}]`

- **Option B: Transformed object**
  - Convert to a specific format
  - Same as pricing-rules, embroidery-costs endpoints
  - Example: `{ "key1": "value1", "key2": "value2" }`

### Step 5: Special Requirements
**Question:** "Any special requirements?"
- Field validation or transformation?
- Hide sensitive fields?
- Add business logic?
- Or just "return everything as-is"? (most common)

### Caspio Pagination

**CRITICAL**: Caspio API uses pagination, which means that results may be split across multiple pages. When implementing new endpoints, **ALWAYS** use the `fetchAllCaspioPages` function instead of `makeCaspioRequest` to ensure you get ALL records.

Failure to use `fetchAllCaspioPages` will result in incomplete data when the result set spans multiple pages. We've seen this issue with brands like "OGIO" which were on the second page and were not being returned when using `makeCaspioRequest`.

### Standard Implementation Pattern
Most endpoints will follow this pattern:
1. **Add to appropriate module in `src/routes/`** (NOT to server.js!)
2. Use Caspio API v2 for consistency
3. Public access (no authentication)
4. Standard error handling (400 for bad params, 500 for server errors)
5. **ALWAYS use `fetchAllCaspioPages` for pagination** (never `makeCaspioRequest` for multi-record queries)

### Step-by-Step Implementation Guide

#### 1. Choose the Right Module
Before writing any code, determine which module your endpoint belongs in:

```javascript
// Example: Adding a new product variant endpoint
// This belongs in src/routes/products.js, NOT server.js!
```

#### 2. Import Required Functions
```javascript
// At the top of your route module
const express = require('express');
const router = express.Router();
const { fetchAllCaspioPages } = require('../../server');
```

#### 3. Implement the Endpoint
```javascript
// Standard GET endpoint pattern
router.get('/your-endpoint-name', async (req, res) => {
  try {
    // Extract query parameters
    const whereClause = req.query['q.where'] || '';
    const orderBy = req.query['q.orderBy'] || '';
    const limit = req.query['q.limit'] || '100';
    
    // Build Caspio parameters
    const params = {};
    if (whereClause) params['q.where'] = whereClause;
    if (orderBy) params['q.orderBy'] = orderBy;
    params['q.limit'] = limit;
    
    // ALWAYS use fetchAllCaspioPages for multi-record queries
    const records = await fetchAllCaspioPages(
      '/tables/Your_Table_Name/records',
      params
    );
    
    // Return the data
    res.json(records);
  } catch (error) {
    console.error('Error in /your-endpoint-name:', error);
    res.status(500).json({ 
      error: 'Failed to fetch data',
      details: error.message 
    });
  }
});
```

#### 4. POST/PUT/DELETE Endpoints
```javascript
// For single record operations, makeCaspioRequest is acceptable
router.post('/your-endpoint-name', async (req, res) => {
  try {
    const { makeCaspioRequest } = require('../../server');
    
    // Validate required fields
    const requiredFields = ['field1', 'field2'];
    for (const field of requiredFields) {
      if (!req.body[field]) {
        return res.status(400).json({ 
          error: `Missing required field: ${field}` 
        });
      }
    }
    
    // Make the request
    const result = await makeCaspioRequest(
      'post',
      '/tables/Your_Table_Name/records',
      {},
      req.body
    );
    
    res.json(result);
  } catch (error) {
    console.error('Error creating record:', error);
    res.status(500).json({ 
      error: 'Failed to create record',
      details: error.message 
    });
  }
});
```

### Common Mistakes to Avoid

1. **❌ DON'T add endpoints to server.js**
   ```javascript
   // WRONG - Never do this in server.js!
   app.get('/api/new-endpoint', (req, res) => { ... });
   ```

2. **❌ DON'T use makeCaspioRequest for multi-record queries**
   ```javascript
   // WRONG - This only gets one page!
   const data = await makeCaspioRequest('get', '/tables/Table/records');
   ```

3. **❌ DON'T forget error handling**
   ```javascript
   // WRONG - No try/catch
   router.get('/endpoint', async (req, res) => {
     const data = await fetchAllCaspioPages(...);
     res.json(data);
   });
   ```

4. **✅ DO use the router pattern in modules**
   ```javascript
   // CORRECT - In src/routes/module.js
   router.get('/endpoint', async (req, res) => { ... });
   ```

5. **✅ DO validate parameters**
   ```javascript
   // CORRECT - Check for required params
   if (!req.query.styleNumber) {
     return res.status(400).json({ error: 'styleNumber parameter required' });
   }
   ```

### Creating a New Route Module

If none of the existing modules fit your endpoint category:

1. **Create a new file** in `src/routes/`:
   ```bash
   touch src/routes/your-category.js
   ```

2. **Set up the module structure**:
   ```javascript
   const express = require('express');
   const router = express.Router();
   const { fetchAllCaspioPages } = require('../../server');
   
   // Add your endpoints here
   router.get('/your-endpoint', async (req, res) => {
     // Implementation
   });
   
   module.exports = router;
   ```

3. **Register in server.js** (this is the ONLY time you modify server.js):
   ```javascript
   // In server.js, with the other route imports
   const yourCategoryRoutes = require('./src/routes/your-category');
   app.use('/api', yourCategoryRoutes);
   console.log('✓ Your Category routes loaded');
   ```

### Testing Your New Endpoint

1. **Start the server**:
   ```bash
   node start-server.js
   ```

2. **Test with curl**:
   ```bash
   # GET request
   curl http://localhost:3002/api/your-endpoint
   
   # POST request
   curl -X POST http://localhost:3002/api/your-endpoint \
     -H "Content-Type: application/json" \
     -d '{"field1": "value1", "field2": "value2"}'
   ```

3. **Add to test suite**:
   ```javascript
   // In your test file
   {
     name: 'Your New Endpoint',
     endpoint: '/api/your-endpoint',
     params: { 'q.limit': '10' },
     description: 'What this endpoint does'
   }
   ```

### Example: ORDER_ODBC Endpoint
```
User provides: Swagger response for ORDER_ODBC table
Q1: Endpoint path? → /api/order-odbc
Q2: Query parameters? → Standard three (where, orderBy, limit)
Q3: Response format? → Simple array
Q4: Special requirements? → Return everything as-is
Result: Standard endpoint returning filtered, sorted order records
```

**Implementation location**: `src/routes/orders.js` (NOT server.js!)

```javascript
// In src/routes/orders.js
router.get('/order-odbc', async (req, res) => {
  try {
    const params = {};
    if (req.query['q.where']) params['q.where'] = req.query['q.where'];
    if (req.query['q.orderBy']) params['q.orderBy'] = req.query['q.orderBy'];
    params['q.limit'] = req.query['q.limit'] || '100';
    
    const records = await fetchAllCaspioPages(
      '/tables/ORDER_ODBC/records',
      params
    );
    
    res.json(records);
  } catch (error) {
    console.error('Error fetching ORDER_ODBC:', error);
    res.status(500).json({ error: 'Failed to fetch order ODBC data' });
  }
});
```

## Recent Additions

### Order Dashboard API (`/api/order-dashboard`)
A specialized endpoint for UI dashboards that provides pre-calculated metrics:

**Features:**
- Pre-calculated summary metrics (total orders, sales, shipping status)
- Breakdown by Customer Service Rep and Order Type
- Today's statistics
- Optional detailed order list
- Year-over-Year comparison
- 60-second parameter-aware cache for performance

**Parameters:**
- `days` (number): Number of days to look back (default: 7)
- `includeDetails` (boolean): Whether to include recent orders array (default: false)
- `compareYoY` (boolean): Include year-over-year comparison data (default: false)

**Important Notes:**
- **Invoice Date Filtering**: All order queries filter by `date_OrderInvoiced` (not `date_OrderPlaced`)
- This captures orders invoiced in the period, regardless of when they were placed
- Year-over-year comparisons are based on invoice dates for accurate financial reporting

**Example Usage:**
```bash
# Get 7-day dashboard
GET /api/order-dashboard

# Get 30-day dashboard with order details
GET /api/order-dashboard?days=30&includeDetails=true

# Get dashboard with year-over-year comparison
GET /api/order-dashboard?compareYoY=true
```

## Production Endpoint Status

### Working Endpoints (40/48 tested)
All critical endpoints for teamnwca.com are working, including:
- ✅ All art invoice endpoints
- ✅ Most pricing endpoints (tiers, base costs, size pricing, DTG, screenprint)
- ✅ All quote endpoints
- ✅ All product search/discovery endpoints
- ✅ Cart sessions and most cart operations
- ✅ Orders and customers
- ✅ All utility endpoints (health, dashboard, announcements)

### Known Issues (8 endpoints)
These endpoints have minor issues but don't affect core functionality:
- `embroidery-costs` - Parameter validation issue
- `size-upcharges`, `size-sort-order` - Not implemented yet
- `pricing-matrix/lookup` - Not implemented
- `cart-items POST` - Requires ProductID field
- `pricing-rules` - Requires both styleNumber AND method parameters
- `brands`, `active-products` - Not implemented

### Note on Testing
When testing endpoints, ensure you're using the correct parameters. Many "failures" are simply due to missing or incorrect parameters, not actual endpoint problems.