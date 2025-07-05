// test-pricing-matrix-lookup.js - Test script for the new lookup endpoint

const axios = require('axios');

// Server URL for testing (local or Heroku)
let serverUrl = 'http://localhost:3002';

// Check if local server is available, otherwise use Heroku
async function determineServerUrl() {
  try {
    console.log(`Checking if local server is available at ${serverUrl}...`);
    await axios.get(`${serverUrl}/status`, { timeout: 2000 });
    console.log(`Using local server at ${serverUrl}`);
    return serverUrl;
  } catch (error) {
    // If local server is not available, try Heroku
    const herokuUrl = 'https://caspio-pricing-proxy-ab30a049961a.herokuapp.com';
    console.log(`Local server not available. Trying Heroku at ${herokuUrl}...`);
    try {
      await axios.get(`${herokuUrl}/status`, { timeout: 5000 });
      console.log(`Using Heroku server at ${herokuUrl}`);
      serverUrl = herokuUrl;
      return serverUrl;
    } catch (error) {
      console.error(`Error connecting to Heroku server: ${error.message}`);
      throw new Error('No server available for testing');
    }
  }
}

// --- Test Cases ---

// Test Case 1: Successful Lookup (using data from previous direct test)
async function testSuccessfulLookup() {
  console.log('\n--- Test Case 1: Successful Lookup ---');
  const params = {
    styleNumber: 'PC61',
    color: 'RED',
    embellishmentType: 'DTG',
    // sessionID: 'direct-test-1745497242701' // Optional: Add sessionID if needed for specific test
  };
  try {
    console.log(`Requesting: GET ${serverUrl}/api/pricing-matrix/lookup with params: ${JSON.stringify(params)}`);
    const response = await axios.get(`${serverUrl}/api/pricing-matrix/lookup`, { params });
    console.log(`Status: ${response.status}`);
    console.log(`Response data: ${JSON.stringify(response.data)}`);
    if (response.data.pricingMatrixId) {
        console.log("SUCCESS: Found pricingMatrixId.");
    } else {
        console.error("FAILURE: Did not receive pricingMatrixId in response.");
    }
  } catch (error) {
    console.error('Error during successful lookup test:');
    if (error.response) {
      console.error(`Status: ${error.response.status}`);
      console.error(`Data: ${JSON.stringify(error.response.data)}`);
    } else {
      console.error(`Message: ${error.message}`);
    }
  }
}

// Test Case 2: Lookup Not Found (404)
async function testNotFoundLookup() {
  console.log('\n--- Test Case 2: Lookup Not Found (404) ---');
  const params = {
    styleNumber: 'NONEXISTENT',
    color: 'NOCOLOR',
    embellishmentType: 'NOTYPE'
  };
  try {
    console.log(`Requesting: GET ${serverUrl}/api/pricing-matrix/lookup with params: ${JSON.stringify(params)}`);
    const response = await axios.get(`${serverUrl}/api/pricing-matrix/lookup`, { params });
    console.error(`FAILURE: Expected 404 but received Status: ${response.status}`);
    console.error(`Response data: ${JSON.stringify(response.data)}`);
  } catch (error) {
    if (error.response && error.response.status === 404) {
      console.log(`Status: ${error.response.status}`);
      console.log(`Response data: ${JSON.stringify(error.response.data)}`);
      console.log("SUCCESS: Received expected 404 Not Found.");
    } else {
      console.error('Error during not found lookup test (unexpected error):');
      if (error.response) {
        console.error(`Status: ${error.response.status}`);
        console.error(`Data: ${JSON.stringify(error.response.data)}`);
      } else {
        console.error(`Message: ${error.message}`);
      }
    }
  }
}

// Test Case 3: Missing Required Parameters (400)
async function testBadRequestLookup() {
  console.log('\n--- Test Case 3: Missing Required Parameters (400) ---');
  const params = {
    styleNumber: 'PC61',
    // color is missing
    embellishmentType: 'DTG'
  };
  try {
    console.log(`Requesting: GET ${serverUrl}/api/pricing-matrix/lookup with params: ${JSON.stringify(params)}`);
    const response = await axios.get(`${serverUrl}/api/pricing-matrix/lookup`, { params });
    console.error(`FAILURE: Expected 400 but received Status: ${response.status}`);
    console.error(`Response data: ${JSON.stringify(response.data)}`);
  } catch (error) {
    if (error.response && error.response.status === 400) {
      console.log(`Status: ${error.response.status}`);
      console.log(`Response data: ${JSON.stringify(error.response.data)}`);
      console.log("SUCCESS: Received expected 400 Bad Request.");
    } else {
      console.error('Error during bad request lookup test (unexpected error):');
      if (error.response) {
        console.error(`Status: ${error.response.status}`);
        console.error(`Data: ${JSON.stringify(error.response.data)}`);
      } else {
        console.error(`Message: ${error.message}`);
      }
    }
  }
}


// Main function to run all tests
async function runTests() {
  try {
    await determineServerUrl(); // Determine if local or Heroku server is running
    console.log(`\nStarting tests for /api/pricing-matrix/lookup against ${serverUrl}`);
    console.log('='.repeat(60));

    await testSuccessfulLookup();
    await testNotFoundLookup();
    await testBadRequestLookup();

    console.log('\n' + '='.repeat(60));
    console.log('All lookup tests completed!');
  } catch (error) {
    console.error('\nError running lookup tests:', error.message);
  }
}

// Run the tests
runTests();