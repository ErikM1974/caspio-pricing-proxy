// Test script to verify all 52 endpoints including the missing ones
const axios = require('axios');

const PRODUCTION_URL = 'https://caspio-pricing-proxy-ab30a049961a.herokuapp.com';

// All important endpoints to test
const endpoints = [
    // Art endpoints (just fixed)
    { method: 'GET', path: '/api/artrequests', description: 'Art requests list' },
    { method: 'GET', path: '/api/art-invoices', description: 'Art invoices list' },
    
    // Production schedules (might be missing)
    { method: 'GET', path: '/api/production-schedules', description: 'Production schedules' },
    
    // Order endpoints
    { method: 'GET', path: '/api/orders', description: 'Orders list' },
    { method: 'GET', path: '/api/order-dashboard', description: 'Order dashboard' },
    { method: 'GET', path: '/api/order-odbc', description: 'Order ODBC' },
    
    // Product search endpoints
    { method: 'GET', path: '/api/stylesearch?term=PC', description: 'Style search' },
    { method: 'GET', path: '/api/search?q=shirt', description: 'General search' },
    { method: 'GET', path: '/api/products/PC54', description: 'Product details by style' },
    { method: 'GET', path: '/api/product-details?styleNumber=PC54', description: 'Product details query' },
    
    // Product categories and filtering
    { method: 'GET', path: '/api/all-brands', description: 'All brands' },
    { method: 'GET', path: '/api/all-categories', description: 'All categories' },
    { method: 'GET', path: '/api/all-subcategories', description: 'All subcategories' },
    { method: 'GET', path: '/api/products-by-brand?brand=Port%20Authority', description: 'Products by brand' },
    { method: 'GET', path: '/api/products-by-category?category=T-Shirts', description: 'Products by category' },
    { method: 'GET', path: '/api/featured-products', description: 'Featured products' },
    
    // Product colors and variants
    { method: 'GET', path: '/api/product-colors?styleNumber=PC54', description: 'Product colors' },
    { method: 'GET', path: '/api/color-swatches?styleNumber=PC54', description: 'Color swatches' },
    { method: 'GET', path: '/api/sizes-by-style-color?styleNumber=PC54&colorName=Navy', description: 'Sizes by style/color' },
    { method: 'GET', path: '/api/product-variant-sizes?style=PC54', description: 'Product variant sizes' },
    
    // Pricing endpoints
    { method: 'GET', path: '/api/pricing-tiers?decorationMethod=screenprint', description: 'Pricing tiers' },
    { method: 'GET', path: '/api/pricing-rules', description: 'Pricing rules' },
    { method: 'GET', path: '/api/pricing-bundle', description: 'Pricing bundle' },
    { method: 'GET', path: '/api/prices-by-style-color?style=PC54&color=Navy', description: 'Prices by style/color' },
    { method: 'GET', path: '/api/max-prices-by-style?style=PC54', description: 'Max prices by style' },
    
    // Inventory
    { method: 'GET', path: '/api/inventory?styleNumber=PC54', description: 'Inventory' },
    
    // Cart and checkout
    { method: 'GET', path: '/api/cart-sessions', description: 'Cart sessions' },
    { method: 'GET', path: '/api/cart-items', description: 'Cart items' },
    { method: 'GET', path: '/api/cart-integration.js', description: 'Cart integration script' },
    
    // Quotes
    { method: 'GET', path: '/api/quote_items', description: 'Quote items' },
    { method: 'GET', path: '/api/quote_sessions', description: 'Quote sessions' },
    { method: 'GET', path: '/api/quote_analytics', description: 'Quote analytics' },
    
    // Misc endpoints
    { method: 'GET', path: '/api/staff-announcements', description: 'Staff announcements' },
    { method: 'GET', path: '/api/locations', description: 'Locations' },
    { method: 'GET', path: '/api/customers', description: 'Customers' },
    { method: 'GET', path: '/api/transfers', description: 'Transfers' },
    
    // Embellishment calculations
    { method: 'GET', path: '/api/embroidery-costs?locations=1&stitches=5000', description: 'Embroidery costs' },
    { method: 'GET', path: '/api/screenprint-costs?colors=3&locations=1', description: 'Screen print costs' },
    { method: 'GET', path: '/api/dtg-costs?printSize=standard', description: 'DTG costs' },
    
    // Other product endpoints
    { method: 'GET', path: '/api/related-products?styleNumber=PC54', description: 'Related products' },
    { method: 'GET', path: '/api/quick-view?styleNumber=PC54', description: 'Quick view' },
    { method: 'GET', path: '/api/compare-products?styles=PC54,PC61', description: 'Compare products' },
    { method: 'GET', path: '/api/recommendations?category=T-Shirts', description: 'Recommendations' },
    
    // Health check
    { method: 'GET', path: '/api/health', description: 'Health check' }
];

async function testEndpoint(endpoint) {
    const url = `${PRODUCTION_URL}${endpoint.path}`;
    
    try {
        const config = {
            method: endpoint.method,
            url: url,
            timeout: 10000,
            validateStatus: (status) => true // Don't throw on any status
        };

        const response = await axios(config);
        
        return {
            endpoint: endpoint.path,
            method: endpoint.method,
            description: endpoint.description,
            status: response.status,
            statusText: response.statusText,
            working: response.status >= 200 && response.status < 400
        };
    } catch (error) {
        return {
            endpoint: endpoint.path,
            method: endpoint.method,
            description: endpoint.description,
            status: 'ERROR',
            error: error.message,
            working: false
        };
    }
}

async function runTests() {
    console.log('Testing All Important Endpoints');
    console.log('===============================\n');
    console.log(`Production URL: ${PRODUCTION_URL}\n`);

    const results = [];
    let workingCount = 0;
    let notFoundCount = 0;
    let errorCount = 0;
    
    for (const endpoint of endpoints) {
        process.stdout.write(`Testing ${endpoint.method} ${endpoint.path.substring(0, 40)}... `);
        const result = await testEndpoint(endpoint);
        results.push(result);
        
        if (result.working) {
            console.log(`✅ ${result.status}`);
            workingCount++;
        } else if (result.status === 404) {
            console.log(`❌ 404 Not Found`);
            notFoundCount++;
        } else {
            console.log(`❌ ${result.status} ${result.statusText || result.error || ''}`);
            errorCount++;
        }
    }

    // Summary
    console.log('\n\nSummary');
    console.log('=======');
    console.log(`Total endpoints tested: ${results.length}`);
    console.log(`Working: ${workingCount} (${Math.round(workingCount / results.length * 100)}%)`);
    console.log(`Not Found (404): ${notFoundCount}`);
    console.log(`Other Errors: ${errorCount}`);
    
    // Group by status
    console.log('\nEndpoints by Status:');
    console.log('-------------------');
    
    console.log('\n✅ Working Endpoints:');
    results.filter(r => r.working).forEach(endpoint => {
        console.log(`   ${endpoint.method} ${endpoint.endpoint} - ${endpoint.description}`);
    });
    
    console.log('\n❌ Missing Endpoints (404):');
    results.filter(r => r.status === 404).forEach(endpoint => {
        console.log(`   ${endpoint.method} ${endpoint.endpoint} - ${endpoint.description}`);
    });
    
    console.log('\n⚠️ Error Endpoints (400/500):');
    results.filter(r => !r.working && r.status !== 404).forEach(endpoint => {
        console.log(`   ${endpoint.method} ${endpoint.endpoint} - ${endpoint.description} (${endpoint.status})`);
    });
    
    // Save results
    const timestamp = new Date().toISOString().replace(/:/g, '-').split('.')[0];
    const fs = require('fs');
    fs.writeFileSync(
        `all-endpoints-test-${timestamp}.json`,
        JSON.stringify({ timestamp: new Date().toISOString(), results }, null, 2)
    );
    
    console.log(`\nResults saved to: all-endpoints-test-${timestamp}.json`);
}

// Run the tests
runTests().catch(console.error);