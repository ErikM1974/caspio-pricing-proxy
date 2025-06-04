const axios = require('axios');

// Test configuration
const API_BASE_URL = 'https://caspio-pricing-proxy-ab30a049961a.herokuapp.com';
const TEST_QUOTE_ID = `test-quote-${Date.now()}`;

// Test data for creating a quote item
const testQuoteItem = {
  QuoteID: TEST_QUOTE_ID,
  LineNumber: 1,
  StyleNumber: "PC61",
  ProductName: "Essential Tee - Test",
  Color: "Black",
  ColorCode: "BLACK",
  EmbellishmentType: "dtg",
  PrintLocation: "FF",
  PrintLocationName: "Full Front",
  Quantity: 24,
  HasLTM: "No",
  BaseUnitPrice: 15.99,
  LTMPerUnit: 0,
  FinalUnitPrice: 15.99,
  LineTotal: 383.76,
  SizeBreakdown: JSON.stringify({"S":6,"M":6,"L":6,"XL":6}),
  PricingTier: "24-47",
  ImageURL: "https://example.com/test-image.jpg"
};

async function testQuoteItemsEndpoint() {
  console.log('=== Testing Quote Items POST Endpoint ===\n');
  
  try {
    // Test 1: Create a new quote item
    console.log('Test 1: Creating a new quote item...');
    console.log('Request data:', JSON.stringify(testQuoteItem, null, 2));
    
    const createResponse = await axios.post(
      `${API_BASE_URL}/api/quote_items`,
      testQuoteItem,
      {
        headers: { 'Content-Type': 'application/json' }
      }
    );
    
    console.log('✅ POST successful!');
    console.log('Response status:', createResponse.status);
    console.log('Response data:', JSON.stringify(createResponse.data, null, 2));
    
    // Extract the created item ID
    const createdId = createResponse.data.PK_ID;
    console.log(`\nCreated quote item with PK_ID: ${createdId}`);
    
    // Test 2: Retrieve the created item
    console.log('\nTest 2: Retrieving the created quote item...');
    const getResponse = await axios.get(`${API_BASE_URL}/api/quote_items/${createdId}`);
    
    console.log('✅ GET successful!');
    console.log('Retrieved item:', JSON.stringify(getResponse.data, null, 2));
    
    // Test 3: Update the item
    console.log('\nTest 3: Updating the quote item...');
    const updateData = {
      Quantity: 48,
      LineTotal: 767.52,
      PricingTier: "48-71"
    };
    
    const updateResponse = await axios.put(
      `${API_BASE_URL}/api/quote_items/${createdId}`,
      updateData,
      {
        headers: { 'Content-Type': 'application/json' }
      }
    );
    
    console.log('✅ PUT successful!');
    console.log('Update response:', JSON.stringify(updateResponse.data, null, 2));
    
    // Test 4: Delete the test item
    console.log('\nTest 4: Deleting the test quote item...');
    const deleteResponse = await axios.delete(`${API_BASE_URL}/api/quote_items/${createdId}`);
    
    console.log('✅ DELETE successful!');
    console.log('Delete response:', JSON.stringify(deleteResponse.data, null, 2));
    
    console.log('\n🎉 All tests passed! The Quote Items endpoint is working correctly.');
    
  } catch (error) {
    console.error('\n❌ Test failed!');
    console.error('Error:', error.message);
    if (error.response) {
      console.error('Response status:', error.response.status);
      console.error('Response data:', JSON.stringify(error.response.data, null, 2));
    }
  }
}

// Run the test
console.log('Starting Quote Items endpoint test...\n');
testQuoteItemsEndpoint();