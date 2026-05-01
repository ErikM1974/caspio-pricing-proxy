// Sticker pricing route — backs the order-form Sticker method.
//
// Source of truth: Caspio table `Sticker_Pricing` (40 rows = 4 sizes × 10 qty
// tiers). When the table doesn't exist yet, the route falls back to an inline
// grid that mirrors the static page at /calculators/sticker-manual-pricing.html
// — so the order form keeps working through the table-creation window.

const express = require('express');
const router = express.Router();
const { fetchAllCaspioPages } = require('../utils/caspio');

// Inline fallback — keep in sync with shared_components/js/sticker-pricing-service.js
// and calculators/sticker-manual-pricing.html. Once Caspio Sticker_Pricing is
// imported (CSV in Erik's Downloads folder, 2026-05-01), this fallback can be
// removed in a follow-up.
const INLINE_GRID = [
  { Size: '2x2', Quantity: 50,    TotalPrice: 87.00,   PricePerSticker: 1.74, IsBestValue: false },
  { Size: '2x2', Quantity: 100,   TotalPrice: 104.00,  PricePerSticker: 1.04, IsBestValue: false },
  { Size: '2x2', Quantity: 200,   TotalPrice: 140.00,  PricePerSticker: 0.70, IsBestValue: true },
  { Size: '2x2', Quantity: 300,   TotalPrice: 186.00,  PricePerSticker: 0.62, IsBestValue: false },
  { Size: '2x2', Quantity: 500,   TotalPrice: 234.00,  PricePerSticker: 0.47, IsBestValue: false },
  { Size: '2x2', Quantity: 1000,  TotalPrice: 408.00,  PricePerSticker: 0.41, IsBestValue: false },
  { Size: '2x2', Quantity: 2000,  TotalPrice: 654.00,  PricePerSticker: 0.33, IsBestValue: false },
  { Size: '2x2', Quantity: 3000,  TotalPrice: 874.00,  PricePerSticker: 0.29, IsBestValue: false },
  { Size: '2x2', Quantity: 5000,  TotalPrice: 1275.00, PricePerSticker: 0.26, IsBestValue: false },
  { Size: '2x2', Quantity: 10000, TotalPrice: 2158.00, PricePerSticker: 0.22, IsBestValue: false },
  { Size: '3x3', Quantity: 50,    TotalPrice: 128.00,  PricePerSticker: 2.56, IsBestValue: false },
  { Size: '3x3', Quantity: 100,   TotalPrice: 124.00,  PricePerSticker: 1.24, IsBestValue: false },
  { Size: '3x3', Quantity: 200,   TotalPrice: 234.00,  PricePerSticker: 1.17, IsBestValue: true },
  { Size: '3x3', Quantity: 300,   TotalPrice: 296.00,  PricePerSticker: 0.99, IsBestValue: false },
  { Size: '3x3', Quantity: 500,   TotalPrice: 406.00,  PricePerSticker: 0.81, IsBestValue: false },
  { Size: '3x3', Quantity: 1000,  TotalPrice: 656.00,  PricePerSticker: 0.66, IsBestValue: false },
  { Size: '3x3', Quantity: 2000,  TotalPrice: 1089.00, PricePerSticker: 0.54, IsBestValue: false },
  { Size: '3x3', Quantity: 3000,  TotalPrice: 1482.00, PricePerSticker: 0.49, IsBestValue: false },
  { Size: '3x3', Quantity: 5000,  TotalPrice: 2199.00, PricePerSticker: 0.44, IsBestValue: false },
  { Size: '3x3', Quantity: 10000, TotalPrice: 3790.00, PricePerSticker: 0.38, IsBestValue: false },
  { Size: '4x4', Quantity: 50,    TotalPrice: 153.00,  PricePerSticker: 3.06, IsBestValue: false },
  { Size: '4x4', Quantity: 100,   TotalPrice: 212.00,  PricePerSticker: 2.12, IsBestValue: false },
  { Size: '4x4', Quantity: 200,   TotalPrice: 294.00,  PricePerSticker: 1.47, IsBestValue: true },
  { Size: '4x4', Quantity: 300,   TotalPrice: 378.00,  PricePerSticker: 1.26, IsBestValue: false },
  { Size: '4x4', Quantity: 500,   TotalPrice: 544.00,  PricePerSticker: 1.09, IsBestValue: false },
  { Size: '4x4', Quantity: 1000,  TotalPrice: 962.00,  PricePerSticker: 0.96, IsBestValue: false },
  { Size: '4x4', Quantity: 2000,  TotalPrice: 1630.00, PricePerSticker: 0.82, IsBestValue: false },
  { Size: '4x4', Quantity: 3000,  TotalPrice: 2236.00, PricePerSticker: 0.75, IsBestValue: false },
  { Size: '4x4', Quantity: 5000,  TotalPrice: 3346.00, PricePerSticker: 0.67, IsBestValue: false },
  { Size: '4x4', Quantity: 10000, TotalPrice: 5846.00, PricePerSticker: 0.58, IsBestValue: false },
  { Size: '5x5', Quantity: 50,    TotalPrice: 183.00,  PricePerSticker: 3.66, IsBestValue: false },
  { Size: '5x5', Quantity: 100,   TotalPrice: 266.00,  PricePerSticker: 2.66, IsBestValue: false },
  { Size: '5x5', Quantity: 200,   TotalPrice: 412.00,  PricePerSticker: 2.06, IsBestValue: true },
  { Size: '5x5', Quantity: 300,   TotalPrice: 536.00,  PricePerSticker: 1.79, IsBestValue: false },
  { Size: '5x5', Quantity: 500,   TotalPrice: 784.00,  PricePerSticker: 1.57, IsBestValue: false },
  { Size: '5x5', Quantity: 1000,  TotalPrice: 1322.00, PricePerSticker: 1.32, IsBestValue: false },
  { Size: '5x5', Quantity: 2000,  TotalPrice: 2266.00, PricePerSticker: 1.13, IsBestValue: false },
  { Size: '5x5', Quantity: 3000,  TotalPrice: 3123.00, PricePerSticker: 1.04, IsBestValue: false },
  { Size: '5x5', Quantity: 5000,  TotalPrice: 4694.00, PricePerSticker: 0.94, IsBestValue: false },
  { Size: '5x5', Quantity: 10000, TotalPrice: 8892.00, PricePerSticker: 0.89, IsBestValue: false },
];

const SETUP_FEE = 50.00;

router.get('/sticker-pricing', async (_req, res) => {
  let grid = null;
  let source = 'inline';
  try {
    const rows = await fetchAllCaspioPages('/tables/Sticker_Pricing/records', {
      'q.select': 'Size,Quantity,TotalPrice,PricePerSticker,IsBestValue',
      'q.pageSize': 200,
    });
    if (Array.isArray(rows) && rows.length) {
      // IsBestValue is stored as Text("Yes"/"No") in the current Caspio table —
      // a bare !!r.IsBestValue would treat the string "No" as truthy. Normalize
      // explicitly so this also works if the column is later switched to Yes/No.
      const isTruthy = v => v === true || v === 1 || v === '1'
        || (typeof v === 'string' && /^(yes|y|true)$/i.test(v.trim()));
      grid = rows
        .map(r => ({
          Size: String(r.Size || '').trim(),
          Quantity: Number(r.Quantity) || 0,
          TotalPrice: Number(r.TotalPrice) || 0,
          PricePerSticker: Number(r.PricePerSticker) || 0,
          IsBestValue: isTruthy(r.IsBestValue),
        }))
        .filter(r => r.Size && r.Quantity > 0)
        .sort((a, b) => a.Size.localeCompare(b.Size) || a.Quantity - b.Quantity);
      source = 'caspio';
    }
  } catch (err) {
    console.warn('[sticker-pricing] Caspio fetch failed, falling back to inline:', err.message);
  }
  if (!grid) grid = INLINE_GRID;
  res.json({ grid, setupFee: SETUP_FEE, source });
});

module.exports = router;
