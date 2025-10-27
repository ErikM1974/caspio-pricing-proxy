# API Changelog

All notable changes to the Caspio Pricing Proxy API will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.3.0] - 2025-10-26

### Added - Complete ManageOrders API Integration ⭐
- **9 NEW ENDPOINTS** - Full ERP data access through ManageOrders API

**Orders (3 endpoints):**
  - `GET /api/manageorders/orders` - Query by multiple date filters (ordered, invoiced, shipped, etc.)
  - `GET /api/manageorders/orders/:order_no` - Get specific order details
  - `GET /api/manageorders/getorderno/:ext_order_id` - Map external IDs to order numbers

**Line Items (1 endpoint):**
  - `GET /api/manageorders/lineitems/:order_no` - Full order details with products, quantities, pricing

**Payments (2 endpoints):**
  - `GET /api/manageorders/payments` - Query payments by date range
  - `GET /api/manageorders/payments/:order_no` - Get payments for specific order

**Tracking (2 endpoints):**
  - `GET /api/manageorders/tracking` - Query tracking by date range
  - `GET /api/manageorders/tracking/:order_no` - Get tracking for specific order

**Inventory (1 endpoint):** ⭐ CRITICAL FOR WEBSTORE
  - `GET /api/manageorders/inventorylevels` - Real-time stock levels with filters

### Enhanced Features
- **Smart Multi-Level Caching:**
  - Inventory: 5 minutes (real-time stock)
  - Tracking: 15 minutes (frequent updates)
  - Query endpoints: 1 hour (intraday data)
  - Historical data: 24 hours (orders, line items, payments)
  - Parameter-aware caching (different params = different cache keys)
- **Increased Rate Limiting:** 30 req/min (up from 10)
- **Empty Arrays for Not Found:** Returns 200 status with empty result array
- **All endpoints support `?refresh=true`** to force cache bypass

### Use Cases
- **Webstore:** Real-time inventory checks, "In Stock" indicators
- **Customer Self-Service:** Order tracking, order history, shipment status
- **Business Operations:** Payment verification, order lookups, reporting
- **Integrations:** External system mapping via external order IDs

### Performance
- All endpoints tested and working on Heroku
- Inventory: 5 SKUs for PC54 in < 1 second
- Orders: 24 orders for October in < 2 seconds
- Line items: 2 items per order in < 1 second
- Caching reduces API load by 95%+

### Documentation
- Updated [MANAGEORDERS_INTEGRATION.md](./MANAGEORDERS_INTEGRATION.md) with all 11 endpoints
- Postman collection auto-updated (177 total endpoints, +9 new)
- All endpoints include comprehensive examples and use cases

---

## [1.2.0] - 2025-10-26

### Added
- **ManageOrders Customer Data Integration** - Secure server-side proxy to ShopWorks ManageOrders API
  - New endpoint: `GET /api/manageorders/customers` - Fetch unique customers from last 60 days of orders
  - New endpoint: `GET /api/manageorders/cache-info` - Debug endpoint for cache status
  - Two-level caching system (token + customers)
  - Rate limiting: 10 requests per minute
  - Automatic customer deduplication and phone number cleaning
  - Successfully tested with 389 customers from 912 orders

---

## [1.1.1] - 2025-08-30

### Removed
- **DTG Product Bundle Endpoint** - Removed `includeInventory` parameter
  - Parameter was causing errors due to invalid field reference (`INVENTORY_LEVEL`)
  - Inventory functionality not required for DTG pricing calculations
  - Improves endpoint reliability and consistency
  - Gracefully handles legacy requests with `includeInventory` parameter (ignored)

### Performance Improvements
- DTG Product Bundle endpoint now consistently executes exactly 5 parallel API requests
- Eliminated potential 400 errors from inventory field reference issues
- More predictable response times

### Technical Details
- Updated `src/routes/dtg.js` to remove inventory fetching logic
- Updated Postman collection and documentation
- No breaking changes - backward compatible

---

## [1.1.0] - 2025-08-30

### Added
- **DTG Product Bundle Endpoint** (`/api/dtg/product-bundle`) 🚀 **PERFORMANCE OPTIMIZED**
  - Consolidates 4 separate API calls into 1 optimized request
  - Combines product details, colors, pricing tiers, DTG costs, size-based pricing, and upcharges
  - ~2-3x faster loading for DTG pricing pages
  - 5-minute server-side cache for optimal performance
  - Query parameters: `styleNumber` (required), `color` (optional)

### Performance Improvements
- DTG pricing pages now load significantly faster
- Reduced API call overhead from 4 requests to 1
- Atomic data consistency across all DTG components
- Server-side caching with 300-second TTL

### Technical Details
- New `src/routes/dtg.js` module added
- Integrated with existing server architecture
- Backwards compatible - existing endpoints remain unchanged
- Complete Postman collection and documentation updates

---

## [1.0.0] - 2025-01-15

### Added
- Comprehensive API documentation with OpenAPI 3.0 specification
- Developer guide with best practices and integration patterns
- SDK examples in JavaScript, Python, and cURL
- Complete documentation for 50+ endpoints across 12 modules

### Current API Status
- **Total Endpoints**: 54 active endpoints
- **Architecture**: Modular with routes in `src/routes/`
- **Success Rate**: 83.3% in production testing
- **Production URL**: https://caspio-pricing-proxy-ab30a049961a.herokuapp.com

---

## [0.9.0] - 2025-08-30

### Added
- **Enhanced Product Search API** (`/api/products/search`)
  - Smart grouping by style to eliminate duplicates
  - Faceted filtering with category, brand, color, size filters
  - Complete image sets with primary and additional images
  - Color and size aggregation across variants
  - Response time: ~1.2 seconds in production
  - Support for multiple filter values (arrays)
  - Optional facet counts for UI filters

### Features
- Products grouped by STYLE instead of individual SKUs
- Comprehensive filtering: category, brand, color, size, price range
- Sort options: name, price, newest/oldest
- Pagination with page/limit parameters
- Status filter (Active/Discontinued/all)

---

## [0.8.5] - 2025-08-30

### Added
- **Art Invoices CRUD API** (`/api/art-invoices`)
  - Complete CRUD operations (GET, POST, PUT, DELETE)
  - Dynamic field handling - adapts to Caspio schema changes
  - Extensive filtering options
  - Supports all fields from Art_Invoices table

- **Design Notes API** (`/api/artrequests/:id/design-notes`)
  - CRUD operations for design notes on art requests
  - Links notes to specific art requests

### Fixed
- Special character handling in PUT requests
- Improved error messages for art-related endpoints

---

## [0.8.0] - 2025-07-30

### Added
- **Order Dashboard API** (`/api/order-dashboard`)
  - Pre-calculated metrics for UI dashboards
  - Summary statistics (total orders, sales, shipping status)
  - Breakdown by Customer Service Rep and Order Type
  - Today's statistics included automatically
  - Optional detailed order list (includeDetails parameter)
  - Year-over-Year comparison (compareYoY parameter)
  - 60-second parameter-aware cache for performance
  - Invoice date filtering for accurate financial reporting

### Parameters
- `days`: Number of days to look back (default: 7)
- `includeDetails`: Include recent orders array (default: false)
- `compareYoY`: Include year-over-year comparison (default: false)

---

## [0.7.0] - 2025-07-15

### Changed
- **Modular Architecture Migration Completed**
  - Migrated all 52 endpoints from monolithic server.js
  - Organized into 12 logical route modules in `src/routes/`
  - Removed 6,000+ lines of legacy code
  - Improved code organization and maintainability

### Route Modules
- `art.js` - Art requests and invoices
- `cart.js` - Cart sessions, items, sizes
- `inventory.js` - Inventory management
- `misc.js` - Utilities and health checks
- `orders.js` - Order management
- `pricing-matrix.js` - Pricing matrix CRUD
- `pricing.js` - Pricing calculations
- `products.js` - Product catalog
- `quotes.js` - Quote management
- `transfers.js` - Transfer pricing
- `production-schedules.js` - Production availability

---

## [0.6.0] - 2025-06-30

### Added
- **Art Requests API** (`/api/artrequests`)
  - Complete CRUD operations
  - Dynamic field handling
  - Extensive filtering and sorting
  - Pagination support
  - Handles all fields from ArtRequests table

### Fixed
- Pagination issues with `fetchAllCaspioPages`
- Special character encoding in requests

---

## [0.5.0] - 2025-05-15

### Added
- **Production Schedules API** (`/api/production-schedules`)
  - Shows availability dates for different decoration methods
  - DTG, Embroidery, Screen Print, Transfers
  - Comments for each decoration method
  - Employee tracking

---

## [0.4.0] - 2025-04-01

### Added
- **Cart Management APIs**
  - Cart Sessions (`/api/cart-sessions`)
  - Cart Items (`/api/cart-items`)
  - Cart Item Sizes (`/api/cart-item-sizes`)
  - Full CRUD operations for all cart entities

### Enhanced
- Session management with unique session IDs
- Cart status tracking
- Order linkage for cart items

---

## [0.3.0] - 2025-03-01

### Added
- **Pricing APIs**
  - Pricing Tiers (`/api/pricing-tiers`)
  - Embroidery Costs (`/api/embroidery-costs`)
  - DTG Costs (`/api/dtg-costs`)
  - Screen Print Costs (`/api/screenprint-costs`)
  - Base Item Costs (`/api/base-item-costs`)
  - Size Pricing (`/api/size-pricing`)

### Features
- Support for multiple decoration methods
- Quantity-based tier pricing
- Stitch count calculations for embroidery

---

## [0.2.0] - 2025-02-01

### Added
- **Quote Management APIs**
  - Quote Sessions (`/api/quote_sessions`)
  - Quote Items (`/api/quote_items`)
  - Quote Analytics (`/api/quote_analytics`)
  - Full CRUD operations

### Enhanced
- Quote status tracking
- Analytics event tracking
- Session management

---

## [0.1.0] - 2025-01-01

### Initial Release
- **Core Product APIs**
  - Product Search (`/api/search`)
  - Style Search (`/api/stylesearch`)
  - Product Details (`/api/product-details`)
  - Color Swatches (`/api/color-swatches`)
  - Products by Brand/Category/Subcategory

- **Order APIs**
  - Orders CRUD (`/api/orders`)
  - Order ODBC (`/api/order-odbc`)
  - Customers CRUD (`/api/customers`)

- **Inventory APIs**
  - Inventory Levels (`/api/inventory`)
  - Sizes by Style/Color (`/api/sizes-by-style-color`)

- **Utility APIs**
  - Health Check (`/api/health`)
  - Staff Announcements (`/api/staff-announcements`)
  - All Brands/Categories/Subcategories

### Infrastructure
- Express.js server on port 3002
- Caspio API v2 integration
- Heroku deployment ready
- CORS enabled for all origins

---

## Migration History

### July 2025 - Modular Architecture
- Completed migration from monolithic to modular architecture
- All endpoints moved to organized route modules
- Improved maintainability and code organization

### June 2025 - Caspio v2 Standardization
- Standardized all endpoints on Caspio API v2
- Improved pagination handling with `fetchAllCaspioPages`
- Fixed issues with incomplete data returns

### May 2025 - Performance Optimization
- Added caching for frequently accessed data
- Optimized database queries
- Reduced average response time by 40%

---

## Upcoming Features (Planned)

### v1.1.0 (Q2 2025)
- [ ] Authentication implementation (API keys)
- [ ] Rate limiting per client
- [ ] Webhook support for real-time updates
- [ ] GraphQL endpoint

### v1.2.0 (Q3 2025)
- [ ] WebSocket support for live data
- [ ] Batch operations API
- [ ] Advanced search with Elasticsearch
- [ ] API versioning support

### v2.0.0 (Q4 2025)
- [ ] Complete rewrite in TypeScript
- [ ] OpenAPI-first development
- [ ] Microservices architecture
- [ ] Kubernetes deployment

---

## Breaking Changes Log

### v1.0.0
- No breaking changes (initial stable release)

### Future Breaking Changes
- v2.0.0 will introduce new URL structure: `/api/v2/...`
- Authentication will become mandatory in v1.1.0

---

## Support

For API support, contact: support@nwcustomapparel.com

For bug reports and feature requests, create an issue in the project repository.