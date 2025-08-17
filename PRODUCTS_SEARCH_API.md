# Enhanced Product Search API

## Overview

The Enhanced Product Search API provides a powerful, Google-like search experience for the Northwest Custom Apparel product catalog. This endpoint aggregates products by style, provides rich filtering options, and returns comprehensive product data suitable for modern e-commerce catalog pages.

## Endpoint Details

### Base URL
- **Production**: `https://caspio-pricing-proxy-ab30a049961a.herokuapp.com/api/products/search`
- **Development**: `http://localhost:3002/api/products/search`

### Method
`GET`

### Authentication
None required (public endpoint)

## Query Parameters

| Parameter | Type | Default | Description | Example |
|-----------|------|---------|-------------|---------|
| `q` | string | - | Search query for text matching across style, title, description, keywords, and brand | `q=polo shirt` |
| `category` | string/array | - | Filter by category names | `category=Polos/Knits` or `category=Polos/Knits,T-Shirts` |
| `subcategory` | string/array | - | Filter by subcategory | `subcategory=Ladies,Youth` |
| `brand` | string/array | - | Filter by brand names | `brand=OGIO,Port Authority` |
| `color` | string/array | - | Filter by color names | `color=Black,Navy,White` |
| `size` | string/array | - | Filter by available sizes | `size=S,M,L,XL` |
| `minPrice` | number | - | Minimum price filter | `minPrice=10.00` |
| `maxPrice` | number | - | Maximum price filter | `maxPrice=50.00` |
| `status` | string | `Active` | Product status filter (`Active`, `Discontinued`, `all`) | `status=Active` |
| `isTopSeller` | boolean | - | Filter for top sellers only | `isTopSeller=true` |
| `sort` | string | `name_asc` | Sort order (see sorting options below) | `sort=price_asc` |
| `page` | number | `1` | Page number | `page=2` |
| `limit` | number | `24` | Results per page (max: 100) | `limit=48` |
| `includeFacets` | boolean | `false` | Include aggregation counts for filters | `includeFacets=true` |

### Sorting Options

| Value | Description |
|-------|-------------|
| `name_asc` | Product name A-Z (default) |
| `name_desc` | Product name Z-A |
| `price_asc` | Price low to high |
| `price_desc` | Price high to low |
| `newest` | Recently updated first |
| `style` | Style number ascending |

## Response Format

### Success Response (200 OK)

```json
{
  "success": true,
  "data": {
    "products": [
      {
        "id": 133609,
        "styleNumber": "BB18220",
        "productName": "Brooks Brothers Mesh Pique Performance Polo BB18220",
        "description": "Quality meets performance in this lightweight...",
        "brand": "Brooks Brothers",
        "category": "",
        "subcategory": "",
        "status": "Active",
        "keywords": "Polo Poly Poly Spandex Stretch...",
        
        "pricing": {
          "current": 28.84,
          "minPrice": 28.84,
          "maxPrice": 32.84,
          "dozen": 28.84,
          "case": 24.84,
          "msrp": null,
          "map": ""
        },
        
        "images": {
          "thumbnail": "https://cdnm.sanmar.com/catalog/images/BB18220TN.jpg",
          "main": "https://cdnm.sanmar.com/catalog/images/BB18220.jpg",
          "colorSwatch": "https://cdnm.sanmar.com/catalog/images/BB18220sw.jpg",
          "specSheet": "https://www.apparelvideos.com/images/specsheet/pdf/specsheet/BB18220_specsheet.pdf",
          "decorationSpec": "",
          "productMeasurements": "",
          "brandLogo": "https://cdnm.sanmar.com/catalog/images/BBHeader.jpg",
          "display": "https://cdnm.sanmar.com/imglib/mresjpg/2023/f8/BB18220_charterblue_model_front.jpg",
          "model": {
            "front": "https://cdnm.sanmar.com/imglib/mresjpg/2023/f8/BB18220_charterblue_model_front.jpg",
            "back": "https://cdnm.sanmar.com/imglib/mresjpg/2023/f8/BB18220_charterblue_model_back.jpg",
            "side": "https://cdnm.sanmar.com/imglib/mresjpg/2023/f8/BB18220_charterblue_model_side.jpg",
            "threeQ": ""
          },
          "flat": {
            "front": "https://cdnm.sanmar.com/imglib/mresjpg/2023/f8/BB18220_charterblue_flat_front.jpg",
            "back": "https://cdnm.sanmar.com/imglib/mresjpg/2023/f8/BB18220_charterblue_flat_back.jpg"
          }
        },
        
        "colors": [
          {
            "name": "Charter Blue",
            "catalogColor": "CharterBlu",
            "pmsCode": "",
            "swatchUrl": "https://cdnm.sanmar.com/swatch/gifs/BB18220_CHARTERBLUE.gif",
            "productImageUrl": "https://cdnm.sanmar.com/catalog/images/imglib/catl/2023/f8/BB18220_charterblue_model_front.jpg",
            "productImageThumbnail": "https://cdnm.sanmar.com/cache/altview/imglib/catl/2023/f8/BB18220_charterblue_model_front.jpg",
            "mainframeColor": ""
          }
        ],
        
        "sizes": ["XS", "S", "M", "L", "XL", "2XL", "3XL", "4XL"],
        "availableSizes": "Adult Sizes: XS-4XL",
        
        "features": {
          "isTopSeller": false,
          "priceText": "size",
          "caseSize": 36,
          "companionStyles": ""
        },
        
        "dateUpdated": "2025-06-10T13:43:34",
        "gtin": null,
        "totalQty": 0
      }
    ],
    
    "pagination": {
      "page": 1,
      "limit": 24,
      "total": 21,
      "totalPages": 1,
      "hasNext": false,
      "hasPrev": false
    },
    
    "metadata": {
      "query": "polo",
      "executionTime": 0,
      "filters": {
        "category": null,
        "subcategory": null,
        "brand": null,
        "color": null,
        "size": null,
        "priceRange": null,
        "status": "Active"
      }
    },
    
    "facets": {
      "categories": [
        { "name": "Polos/Knits", "count": 9, "selected": false },
        { "name": "Workwear", "count": 9, "selected": false }
      ],
      "brands": [
        { "name": "CornerStone", "count": 17, "selected": false },
        { "name": "Brooks Brothers", "count": 3, "selected": false }
      ],
      "colors": [
        { "name": "Black", "count": 15, "selected": false },
        { "name": "Royal", "count": 12, "selected": false }
      ],
      "sizes": [
        { "name": "S", "count": 18, "selected": false },
        { "name": "M", "count": 18, "selected": false }
      ],
      "priceRanges": [
        { "label": "Under $25", "min": 0, "max": 25, "count": 17 },
        { "label": "$25-$50", "min": 25, "max": 50, "count": 4 }
      ]
    }
  }
}
```

### Error Response (500 Internal Server Error)

```json
{
  "success": false,
  "error": {
    "code": "SEARCH_ERROR",
    "message": "Failed to execute product search",
    "details": "Specific error details here"
  }
}
```

## Key Features

### 1. Smart Product Grouping
- Groups multiple records by `STYLE` number
- Aggregates all colors and sizes for each style
- Calculates price ranges (min/max) across variants
- Returns one product card per style, not per size/color combination

### 2. Comprehensive Product Data
- **Complete Image Set**: Thumbnail, main, color swatches, model shots (front/back/side), flat images
- **Rich Color Information**: Color names, PMS codes, swatch URLs, product images per color
- **Size Data**: Properly sorted sizes (XS, S, M, L, XL, 2XL, etc.)
- **Pricing**: Current, dozen, case, MSRP, MAP pricing
- **Metadata**: Brand, category, features, spec sheets, decoration guides

### 3. Advanced Search Capabilities
- **Text Search**: Searches across style, product title, description, keywords, and brand
- **Multi-Filter Support**: Combine category, brand, color, size, and price filters
- **Faceted Search**: Optional aggregation counts for building filter UIs
- **Flexible Sorting**: Multiple sort options for different use cases

### 4. Performance Optimized
- **Fast Response Times**: 1-2 seconds for most queries
- **Efficient Pagination**: Limits large result sets
- **Smart Data Handling**: Groups raw records efficiently

## Usage Examples

### Basic Search
```bash
# Search for polo shirts
curl "https://caspio-pricing-proxy-ab30a049961a.herokuapp.com/api/products/search?q=polo"

# Get first page of all active products
curl "https://caspio-pricing-proxy-ab30a049961a.herokuapp.com/api/products/search"
```

### Category and Brand Filtering
```bash
# Filter by category
curl "https://caspio-pricing-proxy-ab30a049961a.herokuapp.com/api/products/search?category=Polos/Knits"

# Filter by brand
curl "https://caspio-pricing-proxy-ab30a049961a.herokuapp.com/api/products/search?brand=OGIO"

# Multiple filters
curl "https://caspio-pricing-proxy-ab30a049961a.herokuapp.com/api/products/search?category=T-Shirts&brand=AllMade&minPrice=10&maxPrice=30"
```

### Advanced Features
```bash
# Search with facets for building filter UI
curl "https://caspio-pricing-proxy-ab30a049961a.herokuapp.com/api/products/search?q=shirt&includeFacets=true"

# Pagination with custom page size
curl "https://caspio-pricing-proxy-ab30a049961a.herokuapp.com/api/products/search?page=2&limit=48"

# Sort by price (low to high)
curl "https://caspio-pricing-proxy-ab30a049961a.herokuapp.com/api/products/search?sort=price_asc&limit=12"

# Top sellers only
curl "https://caspio-pricing-proxy-ab30a049961a.herokuapp.com/api/products/search?isTopSeller=true"
```

### Complex Filtering
```bash
# Multiple categories
curl "https://caspio-pricing-proxy-ab30a049961a.herokuapp.com/api/products/search?category=Polos/Knits,T-Shirts"

# Multiple brands with price range
curl "https://caspio-pricing-proxy-ab30a049961a.herokuapp.com/api/products/search?brand=OGIO,Brooks%20Brothers&minPrice=25&maxPrice=75"

# Color and size filtering
curl "https://caspio-pricing-proxy-ab30a049961a.herokuapp.com/api/products/search?color=Black,Navy&size=M,L,XL"
```

## Testing on Heroku

### Quick Test URLs

1. **Basic Search Test**:
   ```
   https://caspio-pricing-proxy-ab30a049961a.herokuapp.com/api/products/search?q=polo&limit=3
   ```

2. **Category Filter Test**:
   ```
   https://caspio-pricing-proxy-ab30a049961a.herokuapp.com/api/products/search?category=T-Shirts&limit=5
   ```

3. **Faceted Search Test**:
   ```
   https://caspio-pricing-proxy-ab30a049961a.herokuapp.com/api/products/search?q=shirt&includeFacets=true&limit=10
   ```

4. **Advanced Filter Test**:
   ```
   https://caspio-pricing-proxy-ab30a049961a.herokuapp.com/api/products/search?brand=OGIO&minPrice=20&maxPrice=50&sort=price_asc
   ```

### Testing with Postman

1. Import the URL into Postman
2. Set method to `GET`
3. Add query parameters as needed
4. Expected response time: 1-3 seconds
5. Check that `success: true` and products array is populated

## Integration Guide

### For Frontend Developers

1. **Product Catalog Page**:
   - Use basic search with pagination for main catalog
   - Implement faceted search for filter sidebar
   - Display product cards using image URLs and basic info

2. **Search Functionality**:
   - Implement real-time search with the `q` parameter
   - Add debouncing (300ms) to avoid excessive API calls
   - Show loading states during search

3. **Filter UI**:
   - Use `includeFacets=true` to get filter counts
   - Build category, brand, color filter checkboxes
   - Implement price range sliders using min/max values

4. **Product Display**:
   - Use `thumbnail` for grid views
   - Use `main` or `display` for detailed views
   - Show color swatches using `colors[].swatchUrl`
   - Display available sizes from `sizes` array

### Sample JavaScript Integration

```javascript
// Basic search function
async function searchProducts(query, filters = {}, page = 1) {
  const params = new URLSearchParams({
    q: query,
    page: page,
    limit: 24,
    includeFacets: true,
    ...filters
  });

  const response = await fetch(
    `https://caspio-pricing-proxy-ab30a049961a.herokuapp.com/api/products/search?${params}`
  );
  
  return await response.json();
}

// Usage example
const results = await searchProducts('polo', {
  category: 'Polos/Knits',
  brand: 'OGIO',
  minPrice: 20,
  maxPrice: 50
});

console.log(`Found ${results.data.pagination.total} products`);
results.data.products.forEach(product => {
  console.log(`${product.styleNumber}: ${product.productName}`);
});
```

## Performance Notes

- **Response Time**: 1-2 seconds for standard queries, up to 3 seconds with facets
- **Data Volume**: Efficiently handles 1000+ raw records, returns 10-100 grouped products
- **Pagination**: Use reasonable page sizes (24-48) for best performance
- **Caching**: Consider client-side caching for repeated searches

## Data Source

- **Table**: `Sanmar_Bulk_251816_Feb2024`
- **Records**: Products grouped by style number
- **Update Frequency**: Reflects real-time Caspio data
- **Coverage**: All active apparel products in the system

## Troubleshooting

### Common Issues

1. **Empty Results**: Check if search terms are too specific or filters too restrictive
2. **Slow Response**: Try reducing page size or removing facets
3. **Invalid Parameters**: Ensure proper URL encoding for special characters

### Error Codes

- **400**: Invalid request parameters
- **500**: Server error (check logs for details)
- **504**: Request timeout (try simplifying the query)

## Changelog

### Version 1.0 (August 2025)
- Initial release of enhanced product search API
- Smart product grouping by style
- Comprehensive filtering and sorting options
- Faceted search capabilities
- Full product data including images, colors, and sizes
- Production deployment on Heroku

---

**Created**: August 17, 2025  
**Last Updated**: August 17, 2025  
**Endpoint**: `/api/products/search`  
**Version**: 1.0