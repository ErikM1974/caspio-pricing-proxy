# Cart API Documentation

This document provides comprehensive documentation for the cart-related API endpoints in the Caspio Pricing Proxy application.

**Base URL:** `https://caspio-pricing-proxy-ab30a049961a.herokuapp.com`

## Table of Contents

1. [Cart Sessions](#cart-sessions)
2. [Cart Items](#cart-items)
3. [Cart Item Sizes](#cart-item-sizes)
4. [Orders](#orders)
5. [Customer Information](#customer-information)

---

## Cart Sessions

Endpoints for managing cart sessions.

### GET /api/cart-sessions

Retrieves all cart sessions or filters by query parameters.

**Query Parameters:**
- `sessionID` (optional): Filter by session ID
- `userID` (optional): Filter by user ID
- `isActive` (optional): Filter by active status

**Example Request:**
```
GET /api/cart-sessions?sessionID=test_session_001
```

**Example Response:**
```json
[
  {
    "PK_ID": 33,
    "SessionID": "test_session_001",
    "UserID": 101,
    "CreateDate": "2025-04-22T05:52:22",
    "LastActivity": "2025-04-22T05:52:43",
    "IPAddress": "192.168.1.100",
    "UserAgent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/96.0.4664.110",
    "IsActive": true
  }
]
```

### POST /api/cart-sessions

Creates a new cart session.

**Request Body:**
```json
{
  "SessionID": "test_session_001",
  "UserID": 101,
  "IPAddress": "192.168.1.100",
  "UserAgent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/96.0.4664.110",
  "IsActive": true
}
```

**Required Fields:**
- `SessionID`: Unique identifier for the session (string)

**Optional Fields:**
- `UserID`: User identifier (number)
- `IPAddress`: Client IP address (string)
- `UserAgent`: Client user agent (string)
- `IsActive`: Session active status (boolean)

**Note:** `CreateDate` and `LastActivity` are automatically managed by the system.

**Example Response:**
```json
{
  "message": "Cart session created successfully",
  "cartSession": { ... }
}
```

### PUT /api/cart-sessions/:id

Updates a cart session by ID.

**URL Parameters:**
- `id`: Session ID to update

**Request Body:**
```json
{
  "UserID": 202,
  "IPAddress": "192.168.1.202",
  "UserAgent": "Updated User Agent"
}
```

**Example Response:**
```json
{
  "message": "Cart session updated successfully",
  "cartSession": {
    "RecordsAffected": 1,
    "Result": []
  }
}
```

### DELETE /api/cart-sessions/:id

Deletes a cart session by ID.

**URL Parameters:**
- `id`: Session ID to delete

**Example Response:**
```json
{
  "message": "Cart session deleted successfully",
  "recordsAffected": 1
}
```

---

## Cart Items

Endpoints for managing cart items.

### GET /api/cart-items

Retrieves all cart items or filters by query parameters.

**Query Parameters:**
- `sessionID` (optional): Filter by session ID
- `productID` (optional): Filter by product ID
- `styleNumber` (optional): Filter by style number
- `color` (optional): Filter by color
- `cartStatus` (optional): Filter by cart status
- `orderID` (optional): Filter by order ID

**Example Request:**
```
GET /api/cart-items?sessionID=customer_session_123
```

**Example Response:**
```json
[
  {
    "PK_ID": 22,
    "CartItemID": 22,
    "SessionID": "customer_session_123",
    "ProductID": "PROD001",
    "StyleNumber": "ST001",
    "Color": "Navy",
    "ImprintType": "Screen Print",
    "DateAdded": "2025-04-22T05:29:41",
    "CartStatus": "Active",
    "OrderID": null
  }
]
```

### POST /api/cart-items

Creates a new cart item.

**Request Body:**
```json
{
  "SessionID": "customer_session_123",
  "ProductID": "PROD001",
  "StyleNumber": "ST001",
  "Color": "Navy",
  "ImprintType": "Screen Print",
  "CartStatus": "Active",
  "OrderID": null
}
```

**Required Fields:**
- `SessionID`: Session identifier (string)
- `ProductID`: Product identifier (string)
- `StyleNumber`: Style number (string)
- `Color`: Product color (string)

**Optional Fields:**
- `ImprintType`: Type of imprint (string)
- `CartStatus`: Status of the cart item (string, default: "Active")
- `OrderID`: Associated order ID (number, null if not ordered)

**Note:** `CartItemID`, `PK_ID`, and `DateAdded` are automatically managed by the system.

**Example Response:**
```json
{
  "message": "Cart item created successfully",
  "cartItem": { ... }
}
```

### PUT /api/cart-items/:id

Updates a cart item by ID.

**URL Parameters:**
- `id`: Cart item ID to update

**Request Body:**
```json
{
  "Color": "Royal Blue",
  "ImprintType": "Heat Transfer",
  "CartStatus": "Saved",
  "OrderID": 18
}
```

**Example Response:**
```json
{
  "message": "Cart item updated successfully",
  "cartItem": {
    "RecordsAffected": 1,
    "Result": []
  }
}
```

### DELETE /api/cart-items/:id

Deletes a cart item by ID.

**URL Parameters:**
- `id`: Cart item ID to delete

**Example Response:**
```json
{
  "message": "Cart item deleted successfully",
  "recordsAffected": 1
}
```

---

## Cart Item Sizes

Endpoints for managing cart item sizes.

### GET /api/cart-item-sizes

Retrieves all cart item sizes or filters by query parameters.

**Query Parameters:**
- `cartItemID` (optional): Filter by cart item ID
- `size` (optional): Filter by size

**Example Request:**
```
GET /api/cart-item-sizes?cartItemID=22
```

**Example Response:**
```json
[
  {
    "PK_ID": 30,
    "SizeItemID": 30,
    "CartItemID": 22,
    "Size": "XL",
    "Quantity": 5,
    "UnitPrice": 19.99
  },
  {
    "PK_ID": 31,
    "SizeItemID": 31,
    "CartItemID": 22,
    "Size": "L",
    "Quantity": 10,
    "UnitPrice": 18.99
  }
]
```

### POST /api/cart-item-sizes

Creates a new cart item size.

**Request Body:**
```json
{
  "CartItemID": 22,
  "Size": "XL",
  "Quantity": 5,
  "UnitPrice": 19.99
}
```

**Required Fields:**
- `CartItemID`: Cart item identifier (number)
- `Size`: Size identifier (string)
- `Quantity`: Quantity of items (number)

**Optional Fields:**
- `UnitPrice`: Price per unit (number)

**Note:** `SizeItemID` and `PK_ID` are automatically managed by the system.

**Example Response:**
```json
{
  "message": "Cart item size created successfully",
  "cartItemSize": { ... }
}
```

### PUT /api/cart-item-sizes/:id

Updates a cart item size by ID.

**URL Parameters:**
- `id`: Size item ID to update

**Request Body:**
```json
{
  "Size": "XXL",
  "Quantity": 8,
  "UnitPrice": 21.99
}
```

**Example Response:**
```json
{
  "message": "Cart item size updated successfully",
  "cartItemSize": {
    "RecordsAffected": 1,
    "Result": []
  }
}
```

### DELETE /api/cart-item-sizes/:id

Deletes a cart item size by ID.

**URL Parameters:**
- `id`: Size item ID to delete

**Example Response:**
```json
{
  "message": "Cart item size deleted successfully",
  "recordsAffected": 1
}
```

---

## Orders

Endpoints for managing orders.

### GET /api/orders

Retrieves all orders or filters by query parameters.

**Query Parameters:**
- `orderID` (optional): Filter by order ID
- `customerID` (optional): Filter by customer ID
- `orderStatus` (optional): Filter by order status
- `paymentStatus` (optional): Filter by payment status
- `imprintType` (optional): Filter by imprint type

**Example Request:**
```
GET /api/orders?customerID=101
```

**Example Response:**
```json
[
  {
    "PK_ID": 1,
    "OrderID": 1,
    "CustomerID": 101,
    "OrderNumber": "ORD-12345",
    "SessionID": "session_123",
    "OrderDate": "2025-04-22T05:00:00",
    "TotalAmount": 199.99,
    "OrderStatus": "New",
    "ImprintType": "Screen Print",
    "PaymentMethod": "Credit Card",
    "PaymentStatus": "Paid",
    "ShippingMethod": "Ground",
    "TrackingNumber": null,
    "EstimatedDelivery": "2025-04-29T00:00:00",
    "Notes": "Rush order",
    "InternalNotes": "Approved by manager"
  }
]
```

### POST /api/orders

Creates a new order.

**Request Body:**
```json
{
  "CustomerID": 101,
  "OrderNumber": "ORD-12345",
  "SessionID": "session_123",
  "TotalAmount": 199.99,
  "OrderStatus": "New",
  "ImprintType": "Screen Print",
  "PaymentMethod": "Credit Card",
  "PaymentStatus": "Pending",
  "ShippingMethod": "Ground",
  "Notes": "Rush order",
  "InternalNotes": "Approved by manager"
}
```

**Required Fields:**
- `CustomerID`: Customer identifier (number)

**Optional Fields:**
- `OrderNumber`: Order number (string, default: auto-generated)
- `SessionID`: Associated session ID (string)
- `TotalAmount`: Total order amount (number)
- `OrderStatus`: Status of the order (string, default: "New")
- `ImprintType`: Type of imprint (string)
- `PaymentMethod`: Method of payment (string)
- `PaymentStatus`: Status of payment (string, default: "Pending")
- `ShippingMethod`: Method of shipping (string)
- `TrackingNumber`: Shipping tracking number (string)
- `EstimatedDelivery`: Estimated delivery date (date string)
- `Notes`: Customer-visible notes (string)
- `InternalNotes`: Internal notes (string)

**Note:** 
- `OrderID` and `PK_ID` are automatically managed by the system.
- `OrderDate` is automatically set to the current date/time.
- Do NOT include `OrderDate` in the request body.

**Example Response:**
```json
{
  "message": "Order created successfully",
  "order": { ... }
}
```

### PUT /api/orders/:id

Updates an order by ID.

**URL Parameters:**
- `id`: Order ID to update

**Request Body:**
```json
{
  "OrderStatus": "Processing",
  "PaymentStatus": "Paid",
  "TrackingNumber": "1Z999AA10123456784",
  "Notes": "Updated notes"
}
```

**Note:**
- Avoid updating `OrderID`, `CustomerID`, `OrderNumber`, and `OrderDate` fields.
- Only include fields that need to be updated.

**Example Response:**
```json
{
  "message": "Order updated successfully",
  "order": {
    "RecordsAffected": 1,
    "Result": []
  }
}
```

### DELETE /api/orders/:id

Deletes an order by ID.

**URL Parameters:**
- `id`: Order ID to delete

**Example Response:**
```json
{
  "message": "Order deleted successfully",
  "recordsAffected": 1
}
```

---

## Customer Information

Endpoints for managing customer information.

### GET /api/customers

Retrieves all customers or filters by query parameters.

**Query Parameters:**
- `name` (optional): Filter by customer name
- `email` (optional): Filter by email
- `company` (optional): Filter by company name
- `customerID` (optional): Filter by customer ID

**Example Request:**
```
GET /api/customers?email=john@example.com
```

**Example Response:**
```json
[
  {
    "PK_ID": 1,
    "CustomerID": 101,
    "Name": "John Doe",
    "Email": "john@example.com",
    "Phone": "555-123-4567",
    "Company": "Acme Inc",
    "Address1": "123 Main St",
    "Address2": "Suite 100",
    "City": "Anytown",
    "State": "CA",
    "Zip": "12345",
    "Country": "USA",
    "CustomerType": "Business",
    "Notes": "Preferred customer"
  }
]
```

### POST /api/customers

Creates a new customer.

**Request Body:**
```json
{
  "Name": "John Doe",
  "Email": "john@example.com",
  "Phone": "555-123-4567",
  "Company": "Acme Inc",
  "Address1": "123 Main St",
  "Address2": "Suite 100",
  "City": "Anytown",
  "State": "CA",
  "Zip": "12345",
  "Country": "USA",
  "CustomerType": "Business",
  "Notes": "Preferred customer"
}
```

**Required Fields:**
- `Name`: Customer name (string)
- `Email`: Customer email (string)

**Optional Fields:**
- `Phone`: Phone number (string)
- `Company`: Company name (string)
- `Address1`: Address line 1 (string)
- `Address2`: Address line 2 (string)
- `City`: City (string)
- `State`: State/province (string)
- `Zip`: Postal code (string)
- `Country`: Country (string)
- `CustomerType`: Type of customer (string)
- `Notes`: Additional notes (string)

**Note:** `CustomerID` and `PK_ID` are automatically managed by the system.

**Example Response:**
```json
{
  "message": "Customer created successfully",
  "customer": { ... }
}
```

### PUT /api/customers/:id

Updates a customer by ID.

**URL Parameters:**
- `id`: Customer ID to update

**Request Body:**
```json
{
  "Phone": "555-987-6543",
  "Address1": "456 Oak St",
  "City": "New City",
  "Notes": "Updated notes"
}
```

**Example Response:**
```json
{
  "message": "Customer updated successfully",
  "customer": {
    "RecordsAffected": 1,
    "Result": []
  }
}
```

### DELETE /api/customers/:id

Deletes a customer by ID.

**URL Parameters:**
- `id`: Customer ID to delete

**Example Response:**
```json
{
  "message": "Customer deleted successfully"
}
```

---

## Additional Notes

### Error Handling

All endpoints return appropriate HTTP status codes:

- `200 OK`: Request successful
- `201 Created`: Resource created successfully
- `400 Bad Request`: Invalid request parameters or body
- `404 Not Found`: Resource not found
- `500 Internal Server Error`: Server-side error

Error responses include a JSON object with an error message:

```json
{
  "error": "Error message details"
}
```

### Authentication

These endpoints do not currently require authentication. However, they are intended for internal use and should be secured in a production environment.

### Data Relationships

- A `Cart Session` can have multiple `Cart Items`
- A `Cart Item` can have multiple `Cart Item Sizes`
- An `Order` is associated with a `Customer` and optionally with a `Cart Session`
- When an order is placed, `Cart Items` can be associated with an `Order` via the `OrderID` field

### Recent Updates

- Fixed Cart_Sessions API endpoints to use SessionID instead of PK_ID in where clause for PUT and DELETE operations
- Improved error handling and validation for all endpoints
- Added comprehensive documentation for all cart-related endpoints