// DTG-specific routes including the optimized product-bundle endpoint

const express = require('express');
const router = express.Router();
const { fetchAllCaspioPages } = require('../utils/caspio');
const { priceLines, ALL_LOCATION_CODES } = require('../../lib/dtg-canonical-pricing');
const { createTtlCache, shouldBypass, makeKey } = require('../utils/ttl-cache');
const {
  getSizeUpchargeRows,
  getDtgPricingTierRows,
  getDtgCostRows
} = require('../utils/caspio-static-tables');

const INTERNAL_API_BASE = process.env.PROXY_PUBLIC_URL
    || 'https://caspio-pricing-proxy-ab30a049961a.herokuapp.com';

// Sanitize style number input to prevent Caspio WHERE clause injection.
// Copied verbatim from src/routes/pricing.js:32 (same helper also in products.js,
// inventory.js, quotes.js). This route interpolated raw req.query into q.where
// until 2026-07-28.
function sanitizeStyleNumber(input) {
  if (!input || typeof input !== 'string') return null;
  // Allow alphanumeric, hyphens, and periods only (valid SanMar style format)
  const sanitized = input.replace(/[^a-zA-Z0-9\-\.]/g, '').trim();
  return (sanitized.length > 0 && sanitized.length <= 30) ? sanitized : null;
}

// Per-style bundle cache. Keyed on the sanitized style ONLY — never on color.
// The Caspio read is per-style, and the colour view is derived in memory below,
// so one entry serves every ?color= variant instead of caching up to 82
// near-identical copies of the same ~23 KB payload.
// 15 min matches /api/pricing-bundle so the two routes cannot disagree about a
// price for longer than one window. Worst-case staleness is 15 min, NOT 30:
// the price tables are read through their own 15-min cache, but an entry here is
// built from whatever those held at build time and expires on its own clock.
const dtgBundleCache = createTtlCache({
  name: 'dtg-product-bundle',
  ttlMs: 15 * 60 * 1000,
  maxEntries: 300
});

// GET /api/dtg/product-bundle
// Optimized endpoint that combines product, pricing, and DTG data in a single request
router.get('/product-bundle', async (req, res) => {
  const { styleNumber, color } = req.query;
  console.log(`GET /api/dtg/product-bundle requested with styleNumber=${styleNumber}, color=${color}`);

  if (!styleNumber) {
    return res.status(400).json({ error: 'styleNumber is required' });
  }

  const safeStyle = sanitizeStyleNumber(styleNumber);
  if (!safeStyle) {
    return res.status(400).json({ error: 'styleNumber is invalid' });
  }
  const styleKey = safeStyle.toUpperCase();

  try {
    const forceRefresh = shouldBypass(req);
    const cacheKey = makeKey({ style: styleKey });

    // Cache holds the ALL-COLORS bundle; the per-request colour view is derived
    // from it below, so a ?color= request can still be served from a warm entry.
    let response = forceRefresh ? undefined : dtgBundleCache.get(cacheKey);

    if (!response) {
      // ONE Sanmar_Bulk read, not two. This endpoint used to scan the 251k-row
      // table twice per request — once for colours/images (page size 200, so PC54
      // paid 4 billed pages) and again for SIZE/CASE_PRICE. The union select at
      // page size 1000 makes PC54 a single billed call: 8 -> 1.
      // q.orderBy is mandatory on a multi-page read (unordered Caspio pagination
      // silently drops and duplicates rows); strict:true turns a maxPages
      // truncation into a throw instead of a short, plausible-looking result.
      const productPromise = fetchAllCaspioPages('/tables/Sanmar_Bulk_251816_Feb2024/records', {
        'q.where': `STYLE='${safeStyle}'`,
        'q.select': 'STYLE,PRODUCT_TITLE,PRODUCT_DESCRIPTION,COLOR_NAME,CATALOG_COLOR,'
          + 'COLOR_SQUARE_IMAGE,FRONT_MODEL,FRONT_FLAT,SIZE,CASE_PRICE',
        'q.orderBy': 'PK_ID',
        'q.limit': 1000
      }, { strict: true });

      // Tiers / costs / upcharges are style-INDEPENDENT and now come from the
      // shared 15-min table caches, so they cost 0 Caspio calls on a warm process
      // instead of 3 per request. getSizeUpchargeRows already existed — this
      // route was bypassing it with its own copy of the query.
      const [productRows, pricingTiers, dtgCosts, upchargeData] = await Promise.all([
        productPromise,
        getDtgPricingTierRows({ force: forceRefresh }),
        getDtgCostRows({ force: forceRefresh }),
        getSizeUpchargeRows({ force: forceRefresh })
      ]);

      // Rule 4: a DTG price built on a missing pricing table is a silently WRONG
      // price, which is worse than an error. The old code ran Promise.allSettled
      // and substituted [] for any rejected leg, so a Caspio blip produced a
      // well-formed 200 carrying nonsense. Note that "not rejected" is NOT the
      // same as "complete" — caspio.js resolves with PARTIAL results on a
      // mid-pagination failure — so test the data, not the promise state.
      const missing = [];
      if (!Array.isArray(pricingTiers) || pricingTiers.length === 0) missing.push('Pricing_Tiers');
      if (!Array.isArray(dtgCosts) || dtgCosts.length === 0) missing.push('DTG_Costs');
      if (!Array.isArray(upchargeData) || upchargeData.length === 0) missing.push('Standard_Size_Upcharges');
      if (!Array.isArray(productRows) || productRows.length === 0) missing.push('Sanmar_Bulk');
      if (missing.length > 0) {
        console.error(`[DTG BUNDLE] incomplete pricing source for ${styleKey}: ${missing.join(', ')}`);
        return res.status(502).json({
          error: 'pricing_source_unavailable',
          details: `Missing or empty: ${missing.join(', ')}`
        });
      }

      response = buildBundle(productRows, pricingTiers, dtgCosts, upchargeData);

      // Only pin a verified-complete payload (ttl-cache.js caller contract).
      // `sizes` is derived from CASE_PRICE and can legitimately be empty for a
      // style with no priced sizes, so it gates the cache but not the response.
      if (response.product && response.pricing.sizes.length > 0) {
        dtgBundleCache.set(cacheKey, response);
      }
    }

    // Derive the colour view. Preserves the pre-2026-07-28 wire shape exactly:
    // with ?color=, `colors` held only the matching entry and `selectedColor`
    // was set. The Caspio read is no longer colour-filtered, so do it here.
    res.json(withSelectedColor(response, color));

  } catch (error) {
    console.error('Error fetching DTG product bundle:', error.message);
    res.status(500).json({
      error: 'Failed to fetch DTG product bundle',
      details: error.message
    });
  }
});

// Narrow an all-colours bundle to the requested colour, reproducing the shape the
// colour-filtered Caspio query used to return. No colour -> unchanged.
function withSelectedColor(bundle, color) {
  if (!color || !bundle || !bundle.product) return bundle;
  const match = bundle.product.colors.find(c => c.COLOR_NAME === color);
  return {
    ...bundle,
    product: {
      ...bundle.product,
      colors: match ? [match] : [],
      ...(match && { selectedColor: match })
    }
  };
}

function buildBundle(productData, pricingTiers, dtgCosts, upchargeData) {
    const sizeData = productData;

    // Build product section
    const uniqueColors = new Map();
    let productInfo = null;

    productData.forEach(item => {
      if (!productInfo) {
        productInfo = {
          styleNumber: item.STYLE,
          title: item.PRODUCT_TITLE,
          description: item.PRODUCT_DESCRIPTION
        };
      }
      
      const colorKey = item.COLOR_NAME;
      if (!uniqueColors.has(colorKey)) {
        const colorObj = {
          COLOR_NAME: item.COLOR_NAME,
          CATALOG_COLOR: item.CATALOG_COLOR,
          COLOR_SQUARE_IMAGE: item.COLOR_SQUARE_IMAGE,
          MAIN_IMAGE_URL: item.FRONT_MODEL || item.FRONT_FLAT
        };
        uniqueColors.set(colorKey, colorObj);
      }
    });

    // Build pricing section
    const pricing = {
      tiers: pricingTiers.map(tier => ({
        TierLabel: tier.TierLabel,
        MinQuantity: tier.MinQuantity,
        MaxQuantity: tier.MaxQuantity,
        MarginDenominator: tier.MarginDenominator,
        TargetMargin: tier.TargetMargin,
        LTM_Fee: tier.LTM_Fee
      })),
      costs: [],
      sizes: [],
      upcharges: {},
      locations: []
    };

    // Process DTG costs by location and tier
    const locationMap = new Map();
    dtgCosts.forEach(cost => {
      pricing.costs.push({
        PrintLocationCode: cost.PrintLocationCode,
        TierLabel: cost.TierLabel,
        PrintCost: parseFloat(cost.PrintCost) || 0
      });
      
      // Track unique locations
      if (!locationMap.has(cost.PrintLocationCode)) {
        const locationNames = {
          'LC': 'Left Chest',
          'FF': 'Full Front',
          'FB': 'Full Back',
          'POCKET': 'Pocket',
          'SLEEVE': 'Sleeve'
        };
        locationMap.set(cost.PrintLocationCode, {
          code: cost.PrintLocationCode,
          name: locationNames[cost.PrintLocationCode] || cost.PrintLocationCode
        });
      }
    });
    pricing.locations = Array.from(locationMap.values());

    // Process size-based pricing
    const sizePricing = {};
    sizeData.forEach(item => {
      if (item.SIZE && item.CASE_PRICE !== null && !isNaN(parseFloat(item.CASE_PRICE))) {
        const size = String(item.SIZE).trim().toUpperCase();
        const casePrice = parseFloat(item.CASE_PRICE);
        
        if (!sizePricing[size] || casePrice > sizePricing[size]) {
          sizePricing[size] = casePrice;
        }
      }
    });
    
    // Convert to array and sort
    const sizeOrder = ['XS', 'S', 'M', 'L', 'XL', '2XL', '3XL', '4XL', '5XL', '6XL'];
    pricing.sizes = Object.entries(sizePricing)
      .map(([size, maxCasePrice]) => ({ size, maxCasePrice }))
      .sort((a, b) => {
        const indexA = sizeOrder.indexOf(a.size);
        const indexB = sizeOrder.indexOf(b.size);
        if (indexA === -1 && indexB === -1) return a.size.localeCompare(b.size);
        if (indexA === -1) return 1;
        if (indexB === -1) return -1;
        return indexA - indexB;
      });

    // Process upcharges
    upchargeData.forEach(rule => {
      if (rule.SizeDesignation && rule.StandardAddOnAmount !== null && !isNaN(parseFloat(rule.StandardAddOnAmount))) {
        pricing.upcharges[String(rule.SizeDesignation).trim().toUpperCase()] = parseFloat(rule.StandardAddOnAmount);
      }
    });


    // Build response. `selectedColor` is NOT set here — the bundle is cached
    // colour-agnostic and withSelectedColor() adds it per request.
    const response = {
      product: productInfo ? {
        ...productInfo,
        colors: Array.from(uniqueColors.values())
      } : null,
      pricing,
      metadata: {
        cachedAt: new Date().toISOString(),
        // Real TTL, matching dtgBundleCache. This field read 300 for a route that
        // had no cache at all — a decorative number with no readers.
        ttl: 900,
        source: 'dtg-bundle-v1'
      }
    };

    console.log(`DTG product bundle built: ${uniqueColors.size} colors, ${pricingTiers.length} tiers, ${pricing.sizes.length} sizes`);
    return response;
}

// POST /api/dtg/quote-pricing
// Single canonical DTG pricing endpoint. Accepts a shared locationCode +
// a `lines` array (each line = {styleNumber, color, sizes}), fetches each
// unique style's product-bundle once, and delegates the math to
// lib/dtg-canonical-pricing.js so this endpoint produces IDENTICAL prices
// to /pricing/dtg and /order-form.html (which use the equivalent
// shared_components/js/dtg-pricing-service.js algorithm).
//
// Body:
//   {
//     "locationCode": "LC" | "LC_FB" | ...,
//     "lines": [
//       { "styleNumber": "PC61", "color": "Jet Black", "sizes": {"M": 2, "L": 5, "2XL": 1} },
//       ...
//     ]
//   }
// Single-line callers can also pass {locationCode, styleNumber, color, sizes}.
router.post('/quote-pricing', async (req, res) => {
    const body = req.body || {};
    const locationCode = String(body.locationCode || '').toUpperCase();

    if (!ALL_LOCATION_CODES.includes(locationCode)) {
        return res.status(400).json({
            error: 'bad_input',
            message: `locationCode must be one of: ${ALL_LOCATION_CODES.join(', ')}. Got "${body.locationCode}".`,
        });
    }

    // Normalize lines: accept either {lines:[...]} or single-line top-level shape
    let lines;
    if (Array.isArray(body.lines) && body.lines.length > 0) {
        lines = body.lines;
    } else if (body.styleNumber && body.sizes) {
        lines = [{ styleNumber: body.styleNumber, color: body.color, sizes: body.sizes }];
    } else {
        return res.status(400).json({
            error: 'bad_input',
            message: 'Need either {styleNumber, color, sizes} OR a non-empty `lines` array.',
        });
    }

    // Fetch each unique style's bundle in parallel.
    const uniqueStyles = Array.from(new Set(
        lines.map((l) => String((l && l.styleNumber) || '').trim().toUpperCase()).filter(Boolean),
    ));
    if (uniqueStyles.length === 0) {
        return res.status(400).json({ error: 'bad_input', message: 'No valid styleNumbers in lines[]' });
    }

    const bundleResults = await Promise.all(uniqueStyles.map(async (style) => {
        try {
            const r = await fetch(`${INTERNAL_API_BASE}/api/dtg/product-bundle?styleNumber=${encodeURIComponent(style)}`);
            if (!r.ok) {
                return { style, error: `bundle fetch returned ${r.status}` };
            }
            const data = await r.json();
            return { style, data };
        } catch (err) {
            return { style, error: err.message };
        }
    }));

    const bundlesByStyle = {};
    const fetchErrors = [];
    for (const r of bundleResults) {
        if (r.error || !r.data) {
            fetchErrors.push(`${r.style}: ${r.error || 'no data'}`);
        } else {
            bundlesByStyle[r.style] = r.data;
        }
    }
    // Fail on ANY missing bundle, not only when every one is missing. A partial
    // set is a SILENTLY WRONG quote, not a degraded one: priceLines() drops the
    // failing line but still counts its quantity in combinedQty, and the caller
    // (shared_components/js/quote-cart-engine.js) neither reads `warnings` nor
    // index-aligns items to a shortened lineItems array — so a partial answered
    // 200 with an under-stated subtotal AND mis-attributed line items.
    if (fetchErrors.length > 0) {
        return res.status(502).json({
            error: 'pricing_fetch_failed',
            message: `Could not fetch product bundles: ${fetchErrors.join('; ')}`,
        });
    }

    // Delegate math to the canonical module.
    const out = priceLines({ locationCode, lines, bundlesByStyle });
    if (out.error) {
        return res.status(400).json(out);
    }
    res.json(out);
});

module.exports = router;