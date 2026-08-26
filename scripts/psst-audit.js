#!/usr/bin/env node
/**
 * PSST freight-manifest audit — reconcile SanMar's daily manifest against our inbound board.
 *
 *   node scripts/psst-audit.js "C:/path/to/FreightManifest.csv" [--no-refresh]
 *
 * WHY THIS EXISTS
 * Erik reconciles SanMar's emailed manifest against the board every morning. Done by hand it
 * means picking the arrival dates by eye, and on 2026-08-20 that quietly failed: PO 114075
 * shipped from VIRGINIA and was reported "NOT FOUND" purely because the hand-picked window
 * stopped before its arrival day. The carton was fine. The window was too short.
 *
 * 🔴 THE WINDOW IS DERIVED, NEVER TYPED. Transit is per-warehouse and the east coast is a week
 * out: WA/OR 1 day, NV/AZ 2, TX/MN 3, OH 4, NJ/FL/VA 5 — the same table /inbound-today uses
 * (TRANSIT_DAYS_BY_STATE, src/routes/sanmar-orders.js). A manifest shipped Wednesday from VA
 * lands the FOLLOWING Wednesday. This reads the ship dates and warehouses out of the CSV,
 * converts each to a business-day arrival, and covers that span plus the board's own ±3 band.
 * If TRANSIT_DAYS_BY_STATE changes, change TRANSIT here too — they are deliberately identical.
 *
 * 🔴 RATE LIMIT. inbound-today?refresh=1 rebuilds from Caspio; several at once right after a
 * sync exhausts the quota, and the endpoint then returns an ERROR. That is correct behaviour,
 * but it leaves dates unchecked — which is exactly how a PO hides. So: sequential, spaced, and
 * refresh only where this manifest's cartons can actually land. A failed date is reported
 * loudly at the end and NEVER counted as "nothing arriving".
 *
 * 🔴 REFRESH THE ARRIVAL SPAN, NOT THE FIRST N DATES. This used to be `i < REFRESH_NEAR_DAYS`
 * — the first three entries of `dates`. But `dates` starts BAND business days BEFORE the
 * earliest arrival, so those three are the OLDEST days in the window and the arrival dates
 * always sat past them, served from a 600 s cache. On 2026-08-26 that printed "NOT FOUND" for
 * all 26 POs while quietly labelling the only two dates that mattered (08-26, 08-27) `(cached)`.
 * The padding band genuinely does not need refreshing — anything landing there was synced days
 * ago — so the fix costs no extra calls in the common case. REFRESH_MAX caps a freak manifest
 * that spans many warehouses.
 *
 * 🔴 A STALE SYNC IS NOT A MISSING CARTON. The board mirrors SanMar through a once-a-day sync
 * (~05:30 PT). Audit a manifest before it runs and EVERY PO reads NOT FOUND — 26 false alarms
 * on 2026-08-26, which is how a real one gets ignored. So ask /status-summary when the mirror
 * last synced and compare it against the manifest's ship date before blaming the board.
 */
const fs = require('fs');

const BASE = process.env.BASE_URL || 'https://caspio-pricing-proxy-ab30a049961a.herokuapp.com';
const OUR_ACCOUNTS = new Set(['6920-0000', '6920-0001']);
const TRANSIT = { WA: 1, OR: 1, NV: 2, AZ: 2, TX: 3, MN: 3, OH: 4, NJ: 5, FL: 5, VA: 5 };
const DEFAULT_TRANSIT = 3;
const BAND = 3;
const REFRESH_MAX = 6;          // hard cap on refreshed dates, so a freak manifest can't blow the quota
const SPACING_MS = 6000;

const csvPath = process.argv[2];
const noRefresh = process.argv.includes('--no-refresh');
if (!csvPath || !fs.existsSync(csvPath)) {
  console.error('usage: node scripts/psst-audit.js "<manifest.csv>" [--no-refresh]');
  process.exit(1);
}

// Quoted CSV — company names contain commas.
function parseCsv(text) {
  const rows = [];
  let row = [], cur = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') { cur += '"'; i++; }
      else if (c === '"') q = false;
      else cur += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(cur); cur = ''; }
    else if (c === '\n') { row.push(cur); rows.push(row); row = []; cur = ''; }
    else if (c !== '\r') cur += c;
  }
  if (cur || row.length) { row.push(cur); rows.push(row); }
  const head = rows.shift().map((h) => h.trim());
  return rows.filter((r) => r.length > 1)
    .map((r) => Object.fromEntries(head.map((h, i) => [h, (r[i] || '').trim()])));
}

// Business-day arrival maths, matching the board's own rules.
const iso = (d) => d.toISOString().slice(0, 10);
const parseD = (s) => new Date(String(s).replace(/\//g, '-').slice(0, 10) + 'T00:00:00Z');
function observed(d) {
  const w = d.getUTCDay();
  if (w === 6) d.setUTCDate(d.getUTCDate() - 1);
  if (w === 0) d.setUTCDate(d.getUTCDate() + 1);
  return d;
}
const holidayCache = new Map();
function holidays(y) {
  if (holidayCache.has(y)) return holidayCache.get(y);
  const nth = (m, wd, n) => {
    const d = new Date(Date.UTC(y, m - 1, 1));
    let c = 0;
    for (;;) { if (d.getUTCDay() === wd && ++c === n) return iso(d); d.setUTCDate(d.getUTCDate() + 1); }
  };
  const last = (m, wd) => {
    const d = new Date(Date.UTC(y, m, 0));
    while (d.getUTCDay() !== wd) d.setUTCDate(d.getUTCDate() - 1);
    return iso(d);
  };
  const s = new Set([
    iso(observed(new Date(Date.UTC(y, 0, 1)))), last(5, 1), iso(observed(new Date(Date.UTC(y, 6, 4)))),
    nth(9, 1, 1), nth(11, 4, 4), iso(observed(new Date(Date.UTC(y, 11, 25)))),
  ]);
  holidayCache.set(y, s);
  return s;
}
const isBiz = (d) => {
  const w = d.getUTCDay();
  return w !== 0 && w !== 6 && !holidays(d.getUTCFullYear()).has(iso(d));
};
function addBusinessDays(startIso, n) {
  const d = parseD(startIso);
  const step = n < 0 ? -1 : 1;
  let left = Math.abs(n);
  while (left > 0) { d.setUTCDate(d.getUTCDate() + step); if (isBiz(d)) left--; }
  return iso(d);
}
function businessDaysBetween(a, b) {
  const out = [];
  const d = parseD(a), end = parseD(b);
  while (d <= end) { if (isBiz(d)) out.push(iso(d)); d.setUTCDate(d.getUTCDate() + 1); }
  return out;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const rows = parseCsv(fs.readFileSync(csvPath, 'utf8')).filter((r) => r['Customer PO']);
  const ours = rows.filter((r) => OUR_ACCOUNTS.has(r['Customer Account']));
  const theirs = rows.filter((r) => !OUR_ACCOUNTS.has(r['Customer Account']));
  if (!ours.length) { console.error('No rows for our accounts (6920-*) in this manifest.'); process.exit(1); }

  const transitFor = (whse) => {
    const st = String(whse || '').split('-')[0].toUpperCase();
    return TRANSIT[st] === undefined ? DEFAULT_TRANSIT : TRANSIT[st];
  };

  let lo = null, hi = null;
  for (const r of ours) {
    const est = addBusinessDays(r.ShipDate, transitFor(r.Whse));
    if (!lo || est < lo) lo = est;
    if (!hi || est > hi) hi = est;
  }
  const dates = businessDaysBetween(addBusinessDays(lo, -BAND), addBusinessDays(hi, BAND));
  // The cartons on THIS manifest can only land in [lo, hi]; the ±BAND padding exists to catch
  // an early/late arrival that was synced days ago and is therefore safe to read from cache.
  const refreshSet = new Set(businessDaysBetween(lo, hi).slice(0, REFRESH_MAX));

  // Has the mirror even seen this manifest yet? The board is a once-a-day copy of SanMar, so a
  // manifest audited before the morning sync reads as a total loss. Ask, and say so plainly.
  const maxShip = ours.map((r) => String(r.ShipDate).replace(/[/]/g, '-').slice(0, 10)).sort().pop();
  let lastSync = null, syncStale = false;
  try {
    const r = await fetch(BASE + '/api/sanmar-orders/status-summary');
    const j = await r.json();
    lastSync = j.lastSync || null;
    // <=, not <. SanMar publishes a day's shipments AFTER our ~05:30 PT sync has already
    // run, which is why the manifest arrives by email the NEXT morning. A sync stamped the
    // same day as the ship date therefore ran BEFORE these cartons existed. Only a sync
    // dated strictly after the ship date can have seen them. Measured 2026-08-26: sync
    // 08-25T12:31Z vs ship 08-25 -- `<` said fresh and printed 26 false NOT FOUNDs.
    if (lastSync) syncStale = lastSync.slice(0, 10) <= maxShip;
  } catch (e) { /* advisory only — never block the audit on it */ }

  const states = [...new Set(ours.map((r) => String(r.Whse || '').split('-')[0].toUpperCase()))].sort();
  const poCount = new Set(ours.map((r) => r['Customer PO'].replace(/\s+/g, ''))).size;
  console.log('Manifest:   ' + ours.length + ' lines / ' + poCount + ' POs');
  console.log('Warehouses: ' + states.map((s) => s + '=' + transitFor(s) + 'd').join('  '));
  console.log('Window:     ' + dates[0] + ' .. ' + dates[dates.length - 1] + '  (' + dates.length + ' business days, derived)');
  console.log('Refreshing: ' + [...refreshSet].join(', ') + '   (rest served from cache)');
  console.log('Mirror:     last synced ' + (lastSync || 'UNKNOWN') + '   manifest shipped ' + maxShip);
  if (syncStale) {
    console.log('');
    console.log('  *** THE SYNC HAS NOT RUN SINCE THIS MANIFEST SHIPPED. ***');
    console.log('  The board is a once-a-day mirror of SanMar (~05:30 PT). Every PO below will');
    console.log("  read 'not synced yet', and that is the SYNC, not a missing carton. Re-run");
    console.log('  after the morning sync before treating anything here as a discrepancy.');
  }
  console.log('');

  const board = [];
  for (let i = 0; i < dates.length; i++) {
    const d = dates[i];
    const refresh = (!noRefresh && refreshSet.has(d)) ? '&refresh=1' : '';
    let j;
    try {
      const r = await fetch(BASE + '/api/sanmar-orders/inbound-today?date=' + d + refresh);
      j = await r.json();
    } catch (e) { j = { error: e.message }; }
    if (j.error) {
      console.log('  ' + d + '  FAILED: ' + String(j.details || j.error).slice(0, 46));
      board.push({ date: d, failed: true, orders: [] });
    } else {
      console.log('  ' + d + '  ' + String((j.orders || []).length).padStart(2) + ' POs'
        + (refresh ? '' : '  (cached)'));
      board.push(j);
    }
    if (i < dates.length - 1) await sleep(SPACING_MS);
  }
  const failed = board.filter((b) => b.failed).map((b) => b.date);
  // A date inside the ARRIVAL span that could not be fetched makes every 'NOT FOUND'
  // below meaningless -- the PO may be sitting on exactly the day we failed to read.
  // The header of this file has always promised a failed date is never counted as
  // 'nothing arriving'; until 2026-08-26 it was, and a rate-limited run printed 26
  // confident 'not on the board' lines having read neither arrival date.
  const blindSpots = failed.filter((d) => refreshSet.has(d));
  const inconclusive = syncStale || blindSpots.length > 0;

  const psst = new Map();
  for (const r of ours) {
    const po = r['Customer PO'].replace(/\s+/g, '');
    if (!psst.has(po)) psst.set(po, { qty: 0, cartons: new Set(), tracking: new Set() });
    const e = psst.get(po);
    e.qty += parseInt(r['Qty shipped'], 10) || 0;
    e.cartons.add(r['Carton Number']);
    e.tracking.add(r['Tracking number'].trim().toUpperCase());
  }
  const sys = new Map();
  for (const b of board) {
    for (const o of (b.orders || [])) {
      const po = String(o.sanmarPO).replace(/\s+/g, '');
      if (!sys.has(po)) sys.set(po, []);
      sys.get(po).push({ date: b.date, o });
    }
  }

  console.log('');
  console.log('PSST -> BOARD');
  const issues = [];
  for (const po of [...psst.keys()].sort()) {
    const p = psst.get(po);
    const ent = sys.get(po);
    if (!ent) {
      const why = syncStale ? 'not synced yet'
        : blindSpots.length ? 'UNKNOWN (arrival date unread)'
        : 'NOT FOUND';
      console.log('  ' + po.padEnd(10) + why);
      issues.push(po + (syncStale ? ': not synced yet (mirror is behind the ship date)'
        : blindSpots.length ? ': unverifiable -- ' + blindSpots.join('/') + ' could not be read'
        : ': not on the board'));
      continue;
    }
    // 🔴 Compare CARTON BY CARTON, matched on tracking number — never PO totals.
    // The manifest is ONE DAY's shipment; the board holds every carton of the PO. A split
    // shipment therefore always "mismatches" on totals: PO 113982 shipped three cartons on
    // three separate days, and comparing 5 manifest pieces against the PO's 8 looked like a
    // defect when both sides were right. Matching on tracking compares like with like.
    const boxes = ent.flatMap((x) => (x.o.boxDetail || []).map((b) => ({
      trk: String(b.trackingNumber || '').toUpperCase(),
      pieces: b.pieces || 0,
    })));
    const onManifest = boxes.filter((b) => p.tracking.has(b.trk));
    const pcs = onManifest.reduce((s, b) => s + b.pieces, 0);
    const bx = new Set(onManifest.map((b) => b.trk)).size;
    const trk = new Set(boxes.map((b) => b.trk));
    const missing = [...p.tracking].filter((t) => !trk.has(t));
    const otherDays = boxes.length - onManifest.length;
    const ok = pcs === p.qty && bx === p.tracking.size && !missing.length;
    // A split shipment can span four days; show the span rather than every date, or the
    // column overflows and shunts the company name out of alignment.
    const days = [...new Set(ent.map((x) => x.date))].sort();
    const when = days.length > 2
      ? days[0] + '..' + days[days.length - 1] + ' (' + days.length + 'd)'
      : days.join('/');
    console.log('  ' + po.padEnd(10)
      + when.padEnd(26)
      + String(ent[0].o.company || '').slice(0, 24).padEnd(25)
      + 'pcs ' + String(pcs).padStart(4) + '/' + String(p.qty).padEnd(5)
      + 'ctn ' + bx + '/' + p.tracking.size + '   ' + (ok ? 'OK' : 'CHECK')
      + (otherDays ? '  (+' + otherDays + ' carton(s) from other days)' : ''));
    if (pcs !== p.qty) issues.push(po + ': pieces ' + pcs + ' vs ' + p.qty);
    if (bx !== p.tracking.size) issues.push(po + ': cartons ' + bx + ' vs ' + p.tracking.size);
    for (const t of missing) issues.push(po + ': tracking ' + t + ' missing');
  }
  // 🔴 THIRD-PARTY POs STAY OFF THE BOARD — DECIDED, NOT AN OVERSIGHT (Erik, 2026-08-26).
  //
  // 8 of 12 manifests carry POs on somebody else's SanMar account: Custom Prints NW,
  // Premium Products NW, Northwest Souvenirs, Donahue Graphics, In Graphic Detail,
  // Armageddon Graphics. Six of the seven are OUR contract-decorating customers (all
  // Ruthie's accounts), they name us as decorator, and the freight does reach Freeman Road —
  // so it looks like a hole in the receiving sheet. It is not one we are filling.
  //
  // Ruthie receives the PSST manifest by email every morning and reads it directly. The
  // SanMar API cannot help either way: our PromoStandards credentials are scoped to account
  // 6920, so a PO on another account returns ZERO shipments (verified on PO 10646). The only
  // source is the CSV she already has.
  //
  // If you are about to "fix" this: don't. Ask Erik first. This has been raised and closed.
  for (const t of new Set(theirs.map((x) => x['Customer PO'] + ' - ' + x['Customer Name']))) {
    console.log('  (third-party) ' + t + '  — expected absent, by decision');
  }

  console.log('');
  if (failed.length) {
    // Never let an unfetched day read as an empty one.
    console.log('WARNING: ' + failed.length + ' date(s) could not be fetched: ' + failed.join(', '));
    console.log('A PO could be hiding on those days. Re-run them before calling this clean.');
    console.log('');
  }
  if (inconclusive && issues.length) {
    console.log('INCONCLUSIVE: ' + issues.length + ' item(s) could not be checked.');
    if (syncStale) {
      console.log('  The mirror is BEHIND the manifest (last synced ' + lastSync + ',');
      console.log('  manifest shipped ' + maxShip + '). Re-run after the morning sync.');
    }
    if (blindSpots.length) {
      console.log('  Arrival date(s) ' + blindSpots.join(', ') + ' could not be read, so a PO');
      console.log('  reported missing may simply be sitting on a day we never fetched.');
      console.log('  Caspio rate-limits hardest right after the morning sync -- wait and re-run.');
    }
    console.log('  Nothing above is a confirmed discrepancy.');
  } else {
    console.log(issues.length
      ? 'ISSUES: ' + issues.length + '\n' + issues.map((i) => '  ' + i).join('\n')
      : 'ISSUES: 0 — manifest matches the board.');
  }
  process.exit(issues.length || failed.length ? 1 : 0);
})();
