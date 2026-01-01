# Daily Sales Archive API

**Last Updated:** 2026-01-01
**Status:** Production Ready
**Version:** 1.0.0

## Overview

Archive and retrieve daily sales data for Year-to-Date (YTD) tracking beyond ManageOrders' 60-day limit. This API stores historical daily revenue and order counts in Caspio for long-term reporting.

**Base URL:** `https://caspio-pricing-proxy-ab30a049961a.herokuapp.com`

**Caspio Table:** `DailySalesArchive`

| Field | Type | Description |
|-------|------|-------------|
| Date | Date/Time | Sales date (PK, unique) |
| Revenue | Currency | Total invoiced revenue |
| OrderCount | Number | Number of orders invoiced |
| CapturedAt | Timestamp | When record was created/updated |

---

## Endpoints

### 1. GET /api/caspio/daily-sales

Fetch archived daily sales for a date range with summary statistics.

#### Query Parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `start` | string | Yes | Start date (YYYY-MM-DD) |
| `end` | string | Yes | End date (YYYY-MM-DD) |

#### Example Request

```bash
curl "https://caspio-pricing-proxy-ab30a049961a.herokuapp.com/api/caspio/daily-sales?start=2026-01-01&end=2026-01-31"
```

#### Example Response

```json
{
  "success": true,
  "dateRange": {
    "start": "2026-01-01",
    "end": "2026-01-31"
  },
  "summary": {
    "daysWithData": 31,
    "totalRevenue": 125000.50,
    "totalOrders": 450
  },
  "records": [
    {
      "Date": "2026-01-01",
      "Revenue": 4250.00,
      "OrderCount": 15,
      "CapturedAt": "2026-01-02T00:05:00Z"
    },
    {
      "Date": "2026-01-02",
      "Revenue": 3875.50,
      "OrderCount": 12,
      "CapturedAt": "2026-01-03T00:05:00Z"
    }
  ]
}
```

---

### 2. POST /api/caspio/daily-sales

Archive a single day's sales. If the date already exists, updates the record instead of creating a duplicate.

#### Request Body

```json
{
  "date": "2026-01-15",
  "revenue": 12450.00,
  "orderCount": 18
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `date` | string | Yes | Date (YYYY-MM-DD) |
| `revenue` | number | Yes | Total revenue for the day |
| `orderCount` | number | Yes | Number of orders |

#### Example Request

```bash
curl -X POST "https://caspio-pricing-proxy-ab30a049961a.herokuapp.com/api/caspio/daily-sales" \
  -H "Content-Type: application/json" \
  -d '{"date": "2026-01-15", "revenue": 12450.00, "orderCount": 18}'
```

#### Example Response (Created)

```json
{
  "success": true,
  "action": "created",
  "record": {
    "Date": "2026-01-15",
    "Revenue": 12450.00,
    "OrderCount": 18,
    "CapturedAt": "2026-01-16T00:05:00Z"
  }
}
```

#### Example Response (Updated)

```json
{
  "success": true,
  "action": "updated",
  "record": {
    "Date": "2026-01-15",
    "Revenue": 12450.00,
    "OrderCount": 18,
    "CapturedAt": "2026-01-16T00:05:00Z"
  }
}
```

---

### 3. GET /api/caspio/daily-sales/ytd

Get Year-to-Date summary from archived data.

#### Query Parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `year` | number | No | Year to calculate YTD for (default: current year) |

#### Example Request

```bash
curl "https://caspio-pricing-proxy-ab30a049961a.herokuapp.com/api/caspio/daily-sales/ytd?year=2026"
```

#### Example Response

```json
{
  "success": true,
  "year": 2026,
  "ytdRevenue": 1250000.00,
  "ytdOrders": 4500,
  "daysWithData": 180,
  "lastArchivedDate": "2026-06-30",
  "dateRange": {
    "start": "2026-01-01",
    "end": "2026-01-01"
  }
}
```

---

### 4. POST /api/caspio/daily-sales/bulk

Bulk insert/update for backfilling historical data. Processes each record individually with upsert logic.

#### Request Body

Array of daily sales records:

```json
[
  { "date": "2025-12-01", "revenue": 8500.00, "orderCount": 25 },
  { "date": "2025-12-02", "revenue": 9200.50, "orderCount": 28 },
  { "date": "2025-12-03", "revenue": 7800.00, "orderCount": 22 }
]
```

#### Example Request

```bash
curl -X POST "https://caspio-pricing-proxy-ab30a049961a.herokuapp.com/api/caspio/daily-sales/bulk" \
  -H "Content-Type: application/json" \
  -d '[{"date":"2025-12-01","revenue":8500,"orderCount":25},{"date":"2025-12-02","revenue":9200.50,"orderCount":28}]'
```

#### Example Response

```json
{
  "success": true,
  "created": 25,
  "updated": 5,
  "errors": []
}
```

#### Response with Errors

```json
{
  "success": false,
  "created": 23,
  "updated": 5,
  "errors": [
    { "date": "2025-12-15", "error": "Missing required fields" },
    { "date": "missing", "error": "Missing required fields" }
  ]
}
```

---

## Error Responses

### 400 Bad Request

```json
{
  "error": "Both start and end date parameters are required",
  "example": "/api/caspio/daily-sales?start=2026-01-01&end=2026-01-31"
}
```

```json
{
  "error": "Dates must be in YYYY-MM-DD format",
  "received": { "start": "01-01-2026", "end": "01-31-2026" }
}
```

### 404 Not Found

```json
{
  "error": "DailySalesArchive table not found in Caspio",
  "message": "Please create the DailySalesArchive table in Caspio with fields: Date (PK), Revenue, OrderCount, CapturedAt"
}
```

### 500 Internal Server Error

```json
{
  "error": "Failed to fetch daily sales archive",
  "details": "Error message here"
}
```

---

## Use Cases

### Daily Archival (Nightly Job)
1. Query ManageOrders for yesterday's invoiced orders
2. Calculate total revenue and order count
3. POST to `/api/caspio/daily-sales` with the data
4. Repeat nightly to maintain continuous archive

### YTD Dashboard
1. Call `GET /api/caspio/daily-sales/ytd`
2. Display `ytdRevenue` and `ytdOrders` on dashboard
3. Show `lastArchivedDate` to indicate data freshness

### Monthly Reporting
1. Call `GET /api/caspio/daily-sales?start=2026-01-01&end=2026-01-31`
2. Use `summary` for month totals
3. Use `records` for daily breakdown chart

### Historical Backfill
1. Export historical data from ManageOrders (up to 60 days)
2. Format as array of `{ date, revenue, orderCount }`
3. POST to `/api/caspio/daily-sales/bulk`
4. Check `created`, `updated`, and `errors` counts

---

## Code Examples

### JavaScript/Node.js

```javascript
const BASE_URL = 'https://caspio-pricing-proxy-ab30a049961a.herokuapp.com';

// Get daily sales for a date range
async function getDailySales(start, end) {
  const response = await fetch(
    `${BASE_URL}/api/caspio/daily-sales?start=${start}&end=${end}`
  );
  return response.json();
}

// Archive a single day
async function archiveDailySales(date, revenue, orderCount) {
  const response = await fetch(`${BASE_URL}/api/caspio/daily-sales`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ date, revenue, orderCount })
  });
  return response.json();
}

// Get YTD summary
async function getYTDSummary(year = new Date().getFullYear()) {
  const response = await fetch(
    `${BASE_URL}/api/caspio/daily-sales/ytd?year=${year}`
  );
  return response.json();
}

// Bulk backfill historical data
async function bulkArchive(records) {
  const response = await fetch(`${BASE_URL}/api/caspio/daily-sales/bulk`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(records)
  });
  return response.json();
}
```

### Python

```python
import requests

BASE_URL = "https://caspio-pricing-proxy-ab30a049961a.herokuapp.com"

def get_daily_sales(start, end):
    """Get daily sales for a date range"""
    response = requests.get(
        f"{BASE_URL}/api/caspio/daily-sales",
        params={"start": start, "end": end}
    )
    return response.json()

def archive_daily_sales(date, revenue, order_count):
    """Archive a single day's sales"""
    response = requests.post(
        f"{BASE_URL}/api/caspio/daily-sales",
        json={"date": date, "revenue": revenue, "orderCount": order_count}
    )
    return response.json()

def get_ytd_summary(year=None):
    """Get Year-to-Date summary"""
    params = {"year": year} if year else {}
    response = requests.get(
        f"{BASE_URL}/api/caspio/daily-sales/ytd",
        params=params
    )
    return response.json()

def bulk_archive(records):
    """Bulk backfill historical data"""
    response = requests.post(
        f"{BASE_URL}/api/caspio/daily-sales/bulk",
        json=records
    )
    return response.json()
```

---

## Changelog

### v1.0.0 - 2026-01-01
- Initial release
- `GET /api/caspio/daily-sales` - Date range query with summary
- `POST /api/caspio/daily-sales` - Upsert single day
- `GET /api/caspio/daily-sales/ytd` - Year-to-date summary
- `POST /api/caspio/daily-sales/bulk` - Bulk insert/update for backfilling
