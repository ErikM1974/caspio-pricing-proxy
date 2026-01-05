#!/usr/bin/env node

/**
 * Test script for new products endpoints
 * Tests the three new endpoints:
 * 1. POST /api/admin/products/add-isnew-field
 * 2. POST /api/admin/products/mark-as-new
 * 3. GET /api/products/new
 */

const axios = require('axios');

// Configure base URL (change to your WSL IP if testing locally)
const BASE_URL = process.env.BASE_URL || 'http://localhost:3002';

// 15 products from the specification
const PRODUCTS_TO_MARK = [
  'EB120',  // Eddie Bauer Adventurer 1/4-Zip
  'EB121',  // Eddie Bauer Full-Zip Fleece Jacket
  'EB122',  // Eddie Bauer Hooded Full-Zip Fleece
  'EB123',  // Eddie Bauer Ladies Adventurer 1/4-Zip
  'EB124',  // Eddie Bauer Ladies Full-Zip Fleece Jacket
  'EB125',  // Eddie Bauer Ladies Hooded Full-Zip Fleece
  'EB130',  // Eddie Bauer Fleece Vest
  'EB131',  // Eddie Bauer Ladies Fleece Vest
  'OG734',  // OGIO Gauge Polo
  'OG735',  // OGIO Ladies Gauge Polo
  'PC54',   // Port & Company Core Cotton Tee
  'PC55',   // Port & Company Core Cotton Long Sleeve Tee
  'LPC54',  // Port & Company Ladies Core Cotton Tee
  'ST350', // Sport-Tek PosiCharge Competitor Tee
  'LST350' // Sport-Tek Ladies PosiCharge Competitor Tee
];

// Color codes
const colors = {
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  reset: '\x1b[0m'
};

function log(message, color = 'reset') {
  console.log(`${colors[color]}${message}${colors.reset}`);
}

function logSection(title) {
  console.log('\n' + '='.repeat(60));
  log(title, 'blue');
  console.log('='.repeat(60));
}

async function test1_AddIsNewField() {
  logSection('TEST 1: Add IsNew Field');

  try {
    const response = await axios.post(`${BASE_URL}/api/admin/products/add-isnew-field`);

    log(`✓ Status: ${response.status}`, 'green');
    log(`✓ Response: ${JSON.stringify(response.data, null, 2)}`, 'green');

    if (response.data.alreadyExists) {
      log('  → Field already exists (expected on second run)', 'yellow');
    } else {
      log('  → Field created successfully', 'green');
    }

    return true;
  } catch (error) {
    log(`✗ Error: ${error.response?.data?.message || error.message}`, 'red');
    return false;
  }
}

async function test2_MarkProductsAsNew() {
  logSection('TEST 2: Mark Products as New');

  try {
    const response = await axios.post(`${BASE_URL}/api/admin/products/mark-as-new`, {
      styles: PRODUCTS_TO_MARK
    });

    log(`✓ Status: ${response.status}`, 'green');
    log(`✓ Response: ${JSON.stringify(response.data, null, 2)}`, 'green');
    log(`  → Marked ${response.data.recordsAffected} records across ${response.data.styleCount} styles`, 'green');

    return true;
  } catch (error) {
    log(`✗ Error: ${error.response?.data?.message || error.message}`, 'red');
    return false;
  }
}

async function test3_QueryNewProducts() {
  logSection('TEST 3: Query New Products');

  try {
    // Test 1: Get all new products (default limit)
    log('\n3a. Get all new products (default limit):', 'blue');
    const response1 = await axios.get(`${BASE_URL}/api/products/new`);
    log(`✓ Status: ${response1.status}`, 'green');
    log(`✓ Found ${response1.data.count} new products`, 'green');
    log(`✓ Cached: ${response1.data.cached}`, 'green');

    if (response1.data.count > 0) {
      const sample = response1.data.products[0];
      log(`✓ Sample product: ${sample.STYLE} - ${sample.PRODUCT_TITLE}`, 'green');
    }

    // Test 2: Get new products with limit
    log('\n3b. Get new products with limit=5:', 'blue');
    const response2 = await axios.get(`${BASE_URL}/api/products/new?limit=5`);
    log(`✓ Status: ${response2.status}`, 'green');
    log(`✓ Found ${response2.data.count} new products`, 'green');

    // Test 3: Test cache (should return cached data)
    log('\n3c. Test cache (should return cached=true):', 'blue');
    const response3 = await axios.get(`${BASE_URL}/api/products/new?limit=5`);
    log(`✓ Status: ${response3.status}`, 'green');
    log(`✓ Cached: ${response3.data.cached}`, 'green');

    if (!response3.data.cached) {
      log('  → Warning: Expected cached response', 'yellow');
    }

    return true;
  } catch (error) {
    log(`✗ Error: ${error.response?.data?.error || error.message}`, 'red');
    return false;
  }
}

async function runAllTests() {
  log('Testing New Products Endpoints', 'blue');
  log(`Base URL: ${BASE_URL}`, 'yellow');
  log(`Products to mark: ${PRODUCTS_TO_MARK.length}`, 'yellow');

  const results = {
    test1: false,
    test2: false,
    test3: false
  };

  // Run tests
  results.test1 = await test1_AddIsNewField();
  await new Promise(resolve => setTimeout(resolve, 1000)); // Wait 1 second

  results.test2 = await test2_MarkProductsAsNew();
  await new Promise(resolve => setTimeout(resolve, 1000)); // Wait 1 second

  results.test3 = await test3_QueryNewProducts();

  // Summary
  logSection('TEST SUMMARY');
  log(`Test 1 (Add IsNew Field):       ${results.test1 ? '✓ PASS' : '✗ FAIL'}`, results.test1 ? 'green' : 'red');
  log(`Test 2 (Mark Products as New):  ${results.test2 ? '✓ PASS' : '✗ FAIL'}`, results.test2 ? 'green' : 'red');
  log(`Test 3 (Query New Products):    ${results.test3 ? '✓ PASS' : '✗ FAIL'}`, results.test3 ? 'green' : 'red');

  const allPassed = results.test1 && results.test2 && results.test3;
  log(`\nOverall: ${allPassed ? '✓ ALL TESTS PASSED' : '✗ SOME TESTS FAILED'}`, allPassed ? 'green' : 'red');

  process.exit(allPassed ? 0 : 1);
}

// Run tests
runAllTests().catch(error => {
  log(`Fatal error: ${error.message}`, 'red');
  process.exit(1);
});
