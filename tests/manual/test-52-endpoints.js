// Test script to verify ALL 52 endpoints from the Postman collection
const axios = require('axios');

const PRODUCTION_URL = 'https://caspio-pricing-proxy-ab30a049961a.herokuapp.com';

// ALL 52 endpoints from the Postman collection
const endpoints = [
    // Art & Invoicing (3 endpoints)
    { method: 'GET', path: '/api/artrequests', description: 'Art requests' },
    { method: 'GET', path: '/api/art-invoices', description: 'Art invoices' },
    { method: 'POST', path: '/api/art-invoices', description: 'Create art invoice', testData: { test: true } },
    
    // Pricing & Costs (9 endpoints)
    { method: 'GET', path: '/api/pricing-tiers', description: 'Pricing tiers' },
    { method: 'GET', path: '/api/base-item-costs', description: 'Base item costs' },
    { method: 'GET', path: '/api/size-pricing', description: 'Size pricing' },
    { method: 'GET', path: '/api/max-prices-by-style', description: 'Max prices by style' },
    { method: 'GET', path: '/api/pricing-bundle', description: 'Pricing bundle' },
    { method: 'GET', path: '/api/embroidery-costs', description: 'Embroidery costs' },
    { method: 'GET', path: '/api/dtg-costs', description: 'DTG costs' },
    { method: 'GET', path: '/api/screenprint-costs', description: 'Screen print costs' },
    { method: 'GET', path: '/api/pricing-rules', description: 'Pricing rules' },
    
    // Product Search (11 endpoints)
    { method: 'GET', path: '/api/stylesearch', description: 'Style search' },
    { method: 'GET', path: '/api/product-colors', description: 'Product colors' },
    { method: 'GET', path: '/api/product-details', description: 'Product details' },
    { method: 'GET', path: '/api/inventory', description: 'Inventory' },
    { method: 'GET', path: '/api/sizes-by-style-color', description: 'Sizes by style/color' },
    { method: 'GET', path: '/api/color-swatches', description: 'Color swatches' },
    { method: 'GET', path: '/api/products-by-brand', description: 'Products by brand' },
    { method: 'GET', path: '/api/products-by-category', description: 'Products by category' },
    { method: 'GET', path: '/api/all-brands', description: 'All brands' },
    { method: 'GET', path: '/api/all-categories', description: 'All categories' },
    { method: 'GET', path: '/api/all-subcategories', description: 'All subcategories' },
    
    // Pricing Matrix (3 endpoints)
    { method: 'GET', path: '/api/pricing-matrix', description: 'Pricing matrix' },
    { method: 'POST', path: '/api/pricing-matrix', description: 'Create pricing matrix', testData: { test: true } },
    { method: 'GET', path: '/api/pricing-matrix/lookup', description: 'Pricing matrix lookup' },
    
    // Cart Management (5 endpoints)
    { method: 'GET', path: '/api/cart-sessions', description: 'Cart sessions' },
    { method: 'POST', path: '/api/cart-sessions', description: 'Create cart session', testData: { test: true } },
    { method: 'GET', path: '/api/cart-items', description: 'Cart items' },
    { method: 'POST', path: '/api/cart-items', description: 'Create cart item', testData: { test: true } },
    { method: 'GET', path: '/api/cart-item-sizes', description: 'Cart item sizes' },
    
    // Quote System (3 endpoints)
    { method: 'GET', path: '/api/quote_sessions', description: 'Quote sessions' },
    { method: 'GET', path: '/api/quote_items', description: 'Quote items' },
    { method: 'GET', path: '/api/quote_analytics', description: 'Quote analytics' },
    
    // Orders & Customers (3 endpoints)
    { method: 'GET', path: '/api/orders', description: 'Orders' },
    { method: 'GET', path: '/api/order-odbc', description: 'Order ODBC' },
    { method: 'GET', path: '/api/customers', description: 'Customers' },
    
    // Dashboard & Reports (3 endpoints)
    { method: 'GET', path: '/api/order-dashboard', description: 'Order dashboard' },
    { method: 'GET', path: '/api/staff-announcements', description: 'Staff announcements' },
    { method: 'GET', path: '/api/production-schedules', description: 'Production schedules' },
    
    // Utilities (4 endpoints)
    { method: 'GET', path: '/api/health', description: 'Health check' },
    { method: 'GET', path: '/api/locations', description: 'Locations' },
    { method: 'GET', path: '/api/transfers', description: 'Transfers' },
    { method: 'GET', path: '/api/test-sanmar-bulk', description: 'Test Sanmar bulk' }
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

        // Add test data for POST requests
        if (endpoint.method === 'POST' && endpoint.testData) {
            config.data = endpoint.testData;
        }

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
    console.log('Testing ALL 52 Endpoints from Postman Collection');
    console.log('==============================================\n');
    console.log(`Production URL: ${PRODUCTION_URL}\n`);

    const results = [];
    let workingCount = 0;
    let notFoundCount = 0;
    let errorCount = 0;
    
    // Test each endpoint
    for (let i = 0; i < endpoints.length; i++) {
        const endpoint = endpoints[i];
        const progress = `[${i + 1}/${endpoints.length}]`;
        process.stdout.write(`${progress} Testing ${endpoint.method} ${endpoint.path.substring(0, 30).padEnd(30)}... `);
        
        const result = await testEndpoint(endpoint);
        results.push(result);
        
        if (result.working) {
            console.log(`✅ ${result.status}`);
            workingCount++;
        } else if (result.status === 404) {
            console.log(`❌ 404 Not Found`);
            notFoundCount++;
        } else {
            console.log(`⚠️  ${result.status} ${result.statusText || result.error || ''}`);
            errorCount++;
        }
    }

    // Summary
    console.log('\n\nSUMMARY');
    console.log('=======');
    console.log(`Total endpoints tested: ${results.length}`);
    console.log(`✅ Working: ${workingCount} (${Math.round(workingCount / results.length * 100)}%)`);
    console.log(`❌ Not Found (404): ${notFoundCount}`);
    console.log(`⚠️  Other Errors: ${errorCount}`);
    
    // Group by category
    console.log('\n\nDETAILED RESULTS BY CATEGORY:');
    console.log('=============================');
    
    // Art & Invoicing
    console.log('\n🎨 Art & Invoicing:');
    results.slice(0, 3).forEach(r => {
        const icon = r.working ? '✅' : r.status === 404 ? '❌' : '⚠️ ';
        console.log(`   ${icon} ${r.method} ${r.endpoint} - ${r.description} (${r.status})`);
    });
    
    // Pricing & Costs
    console.log('\n💰 Pricing & Costs:');
    results.slice(3, 12).forEach(r => {
        const icon = r.working ? '✅' : r.status === 404 ? '❌' : '⚠️ ';
        console.log(`   ${icon} ${r.method} ${r.endpoint} - ${r.description} (${r.status})`);
    });
    
    // Product Search
    console.log('\n🛍️ Product Search:');
    results.slice(12, 23).forEach(r => {
        const icon = r.working ? '✅' : r.status === 404 ? '❌' : '⚠️ ';
        console.log(`   ${icon} ${r.method} ${r.endpoint} - ${r.description} (${r.status})`);
    });
    
    // Pricing Matrix
    console.log('\n📊 Pricing Matrix:');
    results.slice(23, 26).forEach(r => {
        const icon = r.working ? '✅' : r.status === 404 ? '❌' : '⚠️ ';
        console.log(`   ${icon} ${r.method} ${r.endpoint} - ${r.description} (${r.status})`);
    });
    
    // Cart Management
    console.log('\n🛒 Cart Management:');
    results.slice(26, 31).forEach(r => {
        const icon = r.working ? '✅' : r.status === 404 ? '❌' : '⚠️ ';
        console.log(`   ${icon} ${r.method} ${r.endpoint} - ${r.description} (${r.status})`);
    });
    
    // Quote System
    console.log('\n📝 Quote System:');
    results.slice(31, 34).forEach(r => {
        const icon = r.working ? '✅' : r.status === 404 ? '❌' : '⚠️ ';
        console.log(`   ${icon} ${r.method} ${r.endpoint} - ${r.description} (${r.status})`);
    });
    
    // Orders & Customers
    console.log('\n📦 Orders & Customers:');
    results.slice(34, 37).forEach(r => {
        const icon = r.working ? '✅' : r.status === 404 ? '❌' : '⚠️ ';
        console.log(`   ${icon} ${r.method} ${r.endpoint} - ${r.description} (${r.status})`);
    });
    
    // Dashboard & Reports
    console.log('\n📈 Dashboard & Reports:');
    results.slice(37, 40).forEach(r => {
        const icon = r.working ? '✅' : r.status === 404 ? '❌' : '⚠️ ';
        console.log(`   ${icon} ${r.method} ${r.endpoint} - ${r.description} (${r.status})`);
    });
    
    // Utilities
    console.log('\n⚙️ Utilities:');
    results.slice(40, 44).forEach(r => {
        const icon = r.working ? '✅' : r.status === 404 ? '❌' : '⚠️ ';
        console.log(`   ${icon} ${r.method} ${r.endpoint} - ${r.description} (${r.status})`);
    });
    
    // Save detailed results
    const timestamp = new Date().toISOString().replace(/:/g, '-').split('.')[0];
    const fs = require('fs');
    fs.writeFileSync(
        `52-endpoints-test-${timestamp}.json`,
        JSON.stringify({ 
            timestamp: new Date().toISOString(), 
            summary: {
                total: results.length,
                working: workingCount,
                notFound: notFoundCount,
                errors: errorCount
            },
            results 
        }, null, 2)
    );
    
    console.log(`\n\nDetailed results saved to: 52-endpoints-test-${timestamp}.json`);
}

// Run the tests
runTests().catch(console.error);