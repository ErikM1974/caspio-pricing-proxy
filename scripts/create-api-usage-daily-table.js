/**
 * create-api-usage-daily-table.js — one-time creation for Caspio `API_Usage_Daily`.
 *
 *   node scripts/create-api-usage-daily-table.js          # dry-run (no writes)
 *   node scripts/create-api-usage-daily-table.js --apply  # create
 *
 * Backing store for the Caspio call meter's hourly rollup
 * (src/utils/api-usage-rollup.js). The in-memory tracker resets on every dyno
 * cycle and only ever sees its own dyno, so it cannot answer "how many calls
 * have we burned this period" — the exact question the $358 overage on
 * 2026-07-26 raised (invoice AI-334269, 689.8K against a 500K cap).
 *
 * One row per (Usage_Date, Dyno_Id). The reader sums Call_Count across dynos.
 *
 * Fields — all STRING except Call_Count, deliberately:
 *   Usage_Date  STRING   'YYYY-MM-DD' in UTC. NOT a Caspio Date/Time field:
 *                        those store naive wall-clock Pacific and 400 on '',
 *                        and lexicographic compare on YYYY-MM-DD already gives
 *                        correct range queries (readPeriod uses >= and <=).
 *   Dyno_Id     STRING   Heroku dyno name ('web.1'), or 'local' off-platform.
 *   Call_Count  INTEGER  Calls this dyno counted for that UTC day.
 *   Updated_At  STRING   ISO timestamp of the last rollup write.
 *
 * After creating, set the Heroku config var to switch the rollup on:
 *   heroku config:set API_USAGE_ROLLUP_TABLE=API_Usage_Daily -a caspio-pricing-proxy
 * Until that is set the rollup stays OFF by design (a table that does not exist
 * would otherwise mean 24 failing writes/day forever).
 */
'use strict';
const axios = require('axios');
const config = require('../src/config');
const { getCaspioAccessToken } = require('../src/utils/caspio');

const BASE = config.caspio.apiBaseUrl;
const TABLE = 'API_Usage_Daily';
const APPLY = process.argv.includes('--apply');

const TABLE_DEF = {
  Name: TABLE,
  Fields: [
    { Name: 'Usage_Date', Type: 'STRING' },
    { Name: 'Dyno_Id', Type: 'STRING' },
    { Name: 'Call_Count', Type: 'INTEGER' },
    { Name: 'Updated_At', Type: 'STRING' },
  ],
};

(async () => {
  const token = await getCaspioAccessToken();
  const H = { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } };
  console.log(`Mode: ${APPLY ? 'APPLY (writing)' : 'DRY-RUN (no writes)'}\n`);

  let exists = false;
  try {
    await axios.get(`${BASE}/tables/${TABLE}/fields`, { headers: { Authorization: `Bearer ${token}` } });
    exists = true;
  } catch (_) { /* 404 => does not exist */ }

  console.log(`Table ${TABLE}: ${exists ? 'already exists' : 'does NOT exist'}`);

  if (exists) {
    const f = await axios.get(`${BASE}/tables/${TABLE}/fields`, { headers: { Authorization: `Bearer ${token}` } });
    const got = (f.data.Result || []).map(x => `${x.Name}(${x.Type})`);
    console.log(`  fields: ${got.join(', ')}`);
    console.log('\nNothing to do.');
    process.exit(0);
  }

  console.log(`  ${APPLY ? 'creating' : 'would create'}: ${TABLE_DEF.Fields.map(f => `${f.Name}(${f.Type})`).join(', ')}`);
  if (APPLY) {
    await axios.post(`${BASE}/tables`, TABLE_DEF, H);
    console.log('  ✓ table created');

    const f = await axios.get(`${BASE}/tables/${TABLE}/fields`, { headers: { Authorization: `Bearer ${token}` } });
    console.log(`  verified fields: ${(f.data.Result || []).map(x => `${x.Name}(${x.Type})`).join(', ')}`);
    console.log(`\nNext: heroku config:set API_USAGE_ROLLUP_TABLE=${TABLE} -a caspio-pricing-proxy`);
  } else {
    console.log('\nDry-run only. Re-run with --apply.');
  }

  process.exit(0); // api-tracker timer keeps the loop alive — exit explicitly
})().catch(e => {
  console.error('FAILED:', e.response ? JSON.stringify(e.response.data) : e.message);
  process.exit(1);
});
