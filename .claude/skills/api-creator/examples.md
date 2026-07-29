# API Creator Examples

Real-world examples from the NWCA proxy server codebase.

## Example 1: Simple Read-Only Endpoint

**Endpoint:** `/api/production-schedules`
**File:** `src/routes/production-schedules.js`
**Pattern:** Simple GET with standard filters

### Input (User provides):
```bash
curl -X 'GET' \
  'https://c3eku948.caspio.com/integrations/rest/v3/tables/Production_Schedules/records' \
  -H 'accept: application/json'
```

### Questions & Answers:
```
Q: Endpoint path?
A: /api/production-schedules

Q: Pattern type?
A: 1 (Read-Only)

Q: Field filters?
A: 2 (No field filters, just generic q.where)

Q: Special requirements?
A: 1 (None - standard endpoint)
```

### Generated Code Highlights:
```javascript
// Simple, clean endpoint
router.get('/production-schedules', async (req, res) => {
    const resource = '/tables/Production_Schedules/records';
    const params = {};

    if (req.query['q.where']) params['q.where'] = req.query['q.where'];
    if (req.query['q.orderBy']) params['q.orderby'] = req.query['q.orderBy'];
    params['q.limit'] = parseInt(req.query['q.limit'] || 100);

    const result = await fetchAllCaspioPages(resource, params);
    res.json(result);
});
```

### Usage:
```bash
# Get all schedules
GET /api/production-schedules

# Filter by date
GET /api/production-schedules?q.where=Date>'2024-01-01'

# Sort and limit
GET /api/production-schedules?q.orderBy=Date DESC&limit=50
```

---

## Example 2: CRUD with Field-Specific Filters

**Endpoint:** `/api/artrequests`
**File:** `src/routes/art.js`
**Pattern:** Full CRUD with custom filters

### Input (User provides):
Swagger response showing fields like: `PK_ID`, `CompanyName`, `Status`, `Priority`, `Date_Created`, `Due_Date`, etc.

### Questions & Answers:
```
Q: Endpoint path?
A: /api/artrequests

Q: Pattern type?
A: 2 (Full CRUD)

Q: Field filters?
A: 1 (Use suggested filters)
   Suggested: status, companyName, priority, salesRep, dateCreated

Q: Special requirements?
A: 1 (None - standard)
```

### Generated Code Highlights:
```javascript
// GET with field-specific filters
router.get('/artrequests', async (req, res) => {
    const params = {};
    const whereConditions = [];

    // Field-specific filters
    if (req.query.status) {
        whereConditions.push(`Status='${req.query.status}'`);
    }
    if (req.query.companyName) {
        whereConditions.push(`CompanyName LIKE '%${req.query.companyName}%'`);
    }
    if (req.query.priority) {
        whereConditions.push(`Priority='${req.query.priority}'`);
    }

    // Date range filters
    if (req.query.dateCreatedFrom) {
        whereConditions.push(`Date_Created>='${req.query.dateCreatedFrom}'`);
    }
    if (req.query.dateCreatedTo) {
        whereConditions.push(`Date_Created<='${req.query.dateCreatedTo}'`);
    }

    if (whereConditions.length > 0) {
        params['q.where'] = whereConditions.join(' AND ');
    }

    const result = await fetchAllCaspioPages('/tables/ArtRequests/records', params);
    res.json(result);
});

// POST - Create new art request
router.post('/artrequests', async (req, res) => {
    const token = await getCaspioAccessToken();
    const response = await axios.post(
        `${caspioApiBaseUrl}/tables/ArtRequests/records`,
        req.body,
        {
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json'
            }
        }
    );
    res.status(201).json(response.data);
});

// PUT - Update art request
router.put('/artrequests/:id', async (req, res) => {
    const token = await getCaspioAccessToken();
    const updateData = { PK_ID: parseInt(req.params.id), ...req.body };

    await axios.put(
        `${caspioApiBaseUrl}/tables/ArtRequests/records`,
        updateData,
        {
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json'
            }
        }
    );
    res.status(200).json({ message: 'Updated successfully' });
});

// DELETE - Delete art request
router.delete('/artrequests/:id', async (req, res) => {
    const token = await getCaspioAccessToken();
    await axios.delete(
        `${caspioApiBaseUrl}/tables/ArtRequests/records?q.where=PK_ID=${req.params.id}`,
        { headers: { 'Authorization': `Bearer ${token}` } }
    );
    res.status(204).send();
});
```

### Usage:
```bash
# GET - Read
GET /api/artrequests?status=In Progress
GET /api/artrequests?companyName=Nike&priority=High
GET /api/artrequests?dateCreatedFrom=2024-01-01&dateCreatedTo=2024-12-31

# POST - Create
POST /api/artrequests
{
  "CompanyName": "Test Company",
  "Status": "New",
  "Priority": "High"
}

# PUT - Update
PUT /api/artrequests/123
{
  "Status": "Completed",
  "Invoiced": true
}

# DELETE - Remove
DELETE /api/artrequests/123
```

---

## Example 3: Product Data with Multiple Filters

**Endpoint:** `/api/sanmar-products` (hypothetical)
**Table:** `Sanmar_Bulk_251816_Feb2024`
**Pattern:** Read-only with multiple field types

### Input (Sample Response):
```json
{
  "Result": [
    {
      "PK_ID": 1,
      "STYLE": "LOG105",
      "BRAND_NAME": "OGIO",
      "PRODUCT_STATUS": "Discontinued",
      "CATEGORY_NAME": "Polos/Knits",
      "COLOR_NAME": "Shock Green",
      "PIECE_PRICE": 21.99,
      "QTY": 22,
      "SALE_START_DATE": "2020-04-30T00:00:00",
      "IsTopSeller": false
    }
  ]
}
```

### Field Analysis:
- **Text fields:** STYLE, BRAND_NAME, PRODUCT_STATUS, CATEGORY_NAME, COLOR_NAME
- **Number fields:** PIECE_PRICE, QTY
- **Date fields:** SALE_START_DATE
- **Boolean fields:** IsTopSeller

### Questions & Answers:
```
Q: Endpoint path?
A: /api/sanmar-products

Q: Pattern type?
A: 1 (Read-Only)

Q: Field filters?
A: 1 (Use suggested)
   Suggested: STYLE, BRAND_NAME, PRODUCT_STATUS, CATEGORY_NAME, PIECE_PRICE range, date range

Q: Special requirements?
A: 1 (None)
```

### Generated Code:
```javascript
router.get('/sanmar-products', async (req, res) => {
    const params = {};
    const whereConditions = [];

    // Text filters (exact match)
    if (req.query.STYLE) {
        whereConditions.push(`STYLE='${req.query.STYLE}'`);
    }
    if (req.query.BRAND_NAME) {
        whereConditions.push(`BRAND_NAME='${req.query.BRAND_NAME}'`);
    }
    if (req.query.PRODUCT_STATUS) {
        whereConditions.push(`PRODUCT_STATUS='${req.query.PRODUCT_STATUS}'`);
    }
    if (req.query.CATEGORY_NAME) {
        whereConditions.push(`CATEGORY_NAME='${req.query.CATEGORY_NAME}'`);
    }
    if (req.query.COLOR_NAME) {
        whereConditions.push(`COLOR_NAME='${req.query.COLOR_NAME}'`);
    }

    // Number range filters
    if (req.query.minPrice) {
        whereConditions.push(`PIECE_PRICE>=${parseFloat(req.query.minPrice)}`);
    }
    if (req.query.maxPrice) {
        whereConditions.push(`PIECE_PRICE<=${parseFloat(req.query.maxPrice)}`);
    }

    // Boolean filter
    if (req.query.topSeller === 'true') {
        whereConditions.push(`IsTopSeller=true`);
    } else if (req.query.topSeller === 'false') {
        whereConditions.push(`IsTopSeller=false`);
    }

    // Date range filter
    if (req.query.saleDateFrom) {
        whereConditions.push(`SALE_START_DATE>='${req.query.saleDateFrom}'`);
    }
    if (req.query.saleDateTo) {
        whereConditions.push(`SALE_START_DATE<='${req.query.saleDateTo}'`);
    }

    if (whereConditions.length > 0) {
        params['q.where'] = whereConditions.join(' AND ');
    }

    // Generic q.where override
    if (req.query['q.where']) {
        params['q.where'] = req.query['q.where'];
    }

    if (req.query['q.orderBy']) {
        params['q.orderby'] = req.query['q.orderBy'];
    }

    params['q.limit'] = parseInt(req.query['q.limit'] || 100);

    const result = await fetchAllCaspioPages('/tables/Sanmar_Bulk_251816_Feb2024/records', params);
    res.json(result);
});
```

### Usage Examples:
```bash
# Filter by style
GET /api/sanmar-products?STYLE=LOG105

# Filter by brand and status
GET /api/sanmar-products?BRAND_NAME=OGIO&PRODUCT_STATUS=Active

# Price range
GET /api/sanmar-products?minPrice=10&maxPrice=50

# Top sellers only
GET /api/sanmar-products?topSeller=true

# Date range
GET /api/sanmar-products?saleDateFrom=2024-01-01&saleDateTo=2024-12-31

# Complex query (multiple filters)
GET /api/sanmar-products?BRAND_NAME=OGIO&PRODUCT_STATUS=Active&minPrice=20&topSeller=true

# Generic WHERE clause (advanced)
GET /api/sanmar-products?q.where=STYLE='LOG105' AND COLOR_NAME='Shock Green'

# Sorting
GET /api/sanmar-products?BRAND_NAME=OGIO&q.orderBy=PIECE_PRICE ASC

# Pagination
GET /api/sanmar-products?CATEGORY_NAME=Polos&limit=50
```

---

## Example 4: Order Dashboard (Specialized Logic)

**Endpoint:** `/api/order-dashboard`
**File:** `src/routes/orders.js` (partial example)
**Pattern:** Read-only with business logic

This is a more advanced endpoint that demonstrates **custom data transformation**.

### Key Features:
- Pre-calculated metrics (not raw table data)
- Aggregations and summaries
- Parameter-based filtering (days lookback)
- Response caching
- Year-over-year comparisons

### Code Pattern:
```javascript
router.get('/order-dashboard', async (req, res) => {
    const days = parseInt(req.query.days || 7);
    const includeDetails = req.query.includeDetails === 'true';

    // Calculate date range
    const endDate = new Date();
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - days);

    // Build WHERE clause
    const whereClause = `date_OrderInvoiced>='${startDate.toISOString().split('T')[0]}'`;

    // Fetch orders
    const orders = await fetchAllCaspioPages(
        '/tables/ORDER_ODBC/records',
        { 'q.where': whereClause }
    );

    // Calculate metrics
    const totalOrders = orders.length;
    const totalSales = orders.reduce((sum, order) => sum + (order.Total || 0), 0);
    const avgOrderValue = totalSales / totalOrders || 0;

    // Group by rep
    const byRep = {};
    orders.forEach(order => {
        const rep = order.CustomerServiceRep || 'Unknown';
        if (!byRep[rep]) byRep[rep] = { orders: 0, sales: 0 };
        byRep[rep].orders++;
        byRep[rep].sales += order.Total || 0;
    });

    // Build response
    const response = {
        period: { days, startDate, endDate },
        summary: { totalOrders, totalSales, avgOrderValue },
        byRep: byRep
    };

    if (includeDetails) {
        response.orders = orders;
    }

    res.json(response);
});
```

**When to use this pattern:**
- Dashboard endpoints
- Reporting/analytics
- Aggregated data
- Custom calculations

---

## Field Type Detection Examples

### Text Fields → Exact Match
```javascript
// Fields like: Status, CompanyName, Category, Type
if (req.query.status) {
    whereConditions.push(`Status='${req.query.status}'`);
}
```

### Text Fields → Partial Match (LIKE)
```javascript
// Fields like: Description, Notes, Comments, Keywords
if (req.query.searchTerm) {
    whereConditions.push(`Description LIKE '%${req.query.searchTerm}%'`);
}
```

### Number Fields → Exact or Range
```javascript
// Exact
if (req.query.quantity) {
    whereConditions.push(`Quantity=${parseInt(req.query.quantity)}`);
}

// Range
if (req.query.minPrice) {
    whereConditions.push(`Price>=${parseFloat(req.query.minPrice)}`);
}
if (req.query.maxPrice) {
    whereConditions.push(`Price<=${parseFloat(req.query.maxPrice)}`);
}
```

### Date Fields → Range
```javascript
if (req.query.dateFrom) {
    whereConditions.push(`Date_Created>='${req.query.dateFrom}'`);
}
if (req.query.dateTo) {
    whereConditions.push(`Date_Created<='${req.query.dateTo}'`);
}
```

### Boolean Fields
```javascript
if (req.query.isActive === 'true') {
    whereConditions.push(`IsActive=true`);
} else if (req.query.isActive === 'false') {
    whereConditions.push(`IsActive=false`);
}
```

---

## Testing Examples

### Test File Pattern:
```javascript
// test-sanmar-products.js
const axios = require('axios');

const WSL_IP = '172.20.132.206'; // Detected automatically
const BASE_URL = `http://${WSL_IP}:3002`;

async function testEndpoint() {
    console.log('Testing Sanmar Products endpoint...\n');

    try {
        // Test 1: Basic GET
        console.log('Test 1: Basic GET (limit 5)');
        const basic = await axios.get(`${BASE_URL}/api/sanmar-products?limit=5`);
        console.log(`✅ Status: ${basic.status}, Records: ${basic.data.length}`);

        // Test 2: Filter by style
        console.log('\nTest 2: Filter by STYLE');
        const filtered = await axios.get(`${BASE_URL}/api/sanmar-products?STYLE=LOG105`);
        console.log(`✅ Status: ${filtered.status}, Records: ${filtered.data.length}`);

        // Test 3: Multiple filters
        console.log('\nTest 3: Multiple filters');
        const multi = await axios.get(`${BASE_URL}/api/sanmar-products?BRAND_NAME=OGIO&PRODUCT_STATUS=Active`);
        console.log(`✅ Status: ${multi.status}, Records: ${multi.data.length}`);

        // Test 4: Price range
        console.log('\nTest 4: Price range');
        const priceRange = await axios.get(`${BASE_URL}/api/sanmar-products?minPrice=10&maxPrice=30`);
        console.log(`✅ Status: ${priceRange.status}, Records: ${priceRange.data.length}`);

        // Test 5: Sorting
        console.log('\nTest 5: Sorting');
        const sorted = await axios.get(`${BASE_URL}/api/sanmar-products?q.orderBy=PIECE_PRICE ASC&limit=10`);
        console.log(`✅ Status: ${sorted.status}, First price: ${sorted.data[0]?.PIECE_PRICE}`);

        console.log('\n✅ All tests passed!');

    } catch (error) {
        console.error('\n❌ Test failed:', error.message);
        if (error.response) {
            console.error('Response:', error.response.data);
            console.error('Status:', error.response.status);
        }
    }
}

testEndpoint();
```

---

## Deployment Example

### Git Workflow:
```bash
# 1. Review changes
git status
git diff

# 2. Stage files
git add src/routes/sanmar-products.js
git add server.js
git add docs/NWCA-API.postman_collection.json
git add memory/API_DOCUMENTATION.md
git add memory/API_ENDPOINTS.md

# 3. Commit with descriptive message
git commit -m "feat: add Sanmar products endpoint

- Created GET /api/sanmar-products
- Supports filters: STYLE, BRAND_NAME, PRODUCT_STATUS, CATEGORY_NAME
- Price range and date filtering
- Updated documentation and Postman collection
- Added test file: test-sanmar-products.js"

# 4. Push to GitHub
git push origin develop

# 5. Deploy to Heroku
git push heroku main

# 6. Verify deployment
heroku logs --tail
curl https://caspio-pricing-proxy-ab30a049961a.herokuapp.com/api/sanmar-products?limit=5
```

---

## Common Patterns Summary

| Pattern | When to Use | Example |
|---------|-------------|---------|
| Simple Read-Only | Reference data, lookups | production-schedules |
| CRUD | Editable data | artrequests |
| Field Filters | User-friendly querying | Sanmar products |
| Business Logic | Dashboards, reports | order-dashboard |
| Aggregations | Analytics | Sales summaries |

## Key Takeaways

1. **Always use `fetchAllCaspioPages()`** - Handles pagination automatically
2. **Log Caspio Request ID** - Critical for debugging
3. **Validate input** - Prevent SQL injection, check ranges
4. **Provide examples** - In docs and error messages
5. **Test locally first** - Before deploying to Heroku
6. **Keep it simple** - Start with basic, add features as needed
