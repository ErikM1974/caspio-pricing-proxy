// Pricing-related routes

const express = require('express');
const router = express.Router();
const { makeCaspioRequest, fetchAllCaspioPages } = require('../utils/caspio');

// Cache for pricing bundle (15 minute TTL) - HIGH IMPACT
const pricingBundleCache = new Map();
const PRICING_BUNDLE_CACHE_TTL = 15 * 60 * 1000; // 15 minutes

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

  try {
    const whereClause = `ItemType='${itemType}' AND StitchCountRange='${stitchCount}'`;
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
      { 'q.where': `PK_ID=${id}` });
    console.log('Embroidery cost record deleted:', result);
    res.json({ message: 'Embroidery cost record deleted successfully', recordsAffected: result.RecordsAffected || 0 });
  } catch (error) {
    console.error('Error deleting embroidery cost record:', error.message);
    res.status(500).json({ error: 'Failed to delete embroidery cost record', details: error.message });
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

    // Process Caspio records into structured pricing object
    const pricing = {
      garments: { basePrices: {}, perThousandUpcharge: 1.25, ltmFee: 50.00, ltmThreshold: 7 },
      caps: { basePrices: {}, perThousandUpcharge: 1.00, ltmFee: 50.00, ltmThreshold: 7 },
      fullBack: { ratesPerThousand: {}, minStitches: 25000, minQuantity: 8 },
      heavyweightSurcharge: 10.00,
      source: 'caspio'
    };

    records.forEach(record => {
      const itemType = record.ItemType;
      const tier = record.TierLabel;
      const cost = parseFloat(record.EmbroideryCost) || 0;
      const ltmFee = parseFloat(record.LTM_Fee) || 0;

      if (itemType === 'DECG-Garmt') {
        pricing.garments.basePrices[tier] = cost;
        if (ltmFee > 0) pricing.garments.ltmFee = ltmFee;
      } else if (itemType === 'DECG-Cap') {
        pricing.caps.basePrices[tier] = cost;
        if (ltmFee > 0) pricing.caps.ltmFee = ltmFee;
      } else if (itemType === 'DECG-FB') {
        pricing.fullBack.ratesPerThousand[tier] = cost;
        if (ltmFee > 0) pricing.fullBack.ltmFee = ltmFee;
      }
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
      fullBack: {
        ratePerThousand: 1.25,
        minStitches: 25000
      },
      fees: {
        ltm: { threshold: 7, amount: 50.00 },
        extraColors: { threshold: 5, perColorPerPiece: 1.00 }
      },
      source: 'caspio'
    };

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
      } else if (itemType === 'FB') {
        pricing.fullBack.ratePerThousand = cost;
        if (baseStitches > 0) pricing.fullBack.minStitches = baseStitches;
      }
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
    const whereClause = `STYLE='${styleNumber}'`;
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
    res.json({
      styleNumber: styleNumber,
      baseCosts: baseCosts
    });
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
    let whereClause = `STYLE='${styleNumber}'`;
    if (color) {
      whereClause += ` AND COLOR_NAME='${color}'`;
    }

    // Fetch pricing data and size upcharges in parallel
    const [records, sizeUpcharges] = await Promise.all([
      fetchAllCaspioPages('/tables/Sanmar_Bulk_251816_Feb2024/records', {
        'q.where': whereClause,
        'q.select': 'STYLE, COLOR_NAME, SIZE, CASE_PRICE'
      }),
      fetchAllCaspioPages('/tables/Standard_Size_Upcharges/records', {
        'q.select': 'SizeDesignation, StandardAddOnAmount'
      })
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

    // 1. Fetch Selling Price Display Add-Ons from Standard_Size_Upcharges
    let sellingPriceDisplayAddOns = {};
    try {
      const upchargeResults = await fetchAllCaspioPages('/tables/Standard_Size_Upcharges/records', {
        'q.select': 'SizeDesignation,StandardAddOnAmount',
        'q.orderby': 'SizeDesignation ASC',
        'q.limit': 200
      });
      
      upchargeResults.forEach(rule => {
        if (rule.SizeDesignation && rule.StandardAddOnAmount !== null && !isNaN(parseFloat(rule.StandardAddOnAmount))) {
          sellingPriceDisplayAddOns[String(rule.SizeDesignation).trim().toUpperCase()] = parseFloat(rule.StandardAddOnAmount);
        }
      });
      
      console.log("Fetched Selling Price Display Add-Ons for /max-prices-by-style:", sellingPriceDisplayAddOns);
    } catch (upchargeError) {
      console.error("Error fetching Selling Price Display Add-Ons for /max-prices-by-style:", upchargeError.message);
      sellingPriceDisplayAddOns = {};
    }

    // 2. Fetch Inventory Data from Sanmar table (using STYLE field to match catalog_no)
    const inventoryWhereClause = `STYLE='${styleNumber}'`;
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
    
    res.json({
      style: styleNumber,
      sizes: sizes,
      sellingPriceDisplayAddOns: sellingPriceDisplayAddOns
    });
    
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

  const validMethods = ['DTG', 'EMB', 'CAP', 'ScreenPrint', 'DTF', 'EMB-AL', 'CAP-AL', 'BLANK', 'PATCH', 'CAP-PUFF'];
  if (!validMethods.includes(method)) {
    return res.status(400).json({ error: `Invalid decoration method. Use one of: ${validMethods.join(', ')}` });
  }

  // Map user-friendly method names to database values
  const methodMapping = {
    'EMB': 'EmbroideryShirts',
    'CAP': 'EmbroideryCaps',
    'DTG': 'DTG',
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

  const dbMethod = methodMapping[method];
  const locationType = locationTypeMapping[method];

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
      fetchAllCaspioPages('/tables/Pricing_Tiers/records', {
        'q.where': `DecorationMethod='${dbMethod}'`,
        'q.select': 'PK_ID,TierID,DecorationMethod,TierLabel,MinQuantity,MaxQuantity,MarginDenominator,TargetMargin,LTM_Fee',
        'q.limit': 100
      }).catch(err => {
        console.error('Failed to fetch pricing tiers:', err.message);
        return [];
      }),
      
      // Fetch pricing rules
      fetchAllCaspioPages('/tables/Pricing_Rules/records', {
        'q.where': `DecorationMethod='${dbMethod}'`
      }).catch(err => {
        console.error('Failed to fetch pricing rules:', err.message);
        return [];
      }),

      // Fetch locations (skip if locationType is null - e.g., BLANK products)
      locationType ?
        fetchAllCaspioPages('/tables/location/records', {
          'q.where': `Type='${locationType}'`,
          'q.select': 'location_code,location_name',
          'q.orderBy': 'PK_ID ASC',
          'q.limit': 100
        }).catch(err => {
          console.error('Failed to fetch locations:', err.message);
          return [];
        }) :
        Promise.resolve([])
    ];

    // Add method-specific cost table query with error handling
    let costTableQuery;
    switch (method) {
      case 'DTG':
        costTableQuery = fetchAllCaspioPages('/tables/DTG_Costs/records')
          .catch(err => {
            console.error('Failed to fetch DTG costs:', err.message);
            return [];
          });
        break;
      case 'EMB':
        costTableQuery = fetchAllCaspioPages('/tables/Embroidery_Costs/records', {
          'q.where': "ItemType='Shirt'"
        }).catch(err => {
          console.error('Failed to fetch embroidery costs:', err.message);
          return [];
        });
        break;
      case 'CAP':
        costTableQuery = fetchAllCaspioPages('/tables/Embroidery_Costs/records', {
          'q.where': "ItemType='Cap'"
        }).catch(err => {
          console.error('Failed to fetch cap embroidery costs:', err.message);
          return [];
        });
        break;
      case 'EMB-AL':
        costTableQuery = fetchAllCaspioPages('/tables/Embroidery_Costs/records', {
          'q.where': "ItemType='AL'"
        }).catch(err => {
          console.error('Failed to fetch additional logo embroidery costs:', err.message);
          return [];
        });
        break;
      case 'CAP-AL':
        costTableQuery = fetchAllCaspioPages('/tables/Embroidery_Costs/records', {
          'q.where': "ItemType='AL-CAP'"
        }).catch(err => {
          console.error('Failed to fetch additional logo cap costs:', err.message);
          return [];
        });
        break;
      case 'ScreenPrint':
        costTableQuery = fetchAllCaspioPages('/tables/Screenprint_Costs/records')
          .catch(err => {
            console.error('Failed to fetch screenprint costs:', err.message);
            return [];
          });
        break;
      case 'DTF':
        costTableQuery = fetchAllCaspioPages('/tables/DTF_Pricing/records')
          .catch(err => {
            console.error('Failed to fetch DTF costs:', err.message);
            return [];
          });
        break;
      case 'BLANK':
        // Blank products have no decoration costs
        costTableQuery = Promise.resolve([]);
        break;
      case 'PATCH':
        // Laser leatherette patches - fetch from Embroidery_Costs with ItemType='Patch'
        costTableQuery = fetchAllCaspioPages('/tables/Embroidery_Costs/records', {
          'q.where': "ItemType='Patch'"
        }).catch(err => {
          console.error('Failed to fetch patch costs:', err.message);
          return [];
        });
        break;
      case 'CAP-PUFF':
        // 3D Puff embroidery - fetch both regular cap costs and puff upcharge config
        costTableQuery = fetchAllCaspioPages('/tables/Embroidery_Costs/records', {
          'q.where': "ItemType='Cap' OR ItemType='3D-Puff'"
        }).catch(err => {
          console.error('Failed to fetch 3D puff costs:', err.message);
          return [];
        });
        break;
    }
    baseQueries.push(costTableQuery);

    // For DTF, also fetch Transfer_Freight table
    if (method === 'DTF') {
      baseQueries.push(
        fetchAllCaspioPages('/tables/Transfer_Freight/records')
          .catch(err => {
            console.error('Failed to fetch DTF freight costs:', err.message);
            return [];
          })
      );
    }

    // If styleNumber is provided, also fetch size-specific data
    if (styleNumber) {
      // Add the size upcharges query with error handling
      baseQueries.push(
        fetchAllCaspioPages('/tables/Standard_Size_Upcharges/records', {
          'q.select': 'SizeDesignation,StandardAddOnAmount',
          'q.orderby': 'SizeDesignation ASC',
          'q.limit': 200
        }).catch(err => {
          console.error('Failed to fetch size upcharges:', err.message);
          return [];
        })
      );
      
      // Add the Sanmar query for sizes with error handling
      baseQueries.push(
        fetchAllCaspioPages('/tables/Sanmar_Bulk_251816_Feb2024/records', {
          'q.where': `STYLE='${styleNumber}'`,
          'q.select': 'SIZE, MAX(CASE_PRICE) AS MAX_PRICE',
          'q.groupBy': 'SIZE',
          'q.limit': 100
        }).catch(err => {
          console.error(`Failed to fetch inventory for style ${styleNumber}:`, err.message);
          return [];
        })
      );
      
      // Add the Size Display Order query with error handling
      baseQueries.push(
        fetchAllCaspioPages('/tables/Size_Display_Order/records', {
          'q.select': 'size,sort_order',
          'q.limit': 200
        }).catch(err => {
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
    switch (method) {
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

    // Special handling for CAP and CAP-AL methods: Add missing 1-23 tier
    if ((method === 'CAP' || method === 'CAP-AL') && response.tiersR.length > 0) {
      // Check if 1-23 tier is missing
      const has1to23Tier = response.tiersR.some(tier => tier.TierLabel === '1-23');
      if (!has1to23Tier) {
        // Add the missing 1-23 tier at the beginning
        response.tiersR.unshift({
          PK_ID: 9,  // Use a consistent ID that matches the pattern
          TierID: 9,
          DecorationMethod: 'EmbroideryCaps',
          TierLabel: '1-23',
          MinQuantity: 1,
          MaxQuantity: 23,
          MarginDenominator: 0.57,
          TargetMargin: 0,
          LTM_Fee: 50
        });
      }
    }

    response.rulesR = rulesObject || {};
    response.locations = locations || [];

    // Update costs with actual data
    switch (method) {
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

    // If styleNumber was provided, process and add size-specific data
    if (styleNumber && results.length >= 7) {
        const [, , , , upchargeResults, inventoryResult, sizeOrderResults] = results;
        
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
      switch (method) {
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
    
    // Even on error, return the expected structure
    const errorResponse = {
      tiersR: [],
      rulesR: {},
      locations: []
    };
    
    // Add method-specific cost field
    switch (method) {
      case 'DTG':
        errorResponse.allDtgCostsR = [];
        break;
      case 'EMB':
      case 'CAP':
      case 'EMB-AL':
      case 'CAP-AL':
      case 'CAP-PUFF':
        errorResponse.allEmbroideryCostsR = [];
        break;
      case 'PATCH':
        errorResponse.allPatchCostsR = [];
        break;
      case 'ScreenPrint':
        errorResponse.allScreenprintCostsR = [];
        break;
      case 'DTF':
        errorResponse.allDtfCostsR = [];
        errorResponse.freightR = [];
        break;
      case 'BLANK':
        // Blank products don't need cost fields
        break;
    }

    if (styleNumber) {
      errorResponse.sizes = [];
      errorResponse.sellingPriceDisplayAddOns = {};
    }

    res.json(errorResponse);
  }
});

module.exports = router;