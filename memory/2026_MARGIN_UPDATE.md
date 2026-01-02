# 2026 Margin Update Documentation

**Date**: January 2, 2026
**Change**: Increased margin from 40% to 43%
**Impact**: 5.3% price increase to customers, ~$79K additional annual profit

## Summary

Updated the `Pricing_Tiers` table in Caspio to change the `MarginDenominator` from `0.6` (40% margin) to `0.57` (43% margin) for all decoration methods except ScreenPrint.

## Margin Math

The pricing formula is: **Price = Cost ÷ MarginDenominator**

| Margin % | You Keep | Denominator | Example ($5 cost) |
|----------|----------|-------------|-------------------|
| 40% | 60% | 0.60 | $8.33 |
| 43% | 57% | 0.57 | $8.77 |
| 45% | 55% | 0.55 | $9.09 |

### Price Increase Calculation

Going from 40% → 43% margin:
- Price increase = 0.60 ÷ 0.57 = **1.053 (5.3% increase)**
- Customer sees prices go up ~5.3%

### Profit Impact

Based on $900,000 annual blank garment cost:

| Margin | Revenue | Gross Profit | vs 40% |
|--------|---------|--------------|--------|
| 40% (old) | $1,500,000 | $600,000 | — |
| 43% (new) | $1,578,947 | $678,947 | **+$78,947** |

## What Was Updated

### Caspio Table: `Pricing_Tiers`

**Records updated**: 18 rows
**Field changed**: `MarginDenominator` from `0.6` to `0.57`

| DecorationMethod | TierIDs | Old Value | New Value |
|------------------|---------|-----------|-----------|
| EmbroideryShirts | 1-4 | 0.6 | **0.57** |
| DTG | 6-8 | 0.6 | **0.57** |
| EmbroideryCaps | 10-12 | 0.6 | **0.57** |
| DTF | 18-21 | 0.6 | **0.57** |
| BLANK | 22-25 | 0.6 | **0.57** |

### ScreenPrint (Unchanged)

ScreenPrint keeps its tiered margin structure:

| TierID | Quantity | MarginDenominator | Margin % |
|--------|----------|-------------------|----------|
| 13 | 13-36 | 0.45 | 55% |
| 14 | 37-71 | 0.50 | 50% |
| 15 | 72-144 | 0.55 | 45% |
| 16 | 145-576 | 0.60 | 40% |

## Code Changes

### 1. Dynamic Margin in Decorated Cap Prices

**File**: `src/routes/decorated-cap-prices.js`

Previously had hardcoded `0.6`:
```javascript
const decoratedPrice = Math.ceil((basePrice / 0.6) + embroideryCost);
```

Now queries `Pricing_Tiers` dynamically:
```javascript
// Query margin denominator for EmbroideryCaps at the specified tier
const marginTiers = await fetchAllCaspioPages('/tables/Pricing_Tiers/records', {
  'q.where': `DecorationMethod='EmbroideryCaps' AND TierLabel='${tier}'`,
  'q.select': 'MarginDenominator'
});

const marginDenominator = marginTiers.length > 0 && marginTiers[0].MarginDenominator
  ? marginTiers[0].MarginDenominator
  : 0.6;

const decoratedPrice = Math.ceil((basePrice / marginDenominator) + embroideryCost);
```

The API response now includes `marginDenominator` for transparency:
```json
{
  "brand": "Richardson",
  "tier": "72+",
  "marginDenominator": 0.57,
  "prices": { "112": 21, "115": 21, ... }
}
```

### 2. Update Script

**File**: `scripts/update-margin-2026.js`

One-time script that updated all Pricing_Tiers records:
```javascript
await makeCaspioRequest(
  'put',
  '/tables/Pricing_Tiers/records',
  { 'q.where': "MarginDenominator=0.6 AND DecorationMethod<>'ScreenPrint'" },
  { MarginDenominator: 0.57 }
);
```

## How Pricing Flows Through the System

```
Caspio Pricing_Tiers Table (MarginDenominator = 0.57)
        ↓
API endpoints query table dynamically
        ↓
Frontend receives margin value
        ↓
Prices calculated with 43% margin
```

### Endpoints Affected

| Endpoint | Auto-Updates? |
|----------|---------------|
| `/api/pricing-bundle` | ✅ Yes - queries Pricing_Tiers |
| `/api/pricing-tiers` | ✅ Yes - returns raw table data |
| `/api/decorated-cap-prices` | ✅ Yes - now queries dynamically |

## Rollback Instructions

If you need to revert to 40% margin:

```javascript
// Run this to change back to 0.6
const { makeCaspioRequest } = require('../src/utils/caspio');

await makeCaspioRequest(
  'put',
  '/tables/Pricing_Tiers/records',
  { 'q.where': "MarginDenominator=0.57 AND DecorationMethod<>'ScreenPrint'" },
  { MarginDenominator: 0.6 }
);
```

Or use the Caspio UI to manually update the `MarginDenominator` column.

## Future Margin Changes

To change margins in the future:

1. **Calculate new denominator**: `1 - (margin% / 100)`
   - 44% margin = 0.56
   - 45% margin = 0.55
   - 46% margin = 0.54

2. **Update Caspio** via script or UI:
   ```javascript
   await makeCaspioRequest(
     'put',
     '/tables/Pricing_Tiers/records',
     { 'q.where': "DecorationMethod<>'ScreenPrint'" },
     { MarginDenominator: 0.55 }  // New value
   );
   ```

3. **Clear caches** by calling endpoints with `?refresh=true`

## Related Files

- `src/routes/decorated-cap-prices.js` - Dynamic margin lookup
- `src/routes/pricing.js` - Main pricing endpoints
- `scripts/update-margin-2026.js` - One-time update script
- `memory/BLANK_PRICING.md` - BLANK pricing documentation
