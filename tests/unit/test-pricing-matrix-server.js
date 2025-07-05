// test-pricing-matrix-server.js - Test script for PricingMatrix endpoints in server.js

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

// Function to test GET /api/pricing-matrix
async function testGetPricingMatrix() {
  try {
    console.log('\nTesting GET /api/pricing-matrix');
    const response = await axios.get(`${serverUrl}/api/pricing-matrix`);
    console.log(`Status: ${response.status}`);
    console.log(`Found ${response.data.length} pricing matrix records`);
    if (response.data.length > 0) {
      console.log(`Sample data: ${JSON.stringify(response.data[0])}`);
    }
    return response.data;
  } catch (error) {
    console.error('Error testing GET /api/pricing-matrix:', error.response ? error.response.data : error.message);
    throw error;
  }
}

// Function to test POST /api/pricing-matrix with detailed logging
async function testCreatePricingMatrix() {
  try {
    console.log('\nTesting POST /api/pricing-matrix');
    
    // Create test data with a unique SessionID
    const testData = {
      SessionID: "server-test-" + Date.now(),
      StyleNumber: "PC61",
      Color: "BLUE",
      EmbellishmentType: "SCREENPRINT",
      TierStructure: "SERVER TEST TIER",
      SizeGroups: "SERVER TEST SIZE",
      PriceMatrix: "SERVER TEST PRICE"
    };
    
    console.log(`Creating pricing matrix with data: ${JSON.stringify(testData)}`);
    
    // Make the request with detailed logging
    console.log(`Sending POST request to ${serverUrl}/api/pricing-matrix`);
    const response = await axios.post(`${serverUrl}/api/pricing-matrix`, testData);
    
    console.log(`Response status: ${response.status}`);
    console.log(`Response headers: ${JSON.stringify(response.headers)}`);
    console.log(`Response data: ${JSON.stringify(response.data)}`);
    
    return response.data;
  } catch (error) {
    console.error('Error testing POST /api/pricing-matrix:');
    if (error.response) {
      console.error(`Status: ${error.response.status}`);
      console.error(`Headers: ${JSON.stringify(error.response.headers)}`);
      console.error(`Data: ${JSON.stringify(error.response.data)}`);
    } else if (error.request) {
      console.error(`Request was made but no response received: ${error.request}`);
    } else {
      console.error(`Error setting up request: ${error.message}`);
    }
    throw error;
  }
}

// Function to test GET /api/pricing-matrix/:id
async function testGetPricingMatrixById(id) {
  try {
    console.log(`\nTesting GET /api/pricing-matrix/${id}`);
    const response = await axios.get(`${serverUrl}/api/pricing-matrix/${id}`);
    console.log(`Status: ${response.status}`);
    console.log(`Response data: ${JSON.stringify(response.data)}`);
    return response.data;
  } catch (error) {
    console.error(`Error testing GET /api/pricing-matrix/${id}:`, error.response ? error.response.data : error.message);
    throw error;
  }
}

// Function to test PUT /api/pricing-matrix/:id
async function testUpdatePricingMatrix(id) {
  try {
    console.log(`\nTesting PUT /api/pricing-matrix/${id}`);
    const updateData = {
      TierStructure: "UPDATED SERVER TEST TIER",
      SizeGroups: "UPDATED SERVER TEST SIZE",
      PriceMatrix: "UPDATED SERVER TEST PRICE"
    };
    console.log(`Updating pricing matrix with data: ${JSON.stringify(updateData)}`);
    const response = await axios.put(`${serverUrl}/api/pricing-matrix/${id}`, updateData);
    console.log(`Status: ${response.status}`);
    console.log(`Response data: ${JSON.stringify(response.data)}`);
    return response.data;
  } catch (error) {
    console.error(`Error testing PUT /api/pricing-matrix/${id}:`, error.response ? error.response.data : error.message);
    throw error;
  }
}

// Function to test DELETE /api/pricing-matrix/:id
async function testDeletePricingMatrix(id) {
  try {
    console.log(`\nTesting DELETE /api/pricing-matrix/${id}`);
    const response = await axios.delete(`${serverUrl}/api/pricing-matrix/${id}`);
    console.log(`Status: ${response.status}`);
    console.log(`Response data: ${JSON.stringify(response.data)}`);
    return response.data;
  } catch (error) {
    console.error(`Error testing DELETE /api/pricing-matrix/${id}:`, error.response ? error.response.data : error.message);
    throw error;
  }
}

// Main function to run all tests
async function runTests() {
  try {
    // Determine which server to use
    await determineServerUrl();
    
    console.log(`\nStarting tests against ${serverUrl}`);
    console.log('='.repeat(50));
    
    // Test GET all pricing matrices
    const allRecords = await testGetPricingMatrix();
    
    // Test creating a new pricing matrix
    console.log('\nCreating a new pricing matrix record...');
    const createResponse = await testCreatePricingMatrix();
    
    // Extract the ID of the created pricing matrix
    let createdId;
    
    // Check if we got a proper response with the created record
    if (createResponse && createResponse.pricingMatrix && createResponse.pricingMatrix.Result) {
      // Handle the case where the response is nested under pricingMatrix
      if (Array.isArray(createResponse.pricingMatrix.Result) && createResponse.pricingMatrix.Result.length > 0) {
        createdId = createResponse.pricingMatrix.Result[0].PricingMatrixID;
      } else if (createResponse.pricingMatrix.Result.PricingMatrixID) {
        createdId = createResponse.pricingMatrix.Result.PricingMatrixID;
      }
    }
    
    if (!createdId) {
      console.log('Could not extract ID from created pricing matrix. Trying to get the latest record...');
      
      // If we couldn't extract the ID, get all records again and use the latest one
      const updatedRecords = await testGetPricingMatrix();
      
      if (updatedRecords && updatedRecords.length > allRecords.length) {
        // Find the new record that wasn't in the original list
        const newRecords = updatedRecords.filter(newRecord => 
          !allRecords.some(oldRecord => oldRecord.PricingMatrixID === newRecord.PricingMatrixID)
        );
        
        if (newRecords.length > 0) {
          createdId = newRecords[0].PricingMatrixID;
        }
      }
      
      // If we still don't have an ID, just use the first record
      if (!createdId && updatedRecords && updatedRecords.length > 0) {
        createdId = updatedRecords[0].PricingMatrixID;
      }
    }
    
    if (createdId) {
      console.log(`\nUsing pricing matrix with ID: ${createdId} for further tests`);
      
      // Test getting the created pricing matrix by ID
      await testGetPricingMatrixById(createdId);
      
      // Test updating the created pricing matrix
      await testUpdatePricingMatrix(createdId);
      
      // Test getting the updated pricing matrix
      await testGetPricingMatrixById(createdId);
      
      // Test deleting the pricing matrix
      await testDeletePricingMatrix(createdId);
      
      // Verify deletion
      try {
        await testGetPricingMatrixById(createdId);
        console.log(`\nWARNING: Record with ID ${createdId} still exists after deletion!`);
      } catch (error) {
        console.log(`\nSuccess: Record with ID ${createdId} was deleted successfully.`);
      }
    } else {
      console.warn('\nCould not extract ID from created pricing matrix. Skipping ID-specific tests.');
    }
    
    console.log('\nAll tests completed!');
  } catch (error) {
    console.error('\nError running tests:', error.message);
  }
}

// Run the tests
runTests();