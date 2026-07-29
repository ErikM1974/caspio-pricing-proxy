# Getting Started with API Creator Skill

Quick start guide for creating your first endpoint.

## ⚡ Quick Start (5 minutes)

### Step 1: Open Caspio Swagger
1. Go to: https://c3eku948.caspio.com/integrations/rest
2. Find your table in the list
3. Click on: `GET /v3/tables/{tableName}/records`
4. Click "Try it out"
5. Click "Execute"
6. Copy the **curl command** shown

### Step 2: Trigger the Skill
In Claude Code, say:
```
"Create a new API endpoint"
```

### Step 3: Paste Swagger Info
Paste the curl command you copied.

### Step 4: Answer Questions
The skill will ask 3-4 simple questions:
- Endpoint path? (suggestion provided - just press Enter)
- Read-only or CRUD? (choose 1 for read-only)
- Which filters? (choose 1 for suggested filters)
- Special requirements? (press Enter for none)

### Step 5: Test Locally
```bash
# Start server
node start-test-server.js

# Test endpoint (use YOUR WSL IP)
curl 'http://172.20.132.206:3002/api/your-endpoint?limit=10'
```

### Step 6: Deploy
```bash
git add .
git commit -m "feat: add new endpoint"
git push origin main
git push heroku main
```

Done! 🎉

---

## 📝 Example: Creating Sanmar Products Endpoint

### What You'll Create
**Endpoint:** `GET /api/sanmar-products`
**Table:** `Sanmar_Bulk_251816_Feb2024`
**Filters:** STYLE, BRAND_NAME, PRODUCT_STATUS, CATEGORY_NAME

### Swagger Command
```bash
curl -X 'GET' \
  'https://c3eku948.caspio.com/integrations/rest/v3/tables/Sanmar_Bulk_251816_Feb2024/records' \
  -H 'accept: application/json' \
  -H 'Authorization: Bearer ...'
```

### Your Interaction
```
You: "Create a new API endpoint"

Skill: "Paste your Caspio information..."

You: [Paste curl command above]

Skill: "Endpoint path? Suggested: /api/sanmar-products"

You: [Press Enter]

Skill: "Read-only or Full CRUD? (1 or 2)"

You: "1"

Skill: "Field filters? Suggested: STYLE, BRAND_NAME, PRODUCT_STATUS, CATEGORY_NAME
       1. Use suggested
       2. No filters
       3. Custom"

You: "1"

Skill: "✅ Created endpoint!
       Files created:
       - src/routes/sanmar-products.js
       - Updated server.js
       - Updated Postman collection

       Test: curl 'http://172.20.132.206:3002/api/sanmar-products?limit=10'"
```

### Test It
```bash
# Start server
node start-test-server.js

# Basic test
curl 'http://172.20.132.206:3002/api/sanmar-products?limit=10'

# Filter by style
curl 'http://172.20.132.206:3002/api/sanmar-products?STYLE=LOG105'

# Filter by brand
curl 'http://172.20.132.206:3002/api/sanmar-products?BRAND_NAME=OGIO'

# Multiple filters
curl 'http://172.20.132.206:3002/api/sanmar-products?BRAND_NAME=OGIO&PRODUCT_STATUS=Active'
```

### Deploy It
```bash
git add .
git commit -m "feat: add Sanmar products endpoint

- Created GET /api/sanmar-products
- Supports filters: STYLE, BRAND_NAME, PRODUCT_STATUS, CATEGORY_NAME
- Updated documentation"

git push origin develop
git push heroku main
```

### Verify Production
```bash
curl 'https://caspio-pricing-proxy-ab30a049961a.herokuapp.com/api/sanmar-products?limit=5'
```

---

## 🎯 Common Use Cases

### Use Case 1: Simple Lookup Table
**Example:** Production schedules, pricing tiers, categories

**Choose:**
- Pattern: Read-only (1)
- Filters: No filters (2) - just q.where

**Result:** Clean, simple endpoint for reference data

---

### Use Case 2: Searchable Product Data
**Example:** Products, inventory, catalog items

**Choose:**
- Pattern: Read-only (1)
- Filters: Use suggested (1) - STYLE, BRAND, CATEGORY, etc.

**Result:** User-friendly search endpoint with field-specific filters

---

### Use Case 3: Editable Business Data
**Example:** Art requests, customer records, orders

**Choose:**
- Pattern: Full CRUD (2)
- Filters: Use suggested (1) or custom (3)

**Result:** Complete CRUD API with GET, POST, PUT, DELETE

---

## 🛠️ What Gets Created

### Files Created:
1. **Route file** - `src/routes/your-endpoint.js`
   - Contains all endpoint logic
   - Includes error handling
   - Has pagination support

2. **Test file** - `test-your-endpoint.js`
   - Ready-to-run tests
   - Example queries
   - Validates endpoint works

3. **Rollback script** - `.claude/rollback-your-endpoint.sh`
   - Emergency undo if needed
   - Restores previous state

### Files Updated:
1. **server.js** - Route registration added
2. **Postman collection** - New request(s) added
3. **API_DOCUMENTATION.md** - Endpoint documented
4. **API_ENDPOINTS.md** - Added to inventory

---

## 🔍 Pre-Flight Checks

Before creating endpoint, skill checks:
- ✅ Git repository is clean
- ✅ Environment variables present (.env)
- ✅ Dependencies installed (node_modules)
- ✅ WSL IP detected
- ✅ Port 3002 available
- ⚠️ No duplicate endpoints

If any fail, you'll get clear fix instructions.

---

## 💡 Tips for Success

### 1. Test in Swagger First
Before creating the endpoint:
- Go to Swagger UI
- Try your query in the "q.where" box
- Verify it returns data
- Then create the endpoint

### 2. Start Simple
- Begin with read-only
- Add CRUD later if needed
- Use suggested filters first
- Add custom logic incrementally

### 3. Use Descriptive Names
Good endpoint names:
- `/api/sanmar-products` ✅
- `/api/production-schedules` ✅
- `/api/customer-orders` ✅

Avoid:
- `/api/data` ❌ (too generic)
- `/api/sanmar_bulk_251816` ❌ (ugly)
- `/api/get-stuff` ❌ (redundant "get")

### 4. Test Locally Before Deploying
```bash
# Always run these before deploying:
1. node start-test-server.js  # Server starts?
2. curl 'http://...:3002/api/...'  # Endpoint works?
3. node test-your-endpoint.js  # Tests pass?
4. git status  # Ready to commit?
```

### 5. Commit Often
```bash
# Good: Small, focused commits
git commit -m "feat: add sanmar-products endpoint"
git commit -m "docs: update API documentation"

# Bad: One massive commit
git commit -m "added stuff and fixed things"
```

---

## ❌ Common First-Time Mistakes

### Mistake 1: Skipping Swagger Test
**Problem:** Create endpoint without testing query in Swagger first

**Result:** Endpoint created but query doesn't work

**Fix:** Always test query in Swagger before creating endpoint

---

### Mistake 2: Using Localhost from Windows
**Problem:** Try to access `http://localhost:3002` from Windows browser

**Result:** Connection refused

**Fix:** Use WSL IP address (skill shows you this)
```
http://172.20.132.206:3002/api/...
```

---

### Mistake 3: Forgetting to Start Server
**Problem:** Test endpoint without starting server

**Result:** "Connection refused"

**Fix:** Always run `node start-test-server.js` first

---

### Mistake 4: Typo in Table Name
**Problem:** `Sanmar_Bulk` instead of `Sanmar_Bulk_251816_Feb2024`

**Result:** "Table not found" error

**Fix:** Copy table name directly from Swagger (case-sensitive!)

---

### Mistake 5: Not Using WSL IP Detection
**Problem:** Manually type old/wrong IP address

**Result:** Can't connect

**Fix:** Let skill detect your current WSL IP automatically

---

## 🚨 When Something Goes Wrong

### Server Won't Start
```bash
# Check syntax
node -c server.js
node -c src/routes/your-endpoint.js

# See detailed errors
DEBUG=* node server.js
```

### Endpoint Returns 404
```bash
# Check server logs for route loading
# Should see: "✓ Your Endpoint routes loaded"

# If missing, check server.js registration
grep "your-endpoint" server.js
```

### Empty Results []
```bash
# Test in Swagger first
# If Swagger works but endpoint doesn't = bug
# If Swagger empty too = query or data issue
```

See `troubleshooting.md` for complete guide.

---

## 📚 Next Steps

After creating your first endpoint:

1. **Read examples.md** - See real-world patterns
2. **Review troubleshooting.md** - Know how to fix issues
3. **Check caspio-reference.md** - Understand Caspio API
4. **Create more endpoints** - Practice makes perfect!

---

## 🎓 Learning Resources

- **Caspio REST API Docs:** https://howto.caspio.com/web-services-api/rest-api/
- **Project Documentation:** `memory/API_DOCUMENTATION.md`
- **Existing Endpoints:** Look at `src/routes/` for examples
- **This Skill's Examples:** `.claude/skills/api-creator/examples.md`

---

## ✅ Success Checklist

Before considering your endpoint "done":

**Development:**
- [ ] Tested query in Caspio Swagger
- [ ] Created endpoint using skill
- [ ] Server starts without errors
- [ ] Endpoint returns data locally
- [ ] Filters work correctly
- [ ] Test file passes

**Documentation:**
- [ ] Postman collection updated
- [ ] API documentation updated
- [ ] Endpoint inventory updated
- [ ] Commit message is descriptive

**Deployment:**
- [ ] Committed to git
- [ ] Pushed to GitHub
- [ ] Deployed to Heroku
- [ ] Production endpoint tested
- [ ] Postman production tests pass

---

## 🎉 You're Ready!

You now have everything you need to create production-ready API endpoints in minutes instead of hours.

**Start creating your first endpoint now!**

Say to Claude: **"Create a new API endpoint"**
