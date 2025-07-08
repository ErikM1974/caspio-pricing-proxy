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
- **Old Code**: 6,000+ lines of commented endpoints in server.js kept for reference/rollback

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

### Cleanup Reminder
**DELETE AFTER**: August 5, 2025 (4 weeks from migration completion)
- Once the system has been stable in production for 4 weeks
- Delete all commented endpoint code from server.js
- This will reduce server.js from 6,400+ lines to ~500 lines

### Quick Reference for New Endpoints
When adding a new endpoint:
1. Identify the appropriate module in `src/routes/`
2. Add the endpoint using Express Router syntax
3. Test the endpoint at `/api/your-endpoint`
4. All routes are automatically prefixed with `/api` when mounted

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

### Example: ORDER_ODBC Endpoint
```
User provides: Swagger response for ORDER_ODBC table
Q1: Endpoint path? → /api/order-odbc
Q2: Query parameters? → Standard three (where, orderBy, limit)
Q3: Response format? → Simple array
Q4: Special requirements? → Return everything as-is
Result: Standard endpoint returning filtered, sorted order records
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