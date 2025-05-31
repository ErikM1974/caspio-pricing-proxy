// Transfer pricing routes

const express = require('express');
const router = express.Router();
const { makeCaspioRequest, fetchAllCaspioPages } = require('../utils/caspio');

// GET /api/transfers/lookup - Core pricing endpoint
router.get('/transfers/lookup', async (req, res) => {
  const { size, quantity, price_type } = req.query;
  console.log(`GET /api/transfers/lookup requested with size=${size}, quantity=${quantity}, price_type=${price_type}`);

  if (!size || !quantity || !price_type) {
    return res.status(400).json({ 
      error: 'size, quantity, and price_type are required' 
    });
  }

  try {
    const quantityNum = parseInt(quantity);
    let whereClause = `size='${size}' AND price_type='${price_type}' AND min_quantity<=${quantityNum} AND max_quantity>=${quantityNum} AND active='TRUE'`;

    const records = await fetchAllCaspioPages('/tables/transfer_pricing_2025/records', {
      'q.where': whereClause,
      'q.limit': 1
    });

    if (records.length === 0) {
      return res.status(404).json({ 
        error: 'No pricing found for the specified criteria' 
      });
    }

    console.log(`Transfer pricing lookup successful: ${records[0].unit_price} ${records[0].currency}`);
    res.json({ 
      unit_price: records[0].unit_price,
      currency: records[0].currency,
      quantity_range: records[0].quantity_range,
      pricing_record: records[0]
    });
  } catch (error) {
    console.error('Error looking up transfer pricing:', error.message);
    res.status(500).json({ error: 'Failed to lookup transfer pricing', details: error.message });
  }
});

// GET /api/transfers/matrix - All quantity tiers for a size
router.get('/transfers/matrix', async (req, res) => {
  const { size, price_type } = req.query;
  console.log(`GET /api/transfers/matrix requested with size=${size}, price_type=${price_type}`);

  if (!size) {
    return res.status(400).json({ error: 'size is required' });
  }

  try {
    let whereConditions = [`size='${size}'`, `active='TRUE'`];
    
    if (price_type) {
      whereConditions.push(`price_type='${price_type}'`);
    }

    const records = await fetchAllCaspioPages('/tables/transfer_pricing_2025/records', {
      'q.where': whereConditions.join(' AND '),
      'q.orderby': 'min_quantity'
    });

    console.log(`Transfer pricing matrix: ${records.length} record(s) found for size ${size}`);
    res.json(records);
  } catch (error) {
    console.error('Error fetching transfer pricing matrix:', error.message);
    res.status(500).json({ error: 'Failed to fetch transfer pricing matrix', details: error.message });
  }
});

// GET /api/transfers/sizes - Available transfer sizes
router.get('/transfers/sizes', async (req, res) => {
  console.log('GET /api/transfers/sizes requested');

  try {
    const records = await fetchAllCaspioPages('/tables/transfer_pricing_2025/records', {
      'q.select': 'size',
      'q.where': `active='TRUE'`
    });

    const uniqueSizes = [...new Set(records.map(record => record.size))].sort();
    console.log(`Available transfer sizes: ${uniqueSizes.length} unique sizes found`);
    res.json(uniqueSizes);
  } catch (error) {
    console.error('Error fetching transfer sizes:', error.message);
    res.status(500).json({ error: 'Failed to fetch transfer sizes', details: error.message });
  }
});

// GET /api/transfers/price-types - Available price types
router.get('/transfers/price-types', async (req, res) => {
  console.log('GET /api/transfers/price-types requested');

  try {
    const records = await fetchAllCaspioPages('/tables/transfer_pricing_2025/records', {
      'q.select': 'price_type',
      'q.where': `active='TRUE'`
    });

    const uniquePriceTypes = [...new Set(records.map(record => record.price_type))].sort();
    console.log(`Available price types: ${uniquePriceTypes.length} unique types found`);
    res.json(uniquePriceTypes);
  } catch (error) {
    console.error('Error fetching price types:', error.message);
    res.status(500).json({ error: 'Failed to fetch price types', details: error.message });
  }
});

// GET /api/transfers/quantity-ranges - Available quantity ranges
router.get('/transfers/quantity-ranges', async (req, res) => {
  console.log('GET /api/transfers/quantity-ranges requested');

  try {
    const records = await fetchAllCaspioPages('/tables/transfer_pricing_2025/records', {
      'q.select': 'quantity_range,min_quantity,max_quantity',
      'q.where': `active='TRUE'`
    });

    const uniqueRanges = [...new Set(records.map(record => record.quantity_range))]
      .map(range => {
        const matchingRecord = records.find(r => r.quantity_range === range);
        return {
          range: range,
          min_quantity: matchingRecord.min_quantity,
          max_quantity: matchingRecord.max_quantity
        };
      })
      .sort((a, b) => a.min_quantity - b.min_quantity);

    console.log(`Available quantity ranges: ${uniqueRanges.length} unique ranges found`);
    res.json(uniqueRanges);
  } catch (error) {
    console.error('Error fetching quantity ranges:', error.message);
    res.status(500).json({ error: 'Failed to fetch quantity ranges', details: error.message });
  }
});

// GET /api/transfers - General query endpoint
router.get('/transfers', async (req, res) => {
  console.log('GET /api/transfers requested with query:', req.query);

  try {
    let whereConditions = [];
    
    if (req.query.id) {
      whereConditions.push(`PK_ID=${req.query.id}`);
    }
    if (req.query.product_type) {
      whereConditions.push(`product_type='${req.query.product_type}'`);
    }
    if (req.query.size) {
      whereConditions.push(`size='${req.query.size}'`);
    }
    if (req.query.price_type) {
      whereConditions.push(`price_type='${req.query.price_type}'`);
    }
    if (req.query.quantity_range) {
      whereConditions.push(`quantity_range='${req.query.quantity_range}'`);
    }
    if (req.query.min_quantity) {
      whereConditions.push(`min_quantity>=${req.query.min_quantity}`);
    }
    if (req.query.max_quantity) {
      whereConditions.push(`max_quantity<=${req.query.max_quantity}`);
    }
    if (req.query.active !== undefined) {
      whereConditions.push(`active='${req.query.active.toUpperCase()}'`);
    }
    if (req.query.currency) {
      whereConditions.push(`currency='${req.query.currency}'`);
    }

    const params = {};
    if (whereConditions.length > 0) {
      params['q.where'] = whereConditions.join(' AND ');
    }

    if (req.query.orderby) {
      params['q.orderby'] = req.query.orderby;
    }

    const records = await fetchAllCaspioPages('/tables/transfer_pricing_2025/records', params);
    console.log(`Transfer pricing: ${records.length} record(s) found`);
    res.json(records);
  } catch (error) {
    console.error('Error fetching transfer pricing:', error.message);
    res.status(500).json({ error: 'Failed to fetch transfer pricing', details: error.message });
  }
});

module.exports = router;