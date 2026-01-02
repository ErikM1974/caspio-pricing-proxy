/**
 * One-time script to update DTG_Costs table
 * Adds $0.50 to all PrintCost values for LC, FF, FB, JF, JB locations
 *
 * Run: node scripts/update-dtg-costs-2026.js
 */

require('dotenv').config();
const { makeCaspioRequest, fetchAllCaspioPages } = require('../src/utils/caspio');

const TARGET_LOCATIONS = ['LC', 'FF', 'FB', 'JF', 'JB'];
const INCREASE_AMOUNT = 0.50;

async function updateDtgCosts() {
  console.log('=== 2026 DTG Costs Update: +$0.50 to all print costs ===\n');

  // 1. Fetch all DTG_Costs records
  console.log('Fetching current DTG_Costs records...');
  const allRecords = await fetchAllCaspioPages('/tables/DTG_Costs/records', {
    'q.select': 'PK_ID,PrintLocationCode,TierLabel,PrintCost',
    'q.orderBy': 'PrintLocationCode,TierLabel'
  });
  console.log(`Found ${allRecords.length} total records\n`);

  // 2. Filter to target locations
  const toUpdate = allRecords.filter(r => TARGET_LOCATIONS.includes(r.PrintLocationCode));
  console.log(`Records to update (${TARGET_LOCATIONS.join(', ')}): ${toUpdate.length}\n`);

  // 3. Display BEFORE state
  console.log('BEFORE - Current DTG Print Costs:');
  console.log('─'.repeat(50));

  const byLocation = {};
  toUpdate.forEach(r => {
    if (!byLocation[r.PrintLocationCode]) byLocation[r.PrintLocationCode] = [];
    byLocation[r.PrintLocationCode].push(r);
  });

  for (const loc of TARGET_LOCATIONS) {
    if (byLocation[loc]) {
      console.log(`\n${loc}:`);
      byLocation[loc].forEach(r => {
        const newCost = (r.PrintCost + INCREASE_AMOUNT).toFixed(2);
        console.log(`  ${r.TierLabel.padEnd(8)} $${r.PrintCost.toFixed(2)} → $${newCost}`);
      });
    }
  }

  // 4. Perform updates
  console.log('\n\nUpdating records...');
  let updated = 0;
  let errors = 0;

  for (const record of toUpdate) {
    const newCost = parseFloat((record.PrintCost + INCREASE_AMOUNT).toFixed(2));

    try {
      await makeCaspioRequest(
        'put',
        '/tables/DTG_Costs/records',
        { 'q.where': `PK_ID=${record.PK_ID}` },
        { PrintCost: newCost }
      );
      updated++;
      console.log(`  ✓ ${record.PrintLocationCode} ${record.TierLabel}: $${record.PrintCost.toFixed(2)} → $${newCost.toFixed(2)}`);
    } catch (err) {
      errors++;
      console.error(`  ✗ ${record.PrintLocationCode} ${record.TierLabel}: ${err.message}`);
    }
  }

  // 5. Verify updates
  console.log('\n\nVerifying updates...');
  const afterRecords = await fetchAllCaspioPages('/tables/DTG_Costs/records', {
    'q.select': 'PK_ID,PrintLocationCode,TierLabel,PrintCost',
    'q.orderBy': 'PrintLocationCode,TierLabel'
  });

  const afterFiltered = afterRecords.filter(r => TARGET_LOCATIONS.includes(r.PrintLocationCode));

  console.log('\nAFTER - Updated DTG Print Costs:');
  console.log('─'.repeat(50));

  const afterByLocation = {};
  afterFiltered.forEach(r => {
    if (!afterByLocation[r.PrintLocationCode]) afterByLocation[r.PrintLocationCode] = [];
    afterByLocation[r.PrintLocationCode].push(r);
  });

  for (const loc of TARGET_LOCATIONS) {
    if (afterByLocation[loc]) {
      console.log(`\n${loc}:`);
      afterByLocation[loc].forEach(r => {
        console.log(`  ${r.TierLabel.padEnd(8)} $${r.PrintCost.toFixed(2)}`);
      });
    }
  }

  // 6. Summary
  console.log('\n\n=== SUMMARY ===');
  console.log(`Records updated: ${updated}`);
  console.log(`Errors: ${errors}`);
  console.log(`Increase amount: +$${INCREASE_AMOUNT.toFixed(2)}`);
  console.log('Done!');
}

updateDtgCosts().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
