const axios = require('axios');
const fs = require('fs');

const BASE_URL = 'http://localhost:3002';

// Production endpoints from API_ENDPOINTS.md that teamnwca.com actually uses
const PRODUCTION_ENDPOINTS = [
  // Art Invoice System
  { method: 'GET', path: '/api/artrequests', params: { limit: 10 }, description: 'Art requests list' },
  { method: 'GET', path: '/api/artrequests/52503', description: 'Single art request' },
  { method: 'GET', path: '/api/art-invoices', params: { limit: 10 }, description: 'Art invoices list' },
  { method: 'POST', path: '/api/art-invoices', body: { idDesign: "TEST-001", customerName: "Test" }, description: 'Create art invoice' },
  { method: 'GET', path: '/api/art-invoices/stats', description: 'Invoice statistics' },
  
  // Production Schedule
  { method: 'GET', path: '/api/production-schedule/latest', description: 'Latest production schedule' },
  
  // Pricing System
  { method: 'GET', path: '/api/pricing/matrix', description: 'Pricing matrix' },
  { method: 'GET', path: '/api/pricing/calculate', params: { styleNumber: 'PC54' }, description: 'Calculate pricing' },
  { method: 'POST', path: '/api/pricing/bulk-calculate', body: { items: [] }, description: 'Bulk pricing calculation' },
  { method: 'GET', path: '/api/pricing-tiers', params: { method: 'DTG' }, description: 'Pricing tiers' },
  
  // Quote System
  { method: 'GET', path: '/api/quote_sessions', description: 'Quote sessions' },
  { method: 'GET', path: '/api/quote_items', description: 'Quote items' },
  { method: 'GET', path: '/api/quote_analytics', description: 'Quote analytics' },
  
  // Product Management
  { method: 'GET', path: '/api/products', description: 'Products list' },
  { method: 'GET', path: '/api/products/search', params: { q: 'shirt' }, description: 'Product search' },
  { method: 'GET', path: '/api/products/categories', description: 'Product categories' },
  { method: 'GET', path: '/api/stylesearch', params: { style: 'PC54' }, description: 'Style search' },
  { method: 'GET', path: '/api/product-colors', params: { styleNumber: 'PC54' }, description: 'Product colors' },
  
  // Pricing & Costs
  { method: 'GET', path: '/api/base-item-costs', params: { styleNumber: 'PC54' }, description: 'Base item costs' },
  { method: 'GET', path: '/api/size-pricing', params: { styleNumber: 'PC54' }, description: 'Size pricing' },
  { method: 'GET', path: '/api/max-prices-by-style', params: { styleNumber: 'PC54' }, description: 'Max prices by style' },
  { method: 'GET', path: '/api/pricing-bundle', params: { method: 'DTG' }, description: 'Pricing bundle' },
  
  // Pricing Matrix CRUD
  { method: 'GET', path: '/api/pricing-matrix', description: 'All pricing matrices' },
  { method: 'POST', path: '/api/pricing-matrix', body: { SessionID: "test", StyleNumber: "PC54" }, description: 'Create pricing matrix' },
  { method: 'GET', path: '/api/pricing-matrix/lookup', params: { styleNumber: 'PC54', color: 'Red', embellishmentType: 'DTG', sessionID: 'test' }, description: 'Lookup pricing matrix' },
  
  // Cart Management
  { method: 'GET', path: '/api/cart-sessions', description: 'Cart sessions' },
  { method: 'POST', path: '/api/cart-sessions', body: { SessionID: "test-cart" }, description: 'Create cart session' },
  { method: 'GET', path: '/api/cart-items', description: 'Cart items' },
  { method: 'POST', path: '/api/cart-items', body: { CartSessionID: "test", StyleNumber: "PC54" }, description: 'Create cart item' },
  { method: 'GET', path: '/api/cart-item-sizes', description: 'Cart item sizes' },
  
  // Order Management
  { method: 'GET', path: '/api/orders', description: 'Orders list' },
  { method: 'GET', path: '/api/customers', description: 'Customers list' },
  
  // Utilities
  { method: 'GET', path: '/api/inventory', params: { styleNumber: 'PC54' }, description: 'Check inventory' },
  { method: 'GET', path: '/api/health', description: 'Health check' },
  { method: 'GET', path: '/api/sizes-by-style-color', params: { styleNumber: 'PC54', color: 'Red' }, description: 'Sizes by style/color' },
  
  // Staff/Dashboard specific
  { method: 'GET', path: '/api/staff-announcements', description: 'Staff announcements' },
  { method: 'GET', path: '/api/order-dashboard', description: 'Order dashboard' },
  
  // Additional pricing endpoints
  { method: 'GET', path: '/api/embroidery-costs', params: { itemType: 'Cap', stitchCount: 8000 }, description: 'Embroidery costs' },
  { method: 'GET', path: '/api/dtg-costs', description: 'DTG costs' },
  { method: 'GET', path: '/api/screenprint-costs', params: { costType: 'PrimaryLocation' }, description: 'Screen print costs' },
  { method: 'GET', path: '/api/size-upcharges', description: 'Size upcharges' },
  { method: 'GET', path: '/api/size-sort-order', description: 'Size sort order' },
  
  // Location and testing
  { method: 'GET', path: '/api/locations', description: 'Locations list' },
  { method: 'GET', path: '/api/test-sanmar-bulk', description: 'Test Sanmar bulk' }
];

async function testEndpoint(endpoint) {
  try {
    const config = {
      timeout: 30000,
      validateStatus: function (status) {
        return status >= 200 && status < 500; // Don't throw on 404s
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
  console.log('🚀 Testing Production Endpoints for teamnwca.com\n');
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
  const filename = `production-test-results-${timestamp}.json`;
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