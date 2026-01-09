// Garment Tracker CRUD Routes - GarmentTracker table
// Endpoints for pre-processed garment tracking data (staff dashboard optimization)

const express = require('express');
const axios = require('axios');
const router = express.Router();
const config = require('../../config');
const { getCaspioAccessToken, fetchAllCaspioPages } = require('../utils/caspio');

const caspioApiBaseUrl = config.caspio.apiBaseUrl;
const TABLE_NAME = 'GarmentTracker';

// GET /api/garment-tracker - List all records with optional Caspio query parameters
// Supports: q.where, q.orderBy, q.limit as passthrough params
// Examples:
//   GET /api/garment-tracker?q.where=RepName='Nika Lao'
//   GET /api/garment-tracker?q.where=YEAR(TrackedAt)=2026
//   GET /api/garment-tracker?q.orderBy=DateInvoiced DESC&q.limit=100
router.get('/garment-tracker', async (req, res) => {
    try {
        console.log('Fetching garment tracker records with params:', req.query);
        const resource = `/tables/${TABLE_NAME}/records`;
        const params = {};

        // Passthrough Caspio query parameters
        if (req.query['q.where']) {
            params['q.where'] = req.query['q.where'];
        }
        if (req.query['q.orderBy']) {
            params['q.orderBy'] = req.query['q.orderBy'];
        } else {
            params['q.orderBy'] = 'TrackedAt DESC'; // Default: most recent first
        }
        if (req.query['q.limit']) {
            params['q.limit'] = req.query['q.limit'];
        }

        const result = await fetchAllCaspioPages(resource, params);
        console.log(`Found ${result.length} garment tracker records`);

        res.json({
            success: true,
            count: result.length,
            records: result
        });
    } catch (error) {
        console.error('Error fetching garment tracker records:', error.message);

        // Check if table doesn't exist
        if (error.message.includes('404') || error.message.includes('not found')) {
            return res.status(404).json({
                success: false,
                error: 'GarmentTracker table not found in Caspio',
                message: 'Please create the GarmentTracker table in Caspio first'
            });
        }

        res.status(500).json({ success: false, error: 'Failed to fetch garment tracker records' });
    }
});

// DELETE /api/garment-tracker/bulk - Bulk delete with WHERE clause
// IMPORTANT: This route must be defined BEFORE /:id to prevent "bulk" being matched as an ID
// Body: { "where": "YEAR(TrackedAt)=2025" }
router.delete('/garment-tracker/bulk', express.json(), async (req, res) => {
    const { where } = req.body;

    if (!where) {
        return res.status(400).json({
            success: false,
            error: 'Missing required field: where',
            example: '{ "where": "YEAR(TrackedAt)=2025" }'
        });
    }

    try {
        console.log(`Bulk deleting garment tracker records with WHERE: ${where}`);

        const token = await getCaspioAccessToken();
        const url = `${caspioApiBaseUrl}/tables/${TABLE_NAME}/records?q.where=${encodeURIComponent(where)}`;

        const response = await axios({
            method: 'delete',
            url: url,
            headers: {
                'Authorization': `Bearer ${token}`
            },
            timeout: 30000 // Longer timeout for bulk operations
        });

        // Caspio returns RecordsAffected in response
        const recordsAffected = response.data?.RecordsAffected || 0;
        console.log(`Bulk delete completed: ${recordsAffected} records affected`);

        res.json({
            success: true,
            message: 'Bulk delete completed',
            recordsAffected: recordsAffected
        });
    } catch (error) {
        console.error('Error bulk deleting garment tracker records:',
            error.response ? JSON.stringify(error.response.data) : error.message);
        res.status(500).json({ success: false, error: 'Failed to bulk delete records' });
    }
});

// GET /api/garment-tracker/:id - Get single record by ID_Garment
router.get('/garment-tracker/:id', async (req, res) => {
    const { id } = req.params;

    if (!id) {
        return res.status(400).json({ success: false, error: 'Missing required parameter: id' });
    }

    try {
        console.log(`Fetching garment tracker record with ID_Garment: ${id}`);
        const resource = `/tables/${TABLE_NAME}/records`;
        const params = {
            'q.where': `ID_Garment=${id}`,
            'q.limit': 1
        };

        const result = await fetchAllCaspioPages(resource, params);

        if (result.length === 0) {
            return res.status(404).json({ success: false, error: 'Record not found' });
        }

        res.json({
            success: true,
            record: result[0]
        });
    } catch (error) {
        console.error('Error fetching garment tracker record:', error.message);
        res.status(500).json({ success: false, error: 'Failed to fetch record' });
    }
});

// POST /api/garment-tracker - Create new record
// Body: { OrderNumber, DateInvoiced, RepName, CustomerName, CompanyName, PartNumber, StyleCategory, Quantity, BonusAmount, TrackedAt }
router.post('/garment-tracker', express.json(), async (req, res) => {
    try {
        const requestData = { ...req.body };

        // Validate required fields
        if (!requestData.OrderNumber) {
            return res.status(400).json({ success: false, error: 'Missing required field: OrderNumber' });
        }

        console.log(`Creating garment tracker record for OrderNumber: ${requestData.OrderNumber}`);

        // Auto-set TrackedAt if not provided
        if (!requestData.TrackedAt) {
            requestData.TrackedAt = new Date().toISOString();
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

        // Extract ID_Garment from Location header
        let newId = null;
        if (response.headers.location) {
            newId = parseInt(response.headers.location.split('/').pop());
        }

        console.log(`Created garment tracker record with ID_Garment: ${newId}`);

        res.status(201).json({
            success: true,
            record: {
                ID_Garment: newId,
                ...requestData
            }
        });
    } catch (error) {
        console.error('Error creating garment tracker record:',
            error.response ? JSON.stringify(error.response.data) : error.message);
        res.status(500).json({ success: false, error: 'Failed to create record' });
    }
});

// PUT /api/garment-tracker/:id - Update record by ID_Garment
router.put('/garment-tracker/:id', express.json(), async (req, res) => {
    const { id } = req.params;

    if (!id) {
        return res.status(400).json({ success: false, error: 'Missing required parameter: id' });
    }

    try {
        console.log(`Updating garment tracker record with ID_Garment: ${id}`);

        const updateData = { ...req.body };

        const token = await getCaspioAccessToken();
        const url = `${caspioApiBaseUrl}/tables/${TABLE_NAME}/records?q.where=ID_Garment=${id}`;

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

        res.json({ success: true, message: 'Record updated successfully' });
    } catch (error) {
        console.error('Error updating garment tracker record:',
            error.response ? JSON.stringify(error.response.data) : error.message);
        res.status(500).json({ success: false, error: 'Failed to update record' });
    }
});

// DELETE /api/garment-tracker/:id - Delete record by ID_Garment
router.delete('/garment-tracker/:id', async (req, res) => {
    const { id } = req.params;

    if (!id) {
        return res.status(400).json({ success: false, error: 'Missing required parameter: id' });
    }

    try {
        console.log(`Deleting garment tracker record with ID_Garment: ${id}`);

        const token = await getCaspioAccessToken();
        const url = `${caspioApiBaseUrl}/tables/${TABLE_NAME}/records?q.where=ID_Garment=${id}`;

        await axios({
            method: 'delete',
            url: url,
            headers: {
                'Authorization': `Bearer ${token}`
            },
            timeout: 15000
        });

        res.json({ success: true, message: 'Record deleted successfully' });
    } catch (error) {
        console.error('Error deleting garment tracker record:',
            error.response ? JSON.stringify(error.response.data) : error.message);
        res.status(500).json({ success: false, error: 'Failed to delete record' });
    }
});

module.exports = router;
