// Decorated Cap Prices API
// Returns pre-calculated decorated cap prices for all caps of a specific brand
// Used by frontend to show "As low as: $XX" pricing on product cards

const express = require('express');
const router = express.Router();
const { fetchAllCaspioPages } = require('../utils/caspio');

// Cache (5 min TTL - cap prices don't change frequently)
const decoratedCapPricesCache = new Map();
const CACHE_TTL = 5 * 60 * 1000;

// Supported cap brands (expandable)
const CAP_BRANDS = ['Richardson', 'Outdoor Cap', 'Pacific Headwear'];

// GET /api/decorated-cap-prices
// Query params:
//   - brand (required): Cap brand name, e.g., "Richardson"
//   - tier (optional): Quantity tier, default "72+"
//   - refresh (optional): Set to "true" to bypass cache
router.get('/decorated-cap-prices', async (req, res) => {
  const { brand, tier = '72+' } = req.query;
  console.log(`GET /api/decorated-cap-prices requested with brand=${brand}, tier=${tier}`);

  // Validate brand parameter
  if (!brand) {
    return res.status(400).json({ error: 'brand parameter is required' });
  }

  // Check cache (bypass with ?refresh=true)
  const cacheKey = `${brand}-${tier}`;
  const forceRefresh = req.query.refresh === 'true';
  const cached = decoratedCapPricesCache.get(cacheKey);
  if (!forceRefresh && cached && Date.now() - cached.timestamp < CACHE_TTL) {
    console.log(`[CACHE HIT] decorated-cap-prices ${cacheKey}`);
    return res.json(cached.data);
  }
  console.log(`[CACHE MISS] decorated-cap-prices ${cacheKey}`);

  try {
    // 1. Query all products for the brand (get unique styles with MAX price to be safe)
    const products = await fetchAllCaspioPages('/tables/Sanmar_Bulk_251816_Feb2024/records', {
      'q.where': `BRAND_NAME='${brand}'`,
      'q.select': 'STYLE, MAX(CASE_PRICE) AS MAX_PRICE',
      'q.groupBy': 'STYLE'
    });
    console.log(`Found ${products.length} styles for brand ${brand}`);

    // 2. Query embroidery cost for caps at 8000 stitches (all tiers returned)
    const embCosts = await fetchAllCaspioPages('/tables/Embroidery_Costs/records', {
      'q.where': `ItemType='Cap' AND StitchCount=8000`,
      'q.select': 'TierLabel,EmbroideryCost'
    });
    console.log(`Found ${embCosts.length} embroidery cost tiers for caps at 8000 stitches`);

    // Find the cost for the specified tier (no fallback - must have real data)
    const tierCost = embCosts.find(c => c.TierLabel === tier);
    if (!tierCost || tierCost.EmbroideryCost === undefined) {
      console.error(`No embroidery cost found for tier '${tier}' at 8000 stitches`);
      return res.status(500).json({
        error: `No embroidery cost found for tier '${tier}' at 8000 stitches`
      });
    }
    const embroideryCost = tierCost.EmbroideryCost;
    console.log(`Embroidery cost for tier ${tier}: $${embroideryCost}`);

    // 3. Query margin denominator for EmbroideryCaps at the specified tier
    const marginTiers = await fetchAllCaspioPages('/tables/Pricing_Tiers/records', {
      'q.where': `DecorationMethod='EmbroideryCaps' AND TierLabel='${tier}'`,
      'q.select': 'MarginDenominator'
    });

    // Get margin (fallback to 0.57 if not found for safety)
    const marginDenominator = marginTiers.length > 0 && marginTiers[0].MarginDenominator
      ? marginTiers[0].MarginDenominator
      : 0.57;
    console.log(`Margin denominator for EmbroideryCaps tier ${tier}: ${marginDenominator}`);

    // 4. Calculate decorated price for each style
    // Formula: decoratedPrice = Math.ceil((baseCapPrice / marginDenominator) + embroideryCost)
    const prices = {};
    products.forEach(product => {
      if (product.STYLE && product.MAX_PRICE) {
        const basePrice = parseFloat(product.MAX_PRICE);
        const decoratedPrice = Math.ceil((basePrice / marginDenominator) + embroideryCost);
        prices[product.STYLE] = decoratedPrice;
      }
    });
    console.log(`Calculated prices for ${Object.keys(prices).length} styles`);

    const response = { brand, tier, marginDenominator, prices };

    // Cache result
    decoratedCapPricesCache.set(cacheKey, { data: response, timestamp: Date.now() });

    // FIFO cache eviction if too many entries
    if (decoratedCapPricesCache.size > 50) {
      const firstKey = decoratedCapPricesCache.keys().next().value;
      decoratedCapPricesCache.delete(firstKey);
    }

    res.json(response);
  } catch (error) {
    console.error('Error in /api/decorated-cap-prices:', error);
    res.status(500).json({ error: 'Failed to fetch decorated cap prices', details: error.message });
  }
});

module.exports = router;
