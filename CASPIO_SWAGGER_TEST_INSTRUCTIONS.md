# Caspio Swagger Testing Instructions

## How to Access Caspio Swagger Interface

1. **Go to your Caspio account**
2. **Navigate to**: Apps → REST APIs → Your API → Test/Documentation
3. **Or go directly to**: `https://c3eku948.caspio.com/rest/v2/swagger`

## Test 1: Quote_Analytics POST

### Endpoint to Test:
**POST** `/tables/Quote_Analytics/records`

### JSON Payload to Use:
```json
{
  "SessionID": "swagger-test-session-123",
  "EventType": "swagger_test",
  "QuoteID": "swagger-test-quote-456",
  "StyleNumber": "PC61",
  "Color": "Black",
  "PrintLocation": "FF",
  "Quantity": 24,
  "HasLTM": "No",
  "PriceShown": 15.99,
  "UserAgent": "Caspio Swagger Test",
  "IPAddress": "127.0.0.1",
  "Timestamp": "2025-06-04T12:00:00",
  "NoName": "Test Entry"
}
```

### Expected Result:
- ✅ **Success (201)**: Record created successfully
- ❌ **Error**: Will show specific Caspio error message

---

## Test 2: Quote_Items POST

### Endpoint to Test:
**POST** `/tables/Quote_Items/records`

### JSON Payload to Use:
```json
{
  "QuoteID": "swagger-test-quote-456",
  "LineNumber": 1,
  "StyleNumber": "PC61",
  "ProductName": "Essential Tee - Swagger Test",
  "Color": "Black",
  "ColorCode": "BLACK",
  "EmbellishmentType": "dtg",
  "PrintLocation": "FF",
  "PrintLocationName": "Full Front",
  "Quantity": 24,
  "HasLTM": "No",
  "BaseUnitPrice": 15.99,
  "LTMPerUnit": 0,
  "FinalUnitPrice": 15.99,
  "LineTotal": 383.76,
  "SizeBreakdown": "{\"S\":6,\"M\":6,\"L\":6,\"XL\":6}",
  "PricingTier": "24-47",
  "ImageURL": "https://example.com/swagger-test.jpg",
  "AddedAt": "2025-06-04T12:00:00"
}
```

### Expected Result:
- ✅ **Success (201)**: Record created successfully  
- ❌ **Error**: Will show specific Caspio error message

---

## Test 3: Quote_Sessions POST (Should Work)

### Endpoint to Test:
**POST** `/tables/Quote_Sessions/records`

### JSON Payload to Use:
```json
{
  "QuoteID": "swagger-test-quote-456",
  "SessionID": "swagger-test-session-123",
  "CustomerEmail": "swagger@test.com",
  "CustomerName": "Swagger Tester",
  "CompanyName": "Test Company",
  "Phone": "555-1234",
  "TotalQuantity": 24,
  "SubtotalAmount": 383.76,
  "LTMFeeTotal": 0,
  "TotalAmount": 383.76,
  "Status": "Active",
  "ExpiresAt": "2025-07-04T12:00:00",
  "Notes": "Created via Caspio Swagger for testing"
}
```

### Expected Result:
- ✅ **Success (201)**: Should work (this endpoint is already working)

---

## What to Look For:

### If Tests Succeed in Swagger ✅
- **Issue is with our proxy server code**
- **Need to debug our server-side logic**
- **Caspio tables are configured correctly**

### If Tests Fail in Swagger ❌  
- **Issue is with Caspio table configuration**
- **May need primary key adjustments**
- **Possible field validation rules**
- **Missing required fields or data types**

---

## Common Error Messages to Watch For:

### Field Validation Errors:
```json
{
  "Message": "Field 'FieldName' is required",
  "Details": "..."
}
```

### Primary Key Errors:
```json
{
  "Message": "Primary key constraint violation",
  "Details": "..."
}
```

### Data Type Errors:
```json
{
  "Message": "Invalid data type for field 'FieldName'",
  "Details": "..."
}
```

---

## Steps to Test:

1. **Copy the JSON payload** for each test
2. **Paste into Swagger interface** 
3. **Click "Execute"**
4. **Note the response code and message**
5. **Try each endpoint one by one**

## Report Back:

Please tell me:
1. **Which tests succeeded/failed**
2. **Exact error messages** if any failed
3. **Response codes** for each test

This will help us pinpoint exactly what's causing the 500 errors!
