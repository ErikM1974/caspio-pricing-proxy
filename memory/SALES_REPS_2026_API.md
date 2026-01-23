# Sales Reps 2026 API

**Version**: 1.0.0
**Added**: 2026-01-23
**Table**: `Sales_Reps_2026`

## Overview

CRUD API for managing the master list of customer-to-sales-rep assignments. This table tracks which sales rep is assigned to each customer account.

## Authentication

All endpoints require server-to-server authentication via the `X-CRM-API-SECRET` header.

```bash
curl -H "X-CRM-API-SECRET: your_secret" http://localhost:3002/api/sales-reps-2026
```

## Table Schema

| Field | Type | Description |
|-------|------|-------------|
| ID_Customer | Integer | Primary key (customer ID from ManageOrders) |
| CompanyName | Text (255) | Customer company name |
| CustomerServiceRep | Text (255) | Assigned sales rep name |
| Account_Tier | Text (255) | Account tier classification |
| Inksoft_Store | Yes/No | Has an InkSoft store |
| date_LastOrdered | Date/Time | Last order date |

## Endpoints

### GET /api/sales-reps-2026
List all records with optional filters.

**Query Parameters:**
| Parameter | Type | Description |
|-----------|------|-------------|
| customerServiceRep | string | Filter by rep name |
| accountTier | string | Filter by tier |
| inksoftStore | boolean | Filter by InkSoft store (true/false) |
| search | string | Search CompanyName (LIKE) |
| customerId | integer | Filter by specific ID |
| orderBy | string | Sort field (default: CompanyName) |
| orderDir | string | Sort direction (ASC/DESC) |

**Response:**
```json
{
  "success": true,
  "count": 150,
  "records": [
    {
      "ID_Customer": 12345,
      "CompanyName": "Acme Corp",
      "CustomerServiceRep": "Taneisha",
      "Account_Tier": "A",
      "Inksoft_Store": true,
      "date_LastOrdered": "2026-01-15T00:00:00"
    }
  ]
}
```

### GET /api/sales-reps-2026/stats
Get summary statistics.

**Response:**
```json
{
  "success": true,
  "total": 1200,
  "inksoftStores": 45,
  "byRep": {
    "Taneisha": 800,
    "Nika": 400
  },
  "byTier": {
    "A": 100,
    "B": 500,
    "C": 600
  }
}
```

### GET /api/sales-reps-2026/:id
Get single record by ID_Customer.

**Response:**
```json
{
  "success": true,
  "record": {
    "ID_Customer": 12345,
    "CompanyName": "Acme Corp",
    "CustomerServiceRep": "Taneisha",
    "Account_Tier": "A",
    "Inksoft_Store": true,
    "date_LastOrdered": "2026-01-15T00:00:00"
  }
}
```

### POST /api/sales-reps-2026
Create new record.

**Request Body:**
```json
{
  "ID_Customer": 12345,
  "CompanyName": "Acme Corp",
  "CustomerServiceRep": "Taneisha",
  "Account_Tier": "B",
  "Inksoft_Store": false
}
```

**Response (201):**
```json
{
  "success": true,
  "message": "Record created successfully",
  "record": { ... }
}
```

### PUT /api/sales-reps-2026/:id
Update record.

**Request Body:**
```json
{
  "CustomerServiceRep": "Nika",
  "Account_Tier": "A"
}
```

**Response:**
```json
{
  "success": true,
  "message": "Record updated successfully",
  "updatedFields": ["CustomerServiceRep", "Account_Tier"]
}
```

### DELETE /api/sales-reps-2026/:id
Delete record.

**Response:**
```json
{
  "success": true,
  "message": "Record deleted successfully"
}
```

### POST /api/sales-reps-2026/bulk
Bulk create records.

**Request Body:**
```json
{
  "records": [
    { "ID_Customer": 111, "CompanyName": "Company A", "CustomerServiceRep": "Taneisha" },
    { "ID_Customer": 222, "CompanyName": "Company B", "CustomerServiceRep": "Nika" }
  ]
}
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

## Error Responses

| Status | Description |
|--------|-------------|
| 400 | Missing required field or invalid input |
| 401 | Missing or invalid X-CRM-API-SECRET |
| 404 | Record not found |
| 409 | Duplicate ID_Customer (on create) |
| 500 | Server error |

## Usage Examples

```bash
# List all records for Taneisha
curl -H "X-CRM-API-SECRET: $SECRET" \
  "http://localhost:3002/api/sales-reps-2026?customerServiceRep=Taneisha"

# Get stats
curl -H "X-CRM-API-SECRET: $SECRET" \
  "http://localhost:3002/api/sales-reps-2026/stats"

# Update account tier
curl -X PUT -H "X-CRM-API-SECRET: $SECRET" -H "Content-Type: application/json" \
  -d '{"Account_Tier":"A"}' \
  "http://localhost:3002/api/sales-reps-2026/12345"
```
