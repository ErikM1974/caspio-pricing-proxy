# Caspio Pricing Proxy API

This API serves as a proxy for accessing Caspio data related to pricing, inventory, and product information for Northwest Custom Apparel.

## Important Notes for Developers

### Caspio Pagination

**CRITICAL**: Caspio API uses pagination, which means that results may be split across multiple pages. When implementing new endpoints, **ALWAYS** use the `fetchAllCaspioPages` function instead of `makeCaspioRequest` to ensure you get ALL records.

Failure to use `fetchAllCaspioPages` will result in incomplete data when the result set spans multiple pages. We've seen this issue with brands like "OGIO" which were on the second page and were not being returned when using `makeCaspioRequest`.

## API Endpoints

### Status

- **URL**: `/status`
- **Method**: `GET`
- **Description**: Simple status check to verify the API is running
- **Example**: `https://caspio-pricing-proxy-ab30a049961a.herokuapp.com/status`

### Pricing Tiers

- **URL**: `/api/pricing-tiers`
- **Method**: `GET`
- **Query Parameters**:
  - `method` (required): Decoration method (DTG, ScreenPrint, Embroidery)
- **Description**: Get pricing tiers based on decoration method
- **Example**: `https://caspio-pricing-proxy-ab30a049961a.herokuapp.com/api/pricing-tiers?method=DTG`

### Embroidery Costs

- **URL**: `/api/embroidery-costs`
- **Method**: `GET`
- **Query Parameters**:
  - `itemType` (required): Type of item (Cap, Shirt, etc.)
  - `stitchCount` (required): Stitch count (5000, 8000, 10000)
- **Description**: Get embroidery costs based on item type and stitch count
- **Example**: `https://caspio-pricing-proxy-ab30a049961a.herokuapp.com/api/embroidery-costs?itemType=Cap&stitchCount=5000`

### DTG Costs

- **URL**: `/api/dtg-costs`
- **Method**: `GET`
- **Description**: Get all DTG costs by print location and tier
- **Example**: `https://caspio-pricing-proxy-ab30a049961a.herokuapp.com/api/dtg-costs`

### Screenprint Costs

- **URL**: `/api/screenprint-costs`
- **Method**: `GET`
- **Query Parameters**:
  - `costType` (required): Cost type (PrimaryLocation or AdditionalLocation)
- **Description**: Get screenprint costs by tier and color count
- **Example**: `https://caspio-pricing-proxy-ab30a049961a.herokuapp.com/api/screenprint-costs?costType=PrimaryLocation`

### Pricing Rules

- **URL**: `/api/pricing-rules`
- **Method**: `GET`
- **Query Parameters**:
  - `method` (required): Decoration method (DTG, ScreenPrint, Embroidery)
- **Description**: Get pricing rules based on decoration method
- **Example**: `https://caspio-pricing-proxy-ab30a049961a.herokuapp.com/api/pricing-rules?method=ScreenPrint`

### Base Item Costs

- **URL**: `/api/base-item-costs`
- **Method**: `GET`
- **Query Parameters**:
  - `styleNumber` (required): Style number of the item
- **Description**: Get base item costs (max case price per size) for a specific style
- **Example**: `https://caspio-pricing-proxy-ab30a049961a.herokuapp.com/api/base-item-costs?styleNumber=3001C`

### Style Search Autocomplete

- **URL**: `/api/stylesearch`
- **Method**: `GET`
- **Query Parameters**:
  - `term` (required): Search term (minimum 2 characters)
- **Description**: Search for styles by partial style number
- **Example**: `https://caspio-pricing-proxy-ab30a049961a.herokuapp.com/api/stylesearch?term=PC`

### Product Details

- **URL**: `/api/product-details`
- **Method**: `GET`
- **Query Parameters**:
  - `styleNumber` (required): Style number of the product
  - `color` (optional): Color name to filter results
- **Description**: Get product details including title, description, and images
- **Example**: `https://caspio-pricing-proxy-ab30a049961a.herokuapp.com/api/product-details?styleNumber=PC61`

### Color Swatches

- **URL**: `/api/color-swatches`
- **Method**: `GET`
- **Query Parameters**:
  - `styleNumber` (required): Style number of the product
- **Description**: Get color swatches for a specific style
- **Example**: `https://caspio-pricing-proxy-ab30a049961a.herokuapp.com/api/color-swatches?styleNumber=PC61`

### Inventory

- **URL**: `/api/inventory`
- **Method**: `GET`
- **Query Parameters**:
  - `styleNumber` (required): Style number of the product
  - `color` (optional): Color name to filter results
- **Description**: Get all inventory fields for a specific style
- **Example**: `https://caspio-pricing-proxy-ab30a049961a.herokuapp.com/api/inventory?styleNumber=S100`

### All Brands

- **URL**: `/api/all-brands`
- **Method**: `GET`
- **Description**: Get all brands with sample styles
- **Example**: `https://caspio-pricing-proxy-ab30a049961a.herokuapp.com/api/all-brands`

### Products by Brand

- **URL**: `/api/products-by-brand`
- **Method**: `GET`
- **Query Parameters**:
  - `brand` (required): Brand name (partial match)
- **Description**: Get products by brand name (partial match)
- **Example**: `https://caspio-pricing-proxy-ab30a049961a.herokuapp.com/api/products-by-brand?brand=OGIO`

### Products by Category

- **URL**: `/api/products-by-category`
- **Method**: `GET`
- **Query Parameters**:
  - `category` (required): Category name (exact match)
- **Description**: Get products by category name
- **Example**: `https://caspio-pricing-proxy-ab30a049961a.herokuapp.com/api/products-by-category?category=T-Shirts`

### Products by Subcategory

- **URL**: `/api/products-by-subcategory`
- **Method**: `GET`
- **Query Parameters**:
  - `subcategory` (required): Subcategory name (exact match)
- **Description**: Get products by subcategory name
- **Example**: `https://caspio-pricing-proxy-ab30a049961a.herokuapp.com/api/products-by-subcategory?subcategory=Youth`

### All Categories

- **URL**: `/api/all-categories`
- **Method**: `GET`
- **Description**: Get all available product categories
- **Example**: `https://caspio-pricing-proxy-ab30a049961a.herokuapp.com/api/all-categories`

### All Subcategories

- **URL**: `/api/all-subcategories`
- **Method**: `GET`
- **Description**: Get all available product subcategories
- **Example**: `https://caspio-pricing-proxy-ab30a049961a.herokuapp.com/api/all-subcategories`

### Subcategories by Category

- **URL**: `/api/subcategories-by-category`
- **Method**: `GET`
- **Query Parameters**:
  - `category` (required): Category name (e.g., T-Shirts, Polos/Knits, Caps)
- **Description**: Get subcategories for a specific category
- **Example**: `https://caspio-pricing-proxy-ab30a049961a.herokuapp.com/api/subcategories-by-category?category=Caps`

### Products by Category and Subcategory

- **URL**: `/api/products-by-category-subcategory`
- **Method**: `GET`
- **Query Parameters**:
  - `category` (required): Category name (e.g., T-Shirts, Polos/Knits, Caps)
  - `subcategory` (required): Subcategory name (e.g., Youth, Men's, Women's)
- **Description**: Get products for a specific category and subcategory combination
- **Example**: `https://caspio-pricing-proxy-ab30a049961a.herokuapp.com/api/products-by-category-subcategory?category=T-Shirts&subcategory=Youth`

### Search Products

- **URL**: `/api/search`
- **Method**: `GET`
- **Query Parameters**:
  - `q` (required): Search query (minimum 2 characters)
- **Description**: Search across all products by keyword (searches style, title, description, brand, category, and subcategory)
- **Example**: `https://caspio-pricing-proxy-ab30a049961a.herokuapp.com/api/search?q=hoodie`

### Featured Products

- **URL**: `/api/featured-products`
- **Method**: `GET`
- **Description**: Get featured/new products (products with 'New' status)
- **Example**: `https://caspio-pricing-proxy-ab30a049961a.herokuapp.com/api/featured-products`

### Related Products

- **URL**: `/api/related-products`
- **Method**: `GET`
- **Query Parameters**:
  - `styleNumber` (required): Style number of the reference product
- **Description**: Get products related to a specific style (same category, subcategory, or brand)
- **Example**: `https://caspio-pricing-proxy-ab30a049961a.herokuapp.com/api/related-products?styleNumber=PC61`

### Advanced Filtering

- **URL**: `/api/filter-products`
- **Method**: `GET`
- **Query Parameters**:
  - `category` (optional): Category name
  - `subcategory` (optional): Subcategory name
  - `color` (optional): Color name
  - `brand` (optional): Brand name
  - `minPrice` (optional): Minimum price
  - `maxPrice` (optional): Maximum price
- **Description**: Filter products by multiple criteria (category, subcategory, color, brand, price range)
- **Example**: `https://caspio-pricing-proxy-ab30a049961a.herokuapp.com/api/filter-products?category=T-Shirts&color=Red&minPrice=10&maxPrice=30&brand=Bella`

### Product Recommendations

- **URL**: `/api/recommendations`
- **Method**: `GET`
- **Query Parameters**:
  - `styleNumber` (required): Style number of the reference product
- **Description**: Get personalized product recommendations based on a reference product (similar category, brand, and price range)
- **Example**: `https://caspio-pricing-proxy-ab30a049961a.herokuapp.com/api/recommendations?styleNumber=PC61`

### Quick View

- **URL**: `/api/quick-view`
- **Method**: `GET`
- **Query Parameters**:
  - `styleNumber` (required): Style number of the product
- **Description**: Get lightweight product details for hover/modal views (essential fields only)
- **Example**: `https://caspio-pricing-proxy-ab30a049961a.herokuapp.com/api/quick-view?styleNumber=PC61`

### Product Comparison

- **URL**: `/api/compare-products`
- **Method**: `GET`
- **Query Parameters**:
  - `styles` (required): Comma-separated list of style numbers to compare
- **Description**: Compare multiple products side-by-side (requires at least 2 style numbers)
- **Example**: `https://caspio-pricing-proxy-ab30a049961a.herokuapp.com/api/compare-products?styles=PC61,3001C,5000`

### Inventory Table by Style and Color

- **URL**: `/api/sizes-by-style-color`
- **Method**: `GET`
- **Query Parameters**:
  - `styleNumber` (required): Style number of the product
  - `color` (required): Color name to filter results
- **Description**: Get inventory data in a tabular format with warehouses as rows and sizes as columns. Returns a structured response with style, color, sizes array, warehouses array (each with inventory quantities), size totals, and a grand total.
- **Example**: `https://caspio-pricing-proxy-ab30a049961a.herokuapp.com/api/sizes-by-style-color?styleNumber=PC61&color=Ash`

### Cart Sessions

- **URL**: `/api/cart-sessions`
- **Method**: `GET`, `POST`, `PUT`, `DELETE`
- **Description**: CRUD operations for cart sessions
- **Example**: `https://caspio-pricing-proxy-ab30a049961a.herokuapp.com/api/cart-sessions`

### Cart Items

- **URL**: `/api/cart-items`
- **Method**: `GET`, `POST`, `PUT`, `DELETE`
- **Description**: CRUD operations for cart items
- **Example**: `https://caspio-pricing-proxy-ab30a049961a.herokuapp.com/api/cart-items`

### Cart Item Sizes

- **URL**: `/api/cart-item-sizes`
- **Method**: `GET`, `POST`, `PUT`, `DELETE`
- **Description**: CRUD operations for cart item sizes
- **Example**: `https://caspio-pricing-proxy-ab30a049961a.herokuapp.com/api/cart-item-sizes`

### Customers

- **URL**: `/api/customers`
- **Method**: `GET`, `POST`, `PUT`, `DELETE`
- **Description**: CRUD operations for customers
- **Notes**: When creating a customer, the `Name` field is required. If using separate FirstName and LastName fields, ensure you combine them into a single Name field.
- **Example**: `https://caspio-pricing-proxy-ab30a049961a.herokuapp.com/api/customers`

### Orders

- **URL**: `/api/orders`
- **Method**: `GET`, `POST`, `PUT`, `DELETE`
- **Description**: CRUD operations for orders
- **Example**: `https://caspio-pricing-proxy-ab30a049961a.herokuapp.com/api/orders`

### Process Checkout (New)

- **URL**: `/api/process-checkout`
- **Method**: `POST`
- **Body Parameters**:
  - `sessionId` (required): The cart session ID
  - `customerId` (required): The customer ID
- **Description**: Process checkout using the client-side workaround. This endpoint gets all cart items for the session and creates an order without updating cart items with CartStatus='Ordered'. It avoids the 500 Internal Server Error that occurs when updating cart items.
- **Example**:
```json
POST https://caspio-pricing-proxy-ab30a049961a.herokuapp.com/api/process-checkout
Content-Type: application/json

{
    "sessionId": "sess_abcdef123456",
    "customerId": 1
}
```

### Pricing Matrix (New)

- **URL**: `/api/pricing-matrix`
- **Method**: `GET`, `POST`, `PUT`, `DELETE`
- **Description**: CRUD operations for pricing matrix records
- **Query Parameters for GET**:
  - `pricingMatrixID` (optional): Filter by pricing matrix ID
  - `sessionID` (optional): Filter by session ID
  - `styleNumber` (optional): Filter by style number
  - `color` (optional): Filter by color
  - `embellishmentType` (optional): Filter by embellishment type
- **Example GET**: `https://caspio-pricing-proxy-ab30a049961a.herokuapp.com/api/pricing-matrix`
- **Example GET by ID**: `https://caspio-pricing-proxy-ab30a049961a.herokuapp.com/api/pricing-matrix/1`
- **Example POST**:
```json
POST https://caspio-pricing-proxy-ab30a049961a.herokuapp.com/api/pricing-matrix
Content-Type: application/json

{
    "SessionID": "12321",
    "StyleNumber": "PC61",
    "Color": "BLACK",
    "EmbellishmentType": "EMBROIDERY",
    "TierStructure": "TEST TIER STRUCTURE",
    "SizeGroups": "TEST SIZE GROUPS",
    "PriceMatrix": "TEST PRICE MATRIX"
}
```

## Known Issues and Workarounds

### Customer Creation API Issue

When creating a customer, the API requires a `Name` field. If your application uses separate FirstName and LastName fields, you need to combine them into a single Name field before sending the request.

Example:
```javascript
// If you have separate FirstName and LastName fields
const customerData = {
    FirstName: "John",
    LastName: "Doe",
    Email: "john.doe@example.com"
};

// Add the Name field by combining FirstName and LastName
if (!customerData.Name && customerData.FirstName && customerData.LastName) {
    customerData.Name = `${customerData.FirstName} ${customerData.LastName}`;
}

// Now send the request with the Name field included
```

### Cart Item Update API Issue

When updating cart items with CartStatus="Ordered" and adding an OrderID, a 500 Internal Server Error occurs. To work around this issue, use the new `/api/process-checkout` endpoint, which creates an order without updating cart items.

Alternatively, you can use the client-side workaround implemented in the cart-integration.js file:

```javascript
// Instead of updating cart items, create a separate order record
async function createOrder(sessionId, items, customerId) {
    // Generate a unique order ID
    const orderId = 'ORD-' + Math.random().toString(36).substring(2, 10).toUpperCase();
    
    // Create order with minimal data
    const orderData = {
        CustomerID: customerId,
        OrderID: orderId,
        SessionID: sessionId
    };
    
    try {
        // Send to server
        const response = await fetch('/api/orders', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(orderData)
        });
        
        if (response.ok) {
            return { success: true, orderId: orderId };
        } else {
            // Handle error with local fallback
            return { success: false, fallback: true, orderId: orderId };
        }
    } catch (error) {
        // Handle error with local fallback
        return { success: false, fallback: true, orderId: orderId };
    }
}
```

## Testing with Postman

A Postman collection is available in the repository (`caspio-pricing-proxy-postman-collection.json`). Import this collection into Postman to test all the available endpoints.

## Development

### Environment Variables

The following environment variables are required:

- `CASPIO_ACCOUNT_DOMAIN`: The domain of your Caspio account
- `CASPIO_CLIENT_ID`: Your Caspio client ID
- `CASPIO_CLIENT_SECRET`: Your Caspio client secret

### Running Locally

1. Clone the repository
2. Install dependencies: `npm install`
3. Create a `.env` file with the required environment variables
4. Start the server: `node server.js`