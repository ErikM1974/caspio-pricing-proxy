// test-pricing-matrix-crud.js - Test script for PricingMatrix CRUD operations

const axios = require('axios');

// Heroku URL for testing
const herokuUrl = 'https://caspio-pricing-proxy-ab30a049961a.herokuapp.com';

// Test data for creating a new pricing matrix
const testPricingMatrix = {
  SessionID: "test-session-" + Date.now(),
  StyleNumber: "PC61",
  Color: "NAVY",
  EmbellishmentType: "SCREENPRINT",
  TierStructure: "TEST TIER STRUCTURE",
  SizeGroups: "TEST SIZE GROUPS",
  PriceMatrix: "TEST PRICE MATRIX"
};

// Function to test GET /api/pricing-matrix
async function testGetPricingMatrix() {
  try {
    console.log('\nTesting GET /api/pricing-matrix');
    const response = await axios.get(`${herokuUrl}/api/pricing-matrix`);
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

// Function to test POST /api/pricing-matrix
async function testCreatePricingMatrix() {
  try {
    console.log('\nTesting POST /api/pricing-matrix');
    console.log(`Creating pricing matrix with data: ${JSON.stringify(testPricingMatrix)}`);
    const response = await axios.post(`${herokuUrl}/api/pricing-matrix`, testPricingMatrix);
    console.log(`Status: ${response.status}`);
    console.log(`Response data: ${JSON.stringify(response.data)}`);
    return response.data;
  } catch (error) {
    console.error('Error testing POST /api/pricing-matrix:', error.response ? error.response.data : error.message);
    throw error;
  }
}

// Function to test GET /api/pricing-matrix/:id
async function testGetPricingMatrixById(id) {
  try {
    console.log(`\nTesting GET /api/pricing-matrix/${id}`);
    const response = await axios.get(`${herokuUrl}/api/pricing-matrix/${id}`);
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
      TierStructure: "UPDATED TIER STRUCTURE",
      SizeGroups: "UPDATED SIZE GROUPS",
      PriceMatrix: "UPDATED PRICE MATRIX"
    };
    console.log(`Updating pricing matrix with data: ${JSON.stringify(updateData)}`);
    const response = await axios.put(`${herokuUrl}/api/pricing-matrix/${id}`, updateData);
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
    const response = await axios.delete(`${herokuUrl}/api/pricing-matrix/${id}`);
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
    console.log('Starting CRUD tests for PricingMatrix endpoints');
    console.log('='.repeat(50));
    
    // Test GET all pricing matrices
    await testGetPricingMatrix();
    
    // Test creating a new pricing matrix
    const createResponse = await testCreatePricingMatrix();
    
    // Extract the ID of the created pricing matrix
    let createdId;
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
      
      // If we couldn't extract the ID, get all records and use the latest one
      const allRecords = await testGetPricingMatrix();
      if (allRecords && allRecords.length > 0) {
        // Find the record with our test session ID
        const ourRecord = allRecords.find(record => record.SessionID === testPricingMatrix.SessionID);
        if (ourRecord) {
          createdId = ourRecord.PricingMatrixID;
        } else {
          // If we can't find our record, use the latest one
          createdId = allRecords[0].PricingMatrixID;
        }
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