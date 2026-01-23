# CRM API Security Architecture

**Version**: 1.0.0
**Created**: 2026-01-23
**Purpose**: Document server-to-server authentication for CRM endpoints

**See also:** For the complete three-layer security model (including Caspio authentication and Express sessions), see the frontend documentation:
`../Pricing Index File 2025/memory/CRM_DASHBOARD_AUTH.md`

---

## Architecture Overview

This document covers **Layer 3** of the CRM security model: server-to-server authentication.

### The Three-Layer Security Model

| Layer | Component | Purpose | Documented In |
|-------|-----------|---------|---------------|
| 1 | Caspio Authentication | User identity verification | Frontend: CRM_DASHBOARD_AUTH.md |
| 2 | Express Sessions + Roles | Authorization (who can access what) | Frontend: CRM_DASHBOARD_AUTH.md |
| **3** | **Server-to-Server Secret** | **API protection (this doc)** | **This file** |

The CRM endpoints (taneisha-accounts, nika-accounts, house-accounts) use **server-to-server authentication** with a shared secret. This prevents direct browser access while allowing the Pricing Index frontend server to proxy requests securely.

```
┌─────────┐     ┌──────────────────┐     ┌─────────────────────┐
│ Browser │────▶│ Pricing Index    │────▶│ caspio-pricing-proxy│
│         │     │ (sanmar-inventory│     │                     │
│         │     │  -app)           │     │ X-CRM-API-Secret    │
│         │     │                  │     │ header validated    │
└─────────┘     └──────────────────┘     └─────────────────────┘
```

## How It Works

1. **Browser** makes request to Pricing Index server (`/api/taneisha-accounts`)
2. **Pricing Index server** proxies to caspio-pricing-proxy with `X-CRM-API-Secret` header
3. **caspio-pricing-proxy** validates the secret before returning data
4. If secret is missing/invalid, returns `401 Unauthorized`

## Environment Variables Required

| App | Heroku App Name | Variable | Purpose |
|-----|-----------------|----------|---------|
| caspio-pricing-proxy | `caspio-pricing-proxy-ab30a049961a` | `CRM_API_SECRET` | Validates incoming requests |
| Pricing Index | `sanmar-inventory-app` | `CRM_API_SECRET` | Sends with proxy requests |

**Both apps must have the SAME secret value.**

### Setting the Secret

```bash
# On caspio-pricing-proxy
heroku config:set CRM_API_SECRET=your-secret-here -a caspio-pricing-proxy-ab30a049961a

# On Pricing Index (sanmar-inventory-app)
heroku config:set CRM_API_SECRET=your-secret-here -a sanmar-inventory-app
```

## Files Involved

### caspio-pricing-proxy (this repo)

| File | Purpose |
|------|---------|
| `src/middleware/index.js` | `requireCrmApiSecret` middleware function |
| `server.js:409-440` | Protected route registration |

### Pricing Index (sanmar-inventory-app)

| File | Purpose |
|------|---------|
| `server.js:570-587` | Proxy handler adds `X-CRM-API-Secret` header |

## Adding New Protected APIs

To add another CRM-style protected endpoint:

1. **Create the route file** in `src/routes/` (e.g., `new-accounts.js`)

2. **Apply middleware** in `server.js`:
   ```javascript
   const newAccountsRoutes = require('./src/routes/new-accounts');
   app.use('/api/new-accounts', requireCrmApiSecret, newAccountsRoutes);
   ```

3. **Add proxy handler** in Pricing Index `server.js`:
   ```javascript
   app.use('/api/new-accounts', createProxyMiddleware({
     target: 'https://caspio-pricing-proxy-ab30a049961a.herokuapp.com',
     changeOrigin: true,
     headers: {
       'X-CRM-API-Secret': process.env.CRM_API_SECRET
     }
   }));
   ```

4. **No new env vars needed** - reuses existing `CRM_API_SECRET`

## Security Model Q&A

### "Will adding another API connection cause security issues?"

**No** - the architecture is designed for this:
- All CRM-type endpoints share the same `CRM_API_SECRET`
- Just apply `requireCrmApiSecret` middleware to new routes
- The Pricing Index proxy automatically includes the secret for all `/api/*-accounts` routes

### "Can browsers access CRM endpoints directly?"

**No** - browsers don't have the secret:
- Direct calls to `caspio-pricing-proxy.../api/taneisha-accounts` return 401
- Only server-side code with the secret can access these endpoints

### "What if the secret is compromised?"

1. Generate a new secret
2. Update both Heroku apps simultaneously
3. Redeploy if needed (env var changes usually hot-reload)

## Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| "Unable to load accounts" toast | Missing `CRM_API_SECRET` on frontend app | `heroku config:set CRM_API_SECRET=...` on sanmar-inventory-app |
| "Server configuration error" (500) | Missing `CRM_API_SECRET` on API app | Set env var on caspio-pricing-proxy |
| "Unauthorized" in browser console | Secret mismatch between apps | Ensure both apps have identical secret value |
| Works locally but not in production | Forgot to set Heroku env vars | Check `heroku config` on both apps |

### Debugging Commands

```bash
# Check if secret is set on API
heroku config:get CRM_API_SECRET -a caspio-pricing-proxy-ab30a049961a

# Check if secret is set on frontend
heroku config:get CRM_API_SECRET -a sanmar-inventory-app

# Test endpoint directly (should fail without secret)
curl https://caspio-pricing-proxy-ab30a049961a.herokuapp.com/api/taneisha-accounts

# Test with secret (should succeed)
curl -H "X-CRM-API-Secret: YOUR_SECRET" \
  https://caspio-pricing-proxy-ab30a049961a.herokuapp.com/api/taneisha-accounts
```

## Related Documentation

**Frontend (Pricing Index):**
- [CRM Dashboard Auth](../Pricing%20Index%20File%202025/memory/CRM_DASHBOARD_AUTH.md) - Complete three-layer security (Caspio auth, sessions, roles)

**This project (caspio-pricing-proxy):**
- [Taneisha Accounts API](TANEISHA_ACCOUNTS_API.md)
- [Nika Accounts API](NIKA_ACCOUNTS_API.md)
- [House Accounts API](HOUSE_ACCOUNTS_API.md)
- [Rep Account Management](REP_ACCOUNT_MANAGEMENT.md)
