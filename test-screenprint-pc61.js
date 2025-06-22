// Test script to verify pricing-bundle endpoint returns complete structure for PC61
const axios = require('axios');

// Configuration
const BASE_URL = process.env.API_URL || 'http://localhost:3000';

async function testScreenPrintPricingBundle() {
  console.log('Testing /api/pricing-bundle endpoint for ScreenPrint method with PC61...\n');

  try {
    // Test without styleNumber
    console.log('1. Testing without styleNumber:');
    const response1 = await axios.get(`${BASE_URL}/api/pricing-bundle?method=ScreenPrint`);
    console.log('Response structure:', Object.keys(response1.data));
    console.log('Expected keys present:', {
      tiersR: Array.isArray(response1.data.tiersR),
      rulesR: typeof response1.data.rulesR === 'object',
      locations: Array.isArray(response1.data.locations),
      allScreenprintCostsR: Array.isArray(response1.data.allScreenprintCostsR)
    });
    console.log('Data counts:', {
      tiers: response1.data.tiersR.length,
      rules: Object.keys(response1.data.rulesR).length,
      locations: response1.data.locations.length,
      costs: response1.data.allScreenprintCostsR.length
    });

    console.log('\n2. Testing with styleNumber=PC61:');
    const response2 = await axios.get(`${BASE_URL}/api/pricing-bundle?method=ScreenPrint&styleNumber=PC61`);
    console.log('Response structure:', Object.keys(response2.data));
    console.log('Expected keys present:', {
      tiersR: Array.isArray(response2.data.tiersR),
      rulesR: typeof response2.data.rulesR === 'object',
      locations: Array.isArray(response2.data.locations),
      allScreenprintCostsR: Array.isArray(response2.data.allScreenprintCostsR),
      sizes: Array.isArray(response2.data.sizes),
      sellingPriceDisplayAddOns: typeof response2.data.sellingPriceDisplayAddOns === 'object'
    });
    console.log('Data counts:', {
      tiers: response2.data.tiersR.length,
      rules: Object.keys(response2.data.rulesR).length,
      locations: response2.data.locations.length,
      costs: response2.data.allScreenprintCostsR.length,
      sizes: response2.data.sizes.length,
      upcharges: Object.keys(response2.data.sellingPriceDisplayAddOns).length
    });

    // Verify the exact structure required by Caspio
    console.log('\n3. Verifying required structure for Caspio:');
    const requiredKeys = ['tiersR', 'rulesR', 'locations', 'allScreenprintCostsR', 'sizes', 'sellingPriceDisplayAddOns'];
    const missingKeys = requiredKeys.filter(key => !(key in response2.data));
    
    if (missingKeys.length === 0) {
      console.log('✅ All required keys are present!');
      console.log('\nFull response structure:');
      console.log(JSON.stringify(response2.data, null, 2));
    } else {
      console.log('❌ Missing keys:', missingKeys);
    }

  } catch (error) {
    console.error('Error testing endpoint:', error.response ? error.response.data : error.message);
  }
}

// Run the test
testScreenPrintPricingBundle();