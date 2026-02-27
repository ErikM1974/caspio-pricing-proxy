const axios = require('axios');
const fs = require('fs');

const BASE_URL = 'http://localhost:3002';

// Production endpoints - fixed to match actual implementation
const PRODUCTION_ENDPOINTS = [
  // Art Invoice System (working endpoints)
  { method: 'GET', path: '/api/artrequests', params: { limit: 10 }, description: 'Art requests list' },
  { method: 'GET', path: '/api/art-invoices', params: { limit: 10 }, description: 'Art invoices list' },
  { method: 'POST', path: '/api/art-invoices', body: { 
      InvoiceID: "TEST-" + Date.now(), 
      ArtRequestID: "TEST-REQ-001",
      CustomerName: "Test Customer",
      Status: "Draft"
    }, description: 'Create art invoice' },
  
  // Pricing System (all working)
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
  
  // Quote System (all working)
  { method: 'GET', path: '/api/quote_sessions', description: 'Quote sessions' },
  { method: 'GET', path: '/api/quote_items', description: 'Quote items' },
  { method: 'GET', path: '/api/quote_analytics', description: 'Quote analytics' },
  
  // Product Management (fixed params)
  { method: 'GET', path: '/api/stylesearch', params: { term: 'PC54' }, description: 'Style search' },
  { method: 'GET', path: '/api/product-colors', params: { styleNumber: 'PC54' }, description: 'Product colors' },
  { method: 'GET', path: '/api/product-details', params: { styleNumber: 'PC54' }, description: 'Product details' },
  { method: 'GET', path: '/api/inventory', params: { styleNumber: 'PC54' }, description: 'Check inventory' },
  { method: 'GET', path: '/api/sizes-by-style-color', params: { styleNumber: 'PC54', color: 'Red' }, description: 'Sizes by style/color' },
  { method: 'GET', path: '/api/color-swatches', params: { brandName: 'Port & Company' }, description: 'Color swatches' },
  { method: 'GET', path: '/api/products-by-brand', params: { brand: 'Port & Company' }, description: 'Products by brand' },
  { method: 'GET', path: '/api/products-by-category', params: { category: 'T-Shirts' }, description: 'Products by category' },
  { method: 'GET', path: '/api/all-brands', description: 'All brands' },
  { method: 'GET', path: '/api/all-categories', description: 'All categories' },
  { method: 'GET', path: '/api/all-subcategories', description: 'All subcategories' },
  
  // Pricing Matrix (with proper data)
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
  
  // Cart Management (with proper data)
  { method: 'GET', path: '/api/cart-sessions', description: 'Cart sessions' },
  { method: 'POST', path: '/api/cart-sessions', body: { 
      SessionID: "cart-" + Date.now(),
      CustomerEmail: "test@example.com",
      Status: "Active"
    }, description: 'Create cart session' },
  { method: 'GET', path: '/api/cart-items', description: 'Cart items' },
  { method: 'POST', path: '/api/cart-items', body: { 
      CartSessionID: "test-cart",
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
  { method: 'GET', path: '/api/test-sanmar-bulk', description: 'Test Sanmar bulk' }
];

async function testEndpoint(endpoint) {
  try {
    const config = {
      timeout: 30000,
      validateStatus: function (status) {
        return status >= 200 && status < 500;
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
      responseTime: response.headers['x-response-time'] || 'N/A',
      dataReceived: response.data ? (Array.isArray(response.data) ? response.data.length : 'object') : 'none'
    };
  } catch (error) {
    return {
      endpoint: `${endpoint.method} ${endpoint.path}`,
      description: endpoint.description,
      status: error.response?.status || 'ERROR',
      success: false,
      error: error.message,
      responseTime: 'N/A',
      dataReceived: 'error'
    };
  }
}

async function runTests() {
  console.log('🚀 Testing Production Endpoints (Fixed) for teamnwca.com\n');
  console.log(`Testing ${PRODUCTION_ENDPOINTS.length} endpoints...\n`);
  
  const results = [];
  let passed = 0;
  let failed = 0;
  
  for (const endpoint of PRODUCTION_ENDPOINTS) {
    process.stdout.write(`Testing ${endpoint.method} ${endpoint.path}... `);
    const result = await testEndpoint(endpoint);
    results.push(result);
    
    if (result.success) {
      console.log(`✅ ${result.status}`);
      passed++;
    } else {
      console.log(`❌ ${result.status} - ${result.error || 'Failed'}`);
      failed++;
    }
  }
  
  // Summary
  console.log('\n' + '='.repeat(60));
  console.log('📊 TEST SUMMARY');
  console.log('='.repeat(60));
  console.log(`Total Endpoints: ${PRODUCTION_ENDPOINTS.length}`);
  console.log(`✅ Passed: ${passed}`);
  console.log(`❌ Failed: ${failed}`);
  console.log(`Success Rate: ${((passed / PRODUCTION_ENDPOINTS.length) * 100).toFixed(1)}%`);
  
  // Show failures
  if (failed > 0) {
    console.log('\n❌ FAILED ENDPOINTS:');
    results.filter(r => !r.success).forEach(r => {
      console.log(`  - ${r.endpoint}: ${r.status} ${r.error || ''}`);
    });
  }
  
  // Save results
  const timestamp = new Date().toISOString().replace(/:/g, '-').split('.')[0];
  const filename = `production-test-results-fixed-${timestamp}.json`;
  fs.writeFileSync(filename, JSON.stringify({
    timestamp: new Date().toISOString(),
    baseUrl: BASE_URL,
    totalEndpoints: PRODUCTION_ENDPOINTS.length,
    passed,
    failed,
    successRate: ((passed / PRODUCTION_ENDPOINTS.length) * 100).toFixed(1) + '%',
    results
  }, null, 2));
  
  console.log(`\n📄 Results saved to: ${filename}`);
  
  // List missing endpoints that might need to be implemented
  console.log('\n📝 Note: Some endpoints from API_ENDPOINTS.md are not implemented:');
  console.log('  - GET /api/art-invoices/stats (statistics endpoint)');
  console.log('  - GET /api/production-schedule/latest (production schedule)');
  console.log('  - GET /api/pricing/matrix (different from /api/pricing-matrix)');
  console.log('  - GET /api/pricing/calculate (calculation endpoint)');
  console.log('  - POST /api/pricing/bulk-calculate (bulk calculation)');
  console.log('  - GET /api/products (general products list)');
  console.log('  - GET /api/products/search (product search)');
  console.log('  - GET /api/products/categories (categories list)');
  console.log('\nThese can be added to modules as needed.');
  
  return { passed, failed };
}

// Check if server is running first
console.log('🔍 Checking server status...');
axios.get(`${BASE_URL}/api/health`, { timeout: 5000 })
  .then(() => {
    console.log('✅ Server is running!\n');
    runTests();
  })
  .catch(() => {
    console.log('❌ Server is not running! Please start the server first with:');
    console.log('   node start-server.js');
  });