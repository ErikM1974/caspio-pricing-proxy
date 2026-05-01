// Emblem (embroidered patch) pricing route — backs the order-form Emblem method.
//
// Source of truth: Caspio tables `Emblem_Pricing` (160 rows = 16 size keys × 10
// qty tiers) + `Emblem_Pricing_Rules` (LTM, digitizing, multipliers). When the
// tables don't exist yet, the route falls back to inline data that mirrors the
// calculator at /calculators/embroidered-emblem/index.html.

const express = require('express');
const router = express.Router();
const { fetchAllCaspioPages } = require('../utils/caspio');

// Inline fallback grid — keep in sync with shared_components/js/emblem-pricing-service.js.
const INLINE_GRID = {
  '1.00':  [2.20, 1.91, 1.41, 1.01, 0.86, 0.74, 0.65, 0.59, 0.54, 0.49],
  '1.50':  [2.77, 2.41, 1.78, 1.27, 1.09, 0.93, 0.82, 0.74, 0.68, 0.61],
  '2.00':  [3.87, 3.37, 2.49, 1.78, 1.52, 1.30, 1.14, 1.03, 0.95, 0.86],
  '2.50':  [4.97, 4.32, 3.19, 2.29, 1.95, 1.67, 1.47, 1.33, 1.21, 1.10],
  '3.00':  [6.07, 5.28, 3.90, 2.79, 2.38, 2.03, 1.79, 1.62, 1.48, 1.34],
  '3.50':  [7.17, 6.23, 4.60, 3.30, 2.81, 2.40, 2.12, 1.91, 1.75, 1.59],
  '4.00':  [8.28, 7.19, 5.31, 3.81, 3.24, 2.77, 2.44, 2.21, 2.02, 1.83],
  '4.50':  [9.38, 8.15, 6.02, 4.31, 3.67, 3.14, 2.77, 2.50, 2.29, 2.08],
  '5.00':  [10.48, 9.10, 6.72, 4.82, 4.10, 3.51, 3.09, 2.80, 2.56, 2.32],
  '6.00':  [12.13, 10.54, 7.78, 5.58, 4.75, 4.06, 3.58, 3.24, 2.96, 2.69],
  '7.00':  [14.33, 12.45, 9.19, 6.59, 5.61, 4.80, 4.23, 3.82, 3.50, 3.17],
  '8.00':  [16.53, 14.36, 10.61, 7.60, 6.48, 5.54, 4.88, 4.41, 4.04, 3.66],
  '9.00':  [18.73, 16.27, 12.02, 8.62, 7.34, 6.28, 5.53, 5.00, 4.57, 4.15],
  '10.00': [20.93, 18.19, 13.43, 9.63, 8.20, 7.01, 6.18, 5.59, 5.11, 4.64],
  '11.00': [23.13, 20.10, 14.84, 10.64, 9.06, 7.75, 6.83, 6.17, 5.65, 5.12],
  '12.00': [25.34, 22.01, 16.26, 11.65, 9.93, 8.49, 7.48, 6.76, 6.19, 5.61],
};

const QTY_TIERS = [25, 50, 100, 200, 300, 500, 1000, 2000, 5000, 10000];

const INLINE_RULES = {
  LTM_Fee:         50.00,
  LTM_Threshold:   200,
  Digitizing_Fee:  100.00,
  Metallic_Pct:    0.25,
  Velcro_Pct:      0.25,
  Extra_Color_Pct: 0.10,
};

router.get('/emblem-pricing', async (_req, res) => {
  let grid = null;
  let rules = null;
  let source = 'inline';

  // Pricing grid — long format (160 rows: SizeKey, QuantityTier, BasePrice).
  // Reshape to { sizeKey: [price0, price1, ...] } in QTY_TIERS order.
  try {
    const rows = await fetchAllCaspioPages('/tables/Emblem_Pricing/records', {
      'q.select': 'SizeKey,QuantityTier,BasePrice',
      'q.pageSize': 200,
    });
    if (Array.isArray(rows) && rows.length) {
      const built = {};
      rows.forEach(r => {
        const key = Number(r.SizeKey).toFixed(2);
        const idx = QTY_TIERS.indexOf(Number(r.QuantityTier));
        if (idx === -1) return;
        if (!built[key]) built[key] = new Array(QTY_TIERS.length).fill(null);
        built[key][idx] = Number(r.BasePrice) || 0;
      });
      // Only use Caspio data if it's complete (every tier filled in for at least one size)
      const isComplete = Object.values(built).some(arr => arr.every(v => v != null));
      if (isComplete) { grid = built; source = 'caspio'; }
    }
  } catch (err) {
    console.warn('[emblem-pricing] Caspio Emblem_Pricing fetch failed, using inline:', err.message);
  }
  if (!grid) grid = INLINE_GRID;

  // Rules — small key/value table.
  try {
    const ruleRows = await fetchAllCaspioPages('/tables/Emblem_Pricing_Rules/records', {
      'q.select': 'RuleName,Value',
      'q.pageSize': 50,
    });
    if (Array.isArray(ruleRows) && ruleRows.length) {
      rules = ruleRows.reduce((acc, r) => {
        const name = String(r.RuleName || '').trim();
        if (name) acc[name] = Number(r.Value) || 0;
        return acc;
      }, {});
      // Sanity check: must have core fields, else fall back.
      if (rules.LTM_Fee == null || rules.Metallic_Pct == null) rules = null;
    }
  } catch (err) {
    console.warn('[emblem-pricing] Caspio Emblem_Pricing_Rules fetch failed, using inline:', err.message);
  }
  if (!rules) rules = INLINE_RULES;

  res.json({ grid, rules, qtyTiers: QTY_TIERS, source });
});

module.exports = router;
