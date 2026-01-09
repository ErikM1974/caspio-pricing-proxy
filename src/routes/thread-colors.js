const express = require('express');
const router = express.Router();
const { fetchAllCaspioPages } = require('../utils/caspio');

// GET /api/thread-colors
// Returns all thread colors from the ThreadColors table
// Optional query param: ?instock=true to return only in-stock colors
router.get('/thread-colors', async (req, res) => {
    const { instock } = req.query;
    console.log(`GET /api/thread-colors requested with instock=${instock || 'all'}`);

    try {
        const params = {
            'q.select': 'Thead_ID,Thread_Color,Thread_Number,Instock',
            'q.orderBy': 'Thread_Color ASC'
        };

        // Filter: instock=true returns only in-stock colors (Caspio Yes/No field uses 1/0)
        if (instock === 'true') {
            params['q.where'] = 'Instock=1';
        }

        const colors = await fetchAllCaspioPages('/tables/ThreadColors/records', params);
        console.log(`Thread colors: ${colors.length} record(s) found`);
        res.json(colors);
    } catch (error) {
        console.error('Error fetching thread colors:', error.message);
        res.status(500).json({ error: 'Failed to fetch thread colors', details: error.message });
    }
});

module.exports = router;
