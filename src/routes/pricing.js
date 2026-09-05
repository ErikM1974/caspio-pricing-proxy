// Pricing-related routes

const express = require('express');
const router = express.Router();
const rateLimit = require('express-rate-limit');
const { makeCaspioRequest, fetchAllCaspioPages } = require('../utils/caspio');
const { createTtlCache, shouldBypass, makeKey } = require('../utils/ttl-cache');
const {
  getSizeUpchargeRows, getSizeDisplayOrderRows,
  getPricingTierRows, getPricingRuleRows, getLocationRows,
  getTransferFreightRows, getCostTableRows
} = require('../utils/caspio-static-tables');

// Rate limiter scoped to pricing routes only (not all /api routes)
const pricingLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 100, // Max 100 requests per minute per IP
  message: {
    error: 'Too many requests to pricing endpoints',
    retryAfter: '60 seconds'
  },
  standardHeaders: true,
  legacyHeaders: false
});
// Apply rate limiter ONLY to pricing-specific routes
// router.use() without a path runs on ALL /api requests (including quote_items, inventory, etc.)
const pricingPaths = [
  '/pricing-tiers', '/embroidery-costs', '/contract-pricing',
  '/decg-pricing', '/al-pricing', '/dtg-costs', '/screenprint-costs',
  '/pricing-rules', '/base-item-costs', '/size-pricing',
  '/max-prices-by-style', '/pricing-bundle'
];
pricingPaths.forEach(path => router.use(path, pricingLimiter));

// Sanitize style number input to prevent Caspio WHERE clause injection
function sanitizeStyleNumber(input) {
  if (!input || typeof input !== 'string') return null;
  // Allow alphanumeric, hyphens, and periods only (valid SanMar style format)
  const sanitized = input.replace(/[^a-zA-Z0-9\-\.]/g, '').trim();
  return (sanitized.length > 0 && sanitized.length <= 30) ? sanitized : null;
}

// Cache for pricing bundle (15 minute TTL) - HIGH IMPACT
const pricingBundleCache = new Map();
const PRICING_BUNDLE_CACHE_TTL = 15 * 60 * 1000; // 15 minutes

// Per-style response caches (2026-07-18 Caspio quota reduction). Source data
// only changes on the nightly SanMar sync; `?refresh=true` bypasses. Only
// verified-complete responses are cached (Rule 4 corollary — see ttl-cache.js).
const baseItemCostsCache = createTtlCache({ name: 'base-item-costs', ttlMs: 15 * 60 * 1000, maxEntries: 200 });
const sizePricingCache = createTtlCache({ name: 'size-pricing', ttlMs: 15 * 60 * 1000, maxEntries: 300 });
const maxPricesCache = createTtlCache({ name: 'max-prices-by-style', ttlMs: 15 * 60 * 1000, maxEntries: 200 });

// ─── Full back: ONE ladder, one source (2026-08-15, Erik) ────────────────────
// Full-back embroidery used to have FIVE price sources across three Caspio tables
// (Embroidery_Costs DECG-FB / CTR-FB / FB, Service_Codes 'FB', and per-design
// fbPrice* columns), so what a customer paid depended on WHICH SCREEN the rep used.
// Erik's decision: ONE ladder for everyone, contract included —
//   Embroidery_Costs where ItemType='DECG-FB'.
// Every endpoint's `.fullBack` block is now built from this single read, so the
// surfaces are incapable of disagreeing. CTR-FB and FB rows are retired.
//
// 🔴 Two column traps, both verified against live data — do not "tidy" either:
//   • The rate is in `EmbroideryCost`. `PerThousandRate` is NULL on every DECG-FB
//     row, so preferring it (as the CTR path does) prices full backs at $0.
//   • The small-batch fee is in `LTM`. There is NO `LTM_Fee` column on this table;
//     reading it returned undefined and silently swallowed a real $50 for years.
const fullBackLadderCache = createTtlCache({ name: 'full-back-ladder', ttlMs: 15 * 60 * 1000, maxEntries: 1 });

// Each caller gets its OWN copy. The three endpoints decorate the block with their
// own back-compat key names (`perThousandRates`, `ratePerThousand`), and handing out
// the cached object by reference would let those decorations — and any future rate
// mutation — leak into every other endpoint's response through the shared cache.
function cloneLadder(l) {
  return { ...l, ratesPerThousand: { ...l.ratesPerThousand } };
}

async function getFullBackLadder({ force = false } = {}) {
  if (!force) {
    const cached = fullBackLadderCache.get('decg-fb');
    if (cached !== undefined) return cloneLadder(cached);
  }

  const records = await fetchAllCaspioPages('/tables/Embroidery_Costs/records', {
    'q.where': "ItemType='DECG-FB'"
  });

  const ladder = { ratesPerThousand: {}, minStitches: 25000, ltmFee: 0, ltmThreshold: 0 };
  records.forEach(record => {
    const tier = record.TierLabel;
    if (!tier) return;
    const rate = parseFloat(record.EmbroideryCost) || 0;
    if (rate > 0) ladder.ratesPerThousand[tier] = rate;

    const baseStitches = parseInt(record.BaseStitchCount, 10);
    if (Number.isFinite(baseStitches) && baseStitches > 0) ladder.minStitches = baseStitches;

    // The fee is stamped on the small-batch tier only; that tier is also the threshold.
    const ltm = parseFloat(record.LTM) || 0;
    if (ltm > 0) {
      ladder.ltmFee = ltm;
      const upper = parseInt(String(tier).split('-')[1], 10);
      if (Number.isFinite(upper)) ladder.ltmThreshold = upper;
    }
  });

  // Never fall back to a guessed rate — a missing ladder must surface as an error
  // banner on every consumer, not as a silently cheap full back (Erik's #1 rule).
  if (!Object.keys(ladder.ratesPerThousand).length) {
    throw new Error(
      "No DECG-FB rows found in Embroidery_Costs. Full-back pricing is unavailable; " +
      "refusing to serve a fallback rate."
    );
  }

  fullBackLadderCache.set('decg-fb', ladder);
  return cloneLadder(ladder);
}

// GET /api/pricing-tiers
router.get('/pricing-tiers', async (req, res) => {
  const { method } = req.query;
  console.log(`GET /api/pricing-tiers requested with method=${method}`);

  if (!method) {
    return res.status(400).json({ error: 'Decoration method is required' });
  }

  if (!['DTG', 'ScreenPrint', 'Embroidery', 'EmbroideryShirts'].includes(method)) {
    return res.status(400).json({ error: 'Invalid decoration method. Use DTG, ScreenPrint, Embroidery, or EmbroideryShirts' });
  }

  try {
    let whereClause;
    if (method === 'Embroidery' || method === 'EmbroideryShirts') {
      whereClause = `DecorationMethod='EmbroideryShirts'`;
    } else {
      whereClause = `DecorationMethod='${method}'`;
    }

    const records = await fetchAllCaspioPages('/tables/Pricing_Tiers/records', {
      'q.where': whereClause,
      'q.select': 'PK_ID,TierID,DecorationMethod,TierLabel,MinQuantity,MaxQuantity,MarginDenominator,TargetMargin,LTM_Fee',
      'q.limit': 100
    });
    console.log(`Pricing tiers for ${method}: ${records.length} tier(s) found`);
    res.json(records);
  } catch (error) {
    console.error('Error fetching pricing tiers:', error.message);
    res.status(500).json({ error: 'Failed to fetch pricing tiers', details: error.message });
  }
});

// POST /api/pricing-tiers - Create new pricing tier
router.post('/pricing-tiers', async (req, res) => {
  console.log('POST /api/pricing-tiers - Creating new pricing tier');

  try {
    const result = await makeCaspioRequest('post', '/tables/Pricing_Tiers/records', {}, req.body);
    console.log('Pricing tier created:', result);
    res.status(201).json(result);
  } catch (error) {
    console.error('Error creating pricing tier:', error.message);
    res.status(500).json({ error: 'Failed to create pricing tier', details: error.message });
  }
});

// PUT /api/pricing-tiers/:id - Update pricing tier
router.put('/pricing-tiers/:id', async (req, res) => {
  const { id } = req.params;
  console.log(`PUT /api/pricing-tiers/${id} - Updating pricing tier`);

  try {
    const result = await makeCaspioRequest('put', '/tables/Pricing_Tiers/records',
      { 'q.where': `TierID=${id}` }, req.body);
    console.log('Pricing tier updated:', result);
    res.json({ message: 'Pricing tier updated successfully', updated: result });
  } catch (error) {
    console.error('Error updating pricing tier:', error.message);
    res.status(500).json({ error: 'Failed to update pricing tier', details: error.message });
  }
});

// DELETE /api/pricing-tiers/:id - Delete pricing tier
router.delete('/pricing-tiers/:id', async (req, res) => {
  const { id } = req.params;
  console.log(`DELETE /api/pricing-tiers/${id} - Deleting pricing tier`);

  try {
    const result = await makeCaspioRequest('delete', '/tables/Pricing_Tiers/records',
      { 'q.where': `TierID=${id}` });
    console.log('Pricing tier deleted:', result);
    res.json({ message: 'Pricing tier deleted successfully', recordsAffected: result.RecordsAffected || 0 });
  } catch (error) {
    console.error('Error deleting pricing tier:', error.message);
    res.status(500).json({ error: 'Failed to delete pricing tier', details: error.message });
  }
});

// GET /api/embroidery-costs
router.get('/embroidery-costs', async (req, res) => {
  const { itemType, stitchCount } = req.query;
  console.log(`GET /api/embroidery-costs requested with itemType=${itemType}, stitchCount=${stitchCount}`);

  if (!itemType || !stitchCount) {
    return res.status(400).json({ error: 'Both itemType and stitchCount are required' });
  }

  // Input sanitization: whitelist itemType values
  const allowedItemTypes = ['Shirt', 'Cap', 'AL', 'AL-CAP', '3D-Puff', 'Patch', 'DECG-Garmt', 'DECG-Cap', 'DECG-FB', 'AS-Garm', 'AS-Cap'];
  if (!allowedItemTypes.includes(itemType)) {
    return res.status(400).json({ error: `Invalid itemType. Allowed: ${allowedItemTypes.join(', ')}` });
  }

  // Validate stitchCount is a positive integer
  const stitchCountInt = parseInt(stitchCount, 10);
  if (isNaN(stitchCountInt) || stitchCountInt < 0) {
    return res.status(400).json({ error: 'stitchCount must be a non-negative integer' });
  }

  try {
    const whereClause = `ItemType='${itemType}' AND StitchCount=${stitchCountInt}`;
    const records = await fetchAllCaspioPages('/tables/Embroidery_Costs/records', {
      'q.where': whereClause
    });
    console.log(`Embroidery costs: ${records.length} record(s) found`);
    res.json(records);
  } catch (error) {
    console.error('Error fetching embroidery costs:', error.message);
    res.status(500).json({ error: 'Failed to fetch embroidery costs', details: error.message });
  }
});

// POST /api/embroidery-costs - Create new embroidery cost record
router.post('/embroidery-costs', async (req, res) => {
  console.log('POST /api/embroidery-costs - Creating new embroidery cost record');

  try {
    const result = await makeCaspioRequest('post', '/tables/Embroidery_Costs/records', {}, req.body);
    console.log('Embroidery cost record created:', result);
    res.status(201).json(result);
  } catch (error) {
    console.error('Error creating embroidery cost record:', error.message);
    res.status(500).json({ error: 'Failed to create embroidery cost record', details: error.message });
  }
});

// PUT /api/embroidery-costs/:id - Update embroidery cost record
// Note: Use EmbroideryCostID (not PK_ID) from the record
router.put('/embroidery-costs/:id', async (req, res) => {
  const { id } = req.params;
  console.log(`PUT /api/embroidery-costs/${id} - Updating embroidery cost record`);

  try {
    const result = await makeCaspioRequest('put', '/tables/Embroidery_Costs/records',
      { 'q.where': `EmbroideryCostID=${id}` }, req.body);
    console.log('Embroidery cost record updated:', result);
    res.json({ message: 'Embroidery cost record updated successfully', updated: result });
  } catch (error) {
    console.error('Error updating embroidery cost record:', error.message);
    res.status(500).json({ error: 'Failed to update embroidery cost record', details: error.message });
  }
});

// DELETE /api/embroidery-costs/:id - Delete embroidery cost record
router.delete('/embroidery-costs/:id', async (req, res) => {
  const { id } = req.params;
  console.log(`DELETE /api/embroidery-costs/${id} - Deleting embroidery cost record`);

  try {
    const result = await makeCaspioRequest('delete', '/tables/Embroidery_Costs/records',
      { 'q.where': `EmbroideryCostID=${id}` });
    console.log('Embroidery cost record deleted:', result);
    res.json({ message: 'Embroidery cost record deleted successfully', recordsAffected: result.RecordsAffected || 0 });
  } catch (error) {
    console.error('Error deleting embroidery cost record:', error.message);
    res.status(500).json({ error: 'Failed to delete embroidery cost record', details: error.message });
  }
});

// GET /api/contract-pricing - Contract Embroidery pricing (CTR = Contract)
// Returns linear $/1K rates for production embroidery on customer-supplied items
// Feb 2026 Update: Simplified to perThousandRates structure
// Formula: price = (stitchCount / 1000) * perThousandRate
// Target Revenue: $128/hr (garments) | $112/hr (caps) at 72+ tier
router.get('/contract-pricing', async (req, res) => {
  console.log('GET /api/contract-pricing requested');

  try {
    // Fetch CTR pricing from Embroidery_Costs table
    // ItemType: CTR-Garmt (garments), CTR-Cap (caps), CTR-FB (full back)
    const records = await fetchAllCaspioPages('/tables/Embroidery_Costs/records', {
      'q.where': "ItemType='CTR-Garmt' OR ItemType='CTR-Cap' OR ItemType='CTR-FB'"
    });

    // If no CTR records exist in Caspio, return 404 error (no silent fallbacks!)
    if (records.length === 0) {
      console.error('No CTR records found in Caspio Embroidery_Costs table');
      return res.status(404).json({
        error: 'Contract pricing not configured',
        message: 'No CTR records found in Embroidery_Costs table. Please run: node tests/scripts/update-ctr-pricing-linear.js'
      });
    }

    // Full back is shared across every surface — fetched once, from DECG-FB (see below).
    const fullBackLadder = await getFullBackLadder();

    // Extract $/1K rates from records (using PerThousandRate or calculating from EmbroideryCost/StitchCount)
    // New structure returns perThousandRates by tier for easy frontend calculations
    const pricing = {
      // Fee defaults are ZERO (2026-09-02, Erik): contract small orders are governed by the
      // $250 order minimum (Service_Codes CTR-MIN-ORDER, applied by the calculator), not a
      // fee. A fee only exists if a CTR row carries LTM > 0 in Caspio. The old default of
      // 50.00 meant "no LTM in Caspio" still produced a $50 fee — a hardcoded price.
      garments: {
        perThousandRates: {},
        ltmFee: 0,
        ltmThreshold: 23
      },
      caps: {
        perThousandRates: {},
        ltmFee: 0,
        ltmThreshold: 23
      },
      // 🔴 READ THIS BEFORE "FIXING" IT. These full-back numbers are NOT contract rates
      // and are NOT derived from the CTR-FB rows. Full back is ONE ladder for everyone —
      // contract included — sourced from Embroidery_Costs ItemType='DECG-FB'
      // (Erik, 2026-08-15). ShopWorks has exactly one full-back part, 'DECG-FB', so one
      // part = one price. The key stays `perThousandRates` purely for back-compat with
      // the contract calculator and the reference page; only the SOURCE changed.
      // The CTR-FB rows are retired and should be deleted from Caspio.
      fullBack: fullBackLadder,
      source: 'caspio',
      pricingModel: 'linear-per-thousand'
    };
    // Back-compat alias: this endpoint's consumers read `perThousandRates`, the shared
    // ladder exposes `ratesPerThousand`. Same object, both spellings.
    pricing.fullBack.perThousandRates = fullBackLadder.ratesPerThousand;

    // Process records to extract $/1K rates (one rate per tier)
    // We only need one record per ItemType+TierLabel to get the rate
    const processedTiers = {
      garments: new Set(),
      caps: new Set()
    };

    records.forEach(record => {
      const itemType = record.ItemType;
      const tier = record.TierLabel;
      const ltmFee = parseFloat(record.LTM) || 0;

      // Get the $/1K rate - prefer PerThousandRate field, fallback to calculation
      let perThousandRate = parseFloat(record.PerThousandRate) || 0;
      if (!perThousandRate && record.EmbroideryCost && record.StitchCount) {
        // Calculate from EmbroideryCost / (StitchCount/1000)
        perThousandRate = parseFloat(record.EmbroideryCost) / (parseInt(record.StitchCount) / 1000);
      }

      if (itemType === 'CTR-Garmt' && !processedTiers.garments.has(tier)) {
        pricing.garments.perThousandRates[tier] = parseFloat(perThousandRate.toFixed(2));
        processedTiers.garments.add(tier);
        if (ltmFee > 0) pricing.garments.ltmFee = ltmFee;
      } else if (itemType === 'CTR-Cap' && !processedTiers.caps.has(tier)) {
        pricing.caps.perThousandRates[tier] = parseFloat(perThousandRate.toFixed(2));
        processedTiers.caps.add(tier);
        if (ltmFee > 0) pricing.caps.ltmFee = ltmFee;
      }
      // CTR-FB is deliberately ignored — full back comes from the shared DECG-FB ladder.
    });

    console.log(`Contract pricing: ${records.length} record(s) found - Garment tiers: ${Object.keys(pricing.garments.perThousandRates).length}, Cap tiers: ${Object.keys(pricing.caps.perThousandRates).length}, FB tiers: ${Object.keys(pricing.fullBack.perThousandRates).length}`);
    res.json(pricing);
  } catch (error) {
    console.error('Error fetching contract pricing:', error.message);
    res.status(500).json({ error: 'Failed to fetch contract pricing', details: error.message });
  }
});

// GET /api/decg-pricing - Customer Supplied Embroidery pricing (DECG = Di. Embroider Customer Garments)
// Returns tiered pricing for garments, caps, and full back embroidery on customer-supplied items
router.get('/decg-pricing', async (req, res) => {
  console.log('GET /api/decg-pricing requested');

  try {
    // Fetch DECG pricing from Embroidery_Costs table
    // ItemType can be: DECG-Garmt, DECG-Cap, DECG-FB (Full Back)
    // Note: Caspio REST API doesn't support LIKE with wildcards, so use explicit OR conditions
    const records = await fetchAllCaspioPages('/tables/Embroidery_Costs/records', {
      'q.where': "ItemType='DECG-Garmt' OR ItemType='DECG-Cap' OR ItemType='DECG-FB'"
    });

    // If no DECG records exist in Caspio, return 404 error (no silent fallbacks!)
    if (records.length === 0) {
      console.error('No DECG records found in Caspio Embroidery_Costs table');
      return res.status(404).json({
        error: 'DECG pricing not configured',
        message: 'No DECG records found in Embroidery_Costs table. Please add records with ItemType: DECG-Garmt, DECG-Cap, DECG-FB'
      });
    }

    // Process Caspio records into structured pricing object.
    // `fullBack` comes from the shared ladder below so this endpoint, /api/contract-pricing
    // and /api/al-pricing cannot disagree. `minQuantity` is deliberately GONE: the rows
    // carried both "min 8 pieces" and a 1-7 tier with a $50 fee, which contradicted.
    // Erik's ruling (2026-08-15): full backs under 8 are allowed and carry the fee.
    const pricing = {
      garments: { basePrices: {}, perThousandUpcharge: 1.25, ltmFee: 0, ltmThreshold: 7 },
      caps: { basePrices: {}, perThousandUpcharge: 1.00, ltmFee: 0, ltmThreshold: 7 },
      fullBack: await getFullBackLadder(),
      heavyweightSurcharge: 10.00,
      source: 'caspio'
    };

    records.forEach(record => {
      const itemType = record.ItemType;
      const tier = record.TierLabel;
      const cost = parseFloat(record.EmbroideryCost) || 0;
      // 🔴 `LTM`, not `LTM_Fee` — there is NO LTM_Fee column on Embroidery_Costs. Reading
      // it returned undefined, so this fee was always 0 and the garment/cap $50 you saw
      // came from a hardcoded default, NOT from Caspio. Editing the fee in Caspio did
      // nothing. Verified live 2026-08-15: DECG-Garmt and DECG-Cap 1-7 rows both hold 50.
      const ltmFee = parseFloat(record.LTM) || 0;

      if (itemType === 'DECG-Garmt') {
        pricing.garments.basePrices[tier] = cost;
        if (ltmFee > 0) pricing.garments.ltmFee = ltmFee;
      } else if (itemType === 'DECG-Cap') {
        pricing.caps.basePrices[tier] = cost;
        if (ltmFee > 0) pricing.caps.ltmFee = ltmFee;
      }
      // DECG-FB is intentionally NOT handled here — see fullBack above.
    });

    console.log(`DECG pricing: ${records.length} record(s) found`);
    res.json(pricing);
  } catch (error) {
    console.error('Error fetching DECG pricing:', error.message);
    res.status(500).json({ error: 'Failed to fetch DECG pricing', details: error.message });
  }
});

// GET /api/al-pricing - Additional Logo / Contract Embroidery pricing (unified)
// Returns tiered pricing for AL garments, AL-CAP/CB/CS caps, and FB full back
// Used by: Embroidery Pricing All page, Quote Builders, Contract Embroidery Calculator
router.get('/al-pricing', async (req, res) => {
  console.log('GET /api/al-pricing requested');

  try {
    // Fetch AL pricing from Embroidery_Costs table
    // ItemType can be: AL, AL-CAP, CB, CS, FB
    const records = await fetchAllCaspioPages('/tables/Embroidery_Costs/records', {
      'q.where': "ItemType='AL' OR ItemType='AL-CAP' OR ItemType='CB' OR ItemType='CS' OR ItemType='FB'"
    });

    // If no AL records exist in Caspio, return 404 error (no silent fallbacks!)
    if (records.length === 0) {
      console.error('No AL records found in Caspio Embroidery_Costs table');
      return res.status(404).json({
        error: 'AL pricing not configured',
        message: 'No AL records found in Embroidery_Costs table. Please run: node tests/scripts/update-embroidery-costs.js'
      });
    }

    // Full back is shared across every surface — fetched once, from DECG-FB.
    const fullBackLadder = await getFullBackLadder();

    // Process Caspio records into structured pricing object
    const pricing = {
      garments: {
        basePrices: {},
        perThousandUpcharge: 1.00,
        baseStitches: 5000,
        ltmFee: 50.00,
        ltmThreshold: 7
      },
      caps: {
        basePrices: {},
        perThousandUpcharge: 1.00,
        baseStitches: 5000,
        ltmFee: 50.00,
        ltmThreshold: 7
      },
      // Full back is the ONE shared ladder (Embroidery_Costs ItemType='DECG-FB'), not the
      // flat `FB` row this endpoint used to read. `ratesPerThousand` (tiered) is the real
      // answer and is what the quote builder now uses; `ratePerThousand` is kept as a
      // back-compat scalar for older readers and is the *highest* tier's rate so a stale
      // consumer under-quotes nobody. The FB rows are retired — delete them from Caspio.
      fullBack: fullBackLadder,
      fees: {
        ltm: { threshold: 7, amount: 50.00 },
        extraColors: { threshold: 5, perColorPerPiece: 1.00 }
      },
      source: 'caspio'
    };
    pricing.fullBack.ratePerThousand = Math.max(...Object.values(fullBackLadder.ratesPerThousand));

    records.forEach(record => {
      const itemType = record.ItemType;
      const tier = record.TierLabel;
      const cost = parseFloat(record.EmbroideryCost) || 0;
      const ltmFee = parseFloat(record.LTM_Fee) || 0;
      const additionalRate = parseFloat(record.AdditionalStitchRate) || 0;
      const baseStitches = parseInt(record.BaseStitchCount) || 0;

      if (itemType === 'AL') {
        pricing.garments.basePrices[tier] = cost;
        if (ltmFee > 0) pricing.garments.ltmFee = ltmFee;
        if (additionalRate > 0) pricing.garments.perThousandUpcharge = additionalRate;
        if (baseStitches > 0) pricing.garments.baseStitches = baseStitches;
      } else if (itemType === 'AL-CAP' || itemType === 'CB' || itemType === 'CS') {
        // All cap locations use same pricing - use AL-CAP as primary
        if (itemType === 'AL-CAP' || !pricing.caps.basePrices[tier]) {
          pricing.caps.basePrices[tier] = cost;
        }
        if (ltmFee > 0) pricing.caps.ltmFee = ltmFee;
        if (additionalRate > 0) pricing.caps.perThousandUpcharge = additionalRate;
        if (baseStitches > 0) pricing.caps.baseStitches = baseStitches;
      }
      // ItemType 'FB' is deliberately ignored — full back comes from the shared
      // DECG-FB ladder above. The FB rows are retired; delete them from Caspio.
    });

    // Update fee structure from actual data
    if (pricing.garments.ltmFee) {
      pricing.fees.ltm.amount = pricing.garments.ltmFee;
    }

    console.log(`AL pricing: ${records.length} record(s) found`);
    res.json(pricing);
  } catch (error) {
    console.error('Error fetching AL pricing:', error.message);
    res.status(500).json({ error: 'Failed to fetch AL pricing', details: error.message });
  }
});

// GET /api/dtg-costs
router.get('/dtg-costs', async (req, res) => {
  console.log('GET /api/dtg-costs requested');

  try {
    const records = await fetchAllCaspioPages('/tables/DTG_Costs/records');
    console.log(`DTG costs: ${records.length} record(s) found`);
    res.json(records);
  } catch (error) {
    console.error('Error fetching DTG costs:', error.message);
    res.status(500).json({ error: 'Failed to fetch DTG costs', details: error.message });
  }
});

// GET /api/screenprint-costs
router.get('/screenprint-costs', async (req, res) => {
  const { costType } = req.query;
  console.log(`GET /api/screenprint-costs requested with costType=${costType}`);

  if (!costType) {
    return res.status(400).json({ error: 'costType is required (PrimaryLocation or AdditionalLocation)' });
  }

  let tableName = costType === 'PrimaryLocation' ? 'Screenprint_Costs' : 'Screenprint_Costs_2';

  try {
    const records = await fetchAllCaspioPages(`/tables/${tableName}/records`);
    console.log(`Screenprint costs (${costType}): ${records.length} record(s) found`);
    res.json(records);
  } catch (error) {
    console.error('Error fetching screenprint costs:', error.message);
    res.status(500).json({ error: 'Failed to fetch screenprint costs', details: error.message });
  }
});

// GET /api/pricing-rules
router.get('/pricing-rules', async (req, res) => {
  const { method } = req.query;
  console.log(`GET /api/pricing-rules requested with method=${method}`);

  if (!method) {
    return res.status(400).json({ error: 'Decoration method is required' });
  }

  try {
    const whereClause = `DecorationMethod='${method}'`;
    const records = await fetchAllCaspioPages('/tables/Pricing_Rules/records', {
      'q.where': whereClause
    });
    console.log(`Pricing rules for ${method}: ${records.length} rule(s) found`);
    res.json(records);
  } catch (error) {
    console.error('Error fetching pricing rules:', error.message);
    res.status(500).json({ error: 'Failed to fetch pricing rules', details: error.message });
  }
});

// GET /api/base-item-costs
router.get('/base-item-costs', async (req, res) => {
  const { styleNumber } = req.query;
  console.log(`GET /api/base-item-costs requested with styleNumber=${styleNumber}`);

  if (!styleNumber) {
    return res.status(400).json({ error: 'styleNumber is required' });
  }

  try {
    const safeStyle = sanitizeStyleNumber(styleNumber);
    if (!safeStyle) return res.status(400).json({ error: 'Invalid style number format' });

    const cacheKey = makeKey({ style: safeStyle.toUpperCase() });
    if (!shouldBypass(req)) {
      const cached = baseItemCostsCache.get(cacheKey);
      if (cached !== undefined) return res.json(cached);
    }

    const whereClause = `STYLE='${safeStyle}'`;
    const records = await fetchAllCaspioPages('/tables/Sanmar_Bulk_251816_Feb2024/records', {
      'q.where': whereClause,
      'q.select': 'SIZE, CASE_PRICE'
    });

    if (records.length === 0) {
      return res.status(404).json({ error: 'Style not found' });
    }

    const baseCosts = {};

    records.forEach(record => {
      if (record.SIZE && record.CASE_PRICE !== null && record.CASE_PRICE !== undefined) {
        baseCosts[record.SIZE] = parseFloat(record.CASE_PRICE);
      }
    });

    console.log(`Base costs for ${styleNumber}:`, baseCosts);
    const response = {
      styleNumber: styleNumber,
      baseCosts: baseCosts
    };
    baseItemCostsCache.set(cacheKey, response);
    res.json(response);
  } catch (error) {
    console.error('Error fetching base item costs:', error.message);
    res.status(500).json({ error: 'Failed to fetch base item costs', details: error.message });
  }
});

// GET /api/size-pricing
router.get('/size-pricing', async (req, res) => {
  const { styleNumber, color } = req.query;
  console.log(`GET /api/size-pricing requested with styleNumber=${styleNumber}, color=${color}`);

  if (!styleNumber) {
    return res.status(400).json({ error: 'styleNumber is required' });
  }

  try {
    const safeStyle = sanitizeStyleNumber(styleNumber);
    if (!safeStyle) return res.status(400).json({ error: 'Invalid style number format' });

    const force = shouldBypass(req);
    const cacheKey = makeKey({
      style: safeStyle.toUpperCase(),
      color: color ? String(color).trim().toLowerCase() : null
    });
    if (!force) {
      const cached = sizePricingCache.get(cacheKey);
      if (cached !== undefined) return res.json(cached);
    }

    let whereClause = `STYLE='${safeStyle}'`;
    if (color) {
      const safeColor = color.replace(/'/g, "''").substring(0, 100);
      whereClause += ` AND COLOR_NAME='${safeColor}'`;
    }

    // Fetch pricing data and (1h-cached) size upcharges in parallel. The
    // upcharge getter throws on cold-fetch failure — same 500 as before.
    const [records, sizeUpcharges] = await Promise.all([
      fetchAllCaspioPages('/tables/Sanmar_Bulk_251816_Feb2024/records', {
        'q.where': whereClause,
        'q.select': 'STYLE, COLOR_NAME, SIZE, CASE_PRICE'
      }),
      getSizeUpchargeRows({ force })
    ]);

    if (records.length === 0) {
      return res.status(404).json({ error: 'No inventory records found for the specified criteria' });
    }

    // Create upcharge lookup map
    const upchargeMap = {};
    sizeUpcharges.forEach(upcharge => {
      upchargeMap[upcharge.SizeDesignation] = parseFloat(upcharge.StandardAddOnAmount) || 0;
    });

    // Group records by color and organize sizes with their prices
    const priceData = {};
    
    records.forEach(record => {
      const colorKey = record.COLOR_NAME;
      if (!priceData[colorKey]) {
        priceData[colorKey] = {
          styleNumber: record.STYLE,
          color: record.COLOR_NAME,
          basePrices: {},
          sizeUpcharges: {}
        };
      }
      
      if (record.SIZE && record.CASE_PRICE !== null && record.CASE_PRICE !== undefined) {
        const basePrice = parseFloat(record.CASE_PRICE) || 0;
        const upcharge = upchargeMap[record.SIZE] || 0;
        
        priceData[colorKey].basePrices[record.SIZE] = basePrice;
        if (upcharge > 0) {
          priceData[colorKey].sizeUpcharges[record.SIZE] = upcharge;
        }
      }
    });

    // Convert to array format
    const result = Object.values(priceData);

    console.log(`Size pricing for ${styleNumber}: ${result.length} color(s) found`);
    sizePricingCache.set(cacheKey, result);
    res.json(result);
  } catch (error) {
    console.error('Error fetching size pricing:', error.message);
    res.status(500).json({ error: 'Failed to fetch size pricing', details: error.message });
  }
});

// GET /api/max-prices-by-style
router.get('/max-prices-by-style', async (req, res) => {
  const { styleNumber } = req.query;
  console.log(`GET /api/max-prices-by-style requested with styleNumber=${styleNumber}`);

  if (!styleNumber) {
    return res.status(400).json({ error: 'Missing required query parameter: styleNumber' });
  }

  try {
    console.log(`Fetching data for /api/max-prices-by-style for style: ${styleNumber}`);

    const safeStyle = sanitizeStyleNumber(styleNumber);
    if (!safeStyle) return res.status(400).json({ error: 'Invalid style number format' });

    const force = shouldBypass(req);
    const cacheKey = makeKey({ style: safeStyle.toUpperCase() });
    if (!force) {
      const cached = maxPricesCache.get(cacheKey);
      if (cached !== undefined) return res.json(cached);
    }

    // 1. Fetch Selling Price Display Add-Ons from Standard_Size_Upcharges
    // (1h-cached). Track success — a degraded {} payload must not be cached.
    let sellingPriceDisplayAddOns = {};
    let upchargeFetchSucceeded = true;
    try {
      const upchargeResults = await getSizeUpchargeRows({ force });

      upchargeResults.forEach(rule => {
        if (rule.SizeDesignation && rule.StandardAddOnAmount !== null && !isNaN(parseFloat(rule.StandardAddOnAmount))) {
          sellingPriceDisplayAddOns[String(rule.SizeDesignation).trim().toUpperCase()] = parseFloat(rule.StandardAddOnAmount);
        }
      });

      console.log("Fetched Selling Price Display Add-Ons for /max-prices-by-style:", sellingPriceDisplayAddOns);
    } catch (upchargeError) {
      console.error("Error fetching Selling Price Display Add-Ons for /max-prices-by-style:", upchargeError.message);
      sellingPriceDisplayAddOns = {};
      upchargeFetchSucceeded = false;
    }

    // 2. Fetch Inventory Data from Sanmar table (using STYLE field to match catalog_no)
    const inventoryWhereClause = `STYLE='${safeStyle}'`;
    const inventoryParams = {
      'q.where': inventoryWhereClause,
      'q.select': 'SIZE,CASE_PRICE',
      'q.limit': 1000
    };
    const inventoryResult = await fetchAllCaspioPages('/tables/Sanmar_Bulk_251816_Feb2024/records', inventoryParams);

    if (inventoryResult.length === 0) {
      console.warn(`No inventory found for style: ${styleNumber}`);
      return res.json({
        style: styleNumber, 
        sizes: [], 
        sellingPriceDisplayAddOns: sellingPriceDisplayAddOns,
        message: `No inventory records found for style ${styleNumber}`
      });
    }

    // 3. Calculate max garment costs per size
    const garmentCosts = {};
    inventoryResult.forEach(item => {
      if (item.SIZE && item.CASE_PRICE !== null && !isNaN(parseFloat(item.CASE_PRICE))) {
        const size = String(item.SIZE).trim().toUpperCase();
        const casePrice = parseFloat(item.CASE_PRICE);
        
        if (!garmentCosts[size] || casePrice > garmentCosts[size]) {
          garmentCosts[size] = casePrice;
        }
      }
    });

    // 4. Format response with sizes array
    const sizes = Object.keys(garmentCosts).map(size => ({
      size: size,
      maxCasePrice: garmentCosts[size]
    }));

    console.log(`Max prices found for ${styleNumber}: ${sizes.length} size(s)`);

    const response = {
      style: styleNumber,
      sizes: sizes,
      sellingPriceDisplayAddOns: sellingPriceDisplayAddOns
    };
    // Only cache complete payloads: non-empty sizes AND upcharges fetched OK.
    if (sizes.length > 0 && upchargeFetchSucceeded) {
      maxPricesCache.set(cacheKey, response);
    }
    res.json(response);

  } catch (error) {
    console.error('Error fetching max prices:', error.message);
    res.status(500).json({ error: 'Failed to fetch max prices', details: error.message });
  }
});

// GET /api/pricing-bundle
router.get('/pricing-bundle', async (req, res) => {
  const { method, styleNumber } = req.query;
  console.log(`GET /api/pricing-bundle requested with method=${method}, styleNumber=${styleNumber || 'none'}`);

  if (!method) {
    return res.status(400).json({ error: 'Decoration method is required' });
  }

  const validMethods = ['DTG', 'DTG_Store', 'EMB', 'CAP', 'ScreenPrint', 'DTF', 'EMB-AL', 'CAP-AL', 'BLANK', 'PATCH', 'CAP-PUFF'];
  if (!validMethods.includes(method)) {
    return res.status(400).json({ error: `Invalid decoration method. Use one of: ${validMethods.join(', ')}` });
  }

  // Map user-friendly method names to database values
  const methodMapping = {
    'EMB': 'EmbroideryShirts',
    'CAP': 'EmbroideryCaps',
    'DTG': 'DTG',
    'DTG_Store': 'DTG_Store',        // Retail storefront: own tiers/margin/LTM, reuses DTG print costs
    'ScreenPrint': 'ScreenPrint',
    'DTF': 'DTF',
    'EMB-AL': 'EmbroideryShirts',  // Additional Logo uses same tiers as regular embroidery
    'CAP-AL': 'EmbroideryCaps',      // Cap Additional Logo uses same tiers as regular caps
    'BLANK': 'Blank',
    'PATCH': 'LaserPatches',         // Laser leatherette patches for caps
    'CAP-PUFF': 'EmbroideryCaps'     // 3D Puff uses same tiers as regular cap embroidery
  };

  // Map methods to location types
  const locationTypeMapping = {
    'DTG': 'DTG',
    'EMB': 'EMB',
    'CAP': 'CAP',
    'ScreenPrint': 'Screen',
    'DTF': 'DTF',
    'EMB-AL': 'EMB',  // Additional Logo uses same locations as embroidery
    'CAP-AL': 'CAP',   // Cap Additional Logo uses same locations as caps
    'BLANK': null,     // Blank products have no print locations
    'PATCH': 'PATCH',  // Front only for patches
    'CAP-PUFF': 'CAP'  // 3D Puff uses same locations as caps
  };

  // DTG_Store reuses DTG's print costs, locations, rounding rules and cost transform —
  // ONLY its pricing TIERS come from its own Pricing_Tiers rows (DecorationMethod='DTG_Store').
  // So dbMethod (tiers) stays method-specific while everything else keys off costMethod.
  const costMethod = (method === 'DTG_Store') ? 'DTG' : method;
  const dbMethod = methodMapping[method];
  const locationType = locationTypeMapping[costMethod];

  // Check cache (parameter-aware)
  const cacheKey = JSON.stringify({ method, styleNumber });
  const now = Date.now();
  const cached = pricingBundleCache.get(cacheKey);
  const forceRefresh = req.query.refresh === 'true';

  if (!forceRefresh && cached && (now - cached.timestamp) < PRICING_BUNDLE_CACHE_TTL) {
    console.log(`[CACHE HIT] pricing-bundle - ${method} ${styleNumber || 'no-style'}`);
    return res.json(cached.data);
  }
  console.log(`[CACHE MISS] pricing-bundle - ${method} ${styleNumber || 'no-style'}`);

  try {
    // Base queries that always run - wrapped to handle failures gracefully
    const baseQueries = [
      // Fetch pricing tiers
      getPricingTierRows(dbMethod, { force: forceRefresh }).catch(err => {
        console.error('Failed to fetch pricing tiers:', err.message);
        return [];
      }),
      
      // Fetch pricing rules (DTG_Store reuses DTG's rounding rule via costMethod)
      getPricingRuleRows(methodMapping[costMethod], { force: forceRefresh }).catch(err => {
        console.error('Failed to fetch pricing rules:', err.message);
        return [];
      }),

      // Fetch locations (skip if locationType is null - e.g., BLANK products)
      locationType ?
        getLocationRows(locationType, { force: forceRefresh }).catch(err => {
          console.error('Failed to fetch locations:', err.message);
          return [];
        }) :
        Promise.resolve([])
    ];

    // Add method-specific cost table query with error handling.
    // The method -> table mapping now lives in caspio-static-tables.js so the
    // cache key and the query are chosen in one place and cannot drift apart
    // (a coarser key would serve another method's prices). BLANK yields [];
    // an unknown costMethod yields undefined, exactly as the old switch did.
    const costTableQuery = Promise.resolve(getCostTableRows(costMethod, { force: forceRefresh }))
      .catch(err => {
        console.error(`Failed to fetch cost table for ${costMethod}:`, err.message);
        return [];
      });
    baseQueries.push(costTableQuery);

    // For DTF, also fetch Transfer_Freight table
    if (method === 'DTF') {
      baseQueries.push(
        getTransferFreightRows({ force: forceRefresh })
          .catch(err => {
            console.error('Failed to fetch DTF freight costs:', err.message);
            return [];
          })
      );
    }

    // If styleNumber is provided, also fetch size-specific data
    if (styleNumber) {
      // Add the size upcharges query (1h static-table cache) with error handling
      baseQueries.push(
        getSizeUpchargeRows({ force: forceRefresh }).catch(err => {
          console.error('Failed to fetch size upcharges:', err.message);
          return [];
        })
      );

      // Add the Sanmar query for sizes with error handling. An unsanitizable
      // style yields [] — never fall back to interpolating the raw input.
      const safeBundleStyle = sanitizeStyleNumber(styleNumber);
      baseQueries.push(
        safeBundleStyle
          ? fetchAllCaspioPages('/tables/Sanmar_Bulk_251816_Feb2024/records', {
              'q.where': `STYLE='${safeBundleStyle}'`,
              'q.select': 'SIZE, MAX(CASE_PRICE) AS MAX_PRICE',
              'q.groupBy': 'SIZE',
              'q.limit': 100
            }).catch(err => {
              console.error(`Failed to fetch inventory for style ${styleNumber}:`, err.message);
              return [];
            })
          : Promise.resolve([])
      );

      // Add the Size Display Order query (1h static-table cache) with error handling
      baseQueries.push(
        getSizeDisplayOrderRows({ force: forceRefresh }).catch(err => {
          console.error('Failed to fetch size display order:', err.message);
          return [];
        })
      );
    }

    // Execute all queries in parallel
    const results = await Promise.all(baseQueries);
    
    // Destructure base results - handle DTF freight query
    let tiers, rules, locationsResult, costs, freightData;
    if (method === 'DTF') {
      [tiers, rules, locationsResult, costs, freightData] = results;
    } else {
      [tiers, rules, locationsResult, costs] = results;
      freightData = [];
    }

    console.log(`Pricing bundle for ${method}: ${tiers.length} tier(s), ${rules.length} rule(s), ${costs.length} cost record(s), ${locationsResult.length} location(s)`);

    // Format locations for response
    const locations = locationsResult.map(loc => ({
      code: loc.location_code,
      name: loc.location_name
    }));

    // Process rules into an object
    const rulesObject = {};
    rules.forEach(rule => {
      if (rule.RuleName && rule.RuleValue) {
        rulesObject[rule.RuleName] = rule.RuleValue;
      }
    });

    // Initialize response with ALL required fields to ensure complete structure
    // This guarantees the response always has the expected shape
    const response = {
      tiersR: [],
      rulesR: {},
      locations: []
    };

    // Add method-specific cost field with empty default
    switch (costMethod) {
      case 'DTG':
        response.allDtgCostsR = [];
        break;
      case 'EMB':
      case 'CAP':
      case 'EMB-AL':
      case 'CAP-AL':
      case 'CAP-PUFF':
        response.allEmbroideryCostsR = [];
        break;
      case 'PATCH':
        response.allPatchCostsR = [];
        break;
      case 'ScreenPrint':
        response.allScreenprintCostsR = [];
        break;
      case 'DTF':
        response.allDtfCostsR = [];
        response.freightR = [];
        break;
      case 'BLANK':
        // Blank products don't need cost fields - only tiers, rules, and sizes
        break;
    }

    // If styleNumber is provided, add the size-specific fields
    if (styleNumber) {
      response.sizes = [];
      response.sellingPriceDisplayAddOns = {};
    }

    // Now populate with actual data if available
    response.tiersR = tiers || [];

    response.rulesR = rulesObject || {};
    response.locations = locations || [];

    // Update costs with actual data
    switch (costMethod) {
      case 'DTG':
        response.allDtgCostsR = costs || [];
        break;
      case 'EMB':
      case 'CAP':
      case 'EMB-AL':
      case 'CAP-AL':
      case 'CAP-PUFF':
        response.allEmbroideryCostsR = costs || [];
        break;
      case 'PATCH':
        response.allPatchCostsR = costs || [];
        break;
      case 'ScreenPrint':
        response.allScreenprintCostsR = costs || [];
        break;
      case 'DTF':
        response.allDtfCostsR = costs || [];
        response.freightR = freightData || [];
        break;
      case 'BLANK':
        // Blank products don't have cost data to populate
        break;
    }

    // If styleNumber was provided, process and add size-specific data.
    // The style-specific queries (upcharges, inventory, sizeOrder) are appended
    // AFTER the base queries [tiers, rules, locations, costs]. DTF inserts an
    // extra Transfer_Freight query between the cost query and the style queries,
    // so for DTF the style block starts one slot later. A fixed `[, , , ,]` skip
    // mis-read DTF's slots (freight→upcharges, upcharges→inventory) → garmentCosts
    // empty → `sizes: []` → the Order Form's DTF garment cost was unavailable and
    // it silently under-priced (no garment markup/labor/freight). Compute the
    // offset from the method instead.
    const styleQueryStart = (method === 'DTF') ? 5 : 4;
    if (styleNumber && results.length >= styleQueryStart + 3) {
        const upchargeResults = results[styleQueryStart];
        const inventoryResult = results[styleQueryStart + 1];
        const sizeOrderResults = results[styleQueryStart + 2];

        // Process selling price display add-ons
        let sellingPriceDisplayAddOns = {};
        if (upchargeResults && upchargeResults.length > 0) {
          upchargeResults.forEach(rule => {
            if (rule.SizeDesignation && rule.StandardAddOnAmount !== null && !isNaN(parseFloat(rule.StandardAddOnAmount))) {
              sellingPriceDisplayAddOns[String(rule.SizeDesignation).trim().toUpperCase()] = parseFloat(rule.StandardAddOnAmount);
            }
          });
        }
        
        // Create size order lookup map
        const sizeOrderMap = {};
        if (sizeOrderResults && sizeOrderResults.length > 0) {
          sizeOrderResults.forEach(item => {
            if (item.size && item.sort_order !== null) {
              sizeOrderMap[item.size.toUpperCase()] = item.sort_order;
            }
          });
        }
        
        // Process Sanmar data to get sizes
        const garmentCosts = {};
        
        if (inventoryResult && inventoryResult.length > 0) {
          inventoryResult.forEach(item => {
            if (item.SIZE && item.MAX_PRICE !== null && !isNaN(parseFloat(item.MAX_PRICE))) {
              const sizeKey = String(item.SIZE).trim().toUpperCase();
              const price = parseFloat(item.MAX_PRICE);
              
              // Data is already grouped by SIZE with MAX price
              garmentCosts[sizeKey] = price;
            }
          });
        }
        
        // Sort sizes by sort order from Size_Display_Order table
        const sortedSizeKeys = Object.keys(garmentCosts).sort((a, b) => {
          const orderA = sizeOrderMap[a] || 999;
          const orderB = sizeOrderMap[b] || 999;
          return orderA - orderB;
        });
        
        // Add size-specific data to response
        response.sizes = sortedSizeKeys.map(sizeKey => ({
          size: sizeKey,
          price: garmentCosts[sizeKey],
          sortOrder: sizeOrderMap[sizeKey] || 999
        }));
        response.sellingPriceDisplayAddOns = sellingPriceDisplayAddOns;
        
        console.log(`Added size data for ${styleNumber}: ${sortedSizeKeys.length} sizes found`);
    }

    // Final validation to ensure response has ALL required fields
    const validateAndFixResponse = (resp, hasStyleNumber) => {
      const requiredStructure = {
        tiersR: [],
        rulesR: {},
        locations: []
      };
      
      // Add method-specific cost field
      switch (costMethod) {
        case 'DTG':
          requiredStructure.allDtgCostsR = [];
          break;
        case 'EMB':
        case 'CAP':
        case 'EMB-AL':
        case 'CAP-AL':
        case 'CAP-PUFF':
          requiredStructure.allEmbroideryCostsR = [];
          break;
        case 'PATCH':
          requiredStructure.allPatchCostsR = [];
          break;
        case 'ScreenPrint':
          requiredStructure.allScreenprintCostsR = [];
          break;
        case 'DTF':
          requiredStructure.allDtfCostsR = [];
          requiredStructure.freightR = [];
          break;
        case 'BLANK':
          // Blank products don't need cost fields
          break;
      }

      // Add style-specific fields if styleNumber provided
      if (hasStyleNumber) {
        requiredStructure.sizes = [];
        requiredStructure.sellingPriceDisplayAddOns = {};
      }
      
      // Merge with defaults to guarantee all fields exist
      const validatedResponse = { ...requiredStructure };
      
      // Copy over actual data, ensuring correct types
      Object.keys(requiredStructure).forEach(key => {
        if (resp[key] !== undefined && resp[key] !== null) {
          // Ensure arrays are arrays and objects are objects
          if (Array.isArray(requiredStructure[key])) {
            validatedResponse[key] = Array.isArray(resp[key]) ? resp[key] : [];
          } else if (typeof requiredStructure[key] === 'object') {
            validatedResponse[key] = (typeof resp[key] === 'object' && !Array.isArray(resp[key])) ? resp[key] : {};
          } else {
            validatedResponse[key] = resp[key];
          }
        }
      });
      
      return validatedResponse;
    };
    
    // Validate and send response
    const finalResponse = validateAndFixResponse(response, !!styleNumber);
    console.log(`Sending response for ${method} with ${styleNumber ? `style ${styleNumber}` : 'no style'}: ${JSON.stringify(Object.keys(finalResponse))}`);

    // Cache the response
    pricingBundleCache.set(cacheKey, {
      data: finalResponse,
      timestamp: now
    });
    console.log(`[CACHE SET] pricing-bundle - ${method} ${styleNumber || 'no-style'} - Cache size: ${pricingBundleCache.size}`);

    // Limit cache size (keep last 100 entries)
    if (pricingBundleCache.size > 100) {
      const firstKey = pricingBundleCache.keys().next().value;
      pricingBundleCache.delete(firstKey);
    }

    res.json(finalResponse);
  } catch (error) {
    console.error('Error fetching pricing bundle:', error.message);
    res.status(500).json({
      error: 'Failed to load pricing data from Caspio',
      message: error.message
    });
  }
});

module.exports = router;
// Exported for tests: full back is one ladder for every surface, and nothing else
// pinned its rates before 2026-08-15. See tests/jest/full-back-one-ladder.test.js.
module.exports.getFullBackLadder = getFullBackLadder;