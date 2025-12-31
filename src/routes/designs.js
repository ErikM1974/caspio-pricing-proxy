// Designs CRUD Routes - Inksoft_Transform_Designs_seed table
// Endpoints for managing store designs (InkSoft Transform Flask integration)

const express = require('express');
const axios = require('axios');
const router = express.Router();
const config = require('../../config');
const { getCaspioAccessToken, fetchAllCaspioPages } = require('../utils/caspio');

const caspioApiBaseUrl = config.caspio.apiBaseUrl;
const TABLE_NAME = 'Inksoft_Transform_Designs_seed';

// GET /api/designs/store/:store_id - Get active designs for a specific store
router.get('/designs/store/:store_id', async (req, res) => {
    const { store_id } = req.params;

    if (!store_id) {
        return res.status(400).json({ success: false, error: 'Missing required parameter: store_id' });
    }

    try {
        const resource = `/tables/${TABLE_NAME}/records`;
        const params = {
            'q.where': `StoreId=${store_id} AND IsActive=1`,
            'q.orderBy': 'sort_order ASC'
        };

        const result = await fetchAllCaspioPages(resource, params);

        res.json({
            success: true,
            store_id: parseInt(store_id),
            designs: result
        });
    } catch (error) {
        console.error('Error fetching designs for store:', error.message);
        res.status(500).json({ success: false, error: 'Failed to fetch designs' });
    }
});

// GET /api/designs - Get all active designs grouped by StoreName (admin view)
router.get('/designs', async (req, res) => {
    try {
        const resource = `/tables/${TABLE_NAME}/records`;
        const params = {
            'q.where': 'IsActive=1',
            'q.orderBy': 'StoreName ASC, sort_order ASC'
        };

        const result = await fetchAllCaspioPages(resource, params);

        // Group designs by StoreName
        const stores = {};
        for (const design of result) {
            const storeName = design.StoreName || 'Unknown';
            if (!stores[storeName]) {
                stores[storeName] = [];
            }
            stores[storeName].push(design);
        }

        res.json({
            success: true,
            stores: stores
        });
    } catch (error) {
        console.error('Error fetching all designs:', error.message);
        res.status(500).json({ success: false, error: 'Failed to fetch designs' });
    }
});

// POST /api/designs - Create a new design
router.post('/designs', express.json(), async (req, res) => {
    try {
        const requestData = { ...req.body };

        // Auto-set IsActive to true for new records (Caspio uses 1/0 for Yes/No)
        requestData.IsActive = 1;

        // Convert null detection_key to empty string
        if (requestData.detection_key === null || requestData.detection_key === undefined) {
            requestData.detection_key = '';
        }

        const token = await getCaspioAccessToken();
        const url = `${caspioApiBaseUrl}/tables/${TABLE_NAME}/records`;

        const response = await axios({
            method: 'post',
            url: url,
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json'
            },
            data: requestData,
            timeout: 15000
        });

        // Extract PK_ID from Location header if available
        let pkId = null;
        if (response.headers.location) {
            pkId = parseInt(response.headers.location.split('/').pop());
        }

        res.status(201).json({
            success: true,
            design: {
                PK_ID: pkId,
                ...requestData
            }
        });
    } catch (error) {
        console.error('Error creating design:',
            error.response ? JSON.stringify(error.response.data) : error.message);
        res.status(500).json({ success: false, error: 'Failed to create design' });
    }
});

// PUT /api/designs/:pk_id - Update a design by PK_ID
router.put('/designs/:pk_id', express.json(), async (req, res) => {
    const { pk_id } = req.params;

    if (!pk_id) {
        return res.status(400).json({ success: false, error: 'Missing required parameter: pk_id' });
    }

    try {
        const token = await getCaspioAccessToken();
        const url = `${caspioApiBaseUrl}/tables/${TABLE_NAME}/records?q.where=PK_ID=${pk_id}`;

        await axios({
            method: 'put',
            url: url,
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json'
            },
            data: req.body,
            timeout: 15000
        });

        res.json({ success: true });
    } catch (error) {
        console.error('Error updating design:',
            error.response ? JSON.stringify(error.response.data) : error.message);
        res.status(500).json({ success: false, error: 'Failed to update design' });
    }
});

// DELETE /api/designs/:pk_id - Soft delete a design (set IsActive=false)
router.delete('/designs/:pk_id', async (req, res) => {
    const { pk_id } = req.params;

    if (!pk_id) {
        return res.status(400).json({ success: false, error: 'Missing required parameter: pk_id' });
    }

    try {
        const token = await getCaspioAccessToken();
        const url = `${caspioApiBaseUrl}/tables/${TABLE_NAME}/records?q.where=PK_ID=${pk_id}`;

        // Soft delete: set IsActive to false (Caspio uses 1/0 for Yes/No)
        await axios({
            method: 'put',
            url: url,
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json'
            },
            data: { IsActive: 0 },
            timeout: 15000
        });

        res.json({ success: true });
    } catch (error) {
        console.error('Error deleting design:',
            error.response ? JSON.stringify(error.response.data) : error.message);
        res.status(500).json({ success: false, error: 'Failed to delete design' });
    }
});

module.exports = router;
