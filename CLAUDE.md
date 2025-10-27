## Memories

- **ManageOrders Integration** - Customer data API proxy with caching ([Full Documentation](memory/MANAGEORDERS_INTEGRATION.md))
- **ManageOrders PUSH API** - Send orders TO OnSite ERP with auto-import ([Full Documentation](memory/MANAGEORDERS_PUSH_INTEGRATION.md))
- **Online Store Developer Guide** - Complete guide for building webstore integration ([Developer Guide](memory/ONLINE_STORE_DEVELOPER_GUIDE.md))
- Art_Request Invoice

## Local Development Setup

### Server Configuration
- **Local Port**: 3002 (dedicated port for caspio-pricing-proxy)
- **Production**: Uses Heroku's assigned port via `process.env.PORT`
## Claude Rules
1. First think through the problem, read the codebase for relevant files, and write a plan to tasks/todo.md.
2. The plan should have a list of todo items that you can check off as you complete them
3. Before you begin working, check in with me and I will verify the plan.
4. Then, begin working on the todo items, marking them as complete as you go.
5. Please every step of the way just give me a high level explanation of what changes you made
6. Make every task and code change you do as simple as possible. We want to avoid making any massive or complex changes. Every change should impact as little code as possible. Everything is about simplicity.

### Testing Locally with WSL
When running the server in WSL (Windows Subsystem for Linux), you cannot use `localhost` in Postman or browsers on Windows. Instead:
### we are now using Routes, so when making a new endpoint add to a route file in the /routes folder.

1. **Get your WSL IP address:**
   ```bash
   hostname -I | awk '{print $1}'
   ```

2. **Use the WSL IP for all local testing:**
   ```
   http://[YOUR-WSL-IP]:3002/api/order-dashboard
   http://[YOUR-WSL-IP]:3002/api/order-odbc
   http://[YOUR-WSL-IP]:3002/api/products/search
   ```
   Example: `http://172.20.132.206:3002/api/order-dashboard`

3. **Note**: The WSL IP address changes when Windows restarts, so check it each time.

### Quick Start Testing

#### 1. Start the Server (Recommended Method)
```bash
cd /mnt/c/Users/erik/OneDrive\ -\ Northwest\ Custom\ Apparel/2025/caspio-pricing-proxy
node start-test-server.js
```

This helper script will:
- ✅ Force the server to use port 3002 (avoiding port confusion)
- ✅ Display your current WSL IP address
- ✅ Show ready-to-copy Postman URLs
- ✅ Monitor server health
- ✅ Handle graceful shutdown with Ctrl+C

#### 2. Test the Endpoints
```bash
node test-endpoints.js
```

This will:
- 🔍 Auto-detect which port the server is actually using
- 🧪 Run health checks on key endpoints
- 📋 Display Postman-ready URLs with your current WSL IP
- ✅ Verify server is working correctly

#### 3. Quick Health Check
```bash
curl http://localhost:3002/api/health
```

### Running the Server (Manual Method)
```bash
cd /mnt/c/Users/erik/OneDrive\ -\ Northwest\ Custom\ Apparel/2025/caspio-pricing-proxy
PORT=3002 node server.js
```

### Common Issues & Solutions

| Issue | Solution |
|-------|----------|
| Server starts on port 3000 instead of 3002 | Use `node start-test-server.js` or set `PORT=3002` explicitly |
| Can't connect from Postman | Check WSL IP with `hostname -I` - it changes on reboot |
| Server won't start | Check if port is in use: `lsof -i :3002` or `netstat -tlnp | grep 3002` |
| Connection refused errors | Ensure you're using WSL IP, not localhost, from Windows |
| Endpoints return errors | Run `node test-endpoints.js` to diagnose which endpoints are failing |

## Project Documentation

### Memory Folder
The `memory/` folder contains important project documentation and reference materials:

- **[API Documentation](memory/API_DOCUMENTATION.md)** - Comprehensive API endpoint documentation including:
  - Complete list of all endpoints with examples
  - Request/response formats
  - Query parameters and filters
  - CRUD operations for all entities
  - Recently added Art Invoices API endpoints
- **[OpenAPI Specification](memory/API_SPECIFICATION.yaml)** - Complete OpenAPI 3.0 specification for all endpoints
- **[Developer Guide](memory/DEVELOPER_GUIDE.md)** - Best practices, integration patterns, and troubleshooting
- **[API Changelog](memory/API_CHANGELOG.md)** - Version history and recent changes
- **[Quick Reference](memory/API_QUICK_REFERENCE.md)** - Quick endpoint reference with examples
- **[Endpoint Inventory](memory/API_ENDPOINTS.md)** - Complete list of all 52 endpoints

### SDK Examples
The `examples/` folder contains ready-to-use code examples:
- **[JavaScript Examples](examples/javascript/examples.js)** - Node.js/JavaScript SDK examples
- **[Python Examples](examples/python/examples.py)** - Python SDK examples  
- **[cURL Examples](examples/curl/examples.sh)** - Command-line examples

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

### ManageOrders API - Complete ERP Integration ⭐

**Version 1.3.0** - See **[ManageOrders Integration Guide](memory/MANAGEORDERS_INTEGRATION.md)** for complete documentation.

**11 Endpoints Now Available** (v1.3.0 - Added 9 new endpoints):

**Customers (2 endpoints):**
- `/api/manageorders/customers` - Unique customers from last 60 days (24hr cache)
- `/api/manageorders/cache-info` - Cache status (debug)

**Orders (3 endpoints):**
- `/api/manageorders/orders` - Query by date range (1hr cache)
- `/api/manageorders/orders/:order_no` - Get specific order (24hr cache)
- `/api/manageorders/getorderno/:ext_order_id` - Map external IDs (24hr cache)

**Line Items (1 endpoint):**
- `/api/manageorders/lineitems/:order_no` - Full order details (24hr cache)

**Payments (2 endpoints):**
- `/api/manageorders/payments` - Query by date range (1hr cache)
- `/api/manageorders/payments/:order_no` - Get order payments (24hr cache)

**Tracking (2 endpoints):**
- `/api/manageorders/tracking` - Query by date range (15min cache)
- `/api/manageorders/tracking/:order_no` - Get order tracking (15min cache)

**Inventory (1 endpoint):** ⭐ CRITICAL FOR WEBSTORE
- `/api/manageorders/inventorylevels` - Real-time stock levels (5min cache)

**Key Features:**
- Smart multi-level caching (5min to 24hr based on data type)
- Rate limiting: 30 requests/minute
- Empty arrays for "not found" (200 status, not 404)
- All endpoints support `?refresh=true` for cache bypass
- Parameter-aware caching (different params = different cache)
- Environment-based credentials (server-side only)

**Critical Endpoints for Webstore:**
1. **Inventory Levels** - Real-time stock availability
2. **Order Lookup** - Customer self-service order tracking
3. **Tracking** - Shipment status and carrier info
4. **Line Items** - Order details and product information

**Live Endpoints (Production):**
```bash
# Base URL
BASE_URL="https://caspio-pricing-proxy-ab30a049961a.herokuapp.com"

# Inventory - Check stock for PC54
$BASE_URL/api/manageorders/inventorylevels?PartNumber=PC54

# Orders - Get October orders
$BASE_URL/api/manageorders/orders?date_Ordered_start=2025-10-01&date_Ordered_end=2025-10-31

# Order Details - Get specific order
$BASE_URL/api/manageorders/orders/138145

# Line Items - Get order products
$BASE_URL/api/manageorders/lineitems/138145

# Tracking - Get shipment status
$BASE_URL/api/manageorders/tracking/138152

# Customers - Get customer list
$BASE_URL/api/manageorders/customers
```

**Documentation:**
- [Integration Guide](memory/MANAGEORDERS_INTEGRATION.md) - All 11 endpoints with examples
- [API Specification](memory/MANAGEORDERS_API_SPEC.yaml) - Complete Swagger spec
- [API Changelog](memory/API_CHANGELOG.md) - Version 1.3.0 details

### ManageOrders PUSH API - Send Orders TO OnSite ⭐ NEW

**Version 1.0.1** - See **[ManageOrders PUSH Integration Guide](memory/MANAGEORDERS_PUSH_INTEGRATION.md)** for complete documentation.

**Purpose:** Send orders FROM our webstore/applications directly TO ShopWorks OnSite for production

**3 Endpoints Available:**

1. **Create Order** - `POST /api/manageorders/orders/create`
   - Push new orders to OnSite ERP
   - Auto-imported hourly into OnSite Order Entry
   - Automatic date formatting (YYYY-MM-DD → MM/DD/YYYY)
   - Size translation (L → LG in OnSite)
   - Test order support (adds "TEST-" prefix)

2. **Verify Order** - `GET /api/manageorders/orders/verify/:extOrderId`
   - Confirm order was received by ManageOrders
   - Check upload status

3. **Test Auth** - `POST /api/manageorders/auth/test`
   - Verify credentials and connectivity
   - Test before pushing live orders

**Key Features:**
- ✅ **Automatic Date Conversion** - YYYY-MM-DD → MM/DD/YYYY (v1.0.1 fix)
- ✅ **Size Translation** - Webstore sizes → OnSite size columns
- ✅ **Customer Tracking** - All orders → Customer #2791, actual customer in Contact fields
- ✅ **Hourly Auto-Import** - Orders appear in OnSite within 1 hour
- ✅ **Design Support** - Upload thumbnails via ImageURL
- ✅ **Payment Integration** - Send payment status/details
- ✅ **Full Validation** - Clear error messages for invalid data

**Quick Example:**
```bash
# Push a test order
curl -X POST https://caspio-pricing-proxy-ab30a049961a.herokuapp.com/api/manageorders/orders/create \
  -H "Content-Type: application/json" \
  -d '{
    "orderNumber": "001",
    "isTest": true,
    "orderDate": "2025-10-27",
    "customer": {
      "firstName": "John",
      "lastName": "Doe",
      "email": "john@example.com"
    },
    "lineItems": [{
      "partNumber": "PC54",
      "color": "Red",
      "size": "L",
      "quantity": 12,
      "price": 8.50
    }],
    "shipping": {
      "address1": "123 Main St",
      "city": "Seattle",
      "state": "WA",
      "zip": "98101"
    }
  }'
```

**Important Notes:**
- **Dates:** Send in YYYY-MM-DD format (automatically converted to MM/DD/YYYY)
- **ExtOrderID:** Generated as `NWCA-{orderNumber}` or `NWCA-TEST-{orderNumber}` for test orders
- **Customer:** All orders assigned to Customer #2791, actual customer info in Contact fields
- **OnSite Import:** Orders auto-imported hourly (check "Last Server Import" in OnSite)

**Documentation:**
- [PUSH API Integration Guide](memory/MANAGEORDERS_PUSH_INTEGRATION.md) - Complete docs with examples
- [Online Store Developer Guide](memory/ONLINE_STORE_DEVELOPER_GUIDE.md) - **⭐ Complete guide for building webstore integration**
- [Test Scenarios](examples/push-api/test-scenarios.md) - 10 test cases
- [Example Orders](examples/push-api/) - minimal-order.json, complete-order.json

**For Developers Building an Online Store:**
See the **[Online Store Developer Guide](memory/ONLINE_STORE_DEVELOPER_GUIDE.md)** - a complete, step-by-step guide with:
- Quick start examples
- Complete API reference
- Field-by-field documentation
- Code examples in JavaScript, Python, PHP
- Size translation guide
- Testing workflow
- Production checklist
- Troubleshooting guide