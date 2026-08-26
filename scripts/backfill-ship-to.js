#!/usr/bin/env node
/**
 * Backfill Ship_To_City / Ship_To_State / Ship_To_Zip on SanMar_Shipments.
 *
 *   node scripts/backfill-ship-to.js              # DRY RUN — reports, writes nothing
 *   node scripts/backfill-ship-to.js --apply      # actually writes
 *   node scripts/backfill-ship-to.js --limit 20   # cap the POs processed (dry or apply)
 *
 * WHY THIS EXISTS
 * The board tells Ruthie and the reps which SanMar freight is arriving at Freeman Road, and
 * since 2026-08-26 the printed sheets mark a DROP-SHIP so nobody schedules or checks in
 * freight that went straight to the customer. That marking is driven by classifyDestination()
 * in src/routes/sanmar-orders.js, which reads Ship_To_Zip (falling back to address/city).
 *
 * Both writers set those fields, but only on INSERT — neither ever updates an existing row.
 * Carton rows written before the fields existed therefore have nothing to classify on, and
 * classifyDestination correctly returns 'unknown'. Measured 2026-08-26: of 1,626 shipment
 * rows, 165 (130 POs, Jan–Aug 2026) are blank on zip AND city AND address. On the live 08-26
 * board that was 15 of 32 orders reading 'unknown'.
 *
 * 'unknown' is the SAFE answer — the board keeps showing those cartons as arriving rather
 * than risk deleting a real one from the receiving sheet. But a genuine drop-ship hiding in
 * that set still prints as inbound, which is exactly what the 2026-08-26 work set out to stop.
 * This closes the gap.
 *
 * 🔴 MATCH ON TRACKING NUMBER, NEVER ON POSITION. One PO can ship several cartons from
 * several warehouses to DIFFERENT destinations (a split where part goes to us and part drop
 * ships is the whole reason this field exists). Zipping SanMar's cartons against our rows by
 * index would silently write the wrong destination onto a row — worse than the blank it
 * replaces, because 'unknown' is honest and a wrong ZIP is not.
 *
 * 🔴 FILL BLANKS ONLY. Every field is written only where ours is empty. A row that already
 * carries a destination is left exactly as it is, so re-running is safe and this can never
 * overwrite good data with a later SanMar correction nobody reviewed.
 *
 * 🔴 DRY RUN IS THE DEFAULT. It prints the destination it WOULD write for every row, grouped,
 * with the drop-ships called out. Read that before passing --apply. A numeric summary is not
 * enough: the 2026-08 ghost-order near-miss passed three numeric guards on unread data.
 *
 * COST. Reads: one paged scan of SanMar_Shipments (~2 calls). Writes: one PUT per row,
 * ~165 worst case — an order of magnitude under the ~1,000-row threshold where Erik's rule
 * says to switch to a CSV + Caspio data import, so the API is the right tool here. SanMar
 * SOAP calls are free and do not touch the Caspio meter.
 */
require('dotenv').config();

const { makeCaspioRequest } = require('../src/utils/caspio');
const {
  ENDPOINTS, NS, getPromoStandardsAuth, validateAuth,
  makeSoapRequest, buildShipmentRequest, parseShipmentResponse,
} = require('../src/utils/sanmar-soap');

const TABLE = 'SanMar_Shipments';
const APPLY = process.argv.includes('--apply');
const LIMIT = (() => {
  const i = process.argv.indexOf('--limit');
  return i > -1 ? parseInt(process.argv[i + 1], 10) || 0 : 0;
})();
const SOAP_SPACING_MS = 400;   // be a good citizen against SanMar
const OUR_ZIP = '98354';

// 🔴 DO NOT USE fetchAllCaspioPages HERE. It fetches page 1 with `q.limit` and then
// continues with `q.pageSize` + `q.pageNumber=2` -- two different paging models that do NOT
// agree on what the first 1,000 rows are. Measured against this very table on 2026-08-26:
//
//     q.limit=1000                    -> 1000 rows, PK range 1119..1271 (unordered)
//     q.pageSize=1000&q.pageNumber=1  -> 1000 rows, PK range    6..1005
//     q.pageSize=1000&q.pageNumber=2  ->  626 rows, PK range 1006..1631
//
// So page 2 continues from a baseline page 1 never delivered: the helper returned 1,626 rows
// of which 326 were DUPLICATES and 326 real rows were never returned at all. On a backfill
// that means silently skipping a quarter of the table -- and a skipped drop-ship still prints
// as arriving freight, which is the exact bug this script exists to close.
//
// Paging consistently with pageSize+pageNumber gives 1,626 distinct rows, zero repeats.
// (The helper's bug is real and affects every caller reading a >1,000-row table in full; it
// is reported separately rather than patched from inside a backfill script.)
const PAGE_SIZE = 1000;
async function pageAllRecords(path, select) {
  const out = [];
  for (let n = 1; n <= 40; n++) {
    const r = await makeCaspioRequest('GET', path, {
      'q.select': select, 'q.pageSize': PAGE_SIZE, 'q.pageNumber': n,
    });
    if (!Array.isArray(r) || !r.length) break;
    out.push(...r);
    if (r.length < PAGE_SIZE) return out;
  }
  throw new Error('page cap hit at 40 pages -- refusing to work from a truncated scan');
}

const blank = (v) => !String(v == null ? '' : v).trim();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const norm = (t) => String(t || '').trim().toUpperCase();

/** Every shipTo SanMar knows for this PO, keyed by tracking number. */
async function fetchShipToByTracking(po) {
  const auth = getPromoStandardsAuth();
  if (!validateAuth(auth)) throw new Error('SanMar credentials not configured');
  const xml = await makeSoapRequest(
    ENDPOINTS.shipmentNotification,
    buildShipmentRequest(1, { referenceNumber: po }),
    { timeout: 30000, namespaces: { ns: NS.shipment, shar: NS.shipmentShared } }
  );
  // parseShipmentResponse returns the ARRAY of notifications, NOT { shipments: [...] }.
  // The first cut unwrapped a `.shipments` property that does not exist, so every PO came
  // back empty and the script reported "SanMar returned NO shipments" for POs the live
  // /shipments/:po endpoint answers fine. A parser bug wearing the costume of a fact about
  // the vendor -- the same trap the psst-audit lesson is about. Cross-check before believing
  // an absence.
  const parsed = parseShipmentResponse(xml) || [];
  const out = new Map();
  for (const sh of parsed) {
    for (const so of sh.salesOrders || []) {
      for (const loc of so.locations || []) {
        const to = loc.shipTo || {};
        for (const pkg of loc.packages || []) {
          if (!pkg.trackingNumber) continue;
          out.set(norm(pkg.trackingNumber), {
            city: String(to.city || '').trim(),
            state: String(to.region || '').trim(),
            zip: String(to.postalCode || '').trim(),
            address: String(to.address1 || '').trim(),
          });
        }
      }
    }
  }
  return out;
}

const dest = (z, c) => {
  if (z) return z.slice(0, 5) === OUR_ZIP ? 'ours' : 'DROP-SHIP';
  if (c && c.toLowerCase() === 'milton') return 'ours';
  return c ? 'DROP-SHIP' : '?';
};

(async () => {
  console.log(APPLY ? '*** APPLY MODE — this WILL write to Caspio ***' : 'DRY RUN — nothing will be written. Use --apply to write.');
  console.log('');

  const rows = await pageAllRecords(`/tables/${TABLE}/records`,
    'PK_ID,SanMar_PO,Tracking_Number,Ship_Date,Ship_To_Zip,Ship_To_City,Ship_To_State,Ship_To_Address');
  const distinct = new Set(rows.map((r) => r.PK_ID)).size;
  if (distinct !== rows.length) {
    // Belt and braces: if paging ever repeats a row again, stop rather than write from it.
    throw new Error(`scan returned ${rows.length} rows but only ${distinct} distinct PK_ID -- pagination is repeating rows, refusing to continue`);
  }

  // A row is a target only when we have NOTHING to classify on. Rows carrying an address or
  // city already resolve through classifyDestination's fallback and are deliberately left be.
  const targets = rows.filter((r) => blank(r.Ship_To_Zip) && blank(r.Ship_To_City) && blank(r.Ship_To_Address));
  const byPo = new Map();
  for (const r of targets) {
    if (!byPo.has(r.SanMar_PO)) byPo.set(r.SanMar_PO, []);
    byPo.get(r.SanMar_PO).push(r);
  }
  let pos = [...byPo.keys()].sort();
  if (LIMIT) pos = pos.slice(0, LIMIT);

  console.log(`Scanned ${rows.length} shipment rows.`);
  console.log(`Blank on zip AND city AND address: ${targets.length} row(s) across ${byPo.size} PO(s).`);
  if (LIMIT) console.log(`--limit ${LIMIT}: processing the first ${pos.length} PO(s) only.`);
  console.log('');

  const plan = [];
  const noData = [];
  const unmatched = [];
  const soapFailed = [];

  for (let i = 0; i < pos.length; i++) {
    const po = pos[i];
    let map;
    try {
      map = await fetchShipToByTracking(po);
    } catch (e) {
      soapFailed.push(`${po}: ${e.message}`);
      if (i < pos.length - 1) await sleep(SOAP_SPACING_MS);
      continue;
    }
    if (!map.size) noData.push(po);

    for (const row of byPo.get(po)) {
      const hit = map.get(norm(row.Tracking_Number));
      if (!hit) { unmatched.push(`${po} / ${row.Tracking_Number || '(no tracking)'}`); continue; }
      // Fill blanks only — never overwrite a value we already hold.
      const patch = {};
      if (blank(row.Ship_To_City) && hit.city) patch.Ship_To_City = hit.city;
      if (blank(row.Ship_To_State) && hit.state) patch.Ship_To_State = hit.state;
      if (blank(row.Ship_To_Zip) && hit.zip) patch.Ship_To_Zip = hit.zip;
      if (blank(row.Ship_To_Address) && hit.address) patch.Ship_To_Address = hit.address;
      if (!Object.keys(patch).length) { unmatched.push(`${po} / ${row.Tracking_Number}: SanMar had no address either`); continue; }
      plan.push({ po, pk: row.PK_ID, trk: row.Tracking_Number, shipDate: row.Ship_Date, patch, verdict: dest(hit.zip, hit.city) });
    }
    if (i < pos.length - 1) await sleep(SOAP_SPACING_MS);
    if ((i + 1) % 25 === 0) console.log(`  …${i + 1}/${pos.length} POs fetched`);
  }

  // ---- the part a human reads ---------------------------------------------------------
  const drops = plan.filter((p) => p.verdict === 'DROP-SHIP');
  console.log('');
  console.log('PLAN');
  console.log(`  rows to update : ${plan.length}`);
  console.log(`  -> resolves to OURS      : ${plan.filter((p) => p.verdict === 'ours').length}`);
  console.log(`  -> resolves to DROP-SHIP : ${drops.length}`);
  console.log('');
  if (drops.length) {
    console.log('  🔴 THE DROP-SHIPS — these stop being counted as arriving at Freeman Road:');
    for (const d of drops) {
      console.log(`     ${String(d.po).padEnd(12)} ${String(d.shipDate || '').slice(0, 10).padEnd(11)} ${d.trk}  ->  ${d.patch.Ship_To_City || '?'} ${d.patch.Ship_To_State || ''} ${d.patch.Ship_To_Zip || ''}`);
    }
    console.log('');
  }
  if (noData.length) console.log(`  SanMar returned NO shipments for ${noData.length} PO(s): ${noData.slice(0, 12).join(', ')}${noData.length > 12 ? ' …' : ''}`);
  if (unmatched.length) console.log(`  ${unmatched.length} row(s) had no matching tracking number at SanMar — left blank ON PURPOSE:\n     ${unmatched.slice(0, 10).join('\n     ')}${unmatched.length > 10 ? '\n     …' : ''}`);
  if (soapFailed.length) console.log(`  ⚠ ${soapFailed.length} PO(s) FAILED to fetch — re-run to pick them up:\n     ${soapFailed.slice(0, 10).join('\n     ')}`);
  console.log('');

  if (!APPLY) {
    console.log('DRY RUN — nothing written. Re-run with --apply once the list above looks right.');
    process.exit(0);
  }

  let ok = 0, failed = 0;
  for (const p of plan) {
    try {
      await makeCaspioRequest('PUT', `/tables/${TABLE}/records`,
        { 'q.where': `PK_ID=${parseInt(p.pk, 10)}` }, p.patch);
      ok++;
    } catch (e) {
      failed++;
      console.error(`  write failed PK_ID=${p.pk} (${p.po} / ${p.trk}): ${e.message}`);
    }
    if (ok % 50 === 0 && ok) console.log(`  …${ok}/${plan.length} written`);
  }
  console.log('');
  console.log(`WROTE ${ok} row(s), ${failed} failure(s).`);
  console.log('Re-run the dry run to confirm the remaining count is only the rows SanMar cannot answer for.');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('FATAL', e.message); process.exit(1); });
