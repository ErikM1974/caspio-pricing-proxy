#!/usr/bin/env node

// Complete test suite for all actual endpoints in server.js
const axios = require('axios');
const colors = require('colors');

const PORT = 3002;
const BASE_URL = `http://localhost:${PORT}`;

// All actual endpoints from server.js grouped by category
const endpointTests = {
    'System & Health': [
        { name: 'Health Check', method: 'GET', url: '/api/health' },
        { name: 'Status', method: 'GET', url: '/status' },
        { name: 'Test', method: 'GET', url: '/test' }
    ],
    
    'Pricing APIs': [
        { name: 'Pricing Tiers', method: 'GET', url: '/api/pricing-tiers?method=DTG' },
        { name: 'Embroidery Costs', method: 'GET', url: '/api/embroidery-costs?itemType=Shirt&stitchCount=5000' },
        { name: 'DTG Costs', method: 'GET', url: '/api/dtg-costs' },
        { name: 'Screenprint Costs', method: 'GET', url: '/api/screenprint-costs?costType=PrimaryLocation' },
        { name: 'Pricing Rules', method: 'GET', url: '/api/pricing-rules?method=DTG' },
        { name: 'Pricing Bundle', method: 'GET', url: '/api/pricing-bundle' },
        { name: 'Base Item Costs', method: 'GET', url: '/api/base-item-costs?styleNumber=G500' },
        { name: 'Size Pricing', method: 'GET', url: '/api/size-pricing?styleNumber=G500' },
        { name: 'Max Prices by Style', method: 'GET', url: '/api/max-prices-by-style?styleNumber=G500' }
    ],
    
    'Product Search & Details': [
        { name: 'Style Search', method: 'GET', url: '/api/stylesearch?term=G500' },
        { name: 'Product Search', method: 'GET', url: '/api/search?q=shirt' },
        { name: 'Product Details', method: 'GET', url: '/api/product-details?styleNumber=G500' },
        { name: 'Color Swatches', method: 'GET', url: '/api/color-swatches?styleNumber=G500' },
        { name: 'Product Colors', method: 'GET', url: '/api/product-colors?styleNumber=G500' },
        { name: 'Featured Products', method: 'GET', url: '/api/featured-products' },
        { name: 'Quick View', method: 'GET', url: '/api/quick-view?styleNumber=G500' }
    ],
    
    'Product Categories': [
        { name: 'All Brands', method: 'GET', url: '/api/all-brands' },
        { name: 'All Categories', method: 'GET', url: '/api/all-categories' },
        { name: 'All Subcategories', method: 'GET', url: '/api/all-subcategories' },
        { name: 'Products by Brand', method: 'GET', url: '/api/products-by-brand?brand=Gildan' },
        { name: 'Products by Category', method: 'GET', url: '/api/products-by-category?category=T-Shirts' },
        { name: 'Products by Subcategory', method: 'GET', url: '/api/products-by-subcategory?subcategory=T-Shirts' },
        { name: 'Products by Cat+Subcat', method: 'GET', url: '/api/products-by-category-subcategory?category=T-Shirts&subcategory=T-Shirts' },
        { name: 'Subcategories by Category', method: 'GET', url: '/api/subcategories-by-category?category=T-Shirts' }
    ],
    
    'Inventory & Sizes': [
        { name: 'Inventory', method: 'GET', url: '/api/inventory?styleNumber=G500' },
        { name: 'Sizes by Style/Color', method: 'GET', url: '/api/sizes-by-style-color?styleNumber=G500&color=Black' },
        { name: 'Prices by Style/Color', method: 'GET', url: '/api/prices-by-style-color?styleNumber=G500&color=Black' },
        { name: 'Product Variant Sizes', method: 'GET', url: '/api/product-variant-sizes?styleNumber=G500&color=Black' },
        { name: 'Size Sort Order', method: 'GET', url: '/api/size-sort-order' },
        { name: 'Size Upcharges', method: 'GET', url: '/api/size-upcharges' }
    ],
    
    'Product Utilities': [
        { name: 'Related Products', method: 'GET', url: '/api/related-products?styleNumber=G500' },
        { name: 'Recommendations', method: 'GET', url: '/api/recommendations?styleNumber=G500' },
        { name: 'Compare Products', method: 'GET', url: '/api/compare-products?styles=G500,G200' },
        { name: 'Filter Products', method: 'GET', url: '/api/filter-products?category=T-Shirts&maxPrice=20' }
    ],
    
    'Order Management': [
        { name: 'Orders List', method: 'GET', url: '/api/orders' },
        { name: 'Order Dashboard', method: 'GET', url: '/api/order-dashboard' },
        { name: 'Order ODBC', method: 'GET', url: '/api/order-odbc?q.limit=10' },
        { name: 'Customers List', method: 'GET', url: '/api/customers' }
    ],
    
    'Cart Management': [
        { name: 'Cart Sessions', method: 'GET', url: '/api/cart-sessions' },
        { name: 'Cart Items', method: 'GET', url: '/api/cart-items' },
        { name: 'Cart Item Sizes', method: 'GET', url: '/api/cart-item-sizes' },
        { name: 'Cart Integration Script', method: 'GET', url: '/api/cart-integration.js' }
    ],
    
    'Quotes Management': [
        { name: 'Quote Analytics', method: 'GET', url: '/api/quote_analytics' },
        { name: 'Quote Items', method: 'GET', url: '/api/quote_items' },
        { name: 'Quote Sessions', method: 'GET', url: '/api/quote_sessions' }
    ],
    
    'Pricing Matrix': [
        { name: 'Pricing Matrix List', method: 'GET', url: '/api/pricing-matrix' },
        { name: 'Pricing Matrix Lookup', method: 'GET', url: '/api/pricing-matrix/lookup?styleNumber=G500&color=Black&embellishmentType=DTG' }
    ],
    
    'Art & Production': [
        { name: 'Art Requests', method: 'GET', url: '/api/artrequests?limit=5' },
        { name: 'Art Invoices', method: 'GET', url: '/api/art-invoices' },
        { name: 'Production Schedules', method: 'GET', url: '/api/production-schedules?q.limit=5' }
    ],
    
    'Miscellaneous': [
        { name: 'Locations', method: 'GET', url: '/api/locations' },
        { name: 'Test SanMar Bulk', method: 'GET', url: '/api/test-sanmar-bulk' }
    ]
};

// Test runner
async function testEndpoint(test) {
    try {
        const startTime = Date.now();
        const response = await axios({
            method: test.method,
            url: `${BASE_URL}${test.url}`,
            timeout: 8000,
            validateStatus: () => true
        });
        const duration = Date.now() - startTime;
        
        return {
            success: response.status === 200,
            status: response.status,
            duration,
            dataSize: JSON.stringify(response.data).length
        };
    } catch (error) {
        return {
            success: false,
            status: 0,
            duration: 0,
            error: error.code || error.message
        };
    }
}

async function runCompleteTest() {
    console.log('\n' + '='.repeat(80));
    console.log(colors.cyan.bold('🧪 COMPLETE ENDPOINT TEST - ALL ACTUAL ENDPOINTS'));
    console.log('='.repeat(80));
    console.log(`📍 Server: ${BASE_URL}`);
    console.log(`📅 Date: ${new Date().toLocaleString()}`);
    console.log('='.repeat(80));
    
    // Check server
    try {
        const health = await axios.get(`${BASE_URL}/api/health`, { timeout: 3000 });
        console.log(colors.green('✅ Server is healthy'));
        console.log(`   Caspio Domain: ${health.data.caspio.domain}`);
        console.log(`   Token Cached: ${health.data.caspio.tokenCached ? 'Yes' : 'No'}`);
        console.log('='.repeat(80));
    } catch (error) {
        console.error(colors.red('❌ Server is not running!'));
        console.log(colors.yellow('\nStart the server with: node start-server.js\n'));
        process.exit(1);
    }
    
    const results = {
        total: 0,
        passed: 0,
        failed: 0,
        byCategory: {}
    };
    
    // Test each category
    for (const [category, tests] of Object.entries(endpointTests)) {
        console.log(colors.yellow.bold(`\n📂 ${category}`));
        console.log('-'.repeat(60));
        
        const categoryResults = {
            total: tests.length,
            passed: 0,
            failed: 0
        };
        
        for (const test of tests) {
            process.stdout.write(`  ${test.name.padEnd(30, '.')}`);
            const result = await testEndpoint(test);
            
            results.total++;
            if (result.success) {
                results.passed++;
                categoryResults.passed++;
                console.log(colors.green(` ✅ OK`) + colors.gray(` [${result.duration}ms, ${result.dataSize} bytes]`));
            } else {
                results.failed++;
                categoryResults.failed++;
                const errorMsg = result.error || `Status ${result.status}`;
                console.log(colors.red(` ❌ FAIL`) + colors.gray(` [${errorMsg}]`));
            }
        }
        
        results.byCategory[category] = categoryResults;
        const catRate = ((categoryResults.passed / categoryResults.total) * 100).toFixed(0);
        console.log(colors.gray(`  Category: ${categoryResults.passed}/${categoryResults.total} passed (${catRate}%)`));
    }
    
    // Summary
    console.log('\n' + '='.repeat(80));
    console.log(colors.cyan.bold('📊 FINAL SUMMARY'));
    console.log('='.repeat(80));
    
    const totalRate = ((results.passed / results.total) * 100).toFixed(1);
    console.log(`Total Endpoints Tested: ${results.total}`);
    console.log(colors.green(`✅ Passed: ${results.passed}`));
    console.log(colors.red(`❌ Failed: ${results.failed}`));
    console.log(`Overall Success Rate: ${totalRate}%`);
    
    // Category summary
    console.log('\nCategory Performance:');
    for (const [cat, catResults] of Object.entries(results.byCategory)) {
        const rate = ((catResults.passed / catResults.total) * 100).toFixed(0);
        const status = catResults.failed === 0 ? '✅' : catResults.passed === 0 ? '❌' : '⚠️';
        console.log(`  ${status} ${cat}: ${catResults.passed}/${catResults.total} (${rate}%)`);
    }
    
    console.log('\n' + '='.repeat(80));
    console.log(colors.cyan('Note: Some endpoints may fail due to:'));
    console.log('- Missing data in Caspio tables');
    console.log('- Endpoints from modular routes not loaded');
    console.log('- Required parameters not provided');
    console.log('='.repeat(80) + '\n');
}

// Run the test
runCompleteTest().catch(error => {
    console.error(colors.red('❌ Test runner error:'), error.message);
    process.exit(1);
});