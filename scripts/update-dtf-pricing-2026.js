/**
 * One-time script to update DTF_Pricing table
 * - Adds $0.50 to all unit_price (transfer costs)
 * - Changes PressingLaborCost from 2 to 2.5 (sent as decimal)
 *
 * Run: node scripts/update-dtf-pricing-2026.js
 */

require('dotenv').config();
const { makeCaspioRequest, fetchAllCaspioPages } = require('../src/utils/caspio');

const TRANSFER_INCREASE = 0.50;
const NEW_LABOR_COST = 2.5;  // Try as decimal

async function updateDtfPricing() {
  console.log('=== 2026 DTF Pricing Update ===');
  console.log(`Transfer cost increase: +$${TRANSFER_INCREASE.toFixed(2)}`);
  console.log(`New pressing labor cost: $${NEW_LABOR_COST.toFixed(2)}\n`);

  // 1. Fetch all DTF_Pricing records
  console.log('Fetching current DTF_Pricing records...');
  const allRecords = await fetchAllCaspioPages('/tables/DTF_Pricing/records', {
    'q.select': 'PK_ID,price_type,quantity_range,unit_price,PressingLaborCost',
    'q.orderBy': 'PK_ID'
  });
  console.log(`Found ${allRecords.length} records\n`);

  // 2. Display BEFORE state
  console.log('BEFORE - Current DTF Pricing:');
  console.log('─'.repeat(60));
  console.log('ID   Size     Tier     Transfer  Labor');
  console.log('─'.repeat(60));

  allRecords.forEach(r => {
    const size = (r.price_type || '').padEnd(8);
    const tier = (r.quantity_range || '').padEnd(8);
    const price = `$${(r.unit_price || 0).toFixed(2)}`.padStart(7);
    const labor = `$${(r.PressingLaborCost || 0).toFixed(2)}`;
    console.log(`${r.PK_ID.toString().padEnd(4)} ${size} ${tier} ${price}    ${labor}`);
  });

  // 3. Perform updates - ONLY unit_price for now
  console.log('\n\nUpdating transfer costs (unit_price)...');
  let updated = 0;
  let errors = 0;

  for (const record of allRecords) {
    const newUnitPrice = parseFloat((record.unit_price + TRANSFER_INCREASE).toFixed(2));

    try {
      // Only update unit_price - PressingLaborCost may need different approach
      await makeCaspioRequest(
        'put',
        '/tables/DTF_Pricing/records',
        { 'q.where': `PK_ID=${record.PK_ID}` },
        { unit_price: newUnitPrice }
      );
      updated++;
      console.log(`  ✓ ID ${record.PK_ID} (${record.price_type} ${record.quantity_range}): $${record.unit_price.toFixed(2)} → $${newUnitPrice.toFixed(2)}`);
    } catch (err) {
      errors++;
      console.error(`  ✗ ID ${record.PK_ID}: ${err.message}`);
    }
  }

  // 4. Now try updating PressingLaborCost separately
  console.log('\n\nUpdating PressingLaborCost to $2.50...');
  let laborUpdated = 0;
  let laborErrors = 0;

  for (const record of allRecords) {
    try {
      await makeCaspioRequest(
        'put',
        '/tables/DTF_Pricing/records',
        { 'q.where': `PK_ID=${record.PK_ID}` },
        { PressingLaborCost: NEW_LABOR_COST }
      );
      laborUpdated++;
      console.log(`  ✓ ID ${record.PK_ID}: Labor → $${NEW_LABOR_COST.toFixed(2)}`);
    } catch (err) {
      laborErrors++;
      if (laborErrors === 1) {
        console.error(`  ✗ Labor update failed - field may be integer type: ${err.message}`);
        console.log('  Note: PressingLaborCost may need to be updated manually in Caspio UI');
      }
      break; // Stop trying if first one fails
    }
  }

  // 5. Verify updates
  console.log('\n\nVerifying updates...');
  const afterRecords = await fetchAllCaspioPages('/tables/DTF_Pricing/records', {
    'q.select': 'PK_ID,price_type,quantity_range,unit_price,PressingLaborCost',
    'q.orderBy': 'PK_ID'
  });

  console.log('\nAFTER - Updated DTF Pricing:');
  console.log('─'.repeat(60));
  console.log('ID   Size     Tier     Transfer  Labor');
  console.log('─'.repeat(60));

  afterRecords.forEach(r => {
    const size = (r.price_type || '').padEnd(8);
    const tier = (r.quantity_range || '').padEnd(8);
    const price = `$${(r.unit_price || 0).toFixed(2)}`.padStart(7);
    const labor = `$${(r.PressingLaborCost || 0).toFixed(2)}`;
    console.log(`${r.PK_ID.toString().padEnd(4)} ${size} ${tier} ${price}    ${labor}`);
  });

  // 6. Summary
  console.log('\n\n=== SUMMARY ===');
  console.log(`Transfer costs updated: ${updated}/${allRecords.length}`);
  console.log(`Transfer increase: +$${TRANSFER_INCREASE.toFixed(2)}`);
  if (laborUpdated > 0) {
    console.log(`Labor costs updated: ${laborUpdated}/${allRecords.length}`);
  } else {
    console.log(`⚠️  Labor cost NOT updated - field type mismatch`);
    console.log(`    Please update PressingLaborCost to 2.5 manually in Caspio UI`);
  }
  console.log('Done!');
}

updateDtfPricing().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
