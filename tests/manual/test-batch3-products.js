const axios = require('axios');
const fs = require('fs');
const path = require('path');

// Configuration
const BASE_URL = process.env.API_BASE_URL || 'http://localhost:3002/api';
const TIMEOUT = 30000; // 30 seconds timeout for each request

// Product endpoints to test (21 endpoints)
const productEndpoints = [
    // Product search and details
    { method: 'GET', path: '/stylesearch', params: { term: 'PC' } },
    { method: 'GET', path: '/product-details', params: { styleNumber: 'PC61' } },
    { method: 'GET', path: '/color-swatches', params: { styleNumber: 'PC61' } },
    { method: 'GET', path: '/inventory', params: { styleNumber: 'PC61', color: 'Red' } },
    
    // Product browsing
    { method: 'GET', path: '/products-by-brand', params: { brand: 'Port Authority' } },
    { method: 'GET', path: '/products-by-category', params: { category: 'T-Shirts' } },
    { method: 'GET', path: '/products-by-subcategory', params: { subcategory: 'Short Sleeve' } },
    { method: 'GET', path: '/all-brands' },
    { method: 'GET', path: '/all-subcategories' },
    { method: 'GET', path: '/all-categories' },
    { method: 'GET', path: '/subcategories-by-category', params: { category: 'T-Shirts' } },
    { method: 'GET', path: '/products-by-category-subcategory', params: { category: 'T-Shirts', subcategory: 'Short Sleeve' } },
    
    // Product search and filtering
    { method: 'GET', path: '/search', params: { q: 'hoodie' } },
    { method: 'GET', path: '/featured-products' },
    { method: 'GET', path: '/related-products', params: { styleNumber: 'PC61' } },
    { method: 'GET', path: '/filter-products', params: { category: 'T-Shirts', color: 'Red' } },
    
    // Product views and comparison
    { method: 'GET', path: '/quick-view', params: { styleNumber: 'PC61' } },
    { method: 'GET', path: '/compare-products', params: { styles: 'PC61,3001C' } },
    { method: 'GET', path: '/recommendations', params: { styleNumber: 'PC61' } },
    
    // Inventory and pricing
    { method: 'GET', path: '/sizes-by-style-color', params: { styleNumber: 'PC61', color: 'Red' } },
    { method: 'GET', path: '/prices-by-style-color', params: { styleNumber: 'PC61', color: 'Red' } },
    { method: 'GET', path: '/product-variant-sizes', params: { styleNumber: 'PC61', color: 'Red' } },
    { method: 'GET', path: '/product-colors', params: { styleNumber: 'PC61' } }
];

// Test function
async function testEndpoint(endpoint) {
    const url = `${BASE_URL}${endpoint.path}`;
    const config = {
        method: endpoint.method,
        url: url,
        timeout: TIMEOUT,
        validateStatus: null // Don't throw on any status code
    };

    if (endpoint.params) {
        config.params = endpoint.params;
    }

    const startTime = Date.now();
    
    try {
        const response = await axios(config);
        const duration = Date.now() - startTime;
        
        return {
            endpoint: endpoint.path,
            method: endpoint.method,
            params: endpoint.params || {},
            status: response.status,
            success: response.status >= 200 && response.status < 300,
            duration: duration,
            dataReceived: !!response.data,
            recordCount: Array.isArray(response.data) ? response.data.length : 
                        (response.data && response.data.colors) ? response.data.colors.length :
                        (response.data ? 1 : 0),
            error: null
        };
    } catch (error) {
        const duration = Date.now() - startTime;
        return {
            endpoint: endpoint.path,
            method: endpoint.method,
            params: endpoint.params || {},
            status: error.response ? error.response.status : 0,
            success: false,
            duration: duration,
            dataReceived: false,
            recordCount: 0,
            error: error.message
        };
    }
}

// Main test runner
async function runTests() {
    console.log('Starting Batch 3: Product Endpoints Test');
    console.log('=' .repeat(50));
    console.log(`Testing ${productEndpoints.length} product endpoints`);
    console.log(`Base URL: ${BASE_URL}`);
    console.log(`Timeout: ${TIMEOUT}ms per request`);
    console.log('=' .repeat(50));
    console.log('');

    const results = [];
    let passed = 0;
    let failed = 0;

    // Test each endpoint
    for (const endpoint of productEndpoints) {
        process.stdout.write(`Testing ${endpoint.method} ${endpoint.path}... `);
        const result = await testEndpoint(endpoint);
        results.push(result);
        
        if (result.success) {
            console.log(`✅ PASS (${result.status}) - ${result.duration}ms - ${result.recordCount} records`);
            passed++;
        } else {
            console.log(`❌ FAIL (${result.status}) - ${result.error || 'Unknown error'}`);
            failed++;
        }
    }

    // Summary
    console.log('');
    console.log('=' .repeat(50));
    console.log('TEST SUMMARY');
    console.log('=' .repeat(50));
    console.log(`Total Endpoints: ${productEndpoints.length}`);
    console.log(`Passed: ${passed} ✅`);
    console.log(`Failed: ${failed} ❌`);
    console.log(`Success Rate: ${((passed / productEndpoints.length) * 100).toFixed(1)}%`);
    console.log('');

    // Show failed endpoints
    if (failed > 0) {
        console.log('FAILED ENDPOINTS:');
        results.filter(r => !r.success).forEach(r => {
            console.log(`- ${r.method} ${r.endpoint}: ${r.error || `HTTP ${r.status}`}`);
            if (r.params && Object.keys(r.params).length > 0) {
                console.log(`  Params: ${JSON.stringify(r.params)}`);
            }
        });
        console.log('');
    }

    // Performance stats
    const successfulResults = results.filter(r => r.success);
    if (successfulResults.length > 0) {
        const avgDuration = successfulResults.reduce((sum, r) => sum + r.duration, 0) / successfulResults.length;
        const maxDuration = Math.max(...successfulResults.map(r => r.duration));
        const minDuration = Math.min(...successfulResults.map(r => r.duration));
        
        console.log('PERFORMANCE STATS:');
        console.log(`Average Response Time: ${avgDuration.toFixed(0)}ms`);
        console.log(`Fastest Response: ${minDuration}ms`);
        console.log(`Slowest Response: ${maxDuration}ms`);
        console.log('');
    }

    // Save results
    const timestamp = new Date().toISOString();
    const resultData = {
        timestamp,
        summary: {
            total: productEndpoints.length,
            passed,
            failed,
            successRate: ((passed / productEndpoints.length) * 100).toFixed(1) + '%'
        },
        results
    };

    const resultsDir = path.join(__dirname, 'migration-logs');
    if (!fs.existsSync(resultsDir)) {
        fs.mkdirSync(resultsDir);
    }

    const resultsFile = path.join(resultsDir, 'batch3-products-test-results.json');
    fs.writeFileSync(resultsFile, JSON.stringify(resultData, null, 2));
    console.log(`Results saved to: ${resultsFile}`);

    // Exit with appropriate code
    process.exit(failed > 0 ? 1 : 0);
}

// Run tests
runTests().catch(error => {
    console.error('Fatal error running tests:', error);
    process.exit(1);
});