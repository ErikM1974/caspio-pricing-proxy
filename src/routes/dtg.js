// DTG-specific routes including the optimized product-bundle endpoint

const express = require('express');
const router = express.Router();
const { fetchAllCaspioPages } = require('../utils/caspio');
const { priceLines, ALL_LOCATION_CODES } = require('../../lib/dtg-canonical-pricing');

const INTERNAL_API_BASE = process.env.PROXY_PUBLIC_URL
    || 'https://caspio-pricing-proxy-ab30a049961a.herokuapp.com';

// GET /api/dtg/product-bundle
// Optimized endpoint that combines product, pricing, and DTG data in a single request
router.get('/product-bundle', async (req, res) => {
  const { styleNumber, color } = req.query;
  console.log(`GET /api/dtg/product-bundle requested with styleNumber=${styleNumber}, color=${color}`);

  if (!styleNumber) {
    return res.status(400).json({ error: 'styleNumber is required' });
  }

  try {
    // Start all data fetches in parallel for performance
    const fetchPromises = [];
    
    // 1. Fetch product colors and details
    let whereClause = `STYLE='${styleNumber}'`;
    if (color) {
      whereClause += ` AND COLOR_NAME='${color}'`;
    }
    
    fetchPromises.push(
      fetchAllCaspioPages('/tables/Sanmar_Bulk_251816_Feb2024/records', {
        'q.where': whereClause,
        'q.select': 'STYLE,PRODUCT_TITLE,PRODUCT_DESCRIPTION,COLOR_NAME,CATALOG_COLOR,COLOR_SQUARE_IMAGE,FRONT_MODEL,FRONT_FLAT',
        'q.limit': 200
      })
    );

    // 2. Fetch DTG pricing tiers
    fetchPromises.push(
      fetchAllCaspioPages('/tables/Pricing_Tiers/records', {
        'q.where': "DecorationMethod='DTG'",
        'q.select': 'TierLabel,MinQuantity,MaxQuantity,MarginDenominator,TargetMargin,LTM_Fee',
        'q.limit': 100
      })
    );

    // 3. Fetch DTG costs
    fetchPromises.push(
      fetchAllCaspioPages('/tables/DTG_Costs/records', {
        'q.select': 'PrintLocationCode,TierLabel,PrintCost',
        'q.limit': 200
      })
    );

    // 4. Fetch max prices by style (size-based pricing)
    fetchPromises.push(
      fetchAllCaspioPages('/tables/Sanmar_Bulk_251816_Feb2024/records', {
        'q.where': `STYLE='${styleNumber}'`,
        'q.select': 'SIZE,CASE_PRICE',
        'q.limit': 1000
      })
    );

    // 5. Fetch size upcharges
    fetchPromises.push(
      fetchAllCaspioPages('/tables/Standard_Size_Upcharges/records', {
        'q.select': 'SizeDesignation,StandardAddOnAmount',
        'q.orderby': 'SizeDesignation ASC',
        'q.limit': 200
      })
    );


    // Execute all fetches in parallel
    const results = await Promise.allSettled(fetchPromises);
    
    // Process results
    const productData = results[0].status === 'fulfilled' ? results[0].value : [];
    const pricingTiers = results[1].status === 'fulfilled' ? results[1].value : [];
    const dtgCosts = results[2].status === 'fulfilled' ? results[2].value : [];
    const sizeData = results[3].status === 'fulfilled' ? results[3].value : [];
    const upchargeData = results[4].status === 'fulfilled' ? results[4].value : [];

    // Build product section
    const uniqueColors = new Map();
    let productInfo = null;
    let selectedColorData = null;
    
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
        
        if (color && item.COLOR_NAME === color) {
          selectedColorData = colorObj;
        }
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


    // Build response
    const response = {
      product: productInfo ? {
        ...productInfo,
        colors: Array.from(uniqueColors.values()),
        ...(selectedColorData && { selectedColor: selectedColorData })
      } : null,
      pricing,
      metadata: {
        cachedAt: new Date().toISOString(),
        ttl: 300, // 5 minutes
        source: 'dtg-bundle-v1'
      }
    };

    console.log(`DTG product bundle for ${styleNumber}: ${uniqueColors.size} colors, ${pricingTiers.length} tiers, ${pricing.sizes.length} sizes`);
    res.json(response);

  } catch (error) {
    console.error('Error fetching DTG product bundle:', error.message);
    res.status(500).json({
      error: 'Failed to fetch DTG product bundle',
      details: error.message
    });
  }
});

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
    if (Object.keys(bundlesByStyle).length === 0) {
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
    if (fetchErrors.length) {
        out.warnings = (out.warnings || []).concat(fetchErrors);
    }
    res.json(out);
});

module.exports = router;