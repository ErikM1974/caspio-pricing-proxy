# API Security Guidelines

**Version**: 1.0.0
**Created**: 2026-01-24
**Purpose**: Document when to use authentication vs open endpoints

---

## Default Rule

**New endpoints are OPEN by default** unless they contain sensitive data.

Ask yourself: *"Would a competitor or bad actor benefit from accessing this data?"*

- **Yes** → Protect with `requireCrmApiSecret`
- **No** → Leave open

---

## Security Tiers

| Tier | Auth Required | Data Type | Examples |
|------|---------------|-----------|----------|
| **Public** | ❌ None | Catalog, pricing, product info | `/api/pricing/*`, `/api/products/*`, `/api/inventory/*` |
| **Session** | 🔶 Session ID | User-specific cart/quote data | `/api/cart/*`, `/api/quotes/*` |
| **Internal** | ✅ CRM Secret | PII, business intelligence, audit logs | `/api/*-accounts`, `/api/assignment-history` |

---

## What Requires Protection

Protect endpoints that expose:

1. **PII (Personally Identifiable Information)**
   - Customer names, emails, phone numbers
   - Contact details, addresses

2. **Business Intelligence**
   - Sales data, revenue figures
   - Rep performance metrics
   - Customer-to-rep assignments

3. **Internal Operations**
   - Audit trails (who changed what)
   - Assignment history
   - Sync/reconciliation data

---

## Currently Protected Endpoints

These use `requireCrmApiSecret` middleware:

```javascript
// In server.js
app.use('/api/taneisha-accounts', requireCrmApiSecret, tanieshaAccountsRoutes);
app.use('/api/nika-accounts', requireCrmApiSecret, nikaAccountsRoutes);
app.use('/api/house-accounts', requireCrmApiSecret, houseAccountsRoutes);
app.use('/api/sales-reps-2026', requireCrmApiSecret, salesReps2026Routes);
app.use('/api/assignment-history', requireCrmApiSecret, assignmentHistoryRoutes);
```

---

## Currently Open Endpoints

These are intentionally public:

- **Pricing** - Customers need to see prices
- **Products** - Catalog browsing
- **Inventory** - Stock availability
- **Cart/Quotes** - Shopping experience (session-based)
- **Thumbnails** - Image display
- **Health/Metrics** - Monitoring

---

## Adding New Endpoints

### Open Endpoint (Default)
```javascript
const newRoutes = require('./src/routes/new-feature');
app.use('/api/new-feature', newRoutes);
```

### Protected Endpoint (Sensitive Data)
```javascript
const { requireCrmApiSecret } = require('./src/middleware');
const sensitiveRoutes = require('./src/routes/sensitive-data');
app.use('/api/sensitive-data', requireCrmApiSecret, sensitiveRoutes);
```

---

## Postman Testing

For protected endpoints, add header:
```
X-CRM-API-Secret: {{CRM_SECRET}}
```

Set `CRM_SECRET` in your Postman environment variables.

---

## Related Documentation

- [CRM Security](CRM_SECURITY.md) - Full server-to-server auth details
- [Endpoint Creation Guide](ENDPOINT_CREATION_GUIDE.md) - How to create new endpoints
# Transfer/Supacolor boundary update (2026-09-08)

Pending the coordinated rollout in [the review checklist](PROXY_REVIEW_FIXES_2026_09_07.md),
all methods under `/api/transfer-orders`, `/api/transfer-order-notes` and
`/api/supacolor-jobs` require `X-CRM-API-Secret`. The three vision routes
`/api/vision/extract-supacolor`, `/api/vision/extract-supacolor-jobs-list` and
`/api/vision/extract-supacolor-job-detail` use the same boundary. The Pricing Index
browser calls its own staff-session relay; it never receives the secret.
Vendor portal requests keep their existing session and job-ownership checks.
Both Supacolor scheduler commands require the same CRM_API_SECRET configuration.
Deploy frontend relays/callers before these proxy gates. Do not use a permitted
Origin as proof of authentication.
