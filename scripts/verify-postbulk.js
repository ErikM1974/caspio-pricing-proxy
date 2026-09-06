#!/usr/bin/env node
// Live proof of utils/caspio.js postBulk (REST v4 bulk insert), leaving no trace.
//
//   heroku run node scripts/verify-postbulk.js -a caspio-pricing-proxy
//
// Inserts two marker rows into Sync_Heartbeats with ONE v4 bulk request, reads
// them back through v3 by their marker name, then deletes them with one v3
// DELETE. Net rows: 0. Net Caspio calls: 1 table-list read (first call in a
// process) + 1 bulk POST + 1 GET + 1 DELETE (+ the token). Compare Caspio's
// own usage page the next day if you want the "one request = one billed call"
// assumption confirmed by the billing authority.
//
// Sync_Heartbeats columns: Sync_Name TEXT255, Last_Success DATE/TIME,
// Last_Rows INTEGER, Last_Summary TEXT255 (PK_ID auto).

const { postBulk, fetchAllCaspioPages, makeCaspioRequest } = require('../src/utils/caspio');
const { flushAndExit } = (() => { try { return require('../src/utils/api-usage-rollup'); } catch { return {}; } })();

const MARKER = `postbulk-verify-${Date.now()}`;
const TABLE = 'Sync_Heartbeats';

async function main() {
  const stamp = new Date().toISOString().slice(0, 19);
  const rows = [
    { Sync_Name: `${MARKER}-1`, Last_Success: stamp, Last_Rows: 1, Last_Summary: 'postBulk live verification row 1 (safe to delete)' },
    { Sync_Name: `${MARKER}-2`, Last_Success: stamp, Last_Rows: 2, Last_Summary: 'postBulk live verification row 2 (safe to delete)' },
  ];

  console.log(`1. bulk insert 2 rows into ${TABLE} ...`);
  const result = await postBulk(TABLE, rows);
  console.log('   result:', JSON.stringify({ tableId: result.tableId, calls: result.calls, inserted: result.inserted, failed: result.failed, pkIds: result.pkIds, failures: result.failures }));
  if (result.calls !== 1 || result.inserted !== 2 || result.failed !== 0) {
    throw new Error('bulk insert did not behave as expected — see result above');
  }

  console.log('2. read them back through v3 ...');
  const back = await fetchAllCaspioPages(`/tables/${TABLE}/records`, {
    'q.where': `Sync_Name LIKE '${MARKER}-%'`,
    'q.select': 'PK_ID,Sync_Name,Last_Rows,Last_Summary',
    'q.limit': 10,
  });
  console.log('   rows:', JSON.stringify(back));
  if (back.length !== 2) throw new Error(`expected 2 rows back, got ${back.length}`);

  console.log('3. delete them (one where-clause DELETE) ...');
  const del = await makeCaspioRequest('delete', `/tables/${TABLE}/records`, { 'q.where': `Sync_Name LIKE '${MARKER}-%'` });
  console.log('   RecordsAffected:', del.RecordsAffected);
  if (del.RecordsAffected !== 2) throw new Error(`expected to delete 2 rows, deleted ${del.RecordsAffected}`);

  console.log('\nOK — postBulk verified live: 1 request created 2 rows (PK_IDs ' + result.pkIds.join(', ') + '); both deleted again.');
}

main()
  .then(() => (flushAndExit ? flushAndExit(0) : process.exit(0)))
  .catch((err) => {
    console.error('\nFAILED:', err.message);
    console.error(`If rows were left behind, remove them with: DELETE ... WHERE Sync_Name LIKE '${MARKER}-%'`);
    if (flushAndExit) flushAndExit(1); else process.exit(1);
  });
