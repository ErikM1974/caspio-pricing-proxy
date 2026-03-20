// EMB Design Files Routes — CRUD for EMB_Design_Files Caspio table
// Stores parsed EMB file metadata (dimensions, threads, stitch count, hoop, colorways)
//
// Endpoints:
//   GET    /api/emb-designs              — List EMB files (filter by mockupId, designNumber, etc.)
//   GET    /api/emb-designs/by-mockup/:mockupId — Get all EMB files for a mockup
//   GET    /api/emb-designs/:id          — Get single EMB record
//   POST   /api/emb-designs              — Create new EMB record
//   PUT    /api/emb-designs/:id          — Update EMB record
//   DELETE /api/emb-designs/:id          — Delete EMB record

const express = require('express');
const router = express.Router();
const axios = require('axios');
const { getCaspioAccessToken, fetchAllCaspioPages } = require('../utils/caspio');
const config = require('../../config');

const caspioApiBaseUrl = config.caspio.apiBaseUrl;
const TABLE_NAME = 'EMB_Design_Files';

// ── List EMB Design Files ────────────────────────────────────────────

/**
 * GET /api/emb-designs
 *
 * List EMB files with optional filters.
 * Query params: mockupId, designNumber, colorwayName, isPrimary, applicationType, orderBy, pageSize
 */
router.get('/emb-designs', async (req, res) => {
    try {
        const resource = `/tables/${TABLE_NAME}/records`;
        const params = {};
        const whereConditions = [];

        if (req.query.mockupId) {
            whereConditions.push(`Mockup_ID=${req.query.mockupId}`);
        }

        if (req.query.designNumber) {
            const escaped = req.query.designNumber.replace(/'/g, "''");
            whereConditions.push(`Design_Number='${escaped}'`);
        }

        if (req.query.colorwayName) {
            const escaped = req.query.colorwayName.replace(/'/g, "''");
            whereConditions.push(`Colorway_Name='${escaped}'`);
        }

        if (req.query.isPrimary) {
            const escaped = req.query.isPrimary.replace(/'/g, "''");
            whereConditions.push(`Is_Primary='${escaped}'`);
        }

        if (req.query.applicationType) {
            const escaped = req.query.applicationType.replace(/'/g, "''");
            whereConditions.push(`Application_Type='${escaped}'`);
        }

        if (whereConditions.length > 0) {
            params['q.where'] = whereConditions.join(' AND ');
        }

        params['q.orderBy'] = req.query.orderBy || 'Is_Primary DESC, Upload_Date DESC';
        params['q.pageSize'] = parseInt(req.query.pageSize) || 100;

        const records = await fetchAllCaspioPages(resource, params);

        res.json({
            success: true,
            count: records.length,
            records
        });

    } catch (error) {
        console.error('Error fetching EMB designs:', error.response ? JSON.stringify(error.response.data) : error.message);
        res.status(500).json({ success: false, error: 'Failed to fetch EMB designs: ' + error.message });
    }
});

// ── Get EMB Files by Mockup ID ───────────────────────────────────────

/**
 * GET /api/emb-designs/by-mockup/:mockupId
 *
 * Convenience endpoint to get all EMB files for a specific mockup.
 * Returns primary colorway first, then alternates by upload date.
 */
router.get('/emb-designs/by-mockup/:mockupId', async (req, res) => {
    try {
        const { mockupId } = req.params;
        const resource = `/tables/${TABLE_NAME}/records`;
        const params = {
            'q.where': `Mockup_ID=${mockupId}`,
            'q.orderBy': 'Is_Primary DESC, Upload_Date DESC',
            'q.pageSize': 100
        };

        const records = await fetchAllCaspioPages(resource, params);

        res.json({
            success: true,
            count: records.length,
            records
        });

    } catch (error) {
        console.error('Error fetching EMB designs for mockup:', error.response ? JSON.stringify(error.response.data) : error.message);
        res.status(500).json({ success: false, error: 'Failed to fetch EMB designs: ' + error.message });
    }
});

// ── Get Single EMB Record ────────────────────────────────────────────

/**
 * GET /api/emb-designs/:id
 *
 * Get a single EMB design record by ID.
 */
router.get('/emb-designs/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const token = await getCaspioAccessToken();
        const url = `${caspioApiBaseUrl}/tables/${TABLE_NAME}/records?q.where=ID=${id}`;

        const resp = await axios.get(url, {
            headers: { 'Authorization': `Bearer ${token}` },
            timeout: 15000
        });

        const records = resp.data.Result || [];
        if (records.length === 0) {
            return res.status(404).json({ success: false, error: 'EMB design record not found' });
        }

        res.json({ success: true, record: records[0] });

    } catch (error) {
        console.error('Error fetching EMB design:', error.response ? JSON.stringify(error.response.data) : error.message);
        res.status(500).json({ success: false, error: 'Failed to fetch EMB design: ' + error.message });
    }
});

// ── Create EMB Record ────────────────────────────────────────────────

/**
 * POST /api/emb-designs
 *
 * Create a new EMB design record.
 * Body: all fields from EMB_Design_Files table (except ID — auto-generated)
 */
router.post('/emb-designs', async (req, res) => {
    try {
        const token = await getCaspioAccessToken();
        const url = `${caspioApiBaseUrl}/tables/${TABLE_NAME}/records`;

        const data = {
            ...req.body,
            Upload_Date: req.body.Upload_Date || new Date().toISOString(),
            Is_Primary: req.body.Is_Primary || 'Yes'
        };

        const insertResp = await axios.post(url, data, {
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json'
            },
            timeout: 15000
        });

        // Extract new ID from Location header
        const locationHeader = insertResp.headers.location || '';
        let createdRecord = { ID: null };

        const idMatch = locationHeader.match(/ID[=](\d+)/i);
        if (idMatch) {
            const newId = parseInt(idMatch[1]);

            try {
                const fetchResp = await axios.get(`${caspioApiBaseUrl}/tables/${TABLE_NAME}/records?q.where=ID=${newId}`, {
                    headers: { 'Authorization': `Bearer ${token}` },
                    timeout: 15000
                });
                const records = fetchResp.data.Result || [];
                createdRecord = records.length > 0 ? records[0] : { ID: newId };
            } catch (fetchErr) {
                console.warn('Could not fetch created EMB record:', fetchErr.message);
                createdRecord = { ID: newId };
            }
        } else {
            // Fallback: query newest record for this mockup
            console.warn('No ID in Location header for EMB design. Header:', locationHeader);
            try {
                const queryUrl = `${caspioApiBaseUrl}/tables/${TABLE_NAME}/records?q.where=Mockup_ID=${data.Mockup_ID}&q.orderBy=${encodeURIComponent('ID DESC')}&q.pageSize=1`;
                const queryResp = await axios.get(queryUrl, {
                    headers: { 'Authorization': `Bearer ${token}` },
                    timeout: 15000
                });
                const records = queryResp.data.Result || [];
                if (records.length > 0) {
                    createdRecord = records[0];
                }
            } catch (queryErr) {
                console.warn('Fallback query failed:', queryErr.message);
            }
        }

        console.log(`EMB design created: ID ${createdRecord.ID}, Design ${data.Design_Number}, Colorway: ${data.Colorway_Name}`);

        res.status(201).json({
            success: true,
            record: createdRecord
        });

    } catch (error) {
        console.error('Error creating EMB design:', error.response ? JSON.stringify(error.response.data) : error.message);
        res.status(500).json({ success: false, error: 'Failed to create EMB design: ' + error.message });
    }
});

// ── Update EMB Record ────────────────────────────────────────────────

/**
 * PUT /api/emb-designs/:id
 *
 * Update an EMB design record (partial update).
 * Body: any writable fields
 */
router.put('/emb-designs/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const token = await getCaspioAccessToken();
        const url = `${caspioApiBaseUrl}/tables/${TABLE_NAME}/records?q.where=ID=${id}`;

        await axios.put(url, req.body, {
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json'
            },
            timeout: 15000
        });

        console.log(`EMB design ${id} updated:`, Object.keys(req.body).join(', '));

        res.json({ success: true, message: 'EMB design updated' });

    } catch (error) {
        console.error('Error updating EMB design:', error.response ? JSON.stringify(error.response.data) : error.message);
        res.status(500).json({ success: false, error: 'Failed to update EMB design: ' + error.message });
    }
});

// ── Delete EMB Record ────────────────────────────────────────────────

/**
 * DELETE /api/emb-designs/:id
 *
 * Delete an EMB design record by ID.
 */
router.delete('/emb-designs/:id', async (req, res) => {
    try {
        const { id } = req.params;

        if (!id) {
            return res.status(400).json({ success: false, error: 'Missing required parameter: id' });
        }

        const token = await getCaspioAccessToken();
        const url = `${caspioApiBaseUrl}/tables/${TABLE_NAME}/records?q.where=ID=${id}`;

        await axios.delete(url, {
            headers: { 'Authorization': `Bearer ${token}` },
            timeout: 15000
        });

        console.log(`EMB design ${id} deleted`);

        res.json({ success: true, message: 'EMB design deleted' });

    } catch (error) {
        console.error('Error deleting EMB design:', error.response ? JSON.stringify(error.response.data) : error.message);
        res.status(500).json({ success: false, error: 'Failed to delete EMB design: ' + error.message });
    }
});

module.exports = router;
