# Quote System Implementation Guide

## API Base URL
```
https://caspio-pricing-proxy-ab30a049961a.herokuapp.com
```

## Overview
The quote system consists of two main components:
1. **Quote Sessions** - Tracks the overall quote and customer information
2. **Quote Items** - Individual products/items within a quote

## Complete Quote Workflow

### Step 1: Create a Quote Session
When a user starts building a quote, first create a session:

```javascript
// Create a new quote session
const createQuoteSession = async (customerData) => {
  const quoteID = `Q_${new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '')}`;
  
  const response = await fetch('https://caspio-pricing-proxy-ab30a049961a.herokuapp.com/api/quote_sessions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      QuoteID: quoteID,
      SessionID: customerData.sessionID || generateSessionID(),
      CustomerEmail: customerData.email,
      CustomerName: customerData.name,
      CompanyName: customerData.company,
      Status: 'Active',
      TotalItems: 0,
      SubtotalAmount: 0,
      TaxAmount: 0,
      TotalAmount: 0,
      Currency: 'USD',
      ValidUntil: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(), // 30 days
      Notes: customerData.notes || ''
    })
  });

  return await response.json();
};
```

### Step 2: Add Items to the Quote
For each product the customer wants to quote:

```javascript
// Add item to quote
const addQuoteItem = async (quoteID, productData) => {
  const response = await fetch('https://caspio-pricing-proxy-ab30a049961a.herokuapp.com/api/quote_items', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      QuoteID: quoteID,
      StyleNumber: productData.styleNumber,
      ProductName: productData.productName,
      Color: productData.color,
      ColorCode: productData.colorCode,
      EmbellishmentType: productData.embellishmentType, // 'dtg', 'screenprint', 'embroidery'
      PrintLocation: productData.printLocation, // 'FC', 'BC', 'LC', 'RC', etc.
      PrintLocationName: productData.printLocationName,
      Quantity: productData.quantity,
      HasLTM: productData.hasLTM ? 'Yes' : 'No',
      BaseUnitPrice: productData.baseUnitPrice,
      LTMPerUnit: productData.ltmPerUnit || 0,
      FinalUnitPrice: productData.finalUnitPrice,
      LineTotal: productData.lineTotal,
      SizeBreakdown: JSON.stringify(productData.sizeBreakdown), // {"S":5,"M":10,"L":8,"XL":2}
      PricingTier: productData.pricingTier, // e.g., "24-47"
      ImageURL: productData.imageURL
    })
  });

  return await response.json();
};
```

## Field Reference

### Quote Sessions Fields

| Field | Type | Description | Example |
|-------|------|-------------|---------|
| QuoteID | String | Unique quote identifier | "Q_20250124120000" |
| SessionID | String | Browser session ID | "sess_123abc" |
| CustomerEmail | String | Customer's email | "john@company.com" |
| CustomerName | String | Customer's full name | "John Smith" |
| CompanyName | String | Customer's company | "Smith Corp" |
| Status | String | Quote status | "Active", "Completed", "Expired" |
| TotalItems | Number | Count of items in quote | 3 |
| SubtotalAmount | Number | Total before tax | 299.99 |
| TaxAmount | Number | Calculated tax | 25.50 |
| TotalAmount | Number | Total with tax | 325.49 |
| Currency | String | Currency code | "USD" |
| ValidUntil | DateTime | Quote expiration | "2025-02-23T12:00:00Z" |
| Notes | String | Internal notes | "Rush order needed" |

### Quote Items Fields

| Field | Type | Description | Example |
|-------|------|-------------|---------|
| QuoteID | String | Links to quote session | "Q_20250124120000" |
| StyleNumber | String | Product style code | "PC61" |
| ProductName | String | Product description | "Port & Company Core Cotton Tee" |
| Color | String | Color name | "Navy" |
| ColorCode | String | Color code | "NAV" |
| EmbellishmentType | String | Decoration method | "dtg", "screenprint", "embroidery" |
| PrintLocation | String | Location code | "FC" (Front Center) |
| PrintLocationName | String | Location description | "Front Center" |
| Quantity | Number | Total quantity | 24 |
| HasLTM | String | Has Less Than Minimum | "Yes" or "No" |
| BaseUnitPrice | Number | Base price per unit | 12.50 |
| LTMPerUnit | Number | LTM charge per unit | 2.00 |
| FinalUnitPrice | Number | Final price per unit | 14.50 |
| LineTotal | Number | Total for this line | 348.00 |
| SizeBreakdown | JSON String | Sizes and quantities | "{\"S\":5,\"M\":10,\"L\":8,\"XL\":1}" |
| PricingTier | String | Quantity tier | "24-47" |
| ImageURL | String | Product image URL | "https://..." |

## CRUD Operations Examples

### READ Operations

```javascript
// Get all quote sessions (with filters)
const getQuoteSessions = async (filters = {}) => {
  const params = new URLSearchParams();
  if (filters.quoteID) params.append('quoteID', filters.quoteID);
  if (filters.sessionID) params.append('sessionID', filters.sessionID);
  if (filters.customerEmail) params.append('customerEmail', filters.customerEmail);
  
  const response = await fetch(`https://caspio-pricing-proxy-ab30a049961a.herokuapp.com/api/quote_sessions?${params}`);
  return await response.json();
};

// Get specific quote session
const getQuoteSession = async (id) => {
  const response = await fetch(`https://caspio-pricing-proxy-ab30a049961a.herokuapp.com/api/quote_sessions/${id}`);
  return await response.json();
};

// Get quote items for a specific quote
const getQuoteItems = async (quoteID) => {
  const response = await fetch(`https://caspio-pricing-proxy-ab30a049961a.herokuapp.com/api/quote_items?quoteID=${quoteID}`);
  return await response.json();
};
```

### UPDATE Operations

```javascript
// Update quote session (e.g., after adding items)
const updateQuoteSession = async (sessionId, updates) => {
  const response = await fetch(`https://caspio-pricing-proxy-ab30a049961a.herokuapp.com/api/quote_sessions/${sessionId}`, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(updates)
  });
  return await response.json();
};

// Update quote item (e.g., change quantity)
const updateQuoteItem = async (itemId, updates) => {
  const response = await fetch(`https://caspio-pricing-proxy-ab30a049961a.herokuapp.com/api/quote_items/${itemId}`, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(updates)
  });
  return await response.json();
};
```

### DELETE Operations

```javascript
// Delete quote item
const deleteQuoteItem = async (itemId) => {
  const response = await fetch(`https://caspio-pricing-proxy-ab30a049961a.herokuapp.com/api/quote_items/${itemId}`, {
    method: 'DELETE'
  });
  return response.ok;
};

// Delete entire quote session
const deleteQuoteSession = async (sessionId) => {
  const response = await fetch(`https://caspio-pricing-proxy-ab30a049961a.herokuapp.com/api/quote_sessions/${sessionId}`, {
    method: 'DELETE'
  });
  return response.ok;
};
```

## Complete Implementation Example

```javascript
// Complete quote creation flow
async function createCompleteQuote(customerInfo, items) {
  try {
    // 1. Create quote session
    const session = await createQuoteSession({
      email: customerInfo.email,
      name: customerInfo.name,
      company: customerInfo.company,
      sessionID: customerInfo.sessionID
    });

    const quoteID = session.data.QuoteID;
    let totalAmount = 0;
    let totalItems = 0;

    // 2. Add each item to the quote
    for (const item of items) {
      // Calculate pricing based on quantity and decoration
      const pricing = await calculateItemPricing(item);
      
      const quoteItem = await addQuoteItem(quoteID, {
        styleNumber: item.styleNumber,
        productName: item.productName,
        color: item.color,
        colorCode: item.colorCode,
        embellishmentType: item.embellishmentType,
        printLocation: item.printLocation,
        printLocationName: item.printLocationName,
        quantity: item.quantity,
        hasLTM: item.quantity < 12, // Example minimum
        baseUnitPrice: pricing.basePrice,
        ltmPerUnit: pricing.ltmCharge,
        finalUnitPrice: pricing.finalPrice,
        lineTotal: pricing.lineTotal,
        sizeBreakdown: item.sizeBreakdown,
        pricingTier: pricing.tier,
        imageURL: item.imageURL
      });

      totalAmount += pricing.lineTotal;
      totalItems++;
    }

    // 3. Update session totals
    const updatedSession = await updateQuoteSession(session.data.id, {
      TotalItems: totalItems,
      SubtotalAmount: totalAmount,
      TaxAmount: totalAmount * 0.08, // Example 8% tax
      TotalAmount: totalAmount * 1.08
    });

    return {
      success: true,
      quoteID: quoteID,
      sessionData: updatedSession.data
    };

  } catch (error) {
    console.error('Quote creation failed:', error);
    return {
      success: false,
      error: error.message
    };
  }
}

// Helper function to calculate pricing
async function calculateItemPricing(item) {
  // Fetch pricing from your pricing endpoints
  const pricingResponse = await fetch(`https://caspio-pricing-proxy-ab30a049961a.herokuapp.com/api/pricing-bundle?styleNumber=${item.styleNumber}&quantity=${item.quantity}&method=${item.embellishmentType}`);
  const pricingData = await pricingResponse.json();
  
  return {
    basePrice: pricingData.basePrice,
    ltmCharge: item.quantity < 12 ? 2.00 : 0,
    finalPrice: pricingData.basePrice + (item.quantity < 12 ? 2.00 : 0),
    lineTotal: (pricingData.basePrice + (item.quantity < 12 ? 2.00 : 0)) * item.quantity,
    tier: pricingData.tier
  };
}
```

## Best Practices

1. **Session Management**
   - Generate unique session IDs for each user
   - Store the session ID in localStorage or cookies
   - Use session IDs to retrieve quotes on return visits

2. **Quote ID Format**
   - Use timestamp-based IDs: `Q_YYYYMMDDHHMMSS`
   - This ensures uniqueness and sortability

3. **Error Handling**
   ```javascript
   try {
     const response = await fetch(url, options);
     if (!response.ok) {
       throw new Error(`HTTP error! status: ${response.status}`);
     }
     const data = await response.json();
     return { success: true, data };
   } catch (error) {
     return { success: false, error: error.message };
   }
   ```

4. **State Management**
   - Keep quote state in your frontend framework
   - Sync with backend on significant changes
   - Implement auto-save functionality

5. **Validation**
   - Validate quantities (minimum orders)
   - Check product availability
   - Verify pricing before submission

## Converting Quote to Order

When the customer approves a quote:

```javascript
async function convertQuoteToOrder(quoteID, paymentInfo) {
  // 1. Get the complete quote
  const quoteSessions = await getQuoteSessions({ quoteID });
  const quoteItems = await getQuoteItems(quoteID);
  
  // 2. Create order using the orders endpoint
  const orderResponse = await fetch('https://caspio-pricing-proxy-ab30a049961a.herokuapp.com/api/orders', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      CustomerID: quoteSessions.data[0].CustomerID,
      OrderNumber: `ORD-${Date.now()}`,
      SessionID: quoteSessions.data[0].SessionID,
      TotalAmount: quoteSessions.data[0].TotalAmount,
      OrderStatus: 'New',
      PaymentStatus: 'Pending',
      QuoteID: quoteID // Reference the original quote
    })
  });

  // 3. Update quote status
  await updateQuoteSession(quoteSessions.data[0].id, {
    Status: 'Converted',
    Notes: `Converted to order ${orderResponse.data.OrderNumber}`
  });

  return orderResponse.data;
}
```

## Quote Analytics

Track user interactions with quotes:

```javascript
// Track quote events
const trackQuoteEvent = async (eventData) => {
  await fetch('https://caspio-pricing-proxy-ab30a049961a.herokuapp.com/api/quote_analytics', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      SessionID: eventData.sessionID,
      QuoteID: eventData.quoteID,
      EventType: eventData.type, // 'view', 'edit', 'price_calculated', 'abandoned'
      StyleNumber: eventData.styleNumber,
      Color: eventData.color,
      PrintLocation: eventData.printLocation,
      Quantity: eventData.quantity,
      PriceShown: eventData.price
    })
  });
};
```

This completes the implementation guide for the quote system. The API endpoints are already available and ready to use at the provided base URL.