const axios = require('axios');

// Test against PRODUCTION Heroku
const BASE_URL = 'https://caspio-pricing-proxy-ab30a049961a.herokuapp.com';

// Just test a few critical endpoints to see if Heroku is up to date
const CRITICAL_ENDPOINTS = [
  { method: 'GET', path: '/api/health', description: 'Health check' },
  { method: 'GET', path: '/api/order-dashboard', description: 'Order dashboard' },
  { method: 'GET', path: '/api/staff-announcements', description: 'Staff announcements' },
  { method: 'GET', path: '/api/pricing-tiers', params: { method: 'DTG' }, description: 'Pricing tiers' },
  { method: 'GET', path: '/api/stylesearch', params: { term: 'PC54' }, description: 'Style search' },
  { method: 'GET', path: '/api/product-colors', params: { styleNumber: 'PC54' }, description: 'Product colors' },
  { method: 'GET', path: '/api/art-invoices', params: { limit: 5 }, description: 'Art invoices' },
  { method: 'GET', path: '/api/cart-sessions', description: 'Cart sessions' },
  { method: 'GET', path: '/api/inventory', params: { styleNumber: 'PC54' }, description: 'Inventory' },
  { method: 'GET', path: '/api/size-pricing', params: { styleNumber: 'PC54' }, description: 'Size pricing' }
];

async function testEndpoint(endpoint) {
  try {
    const config = {
      timeout: 10000,
      params: endpoint.params || {}
    };

    const response = await axios.get(`${BASE_URL}${endpoint.path}`, config);
    
    return {
      endpoint: `${endpoint.method} ${endpoint.path}`,
      description: endpoint.description,
      status: response.status,
      success: true,
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
  console.log('🚀 Testing PRODUCTION Heroku Endpoints\n');
  console.log(`URL: ${BASE_URL}\n`);
  console.log('Testing critical endpoints to check deployment status...\n');
  
  let passed = 0;
  let failed = 0;
  
  for (const endpoint of CRITICAL_ENDPOINTS) {
    process.stdout.write(`Testing ${endpoint.description}... `);
    const result = await testEndpoint(endpoint);
    
    if (result.success) {
      console.log(`✅ ${result.status} - ${result.dataReceived}`);
      passed++;
    } else {
      console.log(`❌ ${result.status} - ${result.error}`);
      failed++;
    }
  }
  
  console.log('\n' + '='.repeat(60));
  console.log(`✅ Passed: ${passed}`);
  console.log(`❌ Failed: ${failed}`);
  
  if (failed === 0) {
    console.log('\n🎉 All critical endpoints are working on Heroku!');
    console.log('Your production server is already running the latest code.');
  } else if (passed > failed) {
    console.log('\n⚠️  Some endpoints are failing on Heroku.');
    console.log('You may need to deploy the latest changes.');
  } else {
    console.log('\n❌ Most endpoints are failing on Heroku.');
    console.log('You definitely need to deploy the latest changes.');
  }
  
  console.log('\nTo deploy latest changes to Heroku:');
  console.log('  git push heroku endpoint-migration:main');
}

runTests();