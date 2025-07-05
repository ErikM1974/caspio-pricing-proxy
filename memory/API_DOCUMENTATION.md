# API Documentation

This document provides a comprehensive overview of the Caspio Pricing Proxy API. It includes detailed information about each endpoint, its functionality, and how to interact with it.

## API Status

Most endpoints (51 out of 59) are fully operational. The following features have limited or no availability:

- Status/Test endpoints (`/status`, `/test`) are not implemented
- Transfer pricing endpoints (`/transfers/*`) are currently under development
- Some inventory queries may return 404 if no matching products are found


## Base URL

The base URL for all API endpoints is: `https://caspio-pricing-proxy-ab30a049961a.herokuapp.com/api`

---

## Cart API

The Cart API provides functionality for managing shopping carts, including cart sessions, cart items, and item sizes.

### Cart Sessions

#### GET /cart-sessions

-   **Description**: Retrieves a list of cart sessions. Can be filtered by `sessionID`, `userID`, or `isActive` status.
-   **Method**: `GET`
-   **URL**: `/cart-sessions`
-   **Query Parameters**:
    -   `sessionID` (string, optional): The unique identifier for the cart session.
    -   `userID` (integer, optional): The ID of the user associated with the cart session.
    -   `isActive` (boolean, optional): The status of the cart session.
-   **Example `curl` Request**:
    ```bash
    curl "https://caspio-pricing-proxy-ab30a049961a.herokuapp.com/api/cart-sessions?sessionID=some-session-id"
    ```

#### POST /cart-sessions

-   **Description**: Creates a new cart session.
-   **Method**: `POST`
-   **URL**: `/cart-sessions`
-   **Request Body**:
    ```json
    {
      "SessionID": "string",
      "UserID": "integer (optional)",
      "IPAddress": "string (optional)",
      "UserAgent": "string (optional)",
      "IsActive": "boolean (optional)"
    }
    ```
-   **Example `curl` Request**:
    ```bash
    curl -X POST -H "Content-Type: application/json" -d '{"SessionID": "new-session-id"}' "https://caspio-pricing-proxy-ab30a049961a.herokuapp.com/api/cart-sessions"
    ```

#### PUT /cart-sessions/:id

-   **Description**: Updates an existing cart session.
-   **Method**: `PUT`
-   **URL**: `/cart-sessions/:id`
-   **Request Body**:
    ```json
    {
      "SessionID": "string (optional)",
      "UserID": "integer (optional)",
      "LastActivity": "string (optional)",
      "IPAddress": "string (optional)",
      "UserAgent": "string (optional)",
      "IsActive": "boolean (optional)"
    }
    ```
-   **Example `curl` Request**:
    ```bash
    curl -X PUT -H "Content-Type: application/json" -d '{"IsActive": false}' "https://caspio-pricing-proxy-ab30a049961a.herokuapp.com/api/cart-sessions/some-session-id"
    ```

#### DELETE /cart-sessions/:id

-   **Description**: Deletes a cart session.
-   **Method**: `DELETE`
-   **URL**: `/cart-sessions/:id`
-   **Example `curl` Request**:
    ```bash
    curl -X DELETE "https://caspio-pricing-proxy-ab30a049961a.herokuapp.com/api/cart-sessions/some-session-id"
    ```

### Cart Items

#### GET /cart-items

-   **Description**: Retrieves a list of cart items. Can be filtered by `sessionID`, `productID`, `styleNumber`, `color`, `cartStatus`, or `orderID`.
-   **Method**: `GET`
-   **URL**: `/cart-items`
-   **Example `curl` Request**:
    ```bash
    curl "https://caspio-pricing-proxy-ab30a049961a.herokuapp.com/api/cart-items?sessionID=some-session-id"
    ```

#### POST /cart-items

-   **Description**: Creates a new cart item.
-   **Method**: `POST`
-   **URL**: `/cart-items`
-   **Request Body**:
    ```json
    {
      "SessionID": "string",
      "ProductID": "string",
      "StyleNumber": "string",
      "Color": "string",
      "PRODUCT_TITLE": "string (optional)",
      "ImprintType": "string (optional)",
      "CartStatus": "string (optional)",
      "OrderID": "integer (optional)",
      "imageUrl": "string (optional)"
    }
    ```
-   **Example `curl` Request**:
    ```bash
    curl -X POST -H "Content-Type: application/json" -d '{"SessionID": "some-session-id", "ProductID": "123", "StyleNumber": "ABC", "Color": "Blue"}' "https://caspio-pricing-proxy-ab30a049961a.herokuapp.com/api/cart-items"
    ```

#### PUT /cart-items/:id

-   **Description**: Updates an existing cart item.
-   **Method**: `PUT`
-   **URL**: `/cart-items/:id`
-   **Request Body**:
    ```json
    {
      "SessionID": "string (optional)",
      "ProductID": "string (optional)",
      "StyleNumber": "string (optional)",
      "Color": "string (optional)",
      "PRODUCT_TITLE": "string (optional)",
      "ImprintType": "string (optional)",
      "CartStatus": "string (optional)",
      "OrderID": "integer (optional)",
      "imageUrl": "string (optional)"
    }
    ```
-   **Example `curl` Request**:
    ```bash
    curl -X PUT -H "Content-Type: application/json" -d '{"CartStatus": "Saved"}' "https://caspio-pricing-proxy-ab30a049961a.herokuapp.com/api/cart-items/1"
    ```

#### DELETE /cart-items/:id

-   **Description**: Deletes a cart item.
-   **Method**: `DELETE`
-   **URL**: `/cart-items/:id`
-   **Example `curl` Request**:
    ```bash
    curl -X DELETE "https://caspio-pricing-proxy-ab30a049961a.herokuapp.com/api/cart-items/1"
    ```

### Cart Item Sizes

#### GET /cart-item-sizes

-   **Description**: Retrieves a list of cart item sizes. Can be filtered by `cartItemID` or `size`.
-   **Method**: `GET`
-   **URL**: `/cart-item-sizes`
-   **Example `curl` Request**:
    ```bash
    curl "https://caspio-pricing-proxy-ab30a049961a.herokuapp.com/api/cart-item-sizes?cartItemID=1"
    ```

#### POST /cart-item-sizes

-   **Description**: Creates a new cart item size.
-   **Method**: `POST`
-   **URL**: `/cart-item-sizes`
-   **Request Body**:
    ```json
    {
      "CartItemID": "integer",
      "Size": "string",
      "Quantity": "integer",
      "UnitPrice": "number (optional)"
    }
    ```
-   **Example `curl` Request**:
    ```bash
    curl -X POST -H "Content-Type: application/json" -d '{"CartItemID": 1, "Size": "L", "Quantity": 2}' "https://caspio-pricing-proxy-ab30a049961a.herokuapp.com/api/cart-item-sizes"
    ```

#### PUT /cart-item-sizes/:id

-   **Description**: Updates an existing cart item size.
-   **Method**: `PUT`
-   **URL**: `/cart-item-sizes/:id`
-   **Request Body**:
    ```json
    {
      "CartItemID": "integer (optional)",
      "Size": "string (optional)",
      "Quantity": "integer (optional)",
      "UnitPrice": "number (optional)"
    }
    ```
-   **Example `curl` Request**:
    ```bash
    curl -X PUT -H "Content-Type: application/json" -d '{"Quantity": 3}' "https://caspio-pricing-proxy-ab30a049961a.herokuapp.com/api/cart-item-sizes/1"
    ```

#### DELETE /cart-item-sizes/:id

-   **Description**: Deletes a cart item size.
-   **Method**: `DELETE`
-   **URL**: `/cart-item-sizes/:id`
-   **Example `curl` Request**:
    ```bash
    curl -X DELETE "https://caspio-pricing-proxy-ab30a049961a.herokuapp.com/api/cart-item-sizes/1"
    ```

---

## Pricing API

The Pricing API provides functionality for retrieving pricing information.

#### GET /pricing-tiers

-   **Description**: Retrieves a list of pricing tiers for a given decoration method.
-   **Method**: `GET`
-   **URL**: `/pricing-tiers`
-   **Query Parameters**:
    -   `method` (string, required): The decoration method. Can be `DTG`, `ScreenPrint`, `Embroidery`, or `EmbroideryShirts`.
-   **Example `curl` Request**:
    ```bash
    curl "https://caspio-pricing-proxy-ab30a049961a.herokuapp.com/api/pricing-tiers?method=DTG"
    ```

#### GET /embroidery-costs

-   **Description**: Retrieves the cost of embroidery for a given item type and stitch count.
-   **Method**: `GET`
-   **URL**: `/embroidery-costs`
-   **Query Parameters**:
    -   `itemType` (string, required): The type of item being embroidered.
    -   `stitchCount` (integer, required): The number of stitches.
-   **Example `curl` Request**:
    ```bash
    curl "https://caspio-pricing-proxy-ab30a049961a.herokuapp.com/api/embroidery-costs?itemType=Shirt&stitchCount=5000"
    ```

#### GET /dtg-costs

-   **Description**: Retrieves a list of all DTG costs.
-   **Method**: `GET`
-   **URL**: `/dtg-costs`
-   **Example `curl` Request**:
    ```bash
    curl "https://caspio-pricing-proxy-ab30a049961a.herokuapp.com/api/dtg-costs"
    ```

#### GET /screenprint-costs

-   **Description**: Retrieves a list of all screenprint costs for a given location type.
-   **Method**: `GET`
-   **URL**: `/screenprint-costs`
-   **Query Parameters**:
    -   `costType` (string, required): The type of location. Can be `PrimaryLocation` or `AdditionalLocation`.
-   **Example `curl` Request**:
    ```bash
    curl "https://caspio-pricing-proxy-ab30a049961a.herokuapp.com/api/screenprint-costs?costType=PrimaryLocation"
    ```

#### GET /pricing-rules

-   **Description**: Retrieves a list of all pricing rules for a given decoration method.
-   **Method**: `GET`
-   **URL**: `/pricing-rules`
-   **Query Parameters**:
    -   `method` (string, required): The decoration method.
-   **Example `curl` Request**:
    ```bash
    curl "https://caspio-pricing-proxy-ab30a049961a.herokuapp.com/api/pricing-rules?method=DTG"
    ```

#### GET /base-item-costs

-   **Description**: Retrieves the base cost for each size of a given style.
-   **Method**: `GET`
-   **URL**: `/base-item-costs`
-   **Query Parameters**:
    -   `styleNumber` (string, required): The style number of the item.
-   **Example `curl` Request**:
    ```bash
    curl "https://caspio-pricing-proxy-ab30a049961a.herokuapp.com/api/base-item-costs?styleNumber=PC61"
    ```

#### GET /size-pricing

-   **Description**: Retrieves the pricing for each size of a given style and color.
-   **Method**: `GET`
-   **URL**: `/size-pricing`
-   **Query Parameters**:
    -   `styleNumber` (string, required): The style number of the item.
    -   `color` (string, optional): The color of the item.
-   **Example `curl` Request**:
    ```bash
    curl "https://caspio-pricing-proxy-ab30a049961a.herokuapp.com/api/size-pricing?styleNumber=PC61&color=Ash"
    ```

#### GET /max-prices-by-style

-   **Description**: Retrieves the maximum price for each size of a given style.
-   **Method**: `GET`
-   **URL**: `/max-prices-by-style`
-   **Query Parameters**:
    -   `styleNumber` (string, required): The style number of the item.
-   **Example `curl` Request**:
    ```bash
    curl "https://caspio-pricing-proxy-ab30a049961a.herokuapp.com/api/max-prices-by-style?styleNumber=PC61"
    ```

#### GET /pricing-bundle

-   **Description**: Retrieves a bundle of pricing information for a given decoration method and style.
-   **Method**: `GET`
-   **URL**: `/pricing-bundle`
-   **Query Parameters**:
    -   `method` (string, required): The decoration method.
    -   `styleNumber` (string, optional): The style number of the item.
-   **Example `curl` Request**:
    ```bash
    curl "https://caspio-pricing-proxy-ab30a049961a.herokuapp.com/api/pricing-bundle?method=DTG&styleNumber=PC61"
    ```
---

## Product API

The Product API provides functionality for searching and retrieving product information.

#### GET /stylesearch

-   **Description**: Retrieves a list of style suggestions based on a search term.
-   **Method**: `GET`
-   **URL**: `/stylesearch`
-   **Query Parameters**:
    -   `term` (string, required): The search term. Must be at least 2 characters.
-   **Example `curl` Request**:
    ```bash
    curl "https://caspio-pricing-proxy-ab30a049961a.herokuapp.com/api/stylesearch?term=PC61"
    ```

#### GET /product-details

-   **Description**: Retrieves the details for a given style and color.
-   **Method**: `GET`
-   **URL**: `/product-details`
-   **Query Parameters**:
    -   `styleNumber` (string, required): The style number of the product.
    -   `color` (string, optional): The color of the product.
-   **Example `curl` Request**:
    ```bash
    curl "https://caspio-pricing-proxy-ab30a049961a.herokuapp.com/api/product-details?styleNumber=PC61&color=Ash"
    ```

#### GET /color-swatches

-   **Description**: Retrieves a list of color swatches for a given style.
-   **Method**: `GET`
-   **URL**: `/color-swatches`
-   **Query Parameters**:
    -   `styleNumber` (string, required): The style number of the product.
-   **Example `curl` Request**:
    ```bash
    curl "https://caspio-pricing-proxy-ab30a049961a.herokuapp.com/api/color-swatches?styleNumber=PC61"
    ```

#### GET /products-by-brand

-   **Description**: Retrieves a list of products for a given brand.
-   **Method**: `GET`
-   **URL**: `/products-by-brand`
-   **Query Parameters**:
    -   `brand` (string, required): The brand name.
-   **Example `curl` Request**:
    ```bash
    curl "https://caspio-pricing-proxy-ab30a049961a.herokuapp.com/api/products-by-brand?brand=Port%20&%20Company"
    ```

#### GET /products-by-category

-   **Description**: Retrieves a list of products for a given category.
-   **Method**: `GET`
-   **URL**: `/products-by-category`
-   **Query Parameters**:
    -   `category` (string, required): The category name.
-   **Example `curl` Request**:
    ```bash
    curl "https://caspio-pricing-proxy-ab30a049961a.herokuapp.com/api/products-by-category?category=T-Shirts"
    ```

#### GET /products-by-subcategory

-   **Description**: Retrieves a list of products for a given subcategory.
-   **Method**: `GET`
-   **URL**: `/products-by-subcategory`
-   **Query Parameters**:
    -   `subcategory` (string, required): The subcategory name.
-   **Example `curl` Request**:
    ```bash
    curl "https://caspio-pricing-proxy-ab30a049961a.herokuapp.com/api/products-by-subcategory?subcategory=T-Shirts"
    ```

#### GET /all-brands

-   **Description**: Retrieves a list of all brands.
-   **Method**: `GET`
-   **URL**: `/all-brands`
-   **Example `curl` Request**:
    ```bash
    curl "https://caspio-pricing-proxy-ab30a049961a.herokuapp.com/api/all-brands"
    ```

#### GET /all-categories

-   **Description**: Retrieves a list of all categories.
-   **Method**: `GET`
-   **URL**: `/all-categories`
-   **Example `curl` Request**:
    ```bash
    curl "https://caspio-pricing-proxy-ab30a049961a.herokuapp.com/api/all-categories"
    ```

#### GET /all-subcategories

-   **Description**: Retrieves a list of all subcategories.
-   **Method**: `GET`
-   **URL**: `/all-subcategories`
-   **Example `curl` Request**:
    ```bash
    curl "https://caspio-pricing-proxy-ab30a049961a.herokuapp.com/api/all-subcategories"
    ```

#### GET /search

-   **Description**: Retrieves a list of products based on a search query.
-   **Method**: `GET`
-   **URL**: `/search`
-   **Query Parameters**:
    -   `q` (string, required): The search query. Must be at least 2 characters.
-   **Example `curl` Request**:
    ```bash
    curl "https://caspio-pricing-proxy-ab30a049961a.herokuapp.com/api/search?q=shirt"
    ```

#### GET /featured-products

-   **Description**: Retrieves a list of featured products.
-   **Method**: `GET`
-   **URL**: `/featured-products`
-   **Example `curl` Request**:
    ```bash
    curl "https://caspio-pricing-proxy-ab30a049961a.herokuapp.com/api/featured-products"
    ```

#### GET /product-colors

-   **Description**: Retrieves a list of colors for a given style.
-   **Method**: `GET`
-   **URL**: `/product-colors`
-   **Query Parameters**:
    -   `styleNumber` (string, required): The style number of the product.
-   **Example `curl` Request**:
    ```bash
    curl "https://caspio-pricing-proxy-ab30a049961a.herokuapp.com/api/product-colors?styleNumber=PC61"
    ```

---

## Order API

The Order API provides functionality for managing orders and customers.

### Orders

#### GET /orders

-   **Description**: Retrieves a list of orders. Can be filtered by `orderID`, `customerID`, `orderStatus`, `paymentStatus`, or `imprintType`.
-   **Method**: `GET`
-   **URL**: `/orders`
-   **Example `curl` Request**:
    ```bash
    curl "https://caspio-pricing-proxy-ab30a049961a.herokuapp.com/api/orders?customerID=1"
    ```

#### POST /orders

-   **Description**: Creates a new order.
-   **Method**: `POST`
-   **URL**: `/orders`
-   **Request Body**:
    ```json
    {
      "CustomerID": "integer",
      "OrderNumber": "string (optional)",
      "SessionID": "string (optional)",
      "TotalAmount": "number (optional)",
      "OrderStatus": "string (optional)",
      "ImprintType": "string (optional)",
      "PaymentMethod": "string (optional)",
      "PaymentStatus": "string (optional)",
      "ShippingMethod": "string (optional)",
      "TrackingNumber": "string (optional)",
      "EstimatedDelivery": "string (optional)",
      "Notes": "string (optional)",
      "InternalNotes": "string (optional)"
    }
    ```
-   **Example `curl` Request**:
    ```bash
    curl -X POST -H "Content-Type: application/json" -d '{"CustomerID": 1}' "https://caspio-pricing-proxy-ab30a049961a.herokuapp.com/api/orders"
    ```

#### PUT /orders/:id

-   **Description**: Updates an existing order.
-   **Method**: `PUT`
-   **URL**: `/orders/:id`
-   **Request Body**:
    ```json
    {
      "TotalAmount": "number (optional)",
      "OrderStatus": "string (optional)",
      "ImprintType": "string (optional)",
      "PaymentMethod": "string (optional)",
      "PaymentStatus": "string (optional)",
      "ShippingMethod": "string (optional)",
      "TrackingNumber": "string (optional)",
      "EstimatedDelivery": "string (optional)",
      "Notes": "string (optional)",
      "InternalNotes": "string (optional)"
    }
    ```
-   **Example `curl` Request**:
    ```bash
    curl -X PUT -H "Content-Type: application/json" -d '{"OrderStatus": "Shipped"}' "https://caspio-pricing-proxy-ab30a049961a.herokuapp.com/api/orders/1"
    ```

#### DELETE /orders/:id

-   **Description**: Deletes an order.
-   **Method**: `DELETE`
-   **URL**: `/orders/:id`
-   **Example `curl` Request**:
    ```bash
    curl -X DELETE "https://caspio-pricing-proxy-ab30a049961a.herokuapp.com/api/orders/1"
    ```

### Customers

#### GET /customers

-   **Description**: Retrieves a list of customers. Can be filtered by `name`, `email`, `company`, or `customerID`.
-   **Method**: `GET`
-   **URL**: `/customers`
-   **Example `curl` Request**:
    ```bash
    curl "https://caspio-pricing-proxy-ab30a049961a.herokuapp.com/api/customers?email=test@test.com"
    ```

#### POST /customers

-   **Description**: Creates a new customer.
-   **Method**: `POST`
-   **URL**: `/customers`
-   **Request Body**:
    ```json
    {
      "Name": "string",
      "Email": "string",
      "FirstName": "string (optional)",
      "LastName": "string (optional)"
    }
    ```
-   **Example `curl` Request**:
    ```bash
    curl -X POST -H "Content-Type: application/json" -d '{"Name": "John Doe", "Email": "johndoe@example.com"}' "https://caspio-pricing-proxy-ab30a049961a.herokuapp.com/api/customers"
    ```

#### PUT /customers/:id

-   **Description**: Updates an existing customer.
-   **Method**: `PUT`
-   **URL**: `/customers/:id`
-   **Request Body**:
    ```json
    {
      "Name": "string (optional)",
      "Email": "string (optional)"
    }
    ```
-   **Example `curl` Request**:
    ```bash
    curl -X PUT -H "Content-Type: application/json" -d '{"Email": "newemail@example.com"}' "https://caspio-pricing-proxy-ab30a049961a.herokuapp.com/api/customers/1"
    ```

#### DELETE /customers/:id

-   **Description**: Deletes a customer.
-   **Method**: `DELETE`
-   **URL**: `/customers/:id`
-   **Example `curl` Request**:
    ```bash
    curl -X DELETE "https://caspio-pricing-proxy-ab30a049961a.herokuapp.com/api/customers/1"
    ```

### Order ODBC

#### GET /order-odbc

-   **Description**: Retrieves order records from the ORDER_ODBC table. Supports filtering, sorting, and pagination.
-   **Method**: `GET`
-   **URL**: `/order-odbc`
-   **Query Parameters**:
    -   `q.where` (string, optional): Filter records using SQL-like conditions (e.g., `id_Customer=11824`, `date_OrderPlaced>'2021-03-01'`, `sts_Shipped=0`)
    -   `q.orderBy` (string, optional): Sort results by field(s) (e.g., `date_OrderPlaced DESC`, `ID_Order ASC`)
    -   `q.limit` (integer, optional): Maximum number of records to return (default: 100, max: 1000)
-   **Example `curl` Requests**:
    ```bash
    # Get all orders (limited to 100)
    curl "https://caspio-pricing-proxy-ab30a049961a.herokuapp.com/api/order-odbc"
    
    # Get orders for specific customer
    curl "https://caspio-pricing-proxy-ab30a049961a.herokuapp.com/api/order-odbc?q.where=id_Customer=11824"
    
    # Get unshipped orders
    curl "https://caspio-pricing-proxy-ab30a049961a.herokuapp.com/api/order-odbc?q.where=sts_Shipped=0&q.limit=50"
    
    # Get orders in date range, sorted
    curl "https://caspio-pricing-proxy-ab30a049961a.herokuapp.com/api/order-odbc?q.where=date_OrderPlaced>'2021-03-01' AND date_OrderPlaced<'2021-03-31'&q.orderBy=date_OrderPlaced DESC"
    
    # Get invoiced but not shipped orders
    curl "https://caspio-pricing-proxy-ab30a049961a.herokuapp.com/api/order-odbc?q.where=sts_Invoiced=1 AND sts_Shipped=0"
    ```
-   **Response**: Returns an array of order records from the ORDER_ODBC table
-   **Common Fields**:
    -   `PK_ID`: Primary key
    -   `ID_Order`: Order ID
    -   `date_OrderPlaced`: Order placement date
    -   `date_OrderRequestedToShip`: Requested ship date
    -   `id_Customer`: Customer ID
    -   `CompanyName`: Company name
    -   `ContactEmail`, `ContactFirst`, `ContactLast`: Contact information
    -   `sts_Invoiced`, `sts_Shipped`: Order status flags (0 or 1)
    -   `cur_Subtotal`, `cnCur_TotalInvoice`: Order amounts
    -   `ORDER_TYPE`: Type of order (e.g., "Digital Printing", "Custom Embroidery")
    -   `CustomerServiceRep`: CSR name
    -   `CustomerPurchaseOrder`: PO number

### Order Dashboard

#### GET /order-dashboard

-   **Description**: Retrieves pre-calculated order metrics for dashboard displays. Optimized for UI dashboards with summary statistics, breakdowns by CSR and order type, and cached for performance.
-   **Method**: `GET`
-   **URL**: `/order-dashboard`
-   **Query Parameters**:
    -   `days` (integer, optional): Number of days to look back (default: 7)
    -   `includeDetails` (boolean, optional): Whether to include recent orders array (default: false)
-   **Example `curl` Requests**:
    ```bash
    # Get 7-day dashboard (default)
    curl "https://caspio-pricing-proxy-ab30a049961a.herokuapp.com/api/order-dashboard"
    
    # Get 30-day dashboard
    curl "https://caspio-pricing-proxy-ab30a049961a.herokuapp.com/api/order-dashboard?days=30"
    
    # Get 7-day dashboard with order details
    curl "https://caspio-pricing-proxy-ab30a049961a.herokuapp.com/api/order-dashboard?days=7&includeDetails=true"
    
    # Get today's orders only
    curl "https://caspio-pricing-proxy-ab30a049961a.herokuapp.com/api/order-dashboard?days=1"
    ```
-   **Response Structure**:
    ```json
    {
      "summary": {
        "totalOrders": 45,
        "totalSales": 28450.50,
        "notInvoiced": 12,
        "notShipped": 23,
        "avgOrderValue": 632.23
      },
      "dateRange": {
        "start": "2025-06-28T00:00:00Z",
        "end": "2025-07-04T23:59:59Z",
        "mostRecentOrder": "2025-07-03T00:00:00"
      },
      "breakdown": {
        "byCsr": [
          {"name": "Taylar Hanson", "orders": 15, "sales": 9780.00},
          {"name": "Nika Lao", "orders": 20, "sales": 12450.50}
        ],
        "byOrderType": [
          {"type": "Digital Printing", "orders": 25, "sales": 16300.00},
          {"type": "Screen Printing", "orders": 15, "sales": 9200.50}
        ]
      },
      "todayStats": {
        "ordersToday": 3,
        "salesToday": 1850.00,
        "shippedToday": 1
      },
      "recentOrders": [
        // Only included when includeDetails=true
        {
          "ID_Order": 137091,
          "date_OrderPlaced": "2025-07-03T00:00:00",
          "CompanyName": "BlackStone Construction",
          "CustomerServiceRep": "Nika Lao",
          "ORDER_TYPE": "Digital Printing",
          "cur_Subtotal": 652.00,
          "sts_Invoiced": 0,
          "sts_Shipped": 0
        }
      ]
    }
    ```
-   **Key Features**:
    -   Pre-calculated metrics for immediate dashboard display
    -   Sales calculations use `cur_Subtotal` (pre-tax amount)
    -   60-second server-side cache for performance
    -   Breakdown by Customer Service Rep and Order Type
    -   Today's statistics included automatically
    -   Optional detailed order list (up to 10 most recent)

---

## Inventory API

The Inventory API provides functionality for retrieving inventory information.

#### GET /inventory

-   **Description**: Retrieves a list of inventory for a given style and color.
-   **Method**: `GET`
-   **URL**: `/inventory`
-   **Query Parameters**:
    -   `styleNumber` (string, required): The style number of the product.
    -   `color` (string, optional): The color of the product.
-   **Example `curl` Request**:
    ```bash
    curl "https://caspio-pricing-proxy-ab30a049961a.herokuapp.com/api/inventory?styleNumber=PC61&color=Ash"
    ```

#### GET /sizes-by-style-color

-   **Description**: Retrieves a list of sizes for a given style and color.
-   **Method**: `GET`
-   **URL**: `/sizes-by-style-color`
-   **Query Parameters**:
    -   `styleNumber` (string, required): The style number of the product.
    -   `color` (string, required): The color of the product.
-   **Example `curl` Request**:
    ```bash
    curl "https://caspio-pricing-proxy-ab30a049961a.herokuapp.com/api/sizes-by-style-color?styleNumber=PC61&color=Ash"
    ```

---

## Pricing Matrix API

The Pricing Matrix API provides functionality for managing pricing matrices.

#### GET /pricing-matrix

-   **Description**: Retrieves a list of pricing matrices. Can be filtered by `pricingMatrixID`, `sessionID`, `styleNumber`, `color`, or `embellishmentType`.
-   **Method**: `GET`
-   **URL**: `/pricing-matrix`
-   **Example `curl` Request**:
    ```bash
    curl "https://caspio-pricing-proxy-ab30a049961a.herokuapp.com/api/pricing-matrix?sessionID=some-session-id"
    ```

#### GET /pricing-matrix/lookup

-   **Description**: Retrieves the ID of a pricing matrix for a given style, color, and embellishment type.
-   **Method**: `GET`
-   **URL**: `/pricing-matrix/lookup`
-   **Query Parameters**:
    -   `styleNumber` (string, required): The style number of the product.
    -   `color` (string, required): The color of the product.
    -   `embellishmentType` (string, required): The embellishment type.
    -   `sessionID` (string, optional): The session ID.
-   **Example `curl` Request**:
    ```bash
    curl "https://caspio-pricing-proxy-ab30a049961a.herokuapp.com/api/pricing-matrix/lookup?styleNumber=PC61&color=Ash&embellishmentType=DTG"
    ```

#### GET /pricing-matrix/:id

-   **Description**: Retrieves a pricing matrix by its ID.
-   **Method**: `GET`
-   **URL**: `/pricing-matrix/:id`
-   **Example `curl` Request**:
    ```bash
    curl "https://caspio-pricing-proxy-ab30a049961a.herokuapp.com/api/pricing-matrix/1"
    ```

#### POST /pricing-matrix

-   **Description**: Creates a new pricing matrix.
-   **Method**: `POST`
-   **URL**: `/pricing-matrix`
-   **Request Body**:
    ```json
    {
      "SessionID": "string",
      "StyleNumber": "string",
      "Color": "string",
      "EmbellishmentType": "string",
      "TierStructure": "object (optional)",
      "SizeGroups": "object (optional)",
      "PriceMatrix": "object (optional)"
    }
    ```
-   **Example `curl` Request**:
    ```bash
    curl -X POST -H "Content-Type: application/json" -d '{"SessionID": "some-session-id", "StyleNumber": "PC61", "Color": "Ash", "EmbellishmentType": "DTG"}' "https://caspio-pricing-proxy-ab30a049961a.herokuapp.com/api/pricing-matrix"
    ```

#### PUT /pricing-matrix/:id

-   **Description**: Updates an existing pricing matrix.
-   **Method**: `PUT`
-   **URL**: `/pricing-matrix/:id`
-   **Request Body**:
    ```json
    {
      "SessionID": "string (optional)",
      "STYLE": "string (optional)",
      "COLOR_NAME": "string (optional)",
      "EmbellishmentType": "string (optional)",
      "TierStructure": "object (optional)",
      "SizeGroups": "object (optional)",
      "PriceMatrix": "object (optional)"
    }
    ```
-   **Example `curl` Request**:
    ```bash
    curl -X PUT -H "Content-Type: application/json" -d '{"PriceMatrix": {}}' "https://caspio-pricing-proxy-ab30a049961a.herokuapp.com/api/pricing-matrix/1"
    ```

#### DELETE /pricing-matrix/:id

-   **Description**: Deletes a pricing matrix.
-   **Method**: `DELETE`
-   **URL**: `/pricing-matrix/:id`
-   **Example `curl` Request**:
    ```bash
    curl -X DELETE "https://caspio-pricing-proxy-ab30a049961a.herokuapp.com/api/pricing-matrix/1"
    ```

---

## Quotes API

The Quotes API provides functionality for managing quotes.

### Quote Analytics

#### GET /quote_analytics

-   **Description**: Retrieves a list of quote analytics. Can be filtered by `sessionID`, `quoteID`, or `eventType`.
-   **Method**: `GET`
-   **URL**: `/quote_analytics`
-   **Example `curl` Request**:
    ```bash
    curl "https://caspio-pricing-proxy-ab30a049961a.herokuapp.com/api/quote_analytics?quoteID=1"
    ```

#### GET /quote_analytics/:id

-   **Description**: Retrieves a quote analytics record by its ID.
-   **Method**: `GET`
-   **URL**: `/quote_analytics/:id`
-   **Example `curl` Request**:
    ```bash
    curl "https://caspio-pricing-proxy-ab30a049961a.herokuapp.com/api/quote_analytics/1"
    ```

#### POST /quote_analytics

-   **Description**: Creates a new quote analytics record.
-   **Method**: `POST`
-   **URL**: `/quote_analytics`
-   **Request Body**:
    ```json
    {
      "SessionID": "string",
      "EventType": "string",
      "QuoteID": "string (optional)"
    }
    ```
-   **Example `curl` Request**:
    ```bash
    curl -X POST -H "Content-Type: application/json" -d '{"SessionID": "some-session-id", "EventType": "View"}' "https://caspio-pricing-proxy-ab30a049961a.herokuapp.com/api/quote_analytics"
    ```

#### PUT /quote_analytics/:id

-   **Description**: Updates an existing quote analytics record.
-   **Method**: `PUT`
-   **URL**: `/quote_analytics/:id`
-   **Request Body**:
    ```json
    {
      "EventType": "string (optional)"
    }
    ```
-   **Example `curl` Request**:
    ```bash
    curl -X PUT -H "Content-Type: application/json" -d '{"EventType": "Save"}' "https://caspio-pricing-proxy-ab30a049961a.herokuapp.com/api/quote_analytics/1"
    ```

#### DELETE /quote_analytics/:id

-   **Description**: Deletes a quote analytics record.
-   **Method**: `DELETE`
-   **URL**: `/quote_analytics/:id`
-   **Example `curl` Request**:
    ```bash
    curl -X DELETE "https://caspio-pricing-proxy-ab30a049961a.herokuapp.com/api/quote_analytics/1"
    ```

### Quote Items

#### GET /quote_items

-   **Description**: Retrieves a list of quote items. Can be filtered by `quoteID` or `styleNumber`.
-   **Method**: `GET`
-   **URL**: `/quote_items`
-   **Example `curl` Request**:
    ```bash
    curl "https://caspio-pricing-proxy-ab30a049961a.herokuapp.com/api/quote_items?quoteID=1"
    ```

#### GET /quote_items/:id

-   **Description**: Retrieves a quote item by its ID.
-   **Method**: `GET`
-   **URL**: `/quote_items/:id`
-   **Example `curl` Request**:
    ```bash
    curl "https://caspio-pricing-proxy-ab30a049961a.herokuapp.com/api/quote_items/1"
    ```

#### POST /quote_items

-   **Description**: Creates a new quote item.
-   **Method**: `POST`
-   **URL**: `/quote_items`
-   **Request Body**:
    ```json
    {
      "QuoteID": "string",
      "StyleNumber": "string",
      "Quantity": "integer"
    }
    ```
-   **Example `curl` Request**:
    ```bash
    curl -X POST -H "Content-Type: application/json" -d '{"QuoteID": "1", "StyleNumber": "PC61", "Quantity": 10}' "https://caspio-pricing-proxy-ab30a049961a.herokuapp.com/api/quote_items"
    ```

#### PUT /quote_items/:id

-   **Description**: Updates an existing quote item.
-   **Method**: `PUT`
-   **URL**: `/quote_items/:id`
-   **Request Body**:
    ```json
    {
      "Quantity": "integer (optional)"
    }
    ```
-   **Example `curl` Request**:
    ```bash
    curl -X PUT -H "Content-Type: application/json" -d '{"Quantity": 20}' "https://caspio-pricing-proxy-ab30a049961a.herokuapp.com/api/quote_items/1"
    ```

#### DELETE /quote_items/:id

-   **Description**: Deletes a quote item.
-   **Method**: `DELETE`
-   **URL**: `/quote_items/:id`
-   **Example `curl` Request**:
    ```bash
    curl -X DELETE "https://caspio-pricing-proxy-ab30a049961a.herokuapp.com/api/quote_items/1"
    ```

### Quote Sessions

#### GET /quote_sessions

-   **Description**: Retrieves a list of quote sessions. Can be filtered by `quoteID`, `sessionID`, `customerEmail`, or `status`.
-   **Method**: `GET`
-   **URL**: `/quote_sessions`
-   **Example `curl` Request**:
    ```bash
    curl "https://caspio-pricing-proxy-ab30a049961a.herokuapp.com/api/quote_sessions?quoteID=1"
    ```

#### GET /quote_sessions/:id

-   **Description**: Retrieves a quote session by its ID.
-   **Method**: `GET`
-   **URL**: `/quote_sessions/:id`
-   **Example `curl` Request**:
    ```bash
    curl "https://caspio-pricing-proxy-ab30a049961a.herokuapp.com/api/quote_sessions/1"
    ```

#### POST /quote_sessions

-   **Description**: Creates a new quote session.
-   **Method**: `POST`
-   **URL**: `/quote_sessions`
-   **Request Body**:
    ```json
    {
      "QuoteID": "string",
      "SessionID": "string",
      "Status": "string"
    }
    ```
-   **Example `curl` Request**:
    ```bash
    curl -X POST -H "Content-Type: application/json" -d '{"QuoteID": "1", "SessionID": "some-session-id", "Status": "Active"}' "https://caspio-pricing-proxy-ab30a049961a.herokuapp.com/api/quote_sessions"
    ```

#### PUT /quote_sessions/:id

-   **Description**: Updates an existing quote session.
-   **Method**: `PUT`
-   **URL**: `/quote_sessions/:id`
-   **Request Body**:
    ```json
    {
      "Status": "string (optional)"
    }
    ```
-   **Example `curl` Request**:
    ```bash
    curl -X PUT -H "Content-Type: application/json" -d '{"Status": "Saved"}' "https://caspio-pricing-proxy-ab30a049961a.herokuapp.com/api/quote_sessions/1"
    ```

#### DELETE /quote_sessions/:id

-   **Description**: Deletes a quote session.
-   **Method**: `DELETE`
-   **URL**: `/quote_sessions/:id`
-   **Example `curl` Request**:
    ```bash
    curl -X DELETE "https://caspio-pricing-proxy-ab30a049961a.herokuapp.com/api/quote_sessions/1"
    ```

---

## Misc API

The Misc API provides a variety of utility and product-related functionality.

#### GET /status

-   **Description**: Retrieves the status of the API.
-   **Method**: `GET`
-   **URL**: `/status`
-   **Example `curl` Request**:
    ```bash
    curl "https://caspio-pricing-proxy-ab30a049961a.herokuapp.com/api/status"
    ```

#### GET /test

-   **Description**: A test endpoint to verify that the API is running.
-   **Method**: `GET`
-   **URL**: `/test`
-   **Example `curl` Request**:
    ```bash
    curl "https://caspio-pricing-proxy-ab30a049961a.herokuapp.com/api/test"
    ```

#### GET /cart-integration.js

-   **Description**: Retrieves the cart integration script.
-   **Method**: `GET`
-   **URL**: `/cart-integration.js`
-   **Example `curl` Request**:
    ```bash
    curl "https://caspio-pricing-proxy-ab30a049961a.herokuapp.com/api/cart-integration.js"
    ```

#### GET /subcategories-by-category

-   **Description**: Retrieves a list of subcategories for a given category.
-   **Method**: `GET`
-   **URL**: `/subcategories-by-category`
-   **Query Parameters**:
    -   `category` (string, required): The category name.
-   **Example `curl` Request**:
    ```bash
    curl "https://caspio-pricing-proxy-ab30a049961a.herokuapp.com/api/subcategories-by-category?category=T-Shirts"
    ```

#### GET /products-by-category-subcategory

-   **Description**: Retrieves a list of products for a given category and subcategory.
-   **Method**: `GET`
-   **URL**: `/products-by-category-subcategory`
-   **Query Parameters**:
    -   `category` (string, required): The category name.
    -   `subcategory` (string, required): The subcategory name.
-   **Example `curl` Request**:
    ```bash
    curl "https://caspio-pricing-proxy-ab30a049961a.herokuapp.com/api/products-by-category-subcategory?category=T-Shirts&subcategory=T-Shirts"
    ```

#### GET /related-products

-   **Description**: Retrieves a list of related products for a given style.
-   **Method**: `GET`
-   **URL**: `/related-products`
-   **Query Parameters**:
    -   `styleNumber` (string, required): The style number of the product.
-   **Example `curl` Request**:
    ```bash
    curl "https://caspio-pricing-proxy-ab30a049961a.herokuapp.com/api/related-products?styleNumber=PC61"
    ```

#### GET /filter-products

-   **Description**: Retrieves a list of products based on a set of filters.
-   **Method**: `GET`
-   **URL**: `/filter-products`
-   **Query Parameters**:
    -   `category` (string, optional): The category name.
    -   `subcategory` (string, optional): The subcategory name.
    -   `color` (string, optional): The color of the product.
    -   `brand` (string, optional): The brand name.
    -   `minPrice` (number, optional): The minimum price.
    -   `maxPrice` (number, optional): The maximum price.
-   **Example `curl` Request**:
    ```bash
    curl "https://caspio-pricing-proxy-ab30a049961a.herokuapp.com/api/filter-products?category=T-Shirts&maxPrice=20"
    ```

#### GET /quick-view

-   **Description**: Retrieves a quick view of a product for a given style.
-   **Method**: `GET`
-   **URL**: `/quick-view`
-   **Query Parameters**:
    -   `styleNumber` (string, required): The style number of the product.
-   **Example `curl` Request**:
    ```bash
    curl "https://caspio-pricing-proxy-ab30a049961a.herokuapp.com/api/quick-view?styleNumber=PC61"
    ```

#### GET /compare-products

-   **Description**: Retrieves a list of products to compare.
-   **Method**: `GET`
-   **URL**: `/compare-products`
-   **Query Parameters**:
    -   `styles` (string, required): A comma-separated list of style numbers.
-   **Example `curl` Request**:
    ```bash
    curl "https://caspio-pricing-proxy-ab30a049961a.herokuapp.com/api/compare-products?styles=PC61,PC54"
    ```

#### GET /recommendations

-   **Description**: Retrieves a list of recommended products for a given style.
-   **Method**: `GET`
-   **URL**: `/recommendations`
-   **Query Parameters**:
    -   `styleNumber` (string, required): The style number of the product.
-   **Example `curl` Request**:
    ```bash
    curl "https://caspio-pricing-proxy-ab30a049961a.herokuapp.com/api/recommendations?styleNumber=PC61"
    ```

#### GET /test-sanmar-bulk

-   **Description**: A test endpoint to verify the Sanmar bulk data.
-   **Method**: `GET`
-   **URL**: `/test-sanmar-bulk`
-   **Example `curl` Request**:
    ```bash
    curl "https://caspio-pricing-proxy-ab30a049961a.herokuapp.com/api/test-sanmar-bulk"
    ```

---

## Art Requests API

The Art Requests API provides comprehensive CRUD functionality for managing art request records from the ArtRequests table.

**Important Note - Dynamic Field Handling**: This API is designed to automatically handle any fields present in the Caspio ArtRequests table. When you add new fields to the Caspio table, the API will immediately start accepting and returning those fields without requiring any code changes. This applies to all CRUD operations.

### Art Requests

**Important Note - Dynamic Field Handling**: This API is designed to automatically handle any fields present in the Caspio table. When new fields are added to the ArtRequests table in Caspio (such as Invoiced, Invoiced_Date, Invoice_Updated_Date), they are immediately available through the API without requiring any code changes.

**Testing Results & Tips**:
- ✅ All CRUD operations tested and verified working on Heroku (June 30, 2025)
- ⚠️ **Special Character Handling**: Avoid using special Unicode characters (emojis, etc.) in field values as they may cause 500 errors during PUT operations
- 💡 **Best Practice**: Use simple alphanumeric data for reliable updates
- 🔍 **Field Discovery**: The GET endpoints will return ALL fields from your Caspio table, making it easy to discover new fields
- 📝 **Flexible Schema**: The API accepts ANY fields in POST/PUT requests - if a field exists in Caspio, it will be processed

#### GET /artrequests

-   **Description**: Retrieves a list of art requests. Supports extensive filtering options, field selection, sorting, grouping, and pagination. The response automatically includes ALL fields present in the Caspio ArtRequests table.
-   **Method**: `GET`
-   **URL**: `/artrequests`
-   **Query Parameters**:
    -   **Filtering**:
        -   `pk_id` (integer, optional): The primary key ID of the art request.
        -   `status` (string, optional): The status of the art request (e.g., "Completed", "In Progress", "Awaiting Approval").
        -   `id_design` (integer, optional): The design ID.
        -   `companyName` (string, optional): The company name (supports partial matching).
        -   `customerServiceRep` (string, optional): The customer service representative name.
        -   `priority` (string, optional): The priority level.
        -   `mockup` (boolean, optional): Whether this is a mockup request.
        -   `orderType` (string, optional): The type of order.
        -   `customerType` (string, optional): The type of customer (e.g., "Construction").
        -   `happyStatus` (string, optional): The happiness/satisfaction status.
        -   `salesRep` (string, optional): The sales representative name.
        -   `id_customer` (integer, optional): The customer ID.
        -   `id_contact` (integer, optional): The contact ID.
        -   `dateCreatedFrom` (string, optional): Filter by creation date (from).
        -   `dateCreatedTo` (string, optional): Filter by creation date (to).
        -   `dueDateFrom` (string, optional): Filter by due date (from).
        -   `dueDateTo` (string, optional): Filter by due date (to).
    -   **Field Selection**:
        -   `select` (string, optional): Comma-separated list of fields to return.
    -   **Sorting**:
        -   `orderBy` (string, optional): ORDER BY clause (default: "Date_Created DESC").
    -   **Grouping**:
        -   `groupBy` (string, optional): GROUP BY clause.
    -   **Pagination**:
        -   `limit` (integer, optional): Maximum number of records (max: 1000, default: 100).
        -   `pageNumber` (integer, optional): Page number (used with pageSize).
        -   `pageSize` (integer, optional): Records per page (5-1000, used with pageNumber).
-   **Response**: Returns an array of art request objects with fields such as:
    -   `PK_ID`, `Status`, `ID_Design`, `CompanyName`, `Due_Date`, `NOTES`
    -   `CustomerServiceRep`, `Priority`, `Date_Created`, `Date_Updated`
    -   `Mockup`, `Art_Minutes`, `Amount_Art_Billed`
    -   `GarmentColor`, `GarmentStyle`, `Garment_Placement`
    -   File upload fields, contact information, and more
-   **Example `curl` Requests**:
    ```bash
    # Get all art requests (default limit: 100)
    curl "https://caspio-pricing-proxy-ab30a049961a.herokuapp.com/api/artrequests"
    
    # Get art requests with specific status
    curl "https://caspio-pricing-proxy-ab30a049961a.herokuapp.com/api/artrequests?status=In%20Progress"
    
    # Get art requests for a specific company with pagination
    curl "https://caspio-pricing-proxy-ab30a049961a.herokuapp.com/api/artrequests?companyName=Metal&pageNumber=1&pageSize=25"
    
    # Get specific fields only
    curl "https://caspio-pricing-proxy-ab30a049961a.herokuapp.com/api/artrequests?select=PK_ID,Status,CompanyName,Date_Created&limit=50"
    
    # Get art requests created in a date range, ordered by priority
    curl "https://caspio-pricing-proxy-ab30a049961a.herokuapp.com/api/artrequests?dateCreatedFrom=2023-01-01&dateCreatedTo=2023-12-31&orderBy=Priority%20ASC,Date_Created%20DESC"
    ```

#### GET /artrequests/:id

-   **Description**: Retrieves a specific art request by its primary key ID. Returns ALL fields from the Caspio table.
-   **Method**: `GET`
-   **URL**: `/artrequests/:id`
-   **Path Parameters**:
    -   `id` (integer, required): The primary key ID of the art request.
-   **Example `curl` Request**:
    ```bash
    curl "https://caspio-pricing-proxy-ab30a049961a.herokuapp.com/api/artrequests/1279"
    ```
-   **Response**: Returns a single art request object containing ALL fields from the Caspio table if found, or a 404 error if not found.

#### POST /artrequests

-   **Description**: Creates a new art request record. Accepts ANY fields that exist in the Caspio ArtRequests table.
-   **Method**: `POST`
-   **URL**: `/artrequests`
-   **Request Body**: The request body can include any fields from the Caspio table. Below are commonly used fields:
    ```json
    {
      "Status": "string (optional)",
      "CompanyName": "string (optional)",
      "Due_Date": "string (optional)",
      "CustomerServiceRep": "string (optional)",
      "Priority": "string (optional)",
      "Mockup": "boolean (optional)",
      "GarmentStyle": "string (optional)",
      "GarmentColor": "string (optional)",
      "NOTES": "string (optional)",
      "Invoiced": "boolean (optional)",
      "Invoiced_Date": "string (optional)",
      "...any other fields from your Caspio table..."
    }
    ```
    **Note**: You can include ANY field that exists in your Caspio ArtRequests table. The API will automatically handle all fields without requiring code changes.
-   **Example `curl` Request**:
    ```bash
    curl -X POST -H "Content-Type: application/json" \
      -d '{"CompanyName": "Test Company", "Status": "In Progress", "CustomerServiceRep": "John Doe"}' \
      "https://caspio-pricing-proxy-ab30a049961a.herokuapp.com/api/artrequests"
    ```
-   **Response**: Returns a 201 status with the created art request data.

#### PUT /artrequests/:id

-   **Description**: Updates an existing art request by ID. Accepts ANY fields that exist in the Caspio ArtRequests table.
-   **Method**: `PUT`
-   **URL**: `/artrequests/:id`
-   **Path Parameters**:
    -   `id` (integer, required): The primary key ID of the art request to update.
-   **Request Body**: Any fields from the Caspio ArtRequests table that need to be updated. The API will automatically handle all fields present in your table without requiring code changes.
-   **Example `curl` Request**:
    ```bash
    curl -X PUT -H "Content-Type: application/json" \
      -d '{"Status": "Completed", "Invoiced": true, "Invoiced_Date": "2025-06-30"}' \
      "https://caspio-pricing-proxy-ab30a049961a.herokuapp.com/api/artrequests/1279"
    ```
-   **Response**: Returns the updated art request data.

#### DELETE /artrequests/:id

-   **Description**: Deletes an art request by ID.
-   **Method**: `DELETE`
-   **URL**: `/artrequests/:id`
-   **Path Parameters**:
    -   `id` (integer, required): The primary key ID of the art request to delete.
-   **Example `curl` Request**:
    ```bash
    curl -X DELETE "https://caspio-pricing-proxy-ab30a049961a.herokuapp.com/api/artrequests/1279"
    ```
-   **Response**: Returns a success message if the deletion was successful.

### Testing Examples & Troubleshooting

**Successful Test Sequence** (verified on Heroku):
```bash
# 1. List all art requests
curl "https://caspio-pricing-proxy-ab30a049961a.herokuapp.com/api/artrequests"
# Result: Returns array including new fields like Invoiced, Invoiced_Date

# 2. Create a test art request
curl -X POST -H "Content-Type: application/json" \
  -d '{"CompanyName": "Test Company", "Status": "In Progress", "Invoiced": false}' \
  "https://caspio-pricing-proxy-ab30a049961a.herokuapp.com/api/artrequests"
# Result: 201 Created with new record ID (e.g., 2519)

# 3. Get specific art request
curl "https://caspio-pricing-proxy-ab30a049961a.herokuapp.com/api/artrequests/2519"
# Result: Returns full record with all fields

# 4. Update art request (simple data)
curl -X PUT -H "Content-Type: application/json" \
  -d '{"Status": "Completed", "Invoiced": true}' \
  "https://caspio-pricing-proxy-ab30a049961a.herokuapp.com/api/artrequests/2519"
# Result: Successfully updated

# 5. Delete art request
curl -X DELETE "https://caspio-pricing-proxy-ab30a049961a.herokuapp.com/api/artrequests/2519"
# Result: Successfully deleted, subsequent GET returns 404
```

**Common Issues & Solutions**:
- **500 Error on PUT**: Usually caused by special characters. Solution: Use simple text without emojis or complex Unicode
- **404 Error**: Record doesn't exist. Verify the ID with a GET request first
- **Missing Fields**: The API returns ALL fields from Caspio. If a field is missing, check your Caspio table configuration

### Art Request Schema

The art request object includes fields from the Caspio ArtRequests table. Common fields include:

- `PK_ID`: Primary key identifier
- `Status`: Current status of the request
- `ID_Design`: Design identifier
- `CompanyName`: Company name
- `Due_Date`: Due date for the request
- `NOTES`: Additional notes
- `CustomerServiceRep`: Customer service representative
- `Priority`: Priority level
- `Date_Created`: Creation date
- `Date_Updated`: Last update date
- `Mockup`: Boolean indicating if this is a mockup
- `Art_Minutes`: Time spent on art
- `Amount_Art_Billed`: Amount billed for art
- `Invoiced`: Boolean indicating if invoiced (newly added field)
- `Invoiced_Date`: Date when invoiced (newly added field)
- `Invoice_Updated_Date`: Date when invoice was last updated (newly added field)
- `GarmentColor`, `GarmentStyle`, `Garment_Placement`: Garment details
- `File_Upload_One`, `File_Upload_Two`, `File_Upload_Three`, `File_Upload_Four`: File uploads
- `Happy_Status`: Customer satisfaction status

**Note**: This list is not exhaustive. The API automatically handles ALL fields present in your Caspio ArtRequests table, including any custom fields you may have added. Additional fields include contact info, order details, and more.

---

## Production Schedules API

The Production Schedules API provides access to production availability dates for different decoration methods at Northwest Custom Apparel.

### Production Schedules

#### GET /production-schedules

-   **Description**: Retrieves production schedule records showing availability dates for DTG, Embroidery, Screen Print, and other decoration methods.
-   **Method**: `GET`
-   **URL**: `/production-schedules`
-   **Query Parameters**:
    -   `q.where` (string, optional): Filter records using SQL-like conditions (e.g., `Date>'2021-08-01'`, `Employee='Ruth'`)
    -   `q.orderBy` (string, optional): Sort results by field(s) (e.g., `Date DESC`, `PK_ID ASC`)
    -   `q.limit` (integer, optional): Maximum number of records to return (default: 100, max: 1000)
-   **Example `curl` Requests**:
    ```bash
    # Get all production schedules (limited to 100)
    curl "https://caspio-pricing-proxy-ab30a049961a.herokuapp.com/api/production-schedules"
    
    # Get latest 5 schedules
    curl "https://caspio-pricing-proxy-ab30a049961a.herokuapp.com/api/production-schedules?q.orderBy=Date%20DESC&q.limit=5"
    
    # Get schedules after a specific date
    curl "https://caspio-pricing-proxy-ab30a049961a.herokuapp.com/api/production-schedules?q.where=Date%3E'2021-08-20'&q.orderBy=Date%20ASC"
    
    # Get schedules by specific employee
    curl "https://caspio-pricing-proxy-ab30a049961a.herokuapp.com/api/production-schedules?q.where=Employee%3D'Ruth'&q.limit=10"
    ```
-   **Response Example**:
    ```json
    [
      {
        "PK_ID": 22,
        "ID_Log": "YUAE5SDQ",
        "Date": "2021-09-01T08:20:36",
        "Employee": "Ruth",
        "DTG": "2021-09-10T00:00:00",
        "Embroidery": "2021-09-10T00:00:00",
        "Cap_Embroidery": "2021-09-10T00:00:00",
        "Screenprint": "2021-09-10T00:00:00",
        "Transfers": "2021-09-10T00:00:00",
        "Comment_DTG": "2 weeks out",
        "Comment_Emb": "",
        "Comment_Cap": "",
        "Comment_SP": "3 weeks out",
        "Comment_Transfers": "",
        "DTG_Sneak_In": null,
        "Drop_Dead_Big_Order_Status": ""
      }
    ]
    ```

### Common Production Schedule Fields:

- `PK_ID`: Primary key identifier
- `Date`: When the schedule was updated
- `Employee`: Who updated the schedule
- `DTG`: Direct-to-Garment availability date
- `Embroidery`: Embroidery availability date
- `Cap_Embroidery`: Cap embroidery availability date
- `Screenprint`: Screen printing availability date
- `Transfers`: Transfer printing availability date
- `Comment_DTG`, `Comment_Emb`, `Comment_Cap`, `Comment_SP`, `Comment_Transfers`: Comments for each decoration method

---

## Art Invoices API

The Art Invoices API provides comprehensive CRUD functionality for managing art invoice records through the Heroku API endpoint.

**Important Note - Dynamic Field Handling**: This API is designed to automatically handle any fields present in the Caspio Art_Invoices table. When you add new fields to the Caspio table, the API will immediately start accepting and returning those fields without requiring any code changes. This applies to all CRUD operations.

### Art Invoices

#### GET /art-invoices

-   **Description**: Retrieves a list of art invoices. Supports filtering by multiple fields including invoice ID, request ID, status, artist name, customer details, and more. The response automatically includes ALL fields present in the Caspio Art_Invoices table.
-   **Method**: `GET`
-   **URL**: `/art-invoices`
-   **Query Parameters**:
    -   `invoiceID` (string, optional): The unique invoice identifier.
    -   `artRequestID` (string, optional): The associated art request ID.
    -   `sessionID` (string, optional): The session ID.
    -   `status` (string, optional): The invoice status.
    -   `artistName` (string, optional): The artist's name (supports partial matching).
    -   `customerName` (string, optional): The customer's name (supports partial matching).
    -   `customerCompany` (string, optional): The customer's company (supports partial matching).
    -   `projectName` (string, optional): The project name (supports partial matching).
    -   `isDeleted` (boolean, optional): Filter by deletion status.
-   **Example `curl` Request**:
    ```bash
    curl "https://caspio-pricing-proxy-ab30a049961a.herokuapp.com/api/art-invoices?status=pending&artistName=Steve"
    ```
-   **Response**: Returns an array of art invoice objects sorted by PK_ID in descending order. Each object contains ALL fields from the Caspio table, including any custom fields you've added.

#### GET /art-invoices/:id

-   **Description**: Retrieves a specific art invoice by its primary key ID. Returns ALL fields from the Caspio table.
-   **Method**: `GET`
-   **URL**: `/art-invoices/:id`
-   **Path Parameters**:
    -   `id` (integer, required): The primary key ID of the art invoice.
-   **Example `curl` Request**:
    ```bash
    curl "https://caspio-pricing-proxy-ab30a049961a.herokuapp.com/api/art-invoices/2"
    ```
-   **Response**: Returns a single art invoice object containing ALL fields from the Caspio table if found, or a 404 error if not found.

#### POST /art-invoices

-   **Description**: Creates a new art invoice record. Accepts ANY fields that exist in the Caspio Art_Invoices table.
-   **Method**: `POST`
-   **URL**: `/art-invoices`
-   **Request Body**: The request body can include any fields from the Caspio table. Below are commonly used fields:
    ```json
    {
      "InvoiceID": "string (required)",
      "ArtRequestID": "string (required)",
      "SessionID": "string (optional)",
      "InvoiceDate": "string (optional)",
      "DueDate": "string (optional)",
      "Status": "string (optional)",
      "ArtistName": "string (optional)",
      "ArtistEmail": "string (optional)",
      "CustomerName": "string (optional)",
      "CustomerCompany": "string (optional)",
      "CustomerEmail": "string (optional)",
      "ProjectName": "string (optional)",
      "TotalAmount": "number (optional)",
      "Notes": "string (optional)",
      "...any other fields from your Caspio table..."
    }
    ```
    **Note**: You can include ANY field that exists in your Caspio Art_Invoices table. The API will automatically handle all fields without requiring code changes.
-   **Example `curl` Request**:
    ```bash
    curl -X POST -H "Content-Type: application/json" \
      -d '{"InvoiceID": "INV-2025-001", "ArtRequestID": "AR-2025-001", "ArtistName": "John Doe", "Status": "pending"}' \
      "https://caspio-pricing-proxy-ab30a049961a.herokuapp.com/api/art-invoices"
    ```
-   **Response**: Returns a 201 status with the created invoice data.

#### PUT /art-invoices/:id

-   **Description**: Updates an existing art invoice by ID. Accepts ANY fields that exist in the Caspio Art_Invoices table.
-   **Method**: `PUT`
-   **URL**: `/art-invoices/:id`
-   **Path Parameters**:
    -   `id` (integer, required): The primary key ID of the art invoice to update.
-   **Request Body**: Any fields from the Caspio Art_Invoices table that need to be updated. The API will automatically handle all fields present in your table without requiring code changes.
-   **Example `curl` Request**:
    ```bash
    curl -X PUT -H "Content-Type: application/json" \
      -d '{"Status": "completed", "PaymentDate": "2025-06-30", "PaymentAmount": 500.00}' \
      "https://caspio-pricing-proxy-ab30a049961a.herokuapp.com/api/art-invoices/2"
    ```
-   **Response**: Returns the updated invoice data.

#### DELETE /art-invoices/:id

-   **Description**: Deletes an art invoice by ID.
-   **Method**: `DELETE`
-   **URL**: `/art-invoices/:id`
-   **Path Parameters**:
    -   `id` (integer, required): The primary key ID of the art invoice to delete.
-   **Example `curl` Request**:
    ```bash
    curl -X DELETE "https://caspio-pricing-proxy-ab30a049961a.herokuapp.com/api/art-invoices/2"
    ```
-   **Response**: Returns a success message if the deletion was successful.

### Art Invoice Schema

The art invoice object includes fields from the Caspio Art_Invoices table. Common fields include:

- `PK_ID`: Primary key identifier
- `InvoiceID`: Unique invoice identifier (required for creation)
- `ArtRequestID`: Associated art request ID (required for creation)
- `SessionID`: Session identifier
- `InvoiceDate`: Date the invoice was created
- `DueDate`: Payment due date
- `Status`: Current status of the invoice
- `ArtistName`, `ArtistEmail`: Artist information
- `SalesRepName`, `SalesRepEmail`: Sales representative information
- `CustomerName`, `CustomerCompany`, `CustomerEmail`: Customer details
- `ProjectName`, `ProjectType`: Project information
- `OriginalRequestDate`, `CompletionDate`: Project timeline
- `TimeSpent`, `HourlyRate`: Time tracking
- `SubtotalAmount`, `RushFee`, `RevisionFee`, `OtherFees`: Pricing breakdown
- `TotalAmount`, `TaxAmount`, `GrandTotal`: Total calculations
- `PaymentMethod`, `PaymentReference`, `PaymentDate`, `PaymentAmount`: Payment information
- `BalanceDue`: Outstanding balance
- `Notes`, `CustomerNotes`, `ArtworkDescription`: Additional information
- `FileReferences`: Associated file references
- `Complexity`, `Priority`: Job classification
- `CCEmails`, `EmailSentDate`, `EmailSentTo`: Email tracking
- `ReminderCount`, `LastReminderDate`: Reminder tracking
- `InternalCode`, `Department`: Internal classification
- `ApprovedBy`, `ApprovalDate`: Approval tracking
- `CreatedAt`, `UpdatedAt`, `CreatedBy`, `ModifiedBy`: Audit fields
- `IsDeleted`, `DeletedDate`, `DeletedBy`: Soft delete tracking

**Note**: This list shows commonly used fields. The actual schema may include additional custom fields that you've added to your Caspio table. All fields present in the Caspio table will be automatically handled by the API.

## Transfers API

The Transfers API provides functionality for managing transfer pricing.

#### GET /transfers/lookup

-   **Description**: Retrieves the price of a transfer for a given size, quantity, and price type.
-   **Method**: `GET`
-   **URL**: `/transfers/lookup`
-   **Query Parameters**:
    -   `size` (string, required): The size of the transfer.
    -   `quantity` (integer, required): The quantity of transfers.
    -   `price_type` (string, required): The price type.
-   **Example `curl` Request**:
    ```bash
    curl "https://caspio-pricing-proxy-ab30a049961a.herokuapp.com/api/transfers/lookup?size=Adult&quantity=10&price_type=Regular"
    ```

#### GET /transfers/matrix

-   **Description**: Retrieves a list of all quantity tiers for a given size and price type.
-   **Method**: `GET`
-   **URL**: `/transfers/matrix`
-   **Query Parameters**:
    -   `size` (string, required): The size of the transfer.
    -   `price_type` (string, optional): The price type.
-   **Example `curl` Request**:
    ```bash
    curl "https://caspio-pricing-proxy-ab30a049961a.herokuapp.com/api/transfers/matrix?size=Adult"
    ```

#### GET /transfers/sizes

-   **Description**: Retrieves a list of all available transfer sizes.
-   **Method**: `GET`
-   **URL**: `/transfers/sizes`
-   **Example `curl` Request**:
    ```bash
    curl "https://caspio-pricing-proxy-ab30a049961a.herokuapp.com/api/transfers/sizes"
    ```

#### GET /transfers/price-types

-   **Description**: Retrieves a list of all available price types.
-   **Method**: `GET`
-   **URL**: `/transfers/price-types`
-   **Example `curl` Request**:
    ```bash
    curl "https://caspio-pricing-proxy-ab30a049961a.herokuapp.com/api/transfers/price-types"
    ```

#### GET /transfers/quantity-ranges

-   **Description**: Retrieves a list of all available quantity ranges.
-   **Method**: `GET`
-   **URL**: `/transfers/quantity-ranges`
-   **Example `curl` Request**:
    ```bash
    curl "https://caspio-pricing-proxy-ab30a049961a.herokuapp.com/api/transfers/quantity-ranges"
    ```

#### GET /transfers

-   **Description**: Retrieves a list of transfers. Can be filtered by various criteria.
-   **Method**: `GET`
-   **URL**: `/transfers`
-   **Example `curl` Request**:
    ```bash
    curl "https://caspio-pricing-proxy-ab30a049961a.herokuapp.com/api/transfers?size=Adult"