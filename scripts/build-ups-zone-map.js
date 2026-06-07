#!/usr/bin/env node
/**
 * Build the EXACT origin-983 destination-prefix → UPS Ground zone map and write it into
 * data/ups-ground-rates.json (zonePrefixMap). Once populated, the freight estimator stops
 * using the approximate ZIP-range fallback and returns rough:false.
 *
 * STEP 1 (manual, one-time): download the origin-983 zone chart in a BROWSER — UPS blocks
 *   automated fetches. Either URL works:
 *     https://www.ups.com/media/us/currentrates/zone-txt/983.txt   (preferred — easiest to parse)
 *     https://www.ups.com/media/us/currentrates/zone-csv/983.xls   (save As .csv)
 *   Save it somewhere, e.g. data/ups-983-zone-chart.txt
 *
 * STEP 2:  node scripts/build-ups-zone-map.js data/ups-983-zone-chart.txt
 *
 * The UPS zone .txt lists destination ZIP prefixes (single "100" or range "010-069") with
 * a column per service; the FIRST numeric zone column is Ground. This parser is best-effort:
 * it logs how many prefixes it mapped so you can eyeball it before trusting the estimate.
 */
const fs = require('fs');
const path = require('path');

const inFile = process.argv[2];
if (!inFile) {
  console.error('Usage: node scripts/build-ups-zone-map.js <path-to-983-zone-file.txt|csv>');
  process.exit(1);
}
const RATES_FILE = path.join(__dirname, '..', 'data', 'ups-ground-rates.json');

function expandPrefixes(token) {
  // "100" → ["100"]; "010-069" → ["010".."069"]
  const m = String(token).trim().match(/^(\d{3})\s*-\s*(\d{3})$/);
  if (m) {
    const out = [];
    for (let n = parseInt(m[1], 10); n <= parseInt(m[2], 10); n++) out.push(String(n).padStart(3, '0'));
    return out;
  }
  const s = String(token).trim().match(/^(\d{3})$/);
  return s ? [s[1]] : [];
}

function parse(text) {
  const map = {};
  const lines = text.split(/\r?\n/);
  for (const line of lines) {
    if (!line.trim()) continue;
    // split on comma OR whitespace runs
    const cells = line.split(/[,\t]|\s{2,}/).map((c) => c.trim()).filter(Boolean);
    if (cells.length < 2) continue;
    const prefixes = expandPrefixes(cells[0]);
    if (!prefixes.length) continue;
    // first cell after the prefix that is a 1-2 digit number = Ground zone
    let zone = null;
    for (let i = 1; i < cells.length; i++) {
      const z = cells[i].match(/^(\d{1,2})$/);
      if (z) { zone = parseInt(z[1], 10); break; }
    }
    if (zone == null || zone < 2 || zone > 8) continue;
    prefixes.forEach((p) => { map[p] = zone; });
  }
  return map;
}

try {
  const text = fs.readFileSync(inFile, 'utf8');
  const map = parse(text);
  const count = Object.keys(map).length;
  if (count < 100) {
    console.warn(`Only mapped ${count} prefixes — the file format may differ from what this parser expects.`);
    console.warn('Open the file and check: it should have a destination ZIP-prefix column and a Ground zone column.');
  }
  const rates = JSON.parse(fs.readFileSync(RATES_FILE, 'utf8'));
  rates.zonePrefixMap = map;
  fs.writeFileSync(RATES_FILE, JSON.stringify(rates, null, 2) + '\n');
  console.log(`Wrote ${count} destination prefixes → zone into ${RATES_FILE} (zonePrefixMap).`);
  console.log('Spot check:', ['983', '980', '972', '900', '606', '100'].map((p) => `${p}=${map[p] ?? '?'}`).join('  '));
  console.log('The estimator now returns rough:false for mapped prefixes. Restart/redeploy the proxy to load it.');
} catch (err) {
  console.error('Failed:', err.message);
  process.exit(1);
}
