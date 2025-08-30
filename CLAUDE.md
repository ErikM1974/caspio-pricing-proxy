## Memories

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