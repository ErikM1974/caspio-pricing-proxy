# Monograms API

CRUD endpoints for managing monogram orders (name personalization).

**Version**: 1.0.0
**Created**: 2026-01-09

## Table Schema

| Field | Type | Notes |
|-------|------|-------|
| ID_Monogram | AutoNumber | Primary Key |
| OrderNumber | Number | ShopWorks order number (unique) |
| CompanyName | Text(255) | Customer company |
| SalesRepEmail | Text(255) | Sales rep email |
| FontStyle | Text(255) | Font style |
| ThreadColors | Text(255) | Comma-separated |
| Locations | Text(255) | Comma-separated |
| ImportedNames | Text(255) | Pasted names list |
| NotesToProduction | Text(255) | Production notes |
| ItemsJSON | Text(64000) | JSON array of line items |
| TotalItems | Number | Count of items |
| Status | Text(255) | Draft/Submitted/Printed/Completed |
| CreatedAt | Date/Time | Created timestamp |
| CreatedBy | Text(255) | User who created |
| ModifiedAt | Date/Time | Last modified |
| PrintedAt | Date/Time | When printed |

## Endpoints

### 1. GET /api/monograms

List all monograms with optional filters.

**Query Parameters:**
| Parameter | Type | Description |
|-----------|------|-------------|
| orderNumber | Number | Exact match on OrderNumber |
| companyName | String | Partial match (LIKE) |
| status | String | Exact match (Draft/Submitted/Printed/Completed) |
| dateFrom | Date | CreatedAt >= dateFrom (ISO format) |
| dateTo | Date | CreatedAt <= dateTo (ISO format) |

**Example Request:**
```bash
# Get all monograms
curl "https://caspio-pricing-proxy-ab30a049961a.herokuapp.com/api/monograms"

# Filter by status
curl "https://caspio-pricing-proxy-ab30a049961a.herokuapp.com/api/monograms?status=Submitted"

# Filter by company name (partial match)
curl "https://caspio-pricing-proxy-ab30a049961a.herokuapp.com/api/monograms?companyName=Acme"

# Filter by date range
curl "https://caspio-pricing-proxy-ab30a049961a.herokuapp.com/api/monograms?dateFrom=2026-01-01&dateTo=2026-01-31"
```

**Example Response:**
```json
{
  "success": true,
  "count": 2,
  "monograms": [
    {
      "ID_Monogram": 1,
      "OrderNumber": 138500,
      "CompanyName": "Acme Corp",
      "SalesRepEmail": "sales@example.com",
      "FontStyle": "Script",
      "ThreadColors": "Navy,White",
      "Locations": "Left Chest",
      "ImportedNames": "John Smith\nJane Doe",
      "NotesToProduction": "Rush order",
      "ItemsJSON": "[{\"name\":\"John Smith\",\"size\":\"L\"}]",
      "TotalItems": 2,
      "Status": "Submitted",
      "CreatedAt": "2026-01-09T10:00:00.000Z",
      "CreatedBy": "user@example.com",
      "ModifiedAt": null,
      "PrintedAt": null
    }
  ]
}
```

### 2. GET /api/monograms/:orderNumber

Get a single monogram by OrderNumber.

**Example Request:**
```bash
curl "https://caspio-pricing-proxy-ab30a049961a.herokuapp.com/api/monograms/138500"
```

**Example Response:**
```json
{
  "success": true,
  "monogram": {
    "ID_Monogram": 1,
    "OrderNumber": 138500,
    "CompanyName": "Acme Corp",
    "Status": "Submitted",
    ...
  }
}
```

**404 Response:**
```json
{
  "success": false,
  "error": "Monogram not found"
}
```

### 3. POST /api/monograms

Create a new monogram. Supports **upsert** - if OrderNumber already exists, updates the existing record instead of creating a duplicate.

**Required Fields:**
- `OrderNumber` (Number) - ShopWorks order number

**Example Request:**
```bash
curl -X POST "https://caspio-pricing-proxy-ab30a049961a.herokuapp.com/api/monograms" \
  -H "Content-Type: application/json" \
  -d '{
    "OrderNumber": 138500,
    "CompanyName": "Acme Corp",
    "SalesRepEmail": "sales@example.com",
    "FontStyle": "Script",
    "ThreadColors": "Navy,White",
    "Locations": "Left Chest",
    "ImportedNames": "John Smith\nJane Doe",
    "NotesToProduction": "Rush order",
    "ItemsJSON": "[{\"name\":\"John Smith\",\"size\":\"L\"}]",
    "TotalItems": 2,
    "Status": "Draft",
    "CreatedBy": "user@example.com"
  }'
```

**Create Response (201):**
```json
{
  "success": true,
  "action": "created",
  "monogram": {
    "ID_Monogram": 1,
    "OrderNumber": 138500,
    "CompanyName": "Acme Corp",
    "CreatedAt": "2026-01-09T10:00:00.000Z",
    ...
  }
}
```

**Upsert Response (200):**
```json
{
  "success": true,
  "action": "updated",
  "monogram": {
    "ID_Monogram": 1,
    "OrderNumber": 138500,
    "ModifiedAt": "2026-01-09T11:00:00.000Z",
    ...
  }
}
```

### 4. PUT /api/monograms/:id_monogram

Update an existing monogram by ID_Monogram.

**Example Request:**
```bash
curl -X PUT "https://caspio-pricing-proxy-ab30a049961a.herokuapp.com/api/monograms/1" \
  -H "Content-Type: application/json" \
  -d '{
    "Status": "Printed",
    "PrintedAt": "2026-01-09T14:00:00.000Z"
  }'
```

**Example Response:**
```json
{
  "success": true,
  "message": "Monogram updated successfully"
}
```

### 5. DELETE /api/monograms/:id_monogram

Delete a monogram by ID_Monogram (hard delete).

**Example Request:**
```bash
curl -X DELETE "https://caspio-pricing-proxy-ab30a049961a.herokuapp.com/api/monograms/1"
```

**Example Response:**
```json
{
  "success": true,
  "message": "Monogram deleted successfully"
}
```

## Status Values

| Status | Description |
|--------|-------------|
| Draft | Initial state, still being edited |
| Submitted | Ready for production |
| Printed | Production sheet printed |
| Completed | All items completed |

## ItemsJSON Format

The `ItemsJSON` field stores line item data as a JSON string. Example structure:

```json
[
  {
    "name": "John Smith",
    "size": "L",
    "quantity": 1
  },
  {
    "name": "Jane Doe",
    "size": "M",
    "quantity": 1
  }
]
```

**Note:** Store as-is (stringified JSON), return as-is. The API does not parse or validate the JSON contents.

## Error Responses

All endpoints return consistent error format:

```json
{
  "success": false,
  "error": "Error message here"
}
```

| Status Code | Description |
|-------------|-------------|
| 400 | Bad Request - Missing required parameters |
| 404 | Not Found - Monogram doesn't exist |
| 500 | Server Error - API or database error |
