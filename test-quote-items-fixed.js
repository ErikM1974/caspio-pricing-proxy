const axios = require('axios');

// Test configuration
const API_BASE_URL = 'https://caspio-pricing-proxy-ab30a049961a.herokuapp.com';

async function testQuoteItemsFixed() {
  console.log('=== Testing Quote_Items POST After Fix ===\n');
  console.log('Waiting for deployment to complete...\n');
  
  // Test data matching your original curl command
  const testData = {
    QuoteID: "fix-test-quote-" + Date.now(),
    LineNumber: 1,
    StyleNumber: "PC61",
    ProductName: "Essential Tee - Fixed",
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
    ImageURL: "https://example.com/test-fixed.jpg"
  };
  
  console.log('Sending test data:', JSON.stringify(testData, null, 2));
  
  try {
    const response = await axios.post(
      `${API_BASE_URL}/api/quote_items`,
      testData,
      {
        headers: { 'Content-Type': 'application/json' },
        timeout: 15000
      }
    );
    
    console.log('\n✅ SUCCESS! Quote item created after fix');
    console.log('Response status:', response.status);
    console.log('Response data:', JSON.stringify(response.data, null, 2));
    
    // Extract the PK_ID if available
    let pkId = null;
    if (response.data) {
      if (response.data.PK_ID) {
        pkId = response.data.PK_ID;
      } else if (response.headers.location) {
        // Extract from location header
        pkId = response.headers.location.split('/').pop();
      }
    }
    
    if (pkId) {
      console.log(`\nCreated quote item with PK_ID: ${pkId}`);
      
      // Try to retrieve it
      console.log('\nVerifying by retrieving the created item...');
      try {
        const getResponse = await axios.get(`${API_BASE_URL}/api/quote_items/${pkId}`);
        console.log('✅ Retrieved successfully:', JSON.stringify(getResponse.data, null, 2));
      } catch (getError) {
        console.log('⚠️  Could not retrieve the item, but POST was successful');
      }
    }
    
    console.log('\n🎉 The Quote_Items POST endpoint is now working correctly!');
    
  } catch (error) {
    console.log('\n❌ FAILED');
    
    if (error.response) {
      console.log('\nStatus:', error.response.status);
      console.log('\nError Response:', JSON.stringify(error.response.data, null, 2));
    } else {
      console.log('Network error:', error.message);
    }
    
    console.log('\nThe fix may not have been deployed yet. Wait a moment and try again.');
  }
}

// Wait a moment then run the test
console.log('Starting test in 10 seconds to allow deployment to complete...');
setTimeout(() => {
  testQuoteItemsFixed();
}, 10000);