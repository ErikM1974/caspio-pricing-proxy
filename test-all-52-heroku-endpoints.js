const axios = require('axios');
const fs = require('fs');

// Test against PRODUCTION Heroku
const BASE_URL = 'https://caspio-pricing-proxy-ab30a049961a.herokuapp.com';

// ALL 52 endpoints from API_ENDPOINTS.md
const ALL_ENDPOINTS = [
  // Art Invoice System
  { method: 'GET', path: '/api/artrequests', params: { limit: 5 }, description: 'Art requests list' },
  { method: 'GET', path: '/api/artrequests/52503', description: 'Single art request' },
  { method: 'PUT', path: '/api/artrequests/52503', body: { Invoiced: true }, description: 'Update art request' },
  { method: 'GET', path: '/api/art-invoices', params: { limit: 5 }, description: 'Art invoices list' },
  { method: 'POST', path: '/api/art-invoices', body: { InvoiceID: "TEST-" + Date.now(), ArtRequestID: "TEST" }, description: 'Create art invoice' },
  { method: 'GET', path: '/api/art-invoices/1', description: 'Get single invoice' },
  { method: 'PUT', path: '/api/art-invoices/1', body: { Status: "Draft" }, description: 'Update invoice' },
  { method: 'GET', path: '/api/art-invoices/stats', description: 'Invoice statistics' },
  { method: 'POST', path: '/api/art-invoices/1/payment', body: { amount: 100 }, description: 'Record payment' },
  { method: 'POST', path: '/api/art-invoices/1/reminder', description: 'Send reminder' },
  { method: 'POST', path: '/api/art-invoices/check-overdue', description: 'Check overdue' },
  { method: 'GET', path: '/api/art-invoices/search', params: { term: 'test' }, description: 'Search invoices' },
  
  // Production Schedule
  { method: 'GET', path: '/api/production-schedule/latest', description: 'Latest production schedule' },
  
  // Pricing System
  { method: 'GET', path: '/api/pricing/matrix', description: 'Pricing matrix' },
  { method: 'GET', path: '/api/pricing/calculate', params: { styleNumber: 'PC54' }, description: 'Calculate pricing' },
  { method: 'POST', path: '/api/pricing/bulk-calculate', body: { items: [] }, description: 'Bulk calculate' },
  { method: 'GET', path: '/api/pricing/tiers', params: { method: 'DTG' }, description: 'Pricing tiers (alt)' },
  { method: 'GET', path: '/api/pricing-tiers', params: { method: 'DTG' }, description: 'Pricing tiers' },
  
  // Quote System
  { method: 'GET', path: '/api/quotes', description: 'List quotes' },
  { method: 'POST', path: '/api/quotes', body: { quoteNumber: 'Q-TEST' }, description: 'Create quote' },
  { method: 'GET', path: '/api/quote_items', description: 'Quote items' },
  { method: 'GET', path: '/api/quote_analytics', description: 'Quote analytics' },
  { method: 'GET', path: '/api/quote_sessions', description: 'Quote sessions' },
  
  // Embellishment Services
  { method: 'POST', path: '/api/embellishments/embroidery/calculate', body: {}, description: 'Embroidery calc' },
  { method: 'POST', path: '/api/embellishments/embroidery/validate', body: {}, description: 'Embroidery validate' },
  { method: 'GET', path: '/api/embellishments/embroidery/estimate-stitches', description: 'Estimate stitches' },
  { method: 'POST', path: '/api/embellishments/screen-print/calculate', body: {}, description: 'Screen print calc' },
  { method: 'POST', path: '/api/embellishments/screen-print/validate', body: {}, description: 'Screen print validate' },
  { method: 'POST', path: '/api/embellishments/dtg/calculate', body: {}, description: 'DTG calc' },
  { method: 'POST', path: '/api/embellishments/dtg/validate', body: {}, description: 'DTG validate' },
  { method: 'GET', path: '/api/embellishments/dtg/check-compatibility', description: 'DTG compatibility' },
  { method: 'POST', path: '/api/embellishments/dtf/calculate', body: {}, description: 'DTF calc' },
  { method: 'POST', path: '/api/embellishments/dtf/validate', body: {}, description: 'DTF validate' },
  
  // Product Management
  { method: 'GET', path: '/api/products', description: 'List products' },
  { method: 'GET', path: '/api/products/PC54', description: 'Product details' },
  { method: 'GET', path: '/api/products/search', params: { q: 'shirt' }, description: 'Search products' },
  { method: 'GET', path: '/api/products/categories', description: 'Product categories' },
  { method: 'GET', path: '/api/products/PC54/inventory', description: 'Product inventory' },
  { method: 'GET', path: '/api/products/PC54/colors', description: 'Product colors' },
  { method: 'GET', path: '/api/products/PC54/sizes', description: 'Product sizes' },
  
  // Order Management
  { method: 'GET', path: '/api/orders', description: 'List orders' },
  { method: 'POST', path: '/api/orders', body: { orderNumber: 'TEST-001' }, description: 'Create order' },
  { method: 'GET', path: '/api/orders/1', description: 'Get order' },
  { method: 'PUT', path: '/api/orders/1', body: { status: 'Processing' }, description: 'Update order' },
  { method: 'POST', path: '/api/orders/1/cancel', description: 'Cancel order' },
  { method: 'GET', path: '/api/orders/1/tracking', description: 'Order tracking' },
  
  // Cart
  { method: 'GET', path: '/api/cart', description: 'Get cart' },
  { method: 'POST', path: '/api/cart/items', body: { styleNumber: 'PC54' }, description: 'Add to cart' },
  { method: 'PUT', path: '/api/cart/items/1', body: { quantity: 2 }, description: 'Update cart item' },
  { method: 'DELETE', path: '/api/cart/items/1', description: 'Remove from cart' },
  { method: 'POST', path: '/api/cart/clear', description: 'Clear cart' },
  { method: 'POST', path: '/api/cart/checkout', description: 'Checkout' },
  
  // User Management
  { method: 'POST', path: '/api/auth/login', body: { email: 'test@test.com', password: 'test' }, description: 'Login' },
  { method: 'POST', path: '/api/auth/logout', description: 'Logout' },
  { method: 'POST', path: '/api/auth/refresh', description: 'Refresh token' },
  { method: 'POST', path: '/api/auth/register', body: { email: 'new@test.com' }, description: 'Register' },
  { method: 'POST', path: '/api/auth/forgot-password', body: { email: 'test@test.com' }, description: 'Forgot password' },
  { method: 'POST', path: '/api/auth/reset-password', body: { token: 'test', password: 'new' }, description: 'Reset password' },
  { method: 'GET', path: '/api/user/profile', description: 'User profile' },
  { method: 'GET', path: '/api/user/preferences', description: 'User preferences' },
  { method: 'GET', path: '/api/user/addresses', description: 'User addresses' },
  { method: 'GET', path: '/api/user/quotes', description: 'User quotes' },
  { method: 'GET', path: '/api/user/orders', description: 'User orders' },
  
  // Utilities
  { method: 'POST', path: '/api/utils/upload', body: {}, description: 'File upload' },
  { method: 'GET', path: '/api/utils/search', params: { q: 'test' }, description: 'Global search' },
  { method: 'GET', path: '/api/utils/autocomplete', params: { q: 'test' }, description: 'Autocomplete' },
  { method: 'POST', path: '/api/utils/validate-address', body: { address: '123 Main St' }, description: 'Validate address' },
  { method: 'POST', path: '/api/utils/calculate-shipping', body: { weight: 1 }, description: 'Calculate shipping' },
  
  // Email
  { method: 'POST', path: '/api/art-invoices/1/send', description: 'Send invoice email' },
  { method: 'POST', path: '/api/art-invoices/1/send-reminder', description: 'Send reminder email' },
  { method: 'POST', path: '/api/art-requests/1/send-approval-reminder', description: 'Send approval reminder' },
  { method: 'GET', path: '/api/email/templates', description: 'Email templates' },
  { method: 'POST', path: '/api/email/test', body: { template_id: 'test' }, description: 'Test email' },
  
  // System
  { method: 'GET', path: '/api/health', description: 'Health check' }
];

// Additional endpoints that are implemented but not in API_ENDPOINTS.md
const ADDITIONAL_WORKING_ENDPOINTS = [
  { method: 'GET', path: '/api/stylesearch', params: { term: 'PC54' }, description: 'Style search' },
  { method: 'GET', path: '/api/product-colors', params: { styleNumber: 'PC54' }, description: 'Product colors' },
  { method: 'GET', path: '/api/inventory', params: { styleNumber: 'PC54' }, description: 'Inventory' },
  { method: 'GET', path: '/api/order-dashboard', description: 'Order dashboard' },
  { method: 'GET', path: '/api/staff-announcements', description: 'Staff announcements' },
  { method: 'GET', path: '/api/cart-sessions', description: 'Cart sessions' },
  { method: 'GET', path: '/api/cart-items', description: 'Cart items' },
  { method: 'GET', path: '/api/customers', description: 'Customers' }
];

async function testEndpoint(endpoint) {
  try {
    const config = {
      timeout: 5000,
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
    const is404 = status === 404;
    
    return {
      endpoint: `${endpoint.method} ${endpoint.path}`,
      description: endpoint.description,
      status,
      success: isSuccess,
      notFound: is404,
      exists: status !== 404
    };
  } catch (error) {
    return {
      endpoint: `${endpoint.method} ${endpoint.path}`,
      description: endpoint.description,
      status: 'ERROR',
      success: false,
      notFound: false,
      exists: false,
      error: error.message
    };
  }
}

async function runTests() {
  console.log('🚀 Testing ALL 52+ Endpoints on PRODUCTION Heroku\n');
  console.log(`URL: ${BASE_URL}\n`);
  
  const results = [];
  
  // Test main 52 endpoints
  console.log('Testing 52 documented endpoints from API_ENDPOINTS.md...\n');
  for (const endpoint of ALL_ENDPOINTS) {
    const result = await testEndpoint(endpoint);
    results.push(result);
    
    if (result.success) {
      console.log(`✅ ${endpoint.description}: ${result.status}`);
    } else if (result.notFound) {
      console.log(`❌ ${endpoint.description}: 404 NOT FOUND`);
    } else {
      console.log(`⚠️  ${endpoint.description}: ${result.status}`);
    }
  }
  
  // Test additional endpoints
  console.log('\n\nTesting additional implemented endpoints...\n');
  for (const endpoint of ADDITIONAL_WORKING_ENDPOINTS) {
    const result = await testEndpoint(endpoint);
    results.push(result);
    
    if (result.success) {
      console.log(`✅ ${endpoint.description}: ${result.status}`);
    } else if (result.notFound) {
      console.log(`❌ ${endpoint.description}: 404 NOT FOUND`);
    } else {
      console.log(`⚠️  ${endpoint.description}: ${result.status}`);
    }
  }
  
  // Summary
  const working = results.filter(r => r.success).length;
  const notFound = results.filter(r => r.notFound).length;
  const errors = results.filter(r => !r.success && !r.notFound).length;
  const total = results.length;
  
  console.log('\n' + '='.repeat(60));
  console.log('📊 HEROKU PRODUCTION STATUS');
  console.log('='.repeat(60));
  console.log(`Total Endpoints Tested: ${total}`);
  console.log(`✅ Working (2xx): ${working}`);
  console.log(`❌ Not Found (404): ${notFound}`);
  console.log(`⚠️  Other Errors: ${errors}`);
  console.log(`Success Rate: ${((working / total) * 100).toFixed(1)}%`);
  
  // Group by status
  console.log('\n📝 ENDPOINTS BY STATUS:\n');
  
  console.log('✅ WORKING ON HEROKU:');
  results.filter(r => r.success).forEach(r => {
    console.log(`  - ${r.endpoint}`);
  });
  
  console.log('\n❌ NOT DEPLOYED (404):');
  results.filter(r => r.notFound).forEach(r => {
    console.log(`  - ${r.endpoint}`);
  });
  
  if (errors > 0) {
    console.log('\n⚠️  OTHER ERRORS:');
    results.filter(r => !r.success && !r.notFound).forEach(r => {
      console.log(`  - ${r.endpoint}: ${r.status}`);
    });
  }
  
  // Save results
  const filename = 'heroku-52-endpoints-status.json';
  fs.writeFileSync(filename, JSON.stringify({
    timestamp: new Date().toISOString(),
    url: BASE_URL,
    summary: {
      total,
      working,
      notFound,
      errors,
      successRate: ((working / total) * 100).toFixed(1) + '%'
    },
    results
  }, null, 2));
  
  console.log(`\n📄 Results saved to: ${filename}`);
  
  if (notFound > 20) {
    console.log('\n🚨 DEPLOYMENT NEEDED!');
    console.log('Many endpoints are not available on Heroku.');
    console.log('Deploy with: git push heroku endpoint-migration:main');
  }
}

runTests();