// test-pricing-matrix.js - Test script for PricingMatrix endpoints

require('dotenv').config(); // Load environment variables from .env file

const axios = require('axios');

// Base URL for the API
// Use environment variable if set, otherwise try local server first, then fall back to Heroku
const baseUrl = process.env.API_BASE_URL ||
                'http://localhost:3000';

// Heroku URL for testing if local server is not available
const herokuUrl = 'https://caspio-pricing-proxy-ab30a049961a.herokuapp.com';

// Function to check if a server is available
async function isServerAvailable(url) {
  try {
    const response = await axios.get(`${url}/status`, { timeout: 3000 });
    return response.status === 200;
  } catch (error) {
    return false;
  }
}

// Function to determine which server to use
async function getServerUrl() {
  // First try the local server
  console.log(`Checking if local server is available at ${baseUrl}...`);
  const isLocalAvailable = await isServerAvailable(baseUrl);
  
  if (isLocalAvailable) {
    console.log(`Using local server at ${baseUrl}`);
    return baseUrl;
  }
  
  // If local server is not available, try Heroku
  console.log(`Local server not available. Trying Heroku at ${herokuUrl}...`);
  const isHerokuAvailable = await isServerAvailable(herokuUrl);
  
  if (isHerokuAvailable) {
    console.log(`Using Heroku server at ${herokuUrl}`);
    return herokuUrl;
  }
  
  // If neither is available, default to local and let the tests fail
  console.log(`Neither local nor Heroku server is available. Defaulting to ${baseUrl}`);
  return baseUrl;
}

// Test data for creating a new pricing matrix
const testPricingMatrix = {
  SessionID: "test-session-" + Date.now(),
  StyleNumber: "PC61",
  Color: "BLACK",
  EmbellishmentType: "EMBROIDERY",
  TierStructure: "TEST TIER STRUCTURE",
  SizeGroups: "TEST SIZE GROUPS",
  PriceMatrix: "TEST PRICE MATRIX"
};

// Function to test GET /api/pricing-matrix
async function testGetPricingMatrix() {
  try {
    console.log('Testing GET /api/pricing-matrix');
    const response = await axios.get(`${baseUrl}/api/pricing-matrix`);
    console.log(`Status: ${response.status}`);
    console.log(`Found ${response.data.length} pricing matrix records`);
    console.log('Sample data:', response.data.slice(0, 1));
    return response.data;
  } catch (error) {
    console.error('Error testing GET /api/pricing-matrix:', error.response ? error.response.data : error.message);
    throw error;
  }
}

// Function to test POST /api/pricing-matrix
async function testCreatePricingMatrix() {
  try {
    console.log('Testing POST /api/pricing-matrix');
    console.log('Creating pricing matrix with data:', testPricingMatrix);
    const response = await axios.post(`${baseUrl}/api/pricing-matrix`, testPricingMatrix);
    console.log(`Status: ${response.status}`);
    console.log('Created pricing matrix:', response.data);
    return response.data.pricingMatrix;
  } catch (error) {
    console.error('Error testing POST /api/pricing-matrix:', error.response ? error.response.data : error.message);
    throw error;
  }
}

// Function to test GET /api/pricing-matrix/:id
async function testGetPricingMatrixById(id) {
  try {
    console.log(`Testing GET /api/pricing-matrix/${id}`);
    const response = await axios.get(`${baseUrl}/api/pricing-matrix/${id}`);
    console.log(`Status: ${response.status}`);
    console.log('Retrieved pricing matrix:', response.data);
    return response.data;
  } catch (error) {
    console.error(`Error testing GET /api/pricing-matrix/${id}:`, error.response ? error.response.data : error.message);
    throw error;
  }
}

// Function to test PUT /api/pricing-matrix/:id
async function testUpdatePricingMatrix(id) {
  try {
    console.log(`Testing PUT /api/pricing-matrix/${id}`);
    const updateData = {
      TierStructure: "UPDATED TIER STRUCTURE",
      SizeGroups: "UPDATED SIZE GROUPS",
      PriceMatrix: "UPDATED PRICE MATRIX"
    };
    console.log('Updating pricing matrix with data:', updateData);
    const response = await axios.put(`${baseUrl}/api/pricing-matrix/${id}`, updateData);
    console.log(`Status: ${response.status}`);
    console.log('Updated pricing matrix:', response.data);
    return response.data;
  } catch (error) {
    console.error(`Error testing PUT /api/pricing-matrix/${id}:`, error.response ? error.response.data : error.message);
    throw error;
  }
}

// Function to test DELETE /api/pricing-matrix/:id
async function testDeletePricingMatrix(id) {
  try {
    console.log(`Testing DELETE /api/pricing-matrix/${id}`);
    const response = await axios.delete(`${baseUrl}/api/pricing-matrix/${id}`);
    console.log(`Status: ${response.status}`);
    console.log('Delete response:', response.data);
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
    const serverUrl = await getServerUrl();
    
    // Update the baseUrl with the available server
    global.baseUrl = serverUrl;
    
    console.log(`\nStarting tests against ${serverUrl}`);
    console.log('='.repeat(50));
    
    // Test GET all pricing matrices
    await testGetPricingMatrix();

    // Test creating a new pricing matrix
    const createdMatrix = await testCreatePricingMatrix();
    
    // Extract the ID of the created pricing matrix
    // The structure might vary depending on the Caspio API response
    let createdId;
    if (createdMatrix && createdMatrix.Result && createdMatrix.Result.length > 0) {
      createdId = createdMatrix.Result[0].PricingMatrixID;
    } else if (createdMatrix && createdMatrix.PricingMatrixID) {
      createdId = createdMatrix.PricingMatrixID;
    } else if (createdMatrix && createdMatrix.pricingMatrix && createdMatrix.pricingMatrix.Result) {
      // Handle the case where the response is nested under pricingMatrix
      if (Array.isArray(createdMatrix.pricingMatrix.Result) && createdMatrix.pricingMatrix.Result.length > 0) {
        createdId = createdMatrix.pricingMatrix.Result[0].PricingMatrixID;
      } else if (createdMatrix.pricingMatrix.Result.PricingMatrixID) {
        createdId = createdMatrix.pricingMatrix.Result.PricingMatrixID;
      }
    }
    
    if (createdId) {
      console.log(`Created pricing matrix with ID: ${createdId}`);
      console.log('-'.repeat(50));
      
      // Test getting the created pricing matrix by ID
      await testGetPricingMatrixById(createdId);
      console.log('-'.repeat(50));
      
      // Test updating the created pricing matrix
      await testUpdatePricingMatrix(createdId);
      console.log('-'.repeat(50));
      
      // Test getting the updated pricing matrix
      await testGetPricingMatrixById(createdId);
      console.log('-'.repeat(50));
      
      // Test deleting the pricing matrix
      await testDeletePricingMatrix(createdId);
    } else {
      console.warn('Could not extract ID from created pricing matrix. Skipping ID-specific tests.');
    }
    
    console.log('\nAll tests completed successfully!');
  } catch (error) {
    console.error('Error running tests:', error.message);
  }
}

// Run the tests
runTests();