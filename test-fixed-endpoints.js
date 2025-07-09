const axios = require('axios');

const LOCAL_URL = 'http://localhost:3002';

const fixedEndpoints = [
    { method: 'GET', path: '/api/artrequests', description: 'Art requests (FIXED)' },
    { method: 'GET', path: '/api/art-invoices', description: 'Art invoices (FIXED)' },
    { method: 'GET', path: '/api/production-schedules', description: 'Production schedules (FIXED)' },
    { method: 'GET', path: '/api/locations', description: 'Locations (FIXED)' },
    { method: 'GET', path: '/api/test-sanmar-bulk', description: 'Test Sanmar bulk (ALREADY WORKING)' }
];

async function testEndpoint(endpoint) {
    const url = `${LOCAL_URL}${endpoint.path}`;
    
    try {
        const response = await axios({
            method: endpoint.method,
            url: url,
            timeout: 5000,
            validateStatus: (status) => true
        });
        
        return {
            endpoint: endpoint.path,
            method: endpoint.method,
            description: endpoint.description,
            status: response.status,
            working: response.status >= 200 && response.status < 400
        };
    } catch (error) {
        return {
            endpoint: endpoint.path,
            method: endpoint.method,
            description: endpoint.description,
            status: 'ERROR',
            error: error.message,
            working: false
        };
    }
}

async function runTests() {
    console.log('Testing Fixed Endpoints Locally');
    console.log('==============================\n');

    for (const endpoint of fixedEndpoints) {
        const result = await testEndpoint(endpoint);
        const icon = result.working ? '✅' : '❌';
        console.log(`${icon} ${result.method} ${result.endpoint} - ${result.description} (${result.status})`);
    }
}

runTests().catch(console.error);
