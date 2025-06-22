// Test to verify the exact structure required by Caspio
const axios = require('axios');

const BASE_URL = process.env.API_URL || 'http://localhost:3000';

async function testEmptyResponse() {
  console.log('Testing pricing-bundle endpoint for complete structure...\n');

  try {
    // Test case 1: With non-existent style
    const response = await axios.get(`${BASE_URL}/api/pricing-bundle?method=ScreenPrint&styleNumber=DOESNOTEXIST`);
    
    console.log('Response structure for non-existent style:');
    console.log(JSON.stringify(response.data, null, 2));
    
    // Verify exact structure required by Caspio
    const requiredStructure = {
      tiersR: Array.isArray(response.data.tiersR),
      rulesR: typeof response.data.rulesR === 'object' && !Array.isArray(response.data.rulesR),
      locations: Array.isArray(response.data.locations),
      allScreenprintCostsR: Array.isArray(response.data.allScreenprintCostsR),
      sizes: Array.isArray(response.data.sizes),
      sellingPriceDisplayAddOns: typeof response.data.sellingPriceDisplayAddOns === 'object' && !Array.isArray(response.data.sellingPriceDisplayAddOns)
    };
    
    console.log('\nStructure validation:');
    Object.entries(requiredStructure).forEach(([key, isValid]) => {
      console.log(`${key}: ${isValid ? '✅' : '❌'}`);
    });
    
    const allValid = Object.values(requiredStructure).every(v => v === true);
    console.log(`\nAll required fields present with correct types: ${allValid ? '✅ YES' : '❌ NO'}`);
    
  } catch (error) {
    console.error('Error:', error.response ? error.response.data : error.message);
  }
}

testEmptyResponse();