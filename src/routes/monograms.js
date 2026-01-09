// Monograms CRUD Routes - Monograms table
// Endpoints for managing monogram orders (name personalization)

const express = require('express');
const axios = require('axios');
const router = express.Router();
const config = require('../../config');
const { getCaspioAccessToken, fetchAllCaspioPages } = require('../utils/caspio');

const caspioApiBaseUrl = config.caspio.apiBaseUrl;
const TABLE_NAME = 'Monograms';

// GET /api/monograms - List all monograms with optional filters
router.get('/monograms', async (req, res) => {
    try {
        console.log('Fetching monograms with filters:', req.query);
        const resource = `/tables/${TABLE_NAME}/records`;
        const params = {};
        const whereConditions = [];

        // Build WHERE clause based on query parameters
        if (req.query.orderNumber) {
            whereConditions.push(`OrderNumber=${req.query.orderNumber}`);
        }
        if (req.query.companyName) {
            whereConditions.push(`CompanyName LIKE '%${req.query.companyName}%'`);
        }
        if (req.query.status) {
            whereConditions.push(`Status='${req.query.status}'`);
        }
        if (req.query.dateFrom) {
            whereConditions.push(`CreatedAt>='${req.query.dateFrom}'`);
        }
        if (req.query.dateTo) {
            whereConditions.push(`CreatedAt<='${req.query.dateTo}'`);
        }

        // Apply WHERE clause if conditions exist
        if (whereConditions.length > 0) {
            params['q.where'] = whereConditions.join(' AND ');
        }

        // Default ordering: most recent first
        params['q.orderBy'] = 'CreatedAt DESC';

        const result = await fetchAllCaspioPages(resource, params);
        console.log(`Found ${result.length} monogram records`);

        res.json({
            success: true,
            count: result.length,
            monograms: result
        });
    } catch (error) {
        console.error('Error fetching monograms:', error.message);
        res.status(500).json({ success: false, error: 'Failed to fetch monograms' });
    }
});

// GET /api/monograms/:orderNumber - Get single monogram by OrderNumber
router.get('/monograms/:orderNumber', async (req, res) => {
    const { orderNumber } = req.params;

    if (!orderNumber) {
        return res.status(400).json({ success: false, error: 'Missing required parameter: orderNumber' });
    }

    try {
        console.log(`Fetching monogram with OrderNumber: ${orderNumber}`);
        const resource = `/tables/${TABLE_NAME}/records`;
        const params = {
            'q.where': `OrderNumber=${orderNumber}`,
            'q.limit': 1
        };

        const result = await fetchAllCaspioPages(resource, params);

        if (result.length === 0) {
            return res.status(404).json({ success: false, error: 'Monogram not found' });
        }

        res.json({
            success: true,
            monogram: result[0]
        });
    } catch (error) {
        console.error('Error fetching monogram:', error.message);
        res.status(500).json({ success: false, error: 'Failed to fetch monogram' });
    }
});

// POST /api/monograms - Create new monogram (with upsert support)
router.post('/monograms', express.json(), async (req, res) => {
    try {
        const requestData = { ...req.body };

        // Validate required field
        if (!requestData.OrderNumber) {
            return res.status(400).json({ success: false, error: 'Missing required field: OrderNumber' });
        }

        console.log(`Creating/updating monogram for OrderNumber: ${requestData.OrderNumber}`);

        // Check if OrderNumber already exists (upsert support)
        const checkResource = `/tables/${TABLE_NAME}/records`;
        const checkParams = {
            'q.where': `OrderNumber=${requestData.OrderNumber}`,
            'q.select': 'ID_Monogram',
            'q.limit': 1
        };

        const existing = await fetchAllCaspioPages(checkResource, checkParams);

        const token = await getCaspioAccessToken();

        if (existing.length > 0) {
            // UPDATE existing record
            const existingId = existing[0].ID_Monogram;
            console.log(`OrderNumber ${requestData.OrderNumber} exists, updating ID_Monogram: ${existingId}`);

            // Set ModifiedAt timestamp
            requestData.ModifiedAt = new Date().toISOString();

            const url = `${caspioApiBaseUrl}/tables/${TABLE_NAME}/records?q.where=ID_Monogram=${existingId}`;

            await axios({
                method: 'put',
                url: url,
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'Content-Type': 'application/json'
                },
                data: requestData,
                timeout: 15000
            });

            res.json({
                success: true,
                action: 'updated',
                monogram: {
                    ID_Monogram: existingId,
                    ...requestData
                }
            });
        } else {
            // CREATE new record
            console.log(`Creating new monogram for OrderNumber: ${requestData.OrderNumber}`);

            // Set CreatedAt timestamp if not provided
            if (!requestData.CreatedAt) {
                requestData.CreatedAt = new Date().toISOString();
            }

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

            // Extract ID_Monogram from Location header
            let newId = null;
            if (response.headers.location) {
                newId = parseInt(response.headers.location.split('/').pop());
            }

            res.status(201).json({
                success: true,
                action: 'created',
                monogram: {
                    ID_Monogram: newId,
                    ...requestData
                }
            });
        }
    } catch (error) {
        console.error('Error creating/updating monogram:',
            error.response ? JSON.stringify(error.response.data) : error.message);
        res.status(500).json({ success: false, error: 'Failed to create/update monogram' });
    }
});

// PUT /api/monograms/:id_monogram - Update monogram by ID
router.put('/monograms/:id_monogram', express.json(), async (req, res) => {
    const { id_monogram } = req.params;

    if (!id_monogram) {
        return res.status(400).json({ success: false, error: 'Missing required parameter: id_monogram' });
    }

    try {
        console.log(`Updating monogram with ID_Monogram: ${id_monogram}`);

        const updateData = { ...req.body };

        // Set ModifiedAt timestamp
        updateData.ModifiedAt = new Date().toISOString();

        const token = await getCaspioAccessToken();
        const url = `${caspioApiBaseUrl}/tables/${TABLE_NAME}/records?q.where=ID_Monogram=${id_monogram}`;

        await axios({
            method: 'put',
            url: url,
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json'
            },
            data: updateData,
            timeout: 15000
        });

        res.json({ success: true, message: 'Monogram updated successfully' });
    } catch (error) {
        console.error('Error updating monogram:',
            error.response ? JSON.stringify(error.response.data) : error.message);
        res.status(500).json({ success: false, error: 'Failed to update monogram' });
    }
});

// DELETE /api/monograms/:id_monogram - Delete monogram by ID
router.delete('/monograms/:id_monogram', async (req, res) => {
    const { id_monogram } = req.params;

    if (!id_monogram) {
        return res.status(400).json({ success: false, error: 'Missing required parameter: id_monogram' });
    }

    try {
        console.log(`Deleting monogram with ID_Monogram: ${id_monogram}`);

        const token = await getCaspioAccessToken();
        const url = `${caspioApiBaseUrl}/tables/${TABLE_NAME}/records?q.where=ID_Monogram=${id_monogram}`;

        await axios({
            method: 'delete',
            url: url,
            headers: {
                'Authorization': `Bearer ${token}`
            },
            timeout: 15000
        });

        res.json({ success: true, message: 'Monogram deleted successfully' });
    } catch (error) {
        console.error('Error deleting monogram:',
            error.response ? JSON.stringify(error.response.data) : error.message);
        res.status(500).json({ success: false, error: 'Failed to delete monogram' });
    }
});

module.exports = router;
