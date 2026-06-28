// Seed `Safety_Stripe_Top_Sellers_2026` from Erik's "Safety Stripe Top Sellers"
// list (13-yr repeat sellers). Resolves each style's real SanMar CATALOG_COLOR
// for its safety color via the LIVE proxy /api/product-colors (so the route's
// image hydration matches), then writes ranked records. Idempotent: deletes all
// existing rows first.
//
//   node scripts/safety-stripe-seed.js

const { makeCaspioRequest } = require('../src/utils/caspio');

const TABLE = 'Safety_Stripe_Top_Sellers_2026';
const RESOURCE = `/tables/${TABLE}/records`;
const PROXY = process.env.LIVE_PROXY || 'https://caspio-pricing-proxy-ab30a049961a.herokuapp.com';

// style_rank = by total units sold across colors; color_rank = within style.
const ROWS = [
  { style: 'PC55',   color: 'Safety Green',  title: 'Port & Company Core Blend Tee',                              cat: 'Tee',             units: 2882, sRank: 1, cRank: 1 },
  { style: 'PC55',   color: 'Safety Orange', title: 'Port & Company Core Blend Tee',                              cat: 'Tee',             units: 2389, sRank: 1, cRank: 2 },
  { style: '2000',   color: 'Safety Green',  title: 'Gildan Ultra Cotton 100% Cotton T-Shirt',                    cat: 'Tee',             units: 2211, sRank: 2, cRank: 1 },
  { style: '2000',   color: 'Safety Orange', title: 'Gildan Ultra Cotton 100% Cotton T-Shirt',                    cat: 'Tee',             units: 1519, sRank: 2, cRank: 2 },
  { style: '29M',    color: 'Safety Green',  title: 'Jerzees Dri-POWER ACTIVE 5.6 oz 50/50 T-Shirt',              cat: 'Tee',             units: 1239, sRank: 3, cRank: 1 },
  { style: '29M',    color: 'Safety Orange', title: 'Jerzees Dri-POWER ACTIVE 5.6 oz 50/50 T-Shirt',              cat: 'Tee',             units: 701,  sRank: 3, cRank: 2 },
  { style: 'PC55LS', color: 'Safety Green',  title: 'Port & Company Long Sleeve Core Blend Tee',                  cat: 'Long Sleeve Tee', units: 1075, sRank: 4, cRank: 1 },
  { style: 'PC55LS', color: 'Safety Orange', title: 'Port & Company Long Sleeve Core Blend Tee',                  cat: 'Long Sleeve Tee', units: 766,  sRank: 4, cRank: 2 },
  { style: '18500',  color: 'Safety Orange', title: 'Gildan Heavy Blend Hooded Sweatshirt',                       cat: 'Hoodie',          units: 1050, sRank: 5, cRank: 1 },
  { style: '18500',  color: 'Safety Green',  title: 'Gildan Heavy Blend Hooded Sweatshirt',                       cat: 'Hoodie',          units: 599,  sRank: 5, cRank: 2 },
  { style: 'PC90H',  color: 'Safety Green',  title: 'Port & Company Essential Fleece Pullover Hooded Sweatshirt', cat: 'Hoodie',          units: 848,  sRank: 6, cRank: 1 },
  { style: 'PC90H',  color: 'Safety Orange', title: 'Port & Company Essential Fleece Pullover Hooded Sweatshirt', cat: 'Hoodie',          units: 661,  sRank: 6, cRank: 2 },
  { style: 'CSV405', color: 'Safety Yellow', title: 'CornerStone ANSI 107 Class 2 Mesh Back Safety Vest',         cat: 'Safety Vest',     units: 799,  sRank: 7, cRank: 1 },
  { style: '12500',  color: 'Safety Orange', title: 'Gildan DryBlend Pullover Hooded Sweatshirt',                 cat: 'Hoodie',          units: 582,  sRank: 8, cRank: 1 },
  { style: 'PC90HT', color: 'Safety Orange', title: 'Port & Company Tall Essential Fleece Pullover Hooded Sweatshirt', cat: 'Hoodie',      units: 71,   sRank: 9, cRank: 1 },
];

const colorCache = {};
async function colorsFor(style) {
  if (colorCache[style]) return colorCache[style];
  try {
    const r = await fetch(`${PROXY}/api/product-colors?styleNumber=${encodeURIComponent(style)}`);
    const j = await r.json();
    const colors = Array.isArray(j) ? j : (j.colors || j.Result || []);
    colorCache[style] = colors;
    return colors;
  } catch (e) {
    console.warn('colorsFor failed', style, e.message);
    colorCache[style] = [];
    return [];
  }
}

function matchColor(colors, safetyName) {
  const sn = safetyName.toLowerCase();        // "safety orange"
  const hue = sn.split(' ').pop();            // "orange"
  const norm = (s) => String(s || '').toLowerCase().replace(/\s+/g, '');
  // A genuine hi-vis match: "Safety X", "S. X"/"S X" (Gildan), or "Neon/Hi-Vis X".
  // We deliberately do NOT fall back to a plain hue (e.g. "Texas Orange",
  // regular "Orange") — those aren't hi-vis, so we warn instead of mismatching.
  const isSafetyHue = (c) => {
    const n = (c.COLOR_NAME || '').toLowerCase();
    const cc = (c.CATALOG_COLOR || '').toLowerCase();
    return (
      (n.includes('safety') && n.includes(hue)) ||
      (cc.includes('safety') && cc.includes(hue)) ||
      (/^s\.?\s+\w/.test(n) && n.includes(hue)) ||   // "S. Orange", "S Orange"
      (/^s\s+\w/.test(cc) && cc.includes(hue)) ||
      ((n.includes('neon') || n.includes('hi') || n.includes('vis') || n.includes('hivis')) && n.includes(hue))
    );
  };
  return (
    colors.find((c) => (c.COLOR_NAME || '').toLowerCase() === sn) ||
    colors.find((c) => norm(c.CATALOG_COLOR) === norm(safetyName)) ||
    colors.find(isSafetyHue) ||
    null
  );
}

(async () => {
  // 1. Clear existing rows (idempotent re-seed)
  try {
    await makeCaspioRequest('delete', RESOURCE, { 'q.where': 'PK_ID>0' });
    console.log('CLEARED existing rows');
  } catch (e) {
    console.warn('clear skipped:', e.message);
  }

  // 2. Resolve catalog_color + insert
  let ok = 0, warn = 0;
  for (const row of ROWS) {
    const colors = await colorsFor(row.style);
    const match = matchColor(colors, row.color);
    const catalogColor = match ? (match.CATALOG_COLOR || match.COLOR_NAME) : row.color;
    const colorName = match ? (match.COLOR_NAME || row.color) : row.color;
    const hasImg = !!(match && (match.FRONT_MODEL || match.FRONT_FLAT || match.COLOR_SQUARE_IMAGE));
    if (!match) { warn++; console.warn(`  ⚠ no SanMar color match: ${row.style} / ${row.color} (storing '${catalogColor}')`); }

    const record = {
      style: row.style,
      style_rank: row.sRank,
      product_title: row.title,
      category: row.cat,
      color_name: colorName,
      catalog_color: catalogColor,
      color_rank: row.cRank,
      units_sold: row.units,
      is_active: 'Yes',
      best_for: '',
    };
    try {
      await makeCaspioRequest('post', RESOURCE, {}, record);
      ok++;
      console.log(`  + ${row.style.padEnd(7)} ${colorName.padEnd(16)} catalog='${catalogColor}' img=${hasImg ? 'Y' : 'n'} units=${row.units}`);
    } catch (e) {
      console.error(`  ✗ insert failed ${row.style}/${row.color}:`, e.message);
    }
  }
  console.log(`DONE inserted=${ok} colorWarnings=${warn} of ${ROWS.length}`);
})();
