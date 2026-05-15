// Sticker pricing route — backs the contract sticker AI page + order-form Sticker method.
//
// Source of truth: Caspio table `Sticker_Pricing` (50 rows = 5 sizes × 10 qty tiers).
// Each row has a unique PartNumber (STK-{SIZE}-{QTY}) — used by the AI chat to quote
// line items and by ShopWorks push on customer accept.
//
// When the table doesn't exist yet, the route falls back to an inline grid that mirrors
// /calculators/sticker-manual-pricing.html. CSV for import: erik\Downloads\
// sticker-pricing-caspio-import.csv (50 rows). Once imported, the inline fallback can be
// removed in a follow-up.
//
// 2026-05-15: Added PartNumber field + 6x6 tier (10 SKUs, extrapolated from existing
// curve, qty-10000 manually capped at $12,000 to preserve volume-discount monotonicity).

const express = require('express');
const router = express.Router();
const { fetchAllCaspioPages } = require('../utils/caspio');

// Inline fallback — keep in sync with shared_components/js/sticker-pricing-service.js
// and calculators/sticker-manual-pricing.html.
const INLINE_GRID = [
  { PartNumber: 'STK-2X2-50',    Size: '2x2', Quantity: 50,    TotalPrice: 87.00,    PricePerSticker: 1.74, IsBestValue: false },
  { PartNumber: 'STK-2X2-100',   Size: '2x2', Quantity: 100,   TotalPrice: 104.00,   PricePerSticker: 1.04, IsBestValue: false },
  { PartNumber: 'STK-2X2-200',   Size: '2x2', Quantity: 200,   TotalPrice: 140.00,   PricePerSticker: 0.70, IsBestValue: true  },
  { PartNumber: 'STK-2X2-300',   Size: '2x2', Quantity: 300,   TotalPrice: 186.00,   PricePerSticker: 0.62, IsBestValue: false },
  { PartNumber: 'STK-2X2-500',   Size: '2x2', Quantity: 500,   TotalPrice: 234.00,   PricePerSticker: 0.47, IsBestValue: false },
  { PartNumber: 'STK-2X2-1000',  Size: '2x2', Quantity: 1000,  TotalPrice: 408.00,   PricePerSticker: 0.41, IsBestValue: false },
  { PartNumber: 'STK-2X2-2000',  Size: '2x2', Quantity: 2000,  TotalPrice: 654.00,   PricePerSticker: 0.33, IsBestValue: false },
  { PartNumber: 'STK-2X2-3000',  Size: '2x2', Quantity: 3000,  TotalPrice: 874.00,   PricePerSticker: 0.29, IsBestValue: false },
  { PartNumber: 'STK-2X2-5000',  Size: '2x2', Quantity: 5000,  TotalPrice: 1275.00,  PricePerSticker: 0.26, IsBestValue: false },
  { PartNumber: 'STK-2X2-10000', Size: '2x2', Quantity: 10000, TotalPrice: 2158.00,  PricePerSticker: 0.22, IsBestValue: false },
  { PartNumber: 'STK-3X3-50',    Size: '3x3', Quantity: 50,    TotalPrice: 128.00,   PricePerSticker: 2.56, IsBestValue: false },
  { PartNumber: 'STK-3X3-100',   Size: '3x3', Quantity: 100,   TotalPrice: 124.00,   PricePerSticker: 1.24, IsBestValue: false },
  { PartNumber: 'STK-3X3-200',   Size: '3x3', Quantity: 200,   TotalPrice: 234.00,   PricePerSticker: 1.17, IsBestValue: true  },
  { PartNumber: 'STK-3X3-300',   Size: '3x3', Quantity: 300,   TotalPrice: 296.00,   PricePerSticker: 0.99, IsBestValue: false },
  { PartNumber: 'STK-3X3-500',   Size: '3x3', Quantity: 500,   TotalPrice: 406.00,   PricePerSticker: 0.81, IsBestValue: false },
  { PartNumber: 'STK-3X3-1000',  Size: '3x3', Quantity: 1000,  TotalPrice: 656.00,   PricePerSticker: 0.66, IsBestValue: false },
  { PartNumber: 'STK-3X3-2000',  Size: '3x3', Quantity: 2000,  TotalPrice: 1089.00,  PricePerSticker: 0.54, IsBestValue: false },
  { PartNumber: 'STK-3X3-3000',  Size: '3x3', Quantity: 3000,  TotalPrice: 1482.00,  PricePerSticker: 0.49, IsBestValue: false },
  { PartNumber: 'STK-3X3-5000',  Size: '3x3', Quantity: 5000,  TotalPrice: 2199.00,  PricePerSticker: 0.44, IsBestValue: false },
  { PartNumber: 'STK-3X3-10000', Size: '3x3', Quantity: 10000, TotalPrice: 3790.00,  PricePerSticker: 0.38, IsBestValue: false },
  { PartNumber: 'STK-4X4-50',    Size: '4x4', Quantity: 50,    TotalPrice: 153.00,   PricePerSticker: 3.06, IsBestValue: false },
  { PartNumber: 'STK-4X4-100',   Size: '4x4', Quantity: 100,   TotalPrice: 212.00,   PricePerSticker: 2.12, IsBestValue: false },
  { PartNumber: 'STK-4X4-200',   Size: '4x4', Quantity: 200,   TotalPrice: 294.00,   PricePerSticker: 1.47, IsBestValue: true  },
  { PartNumber: 'STK-4X4-300',   Size: '4x4', Quantity: 300,   TotalPrice: 378.00,   PricePerSticker: 1.26, IsBestValue: false },
  { PartNumber: 'STK-4X4-500',   Size: '4x4', Quantity: 500,   TotalPrice: 544.00,   PricePerSticker: 1.09, IsBestValue: false },
  { PartNumber: 'STK-4X4-1000',  Size: '4x4', Quantity: 1000,  TotalPrice: 962.00,   PricePerSticker: 0.96, IsBestValue: false },
  { PartNumber: 'STK-4X4-2000',  Size: '4x4', Quantity: 2000,  TotalPrice: 1630.00,  PricePerSticker: 0.82, IsBestValue: false },
  { PartNumber: 'STK-4X4-3000',  Size: '4x4', Quantity: 3000,  TotalPrice: 2236.00,  PricePerSticker: 0.75, IsBestValue: false },
  { PartNumber: 'STK-4X4-5000',  Size: '4x4', Quantity: 5000,  TotalPrice: 3346.00,  PricePerSticker: 0.67, IsBestValue: false },
  { PartNumber: 'STK-4X4-10000', Size: '4x4', Quantity: 10000, TotalPrice: 5846.00,  PricePerSticker: 0.58, IsBestValue: false },
  { PartNumber: 'STK-5X5-50',    Size: '5x5', Quantity: 50,    TotalPrice: 183.00,   PricePerSticker: 3.66, IsBestValue: false },
  { PartNumber: 'STK-5X5-100',   Size: '5x5', Quantity: 100,   TotalPrice: 266.00,   PricePerSticker: 2.66, IsBestValue: false },
  { PartNumber: 'STK-5X5-200',   Size: '5x5', Quantity: 200,   TotalPrice: 412.00,   PricePerSticker: 2.06, IsBestValue: true  },
  { PartNumber: 'STK-5X5-300',   Size: '5x5', Quantity: 300,   TotalPrice: 536.00,   PricePerSticker: 1.79, IsBestValue: false },
  { PartNumber: 'STK-5X5-500',   Size: '5x5', Quantity: 500,   TotalPrice: 784.00,   PricePerSticker: 1.57, IsBestValue: false },
  { PartNumber: 'STK-5X5-1000',  Size: '5x5', Quantity: 1000,  TotalPrice: 1322.00,  PricePerSticker: 1.32, IsBestValue: false },
  { PartNumber: 'STK-5X5-2000',  Size: '5x5', Quantity: 2000,  TotalPrice: 2266.00,  PricePerSticker: 1.13, IsBestValue: false },
  { PartNumber: 'STK-5X5-3000',  Size: '5x5', Quantity: 3000,  TotalPrice: 3123.00,  PricePerSticker: 1.04, IsBestValue: false },
  { PartNumber: 'STK-5X5-5000',  Size: '5x5', Quantity: 5000,  TotalPrice: 4694.00,  PricePerSticker: 0.94, IsBestValue: false },
  { PartNumber: 'STK-5X5-10000', Size: '5x5', Quantity: 10000, TotalPrice: 8892.00,  PricePerSticker: 0.89, IsBestValue: false },
  // 6x6 — extrapolated from 3x3/4x4/5x5 curve at each qty (quadratic next-step formula),
  // qty=10000 manually capped at $12,000 to preserve volume-discount monotonicity.
  { PartNumber: 'STK-6X6-50',    Size: '6x6', Quantity: 50,    TotalPrice: 218.00,   PricePerSticker: 4.36, IsBestValue: false },
  { PartNumber: 'STK-6X6-100',   Size: '6x6', Quantity: 100,   TotalPrice: 286.00,   PricePerSticker: 2.86, IsBestValue: false },
  { PartNumber: 'STK-6X6-200',   Size: '6x6', Quantity: 200,   TotalPrice: 588.00,   PricePerSticker: 2.94, IsBestValue: true  },
  { PartNumber: 'STK-6X6-300',   Size: '6x6', Quantity: 300,   TotalPrice: 774.00,   PricePerSticker: 2.58, IsBestValue: false },
  { PartNumber: 'STK-6X6-500',   Size: '6x6', Quantity: 500,   TotalPrice: 1125.00,  PricePerSticker: 2.25, IsBestValue: false },
  { PartNumber: 'STK-6X6-1000',  Size: '6x6', Quantity: 1000,  TotalPrice: 1740.00,  PricePerSticker: 1.74, IsBestValue: false },
  { PartNumber: 'STK-6X6-2000',  Size: '6x6', Quantity: 2000,  TotalPrice: 2940.00,  PricePerSticker: 1.47, IsBestValue: false },
  { PartNumber: 'STK-6X6-3000',  Size: '6x6', Quantity: 3000,  TotalPrice: 4080.00,  PricePerSticker: 1.36, IsBestValue: false },
  { PartNumber: 'STK-6X6-5000',  Size: '6x6', Quantity: 5000,  TotalPrice: 6250.00,  PricePerSticker: 1.25, IsBestValue: false },
  { PartNumber: 'STK-6X6-10000', Size: '6x6', Quantity: 10000, TotalPrice: 12000.00, PricePerSticker: 1.20, IsBestValue: false },
];

const SETUP_FEE_PART = 'GRT-50';
const SETUP_FEE_AMOUNT = 50.00;

// Pre-computed sorted size list (used by AI's quote_sticker_price tool for bounding-box lookups).
const STANDARD_SIZES = ['2x2', '3x3', '4x4', '5x5', '6x6'];
const STANDARD_QTYS = [50, 100, 200, 300, 500, 1000, 2000, 3000, 5000, 10000];

/**
 * Load the pricing grid. Tries Caspio first; falls back to INLINE_GRID on any
 * error. Handles the pre-CSV-import window where the PartNumber column doesn't
 * exist yet by retrying without it and deriving PartNumber from Size+Qty.
 *
 * Returns { grid: [...], source: 'caspio' | 'inline' }.
 */
async function loadGrid() {
  try {
    let rows;
    try {
      rows = await fetchAllCaspioPages('/tables/Sticker_Pricing/records', {
        'q.select': 'PartNumber,Size,Quantity,TotalPrice,PricePerSticker,IsBestValue',
        'q.pageSize': 200,
      });
    } catch (innerErr) {
      console.warn('[sticker-pricing] PartNumber column missing, deriving from Size+Qty:', innerErr.message);
      rows = await fetchAllCaspioPages('/tables/Sticker_Pricing/records', {
        'q.select': 'Size,Quantity,TotalPrice,PricePerSticker,IsBestValue',
        'q.pageSize': 200,
      });
    }
    if (Array.isArray(rows) && rows.length) {
      const isTruthy = v => v === true || v === 1 || v === '1'
        || (typeof v === 'string' && /^(yes|y|true)$/i.test(v.trim()));
      const grid = rows
        .map(r => {
          const size = String(r.Size || '').trim();
          const qty = Number(r.Quantity) || 0;
          const partNumber = String(r.PartNumber || '').trim()
            || (size && qty ? `STK-${size.toUpperCase()}-${qty}` : '');
          return {
            PartNumber: partNumber,
            Size: size,
            Quantity: qty,
            TotalPrice: Number(r.TotalPrice) || 0,
            PricePerSticker: Number(r.PricePerSticker) || 0,
            IsBestValue: isTruthy(r.IsBestValue),
          };
        })
        .filter(r => r.PartNumber && r.Size && r.Quantity > 0)
        .sort((a, b) => a.Size.localeCompare(b.Size) || a.Quantity - b.Quantity);
      return { grid, source: 'caspio' };
    }
  } catch (err) {
    console.warn('[sticker-pricing] Caspio fetch failed, falling back to inline:', err.message);
  }
  return { grid: INLINE_GRID, source: 'inline' };
}

router.get('/sticker-pricing', async (_req, res) => {
  const { grid, source } = await loadGrid();
  res.json({
    grid,
    setupFee: {
      partNumber: SETUP_FEE_PART,
      amount: SETUP_FEE_AMOUNT,
      description: 'Art Setup Fee — one-time charge for new artwork',
    },
    standardSizes: STANDARD_SIZES,
    standardQtys: STANDARD_QTYS,
    source,
  });
});

// Quote-lookup helper — used by the contract-sticker-ai route to translate a
// customer's free-form ask (e.g. "200 of 2x3 stickers") into a quotable grid row.
// Implements the bounding-box rule + round-up-qty rule from the system prompt.
//
// GET /api/sticker-pricing/quote?width=2&height=3&qty=200
//   → { partNumber: "STK-3X3-200", size: "3x3", quantity: 200,
//       totalPrice: 234.00, pricePerSticker: 1.17, isBestValue: true,
//       appliedRules: { boundingBox: "2x3 → 3x3", quantityRoundUp: null } }
//
// Off-grid (max dim > 6 OR qty > 10000) → { offGrid: true, reason: "..." }.
router.get('/sticker-pricing/quote', async (req, res) => {
  const widthRaw = parseFloat(req.query.width);
  const heightRaw = parseFloat(req.query.height);
  const qtyRaw = parseInt(req.query.qty, 10);

  if (!Number.isFinite(widthRaw) || widthRaw <= 0
      || !Number.isFinite(heightRaw) || heightRaw <= 0
      || !Number.isFinite(qtyRaw) || qtyRaw <= 0) {
    return res.status(400).json({
      error: 'bad_request',
      message: 'width, height, qty all required as positive numbers',
    });
  }

  // Bounding-box rule: use the larger dimension, round UP to the next standard size.
  const maxDim = Math.max(widthRaw, heightRaw);
  const boundingSize = STANDARD_SIZES.find(s => parseInt(s.split('x')[0], 10) >= maxDim);
  if (!boundingSize) {
    return res.json({
      offGrid: true,
      reason: `oversize_dimension`,
      detail: `${widthRaw}"×${heightRaw}" exceeds our largest standard size (6×6). Needs manual quote.`,
      requested: { width: widthRaw, height: heightRaw, qty: qtyRaw },
    });
  }

  // Quantity round-up rule: use the smallest standard qty ≥ requested.
  const roundedQty = STANDARD_QTYS.find(q => q >= qtyRaw);
  if (!roundedQty) {
    return res.json({
      offGrid: true,
      reason: `oversize_quantity`,
      detail: `${qtyRaw} pcs exceeds our largest standard quantity (10,000). Needs manual quote.`,
      requested: { width: widthRaw, height: heightRaw, qty: qtyRaw },
    });
  }

  const { grid } = await loadGrid();
  const match = grid.find(row => row.Size === boundingSize && row.Quantity === roundedQty);
  if (!match) {
    return res.status(500).json({
      error: 'pricing_lookup_failed',
      message: `No row found for ${boundingSize} @ qty ${roundedQty}`,
    });
  }

  const sizeWasRounded = (parseInt(boundingSize.split('x')[0], 10) !== widthRaw)
                     || (parseInt(boundingSize.split('x')[0], 10) !== heightRaw);
  const qtyWasRounded = roundedQty !== qtyRaw;

  // Rush production fee — shared modifier with banners. Pull the 1.25×
  // multiplier from the Banner_Pricing table's RUSH-25PCT row (de-facto
  // shared-modifier home), falling back to the hardcoded 1.25 if the
  // shared route isn't available.
  const rushRequested = req.query.rush === 'true' || req.query.rush === '1';
  let totalPrice = match.TotalPrice;
  let pricePerSticker = match.PricePerSticker;
  let rushMultiplier = null;
  if (rushRequested) {
    try {
      const { loadBannerRates } = require('./banner-pricing');
      const { rates } = await loadBannerRates();
      const rushRow = rates.find(r => r.PartNumber === 'RUSH-25PCT');
      rushMultiplier = rushRow ? Number(rushRow.Rate) : 1.25;
    } catch (e) {
      rushMultiplier = 1.25;
    }
    totalPrice = Math.round(match.TotalPrice * rushMultiplier * 100) / 100;
    pricePerSticker = Math.round(match.PricePerSticker * rushMultiplier * 10000) / 10000;
  }

  res.json({
    offGrid: false,
    partNumber: match.PartNumber,
    size: match.Size,
    quantity: match.Quantity,
    totalPrice,
    pricePerSticker,
    isBestValue: match.IsBestValue,
    appliedRules: {
      boundingBox: sizeWasRounded ? `${widthRaw}"×${heightRaw}" → ${match.Size}` : null,
      quantityRoundUp: qtyWasRounded ? `${qtyRaw} → ${match.Quantity}` : null,
      rush: rushRequested ? `${rushMultiplier}× multiplier applied for rush production (under 5 working days)` : null,
    },
    requested: { width: widthRaw, height: heightRaw, qty: qtyRaw },
  });
});

// Expose loadGrid + constants for the contract-sticker-ai route's tool implementations,
// so the AI's quote_sticker_price tool can resolve part numbers without an internal HTTP hop.
module.exports = router;
module.exports.loadGrid = loadGrid;
module.exports.STANDARD_SIZES = STANDARD_SIZES;
module.exports.STANDARD_QTYS = STANDARD_QTYS;
module.exports.SETUP_FEE_PART = SETUP_FEE_PART;
module.exports.SETUP_FEE_AMOUNT = SETUP_FEE_AMOUNT;
