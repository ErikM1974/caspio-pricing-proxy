const fs = require('fs');
const path = require('path');

const collectionPath = path.join(__dirname, '../docs/NWCA-API.postman_collection.json');
const collection = JSON.parse(fs.readFileSync(collectionPath, 'utf8'));

const manageOrdersFolder = collection.item.find(i => i.name === '📊 ManageOrders API');

console.log('ManageOrders API folder endpoints:\n');
manageOrdersFolder.item.forEach((endpoint, idx) => {
  const urlPath = endpoint.request?.url?.path?.join('/') || 'unknown';
  console.log(`  ${idx + 1}. ${endpoint.name}`);
  console.log(`     Path: /${urlPath}`);
  console.log('');
});

console.log(`Total: ${manageOrdersFolder.item.length} endpoints`);
