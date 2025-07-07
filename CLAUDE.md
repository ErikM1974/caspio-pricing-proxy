## Memories

- Art_Request Invoice

## Local Development Setup

### Server Configuration (Refactored 2025)
- **Local Port**: 3002 (consistent across all configurations)
- **Production**: Uses Heroku's assigned port via `process.env.PORT`
- **Express Version**: 4.21.2 (stable version)
- **API Version**: Caspio v2 API (standardized)
- **Architecture**: Monolithic server.js (modular routes disabled to prevent conflicts)

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

### Server Features
- **Robust Error Handling**: Enhanced error middleware with error IDs and detailed logging
- **Startup Validation**: Checks Caspio credentials before accepting requests
- **Health Check Endpoint**: `/api/health` provides comprehensive diagnostics
- **Graceful Shutdown**: Handles SIGTERM and SIGINT properly
- **No More Conflicts**: Removed duplicate modular routes and function definitions

### Quick Test
```bash
# Test server health
curl http://localhost:3002/api/health

# Run comprehensive tests
node test-refactored-server.js
```

## Project Documentation

### Memory Folder
The `memory/` folder contains important project documentation and reference materials:

- **[API Documentation](memory/API_DOCUMENTATION.md)** - Comprehensive API endpoint documentation including:
  - Complete list of all endpoints with examples
  - Request/response formats
  - Query parameters and filters
  - CRUD operations for all entities
  - Recently added Art Invoices API endpoints

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
- Misc API utilities
- Production Schedules API

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
1. Add to server.js directly (not modular)
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