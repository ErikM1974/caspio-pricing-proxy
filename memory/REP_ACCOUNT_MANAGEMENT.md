# Rep Account Management & Audit System

**Version**: 1.0.0
**Created**: 2026-01-22
**Purpose**: Ensure sales reps only get credit for their assigned customers

---

## The Problem We're Solving

Each sales rep (Taneisha Clark, Nika Lao) has a Caspio table listing their assigned customer accounts. When orders come in through ShopWorks, they're tagged with a `CustomerServiceRep` field.

**Issues that can occur:**
1. **Missing customers**: A rep processes an order for a customer not in their Caspio list → they don't get YTD credit
2. **Wrong rep credit**: A rep processes an order for a customer assigned to another rep → wrong person gets credit
3. **Unassigned customers**: New customers come in with no rep assignment → orders fall through the cracks

---

## The Solution: Three-Part System

### 1. Reconcile Endpoints - Find Missing Customers

These endpoints compare ManageOrders data against the Caspio account lists to find customers with orders who aren't in the rep's list.

| Endpoint | Description |
|----------|-------------|
| `GET /api/taneisha-accounts/reconcile` | Find customers with Taneisha orders not in her list |
| `GET /api/nika-accounts/reconcile` | Find customers with Nika orders not in her list |
| `?autoAdd=true` | Automatically add missing customers to the list |

**Response:**
```json
{
  "success": true,
  "existingAccounts": 412,
  "missingCustomers": [
    {
      "ID_Customer": 10201,
      "CompanyName": "Schneider Electric",
      "orders": 2,
      "totalSales": 3818,
      "lastOrderDate": "2026-01-06"
    }
  ],
  "missingCount": 5,
  "missingSales": 4619.50,
  "message": "Found 5 customers with $4619.50 in sales not in Nika's list"
}
```

**Frontend UI Suggestion:**
- Add a "Reconcile Accounts" button on each rep's dashboard
- Show a table of missing customers with: Company Name, Orders, Total Sales, Last Order Date
- Provide "Add All" button that calls `?autoAdd=true`
- Filter option: "Show only 2026 orders" (check `lastOrderDate >= '2026-01-01'`)

---

### 2. Sync-Sales Endpoints - Update YTD Totals

These endpoints sync YTD sales data from ManageOrders to update each account's sales totals.

| Endpoint | Description |
|----------|-------------|
| `POST /api/taneisha-accounts/sync-sales` | Sync Taneisha's YTD sales |
| `POST /api/nika-accounts/sync-sales` | Sync Nika's YTD sales |

**Key Features:**
- Only counts orders where `CustomerServiceRep` matches the rep
- Resets accounts with no matching orders to $0 (prevents stale data)
- Uses HYBRID pattern: Archive (pre-60 days) + Fresh ManageOrders (last 60 days)

**Response:**
```json
{
  "success": true,
  "message": "Sales sync completed",
  "ordersProcessed": 1140,
  "accountsUpdated": 72,
  "errors": 0,
  "syncDate": "2026-01-22"
}
```

**Frontend UI Suggestion:**
- Add a "Sync Sales" button (or run automatically on page load)
- Show last sync date
- Display total YTD for the rep

---

### 3. Rep Audit Endpoint - Catch Mismatches

This endpoint cross-checks ALL orders against BOTH account lists to find problems:

| Endpoint | Description |
|----------|-------------|
| `GET /api/rep-audit/summary` | Quick status check (counts only) |
| `GET /api/rep-audit` | Full audit with order details |
| `?year=2026` | Filter to specific year (default: current year) |

**What It Detects:**
1. **Nika orders for Taneisha's customers** - Nika wrote an order but customer is on Taneisha's list
2. **Taneisha orders for Nika's customers** - Taneisha wrote an order but customer is on Nika's list
3. **Unassigned customers** - Orders for customers not in either list

**Summary Response:**
```json
{
  "success": true,
  "year": 2026,
  "status": "ISSUES_FOUND",  // or "OK"
  "totalOrdersChecked": 623,
  "issues": {
    "nikaOrdersTaneishaCustomer": { "count": 0, "total": 0 },
    "taneishaOrdersNikaCustomer": { "count": 0, "total": 0 },
    "unassignedCustomers": { "count": 19, "total": 6039.98 }
  },
  "totalIssues": 19,
  "totalMismatchedRevenue": 6039.98,
  "message": "Found 19 orders with rep/account mismatches"
}
```

**Full Audit Response (with details):**
```json
{
  "success": true,
  "summary": { ... },
  "details": {
    "nikaOrdersTaneishaCustomer": [
      {
        "id_Order": 140123,
        "id_Customer": 12345,
        "CustomerName": "ABC Company",
        "CustomerServiceRep": "Nika Lao",
        "date_Invoiced": "2026-01-15",
        "cur_SubTotal": 500.00,
        "assignedTo": "Taneisha"
      }
    ],
    "taneishaOrdersNikaCustomer": [],
    "unassignedCustomers": []
  }
}
```

**Frontend UI Suggestion:**
- Add an "Audit" panel or button on the CRM dashboard
- Show status indicator: Green checkmark if `status: "OK"`, Red warning if `status: "ISSUES_FOUND"`
- Display summary counts for each issue type
- Click to expand shows detailed order list
- Action buttons:
  - For cross-rep issues: "Fix in ShopWorks" (link to order)
  - For unassigned: "Add to [Rep] List" button

---

## Recommended Workflow

### Daily/Weekly Admin Tasks:

1. **Run Audit** (`GET /api/rep-audit/summary`)
   - If status is "OK" → all good
   - If issues found → review details and fix in ShopWorks

2. **Run Reconcile** for each rep
   - Check for missing customers with 2026 orders
   - Add them to the appropriate list

3. **Run Sync-Sales** for each rep
   - Updates YTD totals after any changes

### When a New Order Comes In:

1. Order is created in ShopWorks with `CustomerServiceRep` assigned
2. ManageOrders syncs hourly
3. Next reconcile will catch if customer isn't in rep's list
4. Next audit will catch if rep doesn't match assignment

---

## Data Flow Diagram

```
ShopWorks Order
       ↓
ManageOrders API (hourly sync)
       ↓
   ┌───┴───┐
   ↓       ↓
Reconcile  Audit
   ↓       ↓
Missing?   Mismatch?
   ↓       ↓
Add to     Fix in
Caspio     ShopWorks
   ↓       ↓
Sync-Sales ←──┘
   ↓
YTD Updated
```

---

## API Quick Reference

### Taneisha Accounts
| Method | Endpoint | Purpose |
|--------|----------|---------|
| GET | `/api/taneisha-accounts` | List all accounts |
| GET | `/api/taneisha-accounts/:id` | Get single account |
| GET | `/api/taneisha-accounts/reconcile` | Find missing customers |
| POST | `/api/taneisha-accounts` | Add new account |
| POST | `/api/taneisha-accounts/sync-sales` | Sync YTD sales |
| PUT | `/api/taneisha-accounts/:id` | Update account |
| PUT | `/api/taneisha-accounts/:id/crm` | Update CRM fields |
| DELETE | `/api/taneisha-accounts/:id` | Remove account |

### Nika Accounts
| Method | Endpoint | Purpose |
|--------|----------|---------|
| GET | `/api/nika-accounts` | List all accounts |
| GET | `/api/nika-accounts/:id` | Get single account |
| GET | `/api/nika-accounts/reconcile` | Find missing customers |
| POST | `/api/nika-accounts` | Add new account |
| POST | `/api/nika-accounts/sync-sales` | Sync YTD sales |
| PUT | `/api/nika-accounts/:id` | Update account |
| PUT | `/api/nika-accounts/:id/crm` | Update CRM fields |
| DELETE | `/api/nika-accounts/:id` | Remove account |

### Rep Audit
| Method | Endpoint | Purpose |
|--------|----------|---------|
| GET | `/api/rep-audit/summary` | Quick status check |
| GET | `/api/rep-audit` | Full audit with details |
| GET | `/api/rep-audit?year=2025` | Audit specific year |

---

## Current Status (as of 2026-01-22)

| Rep | Accounts | Missing 2026 | YTD Status |
|-----|----------|--------------|------------|
| Taneisha | 801 | 0 ✓ | Synced |
| Nika | 412 | 0 ✓ | Synced |

**Audit Status:** OK - No cross-rep mismatches found

---

## See Also

- [Taneisha Accounts API](TANEISHA_ACCOUNTS_API.md) - Full endpoint documentation
- [Nika Accounts API](NIKA_ACCOUNTS_API.md) - Full endpoint documentation
