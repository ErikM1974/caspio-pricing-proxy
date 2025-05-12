// test-cart-items-simple.js - Simple test for /api/cart-items endpoint
const axios = require('axios');

// Define the base URL
const BASE_URL = 'http://localhost:3000';

async function testCartItemsEndpoint() {
  try {
    console.log('Testing /api/cart-items endpoint for existing fields...');
    
    // Make a request to the cart items endpoint
    const response = await axios.get(`${BASE_URL}/api/cart-items?limit=1`);
    
    // Log the full response for inspection
    console.log('Response status:', response.status);
    console.log('Response data:');
    console.log(JSON.stringify(response.data, null, 2));
    
    // If we got items, check the first one for fields
    if (response.data && response.data.length > 0) {
      const firstItem = response.data[0];
      console.log('\nFields in the first cart item:');
      Object.keys(firstItem).forEach(key => {
        console.log(`- ${key}: ${firstItem[key]}`);
      });
      
      // Check specifically for PRODUCT_TITLE
      if ('PRODUCT_TITLE' in firstItem) {
        console.log('\nPRODUCT_TITLE field already exists in the response');
      } else {
        console.log('\nPRODUCT_TITLE field is NOT present in the response');
      }
    } else {
      console.log('No cart items found in the response');
    }
    
  } catch (error) {
    console.error('Error testing cart items endpoint:', error.message);
    if (error.response) {
      console.error('Response status:', error.response.status);
    }
    if (error.code === 'ECONNREFUSED') {
      console.error('Could not connect to the server. Is it running?');
    }
  }
}

// Run the test
testCartItemsEndpoint();