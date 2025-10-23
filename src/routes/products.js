// Product-related routes

const express = require('express');
const router = express.Router();
const { makeCaspioRequest, fetchAllCaspioPages } = require('../utils/caspio');
const { mapFieldsForBackwardCompatibility, createProductColorsResponse, createColorSwatchesResponse } = require('../utils/field-mapper');

// GET /api/stylesearch
router.get('/stylesearch', async (req, res) => {
  const { term } = req.query;
  console.log(`GET /api/stylesearch requested with term=${term}`);

  if (!term || term.length < 2) {
    return res.status(400).json({ error: 'Search term must be at least 2 characters' });
  }

  try {
    const whereClause = `STYLE LIKE '%${term}%'`;
    const records = await fetchAllCaspioPages('/tables/Sanmar_Bulk_251816_Feb2024/records', {
      'q.where': whereClause,
      'q.select': 'STYLE,PRODUCT_TITLE',
      'q.groupBy': 'STYLE,PRODUCT_TITLE',
      'q.limit': 20
    });

    const suggestions = records.map(r => ({
      value: r.STYLE,
      label: `${r.STYLE} - ${r.PRODUCT_TITLE}`
    }));
    console.log(`Style search for "${term}": ${suggestions.length} result(s)`);
    res.json(suggestions);
  } catch (error) {
    console.error('Error in style search:', error.message);
    res.status(500).json({ error: 'Failed to search styles', details: error.message });
  }
});

// GET /api/product-details
router.get('/product-details', async (req, res) => {
  const { styleNumber, color } = req.query;
  console.log(`GET /api/product-details requested with styleNumber=${styleNumber}, color=${color}`);

  if (!styleNumber) {
    return res.status(400).json({ error: 'styleNumber is required' });
  }

  try {
    let whereClause = `STYLE='${styleNumber}'`;
    if (color) {
      whereClause += ` AND COLOR_NAME='${color}'`;
    }

    // Use the original field names from the Caspio table
    const selectFields = [
      'STYLE', 'PRODUCT_TITLE', 'PRODUCT_DESCRIPTION', 'COLOR_NAME', 'CATALOG_COLOR',
      'BRAND_NAME', 'FRONT_MODEL', 'BACK_MODEL', 'FRONT_FLAT', 'BACK_FLAT',
      'PIECE_PRICE', 'DOZEN_PRICE', 'CASE_PRICE',
      'CATEGORY_NAME', 'SUBCATEGORY_NAME', 'PRODUCT_STATUS',
      'PRODUCT_IMAGE', 'COLOR_SQUARE_IMAGE'
    ];

    const records = await fetchAllCaspioPages('/tables/Sanmar_Bulk_251816_Feb2024/records', {
      'q.where': whereClause,
      'q.select': selectFields.join(', ')
    });

    if (records.length === 0) {
      return res.status(404).json({ error: 'Product not found' });
    }

    const uniqueStyles = [];
    const seenStyles = new Set();

    // Return the records with the original field names as expected by existing apps
    console.log(`Product details for ${styleNumber}: ${records.length} record(s)`);
    res.json(records);
  } catch (error) {
    console.error('Error fetching product details:', error.message);
    res.status(500).json({ error: 'Failed to fetch product details', details: error.message });
  }
});

// GET /api/color-swatches
router.get('/color-swatches', async (req, res) => {
  const { styleNumber } = req.query;
  console.log(`GET /api/color-swatches requested with styleNumber=${styleNumber}`);

  if (!styleNumber) {
    return res.status(400).json({ error: 'styleNumber is required' });
  }

  try {
    // Original API used these fields
    const selectFields = 'COLOR_NAME, CATALOG_COLOR, COLOR_SQUARE_IMAGE';

    const records = await fetchAllCaspioPages('/tables/Sanmar_Bulk_251816_Feb2024/records', {
      'q.where': `STYLE='${styleNumber}'`,
      'q.select': selectFields,
      'q.limit': 1000
    });

    // Use the mapper to create the original response format
    const colorSwatches = createColorSwatchesResponse(records);

    console.log(`Color swatches for ${styleNumber}: ${colorSwatches.length} color(s)`);
    res.json(colorSwatches);
  } catch (error) {
    console.error('Error fetching color swatches:', error.message);
    res.status(500).json({ error: 'Failed to fetch color swatches', details: error.message });
  }
});

// GET /api/products-by-brand
router.get('/products-by-brand', async (req, res) => {
  const { brand } = req.query;
  console.log(`GET /api/products-by-brand requested with brand=${brand}`);

  if (!brand) {
    return res.status(400).json({ error: 'brand parameter is required' });
  }

  try {
    const selectFields = [
      'STYLE', 'PRODUCT_TITLE', 'PRODUCT_DESCRIPTION', 'BRAND_NAME',
      'FRONT_MODEL', 'CATEGORY_NAME', 'SUBCATEGORY_NAME', 'PRODUCT_STATUS',
      'PIECE_PRICE', 'DOZEN_PRICE', 'CASE_PRICE'
    ];

    const records = await fetchAllCaspioPages('/tables/Sanmar_Bulk_251816_Feb2024/records', {
      'q.where': `BRAND_NAME LIKE '%${brand}%'`,
      'q.select': selectFields.join(', '),
      'q.groupBy': 'STYLE, PRODUCT_TITLE, PRODUCT_DESCRIPTION, BRAND_NAME, FRONT_MODEL, CATEGORY_NAME, SUBCATEGORY_NAME, PRODUCT_STATUS, PIECE_PRICE, DOZEN_PRICE, CASE_PRICE'
    });

    console.log(`Products by brand "${brand}": ${records.length} product(s) found`);
    res.json(records);
  } catch (error) {
    console.error('Error fetching products by brand:', error.message);
    res.status(500).json({ error: 'Failed to fetch products by brand', details: error.message });
  }
});

// GET /api/products-by-category
router.get('/products-by-category', async (req, res) => {
  const { category } = req.query;
  console.log(`GET /api/products-by-category requested with category=${category}`);

  if (!category) {
    return res.status(400).json({ error: 'category parameter is required' });
  }

  try {
    const selectFields = [
      'STYLE', 'PRODUCT_TITLE', 'PRODUCT_DESCRIPTION', 'BRAND_NAME',
      'FRONT_MODEL', 'CATEGORY_NAME', 'SUBCATEGORY_NAME', 'PRODUCT_STATUS'
    ];

    const records = await fetchAllCaspioPages('/tables/Sanmar_Bulk_251816_Feb2024/records', {
      'q.where': `CATEGORY_NAME='${category}'`,
      'q.select': selectFields.join(', '),
      'q.groupBy': 'STYLE, PRODUCT_TITLE, PRODUCT_DESCRIPTION, BRAND_NAME, FRONT_MODEL, CATEGORY_NAME, SUBCATEGORY_NAME, PRODUCT_STATUS'
    });

    console.log(`Products by category "${category}": ${records.length} product(s) found`);
    res.json(records);
  } catch (error) {
    console.error('Error fetching products by category:', error.message);
    res.status(500).json({ error: 'Failed to fetch products by category', details: error.message });
  }
});

// GET /api/products-by-subcategory
router.get('/products-by-subcategory', async (req, res) => {
  const { subcategory } = req.query;
  console.log(`GET /api/products-by-subcategory requested with subcategory=${subcategory}`);

  if (!subcategory) {
    return res.status(400).json({ error: 'subcategory parameter is required' });
  }

  try {
    const selectFields = [
      'STYLE', 'PRODUCT_TITLE', 'PRODUCT_DESCRIPTION', 'BRAND_NAME',
      'FRONT_MODEL', 'CATEGORY_NAME', 'SUBCATEGORY_NAME', 'PRODUCT_STATUS'
    ];

    const records = await fetchAllCaspioPages('/tables/Sanmar_Bulk_251816_Feb2024/records', {
      'q.where': `SUBCATEGORY_NAME='${subcategory}'`,
      'q.select': selectFields.join(', '),
      'q.groupBy': 'STYLE, PRODUCT_TITLE, PRODUCT_DESCRIPTION, BRAND_NAME, FRONT_MODEL, CATEGORY_NAME, SUBCATEGORY_NAME, PRODUCT_STATUS'
    });

    console.log(`Products by subcategory "${subcategory}": ${records.length} product(s) found`);
    res.json(records);
  } catch (error) {
    console.error('Error fetching products by subcategory:', error.message);
    res.status(500).json({ error: 'Failed to fetch products by subcategory', details: error.message });
  }
});

// Additional product routes...
// GET /api/all-brands
router.get('/all-brands', async (req, res) => {
  console.log('GET /api/all-brands requested');

  try {
    const records = await fetchAllCaspioPages('/tables/Sanmar_Bulk_251816_Feb2024/records', {
      'q.select': 'BRAND_NAME, BRAND_LOGO_IMAGE, STYLE',
      'q.groupBy': 'BRAND_NAME, BRAND_LOGO_IMAGE, STYLE'
    });

    const brandMap = new Map();
    records.forEach(record => {
      if (record.BRAND_NAME && record.STYLE) {
        if (!brandMap.has(record.BRAND_NAME)) {
          brandMap.set(record.BRAND_NAME, {
            logo: record.BRAND_LOGO_IMAGE || '',
            styles: []
          });
        }
        brandMap.get(record.BRAND_NAME).styles.push(record.STYLE);
      }
    });

    const brands = Array.from(brandMap.entries()).map(([brand, data]) => ({
      brand: brand,
      logo: data.logo,
      sampleStyles: data.styles.slice(0, 3)
    }));

    console.log(`All brands: ${brands.length} brand(s) found`);
    res.json(brands);
  } catch (error) {
    console.error('Error fetching all brands:', error.message);
    res.status(500).json({ error: 'Failed to fetch brands', details: error.message });
  }
});

// GET /api/all-categories
router.get('/all-categories', async (req, res) => {
  console.log('GET /api/all-categories requested');

  try {
    const records = await fetchAllCaspioPages('/tables/Sanmar_Bulk_251816_Feb2024/records', {
      'q.select': 'CATEGORY_NAME',
      'q.groupBy': 'CATEGORY_NAME'
    });

    const categories = records
      .map(r => r.CATEGORY_NAME)
      .filter(cat => cat && cat.trim() !== '');

    console.log(`All categories: ${categories.length} categories found`);
    res.json(categories);
  } catch (error) {
    console.error('Error fetching categories:', error.message);
    res.status(500).json({ error: 'Failed to fetch categories', details: error.message });
  }
});

// GET /api/all-subcategories
router.get('/all-subcategories', async (req, res) => {
  console.log('GET /api/all-subcategories requested');

  try {
    const records = await fetchAllCaspioPages('/tables/Sanmar_Bulk_251816_Feb2024/records', {
      'q.select': 'SUBCATEGORY_NAME',
      'q.groupBy': 'SUBCATEGORY_NAME'
    });

    const subcategories = records
      .map(r => r.SUBCATEGORY_NAME)
      .filter(subcat => subcat && subcat.trim() !== '');

    console.log(`All subcategories: ${subcategories.length} subcategories found`);
    res.json(subcategories);
  } catch (error) {
    console.error('Error fetching subcategories:', error.message);
    res.status(500).json({ error: 'Failed to fetch subcategories', details: error.message });
  }
});

// GET /api/search
router.get('/search', async (req, res) => {
  const { q } = req.query;
  console.log(`GET /api/search requested with q=${q}`);

  if (!q || q.length < 2) {
    return res.status(400).json({ error: 'Search query must be at least 2 characters' });
  }

  try {
    const whereClause = `STYLE LIKE '%${q}%' OR PRODUCT_TITLE LIKE '%${q}%' OR PRODUCT_DESCRIPTION LIKE '%${q}%' OR BRAND_NAME LIKE '%${q}%' OR CATEGORY_NAME LIKE '%${q}%' OR SUBCATEGORY_NAME LIKE '%${q}%'`;
    
    const selectFields = [
      'STYLE', 'PRODUCT_TITLE', 'PRODUCT_DESCRIPTION', 'BRAND_NAME',
      'FRONT_MODEL', 'CATEGORY_NAME', 'SUBCATEGORY_NAME', 'PRODUCT_STATUS'
    ];

    const records = await fetchAllCaspioPages('/tables/Sanmar_Bulk_251816_Feb2024/records', {
      'q.where': whereClause,
      'q.select': selectFields.join(', '),
      'q.groupBy': selectFields.join(', '),
      'q.limit': 50
    });

    console.log(`Search for "${q}": ${records.length} result(s) found`);
    res.json(records);
  } catch (error) {
    console.error('Error in product search:', error.message);
    res.status(500).json({ error: 'Failed to search products', details: error.message });
  }
});

// GET /api/featured-products
router.get('/featured-products', async (req, res) => {
  console.log('GET /api/featured-products requested');

  try {
    const selectFields = [
      'STYLE', 'PRODUCT_TITLE', 'PRODUCT_DESCRIPTION', 'BRAND_NAME',
      'FRONT_MODEL', 'CATEGORY_NAME', 'SUBCATEGORY_NAME', 'PRODUCT_STATUS'
    ];

    const records = await fetchAllCaspioPages('/tables/Sanmar_Bulk_251816_Feb2024/records', {
      'q.where': "PRODUCT_STATUS='New'",
      'q.select': selectFields.join(', '),
      'q.groupBy': selectFields.join(', '),
      'q.limit': 20
    });

    console.log(`Featured products: ${records.length} product(s) found`);
    res.json(records);
  } catch (error) {
    console.error('Error fetching featured products:', error.message);
    res.status(500).json({ error: 'Failed to fetch featured products', details: error.message });
  }
});

// GET /api/products/search - Enhanced catalog search endpoint
router.get('/products/search', async (req, res) => {
  console.log('GET /api/products/search requested with query:', req.query);

  try {
    // Extract query parameters
    const {
      q,                    // Search query
      category,             // Filter by category (can be array)
      subcategory,          // Filter by subcategory (can be array)
      brand,                // Filter by brand (can be array)
      color,                // Filter by color (can be array)
      size,                 // Filter by size (can be array)
      minPrice,             // Minimum price filter
      maxPrice,             // Maximum price filter
      status = 'Active',    // Product status filter (default to Active)
      isTopSeller,          // Filter for top sellers only
      sort = 'name_asc',    // Sort order (default to name ascending)
      page = 1,             // Page number (default: 1)
      limit = 24,           // Results per page (default: 24, max: 100)
      includeFacets = false // Include aggregation counts
    } = req.query;

    // Build WHERE clause
    let whereConditions = [];

    // Status filter (hide discontinued unless specified)
    if (status && status !== 'all') {
      whereConditions.push(`PRODUCT_STATUS='${status}'`);
    }

    // Text search across multiple fields
    if (q && q.trim()) {
      const searchTerm = q.trim().replace(/'/g, "''");
      whereConditions.push(`(
        STYLE LIKE '%${searchTerm}%' OR 
        PRODUCT_TITLE LIKE '%${searchTerm}%' OR 
        PRODUCT_DESCRIPTION LIKE '%${searchTerm}%' OR
        KEYWORDS LIKE '%${searchTerm}%' OR
        BRAND_NAME LIKE '%${searchTerm}%'
      )`);
    }

    // Category filter
    if (category) {
      const categories = Array.isArray(category) ? category : [category];
      const categoryList = categories.map(c => `'${c.replace(/'/g, "''")}'`).join(',');
      whereConditions.push(`CATEGORY_NAME IN (${categoryList})`);
    }

    // Subcategory filter
    if (subcategory) {
      const subcategories = Array.isArray(subcategory) ? subcategory : [subcategory];
      const subcategoryList = subcategories.map(s => `'${s.replace(/'/g, "''")}'`).join(',');
      whereConditions.push(`SUBCATEGORY_NAME IN (${subcategoryList})`);
    }

    // Brand filter
    if (brand) {
      const brands = Array.isArray(brand) ? brand : [brand];
      const brandList = brands.map(b => `'${b.replace(/'/g, "''")}'`).join(',');
      whereConditions.push(`BRAND_NAME IN (${brandList})`);
    }

    // Color filter
    if (color) {
      const colors = Array.isArray(color) ? color : [color];
      const colorList = colors.map(c => `'${c.replace(/'/g, "''")}'`).join(',');
      whereConditions.push(`COLOR_NAME IN (${colorList})`);
    }

    // Size filter
    if (size) {
      const sizes = Array.isArray(size) ? size : [size];
      const sizeList = sizes.map(s => `'${s.replace(/'/g, "''")}'`).join(',');
      whereConditions.push(`SIZE IN (${sizeList})`);
    }

    // Price range filters
    if (minPrice) {
      whereConditions.push(`PIECE_PRICE >= ${parseFloat(minPrice)}`);
    }
    if (maxPrice) {
      whereConditions.push(`PIECE_PRICE <= ${parseFloat(maxPrice)}`);
    }

    // Top seller filter
    if (isTopSeller === 'true') {
      whereConditions.push(`IsTopSeller=true`);
    }

    // Build final WHERE clause
    const whereClause = whereConditions.length > 0 ? whereConditions.join(' AND ') : '1=1';

    // Determine sort field and order
    let orderBy = 'PRODUCT_TITLE ASC';
    switch (sort) {
      case 'name_asc':
        orderBy = 'PRODUCT_TITLE ASC';
        break;
      case 'name_desc':
        orderBy = 'PRODUCT_TITLE DESC';
        break;
      case 'price_asc':
        orderBy = 'PIECE_PRICE ASC';
        break;
      case 'price_desc':
        orderBy = 'PIECE_PRICE DESC';
        break;
      case 'newest':
        orderBy = 'Date_Updated DESC';
        break;
      case 'style':
        orderBy = 'STYLE ASC';
        break;
      default:
        orderBy = 'PRODUCT_TITLE ASC';
    }

    // Calculate pagination
    const pageNum = Math.max(1, parseInt(page));
    const pageSize = Math.min(100, Math.max(1, parseInt(limit) || 24));
    const skip = (pageNum - 1) * pageSize;

    console.log(`Executing search with WHERE: ${whereClause}, will sort after grouping by: ${orderBy}`);

    // Fetch all matching records WITHOUT ordering at Caspio level
    // This ensures we get diverse styles across pagination, not just alphabetically similar titles
    const allRecords = await fetchAllCaspioPages('/tables/Sanmar_Bulk_251816_Feb2024/records', {
      'q.where': whereClause
      // NOTE: No q.orderBy here - we'll sort AFTER grouping by style
    });

    console.log(`Found ${allRecords.length} total records before grouping`);

    // Group records by STYLE to create unique products
    const productsByStyle = new Map();

    allRecords.forEach(record => {
      const style = record.STYLE;
      if (!productsByStyle.has(style)) {
        // First record for this style - use it as the base product
        productsByStyle.set(style, {
          // Basic product information
          id: record.PK_ID,
          styleNumber: style,
          productName: record.PRODUCT_TITLE,
          description: record.PRODUCT_DESCRIPTION,
          brand: record.BRAND_NAME,
          category: record.CATEGORY_NAME,
          subcategory: record.SUBCATEGORY_NAME,
          status: record.PRODUCT_STATUS,
          keywords: record.KEYWORDS,
          
          // Pricing (will collect min/max across all variants)
          pricing: {
            current: record.PIECE_PRICE,
            minPrice: record.PIECE_PRICE,
            maxPrice: record.PIECE_PRICE,
            dozen: record.DOZEN_PRICE,
            case: record.CASE_PRICE,
            msrp: record.MSRP,
            map: record.MAP_PRICING
          },
          
          // Images
          images: {
            thumbnail: record.THUMBNAIL_IMAGE,
            main: record.PRODUCT_IMAGE,
            colorSwatch: record.COLOR_SWATCH_IMAGE,
            specSheet: record.SPEC_SHEET,
            decorationSpec: record.DECORATION_SPEC_SHEET,
            productMeasurements: record.PRODUCT_MEASUREMENTS,
            brandLogo: record.BRAND_LOGO_IMAGE,
            display: record.Display_Image_URL || record.FRONT_MODEL,
            model: {
              front: record.FRONT_MODEL,
              back: record.BACK_MODEL,
              side: record.SIDE_MODEL,
              threeQ: record.THREE_Q_MODEL
            },
            flat: {
              front: record.FRONT_FLAT,
              back: record.BACK_FLAT
            }
          },
          
          // Initialize collections for aggregation
          colors: new Map(),
          sizes: new Set(),
          availableSizes: record.AVAILABLE_SIZES,
          
          // Features
          features: {
            isTopSeller: record.IsTopSeller || false,
            priceText: record.PRICE_TEXT,
            caseSize: record.CASE_SIZE,
            companionStyles: record.COMPANION_STYLES
          },
          
          // Metadata
          dateUpdated: record.Date_Updated,
          gtin: record.GTIN,
          
          // For tracking total quantity across all variants
          totalQty: record.QTY || 0
        });
      } else {
        // Additional record for same style - aggregate data
        const product = productsByStyle.get(style);
        
        // Update price range
        if (record.PIECE_PRICE) {
          product.pricing.minPrice = Math.min(product.pricing.minPrice, record.PIECE_PRICE);
          product.pricing.maxPrice = Math.max(product.pricing.maxPrice, record.PIECE_PRICE);
        }
        
        // Add to total quantity
        product.totalQty += (record.QTY || 0);
      }

      // Add color information
      const product = productsByStyle.get(style);
      if (record.COLOR_NAME && !product.colors.has(record.COLOR_NAME)) {
        product.colors.set(record.COLOR_NAME, {
          name: record.COLOR_NAME,
          catalogColor: record.CATALOG_COLOR,
          pmsCode: record.PMS_COLOR,
          swatchUrl: record.COLOR_SQUARE_IMAGE,
          productImageUrl: record.COLOR_PRODUCT_IMAGE,
          productImageThumbnail: record.COLOR_PRODUCT_IMAGE_THUMBNAIL,
          mainframeColor: record.SANMAR_MAINFRAME_COLOR
        });
      }

      // Add size
      if (record.SIZE) {
        product.sizes.add(record.SIZE);
      }
    });

    // Convert Map to array and format final products
    let products = Array.from(productsByStyle.values()).map(product => ({
      ...product,
      colors: Array.from(product.colors.values()),
      sizes: Array.from(product.sizes).sort((a, b) => {
        // Sort sizes in logical order (XS, S, M, L, XL, 2XL, etc.)
        const sizeOrder = ['XS', 'S', 'M', 'L', 'XL', '2XL', '3XL', '4XL', '5XL', '6XL'];
        const aIndex = sizeOrder.indexOf(a);
        const bIndex = sizeOrder.indexOf(b);
        if (aIndex !== -1 && bIndex !== -1) return aIndex - bIndex;
        if (aIndex !== -1) return -1;
        if (bIndex !== -1) return 1;
        return a.localeCompare(b);
      })
    }));

    console.log(`Grouped into ${products.length} unique products`);

    // Sort products based on the requested sort parameter
    products.sort((a, b) => {
      switch (sort) {
        case 'name_asc':
          return (a.productName || '').localeCompare(b.productName || '');
        case 'name_desc':
          return (b.productName || '').localeCompare(a.productName || '');
        case 'price_asc':
          return (a.pricing?.current || 0) - (b.pricing?.current || 0);
        case 'price_desc':
          return (b.pricing?.current || 0) - (a.pricing?.current || 0);
        case 'style':
          return (a.styleNumber || '').localeCompare(b.styleNumber || '');
        case 'newest':
          // For newest, we'd need to track Date_Updated in the product object
          // For now, maintain existing order
          return 0;
        default:
          return (a.productName || '').localeCompare(b.productName || '');
      }
    });

    // Get total count before pagination
    const totalProducts = products.length;

    // Apply pagination to grouped products
    const paginatedProducts = products.slice(skip, skip + pageSize);

    // Build response
    const response = {
      success: true,
      data: {
        products: paginatedProducts,
        pagination: {
          page: pageNum,
          limit: pageSize,
          total: totalProducts,
          totalPages: Math.ceil(totalProducts / pageSize),
          hasNext: pageNum < Math.ceil(totalProducts / pageSize),
          hasPrev: pageNum > 1
        },
        metadata: {
          query: q || null,
          executionTime: Date.now() - req._startTime || 0,
          filters: {
            category: category || null,
            subcategory: subcategory || null,
            brand: brand || null,
            color: color || null,
            size: size || null,
            priceRange: (minPrice || maxPrice) ? [minPrice || 0, maxPrice || 999999] : null,
            status: status
          }
        }
      }
    };

    // Optionally include facets for filter counts
    if (includeFacets === 'true' || includeFacets === true) {
      console.log('Calculating facets...');
      
      // Get unique values for facets from all matching records
      const facets = {
        categories: new Map(),
        subcategories: new Map(),
        brands: new Map(),
        colors: new Map(),
        sizes: new Map(),
        priceRanges: [
          { label: 'Under $25', min: 0, max: 25, count: 0 },
          { label: '$25-$50', min: 25, max: 50, count: 0 },
          { label: '$50-$100', min: 50, max: 100, count: 0 },
          { label: '$100-$200', min: 100, max: 200, count: 0 },
          { label: 'Over $200', min: 200, max: null, count: 0 }
        ]
      };

      // Count occurrences from grouped products (not raw records)
      products.forEach(product => {
        // Categories
        if (product.category) {
          facets.categories.set(product.category, (facets.categories.get(product.category) || 0) + 1);
        }
        
        // Subcategories
        if (product.subcategory) {
          facets.subcategories.set(product.subcategory, (facets.subcategories.get(product.subcategory) || 0) + 1);
        }
        
        // Brands
        if (product.brand) {
          facets.brands.set(product.brand, (facets.brands.get(product.brand) || 0) + 1);
        }
        
        // Colors (count products that have each color)
        product.colors.forEach(color => {
          if (color.name) {
            facets.colors.set(color.name, (facets.colors.get(color.name) || 0) + 1);
          }
        });
        
        // Sizes (count products that have each size)
        product.sizes.forEach(size => {
          if (size) {
            facets.sizes.set(size, (facets.sizes.get(size) || 0) + 1);
          }
        });
        
        // Price ranges
        const price = product.pricing.current;
        if (price < 25) facets.priceRanges[0].count++;
        else if (price < 50) facets.priceRanges[1].count++;
        else if (price < 100) facets.priceRanges[2].count++;
        else if (price < 200) facets.priceRanges[3].count++;
        else facets.priceRanges[4].count++;
      });

      // Convert maps to arrays and sort by count
      response.data.facets = {
        categories: Array.from(facets.categories.entries())
          .map(([name, count]) => ({ name, count, selected: category && category.includes(name) }))
          .sort((a, b) => b.count - a.count),
        
        subcategories: Array.from(facets.subcategories.entries())
          .map(([name, count]) => ({ name, count, selected: subcategory && subcategory.includes(name) }))
          .sort((a, b) => b.count - a.count),
        
        brands: Array.from(facets.brands.entries())
          .map(([name, count]) => ({ name, count, selected: brand && brand.includes(name) }))
          .sort((a, b) => b.count - a.count),
        
        colors: Array.from(facets.colors.entries())
          .map(([name, count]) => ({ name, count, selected: color && color.includes(name) }))
          .sort((a, b) => b.count - a.count),
        
        sizes: Array.from(facets.sizes.entries())
          .map(([name, count]) => ({ name, count, selected: size && size.includes(name) }))
          .sort((a, b) => {
            // Sort sizes in logical order
            const sizeOrder = ['XS', 'S', 'M', 'L', 'XL', '2XL', '3XL', '4XL', '5XL', '6XL'];
            const aIndex = sizeOrder.indexOf(a.name);
            const bIndex = sizeOrder.indexOf(b.name);
            if (aIndex !== -1 && bIndex !== -1) return aIndex - bIndex;
            if (aIndex !== -1) return -1;
            if (bIndex !== -1) return 1;
            return a.name.localeCompare(b.name);
          }),
        
        priceRanges: facets.priceRanges.filter(range => range.count > 0)
      };
    }

    console.log(`Returning ${paginatedProducts.length} products for page ${pageNum}`);
    res.json(response);

  } catch (error) {
    console.error('Error in /api/products/search:', error);
    res.status(500).json({
      success: false,
      error: {
        code: 'SEARCH_ERROR',
        message: 'Failed to execute product search',
        details: error.message
      }
    });
  }
});

// GET /api/product-colors
router.get('/product-colors', async (req, res) => {
  const { styleNumber } = req.query;
  console.log(`GET /api/product-colors requested with styleNumber=${styleNumber}`);

  if (!styleNumber) {
    return res.status(400).json({ error: 'styleNumber is required' });
  }

  try {
    // Get the fields needed for the original response format
    const selectFields = [
      'PRODUCT_TITLE', 'PRODUCT_DESCRIPTION', 'COLOR_NAME', 'CATALOG_COLOR',
      'COLOR_SQUARE_IMAGE', 'FRONT_MODEL', 'FRONT_FLAT',
      'COLOR_SWATCH_IMAGE', 'PRODUCT_IMAGE'
    ];

    const records = await fetchAllCaspioPages('/tables/Sanmar_Bulk_251816_Feb2024/records', {
      'q.where': `STYLE='${styleNumber}'`,
      'q.select': selectFields.join(', ')
    });

    // Use the mapper to create the original response format
    const productColorsResponse = createProductColorsResponse(records, styleNumber);

    if (!productColorsResponse) {
      return res.status(404).json({ error: 'Product not found' });
    }

    console.log(`Product colors for ${styleNumber}: ${productColorsResponse.colors.length} unique color(s) found`);
    res.json(productColorsResponse);
  } catch (error) {
    console.error('Error fetching product colors:', error.message);
    res.status(500).json({ error: 'Failed to fetch product colors', details: error.message });
  }
});

module.exports = router;