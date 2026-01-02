# 2026 Pricing Update Documentation

**Date**: January 2, 2026

## Changes Summary

| Update | Details |
|--------|---------|
| **Margin Increase** | 40% → 43% (denominator 0.6 → 0.57) |
| **DTG Costs** | +$0.50 across all print locations |
| **DTF Costs** | +$0.50 transfer, $2.00 → $2.50 labor |
| **Customer Impact** | ~5.3% price increase on garments |
| **Profit Impact** | ~$79K additional annual profit on $900K blank cost |

---

# Margin Update (40% → 43%)

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
- `scripts/update-margin-2026.js` - One-time margin update script
- `scripts/update-dtg-costs-2026.js` - One-time DTG costs update script
- `memory/BLANK_PRICING.md` - BLANK pricing documentation

---

# DTG Print Cost Update (January 2, 2026)

**Change**: +$0.50 increase to all DTG print costs
**Records Updated**: 20 (5 locations × 4 tiers)

## Summary

Updated the Caspio `DTG_Costs` table to add $0.50 to all `PrintCost` values across all print locations and quantity tiers.

## Updated DTG Print Costs

### Left Chest (LC)

| Tier | Old | New |
|------|-----|-----|
| 12-23 | $8.00 | **$8.50** |
| 24-47 | $7.00 | **$7.50** |
| 48-71 | $6.00 | **$6.50** |
| 72+ | $5.00 | **$5.50** |

### Full Front (FF)

| Tier | Old | New |
|------|-----|-----|
| 12-23 | $10.50 | **$11.00** |
| 24-47 | $9.50 | **$10.00** |
| 48-71 | $7.00 | **$7.50** |
| 72+ | $6.25 | **$6.75** |

### Full Back (FB)

| Tier | Old | New |
|------|-----|-----|
| 12-23 | $10.50 | **$11.00** |
| 24-47 | $9.50 | **$10.00** |
| 48-71 | $7.00 | **$7.50** |
| 72+ | $6.25 | **$6.75** |

### Jumbo Front (JF)

| Tier | Old | New |
|------|-----|-----|
| 12-23 | $12.50 | **$13.00** |
| 24-47 | $11.50 | **$12.00** |
| 48-71 | $9.00 | **$9.50** |
| 72+ | $8.25 | **$8.75** |

### Jumbo Back (JB)

| Tier | Old | New |
|------|-----|-----|
| 12-23 | $12.50 | **$13.00** |
| 24-47 | $11.50 | **$12.00** |
| 48-71 | $9.00 | **$9.50** |
| 72+ | $8.25 | **$8.75** |

## Affected Endpoints

| Endpoint | Auto-Updates? |
|----------|---------------|
| `/api/dtg-costs` | ✅ Yes |
| `/api/pricing-bundle?method=DTG` | ✅ Yes (15-min cache) |
| `/api/dtg/product-bundle` | ✅ Yes |

## Update Script

**File**: `scripts/update-dtg-costs-2026.js`

The script fetches all DTG_Costs records and adds $0.50 to each PrintCost:

```javascript
for (const record of toUpdate) {
  const newCost = record.PrintCost + 0.50;
  await makeCaspioRequest(
    'put',
    '/tables/DTG_Costs/records',
    { 'q.where': `PK_ID=${record.PK_ID}` },
    { PrintCost: newCost }
  );
}
```

## Rollback Instructions

To revert DTG costs (subtract $0.50):

```javascript
// Modify the script to subtract instead of add
const newCost = record.PrintCost - 0.50;
```

Or manually update values in Caspio UI.

---

# DTF Pricing Update (January 2, 2026)

**Changes**:
- Transfer costs: +$0.50 across all sizes/tiers
- Pressing labor: $2.00 → $2.50

**Records Updated**: 12 (3 sizes × 4 tiers)

## Updated DTF Pricing

### Small (Up to 5" x 5")

| Tier | Old Transfer | New Transfer | Labor |
|------|--------------|--------------|-------|
| 10-23 | $6.00 | **$6.50** | **$2.50** |
| 24-47 | $5.25 | **$5.75** | **$2.50** |
| 48-71 | $4.00 | **$4.50** | **$2.50** |
| 72+ | $3.25 | **$3.75** | **$2.50** |

### Medium (Up to 10" x 10")

| Tier | Old Transfer | New Transfer | Labor |
|------|--------------|--------------|-------|
| 10-23 | $9.50 | **$10.00** | **$2.50** |
| 24-47 | $8.25 | **$8.75** | **$2.50** |
| 48-71 | $6.50 | **$7.00** | **$2.50** |
| 72+ | $5.00 | **$5.50** | **$2.50** |

### Large (Up to 12" x 16")

| Tier | Old Transfer | New Transfer | Labor |
|------|--------------|--------------|-------|
| 10-23 | $14.50 | **$15.00** | **$2.50** |
| 24-47 | $12.50 | **$13.00** | **$2.50** |
| 48-71 | $10.00 | **$10.50** | **$2.50** |
| 72+ | $8.00 | **$8.50** | **$2.50** |

## Affected Endpoints

| Endpoint | Auto-Updates? |
|----------|---------------|
| `/api/pricing-bundle?method=DTF` | ✅ Yes (15-min cache) |

## Update Script

**File**: `scripts/update-dtf-pricing-2026.js`

## Rollback Instructions

To revert DTF costs:
- Transfer: subtract $0.50 from unit_price
- Labor: change PressingLaborCost back to 2.0
