// test-local-lookup.js - Simple test for the local lookup endpoint

const axios = require('axios');

// Local server URL
const serverUrl = 'http://localhost:3002';

// Test function
async function testLookup() {
  try {
    console.log('Testing local lookup endpoint...');
    
    const params = {
      styleNumber: 'PC61',
      color: 'RED',
      embellishmentType: 'DTG'
    };
    
    console.log(`Requesting: GET ${serverUrl}/api/pricing-matrix/lookup with params: ${JSON.stringify(params)}`);
    
    const response = await axios.get(`${serverUrl}/api/pricing-matrix/lookup`, { 
      params,
      timeout: 5000 // 5 second timeout
    });
    
    console.log(`Status: ${response.status}`);
    console.log(`Response data: ${JSON.stringify(response.data)}`);
    
    if (response.data.pricingMatrixId) {
      console.log("SUCCESS: Found pricingMatrixId.");
    } else {
      console.error("FAILURE: Did not receive pricingMatrixId in response.");
    }
  } catch (error) {
    console.error('Error during lookup test:');
    if (error.response) {
      console.error(`Status: ${error.response.status}`);
      console.error(`Data: ${JSON.stringify(error.response.data)}`);
    } else {
      console.error(`Message: ${error.message}`);
    }
  }
}

// Run the test
testLookup();