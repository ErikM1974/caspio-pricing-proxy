# Message to Claude Pricing: New Products Management API

**Date:** 2025-10-28  
**From:** Caspio Pricing Proxy  
**To:** Claude Pricing Instance  
**Subject:** 3 New Endpoints for Managing Featured/New Products

---

## Overview

You now have access to 3 new endpoints for managing and displaying featured or "new" products dynamically. This allows you to mark products as new and query them without any database schema changes.

---

## Quick Start (3 Simple Steps)

### Step 1: One-Time Setup (Run Once)

Create the `IsNew` field in your products table:

```bash
POST https://caspio-pricing-proxy-ab30a049961a.herokuapp.com/api/admin/products/add-isnew-field
Content-Type: application/json

# No body needed
```

**Expected Response:**
```json
{
  "success": true,
  "message": "IsNew field created successfully",
  "fieldName": "IsNew"
}
```

**Note:** This endpoint is idempotent - safe to run multiple times.

---

### Step 2: Mark Products as New

Batch mark multiple products using their style numbers:

```bash
POST https://caspio-pricing-proxy-ab30a049961a.herokuapp.com/api/admin/products/mark-as-new
Content-Type: application/json

{
  "styles": ["EB120", "EB121", "PC54", "ST350", "OG734"]
}
```

**Important:** This updates ALL variants (colors, sizes) for each style.

---

### Step 3: Query New Products

Get products marked as new:

```bash
GET https://caspio-pricing-proxy-ab30a049961a.herokuapp.com/api/products/new?limit=10
```

---

## Full Documentation

See **memory/NEW_PRODUCTS_API.md** for complete documentation with all examples, error handling, and use cases.

**Production Base URL:**
https://caspio-pricing-proxy-ab30a049961a.herokuapp.com
