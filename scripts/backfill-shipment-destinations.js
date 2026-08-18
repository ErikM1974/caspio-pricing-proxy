#!/usr/bin/env node
/**
 * Backfill Ship_To_City / Ship_To_State / Ship_To_Zip on SanMar_Shipments.
 *
 * WHY (2026-08-18). The inbound board listed PO 113977 (Inland Beef) as freight arriving
 * at Milton when it had been drop-shipped straight to the customer in Sequim. SanMar
 * reports the destination on every shipment; we were storing only the street, and often
 * not even that — 83 of 174 recent cartons had a blank Ship_To_Address.
 *
 * The board classifies on ZIP (see classifyDestination in src/routes/sanmar-orders.js).
 * Rows written before those fields existed classify as 'unknown' and STAY VISIBLE, which
 * is the safe direction but means a real drop-ship keeps showing until it is backfilled.
 * This fills them in.
 *
 * Usage:
 *   node scripts/backfill-shipment-destinations.js                 # dry run
 *   node scripts/backfill-shipment-destinations.js --apply         # write
 *   node scripts/backfill-shipment-destinations.js --apply --since 113900
 *
 * One SanMar SOAP call per PO, paced at 1/sec — the live feed rate-limits, and this is a
 * one-off catch-up, not a hot path.
 */
require('dotenv').config();
const axios = require('axios');
const { fetchAllCaspioPages, getCaspioAccessToken } = require('../src/utils/caspio');
const config = require('../config');

const APPLY = process.argv.includes('--apply');
const sinceIdx = process.argv.indexOf('--since');
const SINCE = sinceIdx > -1 ? process.argv[sinceIdx + 1] : '113900';
const PACE_MS = 1000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function shipToByTracking(po) {
  // Reuse the proxy's own live endpoint rather than re-implementing the SOAP call.
  const base = process.env.BASE_URL || 'https://caspio-pricing-proxy-ab30a049961a.herokuapp.com';
  const r = await axios.get(`${base}/api/sanmar-orders/shipments/${encodeURIComponent(po)}`, {
    headers: { 'X-CRM-API-Secret': process.env.CRM_API_SECRET || '' }, timeout: 45000,
  });
  const out = new Map();
  for (const s of (r.data && r.data.shipments) || []) {
    for (const so of s.salesOrders || []) {
      for (const loc of so.locations || []) {
        const st = loc.shipTo || {};
        for (const pkg of loc.packages || []) {
          if (pkg.trackingNumber) out.set(String(pkg.trackingNumber).trim(), st);
        }
      }
    }
  }
  return out;
}

(async () => {
  const rows = await fetchAllCaspioPages('/tables/SanMar_Shipments/records', {
    'q.where': `SanMar_PO>'${SINCE}'`,
    'q.select': 'PK_ID,SanMar_PO,Tracking_Number,Ship_To_Address,Ship_To_City,Ship_To_State,Ship_To_Zip',
    'q.pageSize': 1000, 'q.orderBy': 'PK_ID',
  });
  const need = rows.filter((r) => !String(r.Ship_To_Zip || '').trim());
  const byPo = new Map();
  for (const r of need) {
    const po = String(r.SanMar_PO).trim();
    if (!byPo.has(po)) byPo.set(po, []);
    byPo.get(po).push(r);
  }
  console.log(`${need.length} carton row(s) missing Ship_To_Zip across ${byPo.size} PO(s)`);
  console.log(APPLY ? 'APPLY — writing.' : 'DRY RUN — nothing written. Add --apply to write.');

  const token = APPLY ? await getCaspioAccessToken() : null;
  const H = token ? { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } : null;
  let patched = 0, poDone = 0, noData = 0, failed = 0;
  const seenDest = {};

  for (const [po, cartons] of byPo) {
    poDone++;
    let map;
    try { map = await shipToByTracking(po); }
    catch (e) { failed++; console.log(`  ${po}: live lookup failed — ${e.message}`); await sleep(PACE_MS); continue; }
    for (const c of cartons) {
      const st = map.get(String(c.Tracking_Number || '').trim());
      if (!st || !(st.postalCode || st.city)) { noData++; continue; }
      const zip5 = String(st.postalCode || '').slice(0, 5);
      seenDest[zip5 === '98354' ? 'ours' : `dropship:${st.city || '?'}`] =
        (seenDest[zip5 === '98354' ? 'ours' : `dropship:${st.city || '?'}`] || 0) + 1;
      if (!APPLY) continue;
      try {
        await axios.put(
          `${config.caspio.apiBaseUrl}/tables/SanMar_Shipments/records?q.where=${encodeURIComponent(`PK_ID=${c.PK_ID}`)}`,
          {
            Ship_To_Address: st.address1 || c.Ship_To_Address || '',
            Ship_To_City: st.city || '',
            Ship_To_State: st.region || '',
            Ship_To_Zip: st.postalCode || '',
          }, { headers: H, timeout: 20000 });
        patched++;
      } catch (e) { failed++; console.log(`  PK ${c.PK_ID}: write failed — ${e.message}`); }
    }
    if (poDone % 20 === 0) console.log(`  …${poDone}/${byPo.size} POs, ${patched} rows patched`);
    await sleep(PACE_MS);
  }

  console.log(`\nDone. POs ${poDone}, rows patched ${patched}, no destination in feed ${noData}, failures ${failed}`);
  console.log('Destinations seen:', JSON.stringify(seenDest, null, 2));
})().catch((e) => { console.error('FATAL', e.message); process.exit(1); });
