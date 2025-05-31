// Get a sample record to see available columns
const { fetchAllCaspioPages } = require('./src/utils/caspio');

async function getAvailableColumns() {
  console.log('Getting a sample record to see available columns...\n');
  
  try {
    // Get just one record with STYLE 4500
    const records = await fetchAllCaspioPages('/tables/Sanmar_Bulk_251816_Feb2024/records', {
      'q.where': "STYLE='4500'",
      'q.limit': 1
    });
    
    if (records.length > 0) {
      console.log('✓ Found a record! Available columns:');
      const columns = Object.keys(records[0]);
      columns.sort();
      columns.forEach(col => {
        const value = records[0][col];
        const preview = value ? String(value).substring(0, 50) : 'null';
        console.log(`  - ${col}: ${preview}`);
      });
      
      console.log('\n Total columns:', columns.length);
    } else {
      console.log('No records found for STYLE 4500');
    }
  } catch (error) {
    console.log('✗ FAILED:', error.message);
  }
}

getAvailableColumns();