# BLANK Pricing Documentation

## Overview

The BLANK decoration method is used for pricing blank garments (no decoration applied). This is for selling apparel items as-is without any printing, embroidery, or other decoration services.

**Endpoint:** `GET /api/pricing-bundle?method=BLANK`

**Heroku Production:** `https://caspio-pricing-proxy-ab30a049961a.herokuapp.com/api/pricing-bundle?method=BLANK`

---

## Key Characteristics

### What BLANK Pricing Includes:
- ✅ Pricing tiers (4 tiers: 1-23, 24-47, 48-71, 72+)
- ✅ Pricing rules (rounding method, margin denominator)
- ✅ Size-specific base costs (when styleNumber provided)
- ✅ Size upcharges (when styleNumber provided)

### What BLANK Pricing Excludes:
- ❌ No decoration costs (no DTG, embroidery, screenprint costs)
- ❌ No print locations (empty locations array)
- ❌ No cost fields in response (allDtgCostsR, allEmbroideryCostsR, etc.)

---

## Database Configuration

### Pricing_Rules Table
```
DecorationMethod: 'Blank'
RoundingMethod: 'HalfDollarCeil_Final'
```

### Pricing_Tiers Table
Four tiers with MarginDenominator=0.6:

| Tier | Label  | MinQuantity | MaxQuantity | MarginDenominator |
|------|--------|-------------|-------------|-------------------|
| 1    | 1-23   | 1           | 23          | 0.6               |
| 2    | 24-47  | 24          | 47          | 0.6               |
| 3    | 48-71  | 48          | 71          | 0.6               |
| 4    | 72+    | 72          | 999         | 0.6               |

---

## API Usage

### Basic Request (No Style)
Returns only tiers, rules, and empty locations array.

**Request:**
```bash
curl 'https://caspio-pricing-proxy-ab30a049961a.herokuapp.com/api/pricing-bundle?method=BLANK'
```

**Response:**
```json
{
  "tiersR": [
    {
      "PK_ID": 23,
      "TierID": 22,
      "DecorationMethod": "BLANK",
      "TierLabel": "1-23",
      "MinQuantity": 1,
      "MaxQuantity": 23,
      "MarginDenominator": 0.6,
      "TargetMargin": 0,
      "LTM_Fee": 0
    },
    // ... 3 more tiers
  ],
  "rulesR": {
    "RoundingMethod": "HalfDollarCeil_Final"
  },
  "locations": []
}
```

### Request with Style Number
Returns tiers, rules, sizes, and upcharges for a specific product.

**Request:**
```bash
curl 'https://caspio-pricing-proxy-ab30a049961a.herokuapp.com/api/pricing-bundle?method=BLANK&styleNumber=PC54'
```

**Response:**
```json
{
  "tiersR": [4 tiers],
  "rulesR": {
    "RoundingMethod": "HalfDollarCeil_Final"
  },
  "locations": [],
  "sizes": [
    {
      "size": "S",
      "price": 2.85,
      "sortOrder": 22
    },
    {
      "size": "M",
      "price": 2.85,
      "sortOrder": 23
    },
    // ... more sizes
  ],
  "sellingPriceDisplayAddOns": {
    "2XL": 2,
    "3XL": 3,
    "4XL": 4,
    // ... more upcharges
  }
}
```

---

## Implementation Details

### Code Location
File: `src/routes/pricing.js`

### Key Implementation Points

1. **Valid Methods Array (line 325)**
   ```javascript
   const validMethods = ['DTG', 'EMB', 'CAP', 'ScreenPrint', 'DTF', 'EMB-AL', 'CAP-AL', 'BLANK'];
   ```

2. **Method Mapping (line 339)**
   ```javascript
   'BLANK': 'Blank'
   ```
   Maps user-provided 'BLANK' to database value 'Blank'.

3. **Location Type Mapping (line 351)**
   ```javascript
   'BLANK': null
   ```
   Setting to `null` signals that no location query should be performed.

4. **Skip Location Query (lines 377-387)**
   ```javascript
   locationType ?
     fetchAllCaspioPages('/tables/location/records', {...}) :
     Promise.resolve([])
   ```
   Conditionally fetch locations only if locationType is not null.

5. **Cost Table Query (lines 444-447)**
   ```javascript
   case 'BLANK':
     // Blank products have no decoration costs
     costTableQuery = Promise.resolve([]);
     break;
   ```
   Return empty array instead of querying cost tables.

6. **Response Structure (lines 551-553)**
   ```javascript
   case 'BLANK':
     // Blank products don't need cost fields - only tiers, rules, and sizes
     break;
   ```
   Skip adding cost fields (allDtgCostsR, allEmbroideryCostsR, etc.) to response.

---

## Testing

### Local Testing (Port 3002)
```bash
# Test without style
curl 'http://localhost:3002/api/pricing-bundle?method=BLANK'

# Test with style
curl 'http://localhost:3002/api/pricing-bundle?method=BLANK&styleNumber=PC54'
```

### Production Testing (Heroku)
```bash
# Test without style
curl 'https://caspio-pricing-proxy-ab30a049961a.herokuapp.com/api/pricing-bundle?method=BLANK'

# Test with style
curl 'https://caspio-pricing-proxy-ab30a049961a.herokuapp.com/api/pricing-bundle?method=BLANK&styleNumber=PC54'
```

---

## Use Cases

### 1. Blank Garment Sales
Selling apparel items without any decoration:
- Corporate stores buying plain shirts for their own decoration
- Schools/organizations buying blanks for heat press
- Retail customers wanting plain clothing

### 2. Pricing Calculation
Calculate selling price for blank garments:
```
Selling Price = (Base Garment Cost + Size Upcharge) / MarginDenominator
Rounded using: HalfDollarCeil_Final method
```

Example for PC54 size XL (quantity 50):
- Base Cost: $2.85
- Size Upcharge: $0 (XL is standard size)
- Margin Denominator: 0.6 (for 48-71 tier)
- Raw Price: $2.85 / 0.6 = $4.75
- Rounded Price: $4.75 (no rounding needed)

---

## Error Handling

### Invalid Method
```bash
curl 'https://caspio-pricing-proxy-ab30a049961a.herokuapp.com/api/pricing-bundle?method=INVALID'
```
**Response:**
```json
{
  "error": "Invalid decoration method. Use one of: DTG, EMB, CAP, ScreenPrint, DTF, EMB-AL, CAP-AL, BLANK"
}
```

### Missing Method Parameter
```bash
curl 'https://caspio-pricing-proxy-ab30a049961a.herokuapp.com/api/pricing-bundle'
```
**Response:**
```json
{
  "error": "Decoration method is required"
}
```

---

## Version History

### v1.0.0 (November 1, 2025)
- ✅ Initial implementation of BLANK pricing support
- ✅ Added to pricing-bundle endpoint
- ✅ Deployed to Heroku production (v169)
- ✅ Tested and verified on both local and production
- ✅ Postman collection auto-updated

---

## Related Documentation

- [CLAUDE.md](../CLAUDE.md) - Main project documentation
- [API_DOCUMENTATION.md](API_DOCUMENTATION.md) - Complete API reference
- [src/routes/pricing.js](../src/routes/pricing.js) - Implementation code

---

## Questions & Support

For questions about BLANK pricing implementation, refer to:
1. This documentation
2. CLAUDE.md for general API patterns
3. Check git history for commit `007f130` (initial BLANK implementation)

**Deployed:** November 1, 2025
**Heroku Release:** v169
**Status:** ✅ Production Ready
