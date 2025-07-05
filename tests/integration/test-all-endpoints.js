// Comprehensive test for ALL endpoints

const axios = require('axios');
const BASE_URL = 'http://localhost:3002';

// Test results tracking
let passed = 0;
let failed = 0;
const results = [];

async function testEndpoint(name, method, url, data = null) {
  try {
    const config = {
      method,
      url,
      timeout: 10000
    };
    
    if (data) {
      config.data = data;
    }
    
    const startTime = Date.now();
    const response = await axios(config);
    const duration = Date.now() - startTime;
    
    console.log(`✅ ${name} - ${duration}ms`);
    passed++;
    results.push({ name, status: 'PASS', duration });
    return true;
  } catch (error) {
    console.log(`❌ ${name} - ${error.response?.status || 'ERROR'}: ${error.message}`);
    failed++;
    results.push({ 
      name, 
      status: 'FAIL', 
      error: error.response?.status || error.code,
      message: error.response?.data?.error || error.message
    });
    return false;
  }
}

async function runAllTests() {
  console.log('Testing ALL Endpoints');
  console.log('=====================\n');
  
  // Status & Test
  await testEndpoint('Status', 'GET', `${BASE_URL}/status`);
  await testEndpoint('Test', 'GET', `${BASE_URL}/test`);
  
  // Pricing endpoints
  await testEndpoint('Pricing Tiers - DTG', 'GET', `${BASE_URL}/api/pricing-tiers?method=DTG`);
  await testEndpoint('Pricing Tiers - ScreenPrint', 'GET', `${BASE_URL}/api/pricing-tiers?method=ScreenPrint`);
  await testEndpoint('Pricing Tiers - Embroidery', 'GET', `${BASE_URL}/api/pricing-tiers?method=Embroidery`);
  await testEndpoint('Embroidery Costs', 'GET', `${BASE_URL}/api/embroidery-costs?itemType=Cap&stitchCount=5000`);
  await testEndpoint('DTG Costs', 'GET', `${BASE_URL}/api/dtg-costs`);
  await testEndpoint('Screenprint Costs', 'GET', `${BASE_URL}/api/screenprint-costs?costType=PrimaryLocation`);
  await testEndpoint('Pricing Rules', 'GET', `${BASE_URL}/api/pricing-rules?method=DTG`);
  await testEndpoint('Base Item Costs', 'GET', `${BASE_URL}/api/base-item-costs?styleNumber=PC61`);
  await testEndpoint('Size Pricing', 'GET', `${BASE_URL}/api/size-pricing?styleNumber=PC61`);
  await testEndpoint('Max Prices by Style', 'GET', `${BASE_URL}/api/max-prices-by-style?styles=PC61,3001C`);
  
  // Product endpoints
  await testEndpoint('Style Search', 'GET', `${BASE_URL}/api/stylesearch?term=PC`);
  await testEndpoint('Product Details', 'GET', `${BASE_URL}/api/product-details?styleNumber=PC61`);
  await testEndpoint('Product Details with Color', 'GET', `${BASE_URL}/api/product-details?styleNumber=PC61&color=Black`);
  await testEndpoint('Color Swatches', 'GET', `${BASE_URL}/api/color-swatches?styleNumber=PC61`);
  await testEndpoint('Product Colors', 'GET', `${BASE_URL}/api/product-colors?styleNumber=PC61`);
  await testEndpoint('All Brands', 'GET', `${BASE_URL}/api/all-brands`);
  await testEndpoint('Products by Brand', 'GET', `${BASE_URL}/api/products-by-brand?brand=Port`);
  await testEndpoint('All Categories', 'GET', `${BASE_URL}/api/all-categories`);
  await testEndpoint('All Subcategories', 'GET', `${BASE_URL}/api/all-subcategories`);
  await testEndpoint('Products by Category', 'GET', `${BASE_URL}/api/products-by-category?category=T-Shirts`);
  await testEndpoint('Products by Subcategory', 'GET', `${BASE_URL}/api/products-by-subcategory?subcategory=Men's`);
  await testEndpoint('Subcategories by Category', 'GET', `${BASE_URL}/api/subcategories-by-category?category=T-Shirts`);
  await testEndpoint('Products by Cat/Subcat', 'GET', `${BASE_URL}/api/products-by-category-subcategory?category=T-Shirts&subcategory=Men's`);
  await testEndpoint('Search Products', 'GET', `${BASE_URL}/api/search?q=hoodie`);
  await testEndpoint('Featured Products', 'GET', `${BASE_URL}/api/featured-products`);
  await testEndpoint('Related Products', 'GET', `${BASE_URL}/api/related-products?styleNumber=PC61`);
  await testEndpoint('Filter Products', 'GET', `${BASE_URL}/api/filter-products?category=T-Shirts&maxPrice=30`);
  await testEndpoint('Recommendations', 'GET', `${BASE_URL}/api/recommendations?styleNumber=PC61`);
  await testEndpoint('Quick View', 'GET', `${BASE_URL}/api/quick-view?styleNumber=PC61`);
  await testEndpoint('Compare Products', 'GET', `${BASE_URL}/api/compare-products?styles=PC61,3001C`);
  
  // Inventory endpoints
  await testEndpoint('Inventory', 'GET', `${BASE_URL}/api/inventory?styleNumber=PC61`);
  await testEndpoint('Inventory with Color', 'GET', `${BASE_URL}/api/inventory?styleNumber=PC61&color=Black`);
  await testEndpoint('Sizes by Style/Color', 'GET', `${BASE_URL}/api/sizes-by-style-color?styleNumber=PC61&color=Black`);
  
  // Cart endpoints
  await testEndpoint('Cart Sessions - GET', 'GET', `${BASE_URL}/api/cart-sessions`);
  await testEndpoint('Cart Items - GET', 'GET', `${BASE_URL}/api/cart-items`);
  await testEndpoint('Cart Item Sizes - GET', 'GET', `${BASE_URL}/api/cart-item-sizes`);
  
  // Customer endpoints
  await testEndpoint('Customers - GET', 'GET', `${BASE_URL}/api/customers`);
  
  // Order endpoints
  await testEndpoint('Orders - GET', 'GET', `${BASE_URL}/api/orders`);
  
  // Pricing Matrix endpoints
  await testEndpoint('Pricing Matrix - GET', 'GET', `${BASE_URL}/api/pricing-matrix`);
  await testEndpoint('Pricing Matrix Lookup', 'GET', `${BASE_URL}/api/pricing-matrix/lookup?styleNumber=PC61&color=BLACK&embellishmentType=DTG`);
  
  // Quote endpoints
  await testEndpoint('Quote Analytics - GET', 'GET', `${BASE_URL}/api/quote_analytics`);
  await testEndpoint('Quote Items - GET', 'GET', `${BASE_URL}/api/quote_items`);
  await testEndpoint('Quote Sessions - GET', 'GET', `${BASE_URL}/api/quote_sessions`);
  
  // Misc endpoints
  await testEndpoint('Test SanMar Bulk', 'GET', `${BASE_URL}/api/test-sanmar-bulk`);
  await testEndpoint('Cart Integration Script', 'GET', `${BASE_URL}/api/cart-integration.js`);
  
  // Summary
  console.log('\n\nTest Summary');
  console.log('============');
  console.log(`Total: ${passed + failed}`);
  console.log(`Passed: ${passed}`);
  console.log(`Failed: ${failed}`);
  console.log(`Success Rate: ${((passed / (passed + failed)) * 100).toFixed(1)}%`);
  
  // Show failed endpoints
  if (failed > 0) {
    console.log('\nFailed Endpoints:');
    results.filter(r => r.status === 'FAIL').forEach(r => {
      console.log(`- ${r.name}: ${r.error} - ${r.message}`);
    });
  }
}

// Check if server is running
axios.get(`${BASE_URL}/status`)
  .then(() => {
    console.log('Server is running at', BASE_URL);
    runAllTests();
  })
  .catch(() => {
    console.error('Server is not running. Please start the server first with: node server.js');
  });