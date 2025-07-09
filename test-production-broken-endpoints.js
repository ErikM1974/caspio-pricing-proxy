// Test script to verify which endpoints are broken after the cleanup
// Focus on endpoints that were previously working

const axios = require('axios');

const PRODUCTION_URL = 'https://caspio-pricing-proxy-ab30a049961a.herokuapp.com';

// Previously working endpoints from heroku-52-endpoints-status.json
const criticalEndpoints = [
    { method: 'GET', path: '/api/artrequests', description: 'Art requests list' },
    { method: 'PUT', path: '/api/artrequests/52503', description: 'Update art request' },
    { method: 'GET', path: '/api/art-invoices', description: 'Art invoices list' },
    { method: 'POST', path: '/api/art-invoices', description: 'Create art invoice' },
    { method: 'PUT', path: '/api/art-invoices/1', description: 'Update invoice' },
    { method: 'GET', path: '/api/customers', description: 'Customers list' },
    { method: 'GET', path: '/api/product-colors', description: 'Product colors' },
    { method: 'GET', path: '/api/pricing-tiers', description: 'Pricing tiers' },
    { method: 'GET', path: '/api/quote_items', description: 'Quote items' },
    { method: 'GET', path: '/api/quote_analytics', description: 'Quote analytics' },
    { method: 'GET', path: '/api/quote_sessions', description: 'Quote sessions' },
    { method: 'GET', path: '/api/orders', description: 'List orders' },
    { method: 'GET', path: '/api/health', description: 'Health check' },
    { method: 'GET', path: '/api/order-dashboard', description: 'Order dashboard' },
    { method: 'GET', path: '/api/staff-announcements', description: 'Staff announcements' }
];

async function testEndpoint(endpoint) {
    const url = `${PRODUCTION_URL}${endpoint.path}`;
    
    try {
        const config = {
            method: endpoint.method,
            url: url,
            timeout: 10000,
            validateStatus: (status) => true // Don't throw on any status
        };

        // Add test data for POST/PUT requests
        if (endpoint.method === 'POST' && endpoint.path === '/api/art-invoices') {
            config.data = { test: true };
        } else if (endpoint.method === 'PUT') {
            config.data = { test: true };
        }

        const response = await axios(config);
        
        return {
            endpoint: endpoint.path,
            method: endpoint.method,
            description: endpoint.description,
            status: response.status,
            statusText: response.statusText,
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
    console.log('Testing Critical Production Endpoints');
    console.log('=====================================\n');
    console.log(`Production URL: ${PRODUCTION_URL}\n`);

    const results = [];
    
    for (const endpoint of criticalEndpoints) {
        process.stdout.write(`Testing ${endpoint.method} ${endpoint.path}... `);
        const result = await testEndpoint(endpoint);
        results.push(result);
        
        if (result.working) {
            console.log(`✅ ${result.status}`);
        } else {
            console.log(`❌ ${result.status} ${result.statusText || result.error || ''}`);
        }
    }

    // Summary
    console.log('\n\nSummary');
    console.log('=======');
    
    const working = results.filter(r => r.working);
    const broken = results.filter(r => !r.working);
    
    console.log(`Total endpoints tested: ${results.length}`);
    console.log(`Working: ${working.length} (${Math.round(working.length / results.length * 100)}%)`);
    console.log(`Broken: ${broken.length} (${Math.round(broken.length / results.length * 100)}%)`);
    
    if (broken.length > 0) {
        console.log('\nBroken Endpoints:');
        console.log('-----------------');
        broken.forEach(endpoint => {
            console.log(`❌ ${endpoint.method} ${endpoint.endpoint} - ${endpoint.description} (${endpoint.status})`);
        });
    }
    
    // Save results
    const timestamp = new Date().toISOString().replace(/:/g, '-').split('.')[0];
    const fs = require('fs');
    fs.writeFileSync(
        `production-broken-endpoints-${timestamp}.json`,
        JSON.stringify({ timestamp: new Date().toISOString(), results }, null, 2)
    );
    
    console.log(`\nResults saved to: production-broken-endpoints-${timestamp}.json`);
}

// Run the tests
runTests().catch(console.error);