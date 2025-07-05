# Order Data Discrepancy Analysis Report

## Executive Summary
The API returns **2,122 orders** while the invoiced file contains **2,734 orders**, resulting in **612 missing orders** (77.6% coverage).

## Root Cause Identified
**The API filters by Order Placed Date, but the file contains orders by Invoice Date**

### Key Finding
- **Missing orders**: Orders 131594-134682 (placed in 2024, invoiced in 2025)
- **API coverage**: Only orders placed in 2025 (starting from order 134683)
- **File scope**: All orders invoiced from 1/1/25 to 7/3/25 (regardless of order date)

### Example Data Points
| Order ID | Order Date | Invoice Date | Status |
|----------|------------|--------------|---------|
| 131594 | 6/7/2024 | 4/28/2025 | ❌ Missing from API |
| 134682 | 12/30/2024 | 1/10/2025 | ❌ Missing from API |
| 134683 | 1/2/2025 | 1/21/2025 | ✅ Found by API |

## Current API Logic
```sql
-- API filters by order placement date
date_OrderPlaced >= '2025-01-01' AND date_OrderPlaced <= '2025-07-05'
```

## Recommended Solution
```sql
-- Should filter by invoice date instead
date_Invoiced >= '2025-01-01' AND date_Invoiced <= '2025-07-05'
```

## Impact Analysis
- **Missing Sales**: Orders placed in 2024 but invoiced in 2025
- **YoY Comparison**: Inaccurate due to date filtering mismatch
- **Dashboard Metrics**: Underreporting actual invoiced revenue

## Business Context
This discrepancy is significant for:
1. **Financial reporting** - Missing Q4 2024 orders invoiced in Q1 2025
2. **Year-over-year analysis** - Comparison should be based on invoice dates
3. **Dashboard accuracy** - Current metrics don't reflect actual invoiced revenue

## Recommendation
Change the API filter from `date_OrderPlaced` to the appropriate invoice date field to match the business requirement of tracking orders by when they were invoiced, not when they were placed.