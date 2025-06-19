// Pricing-related routes

const express = require('express');
const router = express.Router();
const { makeCaspioRequest, fetchAllCaspioPages } = require('../utils/caspio');

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

  const validMethods = ['DTG', 'EMB', 'CAP', 'ScreenPrint', 'DTF'];
  if (!validMethods.includes(method)) {
    return res.status(400).json({ error: `Invalid decoration method. Use one of: ${validMethods.join(', ')}` });
  }

  // Map user-friendly method names to database values
  const methodMapping = {
    'EMB': 'EmbroideryShirts',
    'CAP': 'EmbroideryCaps',
    'DTG': 'DTG',
    'ScreenPrint': 'ScreenPrint',
    'DTF': 'DTF'
  };

  // Map methods to location types
  const locationTypeMapping = {
    'DTG': 'DTG',
    'EMB': 'EMB',
    'CAP': 'CAP',
    'ScreenPrint': 'Screen',
    'DTF': 'DTF'
  };

  const dbMethod = methodMapping[method];
  const locationType = locationTypeMapping[method];

  try {
    // Base queries that always run
    const baseQueries = [
      // Fetch pricing tiers
      fetchAllCaspioPages('/tables/Pricing_Tiers/records', {
        'q.where': `DecorationMethod='${dbMethod}'`,
        'q.select': 'PK_ID,TierID,DecorationMethod,TierLabel,MinQuantity,MaxQuantity,MarginDenominator,TargetMargin,LTM_Fee',
        'q.limit': 100
      }),
      
      // Fetch pricing rules
      fetchAllCaspioPages('/tables/Pricing_Rules/records', {
        'q.where': `DecorationMethod='${dbMethod}'`
      }),
      
      // Fetch locations
      fetchAllCaspioPages('/tables/location/records', {
        'q.where': `Type='${locationType}'`,
        'q.select': 'location_code,location_name',
        'q.orderBy': 'PK_ID ASC',
        'q.limit': 100
      })
    ];

    // Add method-specific cost table query
    let costTableQuery;
    switch (method) {
      case 'DTG':
        costTableQuery = fetchAllCaspioPages('/tables/DTG_Costs/records');
        break;
      case 'EMB':
        costTableQuery = fetchAllCaspioPages('/tables/Embroidery_Costs/records', {
          'q.where': "ItemType='Shirt'"
        });
        break;
      case 'CAP':
        costTableQuery = fetchAllCaspioPages('/tables/Embroidery_Costs/records', {
          'q.where': "ItemType='Cap'"
        });
        break;
      case 'ScreenPrint':
        costTableQuery = fetchAllCaspioPages('/tables/Screenprint_Costs/records');
        break;
      case 'DTF':
        costTableQuery = fetchAllCaspioPages('/tables/transfer_pricing_2025/records');
        break;
    }
    baseQueries.push(costTableQuery);

    // If styleNumber is provided, also fetch size-specific data
    if (styleNumber) {
      // Add the size upcharges query
      baseQueries.push(
        fetchAllCaspioPages('/tables/Standard_Size_Upcharges/records', {
          'q.select': 'SizeDesignation,StandardAddOnAmount',
          'q.orderby': 'SizeDesignation ASC',
          'q.limit': 200
        })
      );
      
      // Add the Sanmar query for sizes
      baseQueries.push(
        fetchAllCaspioPages('/tables/Sanmar_Bulk_251816_Feb2024/records', {
          'q.where': `STYLE='${styleNumber}'`,
          'q.select': 'SIZE, MAX(CASE_PRICE) AS MAX_PRICE',
          'q.groupBy': 'SIZE',
          'q.limit': 100
        })
      );
      
      // Add the Size Display Order query
      baseQueries.push(
        fetchAllCaspioPages('/tables/Size_Display_Order/records', {
          'q.select': 'size,sort_order',
          'q.limit': 200
        })
      );
    }

    // Execute all queries in parallel
    const results = await Promise.all(baseQueries);
    
    // Destructure base results
    const [tiers, rules, locationsResult, costs] = results;

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

    // Prepare the base response with method-specific cost field name
    const response = {
      tiersR: tiers,
      rulesR: rulesObject,
      locations: locations
    };

    // Add costs with appropriate field name based on method
    switch (method) {
      case 'DTG':
        response.allDtgCostsR = costs;
        break;
      case 'EMB':
      case 'CAP':
        response.allEmbroideryCostsR = costs;
        break;
      case 'ScreenPrint':
        response.allScreenprintCostsR = costs;
        break;
      case 'DTF':
        response.allDtfCostsR = costs;
        break;
    }

    // If styleNumber was provided, process and add size-specific data
    if (styleNumber && results.length >= 7) {
      const [, , , , upchargeResults, inventoryResult, sizeOrderResults] = results;
      
      // Process selling price display add-ons
      let sellingPriceDisplayAddOns = {};
      upchargeResults.forEach(rule => {
        if (rule.SizeDesignation && rule.StandardAddOnAmount !== null && !isNaN(parseFloat(rule.StandardAddOnAmount))) {
          sellingPriceDisplayAddOns[String(rule.SizeDesignation).trim().toUpperCase()] = parseFloat(rule.StandardAddOnAmount);
        }
      });
      
      // Create size order lookup map
      const sizeOrderMap = {};
      sizeOrderResults.forEach(item => {
        if (item.size && item.sort_order !== null) {
          sizeOrderMap[item.size.toUpperCase()] = item.sort_order;
        }
      });
      
      // Process Sanmar data to get sizes
      const garmentCosts = {};
      
      inventoryResult.forEach(item => {
        if (item.SIZE && item.MAX_PRICE !== null && !isNaN(parseFloat(item.MAX_PRICE))) {
          const sizeKey = String(item.SIZE).trim().toUpperCase();
          const price = parseFloat(item.MAX_PRICE);
          
          // Data is already grouped by SIZE with MAX price
          garmentCosts[sizeKey] = price;
        }
      });
      
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

    res.json(response);
  } catch (error) {
    console.error('Error fetching pricing bundle:', error.message);
    res.status(500).json({ error: 'Failed to fetch pricing bundle', details: error.message });
  }
});

module.exports = router;