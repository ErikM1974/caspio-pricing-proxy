# Caspio Pricing Proxy - Claude AI Instructions

## Cross-Project Knowledge Hub

**For documentation spanning all 3 NWCA projects, see:**
- **[CROSS_PROJECT_HUB.md](../Pricing%20Index%20File%202025/memory/CROSS_PROJECT_HUB.md)** - Entry point for all projects
- **[GLOSSARY.md](../Pricing%20Index%20File%202025/memory/GLOSSARY.md)** - Shared terminology
- **[LESSONS_LEARNED.md](../Pricing%20Index%20File%202025/memory/LESSONS_LEARNED.md)** - Master lessons (all projects)

---

## Related Projects

This API server is consumed by two frontend projects:

| Project | Location | Relationship |
|---------|----------|--------------|
| **Pricing Index File 2025** | `../Pricing Index File 2025` | Primary frontend - quote builders, calculators consume all pricing APIs |
| **Python Inksoft** | `../Python Inksoft` | Uses `/api/designs/*` and `/api/gift-certificates/*` endpoints |

When modifying API endpoints, check if these projects need updates.

## ManageOrders API - Complete Reference

For **comprehensive ManageOrders documentation** (PULL + PUSH APIs), see the master file in the Pricing Index project:

**`../Pricing Index File 2025/memory/MANAGEORDERS_COMPLETE_REFERENCE.md`**

This is the single source of truth covering:
- All 7 PULL API endpoints with response schemas
- Complete PUSH API (ExternalOrderJson) structure
- 165+ field definitions
- Critical gotchas (id_Integration, tax flags, date formats)
- Real-world implementations (Staff Dashboard, Garment Tracker)

**Before committing**, if you discovered any ManageOrders patterns:
1. Add fields/endpoints → `MANAGEORDERS_COMPLETE_REFERENCE.md`
2. Add bugs/gotchas → `LESSONS_LEARNED.md` (both projects)

This ensures documentation stays current and nothing is forgotten.

---

## Memory Files

Detailed documentation organized by topic:

- **[LESSONS_LEARNED.md](memory/LESSONS_LEARNED.md)** - Past bugs and solutions (check first when debugging!)
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
- **[Git Workflow](memory/GIT_WORKFLOW.md)** - Branch strategy and deployment process (develop → main → Heroku)
- **[Gift Certificates API](memory/GIFT_CERTIFICATES_API.md)** - Gift certificate lookup and balance checking (v1.0.0 - 2025-12-18)
- **[Daily Sales Archive API](memory/DAILY_SALES_API.md)** - YTD tracking beyond ManageOrders 60-day limit (v1.0.0 - 2026-01-01)
- **[2026 Margin Update](memory/2026_MARGIN_UPDATE.md)** - Changed from 40% to 43% margin (0.6 → 0.57 denominator) - 2026-01-02
- **[Thread Colors API](memory/THREAD_COLORS_API.md)** - Thread color lookup for monogram form (v1.0.0 - 2026-01-08)
- **[Monograms API](memory/MONOGRAMS_API.md)** - CRUD endpoints for monogram orders (v1.0.0 - 2026-01-09)
- **[Garment Tracker API](memory/GARMENT_TRACKER_API.md)** - Pre-processed garment tracking for staff dashboard (v1.0.0 - 2026-01-09)
- **[Taneisha Accounts API](memory/TANEISHA_ACCOUNTS_API.md)** - CRM for Taneisha's 800 customer accounts (v1.0.0 - 2026-01-21)
- **[Nika Accounts API](memory/NIKA_ACCOUNTS_API.md)** - CRM for Nika's 407 customer accounts (v1.0.0 - 2026-01-22)
- **[Rep Account Management & Audit](memory/REP_ACCOUNT_MANAGEMENT.md)** - Reconcile, sync, and audit system for sales rep accounts (v1.0.0 - 2026-01-22)
- **[House Accounts API](memory/HOUSE_ACCOUNTS_API.md)** - Catch-all for non-sales-rep customers: Ruthie, House, Erik, Jim, Web (v1.0.0 - 2026-01-22)
- **[CRM Security](memory/CRM_SECURITY.md)** - Server-to-server authentication for CRM endpoints (v1.0.0 - 2026-01-23)
- **[API Security Guidelines](memory/API_SECURITY_GUIDELINES.md)** - When to use auth vs open endpoints (v1.0.0 - 2026-01-24)
- **[Sales Reps 2026 API](memory/SALES_REPS_2026_API.md)** - Master customer-to-sales-rep assignments (v1.0.0 - 2026-01-23)
- **[MCP Servers for Claude Desktop](memory/MCP_SERVERS.md)** - Setup guide and tools for chatting with account data (v1.1.0 - 2026-01-22)

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
  - Decorated Cap Prices - Pre-calculated cap prices by brand for "As low as" display
- **Product API** - Search, details, categories
- **Order API** - Orders, customers, dashboard
- **Inventory API** - Stock levels, sizes
- **Quotes API** - Analytics, items, sessions
- **Art Invoices API** - Full CRUD operations
- **Production Schedules API** - Production tracking
- **Thumbnail API** - `GET /api/thumbnails/by-design/:designId` - Look up design thumbnails (5-min cache)

### Integration APIs
- **ManageOrders API** ([Docs](memory/MANAGEORDERS_INTEGRATION.md)) - 11 endpoints for ERP data (customers, orders, payments, tracking, inventory)
- **ManageOrders PUSH API** ([Docs](memory/MANAGEORDERS_PUSH_INTEGRATION.md)) - Send orders TO OnSite for production
- **JDS Industries API** ([Docs](memory/JDS_INTEGRATION.md)) - Awards/engraving product integration
- **SanMar → ShopWorks API** ([Docs](memory/SANMAR_SHOPWORKS_API.md)) - Translate products to ShopWorks format
- **Designs API** - CRUD endpoints for InkSoft Transform store designs (5 endpoints)

## Recent Features

See the Memory Files section above for detailed documentation on each API. Key recent additions:
- **Garment Tracker API** - Staff dashboard optimization (Jan 2026)
- **Thread Colors API** - Monogram form support (Jan 2026)
- **Monograms API** - CRUD for monogram orders (Jan 2026)
- **Designs API** - InkSoft Transform store designs
- **Decorated Cap Prices API** - Pre-calculated "As low as" prices
- **API Usage Tracking** - 55-60% reduction achieved ✅

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

**Quick test**: `GET /api/admin/metrics` - API usage dashboard

See memory files for complete endpoint documentation.

## Important Notes

### Caspio Pagination
**CRITICAL**: Always use `fetchAllCaspioPages` instead of `makeCaspioRequest` for multi-record queries. Caspio API paginates results (max 1000 records per request). Failure to use `fetchAllCaspioPages` results in incomplete data.

Example: OGIO brand was missing because it was on page 2 when using `makeCaspioRequest`.

### Caching Strategy
Current caching (see [API Usage Tracking](memory/API_USAGE_TRACKING.md) for details):
- **Pricing bundle**: 15 minutes (high impact - saves 7-9 calls per request)
- **Product search**: 5 minutes (saves 2 calls per request)
- **New products/Top sellers/Quote sessions**: 5 minutes each
- **Decorated cap prices**: 5 minutes (saves 2 calls per request)
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
