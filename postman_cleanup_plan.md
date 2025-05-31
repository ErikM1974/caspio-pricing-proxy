# Postman Collection Cleanup and Organization Plan

This document outlines the plan for cleaning up and organizing the "Caspio Pricing Proxy API" Postman collection, based on the analysis of API usage and future growth considerations.

## 1. API Usage Analysis Summary

Based on the provided information and `server.js` review:

*   **APIs Currently Being Used (by the application):** These are the core APIs actively consumed by the current application. They will be clearly marked in the Postman collection.
*   **APIs Not Currently Being Used (by the application, but implemented in `server.js`):** These APIs are present in the server-side code but are not actively called by the current application. Per user's decision, these will be retained in `server.js` for future growth and included in the Postman collection without a "Used" marker.

The `/api/image-proxy` endpoint will be ignored for this cleanup.

## 2. Postman Collection Organization

The Postman collection will be restructured into logical folders, and each API endpoint will be renamed for clarity. Endpoints explicitly listed as "APIs Currently Being Used" in the initial prompt will have a `(Used)` suffix in their name.

### Proposed Folder Structure and Naming Convention

*   **Folders (Categories):**
    *   `Health & Utility`
    *   `Cart Management`
    *   `Customer Management`
    *   `Order Management`
    *   `Pricing & Costs`
    *   `Product Catalog & Search`
    *   `Sanmar Data Access`

*   **Endpoint Naming Convention:** `[Action] [Resource] /api/[path]` (e.g., `Get Cart Sessions /api/cart-sessions`). For actively consumed APIs, a `(Used)` suffix will be added (e.g., `Get Cart Sessions /api/cart-sessions (Used)`).

```mermaid
graph TD
    A[Caspio Pricing Proxy API Collection] --> B(Health & Utility)
    A --> C(Cart Management)
    A --> D(Customer Management)
    A --> E(Order Management)
    A --> F(Pricing & Costs)
    A --> G(Product Catalog & Search)
    A --> H(Sanmar Data Access)

    B --> B1[Get Status /status]
    B --> B2[Serve Cart Integration Script /api/cart-integration.js (Used)]

    C --> C1[Get Cart Sessions /api/cart-sessions (Used)]
    C --> C2[Create Cart Session /api/cart-sessions (Used)]
    C --> C3[Update Cart Session by ID /api/cart-sessions/:id (Used)]
    C --> C4[Delete Cart Session by ID /api/cart-sessions/:id (Used)]
    C --> C5[Get Cart Items /api/cart-items (Used)]
    C --> C6[Add Item to Cart /api/cart-items (Used)]
    C --> C7[Update Cart Item by ID /api/cart-items/:id (Used)]
    C --> C8[Delete Cart Item by ID /api/cart-items/:id (Used)]
    C --> C9[Get Cart Item Sizes /api/cart-item-sizes (Used)]
    C --> C10[Add Size Details to Cart Item /api/cart-item-sizes (Used)]
    C --> C11[Update Size Details of Cart Item by ID /api/cart-item-sizes/:id (Used)]
    C --> C12[Delete Size Details of Cart Item by ID /api/cart-item-sizes/:id (Used)]
    C --> C13[Process Checkout /api/process-checkout]

    D --> D1[Get Customers /api/customers (Used)]
    D --> D2[Create Customer /api/customers (Used)]
    D --> D3[Update Customer by ID /api/customers/:id (Used)]
    D --> D4[Delete Customer by ID /api/customers/:id]

    E --> E1[Get Orders /api/orders (Used)]
    E --> E2[Create Order /api/orders (Used)]
    E3[Update Order by ID /api/orders/:id (Used)]
    E4[Delete Order by ID /api/orders/:id]
    E --> E3
    E --> E4

    F --> F1[Get Pricing Matrices /api/pricing-matrix (Used)]
    F --> F2[Lookup Pricing Matrix ID /api/pricing-matrix/lookup (Used)]
    F --> F3[Get Specific Pricing Matrix by ID /api/pricing-matrix/:id (Used)]
    F --> F4[Create Pricing Matrix /api/pricing-matrix (Used)]
    F --> F5[Update Pricing Matrix by ID /api/pricing-matrix/:id (Used)]
    F --> F6[Delete Pricing Matrix by ID /api/pricing-matrix/:id]
    F --> F7[Get Pricing Tiers /api/pricing-tiers]
    F --> F8[Get Embroidery Costs /api/embroidery-costs]
    F --> F9[Get DTG Costs /api/dtg-costs]
    F --> F10[Get Screenprint Costs /api/screenprint-costs]
    F --> F11[Get Pricing Rules /api/pricing-rules]
    F --> F12[Get Base Item Costs /api/base-item-costs]
    F --> F13[Get Max Prices for Sizes of Style /api/max-prices-by-style]
    F --> F14[Get Detailed Size Pricing for Style /api/size-pricing]

    G --> G1[Search Styles for Autocomplete /api/stylesearch]
    G --> G2[Get Product Details /api/product-details]
    G --> G3[Get Color Swatches for Style /api/color-swatches]
    G --> G4[Get Products by Brand /api/products-by-brand]
    G --> G5[Get Products by Category /api/products-by-category]
    G --> G6[Get Products by Subcategory /api/products-by-subcategory]
    G --> G7[Get All Brands /api/all-brands]
    G --> G8[Get All Subcategories /api/all-subcategories]
    G --> G9[Get All Categories /api/all-categories]
    G --> G10[Get Subcategories for Category /api/subcategories-by-category]
    G --> G11[Get Products by Category and Subcategory /api/products-by-category-subcategory]
    G --> G12[Perform General Product Search /api/search]
    G --> G13[Get Featured (New) Products /api/featured-products]
    G --> G14[Get Related Products for Style /api/related-products]
    G --> G15[Filter Products /api/filter-products]
    G --> G16[Get Product Details for Quick View /api/quick-view]
    G --> G17[Get Products for Comparison /api/compare-products]
    G --> G18[Get Product Recommendations /api/recommendations]
    G --> G19[Get Available Sizes for Style/Color /api/sizes-by-style-color]
    G --> G20[Get Prices for Sizes of Style/Color /api/prices-by-style-color]
    G --> G21[Get Product Colors /api/product-colors]

    H --> H1[Test SanMar Bulk Data Access /api/test-sanmar-bulk]
```

## 3. Testing Endpoints Locally

To ensure the endpoints are working as expected and to provide confidence in the setup, a sample of endpoints will be tested locally.

**Approach:**

1.  **Start the local server:** The `server.js` application will be running locally (typically on `http://localhost:3000`).
2.  **Sample Testing:** A representative sample of endpoints from each category will be selected and requests will be made to them. This will confirm that the endpoints are functional and that the data retrieval from Caspio is working correctly. This testing will be performed manually or using existing test scripts, rather than creating a new dedicated script within this planning phase.

## 4. Implementation Phase

Once this plan is approved, the next step will be to switch to a different mode (e.g., "Code" mode) to implement the changes in the `caspio-pricing-proxy-postman-collection.json` file. No changes are required for `server.js` at this stage, as all existing APIs are being retained.