#!/usr/bin/env node

/**
 * Refactoring Test Framework
 * This script tests all API endpoints to ensure they work correctly
 * before, during, and after the refactoring process.
 */

const axios = require('axios');
const fs = require('fs');
const path = require('path');

// Configuration
const BASE_URL = process.env.TEST_URL || 'http://localhost:3002';
const TIMEOUT = 10000; // 10 seconds per request

// Color codes for terminal output
const colors = {
    reset: '\x1b[0m',
    green: '\x1b[32m',
    red: '\x1b[31m',
    yellow: '\x1b[33m',
    blue: '\x1b[34m',
    gray: '\x1b[90m'
};

// Load endpoint inventory
const ENDPOINT_INVENTORY = [
    // Health Check
    { method: 'GET', path: '/api/health', module: 'health' },
    
    // Pricing API
    { method: 'GET', path: '/api/pricing-tiers', module: 'pricing' },
    { method: 'GET', path: '/api/embroidery-costs', module: 'pricing' },
    { method: 'GET', path: '/api/dtg-costs', module: 'pricing' },
    { method: 'GET', path: '/api/screenprint-costs', module: 'pricing' },
    { method: 'GET', path: '/api/pricing-rules', module: 'pricing' },
    { method: 'GET', path: '/api/pricing-bundle', module: 'pricing' },
    { method: 'GET', path: '/api/base-item-costs', module: 'pricing' },
    { method: 'GET', path: '/api/size-upcharges', module: 'pricing' },
    
    // Product API
    { method: 'GET', path: '/api/products/search?query=test', module: 'products' },
    { method: 'GET', path: '/api/products/categories', module: 'products' },
    { method: 'GET', path: '/api/products/base-categories', module: 'products' },
    { method: 'GET', path: '/api/products/colors?productStyleID=1', module: 'products' },
    
    // Inventory API
    { method: 'GET', path: '/api/inventory', module: 'inventory' },
    
    // Customer API
    { method: 'GET', path: '/api/customers', module: 'customers' },
    
    // Art Requests API
    { method: 'GET', path: '/api/artrequests', module: 'art-requests' },
    
    // Art Invoices API
    { method: 'GET', path: '/api/art-invoices', module: 'art-invoices' },
    
    // Cart API
    { method: 'GET', path: '/api/cart-items', module: 'cart' },
    { method: 'GET', path: '/api/cart-item-sizes', module: 'cart' },
    { method: 'GET', path: '/api/cart-sessions', module: 'cart' },
    
    // Order API
    { method: 'GET', path: '/api/orders', module: 'orders' },
    { method: 'GET', path: '/api/order-dashboard', module: 'orders' },
    { method: 'GET', path: '/api/order-odbc', module: 'orders' },
    
    // Pricing Matrix API
    { method: 'GET', path: '/api/pricing-matrix', module: 'pricing-matrix' },
    { method: 'GET', path: '/api/pricing-matrix/lookup', module: 'pricing-matrix' },
    
    // Quote API
    { method: 'GET', path: '/api/quote_analytics', module: 'quotes' },
    { method: 'GET', path: '/api/quote_items', module: 'quotes' },
    { method: 'GET', path: '/api/quote_sessions', module: 'quotes' },
    
    // Production API
    { method: 'GET', path: '/api/production-schedules', module: 'production' },
    
    // Miscellaneous API
    { method: 'GET', path: '/api/transfers', module: 'misc' },
    { method: 'GET', path: '/api/orders-with-tracking', module: 'misc' }
];

// Test results storage
const testResults = {
    passed: [],
    failed: [],
    startTime: null,
    endTime: null
};

// Utility functions
function log(message, color = 'reset') {
    console.log(`${colors[color]}${message}${colors.reset}`);
}

function logTestResult(endpoint, success, error = null, responseTime = null) {
    const status = success ? `${colors.green}✓ PASS${colors.reset}` : `${colors.red}✗ FAIL${colors.reset}`;
    const time = responseTime ? `${colors.gray}(${responseTime}ms)${colors.reset}` : '';
    
    console.log(`${status} ${endpoint.method} ${endpoint.path} ${time}`);
    
    if (error) {
        console.log(`  ${colors.red}Error: ${error.message}${colors.reset}`);
    }
}

// Test a single endpoint
async function testEndpoint(endpoint) {
    const startTime = Date.now();
    
    try {
        const response = await axios({
            method: endpoint.method,
            url: `${BASE_URL}${endpoint.path}`,
            timeout: TIMEOUT,
            validateStatus: (status) => status < 500 // Don't throw on 4xx errors
        });
        
        const responseTime = Date.now() - startTime;
        
        // Check if response is successful
        if (response.status >= 200 && response.status < 300) {
            testResults.passed.push({
                ...endpoint,
                status: response.status,
                responseTime
            });
            logTestResult(endpoint, true, null, responseTime);
        } else {
            const error = new Error(`HTTP ${response.status}: ${response.statusText}`);
            testResults.failed.push({
                ...endpoint,
                error: error.message,
                status: response.status
            });
            logTestResult(endpoint, false, error);
        }
    } catch (error) {
        testResults.failed.push({
            ...endpoint,
            error: error.message
        });
        logTestResult(endpoint, false, error);
    }
}

// Test endpoints by module
async function testModule(moduleName) {
    const moduleEndpoints = ENDPOINT_INVENTORY.filter(e => e.module === moduleName);
    
    if (moduleEndpoints.length === 0) {
        log(`No endpoints found for module: ${moduleName}`, 'yellow');
        return;
    }
    
    log(`\nTesting ${moduleName} module (${moduleEndpoints.length} endpoints)...`, 'blue');
    
    for (const endpoint of moduleEndpoints) {
        await testEndpoint(endpoint);
    }
}

// Test all endpoints
async function testAllEndpoints() {
    log('Starting endpoint tests...', 'blue');
    log(`Base URL: ${BASE_URL}`, 'gray');
    log(`Total endpoints: ${ENDPOINT_INVENTORY.length}`, 'gray');
    
    testResults.startTime = new Date();
    
    // Group endpoints by module
    const modules = [...new Set(ENDPOINT_INVENTORY.map(e => e.module))];
    
    for (const module of modules) {
        await testModule(module);
    }
    
    testResults.endTime = new Date();
    
    // Display summary
    displaySummary();
    
    // Save results
    saveResults();
}

// Display test summary
function displaySummary() {
    const total = testResults.passed.length + testResults.failed.length;
    const passRate = ((testResults.passed.length / total) * 100).toFixed(1);
    const duration = (testResults.endTime - testResults.startTime) / 1000;
    
    log('\n' + '='.repeat(60), 'gray');
    log('TEST SUMMARY', 'blue');
    log('='.repeat(60), 'gray');
    
    log(`Total Tests: ${total}`, 'reset');
    log(`Passed: ${testResults.passed.length} (${passRate}%)`, 'green');
    log(`Failed: ${testResults.failed.length}`, testResults.failed.length > 0 ? 'red' : 'gray');
    log(`Duration: ${duration.toFixed(2)}s`, 'gray');
    
    if (testResults.failed.length > 0) {
        log('\nFailed Endpoints:', 'red');
        testResults.failed.forEach(endpoint => {
            log(`  - ${endpoint.method} ${endpoint.path}: ${endpoint.error}`, 'red');
        });
    }
}

// Save test results to file
function saveResults() {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `test-results-${timestamp}.json`;
    const filepath = path.join(__dirname, 'test-results', filename);
    
    // Create test-results directory if it doesn't exist
    const dir = path.dirname(filepath);
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
    
    // Save results
    fs.writeFileSync(filepath, JSON.stringify(testResults, null, 2));
    log(`\nTest results saved to: ${filename}`, 'gray');
}

// Command line interface
async function main() {
    const args = process.argv.slice(2);
    
    if (args.includes('--help') || args.includes('-h')) {
        console.log(`
Refactoring Test Framework

Usage: node test-refactoring.js [options]

Options:
  --module <name>    Test only a specific module
  --url <url>        Set custom base URL (default: http://localhost:3002)
  --help, -h         Show this help message

Examples:
  node test-refactoring.js                    # Test all endpoints
  node test-refactoring.js --module cart      # Test only cart endpoints
  node test-refactoring.js --url http://prod.example.com
        `);
        process.exit(0);
    }
    
    // Parse module filter
    const moduleIndex = args.indexOf('--module');
    if (moduleIndex !== -1 && args[moduleIndex + 1]) {
        const module = args[moduleIndex + 1];
        await testModule(module);
    } else {
        await testAllEndpoints();
    }
}

// Check if server is running
async function checkServer() {
    try {
        await axios.get(`${BASE_URL}/api/health`, { timeout: 5000 });
        return true;
    } catch (error) {
        log(`\nError: Cannot connect to server at ${BASE_URL}`, 'red');
        log('Please ensure the server is running on port 3002', 'yellow');
        log('Start the server with: node start-test-server.js', 'yellow');
        return false;
    }
}

// Run tests
(async () => {
    // Check if server is accessible
    const serverRunning = await checkServer();
    if (!serverRunning) {
        process.exit(1);
    }
    
    // Run main test suite
    await main();
    
    // Exit with appropriate code
    process.exit(testResults.failed.length > 0 ? 1 : 0);
})();