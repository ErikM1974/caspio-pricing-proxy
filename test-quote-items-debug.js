const axios = require('axios');

// Test configuration
const API_BASE_URL = 'https://caspio-pricing-proxy-ab30a049961a.herokuapp.com';

async function debugQuoteItemsPost() {
  console.log('=== Debugging Quote_Items POST Issue ===\n');
  
  // Test different variations to isolate the issue
  const testCases = [
    {
      name: "Minimal required fields only",
      data: {
        QuoteID: "debug-minimal-" + Date.now(),
        StyleNumber: "TEST",
        Quantity: 1
      }
    },
    {
      name: "With numeric fields as numbers",
      data: {
        QuoteID: "debug-numbers-" + Date.now(),
        StyleNumber: "PC61",
        Quantity: 24,
        LineNumber: 1,
        BaseUnitPrice: 15.99,
        FinalUnitPrice: 15.99,
        LineTotal: 383.76
      }
    },
    {
      name: "With all text fields",
      data: {
        QuoteID: "debug-text-" + Date.now(),
        StyleNumber: "PC61",
        ProductName: "Test Product",
        Color: "Black",
        ColorCode: "BLACK",
        Quantity: 24
      }
    },
    {
      name: "Full data without SizeBreakdown",
      data: {
        QuoteID: "debug-full-" + Date.now(),
        LineNumber: 1,
        StyleNumber: "PC61",
        ProductName: "Essential Tee - Debug",
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
        PricingTier: "24-47",
        ImageURL: "https://example.com/test.jpg"
      }
    }
  ];
  
  for (const testCase of testCases) {
    console.log(`\nTest: ${testCase.name}`);
    console.log('Data:', JSON.stringify(testCase.data, null, 2));
    
    try {
      const response = await axios.post(
        `${API_BASE_URL}/api/quote_items`,
        testCase.data,
        {
          headers: { 'Content-Type': 'application/json' },
          timeout: 10000
        }
      );
      
      console.log('✅ SUCCESS!');
      console.log('Response:', JSON.stringify(response.data, null, 2));
      
      // If successful, try to retrieve it
      if (response.data.PK_ID) {
        const getResponse = await axios.get(`${API_BASE_URL}/api/quote_items/${response.data.PK_ID}`);
        console.log('Retrieved record:', JSON.stringify(getResponse.data, null, 2));
      }
      
      break; // Stop on first success
      
    } catch (error) {
      console.log('❌ FAILED');
      if (error.response) {
        console.log('Status:', error.response.status);
        console.log('Error:', error.response.data);
      } else {
        console.log('Error:', error.message);
      }
    }
  }
  
  console.log('\n\nDiagnostic Summary:');
  console.log('1. Check Heroku logs for detailed Caspio error messages');
  console.log('2. The issue might be related to:');
  console.log('   - Field data types (ensure numbers are sent as numbers, not strings)');
  console.log('   - Missing required fields in Caspio');
  console.log('   - Field validation rules in Caspio');
  console.log('   - The empty record (PK_ID: 9) might indicate a previous failed insert');
}

// Run the debug
debugQuoteItemsPost();