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
      'q.select': 'STYLE',
      'q.groupBy': 'STYLE',
      'q.limit': 20
    });

    const suggestions = records.map(r => r.STYLE);
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
      'q.select': 'BRAND_NAME, STYLE',
      'q.groupBy': 'BRAND_NAME, STYLE'
    });

    const brandMap = new Map();
    records.forEach(record => {
      if (record.BRAND_NAME && record.STYLE) {
        if (!brandMap.has(record.BRAND_NAME)) {
          brandMap.set(record.BRAND_NAME, []);
        }
        brandMap.get(record.BRAND_NAME).push(record.STYLE);
      }
    });

    const brands = Array.from(brandMap.entries()).map(([brand, styles]) => ({
      brand: brand,
      sampleStyles: styles.slice(0, 3)
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