const axios = require('axios');

const BASE_URL = 'http://localhost:3002';

async function testEndpoint(path, params = {}) {
    try {
        const response = await axios.get(`${BASE_URL}${path}`, { params });
        console.log(`✅ ${path} - Status: ${response.status}`);
        if (Object.keys(params).length > 0) {
            console.log(`   Params: ${JSON.stringify(params)}`);
        }
        console.log(`   Response preview:`, JSON.stringify(response.data, null, 2).substring(0, 200));
        return true;
    } catch (error) {
        console.log(`❌ ${path} - Error: ${error.response?.status || error.message}`);
        if (Object.keys(params).length > 0) {
            console.log(`   Params: ${JSON.stringify(params)}`);
        }
        return false;
    }
}

async function runTests() {
    console.log('Testing Batch 2 Pricing Endpoints...\n');
    
    const tests = [
        { path: '/api/pricing-tiers', params: { method: 'DTG' } },
        { path: '/api/embroidery-costs', params: { itemType: 'Cap', stitchCount: 8000 } },
        { path: '/api/dtg-costs', params: {} },
        { path: '/api/screenprint-costs', params: { costType: 'PrimaryLocation' } },
        { path: '/api/pricing-rules', params: { method: 'Embroidery' } },
        { path: '/api/pricing-bundle', params: { method: 'DTG' } },
        { path: '/api/base-item-costs', params: { styleNumber: 'PC54' } },
        { path: '/api/size-pricing', params: { styleNumber: 'PC54' } },
        { path: '/api/size-upcharges', params: {} },
        { path: '/api/size-sort-order', params: {} }
    ];
    
    let passed = 0;
    for (const test of tests) {
        if (await testEndpoint(test.path, test.params)) {
            passed++;
        }
        console.log('');
    }
    
    console.log(`\nSummary: ${passed}/${tests.length} endpoints passed`);
    
    if (passed === tests.length) {
        console.log('\n✅ All pricing endpoints are working correctly!');
    } else {
        console.log('\n❌ Some endpoints failed. Please check the errors above.');
    }
}

// Check if server is running first
axios.get(`${BASE_URL}/api/status`)
    .then(() => {
        console.log('Server is running. Starting tests...\n');
        runTests();
    })
    .catch(() => {
        console.log('❌ Server is not running! Please start the server first with:');
        console.log('   node start-server.js');
    });