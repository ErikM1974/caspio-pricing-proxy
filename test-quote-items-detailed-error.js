const axios = require('axios');

// Test configuration
const API_BASE_URL = 'https://caspio-pricing-proxy-ab30a049961a.herokuapp.com';

async function testWithDetailedError() {
  console.log('=== Testing Quote_Items POST with Enhanced Debugging ===\n');
  console.log('Waiting for Heroku deployment to complete...\n');
  
  // Simple test data
  const testData = {
    QuoteID: "debug-test-" + Date.now(),
    StyleNumber: "PC61",
    Quantity: 24
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
    
    console.log('\n✅ SUCCESS! Quote item created');
    console.log('Response:', JSON.stringify(response.data, null, 2));
    
  } catch (error) {
    console.log('\n❌ FAILED - But we got detailed error info:');
    
    if (error.response) {
      console.log('\nStatus:', error.response.status);
      console.log('\nError Response:', JSON.stringify(error.response.data, null, 2));
      
      // Check if we have the enhanced debug info
      if (error.response.data.debugInfo) {
        console.log('\n=== DEBUG INFO ===');
        console.log('Message:', error.response.data.debugInfo.message);
        console.log('Status:', error.response.data.debugInfo.status);
        console.log('Data:', JSON.stringify(error.response.data.debugInfo.data, null, 2));
      }
    } else {
      console.log('Network error:', error.message);
    }
  }
  
  console.log('\n\nNOTE: Check the Heroku logs for server-side debug output:');
  console.log('heroku logs --tail -a caspio-pricing-proxy');
}

// Wait a moment then run the test
console.log('Starting test in 5 seconds to allow deployment to complete...');
setTimeout(() => {
  testWithDetailedError();
}, 5000);