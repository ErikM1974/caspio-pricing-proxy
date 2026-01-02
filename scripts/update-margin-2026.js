/**
 * One-time script to update Pricing_Tiers MarginDenominator
 * Changes from 0.6 to 0.57 (43% margin) for all methods EXCEPT ScreenPrint
 *
 * Run: node scripts/update-margin-2026.js
 */

require('dotenv').config();
const { makeCaspioRequest, fetchAllCaspioPages } = require('../src/utils/caspio');

async function updateMargins() {
  console.log('=== 2026 Margin Update: 0.6 → 0.57 (43% margin) ===\n');

  // 1. First, show current state
  console.log('BEFORE - Current MarginDenominator values:');
  const before = await fetchAllCaspioPages('/tables/Pricing_Tiers/records', {
    'q.select': 'TierID,DecorationMethod,TierLabel,MarginDenominator',
    'q.orderBy': 'TierID'
  });

  before.forEach(row => {
    const willUpdate = row.MarginDenominator === 0.6 && row.DecorationMethod !== 'ScreenPrint';
    console.log(`  TierID ${row.TierID}: ${row.DecorationMethod} (${row.TierLabel}) = ${row.MarginDenominator}${willUpdate ? ' → 0.57' : ''}`);
  });

  // 2. Count records to be updated
  const toUpdate = before.filter(r => r.MarginDenominator === 0.6 && r.DecorationMethod !== 'ScreenPrint');
  console.log(`\nRecords to update: ${toUpdate.length}`);

  // 3. Perform the update
  console.log('\nUpdating...');
  const result = await makeCaspioRequest(
    'put',
    '/tables/Pricing_Tiers/records',
    { 'q.where': "MarginDenominator=0.6 AND DecorationMethod<>'ScreenPrint'" },
    { MarginDenominator: 0.57 }
  );
  console.log('Update result:', result);

  // 4. Verify the update
  console.log('\nAFTER - Updated MarginDenominator values:');
  const after = await fetchAllCaspioPages('/tables/Pricing_Tiers/records', {
    'q.select': 'TierID,DecorationMethod,TierLabel,MarginDenominator',
    'q.orderBy': 'TierID'
  });

  after.forEach(row => {
    console.log(`  TierID ${row.TierID}: ${row.DecorationMethod} (${row.TierLabel}) = ${row.MarginDenominator}`);
  });

  // 5. Summary
  const updated = after.filter(r => r.MarginDenominator === 0.57);
  const screenPrint = after.filter(r => r.DecorationMethod === 'ScreenPrint');

  console.log('\n=== SUMMARY ===');
  console.log(`Records now at 0.57: ${updated.length}`);
  console.log(`ScreenPrint records (unchanged): ${screenPrint.length}`);
  console.log('Done!');
}

updateMargins().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
