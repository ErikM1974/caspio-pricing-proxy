// Production schedules routes
const express = require('express');
const router = express.Router();
const { fetchAllCaspioPages } = require('../utils/caspio');

// GET /api/production-schedules
// Example: /api/production-schedules
// Example: /api/production-schedules?q.where=Date>'2021-08-01'
// Example: /api/production-schedules?q.orderBy=Date DESC&q.limit=50
router.get('/production-schedules', async (req, res) => {
    console.log(`GET /api/production-schedules requested with params:`, req.query);
    
    try {
        const resource = '/tables/Production_Schedules/records';
        const params = {};
        
        // Handle query parameters
        if (req.query['q.where']) {
            params['q.where'] = req.query['q.where'];
        }
        
        if (req.query['q.orderBy']) {
            params['q.orderby'] = req.query['q.orderBy']; // Note: Caspio uses lowercase 'orderby'
        }
        
        if (req.query['q.limit']) {
            // Validate limit is within allowed range
            const limit = parseInt(req.query['q.limit']);
            if (isNaN(limit) || limit < 1) {
                return res.status(400).json({ error: 'Invalid limit parameter. Must be a positive integer.' });
            }
            if (limit > 1000) {
                return res.status(400).json({ error: 'Limit parameter cannot exceed 1000.' });
            }
            params['q.limit'] = limit;
        } else {
            // Default limit
            params['q.limit'] = 100;
        }
        
        // Use fetchAllCaspioPages to handle pagination
        const result = await fetchAllCaspioPages(resource, params);
        console.log(`Found ${result.length} production schedule records`);
        
        res.json(result);
    } catch (error) {
        console.error("Error fetching production schedules:", error.message);
        res.status(500).json({ error: 'Failed to fetch production schedules.' });
    }
});

module.exports = router;