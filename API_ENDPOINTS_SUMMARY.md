# API Endpoints Summary

## Consolidated Endpoint

### GET /api/pricing-bundle
Consolidates multiple pricing-related data into a single response.

**Parameters:**
- `method` (required): Decoration method (currently only "DTG" supported)
- `styleNumber` (optional): Style number for size-specific data

**Response Structure:**
```json
{
  "tiersR": [...],              // Pricing tiers
  "rulesR": {...},              // Pricing rules
  "allDtgCostsR": [...],        // DTG print costs
  "locations": [...],           // Print locations with codes and names
  "sizes": [...],               // Size-specific data (when styleNumber provided)
  "sellingPriceDisplayAddOns": {...}  // Size upcharges (when styleNumber provided)
}
```

**Example:**
- Basic: `/api/pricing-bundle?method=DTG`
- With style: `/api/pricing-bundle?method=DTG&styleNumber=PC61`

## Individual Endpoints

### GET /api/locations
Returns all print locations.

**Parameters:**
- `type` (optional): Filter by type (e.g., "DTG", "CAP")

**Example:**
- All locations: `/api/locations`
- DTG only: `/api/locations?type=DTG`

### GET /api/size-upcharges
Returns standard size upcharges.

**Example:** `/api/size-upcharges`

### GET /api/size-sort-order
Returns size display order for proper sorting.

**Example:** `/api/size-sort-order`

## Data Sources

The endpoints pull from these Caspio tables:
- `Pricing_Tiers` - Quantity-based pricing tiers
- `Pricing_Rules` - Pricing calculation rules
- `DTG_Costs` - Print costs by location and tier
- `location` - Print location definitions
- `Standard_Size_Upcharges` - Size-based price additions
- `Size_Display_Order` - Proper sort order for sizes
- `Sanmar_Bulk_251816_Feb2024` - Style and size pricing data

## Benefits

1. **Performance**: Single API call instead of multiple calls
2. **Caching**: Easier to cache consolidated responses
3. **Consistency**: All related data in one response
4. **Flexibility**: Individual endpoints available when needed