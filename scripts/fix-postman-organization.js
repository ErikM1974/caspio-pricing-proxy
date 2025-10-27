#!/usr/bin/env node

/**
 * Fix Postman Collection Organization
 *
 * Moves ManageOrders endpoints from "General" folder to "ManageOrders API" folder
 * Removes duplicates and organizes properly
 */

const fs = require('fs');
const path = require('path');

const collectionPath = path.join(__dirname, '../docs/NWCA-API.postman_collection.json');

console.log('🔧 Fixing Postman collection organization...\n');

// Read the collection
const collection = JSON.parse(fs.readFileSync(collectionPath, 'utf8'));

// Find folders
const generalFolderIdx = collection.item.findIndex(i => i.name === '📋 General');
const manageOrdersFolderIdx = collection.item.findIndex(i => i.name === '📊 ManageOrders API');

if (generalFolderIdx === -1) {
  console.log('⚠️  No "General" folder found - nothing to move');
  process.exit(0);
}

if (manageOrdersFolderIdx === -1) {
  console.error('❌ ManageOrders API folder not found!');
  process.exit(1);
}

const generalFolder = collection.item[generalFolderIdx];
const manageOrdersFolder = collection.item[manageOrdersFolderIdx];

// Find all ManageOrders endpoints in General folder
const manageOrdersEndpoints = [];
const otherEndpoints = [];

generalFolder.item.forEach(endpoint => {
  if (endpoint.name.toLowerCase().includes('manageorders')) {
    manageOrdersEndpoints.push(endpoint);
  } else {
    otherEndpoints.push(endpoint);
  }
});

console.log(`📋 Found ${manageOrdersEndpoints.length} ManageOrders endpoints in General folder`);
console.log(`📋 Found ${manageOrdersFolder.item.length} endpoints in ManageOrders API folder`);

// Get endpoint names that already exist in ManageOrders API folder
const existingNames = new Set(
  manageOrdersFolder.item.map(e => e.request?.url?.path?.join('/') || '')
);

// Filter out duplicates (Customers and Cache Info are already in ManageOrders folder)
const endpointsToMove = manageOrdersEndpoints.filter(endpoint => {
  const path = endpoint.request?.url?.path?.join('/') || '';
  const isDuplicate = existingNames.has(path);

  if (isDuplicate) {
    console.log(`  ⏭️  Skipping duplicate: ${endpoint.name}`);
    return false;
  }

  return true;
});

console.log(`\n✨ Moving ${endpointsToMove.length} new endpoints to ManageOrders API folder:\n`);

endpointsToMove.forEach(endpoint => {
  console.log(`   → ${endpoint.name}`);
});

// Move the new endpoints to ManageOrders API folder
// Add after "Get Cache Info" (index 2)
const insertIndex = 3; // After Sign In, Customers, Cache Info
manageOrdersFolder.item.splice(insertIndex, 0, ...endpointsToMove);

// Update General folder to only contain non-ManageOrders endpoints
generalFolder.item = otherEndpoints;

// If General folder is now empty, remove it
if (generalFolder.item.length === 0) {
  console.log('\n🗑️  General folder is now empty - removing it');
  collection.item.splice(generalFolderIdx, 1);
}

// Write back to file
fs.writeFileSync(collectionPath, JSON.stringify(collection, null, '\t'));

console.log(`\n✅ Collection updated successfully!`);
console.log(`📊 ManageOrders API folder now has ${manageOrdersFolder.item.length} endpoints`);

if (generalFolder.item.length > 0) {
  console.log(`📋 General folder now has ${generalFolder.item.length} endpoints`);
}

console.log('\n💡 Next step: Sync to Postman API with npm run update-postman\n');
