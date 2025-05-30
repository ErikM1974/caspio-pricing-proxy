// test-main-server.js - Test script to check if the main server is responding to requests
const axios = require('axios');

// Define the base URL for the main server
const BASE_URL = 'http://localhost:3000';

// Function to test an endpoint
async function testEndpoint(endpoint) {
  try {
    console.log(`Testing endpoint: ${endpoint}`);
    const response = await axios.get(`${BASE_URL}${endpoint}`);
    console.log(`✅ Success! Status: ${response.status}`);
    console.log(`Response data: ${JSON.stringify(response.data)}`);
    return true;
  } catch (error) {
    console.error(`❌ Error! Status: ${error.response ? error.response.status : 'Unknown'}`);
    console.error(`Error message: ${error.message}`);
    if (error.response && error.response.data) {
      console.error(`Response data: ${JSON.stringify(error.response.data)}`);
    }
    return false;
  }
}

// Main function to run all tests
async function runTests() {
  console.log('='.repeat(80));
  console.log('TESTING MAIN SERVER ENDPOINTS');
  console.log('='.repeat(80));
  
  // Test the /test endpoint we added
  await testEndpoint('/test');
  
  // Test the /status endpoint
  await testEndpoint('/status');
  
  // Test the /api/quote_analytics endpoint
  await testEndpoint('/api/quote_analytics');
  
  // Test a few other endpoints
  await testEndpoint('/api/stylesearch?term=PC');
  await testEndpoint('/api/pricing-tiers?method=DTG');
  
  console.log('='.repeat(80));
  console.log('TESTS COMPLETED');
  console.log('='.repeat(80));
}

// Run the tests
runTests();