/**
 * Analyze SanMar Caspio Size Values vs SIZE_MAPPING
 *
 * Purpose: Find all unique SIZE values in Sanmar_Bulk_251816_Feb2024 table
 * and compare against current SIZE_MAPPING to identify gaps.
 *
 * Usage: node scripts/analyze-size-mapping.js
 */

require('dotenv').config();
const { fetchAllCaspioPages } = require('../src/utils/caspio');
const { SIZE_MAPPING } = require('../config/manageorders-push-config');

// Size categorization function
function categorizeSize(size) {
  const upper = size.toUpperCase();

  if (/^Y/.test(upper)) return 'YOUTH';
  if (/^(XS|S|M|L|XL|2XL|XXL|3XL|4XL|5XL|6XL)$/.test(upper)) return 'ADULT_STANDARD';
  if (/T$/.test(upper) && upper.length > 1) return 'TALL';
  if (/^\d+/.test(size)) return 'NUMERIC';
  if (/^(OSFA|OS|ONE SIZE)/.test(upper)) return 'ONE_SIZE';
  if (/\//.test(size)) return 'FLEX_FIT';

  return 'UNKNOWN';
}

// Priority levels for different categories
const CATEGORY_PRIORITY = {
  'YOUTH': 'HIGH',
  'ADULT_STANDARD': 'HIGH',
  'TALL': 'MEDIUM',
  'FLEX_FIT': 'LOW',
  'ONE_SIZE': 'LOW',
  'NUMERIC': 'LOW',
  'UNKNOWN': 'REVIEW'
};

async function analyzeSizeMapping() {
  console.log('========================================');
  console.log('SANMAR SIZE MAPPING ANALYSIS');
  console.log('========================================\n');

  try {
    // Step 1: Analyze current SIZE_MAPPING
    console.log('Analyzing current SIZE_MAPPING...');
    const mappedInputs = Object.keys(SIZE_MAPPING);
    const mappedOutputs = [...new Set(Object.values(SIZE_MAPPING))];
    const normalizedMapped = mappedInputs.map(s => s.trim().toUpperCase());

    console.log(`Current SIZE_MAPPING Status:`);
    console.log(`  - Total entries: ${mappedInputs.length}`);
    console.log(`  - Unique inputs: ${mappedInputs.length}`);
    console.log(`  - Unique OnSite outputs: ${mappedOutputs.length}\n`);

    // Step 2: Query Caspio for all unique sizes
    console.log('Querying Caspio for unique SIZE values...');
    console.log('(This may take 30-60 seconds with pagination)\n');

    const allSizes = await fetchAllCaspioPages(
      '/tables/Sanmar_Bulk_251816_Feb2024/records',
      {
        'q.select': 'SIZE',
        'q.groupBy': 'SIZE',
        'q.where': 'SIZE IS NOT NULL',
        'q.limit': 1000
      }
    );

    // Step 3: Extract and clean size values
    const caspioSizes = allSizes
      .map(record => record.SIZE)
      .filter(size => size && typeof size === 'string')
      .filter(size => size.trim().length > 0)
      .map(size => size.trim());

    const uniqueCaspioSizes = [...new Set(caspioSizes)].sort();

    console.log(`Caspio Database Analysis:`);
    console.log(`  - Total unique sizes found: ${uniqueCaspioSizes.length}`);

    // Step 4: Find missing sizes
    const missingSizes = uniqueCaspioSizes.filter(caspioSize => {
      const normalized = caspioSize.toUpperCase();
      return !normalizedMapped.includes(normalized);
    });

    const alreadyMapped = uniqueCaspioSizes.length - missingSizes.length;
    const coverage = ((alreadyMapped / uniqueCaspioSizes.length) * 100).toFixed(1);

    console.log(`  - Already mapped: ${alreadyMapped}`);
    console.log(`  - MISSING from mapping: ${missingSizes.length}`);
    console.log(`  - Coverage: ${coverage}%\n`);

    // Step 5: Categorize missing sizes
    const categorized = {};
    missingSizes.forEach(size => {
      const category = categorizeSize(size);
      if (!categorized[category]) {
        categorized[category] = [];
      }
      categorized[category].push(size);
    });

    // Step 6: Display results by category
    console.log('========================================');
    console.log('MISSING SIZES BY CATEGORY');
    console.log('========================================\n');

    const categoryOrder = ['YOUTH', 'ADULT_STANDARD', 'TALL', 'NUMERIC', 'FLEX_FIT', 'ONE_SIZE', 'UNKNOWN'];

    categoryOrder.forEach(category => {
      if (categorized[category] && categorized[category].length > 0) {
        const priority = CATEGORY_PRIORITY[category];
        console.log(`${category} (Priority: ${priority})`);
        categorized[category].sort().forEach(size => {
          console.log(`  - ${size}`);
        });
        console.log();
      }
    });

    // Step 7: Generate recommendations
    console.log('========================================');
    console.log('RECOMMENDATIONS');
    console.log('========================================\n');

    // Youth sizes recommendation
    if (categorized['YOUTH'] && categorized['YOUTH'].length > 0) {
      console.log('1. IMMEDIATE ADDITIONS (High Priority - Youth Sizes):');
      console.log('   Add these youth sizes to SIZE_MAPPING:\n');
      categorized['YOUTH'].forEach(size => {
        console.log(`   '${size}': '${size}',`);
      });
      console.log();
    }

    // Tall sizes recommendation
    if (categorized['TALL'] && categorized['TALL'].length > 0) {
      console.log('2. TALL SIZES:');
      console.log('   Add these tall sizes to SIZE_MAPPING:\n');
      categorized['TALL'].forEach(size => {
        console.log(`   '${size}': '${size}',`);
      });
      console.log();
    }

    // Numeric sizes warning
    if (categorized['NUMERIC'] && categorized['NUMERIC'].length > 0) {
      console.log('3. NUMERIC SIZES (Discuss with team):');
      console.log('   These appear to be waist/inseam sizes:');
      console.log(`   Found: ${categorized['NUMERIC'].join(', ')}`);
      console.log('   Action: Verify if these need special OnSite configuration\n');
    }

    // Unknown sizes warning
    if (categorized['UNKNOWN'] && categorized['UNKNOWN'].length > 0) {
      console.log('4. UNKNOWN SIZES (Manual Review Required):');
      console.log('   These sizes don\'t match expected patterns:');
      categorized['UNKNOWN'].forEach(size => {
        console.log(`   - "${size}" (needs investigation)`);
      });
      console.log();
    }

    // Step 8: Summary
    console.log('========================================');
    console.log('SUMMARY');
    console.log('========================================\n');
    console.log(`Coverage: ${coverage}% (${alreadyMapped} mapped / ${uniqueCaspioSizes.length} total in Caspio)`);
    console.log(`Action Items: ${Object.keys(categorized).length} categories need attention`);
    console.log(`High Priority: ${(categorized['YOUTH']?.length || 0) + (categorized['ADULT_STANDARD']?.length || 0)} sizes\n`);

    console.log('Analysis complete! ✓\n');

  } catch (error) {
    console.error('\n❌ ERROR during analysis:\n');

    if (error.message.includes('access token') || error.message.includes('oauth')) {
      console.error('AUTHENTICATION FAILED');
      console.error('Check your .env file contains:');
      console.error('  - CASPIO_ACCOUNT_DOMAIN');
      console.error('  - CASPIO_CLIENT_ID');
      console.error('  - CASPIO_CLIENT_SECRET\n');
    } else if (error.code === 'ECONNABORTED') {
      console.error('REQUEST TIMED OUT');
      console.error('The query took too long. This is normal for large datasets.');
      console.error('Try again or increase timeout in src/config/index.js\n');
    } else {
      console.error('Unexpected error:', error.message);
      if (error.response?.data) {
        console.error('API Response:', error.response.data);
      }
    }

    process.exit(1);
  }
}

// Run the analysis
analyzeSizeMapping();
