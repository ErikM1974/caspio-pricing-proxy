#!/usr/bin/env node

// Comprehensive endpoint testing for refactored server
const axios = require('axios');
const colors = require('colors');

const PORT = 3002;
const BASE_URL = `http://localhost:${PORT}`;

// Configure axios defaults
axios.defaults.timeout = 10000;
axios.defaults.validateStatus = function (status) {
    return status < 500; // Resolve only if the status code is less than 500
};

// Test categories with endpoints
const testSuites = {
    'System Health': [
        {
            name: 'Health Check',
            method: 'GET',
            url: '/api/health',
            validate: (res) => res.status === 200 && res.data.status === 'healthy'
        },
        {
            name: 'Status Check',
            method: 'GET',
            url: '/status',
            validate: (res) => res.status === 200 && res.data.status
        },
        {
            name: 'Test Endpoint',
            method: 'GET',
            url: '/test',
            validate: (res) => res.status === 200 && res.data.message
        }
    ],
    
    'Pricing APIs': [
        {
            name: 'Pricing Tiers - DTG',
            method: 'GET',
            url: '/api/pricing-tiers?method=DTG',
            validate: (res) => res.status === 200 && Array.isArray(res.data)
        },
        {
            name: 'Pricing Tiers - ScreenPrint',
            method: 'GET',
            url: '/api/pricing-tiers?method=ScreenPrint',
            validate: (res) => res.status === 200 && Array.isArray(res.data)
        },
        {
            name: 'Pricing Tiers - Embroidery',
            method: 'GET',
            url: '/api/pricing-tiers?method=Embroidery',
            validate: (res) => res.status === 200 && Array.isArray(res.data)
        },
        {
            name: 'Embroidery Costs',
            method: 'GET',
            url: '/api/embroidery-costs?itemType=Shirt&stitchCount=5000',
            validate: (res) => res.status === 200
        },
        {
            name: 'DTG Costs',
            method: 'GET',
            url: '/api/dtg-costs',
            validate: (res) => res.status === 200 && res.data
        },
        {
            name: 'Screenprint Costs - Primary',
            method: 'GET',
            url: '/api/screenprint-costs?costType=PrimaryLocation',
            validate: (res) => res.status === 200 && res.data
        },
        {
            name: 'Pricing Rules - DTG',
            method: 'GET',
            url: '/api/pricing-rules?method=DTG',
            validate: (res) => res.status === 200 && res.data
        },
        {
            name: 'Pricing Bundle',
            method: 'GET',
            url: '/api/pricing-bundle',
            validate: (res) => res.status === 200 && res.data
        },
        {
            name: 'Base Item Costs',
            method: 'GET',
            url: '/api/base-item-costs?styleNumber=PC54',
            validate: (res) => res.status === 200
        },
        {
            name: 'Size Pricing',
            method: 'GET',
            url: '/api/size-pricing?styleNumber=PC54',
            validate: (res) => res.status === 200
        },
        {
            name: 'Max Prices by Style',
            method: 'GET',
            url: '/api/max-prices-by-style?styleNumber=PC54',
            validate: (res) => res.status === 200
        }
    ],
    
    'Product APIs': [
        {
            name: 'Style Search',
            method: 'GET',
            url: '/api/stylesearch?term=PC54',
            validate: (res) => res.status === 200 && Array.isArray(res.data)
        },
        {
            name: 'Product Details',
            method: 'GET',
            url: '/api/product-details?styleNumber=PC54',
            validate: (res) => res.status === 200
        },
        {
            name: 'Color Swatches',
            method: 'GET',
            url: '/api/color-swatches?styleNumber=PC54',
            validate: (res) => res.status === 200 && Array.isArray(res.data)
        },
        {
            name: 'All Brands',
            method: 'GET',
            url: '/api/all-brands',
            validate: (res) => res.status === 200 && Array.isArray(res.data)
        },
        {
            name: 'All Categories',
            method: 'GET',
            url: '/api/all-categories',
            validate: (res) => res.status === 200 && Array.isArray(res.data)
        },
        {
            name: 'All Subcategories',
            method: 'GET',
            url: '/api/all-subcategories',
            validate: (res) => res.status === 200 && Array.isArray(res.data)
        },
        {
            name: 'Products by Brand',
            method: 'GET',
            url: '/api/products-by-brand?brand=Port%20%26%20Company',
            validate: (res) => res.status === 200 && Array.isArray(res.data)
        },
        {
            name: 'Products by Category',
            method: 'GET',
            url: '/api/products-by-category?category=T-Shirts',
            validate: (res) => res.status === 200 && Array.isArray(res.data)
        },
        {
            name: 'Products by Subcategory',
            method: 'GET',
            url: '/api/products-by-subcategory?subcategory=T-Shirts',
            validate: (res) => res.status === 200 && Array.isArray(res.data)
        },
        {
            name: 'Products by Category & Subcategory',
            method: 'GET',
            url: '/api/products-by-category-subcategory?category=T-Shirts&subcategory=T-Shirts',
            validate: (res) => res.status === 200 && Array.isArray(res.data)
        }
    ],
    
    'Inventory APIs': [
        {
            name: 'Inventory Check',
            method: 'GET',
            url: '/api/inventory?styleNumber=PC54',
            validate: (res) => res.status === 200 || res.status === 404 // 404 is ok if no inventory
        },
        {
            name: 'Size Sort Order',
            method: 'GET',
            url: '/api/size-sort-order',
            validate: (res) => res.status === 200 && res.data
        },
        {
            name: 'Size Upcharges',
            method: 'GET',
            url: '/api/size-upcharges',
            validate: (res) => res.status === 200 && res.data
        }
    ],
    
    'Utility APIs': [
        {
            name: 'Locations',
            method: 'GET',
            url: '/api/locations',
            validate: (res) => res.status === 200 && Array.isArray(res.data)
        },
        {
            name: 'Test SanMar Bulk',
            method: 'GET',
            url: '/api/test-sanmar-bulk',
            validate: (res) => res.status === 200
        }
    ]
};

// Test execution
async function testEndpoint(test) {
    try {
        const startTime = Date.now();
        const response = await axios({
            method: test.method,
            url: `${BASE_URL}${test.url}`
        });
        const duration = Date.now() - startTime;
        
        const isValid = test.validate(response);
        
        return {
            success: isValid,
            status: response.status,
            duration,
            dataSize: JSON.stringify(response.data).length,
            error: null
        };
    } catch (error) {
        return {
            success: false,
            status: error.response?.status || 0,
            duration: 0,
            dataSize: 0,
            error: error.message
        };
    }
}

async function runAllTests() {
    console.log('\n' + '='.repeat(80));
    console.log(colors.cyan.bold('🧪 COMPREHENSIVE ENDPOINT TESTING'));
    console.log('='.repeat(80));
    console.log(`📍 Server URL: ${BASE_URL}`);
    console.log(`📅 Test Date: ${new Date().toLocaleString()}`);
    console.log('='.repeat(80) + '\n');
    
    // First check if server is running
    try {
        await axios.get(`${BASE_URL}/api/health`);
    } catch (error) {
        console.error(colors.red('❌ Server is not running!'));
        console.log(colors.yellow('\nPlease start the server:'));
        console.log('  node start-server.js\n');
        process.exit(1);
    }
    
    const results = {
        total: 0,
        passed: 0,
        failed: 0,
        byCategory: {}
    };
    
    // Run tests by category
    for (const [category, tests] of Object.entries(testSuites)) {
        console.log(colors.yellow.bold(`\n📂 ${category}`));
        console.log('-'.repeat(60));
        
        const categoryResults = {
            total: 0,
            passed: 0,
            failed: 0,
            tests: []
        };
        
        for (const test of tests) {
            process.stdout.write(`  ${test.name.padEnd(40, '.')}`);
            
            const result = await testEndpoint(test);
            categoryResults.total++;
            results.total++;
            
            if (result.success) {
                categoryResults.passed++;
                results.passed++;
                console.log(colors.green(` ✅ PASS`) + 
                    colors.gray(` [${result.status}] ${result.duration}ms (${result.dataSize} bytes)`));
            } else {
                categoryResults.failed++;
                results.failed++;
                console.log(colors.red(` ❌ FAIL`) + 
                    colors.gray(` [${result.status}] ${result.error || 'Invalid response'}`));
            }
            
            categoryResults.tests.push({
                name: test.name,
                ...result
            });
        }
        
        results.byCategory[category] = categoryResults;
        
        // Category summary
        console.log(colors.gray(`  Summary: ${categoryResults.passed}/${categoryResults.total} passed`));
    }
    
    // Overall summary
    console.log('\n' + '='.repeat(80));
    console.log(colors.cyan.bold('📊 TEST SUMMARY'));
    console.log('='.repeat(80));
    
    const passRate = ((results.passed / results.total) * 100).toFixed(1);
    console.log(`Total Tests: ${results.total}`);
    console.log(colors.green(`✅ Passed: ${results.passed}`));
    console.log(colors.red(`❌ Failed: ${results.failed}`));
    console.log(`Pass Rate: ${passRate}%`);
    
    // Category breakdown
    console.log('\nBy Category:');
    for (const [category, catResults] of Object.entries(results.byCategory)) {
        const catPassRate = ((catResults.passed / catResults.total) * 100).toFixed(0);
        const icon = catResults.failed === 0 ? '✅' : '⚠️';
        console.log(`  ${icon} ${category}: ${catResults.passed}/${catResults.total} (${catPassRate}%)`);
    }
    
    // Failed tests detail
    if (results.failed > 0) {
        console.log(colors.red('\n❌ Failed Tests:'));
        for (const [category, catResults] of Object.entries(results.byCategory)) {
            const failedTests = catResults.tests.filter(t => !t.success);
            if (failedTests.length > 0) {
                console.log(`\n  ${category}:`);
                failedTests.forEach(test => {
                    console.log(`    - ${test.name}: ${test.error || `Status ${test.status}`}`);
                });
            }
        }
    }
    
    // Performance stats
    console.log('\n📈 Performance Statistics:');
    let totalDuration = 0;
    let fastestTest = null;
    let slowestTest = null;
    
    for (const catResults of Object.values(results.byCategory)) {
        for (const test of catResults.tests) {
            if (test.success && test.duration > 0) {
                totalDuration += test.duration;
                if (!fastestTest || test.duration < fastestTest.duration) {
                    fastestTest = test;
                }
                if (!slowestTest || test.duration > slowestTest.duration) {
                    slowestTest = test;
                }
            }
        }
    }
    
    console.log(`  Total test time: ${(totalDuration / 1000).toFixed(2)}s`);
    if (fastestTest) {
        console.log(`  Fastest endpoint: ${fastestTest.name} (${fastestTest.duration}ms)`);
    }
    if (slowestTest) {
        console.log(`  Slowest endpoint: ${slowestTest.name} (${slowestTest.duration}ms)`);
    }
    
    console.log('\n' + '='.repeat(80));
    
    // Exit code based on results
    process.exit(results.failed > 0 ? 1 : 0);
}

// Run the tests
runAllTests().catch(error => {
    console.error(colors.red('❌ Test runner error:'), error.message);
    process.exit(1);
});