// test-image-url.js - Test script to verify imageUrl handling in cart-items API
const axios = require('axios');

// API Base URL - Using the Heroku deployment
const API_BASE_URL = 'https://caspio-pricing-proxy-ab30a049961a.herokuapp.com';

// Generate a unique session ID for testing
const sessionId = `test_session_${Date.now()}`;

// Test data for creating a cart item with imageUrl
const cartItemData = {
    SessionID: sessionId,
    ProductID: 'TEST_PRODUCT',
    StyleNumber: 'TEST123',
    Color: 'Blue',
    ImprintType: 'test',
    CartStatus: 'Active',
    imageUrl: 'https://cdnm.sanmar.com/imglib/mresjpg/2014/f19/PC90H_purple_model_front_082010.jpg'
};

// Function to test the imageUrl handling in cart-items API
async function testImageUrlHandling() {
    try {
        console.log('=== CART ITEM IMAGE URL TEST ===');
        console.log(`Using session ID: ${sessionId}`);
        console.log(`Using image URL: ${cartItemData.imageUrl}`);
        
        // Step 1: Create a cart item with imageUrl
        console.log('\nStep 1: Creating a cart item with imageUrl...');
        const response = await axios.post(`${API_BASE_URL}/api/cart-items`, cartItemData);
        
        if (!response.data || !response.data.cartItem) {
            throw new Error('Failed to create cart item: Invalid response');
        }
        
        const cartItem = response.data.cartItem;
        const cartItemId = cartItem.CartItemID;
        
        console.log(`Cart item created with ID: ${cartItemId}`);
        console.log('Cart item data from response:', JSON.stringify(cartItem, null, 2));
        
        // Step 2: Verify the imageUrl was saved by retrieving the cart item
        console.log('\nStep 2: Retrieving the cart item to verify imageUrl was saved...');
        const getResponse = await axios.get(`${API_BASE_URL}/api/cart-items?sessionID=${sessionId}`);
        
        if (!getResponse.data || !Array.isArray(getResponse.data) || getResponse.data.length === 0) {
            throw new Error('Failed to retrieve cart items: Invalid response');
        }
        
        const retrievedCartItem = getResponse.data.find(item => item.CartItemID === cartItemId);
        
        if (!retrievedCartItem) {
            throw new Error(`Failed to find cart item with ID: ${cartItemId}`);
        }
        
        console.log('Retrieved cart item data:', JSON.stringify(retrievedCartItem, null, 2));
        
        // Step 3: Check if the imageUrl was saved correctly
        if (retrievedCartItem.imageUrl === cartItemData.imageUrl) {
            console.log('\n✅ SUCCESS: imageUrl was saved correctly');
        } else {
            console.log(`\n❌ FAILURE: imageUrl was not saved correctly`);
            console.log(`Expected: ${cartItemData.imageUrl}`);
            console.log(`Actual: ${retrievedCartItem.imageUrl}`);
        }
        
        return {
            success: retrievedCartItem.imageUrl === cartItemData.imageUrl,
            cartItemId,
            expectedImageUrl: cartItemData.imageUrl,
            actualImageUrl: retrievedCartItem.imageUrl
        };
    } catch (error) {
        console.error('Error in test:', error.message);
        if (error.response) {
            console.error('Response status:', error.response.status);
            console.error('Response data:', JSON.stringify(error.response.data, null, 2));
        }
        return {
            success: false,
            error: error.message
        };
    }
}

// Run the test
testImageUrlHandling()
    .then(result => {
        console.log('\nTest completed with result:', result);
        
        if (!result.success) {
            console.log('\n=== POTENTIAL ISSUES ===');
            console.log('1. The imageUrl field might not be properly defined in the Caspio Cart_Items table');
            console.log('2. The field name in Caspio might be different (e.g., ImageURL vs imageUrl)');
            console.log('3. There might be a case sensitivity issue with the field name');
            console.log('4. The server code might not be correctly mapping the field to the Caspio table');
            console.log('\n=== SUGGESTED FIXES ===');
            console.log('1. Check the Caspio Cart_Items table schema to confirm the imageUrl field exists and its exact name');
            console.log('2. Update the server.js code to ensure proper case matching for the field name');
            console.log('3. Add explicit logging in the server code to track the imageUrl field throughout the request lifecycle');
        }
    })
    .catch(err => {
        console.error('Test failed with error:', err);
    });