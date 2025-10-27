#!/usr/bin/env node

/**
 * Rename ManageOrders Endpoints
 *
 * Gives descriptive names to the auto-generated ManageOrders endpoints
 */

const fs = require('fs');
const path = require('path');

const collectionPath = path.join(__dirname, '../docs/NWCA-API.postman_collection.json');

console.log('✏️  Renaming ManageOrders endpoints...\n');

// Read the collection
const collection = JSON.parse(fs.readFileSync(collectionPath, 'utf8'));

// Find ManageOrders API folder
const manageOrdersFolder = collection.item.find(i => i.name === '📊 ManageOrders API');

if (!manageOrdersFolder) {
  console.error('❌ ManageOrders API folder not found!');
  process.exit(1);
}

// Mapping of paths to descriptive names
const nameMapping = {
  '/api/manageorders/orders': 'Get Orders (by Date Range)',
  '/api/manageorders/orders/:order_no': 'Get Order (by Order Number)',
  '/api/manageorders/getorderno/:ext_order_id': 'Get Order Number (by External ID)',
  '/api/manageorders/lineitems/:order_no': 'Get Line Items (for Order)',
  '/api/manageorders/payments': 'Get Payments (by Date Range)',
  '/api/manageorders/payments/:order_no': 'Get Payments (for Order)',
  '/api/manageorders/tracking': 'Get Tracking (by Date Range)',
  '/api/manageorders/tracking/:order_no': 'Get Tracking (for Order)',
  '/api/manageorders/inventorylevels': 'Get Inventory Levels'
};

let renamedCount = 0;

manageOrdersFolder.item.forEach(endpoint => {
  const urlPath = endpoint.request?.url?.path?.join('/') || '';
  const newName = nameMapping['/' + urlPath];

  if (newName && endpoint.name !== newName) {
    console.log(`  ✏️  ${endpoint.name}`);
    console.log(`     → ${newName}\n`);
    endpoint.name = newName;
    renamedCount++;
  }
});

// Write back to file
fs.writeFileSync(collectionPath, JSON.stringify(collection, null, '\t'));

console.log(`✅ Renamed ${renamedCount} endpoints`);
console.log(`📊 ManageOrders API folder now has ${manageOrdersFolder.item.length} endpoints with descriptive names\n`);
