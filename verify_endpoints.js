const axios = require('axios');
const colors = require('colors');

const BASE_URL = 'https://caspio-pricing-proxy-ab30a049961a.herokuapp.com/api';

// Sample data for POST requests
const sampleData = {
  cartSession: {
    SessionID: 'test-session-' + Date.now(),
    IsActive: true
  },
  cartItem: {
    SessionID: 'test-session-' + Date.now(),
    ProductID: 'TEST123',
    StyleNumber: 'PC61',
    Color: 'Ash'
  },
  cartItemSize: {
    CartItemID: 1,
    Size: 'L',
    Quantity: 1
  },
  order: {
    CustomerID: 1,
    OrderStatus: 'New'
  },
  customer: {
    Name: 'Test Customer',
    Email: 'test@example.com'
  },
  pricingMatrix: {
    SessionID: 'test-session-' + Date.now(),
    StyleNumber: 'PC61',
    Color: 'Ash',
    EmbellishmentType: 'DTG'
  },
  quoteAnalytics: {
    SessionID: 'test-session-' + Date.now(),
    EventType: 'View'
  },
  quoteItem: {
    QuoteID: '1',
    StyleNumber: 'PC61',
    Quantity: 10
  },
  quoteSession: {
    QuoteID: '1',
    SessionID: 'test-session-' + Date.now(),
    Status: 'Active'
  }
};

const endpoints = [
  // Status endpoints
  { method: 'get', url: '/status', name: 'Status Check' },
  { method: 'get', url: '/test', name: 'Test Endpoint' },

  // Cart API
  { method: 'get', url: '/cart-sessions', name: 'Get Cart Sessions' },
  { method: 'post', url: '/cart-sessions', data: sampleData.cartSession, name: 'Create Cart Session' },
  { method: 'get', url: '/cart-items', name: 'Get Cart Items' },
  { method: 'post', url: '/cart-items', data: sampleData.cartItem, name: 'Create Cart Item' },
  { method: 'get', url: '/cart-item-sizes', name: 'Get Cart Item Sizes' },
  { method: 'post', url: '/cart-item-sizes', data: sampleData.cartItemSize, name: 'Create Cart Item Size' },

  // Pricing API
  { method: 'get', url: '/pricing-tiers?method=DTG', name: 'Get DTG Pricing Tiers' },
  { method: 'get', url: '/embroidery-costs?itemType=Shirt&stitchCount=5000', name: 'Get Embroidery Costs' },
  { method: 'get', url: '/dtg-costs', name: 'Get DTG Costs' },
  { method: 'get', url: '/screenprint-costs?costType=PrimaryLocation', name: 'Get Screenprint Costs' },
  { method: 'get', url: '/pricing-rules?method=DTG', name: 'Get DTG Pricing Rules' },
  { method: 'get', url: '/base-item-costs?styleNumber=PC61', name: 'Get Base Item Costs' },
  { method: 'get', url: '/size-pricing?styleNumber=PC61', name: 'Get Size Pricing' },
  { method: 'get', url: '/max-prices-by-style?styleNumber=PC61', name: 'Get Max Prices by Style' },
  { method: 'get', url: '/pricing-bundle?method=DTG&styleNumber=PC61', name: 'Get Pricing Bundle' },

  // Product API
  { method: 'get', url: '/stylesearch?term=PC61', name: 'Style Search' },
  { method: 'get', url: '/product-details?styleNumber=PC61', name: 'Get Product Details' },
  { method: 'get', url: '/color-swatches?styleNumber=PC61', name: 'Get Color Swatches' },
  { method: 'get', url: '/products-by-brand?brand=Port%20%26%20Company', name: 'Get Products by Brand' },
  { method: 'get', url: '/products-by-category?category=T-Shirts', name: 'Get Products by Category' },
  { method: 'get', url: '/products-by-subcategory?subcategory=T-Shirts', name: 'Get Products by Subcategory' },
  { method: 'get', url: '/all-brands', name: 'Get All Brands' },
  { method: 'get', url: '/all-categories', name: 'Get All Categories' },
  { method: 'get', url: '/all-subcategories', name: 'Get All Subcategories' },
  { method: 'get', url: '/search?q=shirt', name: 'Product Search' },
  { method: 'get', url: '/featured-products', name: 'Get Featured Products' },
  { method: 'get', url: '/product-colors?styleNumber=PC61', name: 'Get Product Colors' },

  // Order API
  { method: 'get', url: '/orders', name: 'Get Orders' },
  { method: 'post', url: '/orders', data: sampleData.order, name: 'Create Order' },
  { method: 'get', url: '/customers', name: 'Get Customers' },
  { method: 'post', url: '/customers', data: sampleData.customer, name: 'Create Customer' },

  // Inventory API
  { method: 'get', url: '/inventory?styleNumber=PC61', name: 'Get Inventory' },
  { method: 'get', url: '/sizes-by-style-color?styleNumber=PC61&color=Ash', name: 'Get Sizes by Style and Color' },

  // Pricing Matrix API
  { method: 'get', url: '/pricing-matrix', name: 'Get Pricing Matrix' },
  { method: 'post', url: '/pricing-matrix', data: sampleData.pricingMatrix, name: 'Create Pricing Matrix' },
  { method: 'get', url: '/pricing-matrix/lookup?styleNumber=PC61&color=Ash&embellishmentType=DTG', name: 'Pricing Matrix Lookup' },

  // Quote API
  { method: 'get', url: '/quote_analytics', name: 'Get Quote Analytics' },
  { method: 'post', url: '/quote_analytics', data: sampleData.quoteAnalytics, name: 'Create Quote Analytics' },
  { method: 'get', url: '/quote_items', name: 'Get Quote Items' },
  { method: 'post', url: '/quote_items', data: sampleData.quoteItem, name: 'Create Quote Item' },
  { method: 'get', url: '/quote_sessions', name: 'Get Quote Sessions' },
  { method: 'post', url: '/quote_sessions', data: sampleData.quoteSession, name: 'Create Quote Session' },

  // Misc API
  { method: 'get', url: '/cart-integration.js', name: 'Get Cart Integration Script' },
  { method: 'get', url: '/subcategories-by-category?category=T-Shirts', name: 'Get Subcategories by Category' },
  { method: 'get', url: '/products-by-category-subcategory?category=T-Shirts&subcategory=T-Shirts', name: 'Get Products by Category and Subcategory' },
  { method: 'get', url: '/related-products?styleNumber=PC61', name: 'Get Related Products' },
  { method: 'get', url: '/filter-products?category=T-Shirts', name: 'Filter Products' },
  { method: 'get', url: '/quick-view?styleNumber=PC61', name: 'Quick View' },
  { method: 'get', url: '/compare-products?styles=PC61,PC54', name: 'Compare Products' },
  { method: 'get', url: '/recommendations?styleNumber=PC61', name: 'Get Recommendations' },
  { method: 'get', url: '/test-sanmar-bulk', name: 'Test SanMar Bulk' },

  // Transfers API
  { method: 'get', url: '/transfers/lookup?size=Adult&quantity=10&price_type=Regular', name: 'Transfer Price Lookup' },
  { method: 'get', url: '/transfers/matrix?size=Adult', name: 'Get Transfer Matrix' },
  { method: 'get', url: '/transfers/sizes', name: 'Get Transfer Sizes' },
  { method: 'get', url: '/transfers/price-types', name: 'Get Transfer Price Types' },
  { method: 'get', url: '/transfers/quantity-ranges', name: 'Get Transfer Quantity Ranges' },
  { method: 'get', url: '/transfers', name: 'Get Transfers' }
];

async function verifyEndpoint(endpoint) {
  try {
    const config = {
      method: endpoint.method,
      url: BASE_URL + endpoint.url,
      timeout: 10000
    };

    if (endpoint.data) {
      config.headers = { 'Content-Type': 'application/json' };
      config.data = endpoint.data;
    }

    const response = await axios(config);
    console.log(`✓ ${endpoint.name}`.green);
    return { success: true, endpoint: endpoint.name };
  } catch (error) {
    const status = error.response ? error.response.status : 'No response';
    const message = error.response ? error.response.data.error || error.message : error.message;
    console.log(`✗ ${endpoint.name}`.red);
    console.log(`  Status: ${status}`.red);
    console.log(`  Error: ${message}`.red);
    return { success: false, endpoint: endpoint.name, error: { status, message } };
  }
}

async function verifyAllEndpoints() {
  console.log('\nVerifying API endpoints...\n'.cyan);
  
  const results = {
    successful: [],
    failed: []
  };

  for (const endpoint of endpoints) {
    const result = await verifyEndpoint(endpoint);
    if (result.success) {
      results.successful.push(result.endpoint);
    } else {
      results.failed.push({
        endpoint: result.endpoint,
        status: result.error.status,
        message: result.error.message
      });
    }
  }

  console.log('\nVerification Summary:'.cyan);
  console.log(`Total endpoints tested: ${endpoints.length}`.cyan);
  console.log(`Successful: ${results.successful.length}`.green);
  console.log(`Failed: ${results.failed.length}`.red);

  if (results.failed.length > 0) {
    console.log('\nFailed Endpoints:'.red);
    results.failed.forEach(failure => {
      console.log(`\n${failure.endpoint}:`.red);
      console.log(`  Status: ${failure.status}`.red);
      console.log(`  Error: ${failure.message}`.red);
    });
  }

  return results;
}

// Run the verification
verifyAllEndpoints().catch(console.error);