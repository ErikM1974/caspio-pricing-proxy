// Test to see exact URL being built
const config = require('./src/config');

console.log('Config check:');
console.log('Domain:', config.caspio.domain);
console.log('API Base URL:', config.caspio.apiBaseUrl);

// Simulate what fetchAllCaspioPages does
const resourcePath = '/tables/Sanmar_Bulk_251816_Feb2024/records';
const fullUrl = `${config.caspio.apiBaseUrl}${resourcePath}`;

console.log('\nFull URL that would be called:', fullUrl);
console.log('\nExpected URL:', `https://c3eku948.caspio.com/integrations/rest/v3/tables/Sanmar_Bulk_251816_Feb2024/records`);