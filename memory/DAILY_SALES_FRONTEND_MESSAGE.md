# Daily Sales Archive API - Frontend Integration Guide

## For Claude Pricing Frontend

A new API is available for Year-to-Date (YTD) sales tracking that works beyond ManageOrders' 60-day limit.

---

## Quick Start

### Get YTD Summary
```javascript
const response = await fetch(
  'https://caspio-pricing-proxy-ab30a049961a.herokuapp.com/api/caspio/daily-sales/ytd?year=2026'
);
const data = await response.json();

// Response:
// {
//   "success": true,
//   "year": 2026,
//   "ytdRevenue": 1250000.00,
//   "ytdOrders": 4500,
//   "daysWithData": 180,
//   "lastArchivedDate": "2026-06-30"
// }
```

### Get Date Range with Summary
```javascript
const response = await fetch(
  'https://caspio-pricing-proxy-ab30a049961a.herokuapp.com/api/caspio/daily-sales?start=2026-01-01&end=2026-01-31'
);
const data = await response.json();

// Response:
// {
//   "success": true,
//   "dateRange": { "start": "2026-01-01", "end": "2026-01-31" },
//   "summary": {
//     "daysWithData": 31,
//     "totalRevenue": 125000.50,
//     "totalOrders": 450
//   },
//   "records": [
//     { "Date": "2026-01-01", "Revenue": 4250.00, "OrderCount": 15, "CapturedAt": "..." },
//     { "Date": "2026-01-02", "Revenue": 3875.50, "OrderCount": 12, "CapturedAt": "..." }
//   ]
// }
```

---

## Available Endpoints

| Method | Endpoint | Purpose |
|--------|----------|---------|
| GET | `/api/caspio/daily-sales?start=YYYY-MM-DD&end=YYYY-MM-DD` | Get date range with summary |
| POST | `/api/caspio/daily-sales` | Archive single day (upsert) |
| GET | `/api/caspio/daily-sales/ytd?year=YYYY` | Get YTD summary |
| POST | `/api/caspio/daily-sales/bulk` | Bulk backfill historical data |

---

## Dashboard Usage Example

```javascript
// YTD Dashboard Card
async function loadYTDStats() {
  try {
    const response = await fetch(
      `${API_BASE}/api/caspio/daily-sales/ytd?year=${new Date().getFullYear()}`
    );
    const data = await response.json();

    if (data.success) {
      document.getElementById('ytd-revenue').textContent =
        `$${data.ytdRevenue.toLocaleString()}`;
      document.getElementById('ytd-orders').textContent =
        data.ytdOrders.toLocaleString();
      document.getElementById('last-updated').textContent =
        data.lastArchivedDate || 'No data yet';
    }
  } catch (error) {
    console.error('Failed to load YTD stats:', error);
  }
}

// Monthly Chart Data
async function loadMonthlyData(year, month) {
  const start = `${year}-${String(month).padStart(2, '0')}-01`;
  const lastDay = new Date(year, month, 0).getDate();
  const end = `${year}-${String(month).padStart(2, '0')}-${lastDay}`;

  const response = await fetch(
    `${API_BASE}/api/caspio/daily-sales?start=${start}&end=${end}`
  );
  const data = await response.json();

  // Use data.records for chart
  // Use data.summary for totals
  return data;
}
```

---

## Archiving Data (Backend/Nightly Job)

To populate the archive, call POST endpoints from a nightly job:

```javascript
// Archive yesterday's sales
async function archiveYesterdaySales() {
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  const dateStr = yesterday.toISOString().split('T')[0];

  // Get sales from ManageOrders API
  const salesData = await getManageOrdersSales(dateStr);

  // Archive to Caspio
  const response = await fetch(`${API_BASE}/api/caspio/daily-sales`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      date: dateStr,
      revenue: salesData.totalRevenue,
      orderCount: salesData.orderCount
    })
  });

  const result = await response.json();
  console.log(`Archived ${dateStr}: ${result.action}`);
}
```

---

## Response Fields Reference

### YTD Response
| Field | Type | Description |
|-------|------|-------------|
| `ytdRevenue` | number | Total revenue year-to-date |
| `ytdOrders` | number | Total orders year-to-date |
| `daysWithData` | number | Days with archived data |
| `lastArchivedDate` | string | Most recent archived date |

### Date Range Response
| Field | Type | Description |
|-------|------|-------------|
| `summary.totalRevenue` | number | Sum of revenue in range |
| `summary.totalOrders` | number | Sum of orders in range |
| `summary.daysWithData` | number | Days with data in range |
| `records` | array | Individual daily records |

---

## Notes

1. **No caching yet** - Consider adding frontend caching for dashboard cards
2. **Data starts empty** - Need to backfill or start nightly archival job
3. **Dates in YYYY-MM-DD format** - ISO format required for all date params
4. **Year defaults to current** - YTD endpoint uses current year if not specified

---

## Full Documentation

See [DAILY_SALES_API.md](./DAILY_SALES_API.md) for complete API documentation including error handling, bulk operations, and code examples.
