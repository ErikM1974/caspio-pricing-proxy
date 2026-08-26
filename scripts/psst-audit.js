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
 * refresh only the near dates (the far ones cannot have changed since the morning sync). A
 * failed date is reported loudly at the end and NEVER counted as "nothing arriving".
 */
const fs = require('fs');

const BASE = process.env.BASE_URL || 'https://caspio-pricing-proxy-ab30a049961a.herokuapp.com';
const OUR_ACCOUNTS = new Set(['6920-0000', '6920-0001']);
const TRANSIT = { WA: 1, OR: 1, NV: 2, AZ: 2, TX: 3, MN: 3, OH: 4, NJ: 5, FL: 5, VA: 5 };
const DEFAULT_TRANSIT = 3;
const BAND = 3;
const REFRESH_NEAR_DAYS = 3;
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

  const states = [...new Set(ours.map((r) => String(r.Whse || '').split('-')[0].toUpperCase()))].sort();
  const poCount = new Set(ours.map((r) => r['Customer PO'].replace(/\s+/g, ''))).size;
  console.log('Manifest:   ' + ours.length + ' lines / ' + poCount + ' POs');
  console.log('Warehouses: ' + states.map((s) => s + '=' + transitFor(s) + 'd').join('  '));
  console.log('Window:     ' + dates[0] + ' .. ' + dates[dates.length - 1] + '  (' + dates.length + ' business days, derived)');
  console.log('');

  const board = [];
  for (let i = 0; i < dates.length; i++) {
    const d = dates[i];
    const refresh = (!noRefresh && i < REFRESH_NEAR_DAYS) ? '&refresh=1' : '';
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
    if (!ent) { console.log('  ' + po.padEnd(10) + 'NOT FOUND'); issues.push(po + ': not on the board'); continue; }
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
  for (const t of new Set(theirs.map((x) => x['Customer PO'] + ' - ' + x['Customer Name']))) {
    console.log('  (third-party) ' + t + '  — expected absent');
  }

  console.log('');
  if (failed.length) {
    // Never let an unfetched day read as an empty one.
    console.log('WARNING: ' + failed.length + ' date(s) could not be fetched: ' + failed.join(', '));
    console.log('A PO could be hiding on those days. Re-run them before calling this clean.');
    console.log('');
  }
  console.log(issues.length
    ? 'ISSUES: ' + issues.length + '\n' + issues.map((i) => '  ' + i).join('\n')
    : 'ISSUES: 0 — manifest matches the board.');
  process.exit(issues.length || failed.length ? 1 : 0);
})();
