// Test using our actual utilities
const { getCaspioAccessToken, fetchAllCaspioPages } = require('./src/utils/caspio');

async function testOurUtils() {
  try {
    console.log('1. Testing token retrieval...');
    const token = await getCaspioAccessToken();
    console.log('✓ Token retrieved successfully');
    
    console.log('\n2. Testing fetchAllCaspioPages with style search...');
    const whereClause = `STYLE LIKE '%LOG%'`;
    const records = await fetchAllCaspioPages('/tables/Sanmar_Bulk_251816_Feb2024/records', {
      'q.where': whereClause,
      'q.select': 'STYLE',
      'q.groupBy': 'STYLE',
      'q.limit': 20
    });
    
    console.log('✓ SUCCESS! Got', records.length, 'results');
    console.log('First few results:', records.slice(0, 3).map(r => r.STYLE));
    
  } catch (error) {
    console.error('✗ FAILED:', error.message);
    if (error.response) {
      console.error('Response status:', error.response.status);
      console.error('Response data:', error.response.data);
    }
  }
}

testOurUtils();