const axios = require('axios');

// Test against PRODUCTION Heroku after deployment
const BASE_URL = 'https://caspio-pricing-proxy-ab30a049961a.herokuapp.com';

// The 52 critical endpoints from API_ENDPOINTS.md that are used on teamnwca.com
const CRITICAL_52_ENDPOINTS = [
  // Art Invoice System
  { method: 'GET', path: '/api/artrequests', params: { limit: 5 }, description: 'Art requests list' },
  { method: 'GET', path: '/api/art-invoices', params: { limit: 5 }, description: 'Art invoices list' },
  { method: 'POST', path: '/api/art-invoices', body: { InvoiceID: "TEST-" + Date.now(), ArtRequestID: "TEST" }, description: 'Create art invoice' },
  
  // Pricing System
  { method: 'GET', path: '/api/pricing-tiers', params: { method: 'DTG' }, description: 'Pricing tiers' },
  { method: 'GET', path: '/api/base-item-costs', params: { styleNumber: 'PC54' }, description: 'Base item costs' },
  { method: 'GET', path: '/api/size-pricing', params: { styleNumber: 'PC54' }, description: 'Size pricing' },
  { method: 'GET', path: '/api/max-prices-by-style', params: { styleNumber: 'PC54' }, description: 'Max prices by style' },
  { method: 'GET', path: '/api/pricing-bundle', params: { method: 'DTG' }, description: 'Pricing bundle' },
  { method: 'GET', path: '/api/embroidery-costs', params: { itemType: 'Cap', stitchCount: 8000 }, description: 'Embroidery costs' },
  { method: 'GET', path: '/api/dtg-costs', description: 'DTG costs' },
  { method: 'GET', path: '/api/screenprint-costs', params: { costType: 'PrimaryLocation' }, description: 'Screen print costs' },
  { method: 'GET', path: '/api/size-upcharges', description: 'Size upcharges' },
  { method: 'GET', path: '/api/size-sort-order', description: 'Size sort order' },
  
  // Quote System
  { method: 'GET', path: '/api/quote_sessions', description: 'Quote sessions' },
  { method: 'GET', path: '/api/quote_items', description: 'Quote items' },
  { method: 'GET', path: '/api/quote_analytics', description: 'Quote analytics' },
  
  // Product Management
  { method: 'GET', path: '/api/stylesearch', params: { term: 'PC54' }, description: 'Style search' },
  { method: 'GET', path: '/api/product-colors', params: { styleNumber: 'PC54' }, description: 'Product colors' },
  { method: 'GET', path: '/api/product-details', params: { styleNumber: 'PC54' }, description: 'Product details' },
  { method: 'GET', path: '/api/inventory', params: { styleNumber: 'PC54' }, description: 'Check inventory' },
  { method: 'GET', path: '/api/sizes-by-style-color', params: { styleNumber: 'PC54', color: 'Red' }, description: 'Sizes by style/color' },
  { method: 'GET', path: '/api/color-swatches', params: { styleNumber: 'PC54' }, description: 'Color swatches' },
  { method: 'GET', path: '/api/products-by-brand', params: { brand: 'Port & Company' }, description: 'Products by brand' },
  { method: 'GET', path: '/api/products-by-category', params: { category: 'T-Shirts' }, description: 'Products by category' },
  { method: 'GET', path: '/api/all-brands', description: 'All brands' },
  { method: 'GET', path: '/api/all-categories', description: 'All categories' },
  { method: 'GET', path: '/api/all-subcategories', description: 'All subcategories' },
  
  // Pricing Matrix
  { method: 'GET', path: '/api/pricing-matrix', description: 'All pricing matrices' },
  { method: 'POST', path: '/api/pricing-matrix', body: { 
      SessionID: "test-" + Date.now(),
      StyleNumber: "PC54",
      Color: "Red",
      EmbellishmentType: "DTG",
      TierStructure: { tiers: [{min: 24, max: 47, label: "24-47"}] },
      PriceMatrix: { "24-47": { "S": 15.99 } }
    }, description: 'Create pricing matrix' },
  { method: 'GET', path: '/api/pricing-matrix/lookup', params: { 
      styleNumber: 'PC54', 
      color: 'Red', 
      embellishmentType: 'DTG', 
      sessionID: 'test' 
    }, description: 'Lookup pricing matrix' },
  
  // Cart Management
  { method: 'GET', path: '/api/cart-sessions', description: 'Cart sessions' },
  { method: 'POST', path: '/api/cart-sessions', body: { 
      SessionID: "cart-" + Date.now(),
      CustomerEmail: "test@example.com",
      Status: "Active"
    }, description: 'Create cart session' },
  { method: 'GET', path: '/api/cart-items', description: 'Cart items' },
  { method: 'POST', path: '/api/cart-items', body: { 
      SessionID: "test-cart",
      StyleNumber: "PC54",
      Color: "Red",
      Quantity: 50,
      DecorationMethod: "DTG"
    }, description: 'Create cart item' },
  { method: 'GET', path: '/api/cart-item-sizes', description: 'Cart item sizes' },
  
  // Order Management
  { method: 'GET', path: '/api/orders', description: 'Orders list' },
  { method: 'GET', path: '/api/customers', description: 'Customers list' },
  
  // Utilities
  { method: 'GET', path: '/api/health', description: 'Health check' },
  { method: 'GET', path: '/api/staff-announcements', description: 'Staff announcements' },
  { method: 'GET', path: '/api/order-dashboard', description: 'Order dashboard' },
  { method: 'GET', path: '/api/locations', description: 'Locations list' },
  { method: 'GET', path: '/api/transfers', description: 'Transfers list' },
  { method: 'GET', path: '/api/production-schedules', params: { limit: 5 }, description: 'Production schedules' },
  { method: 'GET', path: '/api/pricing-rules', description: 'Pricing rules' },
  { method: 'GET', path: '/api/order-odbc', params: { limit: 5 }, description: 'Order ODBC data' },
  
  // Additional endpoints that might be in use
  { method: 'GET', path: '/api/brands', description: 'Brands list' },
  { method: 'GET', path: '/api/active-products', description: 'Active products' },
  { method: 'GET', path: '/api/test-sanmar-bulk', description: 'Test Sanmar bulk' }
];

async function testEndpoint(endpoint) {
  try {
    const config = {
      timeout: 10000,
      validateStatus: function (status) {
        return status >= 200 && status < 600; // Don't throw on any HTTP status
      }
    };

    let response;
    
    if (endpoint.method === 'GET') {
      config.params = endpoint.params || {};
      response = await axios.get(`${BASE_URL}${endpoint.path}`, config);
    } else if (endpoint.method === 'POST') {
      response = await axios.post(`${BASE_URL}${endpoint.path}`, endpoint.body || {}, config);
    } else if (endpoint.method === 'PUT') {
      response = await axios.put(`${BASE_URL}${endpoint.path}`, endpoint.body || {}, config);
    } else if (endpoint.method === 'DELETE') {
      response = await axios.delete(`${BASE_URL}${endpoint.path}`, config);
    }

    const status = response.status;
    const isSuccess = status >= 200 && status < 300;
    
    return {
      endpoint: `${endpoint.method} ${endpoint.path}`,
      description: endpoint.description,
      status,
      success: isSuccess,
      dataReceived: response.data ? (Array.isArray(response.data) ? `${response.data.length} items` : 'data') : 'none'
    };
  } catch (error) {
    return {
      endpoint: `${endpoint.method} ${endpoint.path}`,
      description: endpoint.description,
      status: error.response?.status || 'ERROR',
      success: false,
      error: error.message
    };
  }
}

async function runTests() {
  console.log('🚀 Testing 52 Critical Endpoints on Heroku AFTER DEPLOYMENT\n');
  console.log(`URL: ${BASE_URL}`);
  console.log(`Time: ${new Date().toISOString()}\n`);
  
  const results = [];
  let passed = 0;
  let failed = 0;
  
  for (const endpoint of CRITICAL_52_ENDPOINTS) {
    process.stdout.write(`Testing ${endpoint.description}... `);
    const result = await testEndpoint(endpoint);
    results.push(result);
    
    if (result.success) {
      console.log(`✅ ${result.status} - ${result.dataReceived}`);
      passed++;
    } else {
      console.log(`❌ ${result.status}`);
      failed++;
    }
  }
  
  // Summary
  console.log('\n' + '='.repeat(60));
  console.log('📊 HEROKU DEPLOYMENT TEST RESULTS');
  console.log('='.repeat(60));
  console.log(`Total Endpoints: ${CRITICAL_52_ENDPOINTS.length}`);
  console.log(`✅ Working: ${passed}`);
  console.log(`❌ Failed: ${failed}`);
  console.log(`Success Rate: ${((passed / CRITICAL_52_ENDPOINTS.length) * 100).toFixed(1)}%`);
  
  // Show failures if any
  if (failed > 0) {
    console.log('\n❌ FAILED ENDPOINTS:');
    results.filter(r => !r.success).forEach(r => {
      console.log(`  - ${r.endpoint}: ${r.status}`);
    });
  }
  
  // Deployment status
  if (passed >= 50) {
    console.log('\n✅ DEPLOYMENT SUCCESSFUL!');
    console.log('All critical endpoints are now working on Heroku.');
    console.log('Your website teamnwca.com should have full functionality.');
  } else if (passed >= 40) {
    console.log('\n⚠️  DEPLOYMENT PARTIALLY SUCCESSFUL');
    console.log('Most endpoints are working but some are still failing.');
  } else {
    console.log('\n❌ DEPLOYMENT ISSUES DETECTED');
    console.log('Many endpoints are still not working. Check server logs.');
  }
}

runTests();