# House Accounts API

**Version**: 1.1.0
**Created**: 2026-01-22
**Updated**: 2026-01-22
**Tables**: `House_Accounts`, `House_Daily_Sales_By_Account`

---

## Purpose

House Accounts is a catch-all system for customers handled by non-sales-rep staff. These customers should not show as "unassigned" in the rep audit.

**Valid Assignees:**
- Ruthie
- House
- Erik
- Jim
- Web
- Other

---

## Caspio Table Schema

| Field | Type | Description |
|-------|------|-------------|
| ID_Customer | Number (PK) | ShopWorks customer ID |
| CompanyName | Text 255 | Customer/company name |
| Assigned_To | Text 255 | Who handles: Ruthie, House, Erik, Jim, Web, etc. |
| Notes | Text 64000 | Optional notes |
| Date_Added | Date/Time | When added to list |
| Reviewed | Yes/No | Flag for reviewed accounts |

---

## Endpoints

### GET /api/house-accounts

List all house accounts with optional filters.

**Query Parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| assignedTo | string | Filter by handler (Ruthie, House, Erik, Jim, Web) |
| reviewed | 0/1 | Filter by reviewed status |
| search | string | Search company name |
| customerId | number | Filter by specific customer ID |
| orderBy | string | Field to sort by (default: CompanyName) |
| orderDir | ASC/DESC | Sort direction |

**Example:**
```bash
curl "https://caspio-pricing-proxy-ab30a049961a.herokuapp.com/api/house-accounts?assignedTo=Ruthie"
```

**Response:**
```json
{
  "success": true,
  "count": 15,
  "accounts": [
    {
      "ID_Customer": 12345,
      "CompanyName": "ABC Company",
      "Assigned_To": "Ruthie",
      "Notes": "Long-time customer",
      "Date_Added": "2026-01-22",
      "Reviewed": true
    }
  ]
}
```

---

### GET /api/house-accounts/stats

Get summary statistics for house accounts.

**Example:**
```bash
curl "https://caspio-pricing-proxy-ab30a049961a.herokuapp.com/api/house-accounts/stats"
```

**Response:**
```json
{
  "success": true,
  "total": 50,
  "reviewed": 35,
  "unreviewed": 15,
  "byAssignee": {
    "Ruthie": 20,
    "House": 15,
    "Erik": 8,
    "Web": 5,
    "Jim": 2
  }
}
```

---

### GET /api/house-accounts/:id

Get a single house account by customer ID.

**Example:**
```bash
curl "https://caspio-pricing-proxy-ab30a049961a.herokuapp.com/api/house-accounts/12345"
```

**Response:**
```json
{
  "success": true,
  "account": {
    "ID_Customer": 12345,
    "CompanyName": "ABC Company",
    "Assigned_To": "Ruthie",
    "Notes": "Long-time customer, prefers phone calls",
    "Date_Added": "2026-01-22",
    "Reviewed": true
  }
}
```

---

### POST /api/house-accounts

Add a new customer to house accounts.

**Required Fields:**
- `ID_Customer` - ShopWorks customer ID
- `CompanyName` - Company name

**Optional Fields:**
- `Assigned_To` - Who handles (default: none)
- `Notes` - Notes about the account
- `Reviewed` - Reviewed flag (default: false)

**Example:**
```bash
curl -X POST "https://caspio-pricing-proxy-ab30a049961a.herokuapp.com/api/house-accounts" \
  -H "Content-Type: application/json" \
  -d '{
    "ID_Customer": 12345,
    "CompanyName": "ABC Company",
    "Assigned_To": "Ruthie",
    "Notes": "Web order customer"
  }'
```

**Response:**
```json
{
  "success": true,
  "message": "House account created successfully",
  "account": {
    "ID_Customer": 12345,
    "CompanyName": "ABC Company",
    "Assigned_To": "Ruthie",
    "Notes": "Web order customer",
    "Date_Added": "2026-01-22",
    "Reviewed": false
  }
}
```

---

### PUT /api/house-accounts/:id

Update a house account.

**Updatable Fields:**
- `CompanyName`
- `Assigned_To`
- `Notes`
- `Reviewed`

**Example:**
```bash
curl -X PUT "https://caspio-pricing-proxy-ab30a049961a.herokuapp.com/api/house-accounts/12345" \
  -H "Content-Type: application/json" \
  -d '{
    "Assigned_To": "Erik",
    "Reviewed": true
  }'
```

**Response:**
```json
{
  "success": true,
  "message": "House account updated successfully",
  "updatedFields": ["Assigned_To", "Reviewed"]
}
```

---

### DELETE /api/house-accounts/:id

Remove a customer from house accounts.

**Example:**
```bash
curl -X DELETE "https://caspio-pricing-proxy-ab30a049961a.herokuapp.com/api/house-accounts/12345"
```

**Response:**
```json
{
  "success": true,
  "message": "House account deleted successfully"
}
```

---

### POST /api/house-accounts/bulk

Add multiple customers to house accounts at once.

**Example:**
```bash
curl -X POST "https://caspio-pricing-proxy-ab30a049961a.herokuapp.com/api/house-accounts/bulk" \
  -H "Content-Type: application/json" \
  -d '{
    "accounts": [
      { "ID_Customer": 12345, "CompanyName": "ABC Co", "Assigned_To": "Web" },
      { "ID_Customer": 12346, "CompanyName": "XYZ Inc", "Assigned_To": "House" }
    ]
  }'
```

**Response:**
```json
{
  "success": true,
  "message": "Bulk add complete: 2 added, 0 skipped",
  "added": 2,
  "skipped": 0
}
```

---

## Integration with Rep Audit

The rep audit (`/api/rep-audit`) now checks House_Accounts:

- Customers in House_Accounts are NOT flagged as "unassigned"
- The audit response includes a `houseAccounts` section showing orders for house account customers
- This is for visibility only - house account orders are not counted as "issues"

**Example audit response:**
```json
{
  "success": true,
  "summary": {
    "year": 2026,
    "accountLists": {
      "taneisha": 800,
      "nika": 600,
      "house": 50
    },
    "issues": {
      "unassignedCustomers": { "count": 5, "total": 1500 }
    },
    "houseAccounts": {
      "count": 25,
      "total": 8500,
      "description": "Orders for House Account customers (not issues - for visibility)"
    }
  }
}
```

---

## Daily Sales Archive

### Table: `House_Daily_Sales_By_Account`

| Field | Type | Description |
|-------|------|-------------|
| SalesDate | Date/Time | Sales date |
| CustomerID | Text 255 | ShopWorks customer ID |
| CustomerName | Text 255 | Company name |
| Revenue | Currency | Daily revenue |
| OrderCount | Number | Number of orders |
| ArchivedAt | Timestamp | When archived |

### GET /api/house/daily-sales-by-account

Fetch archived daily sales for a date range.

**Query Parameters:**
- `start` (required): Start date (YYYY-MM-DD)
- `end` (required): End date (YYYY-MM-DD)

**Example:**
```bash
curl "https://caspio-pricing-proxy-ab30a049961a.herokuapp.com/api/house/daily-sales-by-account?start=2026-01-01&end=2026-01-31"
```

---

### GET /api/house/daily-sales-by-account/ytd

Get Year-to-Date summary aggregated by customer.

**Query Parameters:**
- `year` (optional): Year to get YTD for (default: current year)

**Example:**
```bash
curl "https://caspio-pricing-proxy-ab30a049961a.herokuapp.com/api/house/daily-sales-by-account/ytd?year=2026"
```

---

### POST /api/house/daily-sales-by-account

Archive a single day's per-customer sales data.

**Body:**
```json
{
  "date": "2026-01-15",
  "customers": [
    { "customerId": 12345, "customerName": "ACME Corp", "revenue": 5234.50, "orderCount": 2 }
  ]
}
```

---

### POST /api/house/daily-sales-by-account/bulk

Archive multiple days at once (for backfilling).

**Body:**
```json
[
  {
    "date": "2026-01-01",
    "customers": [{ "customerId": 12345, "customerName": "ACME Corp", "revenue": 500, "orderCount": 1 }]
  }
]
```

---

## MCP Tools

The following MCP tools are available in Claude Desktop:

**Account Management:**

| Tool | Description |
|------|-------------|
| `list_house_accounts` | List with filters |
| `get_house_account` | Get single account |
| `add_house_account` | Add to house accounts |
| `update_house_account` | Update account |
| `delete_house_account` | Remove account |
| `move_to_house` | Move from rep list to house |
| `move_from_house` | Move from house to rep list (Taneisha/Nika) |
| `house_stats` | Get statistics |

**Daily Sales:**

| Tool | Description |
|------|-------------|
| `house_daily_sales` | Get archived sales for date range |
| `house_ytd_sales` | Get YTD summary for house accounts |

---

## See Also

- [MCP Servers](MCP_SERVERS.md) - MCP server configuration
- [Taneisha Accounts API](TANEISHA_ACCOUNTS_API.md) - Rep account management
- [Nika Accounts API](NIKA_ACCOUNTS_API.md) - Rep account management
