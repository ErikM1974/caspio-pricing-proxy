#!/usr/bin/env node

/**
 * Auto-Generate and Sync Postman Collection
 *
 * NEW APPROACH: Scans Express routes and auto-generates Postman collection
 * No more manual JSON construction - routes are discovered from actual code!
 *
 * Workflow:
 * 1. Scan all route files in src/routes/*.js
 * 2. Auto-generate Postman endpoints from discovered routes
 * 3. Intelligently merge with existing collection (preserves customizations)
 * 4. Sync to Postman API automatically
 *
 * Features:
 * - ✅ Auto-discovers endpoints from code
 * - ✅ No manual endpoint definitions needed
 * - ✅ Preserves custom descriptions and examples
 * - ✅ Detects new, updated, and removed endpoints
 * - ✅ Syncs to Postman API automatically
 */

const fs = require('fs').promises;
const path = require('path');
const colors = require('colors');
require('dotenv').config();

// Import our utilities
const RouteScanner = require('./route-scanner');
const PostmanGenerator = require('./postman-generator');
const CollectionDiffer = require('./collection-differ');
const PostmanAPIClient = require('./postman-api-client');

async function main() {
  console.log('\n🚀 NWCA API - Auto-Generate Postman Collection'.cyan.bold);
  console.log('='.repeat(60).gray);
  console.log('NEW: Automatically scans Express routes and generates collection\n'.yellow);

  try {
    // Step 1: Scan routes from code
    console.log('📝 Step 1: Scanning Express routes...'.cyan.bold);
    const scanner = new RouteScanner({ basePrefix: '/api' });
    const routesDir = path.join(__dirname, '../src/routes');
    const endpoints = await scanner.scanDirectory(routesDir);
    scanner.generateReport();

    // Save scanned routes for reference
    const scannedPath = path.join(__dirname, '../.cache/scanned-routes.json');
    await fs.mkdir(path.dirname(scannedPath), { recursive: true });
    await scanner.exportToJson(scannedPath);

    // Step 2: Generate Postman collection from routes
    console.log('📝 Step 2: Generating Postman collection...'.cyan.bold);
    const generator = new PostmanGenerator({
      collectionName: 'NWCA Production API - Complete',
      baseUrl: '{{baseUrl}}',
      description: 'Complete API collection for Northwest Custom Apparel. Auto-generated from Express routes.'
    });

    const generatedCollection = generator.generateCollection(endpoints);

    // Save generated collection for reference
    const generatedPath = path.join(__dirname, '../docs/NWCA-API.postman_collection.AUTO.json');
    await generator.exportToFile(generatedCollection, generatedPath);

    // Step 3: Merge with existing collection
    console.log('📝 Step 3: Merging with existing collection...'.cyan.bold);
    let existingCollection;
    const existingPath = path.join(__dirname, '../docs/NWCA-API.postman_collection.json');

    try {
      const existingContent = await fs.readFile(existingPath, 'utf8');
      existingCollection = JSON.parse(existingContent);
      console.log(`   Loaded existing collection: ${existingCollection.info.name}`.gray);
    } catch (error) {
      console.log('   No existing collection found, will use generated only'.yellow);
      existingCollection = null;
    }

    // --prune: also DELETE collection entries that no longer exist in code (except the
    // hand-added ones in scripts/postman-manual-endpoints.json). Opt-in, because the
    // default must never lose a manually curated request.
    const prune = process.argv.includes('--prune');
    if (prune) console.log('🗑  --prune: stale entries will be removed (manual list exempt)'.yellow);

    const differ = new CollectionDiffer({
      preserveDescriptions: true,
      preserveExamples: true,
      preserveQueryValues: true,
      prune
    });

    const mergedCollection = existingCollection
      ? differ.merge(existingCollection, generatedCollection)
      : generatedCollection;

    // Save merged collection
    const mergedPath = path.join(__dirname, '../docs/NWCA-API.postman_collection.json');
    await fs.writeFile(mergedPath, JSON.stringify(mergedCollection, null, '\t'));
    console.log(`\n💾 Saved merged collection to ${path.basename(mergedPath)}`.green);

    // Count endpoints
    let totalEndpoints = 0;
    mergedCollection.item.forEach(category => {
      if (category.item && Array.isArray(category.item)) {
        totalEndpoints += category.item.length;
      }
    });
    console.log(`📊 Total endpoints in collection: ${totalEndpoints}`.cyan);

    // Step 4: Sync with Postman API
    console.log('\n📝 Step 4: Syncing with Postman API...'.cyan.bold);
    await syncWithPostmanAPI(mergedCollection);

    console.log('\n' + '='.repeat(60).gray);
    console.log('✅ Collection update complete!'.green.bold);
    console.log('\n💡 Summary:'.cyan);
    console.log(`   - Scanned ${endpoints.length} endpoints from code`.white);
    console.log(`   - Generated Postman collection automatically`.white);
    console.log(`   - Merged with existing customizations`.white);
    console.log(`   - Synced to Postman API`.white);
    console.log('\n🎉 No manual JSON editing needed!\n'.green);

  } catch (error) {
    console.error('\n❌ Update failed:'.red.bold, error.message);
    console.error(error.stack);
    process.exit(1);
  }
}

/**
 * Sync collection with Postman API
 */
async function syncWithPostmanAPI(collection) {
  const apiKey = process.env.POSTMAN_API_KEY;
  const collectionId = process.env.POSTMAN_COLLECTION_ID;

  if (!apiKey || !collectionId || apiKey === 'your-postman-api-key-here') {
    console.log('\n⚠️  Postman API credentials not configured - skipping API sync'.yellow);
    console.log('💡 To enable automatic sync:'.cyan);
    console.log('   1. Get API key from https://postman.co/settings/me/api-keys'.gray);
    console.log('   2. Set POSTMAN_API_KEY in your .env file'.gray);
    console.log('   3. Run this script again for automatic sync'.gray);
    return false;
  }

  try {
    const client = new PostmanAPIClient(apiKey, collectionId);

    // Test connection first
    const connected = await client.testConnection();
    if (!connected) {
      throw new Error('Failed to connect to Postman API');
    }

    // Update the collection in Postman
    await client.updateCollection(collection);
    console.log('🎉 Successfully synced collection with Postman API!'.green);
    console.log('💫 No manual JSON import needed - changes are live!'.cyan);
    return true;
  } catch (error) {
    console.error('\n❌ Failed to sync with Postman API:'.red, error.message);
    console.log('⚠️  Local JSON file was still updated successfully'.yellow);
    console.log('📥 You can manually import the JSON file as a fallback'.gray);
    return false;
  }
}

// Run the script
main();
