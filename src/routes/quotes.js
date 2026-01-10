// Quote-related routes

const express = require('express');
const router = express.Router();
const { makeCaspioRequest, fetchAllCaspioPages } = require('../utils/caspio');

// Input validation helpers
function sanitizeQuoteID(quoteID) {
  if (!quoteID || typeof quoteID !== 'string') return null;
  const sanitized = quoteID.replace(/[^a-zA-Z0-9_-]/g, '');
  return (sanitized.length > 0 && sanitized.length <= 50) ? sanitized : null;
}

function sanitizeSessionID(sessionID) {
  if (!sessionID || typeof sessionID !== 'string') return null;
  const sanitized = sessionID.replace(/[^a-zA-Z0-9_-]/g, '');
  return (sanitized.length > 0 && sanitized.length <= 100) ? sanitized : null;
}

function sanitizeEmail(email) {
  if (!email || typeof email !== 'string') return null;
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return emailRegex.test(email) ? email : null;
}

function sanitizeStatus(status) {
  const validStatuses = ['active', 'pending', 'completed', 'abandoned', 'expired'];
  return validStatuses.includes(status?.toLowerCase()) ? status : null;
}

// Cache for quote sessions (5 minute TTL)
const quoteSessionsCache = new Map();
const QUOTE_SESSIONS_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

// Quote Analytics Routes
// GET /api/quote_analytics
router.get('/quote_analytics', async (req, res) => {
  console.log('GET /api/quote_analytics requested with query:', req.query);

  try {
    let whereConditions = [];
    
    if (req.query.sessionID) {
      whereConditions.push(`SessionID='${req.query.sessionID}'`);
    }
    if (req.query.quoteID) {
      whereConditions.push(`QuoteID='${req.query.quoteID}'`);
    }
    if (req.query.eventType) {
      whereConditions.push(`EventType='${req.query.eventType}'`);
    }

    const params = {};
    if (whereConditions.length > 0) {
      params['q.where'] = whereConditions.join(' AND ');
    }

    const records = await fetchAllCaspioPages('/tables/Quote_Analytics/records', params);
    console.log(`Quote analytics: ${records.length} record(s) found`);
    res.json(records);
  } catch (error) {
    console.error('Error fetching quote analytics:', error.message);
    res.status(500).json({ error: 'Failed to fetch quote analytics', details: error.message });
  }
});

// GET /api/quote_analytics/:id
router.get('/quote_analytics/:id', async (req, res) => {
  const { id } = req.params;
  console.log(`GET /api/quote_analytics/${id} requested`);

  try {
    const records = await fetchAllCaspioPages('/tables/Quote_Analytics/records', {
      'q.where': `PK_ID=${id}`
    });

    if (records.length === 0) {
      return res.status(404).json({ error: 'Quote analytics record not found' });
    }

    console.log(`Quote analytics ${id} retrieved successfully`);
    res.json(records[0]);
  } catch (error) {
    console.error('Error fetching quote analytics by ID:', error.message);
    res.status(500).json({ error: 'Failed to fetch quote analytics', details: error.message });
  }
});

// POST /api/quote_analytics
router.post('/quote_analytics', express.json(), async (req, res) => {
  console.log('POST /api/quote_analytics requested with body:', req.body);

  try {
    const { SessionID, EventType } = req.body;

    if (!SessionID || !EventType) {
      return res.status(400).json({ 
        error: 'SessionID and EventType are required' 
      });
    }

    // Just pass the data directly - Caspio handles AnalyticsID
    const analyticsData = { ...req.body };

    const result = await makeCaspioRequest('post', '/tables/Quote_Analytics/records', {}, analyticsData);
    console.log('Quote analytics created successfully');
    res.status(201).json(result);
  } catch (error) {
    console.error('Error creating quote analytics:', error.message);
    res.status(500).json({ error: 'Failed to create quote analytics', details: error.message });
  }
});

// PUT /api/quote_analytics/:id
router.put('/quote_analytics/:id', express.json(), async (req, res) => {
  const { id } = req.params;
  console.log(`PUT /api/quote_analytics/${id} requested with body:`, req.body);

  try {
    const updates = { ...req.body };
    delete updates.PK_ID;
    delete updates.AnalyticsID;

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ error: 'No valid fields to update' });
    }

    const result = await makeCaspioRequest('put', '/tables/Quote_Analytics/records', 
      { 'q.where': `PK_ID=${id}` }, 
      updates
    );
    
    console.log('Quote analytics updated successfully');
    res.json(result);
  } catch (error) {
    console.error('Error updating quote analytics:', error.message);
    res.status(500).json({ error: 'Failed to update quote analytics', details: error.message });
  }
});

// DELETE /api/quote_analytics/:id
router.delete('/quote_analytics/:id', async (req, res) => {
  const { id } = req.params;
  console.log(`DELETE /api/quote_analytics/${id} requested`);

  try {
    const result = await makeCaspioRequest('delete', '/tables/Quote_Analytics/records', 
      { 'q.where': `PK_ID=${id}` }
    );
    
    console.log('Quote analytics deleted successfully');
    res.json({ message: 'Quote analytics deleted successfully', recordsAffected: result.RecordsAffected || 0 });
  } catch (error) {
    console.error('Error deleting quote analytics:', error.message);
    res.status(500).json({ error: 'Failed to delete quote analytics', details: error.message });
  }
});

// Quote Items Routes
// GET /api/quote_items
router.get('/quote_items', async (req, res) => {
  console.log('GET /api/quote_items requested with query:', req.query);

  try {
    let whereConditions = [];
    
    if (req.query.quoteID) {
      whereConditions.push(`QuoteID='${req.query.quoteID}'`);
    }
    if (req.query.styleNumber) {
      whereConditions.push(`StyleNumber='${req.query.styleNumber}'`);
    }

    const params = {};
    if (whereConditions.length > 0) {
      params['q.where'] = whereConditions.join(' AND ');
    }

    const records = await fetchAllCaspioPages('/tables/Quote_Items/records', params);
    console.log(`Quote items: ${records.length} record(s) found`);
    res.json(records);
  } catch (error) {
    console.error('Error fetching quote items:', error.message);
    res.status(500).json({ error: 'Failed to fetch quote items', details: error.message });
  }
});

// GET /api/quote_items/:id
router.get('/quote_items/:id', async (req, res) => {
  const { id } = req.params;
  console.log(`GET /api/quote_items/${id} requested`);

  try {
    const records = await fetchAllCaspioPages('/tables/Quote_Items/records', {
      'q.where': `PK_ID=${id}`
    });

    if (records.length === 0) {
      return res.status(404).json({ error: 'Quote item not found' });
    }

    console.log(`Quote item ${id} retrieved successfully`);
    res.json(records[0]);
  } catch (error) {
    console.error('Error fetching quote item by ID:', error.message);
    res.status(500).json({ error: 'Failed to fetch quote item', details: error.message });
  }
});

// POST /api/quote_items - ENHANCED WITH DEBUGGING
router.post('/quote_items', express.json(), async (req, res) => {
  console.log('POST /api/quote_items requested with body:', JSON.stringify(req.body, null, 2));

  try {
    const { QuoteID, StyleNumber, Quantity } = req.body;

    if (!QuoteID || !StyleNumber || !Quantity) {
      return res.status(400).json({
        error: 'QuoteID, StyleNumber, and Quantity are required'
      });
    }

    // Log the exact data being sent to Caspio
    const itemData = { ...req.body };
    console.log('Sending to Caspio:', JSON.stringify(itemData, null, 2));

    const result = await makeCaspioRequest('post', '/tables/Quote_Items/records', {}, itemData);
    console.log('Quote item created successfully:', JSON.stringify(result, null, 2));
    res.status(201).json(result);
  } catch (error) {
    // Enhanced error logging
    console.error('Error creating quote item - Full error object:', error);
    console.error('Error message:', error.message);
    console.error('Error stack:', error.stack);
    
    // Try to extract more details from the error
    let errorDetails = error.message;
    if (error.response) {
      console.error('Error response status:', error.response.status);
      console.error('Error response data:', JSON.stringify(error.response.data, null, 2));
      errorDetails = error.response.data || error.message;
    }
    
    res.status(500).json({
      error: 'Failed to create quote item',
      details: errorDetails,
      debugInfo: {
        message: error.message,
        status: error.response?.status,
        data: error.response?.data
      }
    });
  }
});

// PUT /api/quote_items/:id
router.put('/quote_items/:id', express.json(), async (req, res) => {
  const { id } = req.params;
  console.log(`PUT /api/quote_items/${id} requested with body:`, req.body);

  try {
    const updates = { ...req.body };
    delete updates.PK_ID;
    delete updates.ItemID;

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ error: 'No valid fields to update' });
    }

    const result = await makeCaspioRequest('put', '/tables/Quote_Items/records', 
      { 'q.where': `PK_ID=${id}` }, 
      updates
    );
    
    console.log('Quote item updated successfully');
    res.json(result);
  } catch (error) {
    console.error('Error updating quote item:', error.message);
    res.status(500).json({ error: 'Failed to update quote item', details: error.message });
  }
});

// DELETE /api/quote_items/:id
router.delete('/quote_items/:id', async (req, res) => {
  const { id } = req.params;
  console.log(`DELETE /api/quote_items/${id} requested`);

  try {
    const result = await makeCaspioRequest('delete', '/tables/Quote_Items/records', 
      { 'q.where': `PK_ID=${id}` }
    );
    
    console.log('Quote item deleted successfully');
    res.json({ message: 'Quote item deleted successfully', recordsAffected: result.RecordsAffected || 0 });
  } catch (error) {
    console.error('Error deleting quote item:', error.message);
    res.status(500).json({ error: 'Failed to delete quote item', details: error.message });
  }
});

// Quote Sessions Routes
// GET /api/quote_sessions
router.get('/quote_sessions', async (req, res) => {
  console.log('GET /api/quote_sessions requested with query:', JSON.stringify(req.query));

  try {
    let whereConditions = [];

    // Support 'filter' parameter (parse QuoteID from filter string)
    if (req.query.filter) {
      console.log('Filter parameter detected:', req.query.filter);
      const filterMatch = req.query.filter.match(/QuoteID='([^']+)'/);
      if (filterMatch && filterMatch[1]) {
        const sanitizedQuoteID = sanitizeQuoteID(filterMatch[1]);
        if (!sanitizedQuoteID) {
          return res.status(400).json({
            error: 'Invalid QuoteID format in filter parameter',
            hint: 'QuoteID must contain only alphanumeric characters, hyphens, and underscores'
          });
        }
        whereConditions.push(`QuoteID='${sanitizedQuoteID}'`);
        console.log('Extracted QuoteID from filter:', sanitizedQuoteID);
      } else {
        return res.status(400).json({
          error: 'Invalid filter format',
          hint: 'Expected format: filter=QuoteID=\'VALUE\' or use quoteID parameter'
        });
      }
    }

    // Support individual parameters (backward compatibility)
    if (req.query.quoteID) {
      const sanitizedQuoteID = sanitizeQuoteID(req.query.quoteID);
      if (!sanitizedQuoteID) {
        return res.status(400).json({
          error: 'Invalid quoteID parameter',
          hint: 'QuoteID must contain only alphanumeric characters, hyphens, and underscores (max 50 chars)'
        });
      }
      whereConditions.push(`QuoteID='${sanitizedQuoteID}'`);
    }

    if (req.query.sessionID) {
      const sanitizedSessionID = sanitizeSessionID(req.query.sessionID);
      if (!sanitizedSessionID) {
        return res.status(400).json({
          error: 'Invalid sessionID parameter',
          hint: 'SessionID must contain only alphanumeric characters, hyphens, and underscores (max 100 chars)'
        });
      }
      whereConditions.push(`SessionID='${sanitizedSessionID}'`);
    }

    if (req.query.customerEmail) {
      const sanitizedEmail = sanitizeEmail(req.query.customerEmail);
      if (!sanitizedEmail) {
        return res.status(400).json({
          error: 'Invalid customerEmail parameter',
          hint: 'Must be a valid email address'
        });
      }
      whereConditions.push(`CustomerEmail='${sanitizedEmail}'`);
    }

    if (req.query.status) {
      const sanitizedStatus = sanitizeStatus(req.query.status);
      if (!sanitizedStatus) {
        return res.status(400).json({
          error: 'Invalid status parameter',
          hint: 'Valid values: active, pending, completed, abandoned, expired'
        });
      }
      whereConditions.push(`Status='${sanitizedStatus}'`);
    }

    // Warn if no filters
    if (whereConditions.length === 0) {
      console.warn('WARNING: No filters provided to /api/quote_sessions - returning all records');
    }

    // Check cache
    const forceRefresh = req.query.refresh === 'true';
    if (!forceRefresh && whereConditions.length > 0) {
      const cacheKey = whereConditions.sort().join('|');
      const cached = quoteSessionsCache.get(cacheKey);

      if (cached && Date.now() - cached.timestamp < QUOTE_SESSIONS_CACHE_TTL) {
        console.log(`Cache HIT for quote_sessions: ${cacheKey} (${cached.data.length} records)`);
        return res.json(cached.data);
      }
    }

    // Build Caspio query
    const params = {};
    if (whereConditions.length > 0) {
      params['q.where'] = whereConditions.join(' AND ');
    }

    console.log('Caspio query params:', JSON.stringify(params));
    const records = await fetchAllCaspioPages('/tables/Quote_Sessions/records', params);
    console.log(`Quote sessions: ${records.length} record(s) found`);

    // Store in cache
    if (whereConditions.length > 0) {
      const cacheKey = whereConditions.sort().join('|');
      quoteSessionsCache.set(cacheKey, {
        data: records,
        timestamp: Date.now()
      });
      console.log(`Cache MISS - stored quote_sessions: ${cacheKey}`);

      // Limit cache size (keep last 100 entries)
      if (quoteSessionsCache.size > 100) {
        const firstKey = quoteSessionsCache.keys().next().value;
        quoteSessionsCache.delete(firstKey);
      }
    }

    res.json(records);
  } catch (error) {
    console.error('Error fetching quote sessions:', error.message);
    res.status(500).json({ error: 'Failed to fetch quote sessions', details: error.message });
  }
});

// GET /api/quote_sessions/:id
router.get('/quote_sessions/:id', async (req, res) => {
  const { id } = req.params;
  console.log(`GET /api/quote_sessions/${id} requested`);

  try {
    const records = await fetchAllCaspioPages('/tables/Quote_Sessions/records', {
      'q.where': `PK_ID=${id}`
    });

    if (records.length === 0) {
      return res.status(404).json({ error: 'Quote session not found' });
    }

    console.log(`Quote session ${id} retrieved successfully`);
    res.json(records[0]);
  } catch (error) {
    console.error('Error fetching quote session by ID:', error.message);
    res.status(500).json({ error: 'Failed to fetch quote session', details: error.message });
  }
});

// POST /api/quote_sessions
router.post('/quote_sessions', express.json(), async (req, res) => {
  console.log('POST /api/quote_sessions requested with body:', req.body);

  try {
    const { QuoteID, SessionID, Status } = req.body;

    if (!QuoteID || !SessionID || !Status) {
      return res.status(400).json({ 
        error: 'QuoteID, SessionID, and Status are required' 
      });
    }

    // Just pass the data directly - no ID generation needed
    const sessionData = { ...req.body };

    const result = await makeCaspioRequest('post', '/tables/Quote_Sessions/records', {}, sessionData);
    console.log('Quote session created successfully');
    res.status(201).json(result);
  } catch (error) {
    console.error('Error creating quote session:', error.message);
    res.status(500).json({ error: 'Failed to create quote session', details: error.message });
  }
});

// PUT /api/quote_sessions/:id
router.put('/quote_sessions/:id', express.json(), async (req, res) => {
  const { id } = req.params;
  console.log(`PUT /api/quote_sessions/${id} requested with body:`, req.body);

  try {
    const updates = { ...req.body };
    delete updates.PK_ID;
    delete updates.CreatedAt;

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ error: 'No valid fields to update' });
    }

    const result = await makeCaspioRequest('put', '/tables/Quote_Sessions/records', 
      { 'q.where': `PK_ID=${id}` }, 
      updates
    );
    
    console.log('Quote session updated successfully');
    res.json(result);
  } catch (error) {
    console.error('Error updating quote session:', error.message);
    res.status(500).json({ error: 'Failed to update quote session', details: error.message });
  }
});

// DELETE /api/quote_sessions/:id
router.delete('/quote_sessions/:id', async (req, res) => {
  const { id } = req.params;
  console.log(`DELETE /api/quote_sessions/${id} requested`);

  try {
    const result = await makeCaspioRequest('delete', '/tables/Quote_Sessions/records', 
      { 'q.where': `PK_ID=${id}` }
    );
    
    console.log('Quote session deleted successfully');
    res.json({ message: 'Quote session deleted successfully', recordsAffected: result.RecordsAffected || 0 });
  } catch (error) {
    console.error('Error deleting quote session:', error.message);
    res.status(500).json({ error: 'Failed to delete quote session', details: error.message });
  }
});

module.exports = router;