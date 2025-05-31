// test-cart-item-sizes.js - Test script to verify cart-item-sizes API behavior
const axios = require('axios');

// API Base URL - Using the Heroku deployment
const API_BASE_URL = 'https://caspio-pricing-proxy-ab30a049961a.herokuapp.com';

// Generate a unique session ID for testing
const sessionId = `test_session_${Date.now()}`;

// Test data for creating a cart item
const cartItemData = {
    SessionID: sessionId,
    ProductID: 'TEST_PRODUCT',
    StyleNumber: 'TEST123',
    Color: 'Blue',
    ImprintType: 'test',
    CartStatus: 'Active'
};

// Test data for creating cart item sizes
const sizeData1 = {
    Size: 'L',
    Quantity: 1,
    UnitPrice: 21.5
};

const sizeData2 = {
    Size: 'XL',
    Quantity: 1,
    UnitPrice: 22.0
};

// Function to test the cart-item-sizes API
async function testCartItemSizes() {
    try {
        console.log('=== CART ITEM SIZES API TEST ===');
        console.log(`Using session ID: ${sessionId}`);
        
        // Step 1: Create a cart item
        console.log('\nStep 1: Creating a cart item...');
        const cartItemResponse = await axios.post(`${API_BASE_URL}/api/cart-items`, cartItemData);
        
        if (!cartItemResponse.data || !cartItemResponse.data.cartItem || !cartItemResponse.data.cartItem.CartItemID) {
            throw new Error('Failed to create cart item: Invalid response');
        }
        
        const cartItemId = cartItemResponse.data.cartItem.CartItemID;
        console.log(`Cart item created with ID: ${cartItemId}`);
        console.log('Cart item data:', JSON.stringify(cartItemResponse.data.cartItem, null, 2));
        
        // Step 2: Create first size for the cart item
        console.log('\nStep 2: Creating first size (L) for the cart item...');
        const size1Data = {
            ...sizeData1,
            CartItemID: cartItemId
        };
        
        const size1Response = await axios.post(`${API_BASE_URL}/api/cart-item-sizes`, size1Data);
        console.log('Size 1 created:', JSON.stringify(size1Response.data, null, 2));
        
        // Step 3: Create second size for the cart item
        console.log('\nStep 3: Creating second size (XL) for the cart item...');
        const size2Data = {
            ...sizeData2,
            CartItemID: cartItemId
        };
        
        const size2Response = await axios.post(`${API_BASE_URL}/api/cart-item-sizes`, size2Data);
        console.log('Size 2 created:', JSON.stringify(size2Response.data, null, 2));
        
        // Step 4: Retrieve all sizes for the cart item
        console.log('\nStep 4: Retrieving all sizes for the cart item...');
        const getSizesResponse = await axios.get(`${API_BASE_URL}/api/cart-item-sizes?cartItemID=${cartItemId}`);
        
        console.log(`Retrieved ${getSizesResponse.data.length} sizes for cart item ${cartItemId}:`);
        console.log(JSON.stringify(getSizesResponse.data, null, 2));
        
        // Step 5: Verify that both sizes were retrieved
        if (getSizesResponse.data.length === 2) {
            console.log('\n✅ SUCCESS: Both sizes were retrieved correctly');
        } else {
            console.log(`\n❌ FAILURE: Expected 2 sizes, but got ${getSizesResponse.data.length}`);
        }
        
        // Step 6: Retrieve all sizes without a cartItemID parameter
        console.log('\nStep 6: Retrieving all sizes without a cartItemID parameter...');
        const getAllSizesResponse = await axios.get(`${API_BASE_URL}/api/cart-item-sizes`);
        
        console.log(`Retrieved ${getAllSizesResponse.data.length} total sizes from the database`);
        console.log('Sample of first 2 sizes:', JSON.stringify(getAllSizesResponse.data.slice(0, 2), null, 2));
        
        // Step 7: Check if our cart item sizes are included in the full list
        const foundSizes = getAllSizesResponse.data.filter(size => size.CartItemID === cartItemId);
        console.log(`\nFound ${foundSizes.length} sizes for cart item ${cartItemId} in the full list`);
        
        if (foundSizes.length === 2) {
            console.log('✅ SUCCESS: Both sizes were found in the full list');
        } else {
            console.log(`❌ FAILURE: Expected 2 sizes in the full list, but found ${foundSizes.length}`);
        }
        
        return {
            success: true,
            cartItemId,
            sizesCount: getSizesResponse.data.length
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
testCartItemSizes()
    .then(result => {
        console.log('\nTest completed with result:', result);
    })
    .catch(err => {
        console.error('Test failed with error:', err);
    });