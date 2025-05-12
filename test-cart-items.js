// test-cart-items.js - Test script for /api/cart-items endpoint
const axios = require('axios');

// Define the base URL (adjust if needed)
const BASE_URL = 'http://localhost:3000';

async function testCartItemsEndpoint() {
  try {
    console.log('Testing /api/cart-items endpoint...');
    
    // Make a request to the cart items endpoint
    const response = await axios.get(`${BASE_URL}/api/cart-items`);
    
    // Check if we got a valid response
    if (response.status !== 200) {
      console.error(`Error: Unexpected status code ${response.status}`);
      return;
    }
    
    const cartItems = response.data;
    console.log(`Retrieved ${cartItems.length} cart items`);
    
    // Check if there are any items
    if (cartItems.length === 0) {
      console.log('No cart items found. Add items to the cart and try again.');
      return;
    }
    
    // Check the first item for PRODUCT_TITLE field
    const firstItem = cartItems[0];
    console.log('\nFirst cart item:');
    console.log(JSON.stringify(firstItem, null, 2));
    
    // Verify PRODUCT_TITLE field is present
    if ('PRODUCT_TITLE' in firstItem) {
      console.log('\n✅ SUCCESS: PRODUCT_TITLE field is present in cart items');
    } else {
      console.error('\n❌ ERROR: PRODUCT_TITLE field is missing from cart items');
    }
    
    // Check all required fields from the Swagger example
    const requiredFields = [
      'PK_ID', 'CartItemID', 'SessionID', 'ProductID', 'StyleNumber',
      'Color', 'ImprintType', 'DateAdded', 'CartStatus', 'OrderID',
      'imageUrl', 'PRODUCT_TITLE'
    ];
    
    const missingFields = requiredFields.filter(field => !(field in firstItem));
    
    if (missingFields.length === 0) {
      console.log('✅ SUCCESS: All required fields are present');
    } else {
      console.error(`❌ ERROR: Missing fields: ${missingFields.join(', ')}`);
    }
    
  } catch (error) {
    console.error('Error testing cart items endpoint:', error.message);
    if (error.response) {
      console.error('Response data:', error.response.data);
    }
  }
}

// Run the test
testCartItemsEndpoint();