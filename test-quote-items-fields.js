const axios = require('axios');

// Test configuration
const API_BASE_URL = 'https://caspio-pricing-proxy-ab30a049961a.herokuapp.com';

async function checkQuoteItemsTable() {
  console.log('=== Checking Quote_Items Table Structure ===\n');
  
  try {
    // First, let's try to get any existing records to see the field structure
    console.log('Fetching existing Quote_Items records to check field structure...');
    const response = await axios.get(`${API_BASE_URL}/api/quote_items?q.limit=1`);
    
    if (response.data && response.data.length > 0) {
      console.log('\nSample record structure:');
      const sampleRecord = response.data[0];
      console.log('Fields found:', Object.keys(sampleRecord));
      console.log('\nFull sample record:');
      console.log(JSON.stringify(sampleRecord, null, 2));
    } else {
      console.log('No existing records found in Quote_Items table.');
    }
    
    // Now let's try a minimal POST with only required fields
    console.log('\n\nTesting minimal POST with only required fields...');
    const minimalData = {
      QuoteID: "minimal-test-" + Date.now(),
      StyleNumber: "TEST123",
      Quantity: 1
    };
    
    console.log('Sending minimal data:', JSON.stringify(minimalData, null, 2));
    
    try {
      const postResponse = await axios.post(
        `${API_BASE_URL}/api/quote_items`,
        minimalData,
        {
          headers: { 'Content-Type': 'application/json' }
        }
      );
      console.log('✅ Minimal POST successful!');
      console.log('Response:', JSON.stringify(postResponse.data, null, 2));
    } catch (postError) {
      console.log('❌ Minimal POST failed');
      if (postError.response) {
        console.log('Error status:', postError.response.status);
        console.log('Error data:', JSON.stringify(postError.response.data, null, 2));
      }
    }
    
    // Let's also check what happens when we send all fields
    console.log('\n\nChecking server logs for more details...');
    console.log('The server should be logging the actual Caspio error.');
    console.log('Check your Heroku logs with: heroku logs --tail -a caspio-pricing-proxy');
    
  } catch (error) {
    console.error('Error checking table:', error.message);
    if (error.response) {
      console.error('Response:', error.response.data);
    }
  }
}

// Run the check
checkQuoteItemsTable();