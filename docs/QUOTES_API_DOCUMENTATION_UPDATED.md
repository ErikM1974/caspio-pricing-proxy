# Quote API Documentation - Current Status

## Overview

This documentation provides current status and working endpoints for the Quote API. Based on live testing with the Heroku server, here's the accurate functionality:

## Base Information

- **Base URL**: `https://caspio-pricing-proxy-ab30a049961a.herokuapp.com` (production)
- **Development URL**: `http://localhost:3000` (local development)
- **API Version**: 1.0.0
- **Content Type**: `application/json`
- **Authentication**: None required (proxy handles Caspio authentication)

## ✅ FULLY WORKING ENDPOINTS

### Quote Sessions - Full CRUD Support

All Quote Sessions operations are working perfectly on the Heroku server.

#### GET /api/quote_sessions
✅ **Status: WORKING** - Retrieve all quote sessions or filter by query parameters.

**Query Parameters:**
- `quoteID` (string, optional) - Filter by quote ID
- `sessionID` (string, optional) - Filter by session ID
- `customerEmail` (string, optional) - Filter by customer email
- `status` (string, optional) - Filter by status

**Example Request:**
```bash
GET https://caspio-pricing-proxy-ab30a049961a.herokuapp.com/api/quote_sessions?sessionID=test-session-123
```

#### POST /api/quote_sessions
✅ **Status: WORKING** - Create a new quote session.

**Required Fields:**
- `QuoteID` (string) - Quote identifier
- `SessionID` (string) - Session identifier
- `Status` (string) - Session status

**Example Request:**
```bash
curl -X POST https://caspio-pricing-proxy-ab30a049961a.herokuapp.com/api/quote_sessions \
  -H "Content-Type: application/json" \
  -d '{
    "QuoteID": "quote-456",
    "SessionID": "session-123",
    "Status": "Active",
    "CustomerEmail": "test@example.com",
    "CustomerName": "John Doe"
  }'
```

#### PUT /api/quote_sessions/:id
✅ **Status: WORKING** - Update an existing quote session.

#### DELETE /api/quote_sessions/:id
✅ **Status: WORKING** - Delete a quote session.

## ✅ PARTIALLY WORKING ENDPOINTS

### Quote Analytics - Read Operations Only

GET operations work perfectly. POST operations currently have issues.

#### GET /api/quote_analytics
✅ **Status: WORKING** - Retrieve all quote analytics records.

**Query Parameters:**
- `sessionID` (string, optional) - Filter by session ID
- `quoteID` (string, optional) - Filter by quote ID
- `eventType` (string, optional) - Filter by event type

**Example Request:**
```bash
GET https://caspio-pricing-proxy-ab30a049961a.herokuapp.com/api/quote_analytics?sessionID=test-session-123
```

**Example Response:**
```json
[
  {
    "PK_ID": 17,
    "SessionID": "test_session_123",
    "QuoteID": "test_quote",
    "EventType": "test_event",
    "StyleNumber": "",
    "Color": "",
    "PrintLocation": "",
    "Quantity": null,
    "HasLTM": "",
    "PriceShown": null,
    "UserAgent": "",
    "IPAddress": "",
    "Timestamp": null,
    "NoName": "",
    "AnalyticsID": 13
  }
]
```

#### GET /api/quote_analytics/:id
✅ **Status: WORKING** - Retrieve a specific quote analytics record by PK_ID.

#### POST /api/quote_analytics
❌ **Status: CURRENTLY NOT WORKING** - Returns 500 error "Failed to create Quote_Analytics record."

#### PUT /api/quote_analytics/:id
⚠️ **Status: UNTESTED** - May work for existing records

#### DELETE /api/quote_analytics/:id
⚠️ **Status: UNTESTED** - May work for existing records

### Quote Items - Read Operations Only

GET operations work perfectly. POST operations currently have issues.

#### GET /api/quote_items
✅ **Status: WORKING** - Retrieve all quote items.

**Query Parameters:**
- `quoteID` (string, optional) - Filter by quote ID
- `styleNumber` (string, optional) - Filter by style number

**Example Request:**
```bash
GET https://caspio-pricing-proxy-ab30a049961a.herokuapp.com/api/quote_items?quoteID=Q_20250529_SAMPLE
```

**Example Response:**
```json
[
  {
    "PK_ID": 1,
    "QuoteID": "Q_20250529_SAMPLE",
    "LineNumber": 1,
    "StyleNumber": "PC61",
    "ProductName": "Essential Tee",
    "Color": "Black",
    "ColorCode": "BLACK",
    "EmbellishmentType": "dtg",
    "PrintLocation": "FF",
    "PrintLocationName": "Full Front",
    "Quantity": 48,
    "HasLTM": "No",
    "BaseUnitPrice": 15.99,
    "LTMPerUnit": 0,
    "FinalUnitPrice": 15.99,
    "LineTotal": 767.52,
    "SizeBreakdown": "{\"S\":12,\"M\":12,\"L\":12,\"XL\":12}",
    "PricingTier": "48-71",
    "ImageURL": "https://example.com/pc61-black.jpg",
    "AddedAt": "2025-05-29T12:00:00",
    "ItemID": 1
  }
]
```

#### GET /api/quote_items/:id
✅ **Status: WORKING** - Retrieve a specific quote item by PK_ID.

#### POST /api/quote_items
❌ **Status: CURRENTLY NOT WORKING** - Returns 500 error "Failed to create Quote_Items record."

#### PUT /api/quote_items/:id
⚠️ **Status: UNTESTED** - May work for existing records

#### DELETE /api/quote_items/:id
⚠️ **Status: UNTESTED** - May work for existing records

## 🔧 Working Integration Examples

### Quote Sessions (Fully Functional)

```javascript
// Working example for Quote Sessions
class QuoteSessionsService {
  constructor(baseUrl = 'https://caspio-pricing-proxy-ab30a049961a.herokuapp.com') {
    this.baseUrl = baseUrl;
  }

  // ✅ WORKING - Create new quote session
  async createSession(quoteId, sessionId, customerData = {}) {
    const payload = {
      QuoteID: quoteId,
      SessionID: sessionId,
      Status: 'Active',
      ...customerData
    };

    const response = await fetch(`${this.baseUrl}/api/quote_sessions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      throw new Error(`Failed to create session: ${response.statusText}`);
    }

    return response.json();
  }

  // ✅ WORKING - Get sessions
  async getSessionBySessionId(sessionId) {
    const response = await fetch(
      `${this.baseUrl}/api/quote_sessions?sessionID=${sessionId}`
    );

    if (!response.ok) {
      throw new Error(`Failed to fetch session: ${response.statusText}`);
    }

    return response.json();
  }

  // ✅ WORKING - Update session
  async updateSession(pkId, updates) {
    const response = await fetch(`${this.baseUrl}/api/quote_sessions/${pkId}`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(updates)
    });

    if (!response.ok) {
      throw new Error(`Failed to update session: ${response.statusText}`);
    }

    return response.json();
  }
}
```

### Quote Analytics (Read-Only)

```javascript
// Read-only example for Quote Analytics
class QuoteAnalyticsService {
  constructor(baseUrl = 'https://caspio-pricing-proxy-ab30a049961a.herokuapp.com') {
    this.baseUrl = baseUrl;
  }

  // ✅ WORKING - Get analytics for a session
  async getSessionAnalytics(sessionId) {
    const response = await fetch(
      `${this.baseUrl}/api/quote_analytics?sessionID=${sessionId}`
    );

    if (!response.ok) {
      throw new Error(`Failed to fetch analytics: ${response.statusText}`);
    }

    return response.json();
  }

  // ✅ WORKING - Get all analytics
  async getAllAnalytics() {
    const response = await fetch(`${this.baseUrl}/api/quote_analytics`);

    if (!response.ok) {
      throw new Error(`Failed to fetch analytics: ${response.statusText}`);
    }

    return response.json();
  }

  // ❌ NOT WORKING - Create analytics (500 error)
  // async trackEvent(sessionId, eventType, data = {}) {
  //   // This currently returns 500 error
  // }
}
```

### Quote Items (Read-Only)

```javascript
// Read-only example for Quote Items
class QuoteItemsService {
  constructor(baseUrl = 'https://caspio-pricing-proxy-ab30a049961a.herokuapp.com') {
    this.baseUrl = baseUrl;
  }

  // ✅ WORKING - Get items for a quote
  async getQuoteItems(quoteId) {
    const response = await fetch(
      `${this.baseUrl}/api/quote_items?quoteID=${quoteId}`
    );

    if (!response.ok) {
      throw new Error(`Failed to fetch items: ${response.statusText}`);
    }

    return response.json();
  }

  // ✅ WORKING - Get all items
  async getAllItems() {
    const response = await fetch(`${this.baseUrl}/api/quote_items`);

    if (!response.ok) {
      throw new Error(`Failed to fetch items: ${response.statusText}`);
    }

    return response.json();
  }

  // ❌ NOT WORKING - Add item (500 error)
  // async addItem(quoteId, item) {
  //   // This currently returns 500 error
  // }
}
```

## 🧪 Working Test Examples

### Test Quote Sessions (Full CRUD)

```bash
# ✅ Create a quote session
curl -X POST https://caspio-pricing-proxy-ab30a049961a.herokuapp.com/api/quote_sessions \
  -H "Content-Type: application/json" \
  -d '{
    "QuoteID": "test-quote-123",
    "SessionID": "test-session-123",
    "Status": "Active",
    "CustomerEmail": "test@example.com"
  }'

# ✅ Get quote sessions
curl https://caspio-pricing-proxy-ab30a049961a.herokuapp.com/api/quote_sessions?sessionID=test-session-123

# ✅ Update quote session (use PK_ID from creation response)
curl -X PUT https://caspio-pricing-proxy-ab30a049961a.herokuapp.com/api/quote_sessions/1 \
  -H "Content-Type: application/json" \
  -d '{
    "Status": "Completed",
    "Notes": "Session completed successfully"
  }'

# ✅ Delete quote session
curl -X DELETE https://caspio-pricing-proxy-ab30a049961a.herokuapp.com/api/quote_sessions/1
```

### Test Analytics and Items (Read-Only)

```bash
# ✅ Get all quote analytics
curl https://caspio-pricing-proxy-ab30a049961a.herokuapp.com/api/quote_analytics

# ✅ Get analytics by session
curl https://caspio-pricing-proxy-ab30a049961a.herokuapp.com/api/quote_analytics?sessionID=test_session_123

# ✅ Get all quote items
curl https://caspio-pricing-proxy-ab30a049961a.herokuapp.com/api/quote_items

# ✅ Get items by quote ID
curl https://caspio-pricing-proxy-ab30a049961a.herokuapp.com/api/quote_items?quoteID=Q_20250529_SAMPLE
```

## 📋 Current Limitations

1. **Quote Analytics POST**: Currently returns 500 error - issue with auto-ID generation
2. **Quote Items POST**: Currently returns 500 error - issue with auto-ID generation
3. **Analytics/Items PUT/DELETE**: Untested but may work for existing records

## 📊 Data Models (From Live Data)

### Quote Session Model (Working)
```typescript
interface QuoteSession {
  PK_ID: number;              // Auto-generated primary key
  QuoteID: string;            // Quote ID (required)
  SessionID: string;          // Session ID (required)
  CustomerEmail?: string;     // Customer email
  CustomerName?: string;      // Customer name
  CompanyName?: string;       // Company name
  Phone?: string;             // Phone number
  TotalQuantity?: number;     // Total quantity
  SubtotalAmount?: number;    // Subtotal
  LTMFeeTotal?: number;       // LTM fees total
  TotalAmount?: number;       // Grand total
  Status: string;             // Status (required)
  CreatedAt: string;          // Created timestamp (auto-generated)
  UpdatedAt: string;          // Updated timestamp (auto-updated)
  ExpiresAt?: string;         // Expiration timestamp
  Notes?: string;             // Additional notes
}
```

### Quote Analytics Model (Read-Only)
```typescript
interface QuoteAnalytics {
  PK_ID: number;              // Auto-generated primary key
  AnalyticsID: number;        // Analytics identifier
  SessionID: string;          // Session ID
  QuoteID?: string;           // Quote ID
  EventType: string;          // Event type
  StyleNumber?: string;       // Product style
  Color?: string;             // Product color
  PrintLocation?: string;     // Print location
  Quantity?: number;          // Quantity
  HasLTM?: string;           // "Yes" or "No"
  PriceShown?: number;       // Price displayed
  UserAgent?: string;        // Browser user agent
  IPAddress?: string;        // User IP address
  Timestamp?: string;        // ISO 8601 timestamp
  NoName?: string;           // Additional field
}
```

### Quote Item Model (Read-Only)
```typescript
interface QuoteItem {
  PK_ID: number;              // Auto-generated primary key
  ItemID: number;             // Item identifier
  QuoteID: string;            // Quote ID
  LineNumber?: number;        // Line number
  StyleNumber: string;        // Style number
  ProductName?: string;       // Product name
  Color?: string;             // Color
  ColorCode?: string;         // Color code
  EmbellishmentType?: string; // Decoration type
  PrintLocation?: string;     // Print location code
  PrintLocationName?: string; // Print location name
  Quantity: number;           // Quantity
  HasLTM?: string;           // "Yes" or "No"
  BaseUnitPrice?: number;    // Base price per unit
  LTMPerUnit?: number;       // LTM fee per unit
  FinalUnitPrice?: number;   // Final price per unit
  LineTotal?: number;        // Line total
  SizeBreakdown?: string;    // JSON size breakdown
  PricingTier?: string;      // Pricing tier
  ImageURL?: string;         // Product image URL
  AddedAt?: string;          // ISO 8601 timestamp
}
```

## 🎯 Recommended Integration Approach

For immediate integration with Claude's website:

1. **Start with Quote Sessions** - These work perfectly for managing quote state
2. **Use Analytics/Items for reading existing data** - Perfect for displaying historical quotes
3. **Consider workarounds for creating analytics/items** - Could use direct Caspio integration or fix server-side issues

## 🚀 Next Steps

1. Quote Sessions can be immediately integrated and used for production
2. Analytics and Items reading functionality is production-ready
3. POST functionality for Analytics/Items needs server-side debugging
4. All GET operations are fully functional and ready for use

This documentation reflects the actual tested state of the Heroku server as of June 4, 2025.
