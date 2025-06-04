# Quote API Documentation

## Overview

This documentation provides comprehensive information about the Quote API endpoints for integrating quote functionality into your pricing application. The API supports full CRUD operations for quote analytics, quote items, and quote sessions.

## Base Information

- **Base URL**: `https://caspio-pricing-proxy-ab30a049961a.herokuapp.com` (production)
- **Development URL**: `http://localhost:3000` (local development)
- **API Version**: 1.0.0
- **Content Type**: `application/json`
- **Authentication**: None required (proxy handles Caspio authentication)

## API Endpoints Overview

The Quote API consists of three main resource types:

1. **Quote Analytics** (`/api/quote_analytics`) - Track user interactions and analytics
2. **Quote Items** (`/api/quote_items`) - Manage individual items in quotes
3. **Quote Sessions** (`/api/quote_sessions`) - Handle quote session management

---

## Quote Analytics Endpoints

### GET /api/quote_analytics

Retrieve all quote analytics records or filter by query parameters.

**Query Parameters:**
- `sessionID` (string, optional) - Filter by session ID
- `quoteID` (string, optional) - Filter by quote ID
- `eventType` (string, optional) - Filter by event type

**Example Request:**
```bash
GET /api/quote_analytics?sessionID=sess123&eventType=page_view
```

**Example Response:**
```json
[
  {
    "PK_ID": 1,
    "AnalyticsID": 101,
    "SessionID": "sess123",
    "QuoteID": "quote456",
    "EventType": "page_view",
    "StyleNumber": "PC61",
    "Color": "Red",
    "PrintLocation": "Front",
    "Quantity": 50,
    "HasLTM": "Yes",
    "PriceShown": 12.50,
    "UserAgent": "Mozilla/5.0...",
    "IPAddress": "192.168.1.1",
    "Timestamp": "2025-01-01T12:00:00Z"
  }
]
```

### GET /api/quote_analytics/:id

Retrieve a specific quote analytics record by PK_ID.

**Path Parameters:**
- `id` (integer, required) - The PK_ID of the analytics record

**Example Request:**
```bash
GET /api/quote_analytics/1
```

### POST /api/quote_analytics

Create a new quote analytics record.

**Required Fields:**
- `SessionID` (string) - Session identifier
- `EventType` (string) - Type of event (e.g., "page_view", "add_to_cart", "price_check")

**Optional Fields:**
- `QuoteID` (string) - Quote identifier
- `StyleNumber` (string) - Product style number
- `Color` (string) - Product color
- `PrintLocation` (string) - Print location code
- `Quantity` (integer) - Quantity of items
- `HasLTM` (string) - Whether item has LTM ("Yes"/"No")
- `PriceShown` (number) - Price displayed to user
- `UserAgent` (string) - Browser user agent
- `IPAddress` (string) - User's IP address

**Example Request:**
```bash
POST /api/quote_analytics
Content-Type: application/json

{
  "SessionID": "sess123",
  "EventType": "add_to_cart",
  "StyleNumber": "PC61",
  "Color": "Red",
  "Quantity": 50,
  "PriceShown": 12.50
}
```

### PUT /api/quote_analytics/:id

Update an existing quote analytics record.

**Path Parameters:**
- `id` (integer, required) - The PK_ID of the record to update

**Example Request:**
```bash
PUT /api/quote_analytics/1
Content-Type: application/json

{
  "EventType": "updated_cart",
  "Quantity": 75
}
```

### DELETE /api/quote_analytics/:id

Delete a quote analytics record.

**Path Parameters:**
- `id` (integer, required) - The PK_ID of the record to delete

**Example Request:**
```bash
DELETE /api/quote_analytics/1
```

---

## Quote Items Endpoints

### GET /api/quote_items

Retrieve all quote items or filter by query parameters.

**Query Parameters:**
- `quoteID` (string, optional) - Filter by quote ID
- `styleNumber` (string, optional) - Filter by style number

**Example Request:**
```bash
GET /api/quote_items?quoteID=quote456
```

**Example Response:**
```json
[
  {
    "PK_ID": 1,
    "ItemID": 201,
    "QuoteID": "quote456",
    "LineNumber": 1,
    "StyleNumber": "PC61",
    "ProductName": "Port & Company Essential T-Shirt",
    "Color": "Red",
    "ColorCode": "RED",
    "EmbellishmentType": "DTG",
    "PrintLocation": "Front",
    "PrintLocationName": "Front Center",
    "Quantity": 50,
    "HasLTM": "Yes",
    "BaseUnitPrice": 10.00,
    "LTMPerUnit": 2.50,
    "FinalUnitPrice": 12.50,
    "LineTotal": 625.00,
    "SizeBreakdown": "{\"S\":10,\"M\":20,\"L\":15,\"XL\":5}",
    "PricingTier": "37-72",
    "ImageURL": "https://example.com/pc61-red.jpg",
    "AddedAt": "2025-01-01T12:00:00Z"
  }
]
```

### GET /api/quote_items/:id

Retrieve a specific quote item by PK_ID.

**Example Request:**
```bash
GET /api/quote_items/1
```

### POST /api/quote_items

Create a new quote item.

**Required Fields:**
- `QuoteID` (string) - Quote identifier
- `StyleNumber` (string) - Product style number
- `Quantity` (integer) - Quantity of items

**Optional Fields:**
- `LineNumber` (integer) - Line number in quote
- `ProductName` (string) - Product name
- `Color` (string) - Product color
- `ColorCode` (string) - Color code
- `EmbellishmentType` (string) - Type of decoration (DTG, ScreenPrint, etc.)
- `PrintLocation` (string) - Print location code
- `PrintLocationName` (string) - Print location display name
- `HasLTM` (string) - Whether item has LTM ("Yes"/"No")
- `BaseUnitPrice` (number) - Base price per unit
- `LTMPerUnit` (number) - LTM fee per unit
- `FinalUnitPrice` (number) - Final price per unit
- `LineTotal` (number) - Total for this line item
- `SizeBreakdown` (string) - JSON string of size breakdown
- `PricingTier` (string) - Pricing tier used
- `ImageURL` (string) - Product image URL

**Example Request:**
```bash
POST /api/quote_items
Content-Type: application/json

{
  "QuoteID": "quote456",
  "StyleNumber": "PC61",
  "ProductName": "Port & Company Essential T-Shirt",
  "Color": "Red",
  "EmbellishmentType": "DTG",
  "Quantity": 50,
  "BaseUnitPrice": 10.00,
  "LTMPerUnit": 2.50,
  "FinalUnitPrice": 12.50,
  "LineTotal": 625.00,
  "SizeBreakdown": "{\"S\":10,\"M\":20,\"L\":15,\"XL\":5}"
}
```

### PUT /api/quote_items/:id

Update an existing quote item.

**Example Request:**
```bash
PUT /api/quote_items/1
Content-Type: application/json

{
  "Quantity": 75,
  "FinalUnitPrice": 11.50,
  "LineTotal": 862.50
}
```

### DELETE /api/quote_items/:id

Delete a quote item.

**Example Request:**
```bash
DELETE /api/quote_items/1
```

---

## Quote Sessions Endpoints

### GET /api/quote_sessions

Retrieve all quote sessions or filter by query parameters.

**Query Parameters:**
- `quoteID` (string, optional) - Filter by quote ID
- `sessionID` (string, optional) - Filter by session ID
- `customerEmail` (string, optional) - Filter by customer email
- `status` (string, optional) - Filter by status

**Example Request:**
```bash
GET /api/quote_sessions?customerEmail=customer@example.com
```

**Example Response:**
```json
[
  {
    "PK_ID": 1,
    "QuoteID": "quote456",
    "SessionID": "sess123",
    "CustomerEmail": "customer@example.com",
    "CustomerName": "John Doe",
    "CompanyName": "ABC Company",
    "Phone": "555-1234",
    "TotalQuantity": 100,
    "SubtotalAmount": 1000.00,
    "LTMFeeTotal": 250.00,
    "TotalAmount": 1250.00,
    "Status": "Active",
    "CreatedAt": "2025-01-01T12:00:00Z",
    "UpdatedAt": "2025-01-01T13:00:00Z",
    "ExpiresAt": "2025-01-08T12:00:00Z",
    "Notes": "Customer requested rush delivery"
  }
]
```

### GET /api/quote_sessions/:id

Retrieve a specific quote session by PK_ID.

**Example Request:**
```bash
GET /api/quote_sessions/1
```

### POST /api/quote_sessions

Create a new quote session.

**Required Fields:**
- `QuoteID` (string) - Quote identifier
- `SessionID` (string) - Session identifier
- `Status` (string) - Session status

**Optional Fields:**
- `CustomerEmail` (string) - Customer email address
- `CustomerName` (string) - Customer name
- `CompanyName` (string) - Company name
- `Phone` (string) - Phone number
- `TotalQuantity` (integer) - Total quantity across all items
- `SubtotalAmount` (number) - Subtotal before fees
- `LTMFeeTotal` (number) - Total LTM fees
- `TotalAmount` (number) - Grand total
- `ExpiresAt` (string) - Expiration timestamp (ISO 8601)
- `Notes` (string) - Additional notes

**Example Request:**
```bash
POST /api/quote_sessions
Content-Type: application/json

{
  "QuoteID": "quote456",
  "SessionID": "sess123",
  "CustomerEmail": "customer@example.com",
  "CustomerName": "John Doe",
  "Status": "Active",
  "TotalAmount": 1250.00
}
```

### PUT /api/quote_sessions/:id

Update an existing quote session.

**Example Request:**
```bash
PUT /api/quote_sessions/1
Content-Type: application/json

{
  "Status": "Completed",
  "TotalAmount": 1500.00,
  "Notes": "Final pricing confirmed"
}
```

### DELETE /api/quote_sessions/:id

Delete a quote session.

**Example Request:**
```bash
DELETE /api/quote_sessions/1
```

---

## Data Models

### Quote Analytics Model
```typescript
interface QuoteAnalytics {
  PK_ID: number;              // Auto-generated primary key
  AnalyticsID: number;        // Analytics identifier
  SessionID: string;          // Session ID (required)
  QuoteID?: string;           // Quote ID
  EventType: string;          // Event type (required)
  StyleNumber?: string;       // Product style
  Color?: string;             // Product color
  PrintLocation?: string;     // Print location
  Quantity?: number;          // Quantity
  HasLTM?: string;           // "Yes" or "No"
  PriceShown?: number;       // Price displayed
  UserAgent?: string;        // Browser user agent
  IPAddress?: string;        // User IP address
  Timestamp: string;         // ISO 8601 timestamp
}
```

### Quote Item Model
```typescript
interface QuoteItem {
  PK_ID: number;              // Auto-generated primary key
  ItemID: number;             // Item identifier
  QuoteID: string;            // Quote ID (required)
  LineNumber?: number;        // Line number
  StyleNumber: string;        // Style number (required)
  ProductName?: string;       // Product name
  Color?: string;             // Color
  ColorCode?: string;         // Color code
  EmbellishmentType?: string; // Decoration type
  PrintLocation?: string;     // Print location code
  PrintLocationName?: string; // Print location name
  Quantity: number;           // Quantity (required)
  HasLTM?: string;           // "Yes" or "No"
  BaseUnitPrice?: number;    // Base price per unit
  LTMPerUnit?: number;       // LTM fee per unit
  FinalUnitPrice?: number;   // Final price per unit
  LineTotal?: number;        // Line total
  SizeBreakdown?: string;    // JSON size breakdown
  PricingTier?: string;      // Pricing tier
  ImageURL?: string;         // Product image URL
  AddedAt: string;           // ISO 8601 timestamp
}
```

### Quote Session Model
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
  CreatedAt: string;          // Created timestamp
  UpdatedAt: string;          // Updated timestamp
  ExpiresAt?: string;         // Expiration timestamp
  Notes?: string;             // Additional notes
}
```

---

## Error Responses

All endpoints return consistent error responses:

### 400 Bad Request
```json
{
  "error": "Missing required field: SessionID"
}
```

### 404 Not Found
```json
{
  "error": "Quote analytics record not found"
}
```

### 500 Internal Server Error
```json
{
  "error": "Failed to fetch quote analytics",
  "details": "Database connection error"
}
```

---

## Integration Examples

### JavaScript/Frontend Integration

```javascript
// Quote Analytics Service
class QuoteAnalyticsService {
  constructor(baseUrl = 'http://localhost:3000') {
    this.baseUrl = baseUrl;
  }

  // Track a quote event
  async trackEvent(sessionId, eventType, data = {}) {
    const payload = {
      SessionID: sessionId,
      EventType: eventType,
      ...data
    };

    const response = await fetch(`${this.baseUrl}/api/quote_analytics`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      throw new Error(`Failed to track event: ${response.statusText}`);
    }

    return response.json();
  }

  // Get analytics for a session
  async getSessionAnalytics(sessionId) {
    const response = await fetch(
      `${this.baseUrl}/api/quote_analytics?sessionID=${sessionId}`
    );

    if (!response.ok) {
      throw new Error(`Failed to fetch analytics: ${response.statusText}`);
    }

    return response.json();
  }
}

// Quote Items Service
class QuoteItemsService {
  constructor(baseUrl = 'http://localhost:3000') {
    this.baseUrl = baseUrl;
  }

  // Add item to quote
  async addItem(quoteId, item) {
    const payload = {
      QuoteID: quoteId,
      ...item
    };

    const response = await fetch(`${this.baseUrl}/api/quote_items`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      throw new Error(`Failed to add item: ${response.statusText}`);
    }

    return response.json();
  }

  // Get items for a quote
  async getQuoteItems(quoteId) {
    const response = await fetch(
      `${this.baseUrl}/api/quote_items?quoteID=${quoteId}`
    );

    if (!response.ok) {
      throw new Error(`Failed to fetch items: ${response.statusText}`);
    }

    return response.json();
  }

  // Update item
  async updateItem(itemId, updates) {
    const response = await fetch(`${this.baseUrl}/api/quote_items/${itemId}`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(updates)
    });

    if (!response.ok) {
      throw new Error(`Failed to update item: ${response.statusText}`);
    }

    return response.json();
  }

  // Delete item
  async deleteItem(itemId) {
    const response = await fetch(`${this.baseUrl}/api/quote_items/${itemId}`, {
      method: 'DELETE'
    });

    if (!response.ok) {
      throw new Error(`Failed to delete item: ${response.statusText}`);
    }
  }
}

// Quote Sessions Service
class QuoteSessionsService {
  constructor(baseUrl = 'http://localhost:3000') {
    this.baseUrl = baseUrl;
  }

  // Create new quote session
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

  // Update session
  async updateSession(sessionId, updates) {
    // First find the session by SessionID
    const sessions = await this.getSessionBySessionId(sessionId);
    if (!sessions || sessions.length === 0) {
      throw new Error('Session not found');
    }

    const pkId = sessions[0].PK_ID;
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

  // Get session by SessionID
  async getSessionBySessionId(sessionId) {
    const response = await fetch(
      `${this.baseUrl}/api/quote_sessions?sessionID=${sessionId}`
    );

    if (!response.ok) {
      throw new Error(`Failed to fetch session: ${response.statusText}`);
    }

    return response.json();
  }
}

// Usage Example
async function initializeQuote() {
  const analytics = new QuoteAnalyticsService();
  const items = new QuoteItemsService();
  const sessions = new QuoteSessionsService();

  const sessionId = `session-${Date.now()}`;
  const quoteId = `quote-${Date.now()}`;

  try {
    // Create quote session
    await sessions.createSession(quoteId, sessionId, {
      CustomerEmail: 'customer@example.com',
      CustomerName: 'John Doe'
    });

    // Track page view
    await analytics.trackEvent(sessionId, 'quote_started', {
      QuoteID: quoteId
    });

    // Add item to quote
    await items.addItem(quoteId, {
      StyleNumber: 'PC61',
      ProductName: 'Port & Company Essential T-Shirt',
      Color: 'Red',
      Quantity: 50,
      FinalUnitPrice: 12.50,
      LineTotal: 625.00
    });

    // Track item added
    await analytics.trackEvent(sessionId, 'item_added', {
      QuoteID: quoteId,
      StyleNumber: 'PC61',
      Color: 'Red',
      Quantity: 50,
      PriceShown: 12.50
    });

    console.log('Quote initialized successfully');
  } catch (error) {
    console.error('Error initializing quote:', error);
  }
}
```

### Node.js/Backend Integration

```javascript
const axios = require('axios');

class QuoteAPI {
  constructor(baseUrl = 'http://localhost:3000') {
    this.baseUrl = baseUrl;
    this.client = axios.create({
      baseURL: baseUrl,
      headers: {
        'Content-Type': 'application/json'
      }
    });
  }

  // Analytics methods
  async trackAnalytics(data) {
    try {
      const response = await this.client.post('/api/quote_analytics', data);
      return response.data;
    } catch (error) {
      throw new Error(`Analytics tracking failed: ${error.response?.data?.error || error.message}`);
    }
  }

  async getAnalytics(filters = {}) {
    try {
      const response = await this.client.get('/api/quote_analytics', { params: filters });
      return response.data;
    } catch (error) {
      throw new Error(`Failed to fetch analytics: ${error.response?.data?.error || error.message}`);
    }
  }

  // Quote items methods
  async addQuoteItem(data) {
    try {
      const response = await this.client.post('/api/quote_items', data);
      return response.data;
    } catch (error) {
      throw new Error(`Failed to add quote item: ${error.response?.data?.error || error.message}`);
    }
  }

  async getQuoteItems(filters = {}) {
    try {
      const response = await this.client.get('/api/quote_items', { params: filters });
      return response.data;
    } catch (error) {
      throw new Error(`Failed to fetch quote items: ${error.response?.data?.error || error.message}`);
    }
  }

  async updateQuoteItem(id, data) {
    try {
      const response = await this.client.put(`/api/quote_items/${id}`, data);
      return response.data;
    } catch (error) {
      throw new Error(`Failed to update quote item: ${error.response?.data?.error || error.message}`);
    }
  }

  async deleteQuoteItem(id) {
    try {
      await this.client.delete(`/api/quote_items/${id}`);
      return true;
    } catch (error) {
      throw new Error(`Failed to delete quote item: ${error.response?.data?.error || error.message}`);
    }
  }

  // Quote sessions methods
  async createQuoteSession(data) {
    try {
      const response = await this.client.post('/api/quote_sessions', data);
      return response.data;
    } catch (error) {
      throw new Error(`Failed to create quote session: ${error.response?.data?.error || error.message}`);
    }
  }

  async getQuoteSessions(filters = {}) {
    try {
      const response = await this.client.get('/api/quote_sessions', { params: filters });
      return response.data;
    } catch (error) {
      throw new Error(`Failed to fetch quote sessions: ${error.response?.data?.error || error.message}`);
    }
  }

  async updateQuoteSession(id, data) {
    try {
      const response = await this.client.put(`/api/quote_sessions/${id}`, data);
      return response.data;
    } catch (error) {
      throw new Error(`Failed to update quote session: ${error.response?.data?.error || error.message}`);
    }
  }
}

module.exports = QuoteAPI;
```

---

## Testing with cURL

### Create Analytics Record
```bash
curl -X POST https://caspio-pricing-proxy-ab30a049961a.herokuapp.com/api/quote_analytics \
  -H "Content-Type: application/json" \
  -d '{
    "SessionID": "test-session-123",
    "EventType": "page_view",
    "StyleNumber": "PC61",
    "Color": "Red",
    "Quantity": 50
  }'
```

### Create Quote Item
```bash
curl -X POST https://caspio-pricing-proxy-ab30a049961a.herokuapp.com/api/quote_items \
  -H "Content-Type: application/json" \
  -d '{
    "QuoteID": "quote-456",
    "StyleNumber": "PC61",
    "ProductName": "Essential T-Shirt",
    "Quantity": 50,
    "FinalUnitPrice": 12.50
  }'
```

### Create Quote Session
```bash
curl -X POST https://caspio-pricing-proxy-ab30a049961a.herokuapp.com/api/quote_sessions \
  -H "Content-Type: application/json" \
  -d '{
    "QuoteID": "quote-456",
    "SessionID": "test-session-123",
    "CustomerEmail": "test@example.com",
    "Status": "Active"
  }'
```

---

## Rate Limits and Best Practices

1. **Batch Operations**: When possible, batch multiple analytics events rather than sending individual requests
2. **Error Handling**: Always implement proper error handling and retry logic
3. **Data Validation**: Validate data on the client side before sending to the API
4. **Session Management**: Use consistent session IDs across related operations
5. **Async Operations**: Use async/await for better performance in JavaScript applications

---

## Support and Troubleshooting

### Common Issues

1. **404 Errors**: Check that the endpoint URL is correct and the record exists
2. **400 Errors**: Verify that required fields are included in the request
3. **500 Errors**: Check server logs for database connection or other backend issues

### Debug Mode

Add debug logging to your requests:

```javascript
// Enable request/response logging
const response = await fetch(url, options);
console.log('Request:', url, options);
console.log('Response:', response.status, await response.json());
```

For any additional questions or integration assistance, please refer to the server logs or contact the development team.
