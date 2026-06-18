// Custom / oversize decal pricing route — backs the contract sticker AI bot's
// quote_custom_decal tool + the "Custom & Oversize Decal" rate card on
// /calculators/sticker-manual-pricing.html.
//
// WHY THIS EXISTS (2026-06-18): the standard Sticker_Pricing grid is a fixed
// (size, qty) -> price table that maxes out at 6x6 and a 50-piece minimum. It
// can't price oversize logo decals (12", 18", 24"+) or odd/custom dimensions in
// small quantities — those used to be punted to "Erik will follow up". This route
// prices them by the SQUARE FOOT of finished (bounding-box) area, on a declining
// volume ladder calibrated to the 6x6 grid column (matches it within ~3%), so the
// two systems stay consistent. Decals are ganged/nested on the 54" Roland and
// machine contour-cut, so the rate already includes cutting + a waste allowance.
//
// Source of truth: Caspio table `Custom_Decal_Pricing`. Inline fallback below
// keeps the route working before the CSV is imported (see
// caspio-pricing-proxy/scripts/custom-decal-pricing-caspio-import.csv).
//
// Pricing model (per ORDER / per line):
//   totalSqFt   = (W" x H" / 144) x qty                 (finished bounding-box area)
//   material    = max(MIN_MATERIAL, totalSqFt x rate(totalSqFt))
//   rate(sqft)  = declining ladder (DECAL-SQFT-T1..T6 rows)
//   + GRT-50 $50 one-time art setup (new art; waived if art on file)
//   + RUSH-25PCT 1.25x if rush
// Keep IN SYNC with the frontend card render in
// shared_components/js/sticker-pricing-page.js and the rate card documented in
// /memory/CUSTOM_DECAL_PRICING_2026-06.md.

const express = require('express');
const router = express.Router();
const { fetchAllCaspioPages } = require('../utils/caspio');

// Inline fallback — KEEP IN SYNC with Custom_Decal_Pricing Caspio rows + the CSV.
// Tier rows: declining $/sqft by total finished sq ft. The DECAL-MIN row carries
// the flat minimum material charge (FlatAmount), not a per-sqft rate.
const INLINE_RATES = [
  { PartNumber: 'DECAL-SQFT-T1', Description: 'Custom decal — up to 50 sq ft',    MinSqFt: 0,    MaxSqFt: 50,     RatePerSqFt: 12.00, FlatAmount: 0,  Notes: 'Small / single-design custom & oversize decal runs.' },
  { PartNumber: 'DECAL-SQFT-T2', Description: 'Custom decal — 50 to 125 sq ft',   MinSqFt: 50,   MaxSqFt: 125,    RatePerSqFt: 9.50,  FlatAmount: 0,  Notes: '' },
  { PartNumber: 'DECAL-SQFT-T3', Description: 'Custom decal — 125 to 250 sq ft',  MinSqFt: 125,  MaxSqFt: 250,    RatePerSqFt: 7.50,  FlatAmount: 0,  Notes: '' },
  { PartNumber: 'DECAL-SQFT-T4', Description: 'Custom decal — 250 to 500 sq ft',  MinSqFt: 250,  MaxSqFt: 500,    RatePerSqFt: 6.00,  FlatAmount: 0,  Notes: '' },
  { PartNumber: 'DECAL-SQFT-T5', Description: 'Custom decal — 500 to 1000 sq ft', MinSqFt: 500,  MaxSqFt: 1000,   RatePerSqFt: 5.25,  FlatAmount: 0,  Notes: '' },
  { PartNumber: 'DECAL-SQFT-T6', Description: 'Custom decal — over 1000 sq ft',   MinSqFt: 1000, MaxSqFt: 999999, RatePerSqFt: 4.80,  FlatAmount: 0,  Notes: 'High-volume / large-format.' },
  { PartNumber: 'DECAL-MIN',     Description: 'Minimum material charge',           MinSqFt: 0,    MaxSqFt: 0,      RatePerSqFt: 0,     FlatAmount: 90, Notes: 'Floor for tiny custom runs (before the $50 art setup).' },
];

const SETUP_FEE_PART = 'GRT-50';   // shared one-time art setup, same as stickers/banners
const SETUP_FEE_AMOUNT = 50.00;
const DEFAULT_MIN_MATERIAL = 90.00;

/**
 * Load the decal rate card. Tries Caspio `Custom_Decal_Pricing` first; falls back
 * to INLINE_RATES. Returns { tiers: [...], minMaterial, source }.
 */
async function loadDecalRates() {
  let rows = null;
  try {
    const fetched = await fetchAllCaspioPages('/tables/Custom_Decal_Pricing/records', {
      'q.select': 'PartNumber,Description,MinSqFt,MaxSqFt,RatePerSqFt,FlatAmount,Notes',
      'q.pageSize': 100,
    });
    if (Array.isArray(fetched) && fetched.length) rows = fetched;
  } catch (err) {
    console.warn('[custom-decal-pricing] Caspio fetch failed, using inline:', err.message);
  }
  const source = rows ? 'caspio' : 'inline';
  const raw = (rows || INLINE_RATES).map(r => ({
    PartNumber: String(r.PartNumber || '').trim(),
    Description: String(r.Description || '').trim(),
    MinSqFt: Number(r.MinSqFt) || 0,
    MaxSqFt: Number(r.MaxSqFt) || 0,
    RatePerSqFt: Number(r.RatePerSqFt) || 0,
    FlatAmount: Number(r.FlatAmount) || 0,
    Notes: String(r.Notes || '').trim(),
  })).filter(r => r.PartNumber);

  const minRow = raw.find(r => r.PartNumber === 'DECAL-MIN');
  const minMaterial = minRow && minRow.FlatAmount > 0 ? minRow.FlatAmount : DEFAULT_MIN_MATERIAL;
  const tiers = raw
    .filter(r => r.RatePerSqFt > 0 && r.MaxSqFt > 0)
    .sort((a, b) => a.MaxSqFt - b.MaxSqFt);

  return { tiers, minMaterial, source };
}

function round2(n) { return Math.round(n * 100) / 100; }

/**
 * Pick the tier for a given total sq ft. Returns { tier, index }.
 * Tiers are sorted ascending by MaxSqFt; the last tier covers everything above.
 */
function pickTier(tiers, sqft) {
  for (let i = 0; i < tiers.length; i++) {
    if (sqft <= tiers[i].MaxSqFt) return { tier: tiers[i], index: i };
  }
  return { tier: tiers[tiers.length - 1], index: tiers.length - 1 };
}

/**
 * Per-tier CLIFF-PROTECTION floor: a tier's material charge can never be lower
 * than the TOP price of the previous tier (prevMaxSqFt × prevRate). This keeps
 * pricing monotonic — a 51 sq ft order can't cost less than a 50 sq ft order.
 * Floors are DERIVED from the ladder (not stored), so changing a rate in Caspio
 * automatically recomputes them. Tier 0 floors at the global $90 minimum.
 *   tier 1 (50–125)   → 50  × $12.00 = $600.00
 *   tier 2 (125–250)  → 125 × $9.50  = $1,187.50
 *   tier 3 (250–500)  → 250 × $7.50  = $1,875.00
 *   tier 4 (500–1000) → 500 × $6.00  = $3,000.00
 *   tier 5 (>1000)    → 1000× $5.25  = $5,250.00
 */
function tierFloor(tiers, index, minMaterial) {
  if (index <= 0) return minMaterial;
  const prev = tiers[index - 1];
  return round2(prev.MaxSqFt * prev.RatePerSqFt);
}

/**
 * Compute a custom-decal quote. Bands on WHOLE-ORDER finished square footage:
 * pass a single size ({widthIn, heightIn, qty}) OR a mixed-size order
 * ({ items: [{widthIn, heightIn, qty}, ...] }). All items' sq ft are summed,
 * one tier + one cliff-protected floor applies to the whole order, and the
 * material charge is split back across the lines in proportion to their sq ft.
 *
 * @returns quote payload or { error }
 */
async function computeDecalQuote(args = {}) {
  const rawItems = Array.isArray(args.items) && args.items.length
    ? args.items
    : [{ widthIn: args.widthIn, heightIn: args.heightIn, qty: args.qty }];

  const items = [];
  for (const it of rawItems) {
    const w = Number(it.widthIn);
    const h = Number(it.heightIn);
    const q = Math.trunc(Number(it.qty));
    if (!Number.isFinite(w) || w <= 0 || !Number.isFinite(h) || h <= 0
        || !Number.isFinite(q) || q <= 0) {
      return { error: 'bad_input', message: 'each item needs positive widthIn, heightIn, qty' };
    }
    items.push({ w, h, q, sqFtEach: (w * h) / 144, sqFt: (w * h) / 144 * q });
  }

  const { tiers, minMaterial } = await loadDecalRates();
  if (!tiers.length) return { error: 'config_missing', message: 'No decal rate tiers found' };

  const totalSqFt = items.reduce((s, it) => s + it.sqFt, 0);
  const { tier, index } = pickTier(tiers, totalSqFt);
  const rate = tier.RatePerSqFt;
  const floor = tierFloor(tiers, index, minMaterial);

  const rawMaterial = round2(totalSqFt * rate);
  let material = Math.max(rawMaterial, floor);
  const floorApplied = material > rawMaterial + 1e-9;

  // Rush — shared RUSH-25PCT modifier (lives in Banner_Pricing). 1.25x fallback.
  let rushMultiplier = null;
  let rushApplied = false;
  if (args.rush === true || args.rush === 'true' || args.rush === '1') {
    try {
      const { loadBannerRates } = require('./banner-pricing');
      const { rates } = await loadBannerRates();
      const rushRow = rates.find(r => r.PartNumber === 'RUSH-25PCT');
      rushMultiplier = rushRow ? Number(rushRow.Rate) : 1.25;
    } catch (e) {
      rushMultiplier = 1.25;
    }
    material = round2(material * rushMultiplier);
    rushApplied = true;
  }
  material = round2(material);

  // Split the order material back across the lines by sq ft share. Penny
  // remainder lands on the last line so the lines always sum to `material`.
  const lineItems = [];
  let allocated = 0;
  items.forEach((it, i) => {
    const isLast = i === items.length - 1;
    const lineTotal = isLast
      ? round2(material - allocated)
      : round2(material * (it.sqFt / totalSqFt));
    allocated = round2(allocated + lineTotal);
    lineItems.push({
      partNumber: `DECAL-${Math.round(it.w)}X${Math.round(it.h)}`,
      size: `${it.w}x${it.h}`,
      width: it.w,
      height: it.h,
      quantity: it.q,
      sqFtEach: round2(it.sqFtEach),
      sqFt: round2(it.sqFt),
      totalPrice: lineTotal,
      pricePerSticker: round2(lineTotal / it.q),
      description: `${it.w}"×${it.h}" full-color die-cut decal`,
    });
  });

  const single = lineItems.length === 1 ? lineItems[0] : null;

  return {
    offGrid: false,
    productType: 'custom_decal',
    partNumber: single ? single.partNumber : `DECAL-ORDER-${lineItems.length}`,
    description: single ? single.description : `Custom decal order — ${lineItems.length} sizes`,
    quantity: items.reduce((s, it) => s + it.q, 0),
    totalSqFt: round2(totalSqFt),
    ratePerSqFt: rate,
    tier: tier.PartNumber,
    tierFloor: floor,
    pricePerSticker: single ? single.pricePerSticker : null,
    totalPrice: material,
    lineItems,
    appliedRules: {
      squareFoot: `${round2(totalSqFt)} sq ft × $${rate.toFixed(2)}/sq ft (tier ${tier.PartNumber})`,
      tierFloor: floorApplied
        ? `Charged the $${floor.toFixed(2)} tier minimum (cliff protection — never less than the previous tier's top price)`
        : null,
      rush: rushApplied ? `${rushMultiplier}× multiplier applied for rush production (under 5 working days)` : null,
    },
    setupFee: {
      partNumber: SETUP_FEE_PART,
      amount: SETUP_FEE_AMOUNT,
      note: 'One-time art setup fee — waived if customer has approved artwork on file.',
    },
    requested: { items: items.map(it => ({ widthIn: it.w, heightIn: it.h, qty: it.q })), rush: rushApplied },
  };
}

// --- Routes ------------------------------------------------------------------

// Rate card (for the frontend reference panel). Each tier carries its derived
// cliff-protection floor so the page can show the "never less than" column.
router.get('/custom-decal-pricing', async (_req, res) => {
  const { tiers, minMaterial, source } = await loadDecalRates();
  const tiersWithFloor = tiers.map((t, i) => ({ ...t, floor: tierFloor(tiers, i, minMaterial) }));
  res.json({
    tiers: tiersWithFloor,
    minMaterial,
    setupFee: {
      partNumber: SETUP_FEE_PART,
      amount: SETUP_FEE_AMOUNT,
      description: 'Art Setup Fee — one-time charge for new artwork',
    },
    formula: '(Width" × Height" ÷ 144) × Qty = total sq ft → × the $/sq ft for that band (min $' + minMaterial.toFixed(2) + '), + $50 art setup',
    scope: 'Use for sizes larger than 6×6, odd/custom dimensions, or small custom runs. Standard squares 2×2–6×6 at 50+ pcs use the standard sticker grid.',
    safeRollWidthIn: 52,  // Roland print/cut safe width — if BOTH dims exceed this the decal needs paneling/rotation/custom review
    source,
  });
});

// Direct quote endpoint (mirror of /sticker-pricing/quote and /banner-pricing/quote).
router.get('/custom-decal-pricing/quote', async (req, res) => {
  const result = await computeDecalQuote({
    widthIn: req.query.width,
    heightIn: req.query.height,
    qty: req.query.qty,
    rush: req.query.rush === 'true' || req.query.rush === '1',
  });
  if (result.error) return res.status(400).json(result);
  res.json(result);
});

module.exports = router;
module.exports.loadDecalRates = loadDecalRates;
module.exports.computeDecalQuote = computeDecalQuote;
module.exports.SETUP_FEE_PART = SETUP_FEE_PART;
module.exports.SETUP_FEE_AMOUNT = SETUP_FEE_AMOUNT;
