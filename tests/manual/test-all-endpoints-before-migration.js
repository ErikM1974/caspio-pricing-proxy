#!/usr/bin/env node

/**
 * Comprehensive Endpoint Test Suite for Migration
 * 
 * This script tests ALL endpoints in the Caspio Pricing Proxy
 * and saves results for comparison during migration.
 * 
 * Usage:
 *   node test-all-endpoints-before-migration.js
 *   node test-all-endpoints-before-migration.js --save-baseline
 *   node test-all-endpoints-before-migration.js --compare-with baseline.json
 */

const axios = require('axios');
const fs = require('fs').promises;
const path = require('path');
const colors = require('colors');

const PORT = process.env.PORT || 3002;
const BASE_URL = `http://localhost:${PORT}`;

// Configure axios
axios.defaults.timeout = 30000; // 30 second timeout
axios.defaults.validateStatus = () => true; // Don't throw on any status

// Comprehensive endpoint list organized by category
const ENDPOINTS = {
    'System & Health': [
        { method: 'GET', path: '/api/health', description: 'Health check' },
        { method: 'GET', path: '/status', description: 'Server status' },
        { method: 'GET', path: '/test', description: 'Test endpoint' }
    ],
    
    'Pricing APIs': [
        { method: 'GET', path: '/api/pricing-tiers?method=DTG', description: 'DTG pricing tiers' },
        { method: 'GET', path: '/api/pricing-tiers?method=ScreenPrint', description: 'Screen print pricing tiers' },
        { method: 'GET', path: '/api/pricing-tiers?method=Embroidery', description: 'Embroidery pricing tiers' },
        { method: 'GET', path: '/api/embroidery-costs?itemType=Shirt&stitchCount=5000', description: 'Embroidery cost calculation' },
        { method: 'GET', path: '/api/dtg-costs', description: 'DTG costs' },
        { method: 'GET', path: '/api/screenprint-costs?costType=PrimaryLocation', description: 'Screen print costs' },
        { method: 'GET', path: '/api/pricing-rules?method=DTG', description: 'DTG pricing rules' },
        { method: 'GET', path: '/api/pricing-bundle', description: 'Pricing bundle' },
        { method: 'GET', path: '/api/base-item-costs?styleNumber=PC54', description: 'Base item costs' },
        { method: 'GET', path: '/api/size-pricing?styleNumber=PC54', description: 'Size-based pricing' },
        { method: 'GET', path: '/api/max-prices-by-style?styleNumber=PC54', description: 'Maximum prices by style' },
        { method: 'GET', path: '/api/size-upcharges', description: 'Size upcharge rates' },
        { method: 'GET', path: '/api/size-sort-order', description: 'Size sort order' }
    ],
    
    'Product APIs': [
        { method: 'GET', path: '/api/stylesearch?term=PC54', description: 'Style search autocomplete' },
        { method: 'GET', path: '/api/product-details?styleNumber=PC54', description: 'Product details' },
        { method: 'GET', path: '/api/color-swatches?styleNumber=PC54', description: 'Color swatches' },
        { method: 'GET', path: '/api/all-brands', description: 'All available brands' },
        { method: 'GET', path: '/api/all-categories', description: 'All product categories' },
        { method: 'GET', path: '/api/all-subcategories', description: 'All product subcategories' },
        { method: 'GET', path: '/api/products-by-brand?brand=Port%20%26%20Company', description: 'Products by brand' },
        { method: 'GET', path: '/api/products-by-category?category=T-Shirts', description: 'Products by category' },
        { method: 'GET', path: '/api/products-by-subcategory?subcategory=T-Shirts', description: 'Products by subcategory' },
        { method: 'GET', path: '/api/products-by-category-subcategory?category=T-Shirts&subcategory=T-Shirts', description: 'Products by category and subcategory' }
    ],
    
    'Inventory APIs': [
        { method: 'GET', path: '/api/inventory?styleNumber=PC54', description: 'Inventory levels' },
        { method: 'GET', path: '/api/inventory?styleNumber=PC54&color=Black', description: 'Inventory by color' }
    ],
    
    'Order Management APIs': [
        { method: 'GET', path: '/api/orders', description: 'List all orders' },
        { method: 'GET', path: '/api/customers', description: 'List all customers' },
        { method: 'GET', path: '/api/order-odbc?q.limit=10', description: 'Order ODBC records' },
        { method: 'GET', path: '/api/order-dashboard', description: 'Order dashboard summary' },
        { method: 'GET', path: '/api/order-dashboard?days=30', description: 'Order dashboard 30 days' },
        { method: 'GET', path: '/api/order-dashboard?compareYoY=true', description: 'Order dashboard with YoY' }
    ],
    
    'Cart Management APIs': [
        { method: 'GET', path: '/api/cart-sessions', description: 'List cart sessions' },
        { method: 'GET', path: '/api/cart-items', description: 'List cart items' },
        { method: 'GET', path: '/api/cart-item-sizes', description: 'List cart item sizes' },
        { method: 'GET', path: '/api/cart-integration.js', description: 'Cart integration script' }
    ],
    
    'Quote Management APIs': [
        { method: 'GET', path: '/api/quote_analytics', description: 'Quote analytics' },
        { method: 'GET', path: '/api/quote_items', description: 'Quote items' },
        { method: 'GET', path: '/api/quote_sessions', description: 'Quote sessions' }
    ],
    
    'Pricing Matrix APIs': [
        { method: 'GET', path: '/api/pricing-matrix', description: 'Pricing matrix list' },
        { method: 'GET', path: '/api/pricing-matrix/lookup?styleNumber=PC54&color=Black&embellishmentType=DTG', description: 'Pricing matrix lookup' }
    ],
    
    'Production & Art APIs': [
        { method: 'GET', path: '/api/production-schedules?q.limit=5', description: 'Production schedules' },
        { method: 'GET', path: '/api/art-invoices', description: 'Art invoices' },
        { method: 'GET', path: '/api/artrequests?limit=5', description: 'Art requests' }
    ],
    
    'Miscellaneous APIs': [
        { method: 'GET', path: '/api/locations', description: 'Print locations' },
        { method: 'GET', path: '/api/staff-announcements', description: 'Staff announcements' },
        { method: 'GET', path: '/api/test-sanmar-bulk', description: 'Test SanMar bulk data' }
    ],
    
    'Transfer APIs': [
        { method: 'GET', path: '/api/transfers', description: 'Transfer records' }
    ]
};

// Critical endpoints that MUST work
const CRITICAL_ENDPOINTS = [
    '/api/health',
    '/api/order-dashboard',
    '/api/staff-announcements',
    '/api/pricing-tiers?method=DTG',
    '/api/product-details?styleNumber=PC54'
];

// Test result storage
const results = {
    timestamp: new Date().toISOString(),
    serverUrl: BASE_URL,
    summary: {
        total: 0,
        passed: 0,
        failed: 0,
        byCategory: {}
    },
    criticalEndpoints: {
        passed: 0,
        failed: 0,
        details: []
    },
    endpoints: {}
};

// Helper to test a single endpoint
async function testEndpoint(endpoint, category) {
    const url = `${BASE_URL}${endpoint.path}`;
    const startTime = Date.now();
    
    try {
        const response = await axios({
            method: endpoint.method,
            url: url,
            headers: {
                'Content-Type': 'application/json'
            }
        });
        
        const duration = Date.now() - startTime;
        const passed = response.status >= 200 && response.status < 300;
        const isCritical = CRITICAL_ENDPOINTS.includes(endpoint.path);
        
        const result = {
            endpoint: endpoint.path,
            method: endpoint.method,
            description: endpoint.description,
            category: category,
            status: response.status,
            passed: passed,
            duration: duration,
            critical: isCritical,
            dataSize: JSON.stringify(response.data).length,
            hasData: response.data && (Array.isArray(response.data) ? response.data.length > 0 : Object.keys(response.data).length > 0),
            timestamp: new Date().toISOString()
        };
        
        // Save sample response for comparison
        if (passed && result.dataSize < 10000) { // Don't save huge responses
            result.sampleResponse = response.data;
        }
        
        return result;
        
    } catch (error) {
        return {
            endpoint: endpoint.path,
            method: endpoint.method,
            description: endpoint.description,
            category: category,
            status: 0,
            passed: false,
            duration: Date.now() - startTime,
            critical: CRITICAL_ENDPOINTS.includes(endpoint.path),
            error: error.message,
            timestamp: new Date().toISOString()
        };
    }
}

// Main test runner
async function runAllTests() {
    console.log(colors.cyan.bold('\n🧪 COMPREHENSIVE ENDPOINT TESTING FOR MIGRATION'));
    console.log('='.repeat(80));
    console.log(`📍 Server: ${BASE_URL}`);
    console.log(`📅 Date: ${new Date().toLocaleString()}`);
    console.log(`📊 Total Endpoints: ${Object.values(ENDPOINTS).flat().length}`);
    console.log(`⚠️  Critical Endpoints: ${CRITICAL_ENDPOINTS.length}`);
    console.log('='.repeat(80));
    
    // Check if server is running
    console.log('\n' + colors.yellow('Checking server health...'));
    try {
        await axios.get(`${BASE_URL}/api/health`, { timeout: 5000 });
        console.log(colors.green('✅ Server is running'));
    } catch (error) {
        console.error(colors.red('❌ Server is not running!'));
        console.log(colors.yellow('Please start the server with: node start-server.js'));
        process.exit(1);
    }
    
    // Test each category
    for (const [category, endpoints] of Object.entries(ENDPOINTS)) {
        console.log('\n' + colors.yellow.bold(`Testing ${category}...`));
        console.log('-'.repeat(60));
        
        results.summary.byCategory[category] = {
            total: endpoints.length,
            passed: 0,
            failed: 0
        };
        
        for (const endpoint of endpoints) {
            process.stdout.write(`  ${endpoint.description.padEnd(50, '.')}`);
            
            const result = await testEndpoint(endpoint, category);
            results.endpoints[`${endpoint.method} ${endpoint.path}`] = result;
            results.summary.total++;
            
            if (result.passed) {
                results.summary.passed++;
                results.summary.byCategory[category].passed++;
                console.log(colors.green(` ✅ [${result.status}] ${result.duration}ms`));
                
                if (result.critical) {
                    results.criticalEndpoints.passed++;
                }
            } else {
                results.summary.failed++;
                results.summary.byCategory[category].failed++;
                console.log(colors.red(` ❌ [${result.status}] ${result.error || 'Failed'}`));
                
                if (result.critical) {
                    results.criticalEndpoints.failed++;
                    results.criticalEndpoints.details.push({
                        endpoint: result.endpoint,
                        error: result.error || `Status ${result.status}`
                    });
                }
            }
        }
        
        const catStats = results.summary.byCategory[category];
        console.log(colors.gray(`  Category Summary: ${catStats.passed}/${catStats.total} passed`));
    }
    
    // Print summary
    console.log('\n' + '='.repeat(80));
    console.log(colors.cyan.bold('📊 TEST SUMMARY'));
    console.log('='.repeat(80));
    
    const passRate = ((results.summary.passed / results.summary.total) * 100).toFixed(1);
    console.log(`Total Tests: ${results.summary.total}`);
    console.log(colors.green(`✅ Passed: ${results.summary.passed}`));
    console.log(colors.red(`❌ Failed: ${results.summary.failed}`));
    console.log(`Overall Pass Rate: ${passRate}%`);
    
    // Critical endpoints summary
    console.log('\n' + colors.yellow.bold('⚠️  CRITICAL ENDPOINTS'));
    console.log('-'.repeat(40));
    if (results.criticalEndpoints.failed === 0) {
        console.log(colors.green('✅ All critical endpoints passed!'));
    } else {
        console.log(colors.red(`❌ ${results.criticalEndpoints.failed} critical endpoints failed:`));
        results.criticalEndpoints.details.forEach(detail => {
            console.log(colors.red(`   - ${detail.endpoint}: ${detail.error}`));
        });
    }
    
    // Category breakdown
    console.log('\n' + colors.yellow.bold('📂 RESULTS BY CATEGORY'));
    console.log('-'.repeat(40));
    for (const [category, stats] of Object.entries(results.summary.byCategory)) {
        const catPassRate = ((stats.passed / stats.total) * 100).toFixed(0);
        const icon = stats.failed === 0 ? '✅' : stats.passed === 0 ? '❌' : '⚠️';
        console.log(`${icon} ${category}: ${stats.passed}/${stats.total} (${catPassRate}%)`);
    }
    
    // Save results if requested
    if (process.argv.includes('--save-baseline')) {
        const filename = `migration-baseline-${new Date().toISOString().split('T')[0]}.json`;
        const filepath = path.join(__dirname, 'migration-logs', filename);
        
        // Create directory if it doesn't exist
        await fs.mkdir(path.dirname(filepath), { recursive: true });
        
        // Save results
        await fs.writeFile(filepath, JSON.stringify(results, null, 2));
        console.log('\n' + colors.green(`✅ Baseline saved to: ${filename}`));
    }
    
    // Compare with baseline if requested
    if (process.argv.includes('--compare-with')) {
        const baselineFile = process.argv[process.argv.indexOf('--compare-with') + 1];
        await compareWithBaseline(baselineFile);
    }
    
    return results;
}

// Compare current results with baseline
async function compareWithBaseline(baselineFile) {
    try {
        const baselinePath = path.join(__dirname, 'migration-logs', baselineFile);
        const baselineData = JSON.parse(await fs.readFile(baselinePath, 'utf8'));
        
        console.log('\n' + colors.cyan.bold('📊 COMPARISON WITH BASELINE'));
        console.log('='.repeat(80));
        console.log(`Baseline: ${baselineData.timestamp}`);
        console.log(`Current: ${results.timestamp}`);
        console.log('-'.repeat(40));
        
        // Compare pass rates
        const baselinePassRate = ((baselineData.summary.passed / baselineData.summary.total) * 100).toFixed(1);
        const currentPassRate = ((results.summary.passed / results.summary.total) * 100).toFixed(1);
        
        console.log(`Pass Rate: ${baselinePassRate}% → ${currentPassRate}%`);
        
        // Find differences
        const newFailures = [];
        const newPasses = [];
        
        for (const [key, current] of Object.entries(results.endpoints)) {
            const baseline = baselineData.endpoints[key];
            
            if (!baseline) {
                console.log(colors.yellow(`⚠️  New endpoint: ${key}`));
                continue;
            }
            
            if (baseline.passed && !current.passed) {
                newFailures.push(key);
            } else if (!baseline.passed && current.passed) {
                newPasses.push(key);
            }
        }
        
        if (newFailures.length > 0) {
            console.log('\n' + colors.red('❌ NEW FAILURES:'));
            newFailures.forEach(ep => console.log(colors.red(`   - ${ep}`)));
        }
        
        if (newPasses.length > 0) {
            console.log('\n' + colors.green('✅ NEW PASSES:'));
            newPasses.forEach(ep => console.log(colors.green(`   - ${ep}`)));
        }
        
        if (newFailures.length === 0 && newPasses.length === 0) {
            console.log(colors.green('\n✅ No changes in endpoint status'));
        }
        
    } catch (error) {
        console.error(colors.red(`\n❌ Error comparing with baseline: ${error.message}`));
    }
}

// Export for use in other scripts
module.exports = {
    ENDPOINTS,
    CRITICAL_ENDPOINTS,
    testEndpoint,
    runAllTests
};

// Run if executed directly
if (require.main === module) {
    runAllTests()
        .then(() => {
            console.log('\n' + colors.green('✅ Testing complete'));
            process.exit(results.criticalEndpoints.failed > 0 ? 1 : 0);
        })
        .catch(error => {
            console.error(colors.red(`\n❌ Test runner error: ${error.message}`));
            process.exit(1);
        });
}