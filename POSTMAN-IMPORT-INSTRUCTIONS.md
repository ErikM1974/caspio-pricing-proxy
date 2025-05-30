# Caspio Pricing Proxy - Postman Collection

This repository includes a Postman collection file (`caspio-pricing-proxy-postman-collection.json`) that contains all the API endpoints for the Caspio Pricing Proxy application deployed on Heroku.

## How to Import the Collection into Postman

1.  **Open Postman**: Launch the Postman application on your computer.

2.  **Import the Collection**:
    *   Click on the "Import" button in the top left corner of the Postman interface.
    *   In the Import dialog, select the "File" tab.
    *   Click "Upload Files" and select the `caspio-pricing-proxy-postman-collection.json` file.
    *   Click "Import" to complete the process.

3.  **Using the Collection**:
    *   The collection will appear in your Postman Collections sidebar.
    *   Expand the collection to see all the available API endpoints.
    *   Each endpoint is pre-configured with the correct URL and query parameters.
    *   You can click on any endpoint to view its details and send a request.

## Available Endpoints

The collection includes the following endpoints:

-   **/status**: Checks API status.
-   **/api/pricing-tiers**: Gets pricing tiers.
-   **/api/pricing-tiers-caps**: Gets pricing tiers for caps.
-   **/api/embroidery-costs**: Gets embroidery costs.
-   **/api/dtg-costs**: Gets DTG costs.
-   **/api/screenprint-costs**: Gets screenprint costs.
-   **/api/pricing-rules**: Gets pricing rules.
-   **/api/base-item-costs**: Gets base item costs.
-   **/api/test-sanmar-bulk**: Tests SanMar bulk data access.
-   **/api/stylesearch**: Searches styles for autocomplete.
-   **/api/product-details**: Gets product details.
-   **/api/color-swatches**: Gets color swatches for a style.
-   **/api/inventory**: Gets inventory levels for a style/color.
-   **/api/products-by-brand**: Gets products by brand.
-   **/api/products-by-category**: Gets products by category.
-   **/api/products-by-subcategory**: Gets products by subcategory.
-   **/api/all-brands**: Gets all brands.
-   **/api/all-subcategories**: Gets all subcategories.
-   **/api/all-categories**: Gets all categories.
-   **/api/subcategories-by-category**: Gets subcategories for a category.
-   **/api/products-by-category-subcategory**: Gets products by category and subcategory.
-   **/api/search**: Performs a general product search.
-   **/api/featured-products**: Gets featured (new) products.
-   **/api/related-products**: Gets related products for a style.
-   **/api/filter-products**: Filters products based on multiple criteria.
-   **/api/quick-view**: Gets product details for quick view.
-   **/api/compare-products**: Gets products for comparison.
-   **/api/recommendations**: Gets product recommendations.
-   **/api/sizes-by-style-color**: Gets available sizes for a style/color.
-   **/api/prices-by-style-color**: Gets prices for sizes of a style/color.
-   **/api/max-prices-by-style**: Gets max prices for sizes of a style.
-   **/api/size-pricing**: Gets detailed size pricing for a style.
-   **/api/customers**: Gets customers.
-   **/api/customers (POST)**: Creates a customer.
-   **/api/customers/:id (PUT)**: Updates a customer.
-   **/api/customers/:id (DELETE)**: Deletes a customer.
-   **/api/cart-items**: Gets cart items.
-   **/api/cart-items (POST)**: Adds an item to cart.
-   **/api/cart-items/:id (PUT)**: Updates a cart item.
-   **/api/cart-items/:id (DELETE)**: Deletes a cart item.
-   **/api/cart-item-sizes**: Gets sizes for a cart item.
-   **/api/cart-item-sizes (POST)**: Adds size details to a cart item.
-   **/api/cart-item-sizes/:id (PUT)**: Updates size details of a cart item.
-   **/api/cart-item-sizes/:id (DELETE)**: Deletes size details of a cart item.
-   **/api/cart-sessions**: Gets cart sessions.
-   **/api/cart-sessions (POST)**: Creates a cart session.
-   **/api/cart-sessions/:id (PUT)**: Updates a cart session.
-   **/api/cart-sessions/:id (DELETE)**: Deletes a cart session.
-   **/api/orders**: Gets orders.
-   **/api/orders (POST)**: Creates an order.
-   **/api/orders/:id (PUT)**: Updates an order.
-   **/api/orders/:id (DELETE)**: Deletes an order.
-   **/api/cart-integration.js**: Serves cart integration script.
-   **/cart-integration.js**: Redirects to cart integration script.
-   **/api/process-checkout (POST)**: Processes checkout.
-   **/api/pricing-matrix**: Gets pricing matrices.
-   **/api/pricing-matrix/lookup**: Looks up a pricing matrix ID.
-   **/api/pricing-matrix/:id**: Gets a specific pricing matrix.
-   **/api/pricing-matrix (POST)**: Creates a pricing matrix.
-   **/api/pricing-matrix/:id (PUT)**: Updates a pricing matrix.
-   **/api/pricing-matrix/:id (DELETE)**: Deletes a pricing matrix.

## Base URL

All endpoints use the following base URL:
\`\`\`
https://caspio-pricing-proxy-ab30a049961a.herokuapp.com
\`\`\`

You can update this URL in the collection variables if the application URL changes in the future.