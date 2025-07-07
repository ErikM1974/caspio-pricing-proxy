# Order Dashboard API Documentation

## Overview

The Order Dashboard API provides real-time business metrics for Northwest Custom Apparel's order management system. This API delivers pre-calculated summaries, breakdowns by customer service rep and order type, and year-over-year comparisons.

**Base URL:** `https://caspio-pricing-proxy-ab30a049961a.herokuapp.com`

**Key Features:**
- Real-time order and sales metrics
- Customer Service Rep performance tracking
- Order type analysis
- Year-over-year business comparisons
- Invoice-based date filtering (captures when orders were invoiced, not placed)

## Endpoints

### 1. Basic Dashboard
Get order metrics for the last N days.

```http
GET /api/order-dashboard
GET /api/order-dashboard?days=7
GET /api/order-dashboard?days=30
```

**Parameters:**
- `days` (optional, default: 7) - Number of days to look back

**Example Response:**
```json
{
  "summary": {
    "totalOrders": 65,
    "totalSales": 37589.93,
    "notInvoiced": 0,
    "notShipped": 45,
    "avgOrderValue": 578.31
  },
  "dateRange": {
    "start": "2025-06-28T00:00:00Z",
    "end": "2025-07-05T23:59:59Z",
    "mostRecentOrder": "2025-07-03T00:00:00"
  },
  "breakdown": {
    "byCsr": [
      {
        "name": "Nika Lao",
        "orders": 21,
        "sales": 19644.55
      },
      {
        "name": "Taylar Hanson",
        "orders": 41,
        "sales": 13407.48
      }
    ],
    "byOrderType": [
      {
        "type": "Custom Embroidery",
        "orders": 16,
        "sales": 14679.15
      },
      {
        "type": "Caps",
        "orders": 4,
        "sales": 5287.54
      }
    ]
  },
  "todayStats": {
    "ordersToday": 0,
    "salesToday": 0,
    "shippedToday": 0
  }
}
```

### 2. Dashboard with Order Details
Include the 10 most recent orders in the response.

```http
GET /api/order-dashboard?days=7&includeDetails=true
```

**Parameters:**
- `days` (optional, default: 7) - Number of days to look back
- `includeDetails` (optional, default: false) - Include recent orders array

**Additional Response Field:**
```json
{
  "recentOrders": [
    {
      "ID_Order": 136770,
      "date_OrderInvoiced": "2025-07-03T00:00:00",
      "CompanyName": "Shirt The City",
      "CustomerServiceRep": "Ruthie Nhoung",
      "ORDER_TYPE": "Contract Caps",
      "cur_Subtotal": 504.9,
      "sts_Invoiced": 1,
      "sts_Shipped": 0
    }
  ]
}
```

### 3. Year-over-Year Comparison
Compare current year-to-date metrics with the same period last year.

```http
GET /api/order-dashboard?compareYoY=true
GET /api/order-dashboard?days=30&compareYoY=true
```

**Parameters:**
- `days` (optional, default: 7) - Number of days for the main dashboard
- `compareYoY` (optional, default: false) - Include year-over-year comparison

**Additional Response Field:**
```json
{
  "yearOverYear": {
    "currentYear": {
      "period": "2025-01-01 to 2025-07-05",
      "totalSales": 1334954.6,
      "orderCount": 2734
    },
    "previousYear": {
      "period": "2024-01-01 to 2024-07-05",
      "totalSales": 1486904.29,
      "orderCount": 2668
    },
    "comparison": {
      "salesGrowth": -10.22,
      "salesDifference": -151949.69,
      "orderGrowth": 2.47,
      "orderDifference": 66
    }
  }
}
```

### 4. Health Check
Verify API connectivity and status.

```http
GET /api/health
```

**Response:**
```json
{
  "status": "healthy",
  "message": "Caspio Proxy Server is running",
  "timestamp": "2025-07-05T16:22:26.979Z"
}
```

## Implementation Examples

### JavaScript/Fetch Example

```javascript
// Basic dashboard for last 7 days
async function fetchDashboard() {
  try {
    const response = await fetch('https://caspio-pricing-proxy-ab30a049961a.herokuapp.com/api/order-dashboard');
    const data = await response.json();
    
    // Update UI with summary
    document.getElementById('totalOrders').textContent = data.summary.totalOrders;
    document.getElementById('totalSales').textContent = `$${data.summary.totalSales.toLocaleString()}`;
    document.getElementById('avgOrderValue').textContent = `$${data.summary.avgOrderValue.toFixed(2)}`;
    
    // Update CSR breakdown
    updateCSRChart(data.breakdown.byCsr);
    
  } catch (error) {
    console.error('Dashboard fetch failed:', error);
    showErrorMessage('Unable to load dashboard data');
  }
}

// Year-over-year comparison
async function fetchYearOverYear() {
  const response = await fetch('https://caspio-pricing-proxy-ab30a049961a.herokuapp.com/api/order-dashboard?compareYoY=true');
  const data = await response.json();
  
  if (data.yearOverYear) {
    const yoy = data.yearOverYear;
    const growth = yoy.comparison.salesGrowth;
    
    // Display growth indicator
    const growthElement = document.getElementById('salesGrowth');
    growthElement.textContent = `${growth > 0 ? '+' : ''}${growth}%`;
    growthElement.className = growth > 0 ? 'positive' : 'negative';
    
    // Update comparison metrics
    document.getElementById('currentYearSales').textContent = `$${yoy.currentYear.totalSales.toLocaleString()}`;
    document.getElementById('lastYearSales').textContent = `$${yoy.previousYear.totalSales.toLocaleString()}`;
  }
}

// Fetch with loading state
async function refreshDashboard() {
  const container = document.getElementById('dashboardContainer');
  container.classList.add('loading');
  
  try {
    await fetchDashboard();
  } finally {
    container.classList.remove('loading');
  }
}
```

### React Component Example

```jsx
import { useState, useEffect } from 'react';

function OrderDashboard() {
  const [dashboard, setDashboard] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [days, setDays] = useState(7);

  useEffect(() => {
    fetchDashboardData();
  }, [days]);

  const fetchDashboardData = async () => {
    setLoading(true);
    try {
      const response = await fetch(
        `https://caspio-pricing-proxy-ab30a049961a.herokuapp.com/api/order-dashboard?days=${days}&compareYoY=true`
      );
      const data = await response.json();
      setDashboard(data);
    } catch (err) {
      setError('Failed to load dashboard');
    } finally {
      setLoading(false);
    }
  };

  if (loading) return <div>Loading dashboard...</div>;
  if (error) return <div>Error: {error}</div>;

  return (
    <div className="dashboard">
      <div className="summary-cards">
        <Card title="Total Orders" value={dashboard.summary.totalOrders} />
        <Card title="Total Sales" value={`$${dashboard.summary.totalSales.toLocaleString()}`} />
        <Card title="Avg Order" value={`$${dashboard.summary.avgOrderValue.toFixed(2)}`} />
      </div>
      
      {dashboard.yearOverYear && (
        <YearOverYearChart data={dashboard.yearOverYear} />
      )}
      
      <CSRPerformance data={dashboard.breakdown.byCsr} />
      <OrderTypeBreakdown data={dashboard.breakdown.byOrderType} />
    </div>
  );
}
```

## Response Field Definitions

### Summary Object
- `totalOrders` - Total number of orders in the period
- `totalSales` - Total sales amount in dollars
- `notInvoiced` - Count of orders not yet invoiced
- `notShipped` - Count of invoiced orders not yet shipped
- `avgOrderValue` - Average order value (totalSales / totalOrders)

### Date Range Object
- `start` - Start date of the period (ISO 8601)
- `end` - End date of the period (ISO 8601)
- `mostRecentOrder` - Date of the most recent order

### CSR Breakdown
- `name` - Customer Service Rep name
- `orders` - Number of orders handled
- `sales` - Total sales amount

### Order Type Breakdown
- `type` - Order type (e.g., "Custom Embroidery", "DTG", "Caps")
- `orders` - Number of orders of this type
- `sales` - Total sales for this type

### Year-over-Year Comparison
- `currentYear.period` - Date range for current year
- `currentYear.totalSales` - YTD sales for current year
- `currentYear.orderCount` - YTD order count for current year
- `previousYear.*` - Same fields for previous year
- `comparison.salesGrowth` - Percentage change in sales
- `comparison.orderGrowth` - Percentage change in order count

## Best Practices

### 1. Caching
The API has a 60-second cache on the server side. For optimal performance:
- Cache responses client-side for 1-2 minutes
- Implement a manual refresh button for real-time updates
- Use stale-while-revalidate pattern for better UX

### 2. Error Handling
```javascript
const fetchWithRetry = async (url, retries = 3) => {
  for (let i = 0; i < retries; i++) {
    try {
      const response = await fetch(url);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return await response.json();
    } catch (error) {
      if (i === retries - 1) throw error;
      await new Promise(resolve => setTimeout(resolve, 1000 * (i + 1)));
    }
  }
};
```

### 3. Loading States
Always show loading indicators during data fetches:
- Skeleton screens for initial load
- Subtle spinner for refreshes
- Preserve previous data during updates

### 4. Date Considerations
- All dates are in UTC
- The API filters by invoice date, not order placement date
- This captures orders based on when they were invoiced (financial reporting)

## UI Component Suggestions

### 1. Summary Cards
Display the main metrics prominently:
```
┌─────────────┐ ┌─────────────┐ ┌─────────────┐
│   Orders    │ │    Sales    │ │  Avg Order  │
│     65      │ │  $37,590    │ │   $578.31   │
└─────────────┘ └─────────────┘ └─────────────┘
```

### 2. CSR Leaderboard
Show top performers with visual bars:
```
Nika Lao      ████████████████ $19,645 (21 orders)
Taylar Hanson ███████████      $13,407 (41 orders)
Ruthie Nhoung ████             $4,538  (3 orders)
```

### 3. Order Type Pie Chart
Visualize the business mix by order type.

### 4. YoY Trend Arrow
```
Sales YTD: $1,334,955 ↓ -10.22%
Orders YTD: 2,734 ↑ +2.47%
```

## Notes

- The API uses invoice dates for all filtering to ensure accurate financial reporting
- Year-over-year comparisons always use January 1 to current date
- All monetary values are in USD
- Order statuses are binary flags (0 or 1)

## Support

For API issues or questions:
- Check the health endpoint first: `/api/health`
- Verify the base URL is correct
- Ensure date parameters are within valid ranges
- Contact the development team for assistance