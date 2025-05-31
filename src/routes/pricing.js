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

  if (!['DTG', 'ScreenPrint', 'Embroidery'].includes(method)) {
    return res.status(400).json({ error: 'Invalid decoration method. Use DTG, ScreenPrint, or Embroidery' });
  }

  try {
    let whereClause;
    if (method === 'Embroidery') {
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
      'q.select': 'XS_CasePrice, S_CasePrice, M_CasePrice, L_CasePrice, XL_CasePrice, XXL_CasePrice, XXXL_CasePrice, XXXXL_CasePrice, XXXXXL_CasePrice, XXXXXXL_CasePrice'
    });

    if (records.length === 0) {
      return res.status(404).json({ error: 'Style not found' });
    }

    const baseCosts = {};
    const record = records[0];
    const sizes = ['XS', 'S', 'M', 'L', 'XL', 'XXL', 'XXXL', 'XXXXL', 'XXXXXL', 'XXXXXXL'];
    
    sizes.forEach(size => {
      const priceField = `${size}_CasePrice`;
      if (record[priceField] !== null && record[priceField] !== undefined) {
        baseCosts[size] = parseFloat(record[priceField]);
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

    const records = await fetchAllCaspioPages('/tables/Sanmar_Bulk_251816_Feb2024/records', {
      'q.where': whereClause,
      'q.select': 'STYLE, COLOR_NAME, XS_CasePrice, S_CasePrice, M_CasePrice, L_CasePrice, XL_CasePrice, XXL_CasePrice, XXXL_CasePrice, XXXXL_CasePrice, XXXXXL_CasePrice, XXXXXXL_CasePrice'
    });

    if (records.length === 0) {
      return res.status(404).json({ error: 'No inventory records found for the specified criteria' });
    }

    const priceData = records.map(record => {
      const prices = {};
      const sizes = ['XS', 'S', 'M', 'L', 'XL', 'XXL', 'XXXL', 'XXXXL', 'XXXXXL', 'XXXXXXL'];
      
      sizes.forEach(size => {
        const priceField = `${size}_CasePrice`;
        if (record[priceField] !== null && record[priceField] !== undefined && record[priceField] !== '') {
          prices[size] = parseFloat(record[priceField]);
        }
      });

      return {
        styleNumber: record.STYLE,
        color: record.COLOR_NAME,
        prices: prices
      };
    });

    console.log(`Size pricing for ${styleNumber}: ${priceData.length} record(s) found`);
    res.json(priceData);
  } catch (error) {
    console.error('Error fetching size pricing:', error.message);
    res.status(500).json({ error: 'Failed to fetch size pricing', details: error.message });
  }
});

// GET /api/max-prices-by-style
router.get('/max-prices-by-style', async (req, res) => {
  const { styles } = req.query;
  console.log(`GET /api/max-prices-by-style requested with styles=${styles}`);

  if (!styles) {
    return res.status(400).json({ error: 'styles parameter is required (comma-separated list)' });
  }

  const styleArray = styles.split(',').map(s => s.trim());

  try {
    const maxPrices = {};
    
    for (const style of styleArray) {
      const whereClause = `STYLE='${style}'`;
      const records = await fetchAllCaspioPages('/tables/Sanmar_Bulk_251816_Feb2024/records', {
        'q.where': whereClause,
        'q.select': 'STYLE, XS_CasePrice, S_CasePrice, M_CasePrice, L_CasePrice, XL_CasePrice, XXL_CasePrice, XXXL_CasePrice, XXXXL_CasePrice, XXXXXL_CasePrice, XXXXXXL_CasePrice'
      });

      if (records.length > 0) {
        let maxPrice = 0;
        const sizes = ['XS', 'S', 'M', 'L', 'XL', 'XXL', 'XXXL', 'XXXXL', 'XXXXXL', 'XXXXXXL'];
        
        records.forEach(record => {
          sizes.forEach(size => {
            const priceField = `${size}_CasePrice`;
            const price = parseFloat(record[priceField]) || 0;
            if (price > maxPrice) {
              maxPrice = price;
            }
          });
        });

        maxPrices[style] = maxPrice;
      } else {
        maxPrices[style] = null;
      }
    }

    console.log(`Max prices found for ${Object.keys(maxPrices).length} styles`);
    res.json(maxPrices);
  } catch (error) {
    console.error('Error fetching max prices:', error.message);
    res.status(500).json({ error: 'Failed to fetch max prices', details: error.message });
  }
});

module.exports = router;