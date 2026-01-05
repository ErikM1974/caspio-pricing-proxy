# URGENT: Add Nike Tall Sizes to SIZE_MAPPING

## Problem
Sample order submission is failing with Nike polo tall sizes.

**Error:**
```
Invalid size: "2XLT". Not found in size mapping.
Valid sizes include: S, SM, Small, SMALL, M, MD, Medium... (52 total)
```

**Failed Order Line Items:**
- NKDC1963 (Nike Dri-Fit Micro Pique 2.0 Polo) - Size: 2XLT ❌
- NKDC1963 - Size: 3XLT ❌
- NKDC1963 - Size: 4XLT ❌

## Solution Required

**File:** `config/manageorders-push-config.js`
**Location:** After line 121 (after the S/M and L/XL cap sizes)

**Add these 5 Nike tall sizes:**

```javascript
  // Tall sizes (Nike and other athletic brands)
  'LT': 'LT',         // Large Tall - OnSite modifier: _LT
  'XLT': 'XLT',       // XL Tall - OnSite modifier: _XLT
  '2XLT': '2XLT',     // 2XL Tall - OnSite modifier: _2XLT
  '3XLT': '3XLT',     // 3XL Tall - OnSite modifier: _3XLT
  '4XLT': '4XLT',     // 4XL Tall - OnSite modifier: _4XLT
```

## ShopWorks Configuration

User is adding these to ShopWorks Size Translation Table:
- Webstore Size: LT → OnSite Modifier: _LT
- Webstore Size: XLT → OnSite Modifier: _XLT
- Webstore Size: 2XLT → OnSite Modifier: _2XLT
- Webstore Size: 3XLT → OnSite Modifier: _3XLT
- Webstore Size: 4XLT → OnSite Modifier: _4XLT

This will map part numbers like:
- NKDC1963 + 2XLT → NKDC1963_2XLT (OnSite inventory part number)

## Expected Result

After adding these 5 mappings:
- Valid sizes increase from 52 → 57
- Nike tall sizes will be accepted ✅
- Orders will successfully import to ShopWorks OnSite ✅

## Please:
1. Add the 5 tall size mappings to SIZE_MAPPING
2. Deploy to production
3. Confirm when complete

