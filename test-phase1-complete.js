#!/usr/bin/env node

// Test all endpoints after Phase 1 (all modules enabled)
const axios = require('axios');
const fs = require('fs').promises;

const BASE_URL = 'http://localhost:3002';

// Sample of endpoints from each module
const MODULE_ENDPOINTS = {
    'Orders Module': [
        '/api/orders',
        '/api/order-dashboard',
        '/api/order-odbc?q.limit=5',
        '/api/customers'
    ],
    'Misc Module': [
        '/api/staff-announcements',
        '/api/locations',
        '/api/test-sanmar-bulk'
    ],
    'Pricing Module': [
        '/api/pricing-tiers?method=DTG',
        '/api/dtg-costs',
        '/api/embroidery-costs?itemType=Shirt&stitchCount=5000',
        '/api/pricing-rules?method=DTG'
    ],
    'Inventory Module': [
        '/api/inventory?styleNumber=PC54',
        '/api/size-sort-order',
        '/api/size-upcharges'
    ],
    'Products Module': [
        '/api/product-details?styleNumber=PC54',
        '/api/stylesearch?term=PC',
        '/api/all-brands',
        '/api/products-by-category?category=T-Shirts'
    ],
    'Cart Module': [
        '/api/cart-sessions',
        '/api/cart-items',
        '/api/cart-item-sizes'
    ],
    'Quotes Module': [
        '/api/quote_analytics',
        '/api/quote_items',
        '/api/quote_sessions'
    ],
    'Pricing Matrix Module': [
        '/api/pricing-matrix',
        '/api/pricing-matrix/lookup?styleNumber=PC54&color=Black&embellishmentType=DTG'
    ],
    'Transfers Module': [
        '/api/transfers'
    ]
};

async function testAllModules() {
    console.log('🧪 Testing All Modules After Phase 1\n');
    console.log(`Server: ${BASE_URL}`);
    console.log(`Time: ${new Date().toLocaleString()}\n`);
    
    const results = {
        timestamp: new Date().toISOString(),
        phase: 'Phase 1 Complete - All Modules Enabled',
        summary: { total: 0, passed: 0, failed: 0 },
        byModule: {}
    };
    
    for (const [module, endpoints] of Object.entries(MODULE_ENDPOINTS)) {
        console.log(`\n📦 ${module}`);
        console.log('-'.repeat(50));
        
        results.byModule[module] = {
            total: endpoints.length,
            passed: 0,
            failed: 0,
            endpoints: {}
        };
        
        for (const endpoint of endpoints) {
            process.stdout.write(`  ${endpoint.padEnd(60, '.')}`);
            
            try {
                const start = Date.now();
                const response = await axios.get(`${BASE_URL}${endpoint}`, { 
                    timeout: 10000,
                    validateStatus: () => true 
                });
                const duration = Date.now() - start;
                
                results.summary.total++;
                results.byModule[module].endpoints[endpoint] = {
                    status: response.status,
                    duration: duration,
                    passed: response.status === 200
                };
                
                if (response.status === 200) {
                    results.summary.passed++;
                    results.byModule[module].passed++;
                    console.log(` ✅ [${response.status}] ${duration}ms`);
                } else {
                    results.summary.failed++;
                    results.byModule[module].failed++;
                    console.log(` ❌ [${response.status}]`);
                }
                
            } catch (error) {
                results.summary.total++;
                results.summary.failed++;
                results.byModule[module].failed++;
                results.byModule[module].endpoints[endpoint] = {
                    status: 0,
                    error: error.message,
                    passed: false
                };
                console.log(` ❌ [ERROR] ${error.message}`);
            }
        }
        
        const modResult = results.byModule[module];
        console.log(`  Module Summary: ${modResult.passed}/${modResult.total} passed`);
    }
    
    // Summary
    console.log('\n' + '='.repeat(60));
    console.log('📊 PHASE 1 TEST SUMMARY');
    console.log('='.repeat(60));
    console.log(`Total Endpoints: ${results.summary.total}`);
    console.log(`✅ Passed: ${results.summary.passed}`);
    console.log(`❌ Failed: ${results.summary.failed}`);
    console.log(`Success Rate: ${((results.summary.passed / results.summary.total) * 100).toFixed(1)}%`);
    
    // Module breakdown
    console.log('\nBy Module:');
    for (const [module, data] of Object.entries(results.byModule)) {
        const icon = data.failed === 0 ? '✅' : '❌';
        console.log(`  ${icon} ${module}: ${data.passed}/${data.total}`);
    }
    
    // Save results
    await fs.writeFile(
        'migration-logs/phase1-test-results.json',
        JSON.stringify(results, null, 2)
    );
    
    console.log('\n✅ Results saved to migration-logs/phase1-test-results.json');
    
    // Check critical endpoints
    const criticalPass = [
        '/api/order-dashboard',
        '/api/staff-announcements',
        '/api/health'
    ].every(ep => {
        for (const data of Object.values(results.byModule)) {
            if (data.endpoints[ep]?.passed) return true;
        }
        return false;
    });
    
    if (criticalPass) {
        console.log('\n✅ All critical endpoints are working!');
    } else {
        console.log('\n❌ Some critical endpoints failed!');
    }
    
    return results;
}

testAllModules().catch(console.error);