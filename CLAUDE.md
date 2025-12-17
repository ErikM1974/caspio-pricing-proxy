# Caspio Pricing Proxy - Claude AI Instructions

## Memory Files

Detailed documentation organized by topic:

- **[API Usage Tracking & Monitoring](memory/API_USAGE_TRACKING.md)** - Real-time API call tracking, caching strategy, metrics endpoint (v1.1.0 - Updated 2025-12-17)
- **[Local Development Setup](memory/LOCAL_DEVELOPMENT.md)** - WSL configuration, testing procedures, port management, troubleshooting
- **[Endpoint Creation Guide](memory/ENDPOINT_CREATION_GUIDE.md)** - Step-by-step guide for adding new API endpoints, pagination best practices
- **[ManageOrders Integration](memory/MANAGEORDERS_INTEGRATION.md)** - Customer data API proxy with caching (11 endpoints)
- **[ManageOrders PUSH API](memory/MANAGEORDERS_PUSH_INTEGRATION.md)** - Send orders TO OnSite ERP with auto-import
- **[Online Store Developer Guide](memory/ONLINE_STORE_DEVELOPER_GUIDE.md)** - Complete guide for building webstore integration
- **[New Products Management API](memory/NEW_PRODUCTS_API.md)** - Mark and query featured/new products dynamically
- **[BLANK Pricing](memory/BLANK_PRICING.md)** - Blank garment pricing without decoration
- **[SanMar → ShopWorks Import API](memory/SANMAR_SHOPWORKS_QUICKSTART.md)** - Translate SanMar products to ShopWorks inventory format ([Full Docs](memory/SANMAR_SHOPWORKS_API.md))
- **[Image Loading Troubleshooting](memory/IMAGE_LOADING_TROUBLESHOOTING.md)** - Diagnose slow images and Sanmar CDN issues
- **[JDS Industries Integration](memory/JDS_INTEGRATION.md)** - Awards/engraving product integration

## Quick Reference

### Essential Configuration
- **Local Port**: 3002 (see [Local Development Guide](memory/LOCAL_DEVELOPMENT.md) for WSL setup)
- **Production**: Heroku auto-assigns port via `process.env.PORT`
- **Routes**: Add new endpoints to `/src/routes` folder
- **Pagination**: ALWAYS use `fetchAllCaspioPages` (not `makeCaspioRequest`) for multi-record queries

### Claude Workflow Rules
1. Read relevant files and create plan
2. Write plan with todo items
3. Verify plan with user before implementing
4. Mark todos as complete while working
5. Keep changes simple - minimize code impact
6. Provide high-level explanations at each step

## Local Development

**WSL Testing**: Cannot use `localhost` from Windows - must use WSL IP address
**Get IP**: `hostname -I | awk '{print $1}'`
**Start Server**: `PORT=3002 node server.js`

See [Local Development Guide](memory/LOCAL_DEVELOPMENT.md) for complete setup instructions, testing procedures, and troubleshooting.

## Creating New Endpoints

Quick process:
1. Get Caspio Swagger response
2. Choose endpoint path (kebab-case, RESTful)
3. Select query parameters (where/orderBy/limit recommended)
4. Choose response format (array or transformed object)
5. **Critical**: Use `fetchAllCaspioPages` for pagination

See [Endpoint Creation Guide](memory/ENDPOINT_CREATION_GUIDE.md) for complete step-by-step instructions and examples.

## API Features

### Core APIs
- **Cart API** - Sessions, items, sizes
- **Pricing API** - Tiers, costs, rules, bundles
  - BLANK Pricing ([Docs](memory/BLANK_PRICING.md)) - Blank garments without decoration
- **Product API** - Search, details, categories
- **Order API** - Orders, customers, dashboard
- **Inventory API** - Stock levels, sizes
- **Quotes API** - Analytics, items, sessions
- **Art Invoices API** - Full CRUD operations
- **Production Schedules API** - Production tracking

### Integration APIs
- **ManageOrders API** ([Docs](memory/MANAGEORDERS_INTEGRATION.md)) - 11 endpoints for ERP data (customers, orders, payments, tracking, inventory)
- **ManageOrders PUSH API** ([Docs](memory/MANAGEORDERS_PUSH_INTEGRATION.md)) - Send orders TO OnSite for production
- **JDS Industries API** ([Docs](memory/JDS_INTEGRATION.md)) - Awards/engraving product integration
- **SanMar → ShopWorks API** ([Docs](memory/SANMAR_SHOPWORKS_API.md)) - Translate products to ShopWorks format

## Recent Features

### API Usage Tracking & Monitoring (v1.1.0 - Updated 2025-12-17) ✅ SUCCESS
Real-time tracking and caching reduced Caspio API usage from 630K → ~280K calls/month
- **Metrics Endpoint**: `/api/admin/metrics` - Real-time usage dashboard
- **Automatic Tracking**: All API calls logged via `api-tracker.js` utility
- **Caching**: Pricing bundle (15min), product search (5min), new products (5min), top sellers (5min), quote sessions (5min)
- **Actual Impact**: **55-60% reduction achieved** (exceeded 30-40% target)

See [API Usage Tracking Guide](memory/API_USAGE_TRACKING.md) for complete documentation.

### New Products Management API (v1.4.0)
Mark and query featured/"new" products dynamically
- `GET /api/products/new` - Query new products (5-min cache)
- `POST /api/admin/products/mark-as-new` - Batch mark products
- `POST /api/admin/products/add-isnew-field` - One-time setup

See [New Products API Docs](memory/NEW_PRODUCTS_API.md) for examples and usage.

### ManageOrders Integration (v1.3.0)
Complete ERP integration with 11 endpoints for customers, orders, payments, tracking, and inventory
- Smart multi-level caching (5min to 24hr)
- Rate limiting: 30 requests/minute
- Critical for webstore: Inventory levels, order tracking, payments

See [ManageOrders Integration Guide](memory/MANAGEORDERS_INTEGRATION.md) for all endpoints and examples.

### ManageOrders PUSH API (v1.0.1)
Send orders FROM webstore TO ShopWorks OnSite for production
- Auto-imported hourly into OnSite Order Entry
- Automatic date conversion (YYYY-MM-DD → MM/DD/YYYY)
- Size translation (L → LG in OnSite)
- Design support via ImageURL

See [ManageOrders PUSH Guide](memory/MANAGEORDERS_PUSH_INTEGRATION.md) and [Online Store Developer Guide](memory/ONLINE_STORE_DEVELOPER_GUIDE.md) for complete integration instructions.

### Order Dashboard API
Pre-calculated metrics for UI dashboards
- Summary metrics (orders, sales, shipping)
- Breakdowns by CSR and Order Type
- Year-over-Year comparison (optional)
- 60-second parameter-aware cache

**Endpoint**: `GET /api/order-dashboard?days=7&includeDetails=false&compareYoY=false`
**Note**: Filters by `date_OrderInvoiced` (not `date_OrderPlaced`) for accurate financial reporting

### BLANK Pricing
Blank garments without decoration (no printing, embroidery, etc.)
- **Endpoint**: `GET /api/pricing-bundle?method=BLANK&styleNumber=PC54`
- Returns tiers, rules, sizes, upcharges (no decoration costs)
- Rounding: HalfDollarCeil_Final, Margin: 0.6

See [BLANK Pricing Docs](memory/BLANK_PRICING.md) for implementation details.

## Documentation

### API Documentation
- [API Documentation](memory/API_DOCUMENTATION.md) - Comprehensive endpoint docs with examples
- [OpenAPI Specification](memory/API_SPECIFICATION.yaml) - Complete OpenAPI 3.0 spec
- [Developer Guide](memory/DEVELOPER_GUIDE.md) - Best practices, integration patterns
- [API Changelog](memory/API_CHANGELOG.md) - Version history
- [Quick Reference](memory/API_QUICK_REFERENCE.md) - Quick endpoint reference
- [Endpoint Inventory](memory/API_ENDPOINTS.md) - Complete list of all 52 endpoints

### Code Examples
- [JavaScript Examples](examples/javascript/examples.js) - Node.js/JavaScript SDK
- [Python Examples](examples/python/examples.py) - Python SDK
- [cURL Examples](examples/curl/examples.sh) - Command-line examples

## Environment Variables

Required for local development (`.env` file):

```bash
# Caspio API
CASPIO_ACCOUNT_ID=your_account_id
CASPIO_CLIENT_ID=your_client_id
CASPIO_CLIENT_SECRET=your_client_secret

# Server
PORT=3002
NODE_ENV=development

# ManageOrders (optional)
MANAGEORDERS_USERNAME=your_username
MANAGEORDERS_PASSWORD=your_password
```

## Production URLs

**Base URL**: `https://caspio-pricing-proxy-ab30a049961a.herokuapp.com`

**Key Endpoints**:
```bash
# API Usage Metrics
GET /api/admin/metrics

# Pricing
GET /api/pricing-bundle?method=DTG&styleNumber=PC54
GET /api/pricing-bundle?method=BLANK&styleNumber=PC54

# Products
GET /api/products/search?q=PC54&limit=10
GET /api/products/new?limit=10

# Orders
GET /api/order-dashboard?days=7
GET /api/manageorders/orders/138145

# Inventory
GET /api/manageorders/inventorylevels?PartNumber=PC54
```

## Important Notes

### Caspio Pagination
**CRITICAL**: Always use `fetchAllCaspioPages` instead of `makeCaspioRequest` for multi-record queries. Caspio API paginates results (max 1000 records per request). Failure to use `fetchAllCaspioPages` results in incomplete data.

Example: OGIO brand was missing because it was on page 2 when using `makeCaspioRequest`.

### Caching Strategy
Current caching (see [API Usage Tracking](memory/API_USAGE_TRACKING.md) for details):
- **Pricing bundle**: 15 minutes (high impact - saves 7-9 calls per request)
- **Product search**: 5 minutes (saves 2 calls per request)
- **New products/Top sellers/Quote sessions**: 5 minutes each
- **Cache bypass**: Add `?refresh=true` to any cached endpoint

### API Usage Monitoring (Updated Dec 2025)
- **Before caching**: 630K calls/month (26% over 500K limit)
- **After caching**: ~280K calls/month projected (**55-60% reduction achieved**)
- **Current period**: 196K used (Day 21/30) - well under 500K limit
- **Monitor**: `GET /api/admin/metrics` for real-time tracking
- **Status**: ✅ HEALTHY - no action needed

## Troubleshooting

### Common Issues
| Issue | Solution |
|-------|----------|
| WSL can't connect from Windows | Use WSL IP (`hostname -I`), not localhost |
| Incomplete data returned | Use `fetchAllCaspioPages`, not `makeCaspioRequest` |
| High API usage | Check `/api/admin/metrics` and add caching |
| Server won't start | Check port 3002 with `lsof -i :3002` |

See [Local Development Guide](memory/LOCAL_DEVELOPMENT.md) for complete troubleshooting.

## Getting Help

- **Local Development**: [LOCAL_DEVELOPMENT.md](memory/LOCAL_DEVELOPMENT.md)
- **Creating Endpoints**: [ENDPOINT_CREATION_GUIDE.md](memory/ENDPOINT_CREATION_GUIDE.md)
- **API Usage**: [API_USAGE_TRACKING.md](memory/API_USAGE_TRACKING.md)
- **Full Documentation**: All memory files linked at top of this file
