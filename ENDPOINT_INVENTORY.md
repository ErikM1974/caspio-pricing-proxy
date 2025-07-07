# API Endpoint Inventory

This document contains a comprehensive inventory of all API endpoints in the server.js file, organized by module.

## Summary Statistics
- **Total Endpoints**: 93
- **GET Endpoints**: 50
- **POST Endpoints**: 12
- **PUT Endpoints**: 11
- **DELETE Endpoints**: 11

## Table of Contents
1. [Health Check](#health-check)
2. [Pricing API](#pricing-api)
3. [Product API](#product-api)
4. [Inventory API](#inventory-api)
5. [Customer API](#customer-api)
6. [Art Requests API](#art-requests-api)
7. [Art Invoices API](#art-invoices-api)
8. [Cart API](#cart-api)
9. [Order API](#order-api)
10. [Pricing Matrix API](#pricing-matrix-api)
11. [Quote API](#quote-api)
12. [Production API](#production-api)
13. [Miscellaneous API](#miscellaneous-api)

---

## Health Check

| Method | Path | Line | Description |
|--------|------|------|-------------|
| GET | `/api/health` | 256 | Health check endpoint for monitoring server status |

## Pricing API

| Method | Path | Line | Description |
|--------|------|------|-------------|
| GET | `/api/pricing-tiers` | 302 | Retrieve pricing tiers from Caspio |
| GET | `/api/embroidery-costs` | 337 | Get embroidery cost information |
| GET | `/api/dtg-costs` | 370 | Get Direct-to-Garment (DTG) printing costs |
| GET | `/api/screenprint-costs` | 396 | Get screen printing costs |
| GET | `/api/pricing-rules` | 426 | Retrieve pricing rules and conditions |
| GET | `/api/pricing-bundle` | 457 | Get bundled pricing data (all pricing tables) |
| GET | `/api/base-item-costs` | 620 | Retrieve base item cost information |
| GET | `/api/size-upcharges` | 720 | Get size-based upcharge information |

## Product API

| Method | Path | Line | Description |
|--------|------|------|-------------|
| GET | `/api/stylesearch` | 760 | Search for product styles |
| GET | `/api/product-details` | 852 | Get detailed product information |
| GET | `/api/color-swatches` | 949 | Retrieve color swatch information |
| GET | `/api/products-by-brand` | 1088 | Get products filtered by brand |
| GET | `/api/products-by-category` | 1142 | Get products filtered by category |
| GET | `/api/products-by-subcategory` | 1184 | Get products filtered by subcategory |
| GET | `/api/all-brands` | 1226 | Get list of all available brands |
| GET | `/api/all-subcategories` | 1265 | Get list of all subcategories |
| GET | `/api/all-categories` | 1297 | Get list of all categories |
| GET | `/api/subcategories-by-category` | 1329 | Get subcategories for a specific category |
| GET | `/api/products-by-category-subcategory` | 1368 | Get products filtered by both category and subcategory |
| GET | `/api/search` | 1425 | General product search endpoint |
| GET | `/api/featured-products` | 1466 | Get featured products list |
| GET | `/api/related-products` | 1502 | Get related products for a given product |
| GET | `/api/filter-products` | 1565 | Advanced product filtering |
| GET | `/api/quick-view` | 1636 | Quick view product information |
| GET | `/api/compare-products` | 1686 | Compare multiple products |
| GET | `/api/recommendations` | 1735 | Get product recommendations |
| GET | `/api/sizes-by-style-color` | 1801 | Get available sizes for style/color combination |
| GET | `/api/prices-by-style-color` | 1917 | Get pricing for style/color combination |
| GET | `/api/product-variant-sizes` | 1988 | Get product variant size information |
| GET | `/api/max-prices-by-style` | 2075 | Get maximum prices for each style |
| GET | `/api/size-pricing` | 2182 | Get size-specific pricing information |
| GET | `/api/product-colors` | 5350 | Get product color information |

## Inventory API

| Method | Path | Line | Description |
|--------|------|------|-------------|
| GET | `/api/inventory` | 1055 | Retrieve inventory levels and availability |

## Customer API

| Method | Path | Line | Description |
|--------|------|------|-------------|
| GET | `/api/customers` | 2379 | Get list of customers |
| POST | `/api/customers` | 2427 | Create a new customer |
| PUT | `/api/customers/:id` | 2480 | Update customer information |
| DELETE | `/api/customers/:id` | 2521 | Delete a customer |

## Art Requests API

| Method | Path | Line | Description |
|--------|------|------|-------------|
| GET | `/api/artrequests` | 2558 | Get list of art requests |
| GET | `/api/artrequests/:id` | 2671 | Get specific art request by ID |
| POST | `/api/artrequests` | 2695 | Create a new art request |
| PUT | `/api/artrequests/:id` | 2733 | Update art request |
| DELETE | `/api/artrequests/:id` | 2774 | Delete art request |

## Art Invoices API

| Method | Path | Line | Description |
|--------|------|------|-------------|
| GET | `/api/art-invoices` | 2817 | Get list of art invoices |
| GET | `/api/art-invoices/:id` | 2880 | Get specific art invoice by ID |
| POST | `/api/art-invoices` | 2904 | Create a new art invoice |
| PUT | `/api/art-invoices/:id` | 2950 | Update art invoice |
| DELETE | `/api/art-invoices/:id` | 2991 | Delete art invoice |

## Cart API

### Cart Items
| Method | Path | Line | Description |
|--------|------|------|-------------|
| GET | `/api/cart-items` | 3033 | Get cart items |
| POST | `/api/cart-items` | 3087 | Add item to cart |
| PUT | `/api/cart-items/:id` | 3253 | Update cart item |
| DELETE | `/api/cart-items/:id` | 3335 | Remove item from cart |

### Cart Item Sizes
| Method | Path | Line | Description |
|--------|------|------|-------------|
| GET | `/api/cart-item-sizes` | 3378 | Get cart item sizes |
| POST | `/api/cart-item-sizes` | 3456 | Add cart item size |
| PUT | `/api/cart-item-sizes/:id` | 3605 | Update cart item size |
| DELETE | `/api/cart-item-sizes/:id` | 3656 | Delete cart item size |

### Cart Sessions
| Method | Path | Line | Description |
|--------|------|------|-------------|
| GET | `/api/cart-sessions` | 3699 | Get cart sessions |
| POST | `/api/cart-sessions` | 3744 | Create cart session |
| PUT | `/api/cart-sessions/:id` | 3803 | Update cart session |
| DELETE | `/api/cart-sessions/:id` | 3857 | Delete cart session |

### Cart Integration
| Method | Path | Line | Description |
|--------|------|------|-------------|
| GET | `/api/cart-integration.js` | 4174 | Get cart integration JavaScript |

## Order API

| Method | Path | Line | Description |
|--------|------|------|-------------|
| GET | `/api/orders` | 3900 | Get list of orders |
| POST | `/api/orders` | 3951 | Create a new order |
| PUT | `/api/orders/:id` | 4072 | Update order information |
| DELETE | `/api/orders/:id` | 4134 | Delete an order |
| POST | `/api/process-checkout` | 4248 | Process checkout and create order |
| GET | `/api/order-odbc` | 5602 | Get order data from ODBC source |
| GET | `/api/order-dashboard` | 5648 | Get order dashboard metrics |

## Pricing Matrix API

| Method | Path | Line | Description |
|--------|------|------|-------------|
| GET | `/api/pricing-matrix` | 4353 | Get pricing matrix data |
| GET | `/api/pricing-matrix/lookup` | 4405 | Lookup pricing in matrix |
| GET | `/api/pricing-matrix/:id` | 4460 | Get specific pricing matrix entry |
| POST | `/api/pricing-matrix` | 4488 | Create pricing matrix entry |
| PUT | `/api/pricing-matrix/:id` | 4545 | Update pricing matrix entry |
| DELETE | `/api/pricing-matrix/:id` | 4600 | Delete pricing matrix entry |

## Quote API

### Quote Analytics
| Method | Path | Line | Description |
|--------|------|------|-------------|
| GET | `/api/quote_analytics` | 4642 | Get quote analytics data |
| GET | `/api/quote_analytics/:id` | 4675 | Get specific quote analytics |
| POST | `/api/quote_analytics` | 4703 | Create quote analytics entry |
| PUT | `/api/quote_analytics/:id` | 4784 | Update quote analytics |
| DELETE | `/api/quote_analytics/:id` | 4845 | Delete quote analytics |

### Quote Items
| Method | Path | Line | Description |
|--------|------|------|-------------|
| GET | `/api/quote_items` | 4885 | Get quote items |
| GET | `/api/quote_items/:id` | 4918 | Get specific quote item |
| POST | `/api/quote_items` | 4946 | Create quote item |
| PUT | `/api/quote_items/:id` | 5015 | Update quote item |
| DELETE | `/api/quote_items/:id` | 5077 | Delete quote item |

### Quote Sessions
| Method | Path | Line | Description |
|--------|------|------|-------------|
| GET | `/api/quote_sessions` | 5117 | Get quote sessions |
| GET | `/api/quote_sessions/:id` | 5156 | Get specific quote session |
| POST | `/api/quote_sessions` | 5184 | Create quote session |
| PUT | `/api/quote_sessions/:id` | 5247 | Update quote session |
| DELETE | `/api/quote_sessions/:id` | 5310 | Delete quote session |

## Production API

| Method | Path | Line | Description |
|--------|------|------|-------------|
| GET | `/api/production-schedules` | 5555 | Get production schedule information |

## Miscellaneous API

| Method | Path | Line | Description |
|--------|------|------|-------------|
| GET | `/api/test-sanmar-bulk` | 678 | Test endpoint for SanMar bulk operations |
| GET | `/api/locations` | 694 | Get location information |
| GET | `/api/size-sort-order` | 740 | Get size sorting order configuration |

---

## Notes

1. **CRUD Operations**: Several modules support full CRUD operations (Create, Read, Update, Delete):
   - Customers
   - Art Requests
   - Art Invoices
   - Cart Items
   - Cart Item Sizes
   - Cart Sessions
   - Orders
   - Pricing Matrix
   - Quote Analytics
   - Quote Items
   - Quote Sessions

2. **Read-Only Endpoints**: Many endpoints are read-only, particularly in:
   - Pricing API
   - Product API
   - Inventory API
   - Production API

3. **Special Endpoints**:
   - `/api/health` - Server health monitoring
   - `/api/cart-integration.js` - Returns JavaScript code for cart integration
   - `/api/process-checkout` - Complex checkout processing logic
   - `/api/order-dashboard` - Pre-calculated metrics for UI dashboards

4. **Naming Conventions**:
   - Most endpoints use kebab-case (e.g., `/api/cart-items`)
   - Some older endpoints use underscore (e.g., `/api/quote_items`)
   - ID-based endpoints follow RESTful conventions (e.g., `/:id`)

5. **Middleware**:
   - All POST, PUT operations use `express.json()` middleware
   - DELETE operations typically don't require body parsing