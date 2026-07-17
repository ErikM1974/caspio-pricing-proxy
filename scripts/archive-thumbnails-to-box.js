#!/usr/bin/env node
/**
 * Archive OLD thumbnail images from Caspio Files to Box.com, in paced chunks,
 * until the selection is drained. Frees Caspio storage; keeps the metadata rows.
 *
 * The endpoint's WHERE (`ExternalKey != ''`) self-excludes already-archived rows,
 * so repeatedly POSTing the same query drains the backlog — no offset needed.
 *
 * Usage (Heroku Scheduler or one-shot; needs BASE_URL + CRM_API_SECRET):
 *   YEAR=2016   node scripts/archive-thumbnails-to-box.js     # just 2016
 *   BEFORE=2024 node scripts/archive-thumbnails-to-box.js     # all years < 2024
 *   DRY=1 YEAR=2016 node scripts/archive-thumbnails-to-box.js # report a sample, mutate nothing
 *   LIMIT=20 PACE_MS=1500 ...                                 # tune chunk size / pacing
 *
 * ⚠ Caspio API budget: ~3 Caspio calls per image. Run big sweeps after the
 *   monthly budget reset, or keep LIMIT small + PACE_MS generous.
 */
const axios = require('axios');

const BASE = process.env.BASE_URL || 'https://caspio-pricing-proxy-ab30a049961a.herokuapp.com';
const SECRET = process.env.CRM_API_SECRET;
const YEAR = process.env.YEAR;
const BEFORE = process.env.BEFORE;
const UNDATED = process.env.UNDATED === '1'; // rows with no timestamp_Added (year/before can't catch them)
const DRY = process.env.DRY === '1';
const LIMIT = parseInt(process.env.LIMIT, 10) || 20;
const PACE_MS = parseInt(process.env.PACE_MS, 10) || 1500;
const MAX_CHUNKS = parseInt(process.env.MAX_CHUNKS, 10) || 0; // 0 = unlimited; set to cap a run (testing/budget)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  if (!SECRET) { console.error('CRM_API_SECRET required'); process.exit(1); }
  if (!YEAR && !BEFORE && !UNDATED) { console.error('set YEAR=YYYY, BEFORE=YYYY, or UNDATED=1'); process.exit(1); }

  const sel = UNDATED ? 'undated=1' : (YEAR ? `year=${YEAR}` : `before=${BEFORE}`);
  const qs = sel + `&limit=${LIMIT}` + (DRY ? '&dryRun=true' : '');
  const url = `${BASE}/api/thumbnails/archive-to-box?${qs}`;
  const headers = { 'x-crm-api-secret': SECRET };

  let totalArchived = 0, totalMb = 0, chunk = 0, consecErr = 0, noProgress = 0;
  while (true) {
    chunk++;
    let resp;
    try {
      resp = (await axios.post(url, {}, { headers, timeout: 120000 })).data;
    } catch (e) {
      consecErr++;
      console.error(`chunk ${chunk} FAILED: ${e.response ? JSON.stringify(e.response.data) : e.message}`);
      if (consecErr >= 3) { console.error('3 consecutive request failures — stopping'); process.exit(1); }
      await sleep(30000); // proxy/Caspio breather
      continue;
    }
    consecErr = 0;

    if (DRY) { console.log('DRY-RUN:', JSON.stringify(resp)); return; }

    const s = resp.summary || {};
    totalArchived += s.archived || 0;
    totalMb += s.mbFreed || 0;
    console.log(`chunk ${chunk}: +${s.archived || 0} archived, ${s.errored || 0} err, ${s.mbFreed || 0}MB  (total ${totalArchived}, ~${totalMb.toFixed(1)}MB)`);

    if (!resp.moreLikely) { console.log(`DONE: ${totalArchived} archived, ~${totalMb.toFixed(1)}MB freed`); return; }
    if (MAX_CHUNKS && chunk >= MAX_CHUNKS) { console.log(`STOPPED at MAX_CHUNKS=${MAX_CHUNKS}: ${totalArchived} archived, ~${totalMb.toFixed(1)}MB (more remain)`); return; }
    // guard against an all-errors loop (records that never archive keep re-matching)
    if ((s.archived || 0) === 0) { noProgress++; if (noProgress >= 3) { console.error('3 chunks with 0 progress — stopping (check errors above)'); process.exit(1); } }
    else { noProgress = 0; }

    await sleep(PACE_MS);
  }
}

main().catch((e) => { console.error('FATAL:', e.message); process.exit(1); });
