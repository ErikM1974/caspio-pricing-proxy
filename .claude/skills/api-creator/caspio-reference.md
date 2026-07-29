# Caspio REST API v3 Reference

Quick reference for Caspio API patterns used in the NWCA proxy server.

## Base URL Structure

```
https://c3eku948.caspio.com/integrations/rest/v3
```

## Authentication

All requests require Bearer token authentication:

```
Authorization: Bearer {access_token}
```

Tokens are managed automatically by `src/utils/caspio.js` via `getCaspioAccessToken()`.

## Common Endpoints

### Tables

#### Get Records
```
GET /v3/tables/{tableName}/records
```

**Parameters:**
- `q.select` - Comma-separated field list
- `q.where` - Filter condition (e.g., `Status='Active'`)
- `q.orderBy` - Sort field (e.g., `Date_Created DESC`)
- `q.limit` - Max records (default: 100, max: 1000)
- `q.pageNumber` - Page number (for pagination)
- `q.pageSize` - Records per page (5-1000)

**Example:**
```bash
GET /v3/tables/Production_Schedules/records?q.where=Date>'2024-01-01'&q.limit=50
```

#### Create Record
```
POST /v3/tables/{tableName}/records
Content-Type: application/json

{
  "field1": "value1",
  "field2": "value2"
}
```

#### Update Record
```
PUT /v3/tables/{tableName}/records
Content-Type: application/json

{
  "PK_ID": 123,
  "field1": "new_value"
}
```

#### Delete Record
```
DELETE /v3/tables/{tableName}/records?q.where=PK_ID=123
```

### Views

Same as Tables but read-only (GET only):

```
GET /v3/views/{viewName}/records
```

### Files

#### Upload File
```
POST /v3/files
Content-Type: multipart/form-data
```

#### Get Files
```
GET /v3/files
```

## Query Syntax

### WHERE Clause Examples

**Text Equality:**
```
q.where=Status='Active'
q.where=CompanyName='Northwest Custom Apparel'
```

**Text LIKE (partial match):**
```
q.where=CompanyName LIKE '%Custom%'
```

**Numbers:**
```
q.where=Price>100
q.where=Quantity<=50
q.where=Price BETWEEN 10 AND 100
```

**Dates:**
```
q.where=Date_Created>='2024-01-01'
q.where=Date_Created BETWEEN '2024-01-01' AND '2024-12-31'
```

**Boolean:**
```
q.where=IsActive=true
q.where=Discontinued=false
```

**Multiple Conditions:**
```
q.where=Status='Active' AND Price>50
q.where=Category='Polos' OR Category='T-Shirts'
```

**Complex:**
```
q.where=(Status='Active' OR Status='Pending') AND Price<100
```

### ORDER BY Examples

```
q.orderBy=Date_Created DESC
q.orderBy=Price ASC
q.orderBy=CompanyName
```

### SELECT Examples

```
q.select=PK_ID,CompanyName,Status
q.select=*  (default - all fields)
```

## Special Field Types

### PK_ID
- System-generated unique identifier
- Read-only (cannot update or delete)
- Always included in responses
- In tables: Long integer
- In views: Comma-separated list of source table PK_IDs

### Password Fields
- Cannot be retrieved via GET
- Can be set during POST (create)
- Cannot be updated via standard PUT
- Use special password update method
- Automatically excluded from SELECT *

### Date Fields
- Always returned in ISO 8601 format: `YYYY-MM-DDTHH:mm:ss`
- Accept input as: `YYYY-MM-DD` or full ISO 8601

### Attachment Fields
- Separate endpoints for file operations
- Use `/v3/tables/{tableName}/attachments/{attachmentFieldName}/{recordPkId}`

## Pagination

**CRITICAL:** Caspio returns max 1,000 records per request.

### Method 1: Offset-based (using q.skip)
```javascript
// Page 1: q.limit=100
// Page 2: q.skip=100&q.limit=100
// Page 3: q.skip=200&q.limit=100
```

### Method 2: Page-based
```javascript
q.pageNumber=1&q.pageSize=100
q.pageNumber=2&q.pageSize=100
```

### Method 3: Next Page Token (recommended)
Caspio returns `NextPageLink` in response when more pages exist.
Use `fetchAllCaspioPages()` to handle automatically.

**Always use `fetchAllCaspioPages()`** in NWCA proxy to ensure all records are retrieved.

## Response Format

### Success Response
```json
{
  "Result": [
    {
      "PK_ID": 1,
      "field1": "value1",
      "field2": "value2"
    }
  ],
  "NextPageLink": "https://...@nextpage=..."  // if more pages exist
}
```

### Error Response
```json
{
  "Code": "ObjectNotFound",
  "Message": "Requested object not found",
  "Resource": "/v3/tables/InvalidTable/records",
  "RequestId": "abc123xyz"
}
```

## HTTP Status Codes

- `200 OK` - Success (GET)
- `201 Created` - Success (POST)
- `204 No Content` - Success (PUT/DELETE)
- `400 Bad Request` - Invalid parameters or query syntax
- `401 Unauthorized` - Invalid or expired token
- `403 Forbidden` - IP restricted or unsecured connection
- `404 Not Found` - Table/view doesn't exist
- `415 Unsupported Media Type` - Missing Content-Type header
- `500 Internal Server Error` - Caspio server error

## Error Codes

| Code | Meaning | Fix |
|------|---------|-----|
| `IncorrectBodyParameter` | Missing or invalid body parameter | Check JSON format, required fields |
| `IncorrectQueryParameter` | Invalid query parameter | Check q.where syntax, field names |
| `InternalError` | Caspio internal error | Retry later or contact support |
| `ProfileDisabled` | API profile disabled | Enable in Caspio settings |
| `SqlServerError` | Database error | Check query syntax, field types |
| `InsufficientPermissions` | No permission for operation | Check API profile permissions |
| `IpForbidden` | IP not whitelisted | Add IP to Caspio whitelist |
| `UnsecuredConnection` | HTTP instead of HTTPS | Use HTTPS only |
| `ObjectNotFound` | Table/view doesn't exist | Check table name spelling |

## Headers

### Required for All Requests
```
Authorization: Bearer {token}
```

### Required for POST/PUT/DELETE
```
Content-Type: application/json
```

### Optional
```
Accept: application/json (default)
Accept: application/xml
Principal: {user-info}  (for HIPAA audit logs)
```

### Response Headers
```
X-Caspio-Request-ID: {request-tracking-id}
```
Use this for debugging/support. Always log in error cases.

## Limits

- **Max records per request:** 1,000
- **Max URI length:** 2,047 characters
- **Protocol:** HTTPS only (HTTP not allowed)
- **Encoding:** URL encode all query parameters

## Field Naming Conventions

Caspio field names:
- Case-sensitive
- Can contain underscores: `Date_Created`
- Can contain spaces: `Company Name` (must encode in URLs)
- Cannot start with numbers

## Best Practices

1. **Always use `fetchAllCaspioPages()`** for multi-record GET requests
2. **Always log `X-Caspio-Request-ID`** for errors
3. **Always validate user input** before building q.where
4. **Always handle pagination** (1000 record limit)
5. **Never expose password fields** in responses
6. **Always use HTTPS** (never HTTP)
7. **Always URL encode** special characters in queries
8. **Cache access tokens** (reuse until expired)

## URL Encoding

Special characters must be encoded in q.where:

```
Space: %20
Single quote: %27 or ''
Double quote: %22
&: %26
=: %3D
<: %3C
>: %3E
```

**Example:**
```
Raw: q.where=CompanyName='O'Reilly & Sons'
Encoded: q.where=CompanyName%3D'O''Reilly%20%26%20Sons'
```

**Note:** Most HTTP clients (axios, fetch) auto-encode, but Swagger UI may require manual encoding.

## Common Patterns in NWCA Proxy

### Simple Read-Only Endpoint
```javascript
const params = {};
if (req.query['q.where']) params['q.where'] = req.query['q.where'];
if (req.query['q.orderBy']) params['q.orderby'] = req.query['q.orderBy'];
params['q.limit'] = parseInt(req.query['q.limit'] || 100);

const result = await fetchAllCaspioPages('/tables/MyTable/records', params);
res.json(result);
```

### Field-Specific Filters
```javascript
const whereConditions = [];
if (req.query.status) whereConditions.push(`Status='${req.query.status}'`);
if (req.query.companyName) whereConditions.push(`CompanyName LIKE '%${req.query.companyName}%'`);
if (whereConditions.length > 0) params['q.where'] = whereConditions.join(' AND ');
```

### Date Range Filter
```javascript
if (req.query.dateFrom) whereConditions.push(`Date_Created>='${req.query.dateFrom}'`);
if (req.query.dateTo) whereConditions.push(`Date_Created<='${req.query.dateTo}'`);
```

### Create Record (POST)
```javascript
const token = await getCaspioAccessToken();
const response = await axios.post(
  `${caspioApiBaseUrl}/tables/MyTable/records`,
  req.body,
  {
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json'
    }
  }
);
res.status(201).json(response.data);
```

### Update Record (PUT)
```javascript
const id = req.params.id;
const response = await axios.put(
  `${caspioApiBaseUrl}/tables/MyTable/records`,
  { PK_ID: id, ...req.body },
  { headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' } }
);
res.status(200).json(response.data);
```

### Delete Record (DELETE)
```javascript
const id = req.params.id;
await axios.delete(
  `${caspioApiBaseUrl}/tables/MyTable/records?q.where=PK_ID=${id}`,
  { headers: { 'Authorization': `Bearer ${token}` } }
);
res.status(204).send();
```

## Testing in Swagger

1. Go to: https://c3eku948.caspio.com/integrations/rest
2. Click "Authorize" and enter token
3. Find desired endpoint
4. Click "Try it out"
5. Enter parameters
6. Click "Execute"
7. Verify response before implementing in proxy

## References

- Full Caspio API Docs: https://howto.caspio.com/web-services-api/rest-api/
- OAuth Authentication: https://howto.caspio.com/web-services-api/rest-api/authenticate-with-rest-api/
- Query Parameters: https://howto.caspio.com/web-services-api/rest-api/table-records-operations/
