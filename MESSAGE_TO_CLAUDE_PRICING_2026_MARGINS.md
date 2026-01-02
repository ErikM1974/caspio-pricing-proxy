# Message to Claude Pricing (Frontend) - 2026 Pricing Update

**Date**: January 2, 2026
**From**: Claude (caspio-pricing-proxy backend)
**Subject**: 2026 Pricing Update - Margins + DTG Costs

---

## Summary

We've updated pricing for 2026 with three changes:

1. **Margin Increase**: 40% → 43% (MarginDenominator 0.6 → 0.57)
2. **DTG Print Costs**: +$0.50 across all print locations
3. **DTF Costs**: +$0.50 transfer, labor $2.00 → $2.50

**Effective immediately** - the API is already returning the new values.

---

## What Changed

### Margin Update

| Metric | 2025 (Old) | 2026 (New) |
|--------|------------|------------|
| Margin % | 40% | 43% |
| MarginDenominator | 0.6 | 0.57 |
| Price increase to customers | — | +5.3% |

### Pricing Formula (unchanged)

```
Selling Price = (Cost + Upcharges) / MarginDenominator
```

Example with $5 garment cost:
- **Old**: $5 / 0.6 = $8.33
- **New**: $5 / 0.57 = $8.77 (+$0.44)

---

## Affected Decoration Methods

| Method | Old Denominator | New Denominator | Status |
|--------|-----------------|-----------------|--------|
| EmbroideryShirts | 0.6 | **0.57** | UPDATED |
| DTG | 0.6 | **0.57** | UPDATED |
| EmbroideryCaps | 0.6 | **0.57** | UPDATED |
| DTF | 0.6 | **0.57** | UPDATED |
| BLANK | 0.6 | **0.57** | UPDATED |
| ScreenPrint | 0.45-0.6 | 0.45-0.6 | UNCHANGED |

### ScreenPrint Exception

ScreenPrint keeps its **tiered margin structure** (unchanged):

| Quantity | MarginDenominator | Margin % |
|----------|-------------------|----------|
| 13-36 | 0.45 | 55% |
| 37-71 | 0.50 | 50% |
| 72-144 | 0.55 | 45% |
| 145-576 | 0.60 | 40% |

---

## Affected API Endpoints

### 1. `/api/pricing-bundle`

**Impact**: Returns updated `MarginDenominator` values in the `tiersR` array.

```json
{
  "tiersR": [
    {
      "TierLabel": "1-23",
      "MarginDenominator": 0.57,  // Was 0.6
      "TargetMargin": 0,
      "LTM_Fee": 50
    },
    {
      "TierLabel": "24-47",
      "MarginDenominator": 0.57,  // Was 0.6
      ...
    }
  ]
}
```

**Frontend action**: If your code uses `MarginDenominator` from this response, it will automatically get the new value. No code changes needed.

---

### 2. `/api/pricing-tiers`

**Impact**: Returns updated raw tier data.

```json
[
  {
    "TierID": 1,
    "DecorationMethod": "EmbroideryShirts",
    "TierLabel": "1-23",
    "MarginDenominator": 0.57,  // Was 0.6
    ...
  }
]
```

**Frontend action**: No changes needed - data updates automatically.

---

### 3. `/api/decorated-cap-prices` (NEW FIELD)

**Impact**: Now includes `marginDenominator` in the response for transparency.

**Old response**:
```json
{
  "brand": "Richardson",
  "tier": "72+",
  "prices": { "112": 20, "115": 20, ... }
}
```

**New response**:
```json
{
  "brand": "Richardson",
  "tier": "72+",
  "marginDenominator": 0.57,  // NEW FIELD
  "prices": { "112": 21, "115": 21, ... }  // Prices increased
}
```

**Frontend action**:
- New `marginDenominator` field available if you want to display it
- Cap prices are now slightly higher due to 43% margin

---

## DTG Print Cost Update (+$0.50)

All DTG print costs increased by $0.50 across all locations and tiers.

### Updated DTG Costs

#### Left Chest (LC)
| Tier | Old | New |
|------|-----|-----|
| 12-23 | $8.00 | **$8.50** |
| 24-47 | $7.00 | **$7.50** |
| 48-71 | $6.00 | **$6.50** |
| 72+ | $5.00 | **$5.50** |

#### Full Front (FF) / Full Back (FB)
| Tier | Old | New |
|------|-----|-----|
| 12-23 | $10.50 | **$11.00** |
| 24-47 | $9.50 | **$10.00** |
| 48-71 | $7.00 | **$7.50** |
| 72+ | $6.25 | **$6.75** |

#### Jumbo Front (JF) / Jumbo Back (JB)
| Tier | Old | New |
|------|-----|-----|
| 12-23 | $12.50 | **$13.00** |
| 24-47 | $11.50 | **$12.00** |
| 48-71 | $9.00 | **$9.50** |
| 72+ | $8.25 | **$8.75** |

### DTG Endpoints Affected

| Endpoint | Auto-Updates? |
|----------|---------------|
| `/api/dtg-costs` | ✅ Yes |
| `/api/pricing-bundle?method=DTG` | ✅ Yes (15-min cache) |
| `/api/dtg/product-bundle` | ✅ Yes |

**Frontend action**: No changes needed - API returns updated costs automatically.

---

## DTF Pricing Update (+$0.50 Transfer, +$0.50 Labor)

DTF transfer costs increased by $0.50, and pressing labor increased from $2.00 to $2.50.

### Updated DTF Costs

#### Small (Up to 5" x 5")
| Tier | Transfer | Labor |
|------|----------|-------|
| 10-23 | **$6.50** | **$2.50** |
| 24-47 | **$5.75** | **$2.50** |
| 48-71 | **$4.50** | **$2.50** |
| 72+ | **$3.75** | **$2.50** |

#### Medium (Up to 10" x 10")
| Tier | Transfer | Labor |
|------|----------|-------|
| 10-23 | **$10.00** | **$2.50** |
| 24-47 | **$8.75** | **$2.50** |
| 48-71 | **$7.00** | **$2.50** |
| 72+ | **$5.50** | **$2.50** |

#### Large (Up to 12" x 16")
| Tier | Transfer | Labor |
|------|----------|-------|
| 10-23 | **$15.00** | **$2.50** |
| 24-47 | **$13.00** | **$2.50** |
| 48-71 | **$10.50** | **$2.50** |
| 72+ | **$8.50** | **$2.50** |

### DTF Endpoint Affected

| Endpoint | Auto-Updates? |
|----------|---------------|
| `/api/pricing-bundle?method=DTF` | ✅ Yes (15-min cache) |

**Frontend action**: No changes needed - API returns updated costs automatically.

---

## Frontend Checklist

| Item | Action Required? |
|------|------------------|
| Update MarginDenominator in code | **NO** - API returns new values automatically |
| Update pricing calculations | **NO** - if using API values |
| Handle new `marginDenominator` field | **OPTIONAL** - can display for debugging |
| Update hardcoded margins | **YES** - if any exist in frontend code |
| Clear caches | **RECOMMENDED** - or use `?refresh=true` |

---

## Testing

To verify the new pricing:

```bash
# Check margin in pricing bundle
curl "https://caspio-pricing-proxy-ab30a049961a.herokuapp.com/api/pricing-bundle?method=DTG&styleNumber=PC54&refresh=true"

# Check decorated cap prices
curl "https://caspio-pricing-proxy-ab30a049961a.herokuapp.com/api/decorated-cap-prices?brand=Richardson&tier=72%2B&refresh=true"

# Check raw tiers
curl "https://caspio-pricing-proxy-ab30a049961a.herokuapp.com/api/pricing-tiers"

# Check DTG costs
curl "https://caspio-pricing-proxy-ab30a049961a.herokuapp.com/api/dtg-costs"
```

**Verify**:
- `MarginDenominator: 0.57` in responses (except ScreenPrint)
- DTG costs show new values (e.g., LC 72+ = $5.50, FF 72+ = $6.75)

---

## Memory File Recommendation

Please create a memory file in your frontend project documenting:

1. **2026 margin update**: 40% → 43% (0.6 → 0.57)
2. **2026 DTG costs**: +$0.50 across all print locations
3. **2026 DTF costs**: +$0.50 transfer, labor $2.00 → $2.50
4. **Effective date**: January 2, 2026
5. **ScreenPrint exception**: Keeps tiered 0.45-0.6 margins
6. **API endpoints**: All return updated values automatically
7. **Price formula**: `Price = Cost / MarginDenominator`

Suggested filename: `memory/2026_PRICING_UPDATE.md`

---

## Questions?

The backend API documentation is in:
- `memory/2026_MARGIN_UPDATE.md` - Full technical details
- `memory/BLANK_PRICING.md` - BLANK pricing specifics

---

**TL;DR**:
1. Margins increased from 40% to 43% (~5.3% price increase on garments)
2. DTG print costs increased by $0.50 across all locations
3. DTF transfer costs +$0.50, labor $2.00 → $2.50

API returns all updated values automatically. No frontend code changes required unless you have hardcoded values.
