// test-pricing-matrix-simple.js - Simple test script for PricingMatrix GET endpoint

const axios = require('axios');

// Heroku URL for testing
const herokuUrl = 'https://caspio-pricing-proxy-ab30a049961a.herokuapp.com';

// Function to test GET /api/pricing-matrix
async function testGetPricingMatrix() {
  try {
    console.log('Testing GET /api/pricing-matrix');
    const response = await axios.get(`${herokuUrl}/api/pricing-matrix`);
    console.log(`Status: ${response.status}`);
    console.log(`Response data: ${JSON.stringify(response.data)}`);
    return response.data;
  } catch (error) {
    console.error('Error testing GET /api/pricing-matrix:', error.response ? error.response.data : error.message);
    throw error;
  }
}

// Run the test
testGetPricingMatrix()
  .then(data => {
    console.log('Test completed successfully!');
  })
  .catch(error => {
    console.error('Test failed:', error.message);
  });