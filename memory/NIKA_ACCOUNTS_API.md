# Nika Accounts API

**Version**: 1.0.0
**Created**: 2026-01-22
**Table**: `Nika_All_Accounts_Caspio`

## Overview

CRUD endpoints for managing Nika's customer accounts with CRM tracking, contact scheduling, product preferences, and order analytics. Identical structure to Taneisha Accounts API.

## Table Details

| Property | Value |
|----------|-------|
| Table Name | `Nika_All_Accounts_Caspio` |
| Primary Key | `ID_Customer` (Integer) |
| Records | ~407 |
| Fields | 81 |

## Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/nika-accounts` | List all accounts with filtering |
| GET | `/api/nika-accounts/:id` | Get single account by ID_Customer |
| POST | `/api/nika-accounts` | Create new account |
| PUT | `/api/nika-accounts/:id` | Update account (any fields) |
| PUT | `/api/nika-accounts/:id/crm` | Update CRM fields only |
| POST | `/api/nika-accounts/sync-sales` | Sync YTD sales from ManageOrders |
| DELETE | `/api/nika-accounts/:id` | Delete account |

---

## GET /api/nika-accounts

List all accounts with optional filtering.

### Query Parameters

#### Tier Filters
| Parameter | Type | Description | Example |
|-----------|------|-------------|---------|
| `accountTier` | string | Account_Tier value | `GOLD '26-NIKA` |
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
GET /api/nika-accounts

# Get GOLD tier accounts
GET /api/nika-accounts?accountTier=GOLD%20'26-NIKA

# Get at-risk accounts
GET /api/nika-accounts?atRisk=1

# Get accounts overdue for orders
GET /api/nika-accounts?overdueForOrder=1&orderBy=Last_Order&orderDir=DESC
```

### Response
```json
{
  "success": true,
  "count": 407,
  "accounts": [...]
}
```

---

## PUT /api/nika-accounts/:id/crm

Update CRM fields only (whitelisted).

### Allowed Fields
| Field | Description | Example Values |
|-------|-------------|----------------|
| `Last_Contact_Date` | Date of last outreach | `2026-01-22` |
| `Contact_Status` | Status of last contact | Called, Emailed, Left Voicemail, No Response, Won Back, Not Interested |
| `Contact_Notes` | Free text notes | `Left message with receptionist` |
| `Next_Follow_Up` | Scheduled follow-up date | `2026-01-29` |
| `Follow_Up_Type` | Type of follow-up | Call, Email, Visit, Quote |
| `Won_Back_Date` | Date account was won back | `2026-01-22` |

### Example
```bash
curl -X PUT /api/nika-accounts/12354/crm \
  -H "Content-Type: application/json" \
  -d '{
    "Last_Contact_Date": "2026-01-22",
    "Contact_Status": "Called",
    "Contact_Notes": "Needs quote for uniforms",
    "Next_Follow_Up": "2026-01-29",
    "Follow_Up_Type": "Quote"
  }'
```

---

## POST /api/nika-accounts/sync-sales

Sync YTD sales data from ManageOrders for all Nika accounts.

### Response
```json
{
  "success": true,
  "message": "Sales sync completed",
  "ordersProcessed": 1500,
  "accountsUpdated": 125,
  "errors": 0,
  "syncDate": "2026-01-22"
}
```

---

## Account Tier Values
- `GOLD '26-NIKA`
- `SILVER '26-NIKA`
- `BRONZE '26-NIKA`
- `Win Back '26 NIKA`

## Priority Tier Values
- `A - High ($5K+)`
- `B - Medium ($2K-5K)`
- `C - Low ($500-2K)`
- `D - Minimal (<$500)`
- `E - No History`

---

## See Also
- [Taneisha Accounts API](TANEISHA_ACCOUNTS_API.md) - Same structure, different sales rep
