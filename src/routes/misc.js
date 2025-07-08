// Miscellaneous routes

const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const { fetchAllCaspioPages } = require('../utils/caspio');

// GET /status
router.get('/status', (req, res) => {
  console.log('GET /status requested');
  res.json({ status: 'API is running', timestamp: new Date().toISOString() });
});

// GET /test
router.get('/test', (req, res) => {
  console.log('GET /test requested');
  res.json({ message: 'Test endpoint working!' });
});

// GET /api/health - Health check endpoint with comprehensive info
router.get('/health', (req, res) => {
  const os = require('os');
  
  // Get WSL IP
  const interfaces = os.networkInterfaces();
  let wslIP = '127.0.0.1';
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal && iface.address.startsWith('172.')) {
        wslIP = iface.address;
        break;
      }
    }
  }
  
  // Access configuration from the app
  const app = req.app;
  const config = app.get('config');
  const PORT = config?.PORT || process.env.PORT || 3002;
  const caspioDomain = config?.CASPIO_DOMAIN || process.env.CASPIO_DOMAIN || 'c0esh141.caspio.com';
  
  res.json({
    status: 'healthy',
    message: 'Caspio Proxy Server is running',
    server: {
      port: PORT,
      actualPort: req.socket.localPort,
      environment: process.env.NODE_ENV || 'development',
      uptime: process.uptime(),
      wslIP: wslIP
    },
    caspio: {
      domain: caspioDomain,
      tokenCached: false, // Token info not available in modular routes
      tokenExpiry: null
    },
    testUrls: {
      dashboard: `http://${wslIP}:${PORT}/api/order-dashboard`,
      products: `http://${wslIP}:${PORT}/api/products/PC54`,
      health: `http://${wslIP}:${PORT}/api/health`
    },
    timestamp: new Date().toISOString()
  });
});

// GET /api/cart-integration.js
router.get('/cart-integration.js', (req, res) => {
  console.log('GET /api/cart-integration.js requested');
  const filePath = path.join(process.cwd(), 'cart-integration.js');
  
  fs.readFile(filePath, 'utf8', (err, data) => {
    if (err) {
      console.error('Error reading cart-integration.js:', err);
      return res.status(404).send('Cart integration script not found');
    }
    
    res.type('application/javascript');
    res.send(data);
  });
});

// GET /api/subcategories-by-category
router.get('/subcategories-by-category', async (req, res) => {
  const { category } = req.query;
  console.log(`GET /api/subcategories-by-category requested with category=${category}`);

  if (!category) {
    return res.status(400).json({ error: 'category parameter is required' });
  }

  try {
    const records = await fetchAllCaspioPages('/tables/Sanmar_Bulk_251816_Feb2024/records', {
      'q.where': `ProductCategory='${category}'`,
      'q.select': 'ProductSubcategory',
      'q.groupBy': 'ProductSubcategory'
    });

    const subcategories = records
      .map(r => r.ProductSubcategory)
      .filter(subcat => subcat && subcat.trim() !== '');

    console.log(`Subcategories for "${category}": ${subcategories.length} subcategory(ies) found`);
    res.json(subcategories);
  } catch (error) {
    console.error('Error fetching subcategories by category:', error.message);
    res.status(500).json({ error: 'Failed to fetch subcategories', details: error.message });
  }
});

// GET /api/products-by-category-subcategory
router.get('/products-by-category-subcategory', async (req, res) => {
  const { category, subcategory } = req.query;
  console.log(`GET /api/products-by-category-subcategory requested with category=${category}, subcategory=${subcategory}`);

  if (!category || !subcategory) {
    return res.status(400).json({ error: 'Both category and subcategory parameters are required' });
  }

  try {
    const selectFields = [
      'STYLE', 'PRODUCT_TITLE', 'PRODUCT_DESCRIPTION', 'BRAND_NAME',
      'FRONT_MODEL', 'CATEGORY_NAME', 'SUBCATEGORY_NAME', 'ProductStatus'
    ];

    const records = await fetchAllCaspioPages('/tables/Sanmar_Bulk_251816_Feb2024/records', {
      'q.where': `CATEGORY_NAME='${category}' AND SUBCATEGORY_NAME='${subcategory}'`,
      'q.select': selectFields.join(', '),
      'q.groupBy': selectFields.join(', ')
    });

    console.log(`Products for ${category}/${subcategory}: ${records.length} product(s) found`);
    res.json(records);
  } catch (error) {
    console.error('Error fetching products by category and subcategory:', error.message);
    res.status(500).json({ error: 'Failed to fetch products', details: error.message });
  }
});

// GET /api/related-products
router.get('/related-products', async (req, res) => {
  const { styleNumber } = req.query;
  console.log(`GET /api/related-products requested with styleNumber=${styleNumber}`);

  if (!styleNumber) {
    return res.status(400).json({ error: 'styleNumber parameter is required' });
  }

  try {
    // First, get the reference product details
    const referenceProduct = await fetchAllCaspioPages('/tables/Sanmar_Bulk_251816_Feb2024/records', {
      'q.where': `STYLE='${styleNumber}'`,
      'q.select': 'CATEGORY_NAME, SUBCATEGORY_NAME, BRAND_NAME',
      'q.limit': 1
    });

    if (referenceProduct.length === 0) {
      return res.status(404).json({ error: 'Reference product not found' });
    }

    const { CATEGORY_NAME, SUBCATEGORY_NAME, BRAND_NAME } = referenceProduct[0];
    
    // Build where clause for related products
    const whereClause = `(CATEGORY_NAME='${CATEGORY_NAME}' OR SUBCATEGORY_NAME='${SUBCATEGORY_NAME}' OR BRAND_NAME='${BRAND_NAME}') AND STYLE!='${styleNumber}'`;
    
    const selectFields = [
      'STYLE', 'PRODUCT_TITLE', 'PRODUCT_DESCRIPTION', 'BRAND_NAME',
      'FRONT_MODEL', 'CATEGORY_NAME', 'SUBCATEGORY_NAME', 'ProductStatus'
    ];

    const records = await fetchAllCaspioPages('/tables/Sanmar_Bulk_251816_Feb2024/records', {
      'q.where': whereClause,
      'q.select': selectFields.join(', '),
      'q.groupBy': selectFields.join(', '),
      'q.limit': 20
    });

    console.log(`Related products for ${styleNumber}: ${records.length} product(s) found`);
    res.json(records);
  } catch (error) {
    console.error('Error fetching related products:', error.message);
    res.status(500).json({ error: 'Failed to fetch related products', details: error.message });
  }
});

// GET /api/filter-products
router.get('/filter-products', async (req, res) => {
  const { category, subcategory, color, brand, minPrice, maxPrice } = req.query;
  console.log('GET /api/filter-products requested with filters:', req.query);

  try {
    let whereConditions = [];
    
    if (category) {
      whereConditions.push(`ProductCategory='${category}'`);
    }
    if (subcategory) {
      whereConditions.push(`ProductSubcategory='${subcategory}'`);
    }
    if (color) {
      whereConditions.push(`COLOR_NAME='${color}'`);
    }
    if (brand) {
      whereConditions.push(`BRAND_NAME='${brand}'`);
    }
    if (minPrice || maxPrice) {
      const priceConditions = [];
      const sizes = ['S', 'M', 'L', 'XL', 'XXL'];
      sizes.forEach(size => {
        let sizeCondition = '';
        if (minPrice) {
          sizeCondition += `${size}_Price >= ${minPrice}`;
        }
        if (maxPrice) {
          if (sizeCondition) sizeCondition += ' AND ';
          sizeCondition += `${size}_Price <= ${maxPrice}`;
        }
        if (sizeCondition) {
          priceConditions.push(`(${sizeCondition})`);
        }
      });
      if (priceConditions.length > 0) {
        whereConditions.push(`(${priceConditions.join(' OR ')})`);
      }
    }

    if (whereConditions.length === 0) {
      return res.status(400).json({ error: 'At least one filter parameter is required' });
    }

    const selectFields = [
      'STYLE', 'PRODUCT_TITLE', 'PRODUCT_DESCRIPTION', 'BRAND_NAME', 'COLOR_NAME',
      'FRONT_MODEL', 'CATEGORY_NAME', 'SUBCATEGORY_NAME', 'ProductStatus',
      'S_Price', 'M_Price', 'L_Price', 'XL_Price', 'XXL_Price'
    ];

    const records = await fetchAllCaspioPages('/tables/Sanmar_Bulk_251816_Feb2024/records', {
      'q.where': whereConditions.join(' AND '),
      'q.select': selectFields.join(', '),
      'q.limit': 100
    });

    // Deduplicate by style number
    const uniqueProducts = [];
    const seenStyles = new Set();
    
    records.forEach(record => {
      if (!seenStyles.has(record.STYLE)) {
        seenStyles.add(record.STYLE);
        uniqueProducts.push(record);
      }
    });

    console.log(`Filtered products: ${uniqueProducts.length} unique product(s) found`);
    res.json(uniqueProducts);
  } catch (error) {
    console.error('Error filtering products:', error.message);
    res.status(500).json({ error: 'Failed to filter products', details: error.message });
  }
});

// GET /api/quick-view
router.get('/quick-view', async (req, res) => {
  const { styleNumber } = req.query;
  console.log(`GET /api/quick-view requested with styleNumber=${styleNumber}`);

  if (!styleNumber) {
    return res.status(400).json({ error: 'styleNumber is required' });
  }

  try {
    const selectFields = [
      'STYLE', 'PRODUCT_TITLE', 'BRAND_NAME', 'FRONT_MODEL',
      'S_Price', 'M_Price', 'L_Price', 'XL_Price', 'XXL_Price',
      'ProductCategory', 'ProductSubcategory'
    ];

    const records = await fetchAllCaspioPages('/tables/Sanmar_Bulk_251816_Feb2024/records', {
      'q.where': `STYLE='${styleNumber}'`,
      'q.select': selectFields.join(', '),
      'q.limit': 1
    });

    if (records.length === 0) {
      return res.status(404).json({ error: 'Product not found' });
    }

    const product = records[0];
    const prices = [];
    ['S', 'M', 'L', 'XL', 'XXL'].forEach(size => {
      const price = product[`${size}_Price`];
      if (price) prices.push(parseFloat(price));
    });

    const quickView = {
      styleNumber: product.STYLE,
      title: product.ProductTitle,
      brand: product.BRAND_NAME,
      image: product.FRONT_MODEL,
      category: product.ProductCategory,
      subcategory: product.ProductSubcategory,
      priceRange: prices.length > 0 ? {
        min: Math.min(...prices),
        max: Math.max(...prices)
      } : null
    };

    console.log(`Quick view for ${styleNumber} retrieved successfully`);
    res.json(quickView);
  } catch (error) {
    console.error('Error fetching quick view:', error.message);
    res.status(500).json({ error: 'Failed to fetch quick view', details: error.message });
  }
});

// GET /api/compare-products
router.get('/compare-products', async (req, res) => {
  const { styles } = req.query;
  console.log(`GET /api/compare-products requested with styles=${styles}`);

  if (!styles) {
    return res.status(400).json({ error: 'styles parameter is required (comma-separated list)' });
  }

  const styleArray = styles.split(',').map(s => s.trim());
  
  if (styleArray.length < 2) {
    return res.status(400).json({ error: 'At least 2 style numbers are required for comparison' });
  }

  try {
    const comparisonData = [];
    
    for (const style of styleArray) {
      const records = await fetchAllCaspioPages('/tables/Sanmar_Bulk_251816_Feb2024/records', {
        'q.where': `STYLE='${style}'`,
        'q.select': 'STYLE, PRODUCT_TITLE, PRODUCT_DESCRIPTION, BRAND_NAME, FRONT_MODEL, CATEGORY_NAME, SUBCATEGORY_NAME, S_Price, M_Price, L_Price, XL_Price, XXL_Price',
        'q.limit': 1
      });

      if (records.length > 0) {
        comparisonData.push(records[0]);
      }
    }

    if (comparisonData.length === 0) {
      return res.status(404).json({ error: 'No products found for comparison' });
    }

    console.log(`Product comparison: ${comparisonData.length} products retrieved`);
    res.json(comparisonData);
  } catch (error) {
    console.error('Error comparing products:', error.message);
    res.status(500).json({ error: 'Failed to compare products', details: error.message });
  }
});

// GET /api/recommendations
router.get('/recommendations', async (req, res) => {
  const { styleNumber } = req.query;
  console.log(`GET /api/recommendations requested with styleNumber=${styleNumber}`);

  if (!styleNumber) {
    return res.status(400).json({ error: 'styleNumber parameter is required' });
  }

  try {
    // Get reference product details
    const referenceProduct = await fetchAllCaspioPages('/tables/Sanmar_Bulk_251816_Feb2024/records', {
      'q.where': `STYLE='${styleNumber}'`,
      'q.select': 'CATEGORY_NAME, BRAND_NAME, S_Price, M_Price, L_Price, XL_Price, XXL_Price',
      'q.limit': 1
    });

    if (referenceProduct.length === 0) {
      return res.status(404).json({ error: 'Reference product not found' });
    }

    const { CATEGORY_NAME, BRAND_NAME } = referenceProduct[0];
    
    // Calculate average price of reference product
    const prices = [];
    ['S', 'M', 'L', 'XL', 'XXL'].forEach(size => {
      const price = referenceProduct[0][`${size}_Price`];
      if (price) prices.push(parseFloat(price));
    });
    const avgPrice = prices.length > 0 ? prices.reduce((a, b) => a + b, 0) / prices.length : 0;
    
    // Build recommendation query
    const whereClause = `CATEGORY_NAME='${CATEGORY_NAME}' AND STYLE!='${styleNumber}'`;
    
    const selectFields = [
      'STYLE', 'PRODUCT_TITLE', 'PRODUCT_DESCRIPTION', 'BRAND_NAME',
      'FRONT_MODEL', 'CATEGORY_NAME', 'SUBCATEGORY_NAME',
      'S_Price', 'M_Price', 'L_Price', 'XL_Price', 'XXL_Price'
    ];

    const records = await fetchAllCaspioPages('/tables/Sanmar_Bulk_251816_Feb2024/records', {
      'q.where': whereClause,
      'q.select': selectFields.join(', '),
      'q.groupBy': selectFields.join(', '),
      'q.limit': 50
    });

    // Score and sort recommendations
    const recommendations = records.map(product => {
      let score = 0;
      
      // Same brand gets higher score
      if (product.BRAND_NAME === BRAND_NAME) score += 2;
      
      // Similar price range gets higher score
      const productPrices = [];
      ['S', 'M', 'L', 'XL', 'XXL'].forEach(size => {
        const price = product[`${size}_Price`];
        if (price) productPrices.push(parseFloat(price));
      });
      
      if (productPrices.length > 0) {
        const productAvgPrice = productPrices.reduce((a, b) => a + b, 0) / productPrices.length;
        const priceDiff = Math.abs(productAvgPrice - avgPrice) / avgPrice;
        if (priceDiff < 0.2) score += 3; // Within 20% of price
        else if (priceDiff < 0.5) score += 1; // Within 50% of price
      }
      
      return { ...product, recommendationScore: score };
    });

    // Sort by score and return top recommendations
    recommendations.sort((a, b) => b.recommendationScore - a.recommendationScore);
    const topRecommendations = recommendations.slice(0, 10);

    console.log(`Recommendations for ${styleNumber}: ${topRecommendations.length} product(s) found`);
    res.json(topRecommendations);
  } catch (error) {
    console.error('Error fetching recommendations:', error.message);
    res.status(500).json({ error: 'Failed to fetch recommendations', details: error.message });
  }
});

// Test endpoints (if any specific test endpoints are needed)
// GET /api/test-sanmar-bulk
router.get('/test-sanmar-bulk', async (req, res) => {
  console.log('GET /api/test-sanmar-bulk requested');
  
  try {
    const records = await fetchAllCaspioPages('/tables/Sanmar_Bulk_251816_Feb2024/records', {
      'q.limit': 5
    });
    
    console.log(`Test SanMar bulk: ${records.length} record(s) retrieved`);
    res.json({
      message: 'SanMar bulk data test successful',
      recordCount: records.length,
      sampleData: records
    });
  } catch (error) {
    console.error('Error in SanMar bulk test:', error.message);
    res.status(500).json({ error: 'Failed to test SanMar bulk data', details: error.message });
  }
});

// GET /api/staff-announcements
router.get('/staff-announcements', async (req, res) => {
  console.log('GET /api/staff-announcements requested');
  
  try {
    // Fetch active announcements from Caspio
    const announcements = await fetchAllCaspioPages('/tables/staff_announcements/records', {
      'q.where': 'IsActive=1',  // Only get active announcements (1 = true in Caspio)
      'q.orderBy': 'Priority ASC',  // Show highest priority first (1 is highest)
      'q.limit': 100
    });
    
    console.log(`Staff announcements: ${announcements.length} active announcement(s) found`);
    res.json(announcements);
  } catch (error) {
    console.error('Error fetching staff announcements:', error.message);
    res.status(500).json({ error: 'Failed to fetch staff announcements', details: error.message });
  }
});

module.exports = router;