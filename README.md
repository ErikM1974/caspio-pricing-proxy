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