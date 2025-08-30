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

### Documentation Structure (Simplified)

The project uses a **streamlined documentation architecture** to eliminate duplication:

#### 📖 **Primary API Documentation**
- **[CASPIO_API_TEMPLATE.md](../Pricing%20Index%20File%202025/memory/CASPIO_API_TEMPLATE.md)** - 🎯 **SINGLE SOURCE OF TRUTH**
  - Complete specification for all 54 endpoints
  - Request/response examples and parameters
  - Inter-Claude communication channel
  - Performance optimizations and usage patterns

#### 📚 **Supporting Documentation**
- **[Developer Guide](memory/DEVELOPER_GUIDE.md)** - Integration patterns, best practices, performance tips
- **[API Changelog](memory/API_CHANGELOG.md)** - Version history and breaking changes  
- **[OpenAPI Spec](memory/API_SPECIFICATION.yaml)** - Machine-readable specification

#### 📁 **Archive Folder**
Legacy documentation files have been moved to `archive/` to reduce maintenance overhead:
- `API_DOCUMENTATION.md` (archived - redundant with shared template)
- `API_ENDPOINTS.md` (archived - redundant) 
- `API_QUICK_REFERENCE.md` (archived - redundant)
- Plus legacy feature-specific docs

### SDK Examples
The `examples/` folder contains ready-to-use code examples:
- **[JavaScript Examples](examples/javascript/examples.js)** - Node.js/JavaScript SDK examples
- **[Python Examples](examples/python/examples.py)** - Python SDK examples  
- **[cURL Examples](examples/curl/examples.sh)** - Command-line examples

### Key APIs Available (54 Active Endpoints):
- **Products API** (search, details, colors, variants) - 12 endpoints
- **Pricing API** (tiers, costs, rules, **DTG bundle**) - 8 endpoints  
- **Cart API** (sessions, items, sizes) - 6 endpoints
- **Orders API** (orders, customers, dashboard) - 6 endpoints
- **Quotes API** (analytics, items, sessions) - 6 endpoints
- **Art API** (requests, invoices) - 4 endpoints
- **Others** (inventory, transfers, utilities) - 12 endpoints

#### 🚀 **Performance Optimized Endpoints:**
- **DTG Product Bundle** (`/api/dtg/product-bundle`) - Consolidates 4 API calls into 1
- **Enhanced Product Search** (`/api/products/search`) - Smart grouping and faceted filtering  
- **Order Dashboard** (`/api/order-dashboard`) - Pre-calculated metrics with caching

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

### Step 6: Local Testing (MANDATORY)
**CRITICAL**: Every new endpoint MUST be tested locally on port 3002 before being considered complete.

#### Testing Workflow:
1. **Start the local server:**
   ```bash
   cd /mnt/c/Users/erik/OneDrive\ -\ Northwest\ Custom\ Apparel/2025/caspio-pricing-proxy
   PORT=3002 node server.js
   ```
   Or use the helper script: `node start-test-server.js`

2. **Get your WSL IP for Windows testing:**
   ```bash
   hostname -I | awk '{print $1}'
   ```

3. **Test the new endpoint with curl:**
   ```bash
   # Basic test (replace with your endpoint)
   curl "http://localhost:3002/api/your-new-endpoint"
   
   # From Windows (use WSL IP):
   curl "http://172.20.132.206:3002/api/your-new-endpoint"
   
   # Test with parameters:
   curl "http://localhost:3002/api/your-new-endpoint?param1=value1&param2=value2"
   ```

4. **Test in Postman (Windows users):**
   - Use WSL IP address (not localhost): `http://[WSL-IP]:3002/api/your-new-endpoint`
   - Test different parameter combinations
   - Verify response format matches expectations

5. **Run endpoint validation:**
   ```bash
   node test-endpoints.js
   ```

#### Success Criteria Checklist:
- [ ] ✅ Server starts without errors
- [ ] ✅ Endpoint returns 200 status code
- [ ] ✅ Response format matches specification
- [ ] ✅ Parameters work as expected (where, orderBy, limit)
- [ ] ✅ Error handling works (invalid parameters return 400/500)
- [ ] ✅ Data matches expected Caspio table structure
- [ ] ✅ Pagination works correctly (if applicable)
- [ ] ✅ No console errors or warnings

**IMPORTANT**: Do not proceed with documentation updates or commits until local testing is complete and all criteria are met.

### Step 7: Post-Deployment Updates (MANDATORY - AUTOMATED)
**CRITICAL**: After successful Heroku deployment, you MUST update documentation with production status.

#### 🚀 **AUTOMATED Post-Deployment Workflow:**

**Quick Command (Recommended):**
```bash
# Mark endpoint as deployed with all documentation updates
npm run deploy-status -- --endpoint="your-endpoint-path" --deployed --performance="1-2s response, 5min cache"
```

**This single command will:**
- ✅ Update Postman collection description with deployment status
- ✅ Sync changes with live Postman workspace (no manual JSON import!)
- ✅ Mark endpoint as "DEPLOYED & TESTED" with current date
- ✅ Add performance metrics and testing status
- ✅ Update both local JSON file and Postman API simultaneously

#### 📋 **Step-by-Step Checklist:**
1. **Test the production endpoint** on Heroku to confirm it's working
2. **Run automated deployment update:**
   ```bash
   # Example for DTG endpoint
   npm run deploy-status -- --endpoint="dtg/product-bundle" --deployed --performance="0.5-1s response, 5min cache"
   
   # Or by exact name
   npm run deploy-status -- --name="Get DTG Product Bundle" --deployed
   
   # Or with custom status
   npm run deploy-status -- --path="api/products/search" --status="LIVE & OPTIMIZED" --notes="Handles 250K+ records"
   ```
3. **Verify automation succeeded** - check console output for success messages
4. **Update shared documentation** (CASPIO_API_TEMPLATE.md) with deployment confirmation message
5. **Update agent file** with deployment status for Consumer Claude

#### 🔧 **Manual Fallback (If Automation Fails):**
If Postman API is unavailable, you can still update manually:
```bash
# Update local collection only
npm run update-postman
# Then manually import JSON file into Postman workspace
```

#### 🎛️ **Available Automation Commands:**
```bash
# Test Postman API connection
npm run postman-test

# List all endpoints with deployment status
npm run deploy-status -- --list

# Update entire collection structure
npm run update-postman

# Mark specific endpoints as deployed
npm run deploy-status -- --endpoint="path" --deployed
npm run deploy-status -- --name="Endpoint Name" --performance="metrics"
npm run deploy-status -- --path="api/path" --status="CUSTOM STATUS"
```

#### 🔑 **One-Time Setup Required:**
1. Get Postman API key from https://postman.co/settings/me/api-keys
2. Set `POSTMAN_API_KEY=your-key` in `.env` file
3. Collection ID is already configured in `.env.example`

**Benefits**: No more manual JSON editing, instant workspace sync, consistent deployment status tracking.
5. **Update agent file** with deployment status
6. **Add to Recent Updates Requiring Acknowledgment** for Consumer Claude

**Why this matters**: This ensures users have confidence the endpoint is production-ready and Consumer Claude knows it's available for integration.

### Caspio Pagination

**CRITICAL**: Caspio API uses pagination, which means that results may be split across multiple pages. When implementing new endpoints, **ALWAYS** use the `fetchAllCaspioPages` function instead of `makeCaspioRequest` to ensure you get ALL records.

Failure to use `fetchAllCaspioPages` will result in incomplete data when the result set spans multiple pages. We've seen this issue with brands like "OGIO" which were on the second page and were not being returned when using `makeCaspioRequest`.

### Standard Implementation Pattern
Most endpoints will follow this pattern:
1. Add to appropriate route module in `src/routes/` (use modular architecture)
2. Use Caspio API v2 for consistency
3. Public access (no authentication)
4. Standard error handling (400 for bad params, 500 for server errors)
5. **ALWAYS use `fetchAllCaspioPages` for pagination** (never `makeCaspioRequest` for multi-record queries)
6. **MANDATORY local testing** on port 3002 before completion (see Step 6 above)
7. **Update all documentation** (Postman, shared docs, changelog, agent file)
8. **After Heroku deployment**: Update Postman description with production status

### Example: ORDER_ODBC Endpoint
```
User provides: Swagger response for ORDER_ODBC table
Q1: Endpoint path? → /api/order-odbc
Q2: Query parameters? → Standard three (where, orderBy, limit)
Q3: Response format? → Simple array
Q4: Special requirements? → Return everything as-is
Result: Standard endpoint returning filtered, sorted order records
```

## Postman Collection Management

### CRITICAL: Single Source of Truth
**There is ONE official Postman collection file that must be kept up-to-date:**
`docs/NWCA-API.postman_collection.json`

### When Adding or Modifying Endpoints

**IMPORTANT**: Every time you add, modify, or remove an API endpoint, you MUST update the Postman collection:

1. **For NEW endpoints:**
   - Add the endpoint to the appropriate category in `docs/NWCA-API.postman_collection.json`
   - Include example query parameters with descriptions
   - Set appropriate request body examples for POST/PUT endpoints
   - Run `node scripts/update-postman-collection.js` to ensure consistency

2. **For MODIFIED endpoints:**
   - Update the endpoint's URL, parameters, or body in the Postman collection
   - Update any example values or descriptions
   - Verify the endpoint still works with `node test-endpoints.js`

3. **For DELETED endpoints:**
   - Remove the endpoint from the Postman collection
   - Update any documentation that references the removed endpoint

4. **For DEPLOYED endpoints (CRITICAL - Don't forget!):**
   - After successful Heroku deployment and testing, update the endpoint description
   - Add production status: "✅ DEPLOYED on Heroku and production tested ([DATE])"
   - Include actual performance metrics from testing (response times, cache info)
   - Update parameter information if any changes were made during testing
   - This ensures users have confidence the endpoint is production-ready

### Postman Collection Structure
The collection is organized by category:
- 🛍️ Product Search (Enhanced search, related products, quick view)
- 🛒 Cart Management (Sessions, items, sizes)
- 💰 Pricing (Tiers, costs, rules)
- 📦 Orders & Customers (CRUD operations)
- 🎨 Art & Invoicing (Art requests, invoices)
- 📝 Quote System (Sessions, items, analytics)
- 🎨 Transfers (Pricing, matrices, sizes)
- 📊 Pricing Matrix (Lookup, CRUD)
- 📦 Inventory (Sizes, variants, prices)
- ⚙️ Utilities (Health, status, recommendations)

### 🤖 **Automation Tools (NEW - Eliminates Manual JSON Editing)**

**🚀 Automated Deployment Status Updates:**
```bash
npm run deploy-status -- --endpoint="dtg/product-bundle" --deployed --performance="1-2s response"
```
- ✅ Updates endpoint descriptions with deployment status
- ✅ Syncs directly with Postman workspace via API
- ✅ No more manual JSON import/export required
- ✅ Tracks production testing and performance metrics

**📊 Collection Management:**
```bash
npm run update-postman     # Update structure + sync with Postman API
npm run postman-list       # List endpoints with deployment status
npm run postman-test       # Test API connection
```

**🔧 Legacy Script**: `test-endpoints.js`
- Validates all endpoints are working
- Checks server connectivity  
- Provides Postman-ready URLs

### Active Endpoints Only
This collection contains ONLY the endpoints actively used in the pricing-index application (~53 endpoints).
Do NOT add experimental or unused endpoints. If an endpoint is not being used in production, it should not be in the Postman collection.

### Environment Variables
The collection uses these variables:
- `{{baseUrl}}` - Production: `https://caspio-pricing-proxy-ab30a049961a.herokuapp.com`
- `{{styleNumber}}` - Example style: `PC54`
- `{{color}}` - Example color: `Red`
- `{{method}}` - Decoration method: `DTG`
- `{{sessionId}}` - Test session ID
- `{{id}}` - Generic ID for CRUD operations

## CRITICAL: Cross-Project API Documentation Sync & Inter-Claude Communication

### Shared Documentation File
**Path**: `/mnt/c/Users/erik/OneDrive - Northwest Custom Apparel/2025/Pricing Index File 2025/memory/CASPIO_API_TEMPLATE.md`

This file is the **single source of truth** shared between this project (API Provider) and Pricing Index (API Consumer). Both Claude instances use this file to coordinate changes and communicate.

### 🔔 Session Start Protocol
**IMPORTANT: At the start of each session, you MUST:**
1. Read the shared CASPIO_API_TEMPLATE.md file
2. Check the "Active Conversations" section for pending messages from Consumer Claude
3. Review "Recent Updates Requiring Acknowledgment"
4. Update your "Last Checked by Provider" timestamp
5. Respond to any questions or acknowledge updates

### 📝 When Making API Changes
**When you add, modify, or remove ANY API endpoint:**

1. **Update the Postman collection**: `docs/NWCA-API.postman_collection.json`

2. **Update the shared documentation** with:
   - Complete endpoint documentation
   - Leave a message in the Communication Log using appropriate prefix:
     - 🚨 **BREAKING** for breaking changes
     - 📝 **UPDATE** for new endpoints
     - 🐛 **BUG** for fixes
   - Add item to "Recent Updates Requiring Acknowledgment"
   - Update version number and "Last Updated By" timestamp

3. **Example message format**:
   ```
   **2025-01-30 16:00** - 📝 **UPDATE** from API Provider:
   Added new endpoint GET /api/products/bulk for bulk product retrieval.
   Max 500 items per request. See documentation in Products section.
   ```

### 💬 Communication Guidelines
- Check for messages from Consumer Claude regularly
- Use ❓ **QUESTION** prefix when you need information
- Use ✅ **ANSWER** prefix when responding
- Use 🤝 **ACKNOWLEDGED** when you've read and understood a message
- Move resolved conversations from "Active" to "History"

### 🚨 Important Notes
- The Consumer Claude will report bugs, usage patterns, and requirements
- You own the API implementation and performance optimization
- Always document breaking changes with migration guides
- The file acts as a "bulletin board" for asynchronous communication between Claudes

**Why this matters**: This enables coordination between the API provider (you) and consumer (Pricing Index Claude) without human intervention, ensuring both sides stay synchronized.

## 📤 Agent Update Protocol

**IMPORTANT**: The Pricing Index application has an agent that needs updates when APIs change.

**Agent Path**: `/mnt/c/Users/erik/OneDrive - Northwest Custom Apparel/2025/Pricing Index File 2025/.claude/agents/caspio-api-architect.md`

### When to Update the Agent:
You MUST update the agent file when:
1. **Adding New Endpoints**: Add to "Recently Deployed Endpoints" section with full details
2. **Making Breaking Changes**: Update affected endpoint documentation immediately
3. **Adding Major Features**: Document in "Recent API Communications" section
4. **Deprecating Endpoints**: Mark as deprecated with migration notes and timeline

### Agent Update Checklist:
When making API changes:
- [ ] Update the shared CASPIO_API_TEMPLATE.md (primary documentation)
- [ ] Update the agent's "Recently Deployed Endpoints" section
- [ ] Add to "Recent API Communications" with date
- [ ] Include complete endpoint specification (URL, params, response)
- [ ] Note any breaking changes with 🚨 prefix
- [ ] Provide migration guides for deprecated endpoints

### Example Agent Update Format:
```markdown
### `/api/products/bulk-search` - Bulk Product Search
**Status**: LIVE as of January 31, 2025
**Base URL**: `https://caspio-pricing-proxy-ab30a049961a.herokuapp.com/api/products/bulk-search`
**Method**: POST
**Purpose**: Retrieve multiple products by style numbers in one request
**Request Body**:
```json
{
  "styleNumbers": ["PC54", "PC61", "PC55"],
  "includeVariants": true
}
```
**Response**: Array of products with full details
**Use Case**: Product comparison tables, bulk operations
```

### Why This Matters:
The caspio-api-architect agent is used by the Pricing Index Claude to:
- Discover available endpoints
- Understand API capabilities
- Make architecture decisions
- Request new functionality

Keeping it updated ensures the agent has accurate information for decision-making.

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