// test-api-connections.js - Test script to verify API connections

const axios = require('axios');

// API Base URL - Using the Heroku deployment
const API_BASE_URL = 'https://caspio-pricing-proxy-ab30a049961a.herokuapp.com';

// Test endpoints
const endpoints = [
    { name: 'Status Check', path: '/status' },
    { name: 'Style Search', path: '/api/stylesearch?term=PC61' },
    { name: 'Product Details', path: '/api/product-details?styleNumber=PC61' },
    { name: 'Color Swatches', path: '/api/color-swatches?styleNumber=PC61' },
    { name: 'Pricing Tiers', path: '/api/pricing-tiers?method=DTG' },
    { name: 'All Inventory Fields', path: '/api/inventory?styleNumber=S100' }
];

// Function to test an endpoint
async function testEndpoint(endpoint) {
    console.log(`\nTesting endpoint: ${endpoint.name} (${endpoint.path})`);
    try {
        const startTime = Date.now();
        const response = await axios.get(`${API_BASE_URL}${endpoint.path}`, {
            timeout: 10000 // 10 second timeout
        });
        const endTime = Date.now();
        const duration = endTime - startTime;
        
        console.log(`✅ SUCCESS (${duration}ms)`);
        console.log(`Status: ${response.status}`);
        console.log(`Content-Type: ${response.headers['content-type']}`);
        
        // Print a sample of the response data
        if (response.data) {
            if (Array.isArray(response.data)) {
                console.log(`Data: Array with ${response.data.length} items`);
                if (response.data.length > 0) {
                    console.log(`Sample item: ${JSON.stringify(response.data[0]).substring(0, 150)}...`);
                }
            } else if (typeof response.data === 'object') {
                console.log(`Data: ${JSON.stringify(response.data).substring(0, 150)}...`);
            } else {
                console.log(`Data: ${response.data}`);
            }
        }
    } catch (error) {
        console.log(`❌ ERROR`);
        if (error.response) {
            // The request was made and the server responded with a status code
            // that falls out of the range of 2xx
            console.log(`Status: ${error.response.status}`);
            console.log(`Response: ${JSON.stringify(error.response.data)}`);
        } else if (error.request) {
            // The request was made but no response was received
            console.log('No response received from server');
            console.log(error.message);
        } else {
            // Something happened in setting up the request that triggered an Error
            console.log('Error setting up request:', error.message);
        }
    }
}

// Main function to run all tests
async function runTests() {
    console.log(`Testing API connections to: ${API_BASE_URL}`);
    console.log('='.repeat(50));
    
    for (const endpoint of endpoints) {
        await testEndpoint(endpoint);
        console.log('-'.repeat(50));
    }
    
    console.log('\nAll tests completed.');
}

// Run the tests
runTests();