// Sales Reps 2026 CRUD Routes - Sales_Reps_2026 table
// Master list of customer-to-sales-rep assignments

const express = require('express');
const axios = require('axios');
const router = express.Router();
const config = require('../../config');
const { getCaspioAccessToken, fetchAllCaspioPages } = require('../utils/caspio');

const caspioApiBaseUrl = config.caspio.apiBaseUrl;
const TABLE_NAME = 'Sales_Reps_2026';
const PRIMARY_KEY = 'ID_Customer';

// GET /api/sales-reps-2026 - List all with optional filters
router.get('/sales-reps-2026', async (req, res) => {
    try {
        console.log('Fetching sales reps 2026 with filters:', req.query);
        const resource = `/tables/${TABLE_NAME}/records`;
        const params = {};
        const whereConditions = [];

        // Filter by CustomerServiceRep
        if (req.query.customerServiceRep) {
            whereConditions.push(`CustomerServiceRep='${req.query.customerServiceRep}'`);
        }

        // Filter by Account_Tier
        if (req.query.accountTier) {
            whereConditions.push(`Account_Tier='${req.query.accountTier}'`);
        }

        // Filter by Inksoft_Store (boolean)
        if (req.query.inksoftStore !== undefined) {
            const storeVal = req.query.inksoftStore === '1' || req.query.inksoftStore === 'true' ? 1 : 0;
            whereConditions.push(`Inksoft_Store=${storeVal}`);
        }

        // Search by company name
        if (req.query.search) {
            whereConditions.push(`CompanyName LIKE '%${req.query.search}%'`);
        }

        // Filter by customer ID
        if (req.query.customerId) {
            whereConditions.push(`ID_Customer=${req.query.customerId}`);
        }

        // Apply WHERE clause if conditions exist
        if (whereConditions.length > 0) {
            params['q.where'] = whereConditions.join(' AND ');
        }

        // Sorting
        const orderBy = req.query.orderBy || 'CompanyName';
        const orderDir = req.query.orderDir || 'ASC';
        params['q.orderBy'] = `${orderBy} ${orderDir}`;

        const result = await fetchAllCaspioPages(resource, params);
        console.log(`Found ${result.length} sales rep records`);

        res.json({
            success: true,
            count: result.length,
            records: result
        });
    } catch (error) {
        console.error('Error fetching sales reps 2026:', error.message);
        res.status(500).json({ success: false, error: 'Failed to fetch sales reps' });
    }
});

// GET /api/sales-reps-2026/stats - Get summary statistics
router.get('/sales-reps-2026/stats', async (req, res) => {
    try {
        console.log('Fetching sales reps 2026 statistics...');
        const resource = `/tables/${TABLE_NAME}/records`;

        const records = await fetchAllCaspioPages(resource, {});

        // Aggregate by CustomerServiceRep
        const byRep = {};
        // Aggregate by Account_Tier
        const byTier = {};
        let inksoftCount = 0;

        records.forEach(record => {
            const rep = record.CustomerServiceRep || 'Unassigned';
            byRep[rep] = (byRep[rep] || 0) + 1;

            const tier = record.Account_Tier || 'Unknown';
            byTier[tier] = (byTier[tier] || 0) + 1;

            if (record.Inksoft_Store) {
                inksoftCount++;
            }
        });

        res.json({
            success: true,
            total: records.length,
            inksoftStores: inksoftCount,
            byRep: byRep,
            byTier: byTier
        });
    } catch (error) {
        console.error('Error fetching sales reps 2026 stats:', error.message);
        res.status(500).json({ success: false, error: 'Failed to fetch statistics' });
    }
});

// GET /api/sales-reps-2026/:id - Get single record by ID_Customer
router.get('/sales-reps-2026/:id', async (req, res) => {
    const { id } = req.params;

    if (!id) {
        return res.status(400).json({ success: false, error: 'Missing required parameter: id' });
    }

    try {
        console.log(`Fetching sales rep 2026 with ID_Customer: ${id}`);
        const resource = `/tables/${TABLE_NAME}/records`;
        const params = {
            'q.where': `${PRIMARY_KEY}=${id}`,
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
        console.error('Error fetching sales rep 2026:', error.message);
        res.status(500).json({ success: false, error: 'Failed to fetch record' });
    }
});

// POST /api/sales-reps-2026 - Create new record
router.post('/sales-reps-2026', express.json(), async (req, res) => {
    try {
        const requestData = { ...req.body };

        // Validate required fields
        if (!requestData.ID_Customer) {
            return res.status(400).json({ success: false, error: 'Missing required field: ID_Customer' });
        }
        if (!requestData.CompanyName) {
            return res.status(400).json({ success: false, error: 'Missing required field: CompanyName' });
        }

        console.log(`Creating sales rep 2026 for ID_Customer: ${requestData.ID_Customer}`);

        // Check if ID_Customer already exists
        const checkResource = `/tables/${TABLE_NAME}/records`;
        const checkParams = {
            'q.where': `${PRIMARY_KEY}=${requestData.ID_Customer}`,
            'q.select': PRIMARY_KEY,
            'q.limit': 1
        };

        const existing = await fetchAllCaspioPages(checkResource, checkParams);

        if (existing.length > 0) {
            return res.status(409).json({
                success: false,
                error: `Record with ID_Customer ${requestData.ID_Customer} already exists`
            });
        }

        const token = await getCaspioAccessToken();
        const url = `${caspioApiBaseUrl}/tables/${TABLE_NAME}/records`;

        await axios({
            method: 'post',
            url: url,
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json'
            },
            data: requestData,
            timeout: 15000
        });

        console.log(`Created sales rep 2026 for ID_Customer: ${requestData.ID_Customer}`);

        res.status(201).json({
            success: true,
            message: 'Record created successfully',
            record: requestData
        });
    } catch (error) {
        console.error('Error creating sales rep 2026:',
            error.response ? JSON.stringify(error.response.data) : error.message);
        res.status(500).json({ success: false, error: 'Failed to create record' });
    }
});

// PUT /api/sales-reps-2026/:id - Update record
router.put('/sales-reps-2026/:id', express.json(), async (req, res) => {
    const { id } = req.params;

    if (!id) {
        return res.status(400).json({ success: false, error: 'Missing required parameter: id' });
    }

    try {
        console.log(`Updating sales rep 2026 with ID_Customer: ${id}`);

        const updateData = { ...req.body };

        // Remove primary key from update data if present
        delete updateData.ID_Customer;

        if (Object.keys(updateData).length === 0) {
            return res.status(400).json({ success: false, error: 'No fields to update' });
        }

        const token = await getCaspioAccessToken();
        const url = `${caspioApiBaseUrl}/tables/${TABLE_NAME}/records?q.where=${PRIMARY_KEY}=${id}`;

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

        res.json({
            success: true,
            message: 'Record updated successfully',
            updatedFields: Object.keys(updateData)
        });
    } catch (error) {
        console.error('Error updating sales rep 2026:',
            error.response ? JSON.stringify(error.response.data) : error.message);
        res.status(500).json({ success: false, error: 'Failed to update record' });
    }
});

// DELETE /api/sales-reps-2026/:id - Delete record
router.delete('/sales-reps-2026/:id', async (req, res) => {
    const { id } = req.params;

    if (!id) {
        return res.status(400).json({ success: false, error: 'Missing required parameter: id' });
    }

    try {
        console.log(`Deleting sales rep 2026 with ID_Customer: ${id}`);

        const token = await getCaspioAccessToken();
        const url = `${caspioApiBaseUrl}/tables/${TABLE_NAME}/records?q.where=${PRIMARY_KEY}=${id}`;

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
        console.error('Error deleting sales rep 2026:',
            error.response ? JSON.stringify(error.response.data) : error.message);
        res.status(500).json({ success: false, error: 'Failed to delete record' });
    }
});

// POST /api/sales-reps-2026/bulk - Add multiple records at once
router.post('/sales-reps-2026/bulk', express.json(), async (req, res) => {
    try {
        const { records } = req.body;

        if (!records || !Array.isArray(records) || records.length === 0) {
            return res.status(400).json({
                success: false,
                error: 'Missing or empty records array'
            });
        }

        console.log(`Bulk adding ${records.length} sales rep 2026 records...`);

        const token = await getCaspioAccessToken();
        const url = `${caspioApiBaseUrl}/tables/${TABLE_NAME}/records`;

        let added = 0;
        let skipped = 0;
        let errors = [];

        for (const record of records) {
            if (!record.ID_Customer || !record.CompanyName) {
                skipped++;
                continue;
            }

            // Check if already exists
            const existing = await fetchAllCaspioPages(`/tables/${TABLE_NAME}/records`, {
                'q.where': `ID_Customer=${record.ID_Customer}`,
                'q.limit': 1
            });

            if (existing.length > 0) {
                skipped++;
                continue;
            }

            try {
                await axios({
                    method: 'post',
                    url: url,
                    headers: {
                        'Authorization': `Bearer ${token}`,
                        'Content-Type': 'application/json'
                    },
                    data: record,
                    timeout: 10000
                });
                added++;
            } catch (addError) {
                errors.push({ ID_Customer: record.ID_Customer, error: addError.message });
            }
        }

        res.json({
            success: true,
            message: `Bulk add complete: ${added} added, ${skipped} skipped`,
            added,
            skipped,
            errors: errors.length > 0 ? errors : undefined
        });
    } catch (error) {
        console.error('Error bulk adding sales reps 2026:', error.message);
        res.status(500).json({ success: false, error: 'Failed to bulk add records' });
    }
});

module.exports = router;
