# API Quick Reference

Quick reference for all Caspio Pricing Proxy API endpoints.

**Base URL**: `https://caspio-pricing-proxy-ab30a049961a.herokuapp.com/api`

## 🛒 Cart Management

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/cart-sessions` | List cart sessions |
| POST | `/cart-sessions` | Create cart session |
| PUT | `/cart-sessions/:id` | Update cart session |
| DELETE | `/cart-sessions/:id` | Delete cart session |
| GET | `/cart-items` | List cart items |
| POST | `/cart-items` | Add item to cart |
| PUT | `/cart-items/:id` | Update cart item |
| DELETE | `/cart-items/:id` | Remove cart item |
| GET | `/cart-item-sizes` | List item sizes |
| POST | `/cart-item-sizes` | Add item size |
| PUT | `/cart-item-sizes/:id` | Update item size |
| DELETE | `/cart-item-sizes/:id` | Remove item size |

## 🔍 Product Search & Details

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/products/search` | Enhanced product search with filters |
| GET | `/stylesearch` | Style number autocomplete |
| GET | `/product-details` | Get product details |
| GET | `/color-swatches` | Get color swatches for style |
| GET | `/product-colors` | Get colors for style |
| GET | `/products-by-brand` | Products by brand |
| GET | `/products-by-category` | Products by category |
| GET | `/products-by-subcategory` | Products by subcategory |
| GET | `/all-brands` | List all brands |
| GET | `/all-categories` | List all categories |
| GET | `/all-subcategories` | List all subcategories |
| GET | `/featured-products` | Get featured products |
| GET | `/related-products` | Get related products |
| GET | `/recommendations` | Get product recommendations |

## 💰 Pricing

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/pricing-tiers` | Get pricing tiers by method |
| GET | `/embroidery-costs` | Calculate embroidery cost |
| GET | `/dtg-costs` | Get DTG costs |
| GET | `/screenprint-costs` | Get screen print costs |
| GET | `/pricing-rules` | Get pricing rules |
| GET | `/base-item-costs` | Get base costs by style |
| GET | `/size-pricing` | Get size-based pricing |
| GET | `/max-prices-by-style` | Get max prices by style |

## 📦 Orders

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/orders` | List orders |
| POST | `/orders` | Create order |
| PUT | `/orders/:id` | Update order |
| DELETE | `/orders/:id` | Delete order |
| GET | `/order-dashboard` | Dashboard metrics |
| GET | `/order-odbc` | Order ODBC records |
| GET | `/customers` | List customers |
| POST | `/customers` | Create customer |
| PUT | `/customers/:id` | Update customer |
| DELETE | `/customers/:id` | Delete customer |

## 🎨 Art Requests & Invoices

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/artrequests` | List art requests |
| GET | `/artrequests/:id` | Get art request |
| POST | `/artrequests` | Create art request |
| PUT | `/artrequests/:id` | Update art request |
| DELETE | `/artrequests/:id` | Delete art request |
| GET | `/art-invoices` | List art invoices |
| GET | `/art-invoices/:id` | Get art invoice |
| POST | `/art-invoices` | Create art invoice |
| PUT | `/art-invoices/:id` | Update art invoice |
| DELETE | `/art-invoices/:id` | Delete art invoice |

## 📊 Quotes

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/quote_sessions` | List quote sessions |
| GET | `/quote_sessions/:id` | Get quote session |
| POST | `/quote_sessions` | Create quote session |
| PUT | `/quote_sessions/:id` | Update quote session |
| DELETE | `/quote_sessions/:id` | Delete quote session |
| GET | `/quote_items` | List quote items |
| GET | `/quote_items/:id` | Get quote item |
| POST | `/quote_items` | Create quote item |
| PUT | `/quote_items/:id` | Update quote item |
| DELETE | `/quote_items/:id` | Delete quote item |
| GET | `/quote_analytics` | List analytics |
| POST | `/quote_analytics` | Create analytics event |

## 📅 Production

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/production-schedules` | Get production schedules |

## 📦 Inventory

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/inventory` | Get inventory levels |
| GET | `/sizes-by-style-color` | Get available sizes |
| GET | `/product-variant-sizes` | Get variant sizes |
| GET | `/prices-by-style-color` | Get prices by style/color |

## 💸 Pricing Matrix

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/pricing-matrix` | List pricing matrices |
| GET | `/pricing-matrix/lookup` | Lookup pricing matrix |
| GET | `/pricing-matrix/:id` | Get pricing matrix |
| POST | `/pricing-matrix` | Create pricing matrix |
| PUT | `/pricing-matrix/:id` | Update pricing matrix |
| DELETE | `/pricing-matrix/:id` | Delete pricing matrix |

## 🎨 Transfers

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/transfers/lookup` | Get transfer price |
| GET | `/transfers/matrix` | Get pricing matrix |
| GET | `/transfers/sizes` | Get available sizes |
| GET | `/transfers/price-types` | Get price types |
| GET | `/transfers/quantity-ranges` | Get quantity ranges |
| GET | `/transfers` | List transfers |

## 🔧 Utility

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/health` | Health check |
| GET | `/status` | API status |
| GET | `/staff-announcements` | Get announcements |
| GET | `/compare-products` | Compare products |
| GET | `/filter-products` | Filter products |
| GET | `/quick-view` | Product quick view |

---

## Common Query Parameters

### Pagination
- `limit` - Max results (default: 100, max: 1000)
- `page` - Page number
- `pageSize` - Results per page

### Filtering (Caspio)
- `q.where` - SQL-like filter (e.g., `Status='Active'`)
- `q.orderBy` - Sort order (e.g., `Date DESC`)
- `q.limit` - Max results

### Product Search
- `q` - Search query
- `category` - Filter by category (accepts arrays)
- `brand` - Filter by brand (accepts arrays)
- `color` - Filter by color (accepts arrays)
- `size` - Filter by size (accepts arrays)
- `minPrice` - Minimum price
- `maxPrice` - Maximum price
- `status` - Product status (Active/Discontinued/all)
- `sort` - Sort order (name_asc, price_asc, newest, etc.)
- `includeFacets` - Include filter counts

### Order Dashboard
- `days` - Days to look back (default: 7)
- `includeDetails` - Include order details
- `compareYoY` - Include year-over-year comparison

---

## Response Formats

### Success Response
```json
{
  "data": [...] // or single object
}
```

### Error Response
```json
{
  "error": "ErrorType",
  "message": "Error description",
  "errorId": "err_12345"
}
```

### Paginated Response
```json
{
  "data": [...],
  "pagination": {
    "page": 1,
    "limit": 25,
    "totalPages": 10,
    "totalRecords": 250
  }
}
```

---

## Status Codes

| Code | Meaning |
|------|---------|
| 200 | Success |
| 201 | Created |
| 400 | Bad Request |
| 404 | Not Found |
| 500 | Server Error |

---

## Examples

### Create Cart Session
```bash
curl -X POST https://caspio-pricing-proxy-ab30a049961a.herokuapp.com/api/cart-sessions \
  -H "Content-Type: application/json" \
  -d '{"SessionID": "session_123", "IsActive": true}'
```

### Search Products
```bash
curl "https://caspio-pricing-proxy-ab30a049961a.herokuapp.com/api/products/search?q=polo&category=Polos&limit=10"
```

### Get Order Dashboard
```bash
curl "https://caspio-pricing-proxy-ab30a049961a.herokuapp.com/api/order-dashboard?days=30&includeDetails=true"
```

### Get Production Schedule
```bash
curl "https://caspio-pricing-proxy-ab30a049961a.herokuapp.com/api/production-schedules?q.orderBy=Date%20DESC&q.limit=5"
```