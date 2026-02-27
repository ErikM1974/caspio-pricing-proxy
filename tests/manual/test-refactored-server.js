#!/usr/bin/env node

// Test script for refactored server
const axios = require('axios');

const PORT = 3002;
const BASE_URL = `http://localhost:${PORT}`;

// Terminal colors
const colors = {
    reset: '\x1b[0m',
    green: '\x1b[32m',
    red: '\x1b[31m',
    yellow: '\x1b[33m',
    cyan: '\x1b[36m'
};

// Test endpoints
const tests = [
    { 
        name: 'Health Check', 
        url: '/api/health',
        validate: (data) => data.status === 'healthy'
    },
    { 
        name: 'Status', 
        url: '/status',
        validate: (data) => data.status === 'Proxy server running'
    },
    { 
        name: 'Order Dashboard (7 days)', 
        url: '/api/order-dashboard',
        validate: (data) => data.summary && data.dateRange
    },
    { 
        name: 'Product Style Search', 
        url: '/api/stylesearch?styles=PC54',
        validate: (data) => Array.isArray(data)
    },
    { 
        name: 'All Brands', 
        url: '/api/all-brands',
        validate: (data) => Array.isArray(data)
    },
    { 
        name: 'Pricing Tiers', 
        url: '/api/pricing-tiers?method=DTG',
        validate: (data) => Array.isArray(data)
    }
];

async function runTests() {
    console.log(`\n${colors.cyan}🧪 TESTING REFACTORED SERVER${colors.reset}`);
    console.log('='.repeat(40) + '\n');
    
    // First check if server is running
    try {
        await axios.get(`${BASE_URL}/api/health`, { timeout: 2000 });
    } catch (error) {
        console.error(`${colors.red}❌ Server is not running on port ${PORT}${colors.reset}`);
        console.log(`\nPlease start the server first:`);
        console.log(`  node start-server.js\n`);
        process.exit(1);
    }
    
    let passed = 0;
    let failed = 0;
    
    for (const test of tests) {
        process.stdout.write(`Testing ${test.name}... `);
        
        try {
            const response = await axios.get(`${BASE_URL}${test.url}`, { timeout: 10000 });
            
            if (test.validate(response.data)) {
                console.log(`${colors.green}✅ PASSED${colors.reset}`);
                passed++;
            } else {
                console.log(`${colors.red}❌ FAILED (invalid response)${colors.reset}`);
                failed++;
            }
        } catch (error) {
            console.log(`${colors.red}❌ FAILED (${error.message})${colors.reset}`);
            failed++;
        }
    }
    
    console.log('\n' + '='.repeat(40));
    console.log(`${colors.cyan}TEST RESULTS:${colors.reset}`);
    console.log(`  ${colors.green}✅ Passed: ${passed}${colors.reset}`);
    console.log(`  ${colors.red}❌ Failed: ${failed}${colors.reset}`);
    console.log('='.repeat(40) + '\n');
    
    if (failed === 0) {
        console.log(`${colors.green}🎉 All tests passed! Server is working correctly.${colors.reset}\n`);
    } else {
        console.log(`${colors.yellow}⚠️  Some tests failed. Check server logs for details.${colors.reset}\n`);
    }
}

// Run the tests
runTests().catch(error => {
    console.error(`${colors.red}❌ Test runner error:${colors.reset}`, error.message);
    process.exit(1);
});