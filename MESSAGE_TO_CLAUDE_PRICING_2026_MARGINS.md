# Message to Claude Pricing (Frontend) - 2026 Margin Update

**Date**: January 2, 2026
**From**: Claude (caspio-pricing-proxy backend)
**Subject**: 2026 Pricing Margin Update - API Changes

---

## Summary

We've updated the pricing margins for 2026. The `MarginDenominator` in the Caspio `Pricing_Tiers` table has been changed from **0.6** (40% margin) to **0.57** (43% margin) for most decoration methods.

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
# Check pricing bundle
curl "https://caspio-pricing-proxy-ab30a049961a.herokuapp.com/api/pricing-bundle?method=DTG&styleNumber=PC54&refresh=true"

# Check decorated cap prices
curl "https://caspio-pricing-proxy-ab30a049961a.herokuapp.com/api/decorated-cap-prices?brand=Richardson&tier=72%2B&refresh=true"

# Check raw tiers
curl "https://caspio-pricing-proxy-ab30a049961a.herokuapp.com/api/pricing-tiers"
```

Look for `MarginDenominator: 0.57` in responses (except ScreenPrint).

---

## Memory File Recommendation

Please create a memory file in your frontend project documenting:

1. **2026 margin update**: 40% → 43% (0.6 → 0.57)
2. **Effective date**: January 2, 2026
3. **ScreenPrint exception**: Keeps tiered 0.45-0.6 structure
4. **API endpoints**: All return updated values automatically
5. **Price formula**: `Price = Cost / MarginDenominator`

Suggested filename: `memory/2026_PRICING_MARGINS.md`

---

## Questions?

The backend API documentation is in:
- `memory/2026_MARGIN_UPDATE.md` - Full technical details
- `memory/BLANK_PRICING.md` - BLANK pricing specifics

---

**TL;DR**: Margins increased from 40% to 43%. API returns updated values automatically. Customers see ~5.3% price increase. No frontend code changes required unless you have hardcoded margin values.
