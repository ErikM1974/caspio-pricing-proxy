# Garment Tracker API

**Version:** 1.0.0
**Added:** 2026-01-09
**Purpose:** Pre-processed garment tracking data for staff dashboard optimization

## Overview

The Garment Tracker API stores pre-processed garment tracking data from ManageOrders. Instead of making 44+ API calls on each dashboard page load, we:

1. Sync tracked line items to the `GarmentTracker` table periodically
2. Query this table for instant dashboard loading (1 API call vs 44+)

**Benefits:**
- 44+ API calls reduced to 1
- ~30 second load time reduced to ~1 second
- No rate limiting issues
- Full audit trail with order details
- Persistent data across page refreshes

## Caspio Table Schema

**Table Name:** `GarmentTracker` (in Sanmar Pricing 2025 app)

| Field | Type | Description |
|-------|------|-------------|
| ID_Garment | AutoNumber | Primary Key |
| OrderNumber | Number | ShopWorks order number |
| DateInvoiced | Text 255 | Invoice date (YYYY-MM-DD format) |
| RepName | Text 255 | Customer Service Rep name |
| CustomerName | Text 255 | Customer's name |
| CompanyName | Text 255 | Company name |
| PartNumber | Text 255 | Product part number (e.g., CT104670, 112) |
| StyleCategory | Text 255 | Category (Premium, Richardson, etc.) |
| Quantity | Number | Item quantity |
| BonusAmount | Number | Calculated bonus amount |
| TrackedAt | Date/Time | When record was synced |

## Endpoints

### GET /api/garment-tracker

List all records with optional Caspio query parameters.

**Query Parameters (passthrough to Caspio):**
- `q.where` - WHERE clause filter
- `q.orderBy` - ORDER BY clause (default: `TrackedAt DESC`)
- `q.limit` - Result limit

**Examples:**
```bash
# Get all records
GET /api/garment-tracker

# Filter by rep
GET /api/garment-tracker?q.where=RepName='Nika Lao'

# Filter by year
GET /api/garment-tracker?q.where=YEAR(TrackedAt)=2026

# Filter by date range
GET /api/garment-tracker?q.where=DateInvoiced>='2026-01-01' AND DateInvoiced<='2026-01-31'

# Filter by style category
GET /api/garment-tracker?q.where=StyleCategory='Premium'

# Custom ordering and limit
GET /api/garment-tracker?q.orderBy=DateInvoiced DESC&q.limit=100
```

**Response:**
```json
{
  "success": true,
  "count": 8,
  "records": [
    {
      "ID_Garment": 1,
      "OrderNumber": 139697,
      "DateInvoiced": "2026-01-03",
      "RepName": "Nika Lao",
      "CustomerName": "John Smith",
      "CompanyName": "ABC Company",
      "PartNumber": "CT104670",
      "StyleCategory": "Premium",
      "Quantity": 2,
      "BonusAmount": 10.00,
      "TrackedAt": "2026-01-09T12:00:00.000Z"
    }
  ]
}
```

### GET /api/garment-tracker/:id

Get single record by ID_Garment.

**Example:**
```bash
GET /api/garment-tracker/1
```

**Response:**
```json
{
  "success": true,
  "record": {
    "ID_Garment": 1,
    "OrderNumber": 139697,
    "DateInvoiced": "2026-01-03",
    "RepName": "Nika Lao",
    "CustomerName": "John Smith",
    "CompanyName": "ABC Company",
    "PartNumber": "CT104670",
    "StyleCategory": "Premium",
    "Quantity": 2,
    "BonusAmount": 10.00,
    "TrackedAt": "2026-01-09T12:00:00.000Z"
  }
}
```

### POST /api/garment-tracker

Create new record.

**Request Body:**
```json
{
  "OrderNumber": 139697,
  "DateInvoiced": "2026-01-03",
  "RepName": "Nika Lao",
  "CustomerName": "John Smith",
  "CompanyName": "ABC Company",
  "PartNumber": "CT104670",
  "StyleCategory": "Premium",
  "Quantity": 2,
  "BonusAmount": 10.00,
  "TrackedAt": "2026-01-09T12:00:00Z"
}
```

**Notes:**
- `OrderNumber` is required
- `TrackedAt` will be auto-set to current time if not provided

**Response (201):**
```json
{
  "success": true,
  "record": {
    "ID_Garment": 1,
    "OrderNumber": 139697,
    ...
  }
}
```

### PUT /api/garment-tracker/:id

Update existing record by ID_Garment.

**Example:**
```bash
PUT /api/garment-tracker/1
Content-Type: application/json

{
  "Quantity": 5,
  "BonusAmount": 25.00
}
```

**Response:**
```json
{
  "success": true,
  "message": "Record updated successfully"
}
```

### DELETE /api/garment-tracker/:id

Delete single record by ID_Garment.

**Example:**
```bash
DELETE /api/garment-tracker/1
```

**Response:**
```json
{
  "success": true,
  "message": "Record deleted successfully"
}
```

### DELETE /api/garment-tracker/bulk

Bulk delete with WHERE clause. Use this to clear old year's data.

**Request Body:**
```json
{
  "where": "YEAR(TrackedAt)=2025"
}
```

**Example Use Cases:**
```bash
# Clear all 2025 data
DELETE /api/garment-tracker/bulk
{ "where": "YEAR(TrackedAt)=2025" }

# Clear records for a specific rep
DELETE /api/garment-tracker/bulk
{ "where": "RepName='Former Employee'" }

# Clear records before a date
DELETE /api/garment-tracker/bulk
{ "where": "TrackedAt<'2026-01-01'" }
```

**Response:**
```json
{
  "success": true,
  "message": "Bulk delete completed",
  "recordsAffected": 150
}
```

## Usage Example: Staff Dashboard

### Frontend Integration

```javascript
// Load from Caspio table (FAST - replaces 44+ API calls)
async function loadGarmentTrackerFromTable() {
    const year = new Date().getFullYear();
    const url = `${API_BASE}/garment-tracker?q.where=YEAR(DateInvoiced)=${year}`;
    const response = await fetch(url);
    const data = await response.json();

    if (data.success) {
        // Aggregate by rep and style
        return aggregateTrackerData(data.records);
    }
    return null;
}

// Sync new orders to table (manual trigger)
async function syncGarmentTracker() {
    const lastSync = localStorage.getItem('garmentTracker_lastSync') || '2026-01-01';
    const newOrders = await fetchOrdersSince(lastSync);

    for (const order of newOrders) {
        const lineItems = await fetchLineItems(order.id_Order);
        for (const item of lineItems) {
            if (isTrackedStyle(item.PartNumber)) {
                await fetch(`${API_BASE}/garment-tracker`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        OrderNumber: order.id_Order,
                        DateInvoiced: order.date_Invoiced,
                        RepName: order.CustomerServiceRep,
                        CustomerName: order.Customer_Name,
                        CompanyName: order.Company_Name,
                        PartNumber: item.PartNumber,
                        StyleCategory: getStyleCategory(item.PartNumber),
                        Quantity: calculateQuantity(item),
                        BonusAmount: calculateBonus(item)
                    })
                });
            }
        }
    }

    localStorage.setItem('garmentTracker_lastSync', new Date().toISOString());
}
```

## Test Data

Sample CSV for initial import:

```csv
OrderNumber,DateInvoiced,RepName,CustomerName,CompanyName,PartNumber,StyleCategory,Quantity,BonusAmount,TrackedAt
139697,2026-01-03,Nika Lao,John Smith,ABC Company,CT104670,Premium,2,10.00,2026-01-09
139722,2026-01-04,Taneisha Clark,Jane Doe,XYZ Corp,EB550,Premium,1,5.00,2026-01-09
139788,2026-01-05,Nika Lao,Bob Johnson,123 Industries,112,Richardson,24,12.00,2026-01-09
139789,2026-01-05,Taneisha Clark,Alice Brown,Tech Solutions,CT103828,Premium,1,5.00,2026-01-09
139804,2026-01-06,Nika Lao,Charlie Wilson,Global Inc,168,Richardson,12,6.00,2026-01-09
139850,2026-01-07,Taneisha Clark,Diana Lee,Local Business,CT102286,Premium,3,9.00,2026-01-09
139877,2026-01-08,Nika Lao,Ed Martinez,Coast Enterprises,NF0A52S7,Premium,2,4.00,2026-01-09
139992,2026-01-09,Taneisha Clark,Fran Garcia,Mountain LLC,112FP,Richardson,36,18.00,2026-01-09
```

## Error Responses

| Status | Error | Cause |
|--------|-------|-------|
| 400 | Missing required field: OrderNumber | POST without OrderNumber |
| 400 | Missing required field: where | Bulk delete without where clause |
| 404 | GarmentTracker table not found | Table not created in Caspio |
| 404 | Record not found | GET by ID with invalid ID |
| 500 | Failed to fetch/create/update/delete | Server or Caspio error |

## Production URLs

**Base URL:** `https://caspio-pricing-proxy-ab30a049961a.herokuapp.com`

```bash
# List records
GET /api/garment-tracker

# Create record
POST /api/garment-tracker

# Get by ID
GET /api/garment-tracker/:id

# Update by ID
PUT /api/garment-tracker/:id

# Delete by ID
DELETE /api/garment-tracker/:id

# Bulk delete
DELETE /api/garment-tracker/bulk
```
