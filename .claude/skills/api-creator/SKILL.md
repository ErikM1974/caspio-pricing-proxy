---
name: API Creator
description: Create complete Caspio API endpoints from table to Heroku deployment. Handles code generation, documentation, testing, and deployment for non-programmers. Use when the user wants to "create a new endpoint", "add caspio endpoint", or "create endpoint for [table]".
allowed-tools: []
---

# Caspio API Endpoint Creator

I help you create complete API endpoints from Caspio tables to production deployment on Heroku. This skill guides non-programmers through the entire process with safety checks, smart defaults, and clear instructions.

## When to Use This Skill

- User wants to create a new API endpoint from a Caspio table
- User has Swagger documentation from Caspio
- User needs to expose a Caspio table through the REST API
- Keywords: "create endpoint", "new api", "add caspio table", "swagger"

## Step-by-Step Workflow

### PHASE 1: GATHER INPUT

**Ask the user to provide their Caspio information:**

"To create your API endpoint, please paste one of the following:
1. The curl command from Caspio Swagger (recommended)
2. The Swagger JSON response
3. Just the table name (I'll ask more questions)

Paste it below:"

**Expected input formats:**
- **curl command**: `curl -X 'GET' 'https://c3eku948.caspio.com/integrations/rest/v3/tables/MyTable/records' ...`
- **JSON**: `{"Result": [{"field1": "value", ...}]}`
- **Table name**: `Production_Orders` or `ORDER_ODBC`

**Parse the input:**
1. If curl command → extract table name from URL path
2. If JSON → extract field names and types from sample record
3. If table name only → use as-is, will ask for field info

**Extract key information:**
- Table name (e.g., `Sanmar_Bulk_251816_Feb2024`)
- Sample fields from response data
- Field types (text, number, date, boolean)

---

### PHASE 2: PRE-FLIGHT SAFETY CHECKS

**CRITICAL: Run these checks BEFORE proceeding:**

1. **Check Git Status**
   ```bash
   git status --porcelain
   ```
   - If output is not empty: "⚠️ You have uncommitted changes. Commit or stash them first."
   - Ask: "Continue anyway? (yes/no)"

2. **Check Environment Variables**
   - Read `.env` file
   - Verify exists: `CASPIO_CLIENT_ID`, `CASPIO_CLIENT_SECRET`, `CASPIO_DOMAIN`
   - If missing: "❌ Missing Caspio credentials in .env file. Please add them first."

3. **Check Node Modules**
   ```bash
   test -d node_modules
   ```
   - If not exists: "❌ Dependencies not installed. Run: npm install"

4. **Detect WSL IP** (critical for local testing)
   ```bash
   hostname -I | awk '{print $1}'
   ```
   - Save this IP for later use in test commands
   - Display: "✅ Your WSL IP: {IP} (use this for local testing)"

5. **Check if server is running**
   ```bash
   lsof -i :3002 2>/dev/null || netstat -tlnp 2>/dev/null | grep 3002
   ```
   - If running: "⚠️ Server is already running on port 3002. Stop it first (Ctrl+C) or this will cause conflicts."

**Display check results:**
```
Pre-flight Checks:
✅ Git status: Clean
✅ Environment: Configured
✅ Dependencies: Installed
✅ WSL IP: 172.20.132.206
✅ Port 3002: Available

Ready to proceed!
```

---

### PHASE 3: INTERACTIVE CONFIGURATION

**Ask these questions in sequence:**

#### **Question 1: Endpoint Path**

Analyze table name and suggest endpoint:
- `Production_Schedules` → `/api/production-schedules`
- `ORDER_ODBC` → `/api/order-odbc`
- `ArtRequests` → `/api/artrequests`
- `Sanmar_Bulk_251816_Feb2024` → `/api/sanmar-products`

**Pattern: Convert to kebab-case, remove dates/version numbers, make user-friendly**

"What should the endpoint path be?
**Suggested:** /api/{suggested-name}
(Press Enter to accept, or type a custom name)"

Wait for input. If empty, use suggestion.

**CRITICAL: Check for duplicates**
```bash
ls src/routes/{endpoint-name}.js
grep -r "router.get('/{endpoint-name}'" src/routes/
```

If exists: "⚠️ Warning: This endpoint already exists!
1. Overwrite (replaces existing code)
2. Use different name
3. Cancel

Choose (1/2/3):"

---

#### **Question 2: Endpoint Pattern**

"What type of endpoint do you need?

**1. Read-Only** (GET only - recommended for most cases)
   - Fetch and filter data
   - Safe, no data modification
   - Example: /api/production-schedules
   - ~60 lines of code

**2. Full CRUD** (Create, Read, Update, Delete)
   - GET, POST, PUT, DELETE operations
   - Manage data completely
   - Example: /api/artrequests
   - ~350 lines of code

Choose (1 or 2):"

Store answer as: `endpointType = "simple"` or `"crud"`

---

#### **Question 3: Field Filters** (only if READ-ONLY selected)

Analyze fields from sample response and categorize:
- **Text fields**: CompanyName, Status, STYLE, BRAND_NAME
- **Number fields**: Price, Quantity, PIECE_PRICE
- **Date fields**: Date_Created, SALE_START_DATE, Date_Updated
- **Boolean fields**: IsActive, IsTopSeller, Mockup

"I found these fields in the table. Which ones should be filterable?

**Suggested filters:**
- STYLE (text - exact match)
- BRAND_NAME (text - exact match)
- PRODUCT_STATUS (text - exact match)
- CATEGORY_NAME (text - exact match)
- Date_Updated (date range)

Options:
1. Use suggested filters (recommended)
2. No field filters, just generic q.where
3. Let me choose custom fields

Choose (1/2/3):"

If 3: "Enter field names separated by commas:"

Store as: `filters = [array of field names]`

---

#### **Question 4: Special Requirements** (optional)

"Any special requirements?
1. None - standard endpoint
2. Custom data transformation
3. Specific validation rules
4. Hide sensitive fields

Choose (1/2/3/4) or press Enter for none:"

Most users will choose 1 (none).

---

### PHASE 4: CODE GENERATION

**Show progress indicator:**
```
Creating /api/{endpoint-name} endpoint...

[████░░░░░░░░░░░░] 25% - Generating route file...
```

#### **Step 1: Create Route File**

Based on `endpointType`:

**If "simple" (read-only):**
Use template from `templates/simple-route-template.js`
- Replace `{TABLE_NAME}` with actual table name
- Replace `{ENDPOINT_NAME}` with endpoint path
- Replace `{FILTERS}` with generated filter code
- Add field-specific filters based on user selection

**If "crud" (full CRUD):**
Use template from `templates/crud-route-template.js`
- Same replacements as simple
- Include POST, PUT, DELETE handlers
- Add input validation
- Add password field handling (if exists)

**Generated file location:** `src/routes/{kebab-case-name}.js`

Update progress: `[████████░░░░░░░░] 50% - Updating server configuration...`

---

#### **Step 2: Update server.js**

Insert new route registration:

Find the section with route imports (around line 250-305), add:
```javascript
// {Endpoint Description} Routes
const {camelCaseName}Routes = require('./src/routes/{kebab-case-name}');
app.use('/api', {camelCaseName}Routes);
console.log('✓ {Endpoint Name} routes loaded');
```

**Alphabetically sort** the route imports to maintain consistency.

Update progress: `[████████████░░░░] 75% - Updating documentation...`

---

#### **Step 3: Update Documentation**

**3a. Update Postman Collection**

Read: `docs/NWCA-API.postman_collection.json`

Add new request(s) to appropriate category:
- If product-related → "🛍️ Product Search"
- If pricing-related → "💰 Pricing & Costs"
- If order-related → "📦 Orders & Customers"
- If art-related → "🎨 Art & Invoicing"
- Otherwise → "⚙️ Utilities"

**For READ-ONLY endpoints, add:**
```json
{
  "name": "{Endpoint Name}",
  "request": {
    "method": "GET",
    "header": [],
    "url": {
      "raw": "{{baseUrl}}/api/{endpoint-name}?limit=10",
      "host": ["{{baseUrl}}"],
      "path": ["api", "{endpoint-name}"],
      "query": [
        {"key": "limit", "value": "10", "description": "Number of records"},
        {"key": "q.where", "value": "", "description": "Filter condition", "disabled": true},
        {"key": "q.orderBy", "value": "", "description": "Sort field", "disabled": true}
      ]
    },
    "description": "Get {table description}. Filter by {list key fields}."
  }
}
```

**For CRUD endpoints, add 4 requests:** GET, POST, PUT, DELETE

**3b. Update API Documentation**

Read: `memory/API_DOCUMENTATION.md`

Find appropriate section, add:

```markdown
### GET /api/{endpoint-name}

Get records from {table description}.

**Parameters:**
- `q.where` (string) - Filter condition
- `q.orderBy` (string) - Sort field
- `q.limit` (integer) - Max records (default: 100, max: 1000)
{list field-specific filters if applicable}

**Example:**
\`\`\`bash
GET /api/{endpoint-name}?{example-filter}=value&limit=10
\`\`\`

**Response:**
\`\`\`json
[
  {sample response object}
]
\`\`\`
```

**3c. Update Endpoint Inventory**

Read: `memory/API_ENDPOINTS.md`

Add line to appropriate section:
```markdown
- GET /api/{endpoint-name} - {Brief description}
```

Increment total endpoint count at the top.

Update progress: `[████████████████] 100% - Complete!`

---

### PHASE 5: GENERATE TESTS

**Create test file:** `test-{endpoint-name}.js`

```javascript
const axios = require('axios');

const WSL_IP = '{detected-wsl-ip}';
const BASE_URL = `http://${WSL_IP}:3002`;

async function testEndpoint() {
    console.log('Testing {endpoint-name} endpoint...\n');

    try {
        // Test 1: Basic GET
        const response = await axios.get(`${BASE_URL}/api/{endpoint-name}?limit=5`);
        console.log('✅ Basic GET:', response.status, `(${response.data.length} records)`);

        // Test 2: With filter (if applicable)
        {generate filter test based on configured filters}

        // Test 3: Sorting
        const sorted = await axios.get(`${BASE_URL}/api/{endpoint-name}?q.orderBy={first-field} DESC&limit=3`);
        console.log('✅ Sorting:', sorted.status);

        console.log('\n✅ All tests passed!');
    } catch (error) {
        console.error('❌ Test failed:', error.message);
        if (error.response) {
            console.error('Response:', error.response.data);
        }
    }
}

testEndpoint();
```

---

### PHASE 6: PRESENT RESULTS

**Display summary:**

```
✅ Endpoint Created Successfully!

📁 Files Created/Modified:
  ✅ src/routes/{kebab-case-name}.js (NEW - {line-count} lines)
  ✅ server.js (UPDATED - added route registration)
  ✅ docs/NWCA-API.postman_collection.json (UPDATED)
  ✅ memory/API_DOCUMENTATION.md (UPDATED)
  ✅ memory/API_ENDPOINTS.md (UPDATED)
  ✅ test-{endpoint-name}.js (NEW - test file)

🎯 Endpoint Details:
  Path: /api/{endpoint-name}
  Type: {Read-Only/Full CRUD}
  Table: {table-name}
  Filters: {list of filters or "generic q.where"}

📋 Next Steps:
```

---

### PHASE 7: LOCAL TESTING GUIDE

**Provide step-by-step testing instructions:**

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
STEP 1: TEST IN CASPIO SWAGGER FIRST
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Before testing locally, verify the query works in Caspio:

1. Go to: https://c3eku948.caspio.com/integrations/rest
2. Find: GET /v3/tables/{table-name}/records
3. Click "Try it out"

{If user configured field filters, show example queries:}
4. In the "q.where" box, enter:
   {FIELD_NAME}='{example-value}'

   Examples to try:
   {generate 3-4 example queries based on configured filters}

5. Click "Execute"
6. Verify you get results

✅ Once Swagger test works, proceed to Step 2.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
STEP 2: START LOCAL SERVER
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

cd /mnt/c/Users/erik/OneDrive\ -\ Northwest\ Custom\ Apparel/2025/caspio-pricing-proxy
node start-test-server.js

Look for:
  ✓ {Endpoint Name} routes loaded
  🚀 Server started on port 3002

⚠️ If you see errors, check the Troubleshooting section below.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
STEP 3: TEST ENDPOINT LOCALLY
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Option A: Run test script (recommended)
  node test-{endpoint-name}.js

Option B: Use curl commands

Basic test:
curl 'http://{wsl-ip}:3002/api/{endpoint-name}?limit=10'

{If filters configured, generate specific test commands}
With filter:
curl 'http://{wsl-ip}:3002/api/{endpoint-name}?{filter-field}={example-value}'

With sorting:
curl 'http://{wsl-ip}:3002/api/{endpoint-name}?q.orderBy={field} DESC&limit=5'

Complex query:
curl 'http://{wsl-ip}:3002/api/{endpoint-name}?q.where={example-complex-query}'

Option C: Test in Postman
  1. Import: docs/NWCA-API.postman_collection.json
  2. Find: {Endpoint Name}
  3. Change {{baseUrl}} to: http://{wsl-ip}:3002
  4. Send request

✅ Expected: JSON array with data
❌ If errors, see Troubleshooting below.
```

---

### PHASE 8: DEPLOYMENT CHECKLIST

**Generate interactive deployment guide:**

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
DEPLOYMENT TO HEROKU CHECKLIST
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

📋 PRE-DEPLOYMENT (Local Testing)
□ Server starts without errors
□ Endpoint returns data locally
□ Filters work correctly
□ No console errors or warnings
□ Test file passes all checks

📋 GIT PREPARATION
Run these commands:

1. Review changes:
   git status
   git diff

2. Stage files:
   git add src/routes/{endpoint-name}.js
   git add server.js
   git add docs/NWCA-API.postman_collection.json
   git add memory/API_DOCUMENTATION.md
   git add memory/API_ENDPOINTS.md

3. Create commit:
   git commit -m "feat: add {endpoint-name} endpoint for {table-description}

   - Created GET /api/{endpoint-name}
   - Supports filters: {list filters}
   - Updated documentation and Postman collection"

4. Push to GitHub:
   git push origin develop
   (or main, depending on your branch)

📋 HEROKU DEPLOYMENT

1. Deploy to Heroku:
   git push heroku main
   (or: git push heroku develop:main if on develop branch)

2. Watch deployment:
   Wait for "Verifying deploy... done."

3. Check logs:
   heroku logs --tail

   Look for:
   ✓ {Endpoint Name} routes loaded
   ✓ Server started

4. Test production endpoint:
   curl https://caspio-pricing-proxy-ab30a049961a.herokuapp.com/api/{endpoint-name}?limit=5

5. Verify in Postman:
   - Change {{baseUrl}} to production URL
   - Test all query parameters
   - Save successful tests

📋 POST-DEPLOYMENT

□ Production endpoint returns data
□ Filters work in production
□ Postman tests pass
□ Update README.md (endpoint count if needed)
□ Notify team (if applicable)

✅ Deployment Complete!

Production URL:
https://caspio-pricing-proxy-ab30a049961a.herokuapp.com/api/{endpoint-name}
```

---

### PHASE 9: ROLLBACK PLAN

**Create rollback script:**

File: `.claude/rollback-{endpoint-name}.sh`

```bash
#!/bin/bash
# Rollback script for {endpoint-name} endpoint
# Created: {timestamp}

echo "🔄 Rolling back {endpoint-name} endpoint..."

# Stop server if running
pkill -f "node server.js" 2>/dev/null

# Git rollback
git checkout HEAD~1 -- src/routes/{endpoint-name}.js
git checkout HEAD~1 -- server.js
git checkout HEAD~1 -- docs/NWCA-API.postman_collection.json
git checkout HEAD~1 -- memory/API_DOCUMENTATION.md
git checkout HEAD~1 -- memory/API_ENDPOINTS.md

# Remove new files
rm -f src/routes/{endpoint-name}.js
rm -f test-{endpoint-name}.js
rm -f .claude/rollback-{endpoint-name}.sh

echo "✅ Rollback complete!"
echo "⚠️  You may need to restart the server"
```

**Display rollback info:**
```
💾 ROLLBACK CREATED

If something goes wrong, you can undo all changes:

bash .claude/rollback-{endpoint-name}.sh

This will:
- Remove the new route file
- Restore server.js
- Restore documentation files
- Clean up test files
```

---

### PHASE 10: ERROR RECOVERY & TROUBLESHOOTING

**Include common issues and fixes:**

Read from: `troubleshooting.md` and customize based on endpoint type.

**Display:**
```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
TROUBLESHOOTING
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

❌ "Port 3002 already in use"
   Fix: pkill -f "node server.js" then restart

❌ "Module not found: src/routes/{endpoint-name}"
   Fix: Check file was created correctly
        Run: ls -la src/routes/{endpoint-name}.js

❌ "Caspio authentication failed"
   Fix: Verify .env credentials
        Test in Swagger first

❌ "Endpoint returns empty array []"
   Fix: Test the query in Caspio Swagger
        Check q.where syntax
        Verify table has data

❌ "TypeError: Cannot read property 'Result'"
   Fix: Caspio response structure changed
        Check API version in config.js

❌ "Heroku deployment failed"
   Fix: heroku logs --tail
        Look for specific error message
        Verify all files committed

❌ "Filter doesn't work"
   Fix: Check field name spelling (case-sensitive)
        Test in Swagger: {FIELD}='{value}'
        URL encode special characters

Need more help? Check: memory/API_DOCUMENTATION.md
```

---

## QUERY EXAMPLES TO GENERATE

Based on configured filters, generate practical examples:

**Text filters:**
```
# Exact match
/api/{endpoint}?{FIELD}=value

# Multiple filters
/api/{endpoint}?{FIELD1}=value1&{FIELD2}=value2

# Complex query
/api/{endpoint}?q.where={FIELD1}='value' AND {FIELD2}='value'
```

**Number filters:**
```
# Greater than
/api/{endpoint}?q.where={NUMBER_FIELD}>100

# Range
/api/{endpoint}?q.where={NUMBER_FIELD} BETWEEN 10 AND 50

# Combined
/api/{endpoint}?q.where={NUMBER_FIELD}>20 AND {TEXT_FIELD}='Active'
```

**Date filters:**
```
# After date
/api/{endpoint}?q.where={DATE_FIELD}>='2024-01-01'

# Date range
/api/{endpoint}?q.where={DATE_FIELD}>='2024-01-01' AND {DATE_FIELD}<='2024-12-31'

# Last 30 days (show how to calculate)
/api/{endpoint}?q.where={DATE_FIELD}>='{today-30days}'
```

**Boolean filters:**
```
# True/False
/api/{endpoint}?q.where={BOOL_FIELD}=true
/api/{endpoint}?q.where={BOOL_FIELD}=false
```

---

## FINAL OUTPUT SUMMARY

**End with clear success message:**

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
✅ ENDPOINT CREATED SUCCESSFULLY!
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

📍 Endpoint: GET /api/{endpoint-name}
📊 Table: {table-name}
🔧 Type: {Read-Only/Full CRUD}
📁 Files: {count} created/modified
⏱️  Time: {elapsed-seconds} seconds

🎯 QUICK START:
1. Start server: node start-test-server.js
2. Test: curl 'http://{wsl-ip}:3002/api/{endpoint-name}?limit=10'
3. Deploy: git push heroku main

📚 DOCUMENTATION:
- Local: memory/API_DOCUMENTATION.md
- Postman: docs/NWCA-API.postman_collection.json
- Tests: test-{endpoint-name}.js

🆘 HELP:
- Rollback: bash .claude/rollback-{endpoint-name}.sh
- Issues: See troubleshooting section above

Happy coding! 🚀
```

---

## IMPORTANT NOTES FOR CLAUDE

### Field Type Detection Logic

When analyzing sample response data, use this logic:

```
For each field in sample record:

  If field name contains: "date", "created", "updated", "modified"
    → Type: DATE
    → Filter syntax: >= / <= / BETWEEN
    → Suggest: dateFrom/dateTo parameters

  If field name contains: "is", "has", "enabled", "active"
    → Type: BOOLEAN
    → Filter syntax: =true / =false

  If field name is: "status", "type", "category", "name"
    → Type: TEXT (categorical)
    → Filter syntax: ='value'
    → Suggest: exact match

  If field name contains: "description", "notes", "comment"
    → Type: TEXT (free text)
    → Filter syntax: LIKE '%value%'
    → Suggest: partial match

  If sample value is number
    → Type: NUMBER
    → Filter syntax: >, <, =, BETWEEN

  Otherwise
    → Type: TEXT
    → Filter syntax: ='value'
```

### Code Generation Rules

1. **Always use `fetchAllCaspioPages`** - Never `makeCaspioRequest`
2. **Always include error logging** with Caspio Request ID
3. **Always validate limit** parameter (1-1000 range)
4. **Always include PK_ID** in responses (auto-included by Caspio)
5. **Never expose password fields** in GET responses
6. **Always use ISO 8601** date format in documentation
7. **Always sort route imports** alphabetically in server.js
8. **Always include examples** in documentation

### WSL IP Handling

The WSL IP changes on Windows reboot. Always:
1. Detect current IP at runtime
2. Show it to the user
3. Use it in all local test commands
4. Remind user it changes on reboot

### Safety Checks Priority

These checks are CRITICAL and must not be skipped:
1. Git status (prevent conflicts)
2. Environment variables (prevent auth failures)
3. Duplicate detection (prevent overwrites)
4. WSL IP detection (enable local testing)

### User Communication Style

Since user is not a programmer:
- ✅ Use plain English, not jargon
- ✅ Show progress indicators
- ✅ Provide exact commands to copy/paste
- ✅ Explain WHY each step matters
- ✅ Give examples, not just syntax
- ❌ Don't assume technical knowledge
- ❌ Don't skip error explanations
- ❌ Don't use complex regex or advanced commands

---

## EXAMPLES FOR REFERENCE

See `examples.md` for real-world examples from existing endpoints:
- production-schedules.js (simple read-only)
- art.js (full CRUD with filters)
- pricing-bundle.js (specialized logic)

See `troubleshooting.md` for detailed error recovery procedures.

See `caspio-reference.md` for complete Caspio API v3 reference.

---

## SKILL ACTIVATION TRIGGERS

This skill activates when user says:
- "create a new api endpoint"
- "create endpoint for {table}"
- "add caspio endpoint"
- "help me create an api"
- "I have a swagger response"
- "expose {table} through api"

## SKILL COMPLETION

The skill is complete when:
✅ All files created/modified
✅ Documentation updated
✅ Test commands provided
✅ Deployment checklist shown
✅ Rollback plan created
✅ User has clear next steps

Then return control to user for testing and deployment.
