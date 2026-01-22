# Taneisha Accounts API

**Version**: 1.0.0
**Created**: 2026-01-21
**Table**: `Taneisha_All_Accounts_Caspio`

## Overview

CRUD endpoints for managing Taneisha Clark's 800 customer accounts with CRM tracking, contact scheduling, product preferences, and order analytics.

## Table Details

| Property | Value |
|----------|-------|
| Table Name | `Taneisha_All_Accounts_Caspio` |
| Primary Key | `ID_Customer` (Integer) |
| Records | ~800 |
| Fields | 81 |

## Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/taneisha-accounts` | List all accounts with filtering |
| GET | `/api/taneisha-accounts/:id` | Get single account by ID_Customer |
| GET | `/api/taneisha-accounts/reconcile` | Find customers with orders not in list |
| POST | `/api/taneisha-accounts` | Create new account |
| POST | `/api/taneisha-accounts/sync-sales` | Sync YTD sales from ManageOrders |
| PUT | `/api/taneisha-accounts/:id` | Update account (any fields) |
| PUT | `/api/taneisha-accounts/:id/crm` | Update CRM fields only |
| DELETE | `/api/taneisha-accounts/:id` | Delete account |

---

## GET /api/taneisha-accounts

List all accounts with optional filtering.

### Query Parameters

#### Tier Filters
| Parameter | Type | Description | Example |
|-----------|------|-------------|---------|
| `accountTier` | string | Account_Tier value | `GOLD '26-TANEISHA` |
| `priorityTier` | string | Priority_Tier (A-E) | `A` |

#### Activity Filters
| Parameter | Type | Description | Values |
|-----------|------|-------------|--------|
| `month` | string | Month with activity | jan, feb, mar, apr, may, jun, jul, aug, sep, oct, nov, dec |
| `quarter` | string | Quarter with activity | q1, q2, q3, q4 |
| `isActive` | integer | Is_Active flag | 0 or 1 |

#### Product Preference Filters
| Parameter | Type | Description |
|-----------|------|-------------|
| `buysCaps` | integer | Buys caps/hats/beanies (0/1) |
| `buysJackets` | integer | Buys jackets (0/1) |
| `buysCarhartt` | integer | Buys Carhartt brand (0/1) |
| `buysPolos` | integer | Buys polos (0/1) |
| `buysTShirts` | integer | Buys t-shirts (0/1) |
| `buysHoodies` | integer | Buys hoodies/sweatshirts (0/1) |
| `buysSafety` | integer | Buys hi-vis/safety gear (0/1) |

#### Status Filters
| Parameter | Type | Description |
|-----------|------|-------------|
| `atRisk` | integer | At_Risk flag (1) |
| `overdueForOrder` | integer | Overdue_For_Order flag (1) |
| `contactStatus` | string | Contact_Status value |
| `trend` | string | Trend value |

#### Search & Sorting
| Parameter | Type | Description | Default |
|-----------|------|-------------|---------|
| `search` | string | Search CompanyName (LIKE) | - |
| `orderBy` | string | Sort field | CompanyName |
| `orderDir` | string | Sort direction | ASC |

### Example Requests

```bash
# Get all accounts
GET /api/taneisha-accounts

# Get GOLD tier accounts
GET /api/taneisha-accounts?accountTier=GOLD%20'26-TANEISHA

# Get March-active accounts who buy Carhartt
GET /api/taneisha-accounts?month=mar&buysCarhartt=1

# Get at-risk accounts
GET /api/taneisha-accounts?atRisk=1

# Get accounts overdue for orders, sorted by last order
GET /api/taneisha-accounts?overdueForOrder=1&orderBy=Last_Order&orderDir=DESC

# Search by company name
GET /api/taneisha-accounts?search=construction
```

### Response
```json
{
  "success": true,
  "count": 150,
  "accounts": [
    {
      "ID_Customer": 12345,
      "CompanyName": "ABC Construction",
      "Account_Tier": "GOLD '26-TANEISHA",
      "Priority_Tier": "A - High ($5K+)",
      "Total_Revenue": 15000.00,
      "At_Risk": 0,
      "Contact_Status": "Called",
      "Last_Contact_Date": "2026-01-15",
      ...
    }
  ]
}
```

---

## GET /api/taneisha-accounts/:id

Get a single account by ID_Customer.

### Example
```bash
GET /api/taneisha-accounts/12345
```

### Response
```json
{
  "success": true,
  "account": {
    "ID_Customer": 12345,
    "CompanyName": "ABC Construction",
    ...all 81 fields...
  }
}
```

---

## GET /api/taneisha-accounts/reconcile

**Find customers who have Taneisha orders but are NOT in her Caspio account list.** This helps identify missing customers that need to be added.

### How It Works
1. Fetches all customers from Taneisha's Caspio list
2. Fetches all orders from ManageOrders (last 60 days) where `CustomerServiceRep = 'Taneisha Clark'`
3. Finds customers with Taneisha orders who aren't in her Caspio list
4. Optionally auto-adds them with `?autoAdd=true`

### Query Parameters

| Parameter | Type | Description |
|-----------|------|-------------|
| `autoAdd` | boolean | Set to `true` to automatically add missing customers to Caspio |

### Example Requests

```bash
# View missing customers (read-only)
GET /api/taneisha-accounts/reconcile

# Auto-add missing customers to Caspio
GET /api/taneisha-accounts/reconcile?autoAdd=true
```

### Response (Read-Only)
```json
{
  "success": true,
  "existingAccounts": 799,
  "missingCustomers": [
    {
      "ID_Customer": 8194,
      "CompanyName": "Vector Research & Development, Inc.",
      "orders": 1,
      "totalSales": 1462,
      "lastOrderDate": "2025-12-09"
    },
    {
      "ID_Customer": 2791,
      "CompanyName": "Northwest Embroidery-Store",
      "orders": 1,
      "totalSales": 482,
      "lastOrderDate": "2025-12-23"
    }
  ],
  "missingCount": 3,
  "missingSales": 1944,
  "message": "Found 3 customers with $1944.00 in sales not in Taneisha's list"
}
```

### Response (With autoAdd=true)
```json
{
  "success": true,
  "existingAccounts": 799,
  "missingCustomers": [...],
  "missingCount": 3,
  "missingSales": 1944,
  "autoAdded": [8194, 2791, 6569],
  "message": "Added 3 missing customers to Taneisha's list"
}
```

### Frontend UI Suggestion

Add a "Reconcile Accounts" button/section that:
1. Calls `/api/taneisha-accounts/reconcile` to show missing customers
2. Displays a table with: Company Name, Orders, Total Sales, Last Order Date
3. Provides an "Add All Missing" button that calls `?autoAdd=true`
4. Shows success message with count of added customers

---

## POST /api/taneisha-accounts/sync-sales

**Sync YTD sales from ManageOrders to update account analytics.** Uses HYBRID pattern: Archive (pre-60 days) + Fresh ManageOrders (last 60 days).

### What It Updates
- `YTD_Sales_2026` - Year-to-date sales total
- `Order_Count_2026` - Number of orders this year
- `Last_Order_Date` - Most recent order date
- `Last_Sync_Date` - When sync was performed

### How It Works
1. Fetches archived YTD totals from `Taneisha_Daily_Sales_By_Account` (data older than 60 days)
2. Fetches fresh orders from ManageOrders (last 60 days) in 20-day chunks
3. Only counts orders where `CustomerServiceRep = 'Taneisha Clark'`
4. Combines archived + fresh for true YTD totals
5. Updates each account in Caspio

### Example Request
```bash
POST /api/taneisha-accounts/sync-sales
```

### Response
```json
{
  "success": true,
  "message": "Updated 150 Taneisha accounts with YTD sales",
  "accountsUpdated": 150,
  "totalYTD": 73650.99,
  "syncDate": "2026-01-22"
}
```

### Important Notes
- **Only counts Taneisha's orders**: Filters by `CustomerServiceRep === 'Taneisha Clark'`
- **Resets stale data**: Accounts with no matching orders get reset to $0
- **ManageOrders sync delay**: ShopWorks data syncs to ManageOrders hourly

---

## POST /api/taneisha-accounts

Create a new account.

### Required Fields
- `ID_Customer` - ShopWorks customer ID
- `CompanyName` - Account/company name

### Example
```bash
curl -X POST /api/taneisha-accounts \
  -H "Content-Type: application/json" \
  -d '{
    "ID_Customer": 99999,
    "CompanyName": "New Company LLC",
    "Account_Tier": "BRONZE '\''26-TANEISHA",
    "Priority_Tier": "C - Low ($500-2K)"
  }'
```

### Response
```json
{
  "success": true,
  "message": "Account created successfully",
  "account": { ...created data... }
}
```

---

## PUT /api/taneisha-accounts/:id

Update any fields on an account.

### Example
```bash
curl -X PUT /api/taneisha-accounts/12345 \
  -H "Content-Type: application/json" \
  -d '{
    "Account_Tier": "SILVER '\''26-TANEISHA",
    "Priority_Tier": "B - Medium ($2K-5K)"
  }'
```

### Response
```json
{
  "success": true,
  "message": "Account updated successfully",
  "updatedFields": ["Account_Tier", "Priority_Tier"]
}
```

---

## PUT /api/taneisha-accounts/:id/crm

Update CRM fields only (whitelisted). This endpoint is optimized for quick CRM updates during calls.

### Allowed Fields
| Field | Description | Example Values |
|-------|-------------|----------------|
| `Last_Contact_Date` | Date of last outreach | `2026-01-21` |
| `Contact_Status` | Status of last contact | Called, Emailed, Left Voicemail, No Response, Won Back, Not Interested |
| `Contact_Notes` | Free text notes | `Left message with receptionist` |
| `Next_Follow_Up` | Scheduled follow-up date | `2026-01-28` |
| `Follow_Up_Type` | Type of follow-up | Call, Email, Visit, Quote |
| `Won_Back_Date` | Date account was won back | `2026-01-21` |

### Example
```bash
curl -X PUT /api/taneisha-accounts/12345/crm \
  -H "Content-Type: application/json" \
  -d '{
    "Last_Contact_Date": "2026-01-21",
    "Contact_Status": "Called",
    "Contact_Notes": "Spoke with John, needs quote for new uniforms",
    "Next_Follow_Up": "2026-01-28",
    "Follow_Up_Type": "Quote"
  }'
```

### Response
```json
{
  "success": true,
  "message": "CRM fields updated successfully",
  "updatedFields": ["Last_Contact_Date", "Contact_Status", "Contact_Notes", "Next_Follow_Up", "Follow_Up_Type"]
}
```

---

## DELETE /api/taneisha-accounts/:id

Delete an account.

### Example
```bash
curl -X DELETE /api/taneisha-accounts/12345
```

### Response
```json
{
  "success": true,
  "message": "Account deleted successfully"
}
```

---

## Field Reference

### Key Field Categories

| Category | Fields |
|----------|--------|
| **Identifiers** | ID_Customer, CompanyName, Account_Tier, Priority_Tier |
| **Contact Months** | Jan_Active - Dec_Active, Q1-Q4_Active, Primary_Month, All_Contact_Months |
| **Main Contact** | Main_Contact_Name, Main_Contact_Email, Main_Contact_Phone |
| **CRM Tracking** | Last_Contact_Date, Contact_Status, Contact_Notes, Next_Follow_Up, Follow_Up_Type, Won_Back_Date |
| **Financials** | Avg_Annual_Profit, Total_Revenue, Margin_Pct, Revenue_2024, Revenue_2025 |
| **Account History** | First_Order, Last_Order, Days_Since_Last_Order, Years_Active |
| **Product Prefs** | Buys_Caps, Buys_Jackets, Buys_Carhartt, Buys_Polos, Buys_TShirts, Buys_Hoodies, Buys_Safety |
| **Order Patterns** | Orders_Per_Year, Order_Frequency, Avg_Order_Value |
| **Growth/Health** | Trend, At_Risk, Health_Score, YoY_Growth_Pct |
| **Reorder Prediction** | Predicted_Next_Order, Overdue_For_Order, Avg_Days_Between_Orders |
| **Top Products** | Top_Product_1, Top_Product_2, Top_Product_3 |
| **Order Types** | Uses_Inksoft, Uses_Custom_Embroidery, Uses_Digital_Printing, etc. |

### Trend Values
- `Active 2025` - Has orders in 2025
- `Growing` - YoY revenue increase
- `Declining` - YoY revenue decrease
- `Stable` - Consistent revenue
- `Dormant` - No recent activity

### Contact Status Values
- `Called`
- `Emailed`
- `Left Voicemail`
- `No Response`
- `Won Back`
- `Not Interested`

### Account Tier Values
- `GOLD '26-TANEISHA`
- `SILVER '26-TANEISHA`
- `BRONZE '26-TANEISHA`
- `Win Back '26 TANEISHA`

### Priority Tier Values
- `A - High ($5K+)`
- `B - Medium ($2K-5K)`
- `C - Low ($500-2K)`
- `D - Minimal (<$500)`
- `E - No History`

---

## Error Responses

| Status | Error | Description |
|--------|-------|-------------|
| 400 | Missing required parameter | ID or required field not provided |
| 404 | Account not found | No account with given ID_Customer |
| 409 | Already exists | Account with ID_Customer already exists (POST) |
| 500 | Failed to [operation] | Server/Caspio error |

---

## Implementation Notes

- Uses `fetchAllCaspioPages` for pagination (handles >1000 records)
- Primary key `ID_Customer` is the ShopWorks customer ID
- CRM endpoint whitelist prevents accidental updates to analytics fields
- All date fields should use YYYY-MM-DD format
