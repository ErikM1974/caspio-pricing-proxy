/**
 * Update the CONTRACT embroidery rate card in Caspio Embroidery_Costs (Erik, 2026-09-02).
 *
 * WHY: the stitch-cost study (Pricing Index memory/EMBROIDERY_STITCH_COST_2026-09.md) showed
 * the 1-7 and 8-23 contract tiers lose money per ORDER once the $100 order cost is counted,
 * and 24-71 is thin. Erik approved the recommended card:
 *   garments  $1.25 / 1.10 / 1.00 / 0.90 / 0.85 per 1K   (was 1.10 / 1.00 / 0.90 / 0.85 / 0.80)
 *   caps      $1.10 / 1.00 / 0.90 / 0.80 / 0.75 per 1K   (was 1.00 / 0.90 / 0.80 / 0.75 / 0.70)
 *   small-order fee: NONE (LTM = 0 on every CTR row). Erik's same-day revision: a fee plus a
 *   minimum was two rules and a price cliff at 24 pcs, so the contract structure is a single
 *   $250 order minimum (Service_Codes CTR-MIN-ORDER, applied by the calculator).
 *   full back (DECG-FB): untouched here — its ladder fee serves the CUSTOM quote builder; the
 *   contract calculator ignores it and follows the CTR fee (0).
 *
 * HOW the proxy reads these rows (src/routes/pricing.js GET /contract-pricing):
 *   - rate per tier = first CTR-Garmt / CTR-Cap row per TierLabel: PerThousandRate,
 *     else EmbroideryCost / (StitchCount/1000). Every row of a tier is updated so the
 *     value is the same whichever row is read first.
 *   - fee = any row of the type with LTM > 0 (threshold 23 is fixed in the route), so
 *     LTM is written on BOTH small tiers to make the data self-describing.
 *   - full back fee/band = DECG-FB row with LTM > 0 (band = that row's tier upper bound).
 *
 * Usage:  node scripts/update-contract-card-2026-09.js            (dry run — prints the plan)
 *         node scripts/update-contract-card-2026-09.js --live     (applies the PUTs)
 * ~200 rows → per-row PUT is fine (under the CSV-import threshold in CLAUDE.md).
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { fetchAllCaspioPages, makeCaspioRequest } = require('../src/utils/caspio');

const LIVE = process.argv.includes('--live');
const GARMENT = { '1-7': 1.25, '8-23': 1.10, '24-47': 1.00, '48-71': 0.90, '72+': 0.85 };
const CAP     = { '1-7': 1.10, '8-23': 1.00, '24-47': 0.90, '48-71': 0.80, '72+': 0.75 };
const FEE = 0;                       // no contract small-order fee since 2026-09-02 (order minimum instead)
const FEE_TIERS = new Set(['1-7', '8-23']);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const num = (v) => (v === null || v === undefined || v === '' ? null : Number(v));

async function main() {
  const rows = await fetchAllCaspioPages('/tables/Embroidery_Costs/records', {
    'q.where': "ItemType='CTR-Garmt' OR ItemType='CTR-Cap' OR ItemType='DECG-FB' OR ItemType='CTR-FB'",
    'q.pageSize': 1000,
  }, { maxPages: 5 });
  console.log(`${LIVE ? 'LIVE' : 'DRY RUN'} — ${rows.length} rows read`);

  const plan = [];
  for (const r of rows) {
    const id = r.EmbroideryCostID ?? r.PK_ID;
    const tier = String(r.TierLabel || '').trim();
    let body = null;
    if (r.ItemType === 'CTR-Garmt' || r.ItemType === 'CTR-Cap') {
      const rate = (r.ItemType === 'CTR-Garmt' ? GARMENT : CAP)[tier];
      if (rate === undefined) { console.warn(`  skip ${r.ItemType} id ${id}: unknown tier '${tier}'`); continue; }
      const stitches = num(r.StitchCount) || 0;
      body = {
        PerThousandRate: rate,
        AdditionalStitchRate: rate,
        EmbroideryCost: stitches > 0 ? Math.round((stitches / 1000) * rate * 100) / 100 : num(r.EmbroideryCost),
        LTM: FEE_TIERS.has(tier) ? FEE : 0,
      };
    } else if (r.ItemType === 'DECG-FB') {
      continue;   // shared ladder (custom builder's full-back fee lives here) — not a contract setting
    } else if (r.ItemType === 'CTR-FB') {
      console.log(`  note: retired CTR-FB row id ${id} tier ${tier} left untouched (proxy ignores it)`);
      continue;
    }
    if (!body) continue;
    const before = { PerThousandRate: num(r.PerThousandRate), AdditionalStitchRate: num(r.AdditionalStitchRate), EmbroideryCost: num(r.EmbroideryCost), LTM: num(r.LTM) };
    const changed = Object.keys(body).some((k) => Number(before[k] ?? 0) !== Number(body[k]));
    if (changed) plan.push({ id, type: r.ItemType, tier, stitches: r.StitchCount, before, body });
  }

  const byType = {};
  for (const p of plan) byType[p.type] = (byType[p.type] || 0) + 1;
  console.log('rows to change:', byType);
  for (const p of plan.slice(0, 400)) {
    console.log(`  ${p.type.padEnd(9)} ${String(p.tier).padEnd(6)} ${String(p.stitches).padStart(6)} id ${String(p.id).padStart(5)}  ` +
      Object.keys(p.body).map((k) => `${k} ${p.before[k] ?? '-'}→${p.body[k]}`).join('  '));
  }
  if (!LIVE) { console.log('\nDry run only. Re-run with --live to apply.'); return; }

  let ok = 0, fail = 0;
  for (const p of plan) {
    try {
      await makeCaspioRequest('put', '/tables/Embroidery_Costs/records', { 'q.where': `EmbroideryCostID=${p.id}` }, p.body);
      ok++;
    } catch (e) {
      fail++;
      console.error(`  FAILED id ${p.id} (${p.type} ${p.tier}):`, e.message);
    }
    await sleep(120);
  }
  console.log(`\napplied ${ok} rows, ${fail} failed`);
}

main().catch((e) => { console.error(e); process.exit(1); });
