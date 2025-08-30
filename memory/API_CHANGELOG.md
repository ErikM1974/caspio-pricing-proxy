# API Changelog

All notable changes to the Caspio Pricing Proxy API will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0] - 2025-01-15

### Added
- Comprehensive API documentation with OpenAPI 3.0 specification
- Developer guide with best practices and integration patterns
- SDK examples in JavaScript, Python, and cURL
- Complete documentation for 50+ endpoints across 12 modules

### Current API Status
- **Total Endpoints**: 52 active endpoints
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