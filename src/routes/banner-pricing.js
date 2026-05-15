// Banner pricing route — backs the AI quote tool quote_banner_price and the
// banner info card on /calculators/sticker-manual-pricing.html.
//
// Source of truth: Caspio table `Banner_Pricing` (rate card, ~5 rows).
// Unlike Sticker_Pricing which is a fixed (size, qty) → price grid, banners
// price continuously: width × height ÷ 144 × per-sqft rate × qty, with a
// minimum-order floor and optional finishing add-ons.
//
// Schema:
//   PartNumber (Text 255, should be Unique)
//   Description (Text 255)
//   PriceType (Text 255) — "per_sqft" | "minimum" | "per_unit" | "per_lf" | "multiplier"
//   Rate (Number) — dollar amount (or multiplier for double-sided)
//   Unit (Text 255) — "sqft" | "order" | "grommet" | "linear_foot" | "multiplier"
//   IsDefault (Text 255) — "Yes" / "No" (the row that's included by default)
//   Notes (Text 255)
//
// Inline fallback keeps the API working before the CSV is imported.

const express = require('express');
const router = express.Router();
const { fetchAllCaspioPages } = require('../utils/caspio');

// Inline fallback — keep in sync with C:\Users\erik\Downloads\banner-pricing-caspio-import.csv.
const INLINE_RATES = [
  {
    PartNumber: 'BAN-SQFT',
    Description: 'Standard 13oz vinyl banner — printed',
    PriceType: 'per_sqft',
    Rate: 10.00,
    Unit: 'sqft',
    IsDefault: true,
    Notes: 'Includes hemmed edges + 4 corner grommets. Width x Height inches / 144 = sqft.',
  },
  {
    PartNumber: 'BAN-MIN',
    Description: 'Minimum banner order charge',
    PriceType: 'minimum',
    Rate: 40.00,
    Unit: 'order',
    IsDefault: true,
    Notes: 'Any banner pricing below this rounds up to $40.',
  },
  {
    PartNumber: 'BAN-GROMMET',
    Description: 'Additional grommet (beyond the 4 corners included)',
    PriceType: 'per_unit',
    Rate: 0.50,
    Unit: 'grommet',
    IsDefault: false,
    Notes: 'Standard banners ship with 4 corner grommets. Add 1 per 2 ft of perimeter for outdoor use.',
  },
  {
    PartNumber: 'BAN-POLE-POCKET',
    Description: 'Pole pocket (top, bottom, or both)',
    PriceType: 'per_lf',
    Rate: 2.50,
    Unit: 'linear_foot',
    IsDefault: false,
    Notes: 'Sewn pocket for hanging pole. Specify top / bottom / both.',
  },
  {
    PartNumber: 'BAN-DOUBLE-SIDE',
    Description: 'Double-sided print add-on',
    PriceType: 'multiplier',
    Rate: 1.80,
    Unit: 'multiplier',
    IsDefault: false,
    Notes: 'Multiply the BAN-SQFT subtotal by 1.80 — covers second-side print + blockout liner.',
  },
];

const SETUP_FEE_PART = 'GRT-50';      // Shared with stickers
const SETUP_FEE_AMOUNT = 50.00;

/**
 * Load rate-card rows. Tries Caspio first; falls back to INLINE_RATES.
 * Returns { rates: [...], source: 'caspio' | 'inline' }.
 */
async function loadBannerRates() {
  try {
    const rows = await fetchAllCaspioPages('/tables/Banner_Pricing/records', {
      'q.select': 'PartNumber,Description,PriceType,Rate,Unit,IsDefault,Notes',
      'q.pageSize': 50,
    });
    if (Array.isArray(rows) && rows.length) {
      const isTruthy = v => v === true || v === 1 || v === '1'
        || (typeof v === 'string' && /^(yes|y|true)$/i.test(v.trim()));
      const rates = rows
        .map(r => ({
          PartNumber: String(r.PartNumber || '').trim(),
          Description: String(r.Description || '').trim(),
          PriceType: String(r.PriceType || '').trim(),
          Rate: Number(r.Rate) || 0,
          Unit: String(r.Unit || '').trim(),
          IsDefault: isTruthy(r.IsDefault),
          Notes: String(r.Notes || '').trim(),
        }))
        .filter(r => r.PartNumber && r.PriceType);
      if (rates.length) return { rates, source: 'caspio' };
    }
  } catch (err) {
    console.warn('[banner-pricing] Caspio fetch failed, falling back to inline:', err.message);
  }
  return { rates: INLINE_RATES, source: 'inline' };
}

/**
 * Helper: lookup a single rate by PartNumber. Returns the rate row or null.
 */
function findRate(rates, partNumber) {
  return rates.find(r => r.PartNumber === partNumber) || null;
}

/**
 * Compute a banner quote given width/height/qty + optional finishing extras.
 * Used by the AI's quote_banner_price tool AND callable directly via
 * GET /api/banner-pricing/quote.
 *
 * @param {object} args - { widthIn, heightIn, qty, extras }
 *   extras: { grommetCount?: number, polePockets?: 'top'|'bottom'|'both', doubleSided?: boolean }
 * @returns quote payload or { error: '...' }
 */
async function computeBannerQuote({ widthIn, heightIn, qty, extras = {} }) {
  const w = Number(widthIn);
  const h = Number(heightIn);
  const q = Math.trunc(Number(qty));
  if (!Number.isFinite(w) || w <= 0 || !Number.isFinite(h) || h <= 0
      || !Number.isFinite(q) || q <= 0) {
    return { error: 'bad_input', message: 'widthIn, heightIn, qty must all be positive numbers' };
  }

  const { rates } = await loadBannerRates();
  const sqft = (w * h) / 144;
  const baseRate = findRate(rates, 'BAN-SQFT');
  const minimum = findRate(rates, 'BAN-MIN');
  const doubleSideRate = findRate(rates, 'BAN-DOUBLE-SIDE');
  const grommetRate = findRate(rates, 'BAN-GROMMET');
  const polePocketRate = findRate(rates, 'BAN-POLE-POCKET');

  if (!baseRate) return { error: 'config_missing', message: 'BAN-SQFT rate not found' };

  // Per-banner base price (before extras): sqft × rate, floored to minimum.
  let perBannerBase = sqft * baseRate.Rate;
  let minimumApplied = false;
  if (minimum && perBannerBase < minimum.Rate) {
    perBannerBase = minimum.Rate;
    minimumApplied = true;
  }

  // Double-sided multiplier (applies to the per-banner base BEFORE finishing extras).
  let perBannerWithDoubleSide = perBannerBase;
  if (extras.doubleSided && doubleSideRate) {
    perBannerWithDoubleSide = perBannerBase * doubleSideRate.Rate;
  }

  // Finishing extras — flat additions per banner.
  let perBannerExtras = 0;
  const extraLines = [];
  if (extras.grommetCount && grommetRate) {
    const extra = Number(extras.grommetCount) || 0;
    if (extra > 0) {
      perBannerExtras += extra * grommetRate.Rate;
      extraLines.push({ partNumber: 'BAN-GROMMET', qty: extra, amount: extra * grommetRate.Rate });
    }
  }
  if (extras.polePockets && polePocketRate) {
    // Calculate linear feet of pole pocket based on banner width
    const widthFt = w / 12;
    const pocketCount = extras.polePockets === 'both' ? 2 : 1;
    const totalLf = widthFt * pocketCount;
    if (totalLf > 0) {
      perBannerExtras += totalLf * polePocketRate.Rate;
      extraLines.push({
        partNumber: 'BAN-POLE-POCKET',
        qty: totalLf,
        amount: totalLf * polePocketRate.Rate,
        note: `${extras.polePockets} (${widthFt.toFixed(1)} lf × ${pocketCount} side${pocketCount === 1 ? '' : 's'})`,
      });
    }
  }

  const perBannerTotal = round2(perBannerWithDoubleSide + perBannerExtras);
  const orderTotal = round2(perBannerTotal * q);

  return {
    offGrid: false,
    partNumber: `BAN-${Math.round(w)}X${Math.round(h)}`,
    description: `${w}"×${h}" 13oz vinyl banner${extras.doubleSided ? ', double-sided' : ''}`,
    dimensions: { widthIn: w, heightIn: h, sqft: round2(sqft) },
    quantity: q,
    perBanner: {
      base: round2(perBannerBase),
      doubleSide: extras.doubleSided ? round2(perBannerWithDoubleSide - perBannerBase) : 0,
      extras: round2(perBannerExtras),
      total: perBannerTotal,
    },
    extraLines,
    orderTotal,
    appliedRules: {
      minimum: minimumApplied
        ? `${(sqft * baseRate.Rate).toFixed(2)} rounded up to $${minimum.Rate.toFixed(2)} minimum`
        : null,
      doubleSide: extras.doubleSided ? `${doubleSideRate.Rate}× multiplier applied for double-sided` : null,
    },
    setupFee: {
      partNumber: SETUP_FEE_PART,
      amount: SETUP_FEE_AMOUNT,
      note: 'One-time art setup fee — waived if customer has approved banner artwork on file.',
    },
    rateCard: {
      perSqft: baseRate.Rate,
      minimum: minimum ? minimum.Rate : null,
      doubleSideMultiplier: doubleSideRate ? doubleSideRate.Rate : null,
    },
    requested: { widthIn: w, heightIn: h, qty: q, extras },
  };
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

// --- Routes ------------------------------------------------------------------

router.get('/banner-pricing', async (_req, res) => {
  const { rates, source } = await loadBannerRates();
  res.json({
    rates,
    setupFee: {
      partNumber: SETUP_FEE_PART,
      amount: SETUP_FEE_AMOUNT,
      description: 'Art Setup Fee — one-time charge for new artwork',
    },
    source,
  });
});

// Direct quote endpoint (mirror of /sticker-pricing/quote). Useful for testing.
router.get('/banner-pricing/quote', async (req, res) => {
  const result = await computeBannerQuote({
    widthIn: req.query.width,
    heightIn: req.query.height,
    qty: req.query.qty,
    extras: {
      grommetCount: req.query.grommets ? Number(req.query.grommets) : 0,
      polePockets: req.query.polePockets || null,
      doubleSided: req.query.doubleSided === 'true' || req.query.doubleSided === '1',
    },
  });
  if (result.error) return res.status(400).json(result);
  res.json(result);
});

module.exports = router;
module.exports.loadBannerRates = loadBannerRates;
module.exports.computeBannerQuote = computeBannerQuote;
module.exports.SETUP_FEE_PART = SETUP_FEE_PART;
module.exports.SETUP_FEE_AMOUNT = SETUP_FEE_AMOUNT;
