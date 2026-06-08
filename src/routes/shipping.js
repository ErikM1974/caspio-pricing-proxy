/**
 * Shipping estimate routes.
 *
 * POST /api/shipping/estimate-ups-ground
 *   Outbound UPS Ground freight estimate from NWCA (origin ZIP 98354, Milton WA) to a
 *   customer ZIP. Purpose: let the rep put an estimated freight line on the quote so the
 *   customer PRE-PAYS the full amount (no second credit-card charge after shipping).
 *   Erik's ask, 2026-06-04. Rate model upgraded 2026-06-07 (Erik: "static grid now").
 *
 *   Body: { toZip, weightLb | totalWeightOz, boxes, boxWeightsLb?, residential? }
 *     - boxWeightsLb (optional): array of per-box weights (lb). When present, each box is
 *       priced at its OWN weight (a 17 lb jacket box + a 6 lb tee box bill correctly),
 *       which beats splitting the grand total evenly. Falls back to even split if omitted.
 *   Returns: { estimate, zone, zoneSource, rough, billableWeightLb, boxes, perBox[],
 *              fuelSurchargePct, residential, method, origin, toZip, note }
 *
 *   ── Accuracy model ──────────────────────────────────────────────────────────────────
 *   Rates + zones are DATA, loaded from data/ups-ground-rates.json (edit that file, no
 *   deploy). The grid is UPS 2025 Ground DAILY list rates (zones 2-8 x anchor weights),
 *   interpolated by weight; fuel surcharge + residential are separate terms.
 *
 *   These are PUBLISHED LIST rates = an UPPER BOUND (NWCA's negotiated rates are lower) —
 *   intentional, so the customer prepays enough. `rough:true` is returned whenever the zone
 *   came from the approximate ZIP-range fallback (i.e. always, until the exact origin-983
 *   zone chart is loaded into zonePrefixMap — download 983.xls from ups.com in a browser,
 *   then run scripts/build-ups-zone-map.js).
 *
 *   FUTURE (Erik: "UPS API later"): swap groundRate()/zoneForZip() for a live call to the
 *   UPS Rating REST API (developer.ups.com) with NWCA's account for true negotiated cost.
 */
const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const { fetchAllCaspioPages } = require('../utils/caspio');

const ORIGIN_ZIP = '98354'; // NWCA, Milton WA

// ── Rate data (data/ups-ground-rates.json) with an embedded fallback ──
const RATES_FALLBACK = {
  effectiveYear: '2025',
  mode: 'negotiated',
  negotiatedDiscount: 0.63,   // NWCA negotiated base / UPS list-net (fit from real invoice)
  floorUsd: 11.99,            // NWCA negotiated minimum package charge (per box)
  markupPct: 0.15,           // small handling markup on estimated cost
  fuelSurchargePct: 0.20,
  residentialSurchargeUsd: 3.90,
  dasUsd: 0,
  anchorsLb: [1, 5, 10, 20, 40, 70],
  ratesByZone: {
    2: [11.32, 13.38, 15.08, 18.11, 25.53, 32.89],
    3: [11.69, 14.83, 16.11, 20.27, 31.00, 42.04],
    4: [12.75, 16.19, 17.78, 20.66, 35.32, 48.57],
    5: [13.31, 17.61, 19.41, 25.46, 42.36, 59.80],
    6: [13.77, 18.34, 20.08, 29.68, 52.87, 70.85],
    7: [13.99, 19.37, 22.58, 36.17, 62.23, 80.81],
    8: [14.17, 20.49, 24.91, 40.87, 72.27, 97.27],
  },
  zonePrefixMap: {},
  zoneRanges: [
    { min: 980, max: 994, zone: 2 }, { min: 970, max: 979, zone: 3 },
    { min: 995, max: 999, zone: 8 }, { min: 967, max: 968, zone: 8 },
    { min: 832, max: 838, zone: 4 }, { min: 590, max: 599, zone: 4 },
    { min: 840, max: 847, zone: 4 }, { min: 889, max: 898, zone: 4 },
    { min: 820, max: 831, zone: 5 }, { min: 800, max: 816, zone: 5 },
    { min: 850, max: 865, zone: 5 }, { min: 936, max: 966, zone: 5 },
    { min: 900, max: 935, zone: 6 }, { min: 870, max: 884, zone: 6 },
    { min: 750, max: 799, zone: 6 }, { min: 730, max: 749, zone: 6 },
    { min: 660, max: 693, zone: 6 }, { min: 570, max: 588, zone: 6 },
    { min: 550, max: 567, zone: 6 }, { min: 600, max: 658, zone: 7 },
    { min: 700, max: 729, zone: 7 }, { min: 460, max: 499, zone: 7 },
    { min: 430, max: 459, zone: 7 }, { min: 530, max: 549, zone: 7 },
    { min: 350, max: 427, zone: 7 }, { min: 300, max: 349, zone: 8 },
    { min: 270, max: 299, zone: 8 }, { min: 220, max: 269, zone: 8 },
    { min: 100, max: 219, zone: 8 }, { min: 0, max: 99, zone: 8 },
  ],
  defaultZone: 5,
};

function loadRates() {
  try {
    const file = path.join(__dirname, '..', '..', 'data', 'ups-ground-rates.json');
    const json = JSON.parse(fs.readFileSync(file, 'utf8'));
    // minimal sanity check
    if (json && json.ratesByZone && json.anchorsLb) return json;
    console.warn('[shipping] ups-ground-rates.json missing required keys — using fallback');
  } catch (e) {
    console.warn('[shipping] could not load ups-ground-rates.json — using fallback:', e.message);
  }
  return RATES_FALLBACK;
}
const RATES = loadRates();

// ── Billable weight: UPS rounds UP to the next whole pound, min 1 lb ──
function billableLb(lb) {
  const n = Number(lb) || 0;
  return Math.max(1, Math.ceil(n));
}

// ── Resolve destination ZIP → UPS Ground zone (origin 983) ──
// Prefers the exact zonePrefixMap (real 983 chart) when present; else the approximate
// ZIP-range fallback. Returns { zone, source, rough }.
function zoneForZip(zip) {
  const prefix = String(zip || '').slice(0, 3);
  const map = RATES.zonePrefixMap || {};
  if (map[prefix] != null) {
    return { zone: parseInt(map[prefix], 10), source: 'ups-983-chart', rough: false };
  }
  const p = parseInt(prefix, 10);
  if (!isNaN(p)) {
    for (const r of (RATES.zoneRanges || [])) {
      if (p >= r.min && p <= r.max) return { zone: r.zone, source: 'approx-range', rough: true };
    }
  }
  return { zone: RATES.defaultZone || 5, source: 'default', rough: true };
}

// ── UPS Ground NET (pre-fuel) rate for a zone at a given weight, by interpolating the
// published anchor grid. Extrapolates linearly beyond the last anchor (heavy boxes rare). ──
function groundRate(zone, lb) {
  const grid = RATES.ratesByZone[zone] || RATES.ratesByZone[String(zone)] || RATES.ratesByZone[8] || RATES.ratesByZone['8'];
  const anchors = RATES.anchorsLb;
  const w = billableLb(lb);
  if (w <= anchors[0]) return grid[0];
  for (let i = 1; i < anchors.length; i++) {
    if (w <= anchors[i]) {
      const w0 = anchors[i - 1], w1 = anchors[i], r0 = grid[i - 1], r1 = grid[i];
      return r0 + (r1 - r0) * (w - w0) / (w1 - w0);
    }
  }
  const n = anchors.length;
  const slope = (grid[n - 1] - grid[n - 2]) / (anchors[n - 1] - anchors[n - 2]);
  return grid[n - 1] + slope * (w - anchors[n - 1]);
}

// ── Core estimate (pure, exported for tests) ──
function computeEstimate({ toZip, weightLb, totalWeightOz, boxes, boxWeightsLb, residential }) {
  const total = Number(weightLb) || (Number(totalWeightOz) ? Number(totalWeightOz) / 16 : 0);
  const nBoxes = Math.max(1, parseInt(boxes, 10) || 1);
  const { zone, source, rough } = zoneForZip(toZip);

  // Per-box weights: use the caller's array if valid, else split the total evenly.
  let perBoxWeights = Array.isArray(boxWeightsLb) ? boxWeightsLb.map(Number).filter((w) => w > 0) : [];
  if (!perBoxWeights.length) {
    const each = total / nBoxes;
    perBoxWeights = Array.from({ length: nBoxes }, () => each);
  }

  const fuel = RATES.fuelSurchargePct || 0;
  const mode = RATES.mode || 'negotiated';
  const discount = RATES.negotiatedDiscount || 1;
  const floor = RATES.floorUsd || 0;
  const markup = RATES.markupPct || 0;
  const resiUsd = RATES.residentialSurchargeUsd || 0;
  const dasUsd = RATES.dasUsd || 0;

  // Per-box base. In 'negotiated' mode (default): NWCA's contract = list-net x discount,
  // with a per-box floor (the negotiated minimum dominates light packages). Fit to a real
  // UPS invoice (903313166). In 'list' mode: raw published list rate (upper bound).
  let baseSum = 0;
  const perBox = perBoxWeights.map((w) => {
    const listNet = groundRate(zone, w);
    const base = mode === 'list' ? listNet : Math.max(floor, listNet * discount);
    baseSum += base;
    return { weightLb: billableLb(w), base: +base.toFixed(2) };
  });

  const nBox = perBox.length;
  const residentialUsd = residential ? resiUsd * nBox : 0;       // UPS bills residential per package
  const dasTotal = dasUsd * nBox;                                // per package (0 unless configured)
  const fuelUsd = fuel * (baseSum + residentialUsd + dasTotal);  // fuel applies to base + accessorials
  const estimatedCost = baseSum + residentialUsd + dasTotal + fuelUsd;
  const estimate = +(estimatedCost * (1 + markup)).toFixed(2);   // cost + small handling markup

  return {
    estimate,
    estimatedCost: +estimatedCost.toFixed(2),
    markupPct: markup,
    basis: mode,
    method: 'UPS Ground',
    origin: ORIGIN_ZIP,
    toZip: String(toZip).slice(0, 5),
    zone,
    zoneSource: source,
    rough,
    billableWeightLb: perBoxWeights.reduce((s, w) => s + billableLb(w), 0),
    boxes: nBox,
    perBox,
    fuelSurchargePct: fuel,
    residentialUsd: +residentialUsd.toFixed(2),
    dasUsd: +dasTotal.toFixed(2),
    residential: !!residential,
    rateYear: RATES.effectiveYear,
    note: mode === 'list'
      ? `UPS list rate (upper bound).${rough ? ' Zone approximate.' : ''}`
      : `Estimated NWCA cost (negotiated) + ${Math.round(markup * 100)}% handling.${rough ? ' Zone approximate.' : ''}`,
  };
}

router.post('/shipping/estimate-ups-ground', (req, res) => {
  try {
    const { toZip, weightLb, totalWeightOz, boxes, boxWeightsLb, residential } = req.body || {};
    const lb = Number(weightLb) || (Number(totalWeightOz) ? Number(totalWeightOz) / 16 : 0);
    const hasBoxWeights = Array.isArray(boxWeightsLb) && boxWeightsLb.some((w) => Number(w) > 0);
    if (!toZip || (!lb && !hasBoxWeights)) {
      return res.status(400).json({ error: 'toZip and a positive weight (weightLb, totalWeightOz, or boxWeightsLb) are required' });
    }
    return res.json(computeEstimate({ toZip, weightLb, totalWeightOz, boxes, boxWeightsLb, residential }));
  } catch (err) {
    console.error('[shipping/estimate-ups-ground]', err);
    return res.status(500).json({ error: 'Failed to compute shipping estimate' });
  }
});

// Default OUTBOUND pieces-per-box by category — data-backed (real SanMar inbound cartons,
// 2026-06-04 sample, with a decorated-bulk shave). Overridable WITHOUT a deploy via the
// Caspio `Box_Density_Reference` table (columns: Category, PiecesPerBox) — Erik's "config
// lives in Caspio" rule. Seed it with: node scripts/seed-box-density-caspio.js
const BOX_DENSITY_DEFAULTS = {
  Cap: 60, 'T-Shirt': 58, Polo: 36, Sweatshirt: 16, Hoodie: 16, Jacket: 17, Outerwear: 15,
};

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
// Exported for unit tests (tests/jest/shipping-estimate.test.js)
module.exports.computeEstimate = computeEstimate;
module.exports.zoneForZip = zoneForZip;
module.exports.groundRate = groundRate;
module.exports.billableLb = billableLb;
