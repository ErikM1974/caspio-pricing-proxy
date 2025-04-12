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