#!/usr/bin/env node

// Quick endpoint testing with timeout handling
const axios = require('axios');

const PORT = 3002;
const BASE_URL = `http://localhost:${PORT}`;

// Quick test endpoints (avoiding heavy inventory queries)
const quickTests = [
    // System
    { name: 'Health Check', url: '/api/health' },
    { name: 'Status', url: '/status' },
    { name: 'Test', url: '/test' },
    
    // Pricing
    { name: 'Pricing Tiers DTG', url: '/api/pricing-tiers?method=DTG' },
    { name: 'DTG Costs', url: '/api/dtg-costs' },
    { name: 'Pricing Rules', url: '/api/pricing-rules?method=DTG' },
    
    // Product (light queries)
    { name: 'Style Search', url: '/api/stylesearch?term=G500' },
    { name: 'All Brands', url: '/api/all-brands' },
    { name: 'Locations', url: '/api/locations' },
    { name: 'Size Upcharges', url: '/api/size-upcharges' },
    { name: 'Size Sort Order', url: '/api/size-sort-order' },
    
    // Inventory (simpler style)
    { name: 'Inventory G500', url: '/api/inventory?styleNumber=G500' },
    { name: 'Base Costs G500', url: '/api/base-item-costs?styleNumber=G500' }
];

async function runQuickTests() {
    console.log('\n🚀 QUICK ENDPOINT TEST');
    console.log('='.repeat(50));
    
    // Check server
    try {
        await axios.get(`${BASE_URL}/api/health`, { timeout: 2000 });
        console.log('✅ Server is running\n');
    } catch (error) {
        console.error('❌ Server not running!');
        process.exit(1);
    }
    
    let passed = 0;
    let failed = 0;
    
    for (const test of quickTests) {
        process.stdout.write(`${test.name.padEnd(25, '.')}`);
        
        try {
            const start = Date.now();
            const response = await axios.get(`${BASE_URL}${test.url}`, { 
                timeout: 5000,
                validateStatus: () => true 
            });
            const duration = Date.now() - start;
            
            if (response.status === 200) {
                console.log(` ✅ [${duration}ms]`);
                passed++;
            } else {
                console.log(` ❌ [${response.status}]`);
                failed++;
            }
        } catch (error) {
            console.log(` ❌ [${error.code || error.message}]`);
            failed++;
        }
    }
    
    console.log('\n' + '='.repeat(50));
    console.log(`Results: ${passed} passed, ${failed} failed`);
    console.log(`Success rate: ${((passed / quickTests.length) * 100).toFixed(0)}%`);
    
    // List available endpoints
    console.log('\n📋 Available endpoints in server.js:');
    const endpointGroups = {
        'Pricing': ['/pricing-tiers', '/embroidery-costs', '/dtg-costs', '/screenprint-costs', '/pricing-rules', '/base-item-costs'],
        'Products': ['/stylesearch', '/product-details', '/color-swatches', '/all-brands', '/products-by-*'],
        'Inventory': ['/inventory', '/size-pricing', '/max-prices-by-style'],
        'Utility': ['/locations', '/size-upcharges', '/size-sort-order', '/test-sanmar-bulk']
    };
    
    for (const [group, endpoints] of Object.entries(endpointGroups)) {
        console.log(`\n${group}:`);
        endpoints.forEach(ep => console.log(`  ${ep}`));
    }
}

runQuickTests().catch(console.error);