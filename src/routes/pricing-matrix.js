// Pricing matrix routes

const express = require('express');
const router = express.Router();
const { makeCaspioRequest, fetchAllCaspioPages } = require('../utils/caspio');

// GET /api/pricing-matrix
router.get('/pricing-matrix', async (req, res) => {
  console.log('GET /api/pricing-matrix requested with query:', req.query);

  try {
    let whereConditions = [];
    
    if (req.query.pricingMatrixID) {
      whereConditions.push(`PricingMatrixID=${req.query.pricingMatrixID}`);
    }
    if (req.query.sessionID) {
      whereConditions.push(`SessionID='${req.query.sessionID}'`);
    }
    if (req.query.styleNumber) {
      whereConditions.push(`STYLE='${req.query.styleNumber}'`);
    }
    if (req.query.color) {
      whereConditions.push(`COLOR_NAME='${req.query.color}'`);
    }
    if (req.query.embellishmentType) {
      whereConditions.push(`EmbellishmentType='${req.query.embellishmentType}'`);
    }

    const params = {};
    if (whereConditions.length > 0) {
      params['q.where'] = whereConditions.join(' AND ');
    }

    const records = await fetchAllCaspioPages('/tables/PricingMatrix/records', params);
    console.log(`Pricing matrix: ${records.length} record(s) found`);
    res.json(records);
  } catch (error) {
    console.error('Error fetching pricing matrix:', error.message);
    res.status(500).json({ error: 'Failed to fetch pricing matrix', details: error.message });
  }
});

// GET /api/pricing-matrix/lookup
router.get('/pricing-matrix/lookup', async (req, res) => {
  const { styleNumber, color, embellishmentType, sessionID } = req.query;
  console.log(`GET /api/pricing-matrix/lookup requested with styleNumber=${styleNumber}, color=${color}, embellishmentType=${embellishmentType}, sessionID=${sessionID}`);

  if (!styleNumber || !color || !embellishmentType) {
    return res.status(400).json({ 
      error: 'styleNumber, color, and embellishmentType are required' 
    });
  }

  try {
    let whereClause = `StyleNumber='${styleNumber}' AND Color='${color}' AND EmbellishmentType='${embellishmentType}'`;
    if (sessionID) {
      whereClause += ` AND SessionID='${sessionID}'`;
    }

    const records = await fetchAllCaspioPages('/tables/PricingMatrix/records', {
      'q.where': whereClause,
      'q.select': 'PricingMatrixID',
      'q.limit': 1
    });

    if (records.length === 0) {
      return res.status(404).json({ 
        error: 'No pricing matrix found for the specified criteria' 
      });
    }

    console.log(`Pricing matrix lookup successful: ID ${records[0].PricingMatrixID}`);
    res.json({ pricingMatrixId: records[0].PricingMatrixID });
  } catch (error) {
    console.error('Error looking up pricing matrix:', error.message);
    res.status(500).json({ error: 'Failed to lookup pricing matrix', details: error.message });
  }
});

// GET /api/pricing-matrix/:id
router.get('/pricing-matrix/:id', async (req, res) => {
  const { id } = req.params;
  console.log(`GET /api/pricing-matrix/${id} requested`);

  try {
    const records = await fetchAllCaspioPages('/tables/PricingMatrix/records', {
      'q.where': `PricingMatrixID=${id}`
    });

    if (records.length === 0) {
      return res.status(404).json({ error: 'Pricing matrix not found' });
    }

    console.log(`Pricing matrix ${id} retrieved successfully`);
    res.json(records[0]);
  } catch (error) {
    console.error('Error fetching pricing matrix by ID:', error.message);
    res.status(500).json({ error: 'Failed to fetch pricing matrix', details: error.message });
  }
});

// POST /api/pricing-matrix
router.post('/pricing-matrix', express.json(), async (req, res) => {
  console.log('POST /api/pricing-matrix requested with body:', req.body);

  try {
    const { SessionID, StyleNumber, Color, EmbellishmentType } = req.body;

    if (!SessionID || !StyleNumber || !Color || !EmbellishmentType) {
      return res.status(400).json({ 
        error: 'SessionID, StyleNumber, Color, and EmbellishmentType are required' 
      });
    }

    const pricingData = {
      SessionID,
      STYLE: StyleNumber,
      COLOR_NAME: Color,
      EmbellishmentType,
      TierStructure: req.body.TierStructure || null,
      SizeGroups: req.body.SizeGroups || null,
      PriceMatrix: req.body.PriceMatrix || null
    };

    const result = await makeCaspioRequest('post', '/tables/PricingMatrix/records', {}, pricingData);
    console.log('Pricing matrix created successfully');
    res.status(201).json({ message: 'Pricing matrix created successfully', pricingMatrix: result });
  } catch (error) {
    console.error('Error creating pricing matrix:', error.message);
    res.status(500).json({ error: 'Failed to create pricing matrix', details: error.message });
  }
});

// PUT /api/pricing-matrix/:id
router.put('/pricing-matrix/:id', express.json(), async (req, res) => {
  const { id } = req.params;
  console.log(`PUT /api/pricing-matrix/${id} requested with body:`, req.body);

  try {
    const updates = {};
    const allowedFields = [
      'SessionID', 'STYLE', 'COLOR_NAME', 'EmbellishmentType',
      'TierStructure', 'SizeGroups', 'PriceMatrix'
    ];
    
    for (const field of allowedFields) {
      if (req.body[field] !== undefined) {
        updates[field] = req.body[field];
      }
    }

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ error: 'No valid fields to update' });
    }

    const result = await makeCaspioRequest('put', '/tables/PricingMatrix/records', 
      { 'q.where': `PricingMatrixID=${id}` }, 
      updates
    );
    
    console.log('Pricing matrix updated successfully');
    res.json({ message: 'Pricing matrix updated successfully', pricingMatrix: result });
  } catch (error) {
    console.error('Error updating pricing matrix:', error.message);
    res.status(500).json({ error: 'Failed to update pricing matrix', details: error.message });
  }
});

// DELETE /api/pricing-matrix/:id
router.delete('/pricing-matrix/:id', async (req, res) => {
  const { id } = req.params;
  console.log(`DELETE /api/pricing-matrix/${id} requested`);

  try {
    const result = await makeCaspioRequest('delete', '/tables/PricingMatrix/records', 
      { 'q.where': `PricingMatrixID=${id}` }
    );
    
    console.log('Pricing matrix deleted successfully');
    res.json({ message: 'Pricing matrix deleted successfully', recordsAffected: result.RecordsAffected || 0 });
  } catch (error) {
    console.error('Error deleting pricing matrix:', error.message);
    res.status(500).json({ error: 'Failed to delete pricing matrix', details: error.message });
  }
});

module.exports = router;