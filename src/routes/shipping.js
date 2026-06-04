/**
 * Shipping estimate routes.
 *
 * POST /api/shipping/estimate-ups-ground
 *   Rough outbound UPS Ground freight estimate from NWCA (origin ZIP 98354, Milton WA)
 *   to a customer ZIP, given billable weight (lb) + number of boxes. Purpose: let the rep
 *   put an estimated freight line on the quote so the customer PRE-PAYS the full amount
 *   (no second credit-card charge after shipping). Erik's ask, 2026-06-04.
 *
 *   Body: { toZip, weightLb | totalWeightOz, boxes, residential? }
 *   Returns: { estimate, zone, billableWeightLb, boxes, perBox, method, rough, note }
 *
 *   ⚠️ ROUGH: until the real UPS data is loaded, zone is derived from coarse ZIP-prefix
 *   buckets (origin 983) and the rate is a LINEAR model anchored to published UPS Ground
 *   daily rates (zone 2: 1lb $11.99 / 5lb $14.19 … zone 8: 1lb $15.03 / 5lb $21.72).
 *   To make it accurate, replace zoneForZip() with the real ups-zone-983 chart and
 *   ZONE_MODEL with the published UPS Ground rate grid (Erik downloads both from ups.com).
 */
const express = require('express');
const router = express.Router();
const { fetchAllCaspioPages } = require('../utils/caspio');

const ORIGIN_ZIP = '98354'; // NWCA, Milton WA

// Default OUTBOUND pieces-per-box by category — data-backed (real SanMar inbound cartons,
// 2026-06-04 sample, with a decorated-bulk shave). Overridable WITHOUT a deploy via the
// Caspio `Box_Density_Reference` table (columns: Category, PiecesPerBox) — Erik's "config
// lives in Caspio" rule. Import data/box-density-reference.csv to create/seed that table.
const BOX_DENSITY_DEFAULTS = {
  Cap: 60, 'T-Shirt': 58, Polo: 36, Sweatshirt: 16, Hoodie: 16, Jacket: 17, Outerwear: 15,
};

// Coarse destination-ZIP-prefix → UPS zone (origin 983). Continental US = zones 2-8.
// Replace with the real per-origin zone chart for accuracy.
function zoneForZip(zip) {
  const p = parseInt(String(zip || '').slice(0, 3), 10);
  if (isNaN(p)) return 5;
  if (p >= 980 && p <= 994) return 2;                              // WA (+ close ID)
  if ((p >= 970 && p <= 979) || (p >= 995 && p <= 999)) return 3;  // OR, AK
  if (p >= 889 && p <= 961) return 4;                              // CA / NV / parts UT
  if (p >= 800 && p <= 884) return 5;                              // CO / AZ / NM / UT
  if (p >= 580 && p <= 799) return 6;                              // Plains / TX / central
  if (p >= 350 && p <= 579) return 7;                              // Midwest / South
  return 8;                                                        // East coast
}

// Linear rate model per zone: $ = base + perLb * billableLb. Anchored to published
// UPS Ground daily rates at 1 lb and 5 lb. Crude at high weights — refine with the grid.
const ZONE_MODEL = {
  2: { base: 11.44, perLb: 0.55 },
  3: { base: 11.76, perLb: 0.74 },
  4: { base: 12.08, perLb: 0.93 },
  5: { base: 12.40, perLb: 1.11 },
  6: { base: 12.72, perLb: 1.30 },
  7: { base: 13.04, perLb: 1.48 },
  8: { base: 13.36, perLb: 1.67 },
};

const FUEL_FACTOR = 1.12;          // rough fuel surcharge multiplier
const RESIDENTIAL_SURCHARGE = 6.50; // per shipment, residential delivery

router.post('/shipping/estimate-ups-ground', (req, res) => {
  try {
    const { toZip, weightLb, totalWeightOz, boxes, residential } = req.body || {};
    let lb = Number(weightLb) || (Number(totalWeightOz) ? Number(totalWeightOz) / 16 : 0);
    if (!toZip || !lb || lb <= 0) {
      return res.status(400).json({ error: 'toZip and a positive weight (weightLb or totalWeightOz) are required' });
    }
    const nBoxes = Math.max(1, parseInt(boxes, 10) || 1);
    const zone = zoneForZip(toZip);
    const model = ZONE_MODEL[zone] || ZONE_MODEL[5];

    // UPS bills per package; bias up — billable weight per box, min 1 lb.
    const perBoxLb = Math.max(1, Math.ceil(lb / nBoxes));
    const perBoxBase = model.base + model.perLb * perBoxLb;
    const perBox = +(perBoxBase * FUEL_FACTOR).toFixed(2);
    let estimate = +(perBox * nBoxes).toFixed(2);
    if (residential) estimate = +(estimate + RESIDENTIAL_SURCHARGE).toFixed(2);

    return res.json({
      estimate,
      method: 'UPS Ground',
      origin: ORIGIN_ZIP,
      toZip: String(toZip).slice(0, 5),
      zone,
      billableWeightLb: Math.ceil(lb),
      boxes: nBoxes,
      perBox,
      residential: !!residential,
      rough: true,
      note: 'Rough estimate (coarse zone + linear rate + fuel). Load the UPS 983 zone chart + Ground rate grid for accuracy.',
    });
  } catch (err) {
    console.error('[shipping/estimate-ups-ground]', err);
    return res.status(500).json({ error: 'Failed to compute shipping estimate' });
  }
});

/**
 * GET /api/shipping/box-density
 *   Category → outbound pieces-per-box, read from the Caspio `Box_Density_Reference` table
 *   when it exists (so Erik can tune it without a deploy), else the data-backed defaults.
 *   The freight estimator uses this to count boxes. (2026-06-04)
 */
router.get('/shipping/box-density', async (req, res) => {
  try {
    const rows = await fetchAllCaspioPages('/tables/Box_Density_Reference/records', {});
    if (Array.isArray(rows) && rows.length) {
      const density = { ...BOX_DENSITY_DEFAULTS };
      rows.forEach((r) => {
        const cat = r.Category || r.category;
        const ppb = parseFloat(r.PiecesPerBox || r.piecesPerBox);
        if (cat && ppb > 0) density[cat] = ppb;
      });
      return res.json({ source: 'caspio', density });
    }
  } catch (e) {
    // Table not created yet / read error → fall back to the data-backed defaults.
    console.warn('[box-density] Caspio table unavailable, using defaults:', e.message);
  }
  return res.json({ source: 'default', density: BOX_DENSITY_DEFAULTS });
});

module.exports = router;
