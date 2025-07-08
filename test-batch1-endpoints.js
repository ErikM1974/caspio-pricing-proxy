const axios = require('axios');

const BASE_URL = 'http://localhost:3002';

async function testEndpoint(path) {
    try {
        const response = await axios.get(`${BASE_URL}${path}`);
        console.log(`✅ ${path} - Status: ${response.status}`);
        console.log(`   Response:`, JSON.stringify(response.data, null, 2).substring(0, 200));
        return true;
    } catch (error) {
        console.log(`❌ ${path} - Error: ${error.message}`);
        return false;
    }
}

async function runTests() {
    console.log('Testing Batch 1 System Endpoints...\n');
    
    const endpoints = [
        '/api/status',
        '/api/test',
        '/api/health'
    ];
    
    let passed = 0;
    for (const endpoint of endpoints) {
        if (await testEndpoint(endpoint)) {
            passed++;
        }
        console.log('');
    }
    
    console.log(`\nSummary: ${passed}/${endpoints.length} endpoints passed`);
    
    if (passed === endpoints.length) {
        console.log('\n✅ All system endpoints are working correctly from modular routes!');
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