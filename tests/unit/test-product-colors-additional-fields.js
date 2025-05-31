// Test script to verify additional fields in /api/product-colors endpoint
const axios = require('axios');

const styleNumber = 'PC61'; // Use a style number that we know exists
const baseUrl = 'http://localhost:3000'; // Adjust if your server is running on a different port

async function testProductColorsEndpoint() {
  try {
    console.log(`Testing /api/product-colors endpoint for style: ${styleNumber}`);
    
    // Make the request to the endpoint
    const response = await axios.get(`${baseUrl}/api/product-colors?styleNumber=${styleNumber}`);
    
    // Check if the response is successful
    if (response.status !== 200) {
      console.error(`Error: Received status code ${response.status}`);
      return;
    }
    
    console.log(`STATUS: ${response.status}`);
    console.log(`Product Title: ${response.data.productTitle}`);
    console.log(`Number of colors: ${response.data.colors.length}`);
    console.log('\n');
    
    // Check if we have at least one color
    if (response.data.colors.length === 0) {
      console.error('Error: No colors found in the response');
      return;
    }
    
    // Check the first color for the additional fields
    const firstColor = response.data.colors[0];
    console.log(`Checking additional fields for color: ${firstColor.COLOR_NAME}`);
    
    // Check for the additional fields
    const additionalFields = [
      'DECORATION_SPEC_SHEET',
      'BRAND_LOGO_IMAGE',
      'SPEC_SHEET'
    ];
    
    let allFieldsPresent = true;
    
    for (const field of additionalFields) {
      if (firstColor[field] !== undefined) {
        console.log(`✅ ${field}: ${firstColor[field]}`);
      } else {
        console.error(`❌ ${field} is missing`);
        allFieldsPresent = false;
      }
    }
    
    if (allFieldsPresent) {
      console.log('\n✅ All additional fields are present in the response');
    } else {
      console.error('\n❌ Some additional fields are missing in the response');
    }
    
  } catch (error) {
    console.error('Error making request:', error.message);
    if (error.response) {
      console.error('Response data:', error.response.data);
    }
  }
}

// Run the test
testProductColorsEndpoint();