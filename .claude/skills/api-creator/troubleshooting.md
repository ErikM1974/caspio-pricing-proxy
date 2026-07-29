# API Creator Troubleshooting Guide

Common issues and solutions when creating and deploying endpoints.

## Pre-Flight Check Errors

### ❌ Git has uncommitted changes
**Error:** "You have uncommitted changes"

**Cause:** Working directory has modified files not committed to git

**Fix:**
```bash
# Option 1: Commit the changes
git add .
git commit -m "your message"

# Option 2: Stash the changes
git stash

# Option 3: Discard the changes (careful!)
git checkout -- .
```

**Prevention:** Always commit or stash changes before creating new endpoints

---

### ❌ Missing environment variables
**Error:** "Missing Caspio credentials in .env file"

**Cause:** `.env` file missing or incomplete

**Fix:**
```bash
# Check if .env exists
ls -la .env

# If missing, copy from example
cp .env.example .env

# Edit .env and add your credentials
# Required variables:
CASPIO_CLIENT_ID=your_client_id_here
CASPIO_CLIENT_SECRET=your_client_secret_here
CASPIO_DOMAIN=c3eku948
CASPIO_TOKEN_URL=https://c3eku948.caspio.com/oauth/token
```

**Get credentials from:**
1. Log into Caspio
2. Go to: Account → REST API
3. Copy Client ID and Client Secret

---

### ❌ Dependencies not installed
**Error:** "Module not found" or "node_modules doesn't exist"

**Cause:** NPM packages not installed

**Fix:**
```bash
npm install
```

**Verify:**
```bash
ls -la node_modules/ | wc -l  # Should show many packages
```

---

### ❌ Port 3002 already in use
**Error:** "Port 3002 is already in use" or "EADDRINUSE"

**Cause:** Server is already running in another terminal

**Fix:**
```bash
# Kill the running server
pkill -f "node server.js"

# Or find and kill specific process
lsof -i :3002
kill -9 <PID>

# Restart server
node start-test-server.js
```

**Prevention:** Use one terminal for the server, keep it visible

---

### ❌ Cannot detect WSL IP
**Error:** "Could not detect WSL IP"

**Cause:** Running on non-WSL system or network issue

**Fix:**
```bash
# Manual detection
hostname -I | awk '{print $1}'

# Or check ip address
ip addr show eth0

# Use localhost if not on WSL
curl http://localhost:3002/api/health
```

---

## Code Generation Errors

### ❌ Endpoint already exists
**Error:** "This endpoint already exists"

**Cause:** Route file or endpoint path already registered

**Options:**
1. **Overwrite** - Replace existing code (careful!)
2. **Choose different name** - Use `/api/sanmar-products-v2`
3. **Cancel** - Stop and investigate existing endpoint

**Check existing:**
```bash
# List all route files
ls -la src/routes/

# Check server.js for registrations
grep -n "app.use('/api'" server.js

# Search in Postman collection
grep -i "sanmar" docs/NWCA-API.postman_collection.json
```

---

### ❌ Invalid table name
**Error:** "Table not found" or "ObjectNotFound"

**Cause:** Table name misspelled or doesn't exist in Caspio

**Fix:**
```bash
# Test in Swagger first:
# 1. Go to https://c3eku948.caspio.com/integrations/rest
# 2. GET /v3/tables (lists all tables)
# 3. Find your table name (case-sensitive!)
# 4. Try GET /v3/tables/{tableName}/records
```

**Common issues:**
- Case sensitivity: `production_schedules` vs `Production_Schedules`
- Underscores vs spaces: `Order_ODBC` vs `Order ODBC`
- Typos: `Sanmer` vs `Sanmar`

---

### ❌ Cannot parse Swagger input
**Error:** "Could not extract table name from input"

**Cause:** Unexpected input format

**Fix:**
Provide input in one of these formats:

**Format 1: curl command (recommended)**
```bash
curl -X 'GET' \
  'https://c3eku948.caspio.com/integrations/rest/v3/tables/MyTable/records' \
  -H 'accept: application/json'
```

**Format 2: Just the table name**
```
Production_Schedules
```

**Format 3: Full Swagger JSON**
```json
{
  "Result": [{"PK_ID": 1, ...}]
}
```

---

## Local Testing Errors

### ❌ Server won't start
**Error:** Various errors when running `node start-test-server.js`

**Diagnosis:**
```bash
# Check for syntax errors
node server.js

# Check if route file is valid
node -c src/routes/your-endpoint.js

# View detailed errors
DEBUG=* node server.js
```

**Common causes:**
1. **Syntax error in route file** - Missing `}`, `,`, etc.
2. **Missing require statement** - Check imports at top of file
3. **File path wrong** - Check `require('./src/routes/...')`

**Fix:**
```bash
# If you just created the endpoint, check:
ls -la src/routes/your-endpoint.js  # File exists?
node -c src/routes/your-endpoint.js  # Syntax valid?

# Check server.js registration
grep -A2 "your-endpoint" server.js
```

---

### ❌ Endpoint returns 404
**Error:** "Cannot GET /api/your-endpoint"

**Cause:** Route not registered or wrong path

**Fix:**
```bash
# Check server startup logs
# Should see: "✓ Your Endpoint routes loaded"

# If missing, check server.js:
grep -n "your-endpoint" server.js

# Verify route registration:
# Should have:
# const yourEndpointRoutes = require('./src/routes/your-endpoint');
# app.use('/api', yourEndpointRoutes);
```

**Restart server** after fixing registration

---

### ❌ Endpoint returns empty array []
**Error:** Endpoint works but returns `[]` (empty)

**Cause:** Query filter too restrictive or table is empty

**Diagnosis:**
```bash
# Test 1: No filters (get all records)
curl 'http://172.20.132.206:3002/api/your-endpoint?limit=10'

# Test 2: Check in Caspio Swagger
# Go to Swagger and try the same query
# If Swagger returns data but your endpoint doesn't, there's a bug
# If Swagger also returns empty, the table is empty or filter is wrong
```

**Common fixes:**
- Remove filters: `?limit=10` (no where clause)
- Check field spelling: `STYLE` vs `style` (case-sensitive)
- Check table has data in Caspio Datasheet
- Try broader filter: `?q.where=PK_ID>0`

---

### ❌ Caspio authentication failed
**Error:** "Could not obtain Caspio access token" or "401 Unauthorized"

**Cause:** Invalid credentials or expired token

**Fix:**
```bash
# Check .env file
cat .env | grep CASPIO

# Verify credentials in Caspio:
# 1. Log into Caspio
# 2. Go to: Account → REST API
# 3. Compare Client ID and Secret
# 4. Regenerate if needed (will invalidate old tokens)

# Test authentication manually
node -e "
const axios = require('axios');
require('dotenv').config();
const params = new URLSearchParams({
  grant_type: 'client_credentials',
  client_id: process.env.CASPIO_CLIENT_ID,
  client_secret: process.env.CASPIO_CLIENT_SECRET
});
axios.post(process.env.CASPIO_TOKEN_URL, params)
  .then(r => console.log('✅ Auth works!'))
  .catch(e => console.log('❌ Auth failed:', e.message));
"
```

---

### ❌ Filter syntax error
**Error:** "IncorrectQueryParameter" or "SqlServerError"

**Cause:** Invalid WHERE clause syntax

**Examples of WRONG syntax:**
```
❌ q.where=STYLE=LOG105           (missing quotes)
❌ q.where=STYLE='LOG105"         (mismatched quotes)
❌ q.where=STYLE LIKE LOG105      (missing %)
❌ q.where=Price > 100            (spaces in operators - sometimes problematic)
❌ q.where=Date_Created>2024-01-01 (missing quotes for dates)
```

**Examples of CORRECT syntax:**
```
✅ q.where=STYLE='LOG105'
✅ q.where=STYLE LIKE '%LOG%'
✅ q.where=Price>100
✅ q.where=Date_Created>='2024-01-01'
✅ q.where=Status='Active' AND Price<50
```

**Testing:**
1. **Test in Swagger first** - Verify the query works in Caspio Swagger UI
2. **URL encode special characters** - Space = %20, quotes = %27
3. **Use Postman** - Handles encoding automatically

---

### ❌ Timeout errors
**Error:** "Request timeout" or "ETIMEDOUT"

**Cause:** Query taking too long (large table, complex filter)

**Fix:**
```javascript
// In your route file, increase timeout:
const result = await fetchAllCaspioPages(resource, params, {
    totalTimeout: 300000  // 5 minutes instead of default
});
```

**Or optimize query:**
- Add more specific filters
- Reduce limit
- Add index in Caspio (on filtered fields)
- Use `q.select` to return fewer fields

---

## Deployment Errors

### ❌ Git push rejected
**Error:** "Updates were rejected" or "non-fast-forward"

**Cause:** Remote has changes you don't have locally

**Fix:**
```bash
# Pull latest changes first
git pull origin main

# Resolve any conflicts, then:
git push origin main
```

---

### ❌ Heroku deployment failed
**Error:** "Failed to compile" or "Build failed"

**Diagnosis:**
```bash
# Check Heroku logs
heroku logs --tail

# Common errors:
# - Missing dependency in package.json
# - Syntax error in code
# - Missing files
```

**Fix based on error:**

**Missing dependency:**
```bash
npm install missing-package --save
git add package.json package-lock.json
git commit -m "fix: add missing dependency"
git push heroku main
```

**Syntax error:**
```bash
# Fix the error locally
# Test: node server.js
# Commit and redeploy
git add .
git commit -m "fix: syntax error"
git push heroku main
```

---

### ❌ Heroku endpoint returns 404
**Error:** Production URL works but endpoint 404

**Cause:** Code not deployed or route not registered

**Fix:**
```bash
# Check Heroku logs for route registration
heroku logs | grep "routes loaded"

# Should see: "✓ Your Endpoint routes loaded"

# If missing, verify files were deployed:
heroku run ls src/routes/

# Redeploy if needed:
git push heroku main --force
```

---

### ❌ Works locally but fails on Heroku
**Error:** Endpoint works on localhost but not production

**Common causes:**

1. **Environment variables missing on Heroku:**
```bash
# Check Heroku env vars
heroku config

# Should have:
CASPIO_CLIENT_ID
CASPIO_CLIENT_SECRET
CASPIO_DOMAIN
CASPIO_TOKEN_URL

# Add if missing:
heroku config:set CASPIO_CLIENT_ID=your_id
```

2. **Port hardcoded:**
```javascript
// ❌ Wrong (hardcoded port)
app.listen(3002)

// ✅ Correct (use env variable)
app.listen(process.env.PORT || 3002)
```

3. **File path case sensitivity:**
```javascript
// Linux (Heroku) is case-sensitive
// ❌ Wrong if file is lowercase
require('./src/routes/SanmarProducts.js')

// ✅ Correct
require('./src/routes/sanmar-products.js')
```

---

## Data Issues

### ❌ Missing fields in response
**Error:** Expected fields not in response

**Cause:**
1. Field doesn't exist in table
2. Field is password type (excluded automatically)
3. Using `q.select` which excludes fields

**Fix:**
```bash
# Check table schema in Swagger:
GET /v3/tables/YourTable/fields

# Check if field is password type
# (password fields are never returned)

# Remove q.select to get all fields
GET /api/your-endpoint?limit=1
# (without q.select parameter)
```

---

### ❌ Date format issues
**Error:** Date in wrong format or can't filter by date

**Caspio uses ISO 8601:** `2024-01-30T14:30:00`

**For filtering, use:** `YYYY-MM-DD`

**Examples:**
```
✅ Date_Created>='2024-01-01'
✅ Date_Created>='2024-01-30T14:30:00'
❌ Date_Created>='01/30/2024'  (wrong format)
❌ Date_Created>='Jan 30 2024'  (wrong format)
```

---

### ❌ Number formatting issues
**Error:** Price shows as "21.99" but filter doesn't work

**Cause:** Number stored as text in Caspio

**Fix:**
```bash
# Check field type in Swagger:
GET /v3/tables/YourTable/fields

# If number stored as text, use quotes:
q.where=Price='21.99'  (text comparison)

# Not: q.where=Price>20  (numeric comparison won't work)
```

---

## Performance Issues

### ❌ Endpoint very slow
**Error:** Request takes > 10 seconds

**Diagnosis:**
```bash
# Time the request
time curl 'http://localhost:3002/api/your-endpoint?limit=10'

# Check number of records
curl 'http://localhost:3002/api/your-endpoint' | jq 'length'

# Check Caspio pagination (server logs)
# Look for: "Fetching page 1, page 2..." messages
```

**Fixes:**

1. **Add filters** (reduce records fetched)
```javascript
// Instead of getting all 100,000 records:
GET /api/your-endpoint

// Get only what you need:
GET /api/your-endpoint?q.where=Date_Created>='2024-01-01'&limit=100
```

2. **Use q.select** (fewer fields)
```javascript
// Instead of all 50 fields:
GET /api/your-endpoint

// Get only needed fields:
GET /api/your-endpoint?q.select=PK_ID,Name,Status,Date_Created
```

3. **Add caching** (for frequently accessed data)
```javascript
// In route file:
const NodeCache = require('node-cache');
const cache = new NodeCache({ stdTTL: 600 }); // 10 min cache

router.get('/your-endpoint', async (req, res) => {
    const cacheKey = JSON.stringify(req.query);
    const cached = cache.get(cacheKey);
    if (cached) {
        return res.json(cached);
    }

    const result = await fetchAllCaspioPages(...);
    cache.set(cacheKey, result);
    res.json(result);
});
```

---

## Rollback Procedure

### When to rollback:
- Endpoint causes server crashes
- Breaking changes to existing functionality
- Critical bugs in production

### How to rollback:
```bash
# Option 1: Use generated rollback script
bash .claude/rollback-your-endpoint.sh

# Option 2: Manual git revert
git log --oneline  # Find commit hash
git revert <commit-hash>
git push origin main
git push heroku main

# Option 3: Temporary fix (disable route)
# Comment out in server.js:
// const yourEndpointRoutes = require('./src/routes/your-endpoint');
// app.use('/api', yourEndpointRoutes);

# Restart server
```

---

## Getting Help

### Debug checklist:
1. ✅ Works in Caspio Swagger?
2. ✅ Works on localhost?
3. ✅ Works in Postman locally?
4. ✅ Deployed to Heroku?
5. ✅ Works in production?

### Information to collect:
- Error message (full text)
- Caspio Request ID (from headers)
- Server logs: `heroku logs --tail`
- Exact curl command that fails
- Expected vs actual response

### Resources:
- Caspio API Docs: https://howto.caspio.com/web-services-api/rest-api/
- Project docs: `memory/API_DOCUMENTATION.md`
- Examples: `.claude/skills/api-creator/examples.md`
- Caspio Support: Submit ticket with Request ID

---

## Prevention Best Practices

1. **Always test in Swagger first** - Verify query works before coding
2. **Start simple, add complexity** - Basic endpoint first, then filters
3. **Test locally before deploying** - Use test file or curl
4. **Commit working code frequently** - Easy to rollback
5. **Use descriptive commit messages** - Know what each commit does
6. **Monitor Heroku logs** - `heroku logs --tail` during deployment
7. **Keep documentation updated** - Future you will thank you
8. **Use rollback scripts** - Created automatically by skill

---

## Quick Reference: Common Commands

```bash
# Pre-flight
git status
cat .env
npm install
hostname -I | awk '{print $1}'

# Development
node start-test-server.js
curl http://localhost:3002/api/health
curl http://localhost:3002/api/your-endpoint?limit=10

# Testing
node test-your-endpoint.js

# Deployment
git add .
git commit -m "feat: add new endpoint"
git push origin main
git push heroku main
heroku logs --tail

# Troubleshooting
heroku logs --tail | grep error
curl -v http://localhost:3002/api/your-endpoint
git log --oneline
git diff HEAD~1

# Rollback
bash .claude/rollback-your-endpoint.sh
git revert HEAD
pkill -f "node server.js"
```
