// Garment Tracker CRUD Routes - GarmentTracker table
// Endpoints for pre-processed garment tracking data (staff dashboard optimization)
// Also includes archive endpoints for GarmentTrackerArchive (quarterly historical data)

const express = require('express');
const axios = require('axios');
const router = express.Router();
const config = require('../../config');
const { getCaspioAccessToken, fetchAllCaspioPages } = require('../utils/caspio');
const { fetchOrders } = require('../utils/manageorders');

const caspioApiBaseUrl = config.caspio.apiBaseUrl;
const TABLE_NAME = 'GarmentTracker';
const ARCHIVE_TABLE_NAME = 'GarmentTrackerArchive';

// Premium items that qualify for bonuses (from staff-dashboard-init.js)
const PREMIUM_ITEMS = {
    'CT104670': { name: 'Carhartt Firm Duck Vest', bonus: 5 },
    'EB550': { name: 'Eddie Bauer Down Jacket', bonus: 5 },
    'CT103828': { name: 'Carhartt Thermal Hoodie', bonus: 3 },
    'CT102286': { name: 'Carhartt Acrylic Beanie', bonus: 2 },
    'NF0A52S7': { name: 'North Face High Loft Beanie', bonus: 2 }
};

// Richardson cap styles (from staff-dashboard-init.js) - $0.50 bonus each
const RICHARDSON_CAPS = [
    '110', '112', '111', '115', '172', '212', '220', '256', '312',
    '325', '326', '435', '511', '514', '514J', '840', '842', '870'
];

/**
 * Helper to determine quarter from date
 * @param {Date|string} date - Date to check
 * @returns {Object} { quarter: "2026-Q1", year: 2026 }
 */
function getQuarterFromDate(date) {
    const d = new Date(date);
    const year = d.getFullYear();
    const month = d.getMonth(); // 0-11
    const q = Math.floor(month / 3) + 1;
    return {
        quarter: `${year}-Q${q}`,
        year: year
    };
}

/**
 * Check if a part number is a premium item
 */
function getPremiumItem(partNumber) {
    return PREMIUM_ITEMS[partNumber] || null;
}

/**
 * Check if a part number is a Richardson cap
 */
function isRichardsonCap(partNumber) {
    return RICHARDSON_CAPS.includes(partNumber);
}

/**
 * Calculate bonus for an item
 */
function calculateBonus(partNumber, quantity) {
    const premium = getPremiumItem(partNumber);
    if (premium) {
        return premium.bonus * quantity;
    }
    if (isRichardsonCap(partNumber)) {
        return 0.50 * quantity;
    }
    return 0;
}

/**
 * Determine style category
 */
function getStyleCategory(partNumber) {
    if (getPremiumItem(partNumber)) return 'Premium';
    if (isRichardsonCap(partNumber)) return 'Richardson';
    return 'Other';
}

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

// ============================================================================
// ARCHIVE ENDPOINTS - GarmentTrackerArchive table
// IMPORTANT: These must be defined BEFORE /:id routes to prevent "archive" being matched as an ID
// For permanent quarterly storage of garment tracking data
// ============================================================================

// GET /api/garment-tracker/archive - Query archived garment data
// Supports: year, quarter, rep filters
// Examples:
//   GET /api/garment-tracker/archive?year=2026
//   GET /api/garment-tracker/archive?quarter=2026-Q1
//   GET /api/garment-tracker/archive?rep=Nika Lao&year=2026
router.get('/garment-tracker/archive', async (req, res) => {
    try {
        const { year, quarter, rep } = req.query;
        console.log(`[GarmentArchive] Querying with year=${year}, quarter=${quarter}, rep=${rep}`);

        const resource = `/tables/${ARCHIVE_TABLE_NAME}/records`;
        const whereClauses = [];

        if (year) {
            whereClauses.push(`Year=${year}`);
        }
        if (quarter) {
            whereClauses.push(`Quarter='${quarter}'`);
        }
        if (rep) {
            const escapedRep = rep.replace(/'/g, "''");
            whereClauses.push(`RepName='${escapedRep}'`);
        }

        const params = {
            'q.orderBy': 'DateInvoiced DESC'
        };
        if (whereClauses.length > 0) {
            params['q.where'] = whereClauses.join(' AND ');
        }

        const result = await fetchAllCaspioPages(resource, params);
        console.log(`[GarmentArchive] Found ${result.length} archived records`);

        res.json({
            success: true,
            count: result.length,
            records: result
        });
    } catch (error) {
        console.error('[GarmentArchive] Error fetching archive:', error.message);
        if (error.message.includes('404') || error.message.includes('not found')) {
            return res.status(404).json({
                success: false,
                error: 'GarmentTrackerArchive table not found',
                message: 'Please create the GarmentTrackerArchive table in Caspio first'
            });
        }
        res.status(500).json({ success: false, error: 'Failed to fetch archive' });
    }
});

// GET /api/garment-tracker/archive/summary - Get aggregated summary by rep/quarter
// Returns totals per rep per quarter for easy reporting
router.get('/garment-tracker/archive/summary', async (req, res) => {
    try {
        const { year, quarter, rep } = req.query;
        console.log(`[GarmentArchive] Summary query: year=${year}, quarter=${quarter}, rep=${rep}`);

        const resource = `/tables/${ARCHIVE_TABLE_NAME}/records`;
        const whereClauses = [];

        if (year) {
            whereClauses.push(`Year=${year}`);
        }
        if (quarter) {
            whereClauses.push(`Quarter='${quarter}'`);
        }
        if (rep) {
            const escapedRep = rep.replace(/'/g, "''");
            whereClauses.push(`RepName='${escapedRep}'`);
        }

        const params = {};
        if (whereClauses.length > 0) {
            params['q.where'] = whereClauses.join(' AND ');
        }

        const records = await fetchAllCaspioPages(resource, params);

        // Aggregate by rep + quarter
        const summary = {};
        for (const record of records) {
            const key = `${record.RepName}|${record.Quarter}`;
            if (!summary[key]) {
                summary[key] = {
                    repName: record.RepName,
                    quarter: record.Quarter,
                    year: record.Year,
                    totalQuantity: 0,
                    totalBonus: 0,
                    orderCount: new Set(),
                    premiumCount: 0,
                    richardsonCount: 0
                };
            }
            summary[key].totalQuantity += record.Quantity || 0;
            summary[key].totalBonus += record.BonusAmount || 0;
            summary[key].orderCount.add(record.OrderNumber);
            if (record.StyleCategory === 'Premium') {
                summary[key].premiumCount += record.Quantity || 0;
            } else if (record.StyleCategory === 'Richardson') {
                summary[key].richardsonCount += record.Quantity || 0;
            }
        }

        // Convert to array and finalize
        const result = Object.values(summary).map(s => ({
            repName: s.repName,
            quarter: s.quarter,
            year: s.year,
            totalQuantity: s.totalQuantity,
            totalBonus: Math.round(s.totalBonus * 100) / 100,
            orderCount: s.orderCount.size,
            premiumCount: s.premiumCount,
            richardsonCount: s.richardsonCount
        }));

        // Sort by year desc, quarter desc, rep name
        result.sort((a, b) => {
            if (a.year !== b.year) return b.year - a.year;
            if (a.quarter !== b.quarter) return b.quarter.localeCompare(a.quarter);
            return a.repName.localeCompare(b.repName);
        });

        console.log(`[GarmentArchive] Summary: ${result.length} rep-quarter combinations`);

        res.json({
            success: true,
            count: result.length,
            summary: result
        });
    } catch (error) {
        console.error('[GarmentArchive] Error generating summary:', error.message);
        res.status(500).json({ success: false, error: 'Failed to generate summary' });
    }
});

// POST /api/garment-tracker/archive-from-live - Archive from current GarmentTracker table
// Copies records from GarmentTracker to GarmentTrackerArchive
// Body: { startDate, endDate } (optional - defaults to all records)
router.post('/garment-tracker/archive-from-live', express.json(), async (req, res) => {
    try {
        const { startDate, endDate } = req.body;
        console.log(`[GarmentArchive] Archiving from live table: ${startDate || 'all'} to ${endDate || 'all'}`);

        // Fetch from live GarmentTracker table
        const resource = `/tables/${TABLE_NAME}/records`;
        const params = { 'q.orderBy': 'DateInvoiced ASC' };

        const whereClauses = [];
        if (startDate) {
            whereClauses.push(`DateInvoiced>='${startDate}'`);
        }
        if (endDate) {
            whereClauses.push(`DateInvoiced<='${endDate}'`);
        }
        if (whereClauses.length > 0) {
            params['q.where'] = whereClauses.join(' AND ');
        }

        const liveRecords = await fetchAllCaspioPages(resource, params);
        console.log(`[GarmentArchive] Found ${liveRecords.length} live records to archive`);

        if (liveRecords.length === 0) {
            return res.json({
                success: true,
                message: 'No records to archive',
                created: 0,
                updated: 0
            });
        }

        const token = await getCaspioAccessToken();
        let created = 0;
        let updated = 0;
        const errors = [];

        for (const record of liveRecords) {
            try {
                const quarterInfo = getQuarterFromDate(record.DateInvoiced);

                // Check if record exists in archive
                const escapedPart = String(record.PartNumber).replace(/'/g, "''");
                const whereClause = `OrderNumber=${record.OrderNumber} AND PartNumber='${escapedPart}'`;
                const checkUrl = `${caspioApiBaseUrl}/tables/${ARCHIVE_TABLE_NAME}/records?q.where=${encodeURIComponent(whereClause)}&q.limit=1`;

                const checkResponse = await axios({
                    method: 'get',
                    url: checkUrl,
                    headers: { 'Authorization': `Bearer ${token}` },
                    timeout: 15000
                });

                const existing = checkResponse.data?.Result || [];

                const archiveData = {
                    OrderNumber: record.OrderNumber,
                    DateInvoiced: record.DateInvoiced,
                    Quarter: quarterInfo.quarter,
                    Year: quarterInfo.year,
                    RepName: record.RepName,
                    PartNumber: record.PartNumber,
                    StyleCategory: record.StyleCategory,
                    Quantity: record.Quantity,
                    BonusAmount: record.BonusAmount,
                    ArchivedAt: new Date().toISOString()
                };

                if (existing.length > 0) {
                    // Update existing
                    const updateUrl = `${caspioApiBaseUrl}/tables/${ARCHIVE_TABLE_NAME}/records?q.where=${encodeURIComponent(whereClause)}`;
                    await axios({
                        method: 'put',
                        url: updateUrl,
                        headers: {
                            'Authorization': `Bearer ${token}`,
                            'Content-Type': 'application/json'
                        },
                        data: archiveData,
                        timeout: 15000
                    });
                    updated++;
                } else {
                    // Create new
                    const createUrl = `${caspioApiBaseUrl}/tables/${ARCHIVE_TABLE_NAME}/records`;
                    await axios({
                        method: 'post',
                        url: createUrl,
                        headers: {
                            'Authorization': `Bearer ${token}`,
                            'Content-Type': 'application/json'
                        },
                        data: archiveData,
                        timeout: 15000
                    });
                    created++;
                }
            } catch (err) {
                errors.push({
                    orderNumber: record.OrderNumber,
                    partNumber: record.PartNumber,
                    error: err.message
                });
            }
        }

        console.log(`[GarmentArchive] Archive complete: ${created} created, ${updated} updated, ${errors.length} errors`);

        res.json({
            success: errors.length === 0,
            message: 'Archive from live table complete',
            created,
            updated,
            errors: errors.length > 0 ? errors : undefined
        });
    } catch (error) {
        console.error('[GarmentArchive] Error archiving from live:', error.message);
        res.status(500).json({ success: false, error: 'Failed to archive from live table' });
    }
});

// POST /api/garment-tracker/archive-range - Archive date range directly from ManageOrders
// For backfilling or re-archiving specific date ranges
// Body: { start: "YYYY-MM-DD", end: "YYYY-MM-DD" }
router.post('/garment-tracker/archive-range', express.json(), async (req, res) => {
    try {
        const { start, end } = req.body;

        if (!start || !end) {
            return res.status(400).json({
                success: false,
                error: 'Missing required fields: start, end',
                example: '{ "start": "2026-01-01", "end": "2026-01-31" }'
            });
        }

        // Validate dates are within 60-day window
        const sixtyDaysAgo = new Date();
        sixtyDaysAgo.setDate(sixtyDaysAgo.getDate() - 60);
        const startDate = new Date(start);

        if (startDate < sixtyDaysAgo) {
            return res.status(400).json({
                success: false,
                error: `Start date ${start} is beyond ManageOrders 60-day window`,
                message: 'Use /archive-from-live to archive existing GarmentTracker data, or /import for manual data entry'
            });
        }

        console.log(`[GarmentArchive] Archiving range ${start} to ${end} from ManageOrders`);

        // Fetch orders from ManageOrders
        const orders = await fetchOrders({
            date_Invoiced_start: start,
            date_Invoiced_end: end
        });

        console.log(`[GarmentArchive] Fetched ${orders.length} orders from ManageOrders`);

        // Process orders to find qualifying garments
        const garmentRecords = [];
        const processedOrderParts = new Set();

        for (const order of orders) {
            const repName = order.CustomerServiceRep;
            if (!repName) continue;

            // Check each premium item and Richardson caps
            const allParts = [...Object.keys(PREMIUM_ITEMS), ...RICHARDSON_CAPS];

            for (const partNum of allParts) {
                // ManageOrders stores quantities in Part01, Part02, etc. fields
                // We need to check if this part number exists in the order
                const partFields = ['Part01', 'Part02', 'Part03', 'Part04', 'Part05', 'Part06', 'Part07', 'Part08', 'Part09', 'Part10'];
                const qtyFields = ['Qty01', 'Qty02', 'Qty03', 'Qty04', 'Qty05', 'Qty06', 'Qty07', 'Qty08', 'Qty09', 'Qty10'];

                let totalQty = 0;
                for (let i = 0; i < partFields.length; i++) {
                    if (order[partFields[i]] === partNum) {
                        totalQty += parseInt(order[qtyFields[i]]) || 0;
                    }
                }

                if (totalQty > 0) {
                    const key = `${order.OrderNo}-${partNum}`;
                    if (!processedOrderParts.has(key)) {
                        processedOrderParts.add(key);

                        const quarterInfo = getQuarterFromDate(order.date_Invoiced);
                        const bonus = calculateBonus(partNum, totalQty);
                        const category = getStyleCategory(partNum);

                        garmentRecords.push({
                            OrderNumber: order.OrderNo,
                            DateInvoiced: order.date_Invoiced.split('T')[0],
                            Quarter: quarterInfo.quarter,
                            Year: quarterInfo.year,
                            RepName: repName,
                            PartNumber: partNum,
                            StyleCategory: category,
                            Quantity: totalQty,
                            BonusAmount: bonus
                        });
                    }
                }
            }
        }

        console.log(`[GarmentArchive] Found ${garmentRecords.length} garment records to archive`);

        if (garmentRecords.length === 0) {
            return res.json({
                success: true,
                message: 'No qualifying garment records found in date range',
                created: 0,
                updated: 0
            });
        }

        // Upsert to archive table
        const token = await getCaspioAccessToken();
        let created = 0;
        let updated = 0;
        const errors = [];

        for (const record of garmentRecords) {
            try {
                const escapedPart = String(record.PartNumber).replace(/'/g, "''");
                const whereClause = `OrderNumber=${record.OrderNumber} AND PartNumber='${escapedPart}'`;
                const checkUrl = `${caspioApiBaseUrl}/tables/${ARCHIVE_TABLE_NAME}/records?q.where=${encodeURIComponent(whereClause)}&q.limit=1`;

                const checkResponse = await axios({
                    method: 'get',
                    url: checkUrl,
                    headers: { 'Authorization': `Bearer ${token}` },
                    timeout: 15000
                });

                const existing = checkResponse.data?.Result || [];
                record.ArchivedAt = new Date().toISOString();

                if (existing.length > 0) {
                    const updateUrl = `${caspioApiBaseUrl}/tables/${ARCHIVE_TABLE_NAME}/records?q.where=${encodeURIComponent(whereClause)}`;
                    await axios({
                        method: 'put',
                        url: updateUrl,
                        headers: {
                            'Authorization': `Bearer ${token}`,
                            'Content-Type': 'application/json'
                        },
                        data: record,
                        timeout: 15000
                    });
                    updated++;
                } else {
                    const createUrl = `${caspioApiBaseUrl}/tables/${ARCHIVE_TABLE_NAME}/records`;
                    await axios({
                        method: 'post',
                        url: createUrl,
                        headers: {
                            'Authorization': `Bearer ${token}`,
                            'Content-Type': 'application/json'
                        },
                        data: record,
                        timeout: 15000
                    });
                    created++;
                }
            } catch (err) {
                errors.push({
                    orderNumber: record.OrderNumber,
                    partNumber: record.PartNumber,
                    error: err.message
                });
            }
        }

        console.log(`[GarmentArchive] Archive range complete: ${created} created, ${updated} updated`);

        res.json({
            success: errors.length === 0,
            message: `Archived ${start} to ${end}`,
            recordsProcessed: garmentRecords.length,
            created,
            updated,
            errors: errors.length > 0 ? errors : undefined
        });
    } catch (error) {
        console.error('[GarmentArchive] Error archiving range:', error.message);
        res.status(500).json({ success: false, error: 'Failed to archive date range' });
    }
});

// POST /api/garment-tracker/import - Manual import for historical data (>60 days)
// For correcting data that's beyond ManageOrders retention
// Body: { data: [{ orderNumber, dateInvoiced, rep, partNumber, quantity }, ...] }
router.post('/garment-tracker/import', express.json(), async (req, res) => {
    try {
        const { data } = req.body;

        if (!data || !Array.isArray(data) || data.length === 0) {
            return res.status(400).json({
                success: false,
                error: 'Missing or invalid data array',
                example: '{ "data": [{ "orderNumber": 12345, "dateInvoiced": "2025-11-15", "rep": "Nika Lao", "partNumber": "CT104670", "quantity": 5 }] }'
            });
        }

        console.log(`[GarmentArchive] Importing ${data.length} records manually`);

        const token = await getCaspioAccessToken();
        let created = 0;
        let updated = 0;
        const errors = [];

        for (const item of data) {
            try {
                if (!item.orderNumber || !item.partNumber || !item.dateInvoiced || !item.rep) {
                    errors.push({ item, error: 'Missing required fields (orderNumber, partNumber, dateInvoiced, rep)' });
                    continue;
                }

                const quarterInfo = getQuarterFromDate(item.dateInvoiced);
                const quantity = item.quantity || 1;
                const bonus = calculateBonus(item.partNumber, quantity);
                const category = getStyleCategory(item.partNumber);

                const archiveData = {
                    OrderNumber: item.orderNumber,
                    DateInvoiced: item.dateInvoiced,
                    Quarter: quarterInfo.quarter,
                    Year: quarterInfo.year,
                    RepName: item.rep,
                    PartNumber: item.partNumber,
                    StyleCategory: category,
                    Quantity: quantity,
                    BonusAmount: bonus,
                    ArchivedAt: new Date().toISOString()
                };

                const escapedPart = String(item.partNumber).replace(/'/g, "''");
                const whereClause = `OrderNumber=${item.orderNumber} AND PartNumber='${escapedPart}'`;
                const checkUrl = `${caspioApiBaseUrl}/tables/${ARCHIVE_TABLE_NAME}/records?q.where=${encodeURIComponent(whereClause)}&q.limit=1`;

                const checkResponse = await axios({
                    method: 'get',
                    url: checkUrl,
                    headers: { 'Authorization': `Bearer ${token}` },
                    timeout: 15000
                });

                const existing = checkResponse.data?.Result || [];

                if (existing.length > 0) {
                    const updateUrl = `${caspioApiBaseUrl}/tables/${ARCHIVE_TABLE_NAME}/records?q.where=${encodeURIComponent(whereClause)}`;
                    await axios({
                        method: 'put',
                        url: updateUrl,
                        headers: {
                            'Authorization': `Bearer ${token}`,
                            'Content-Type': 'application/json'
                        },
                        data: archiveData,
                        timeout: 15000
                    });
                    updated++;
                } else {
                    const createUrl = `${caspioApiBaseUrl}/tables/${ARCHIVE_TABLE_NAME}/records`;
                    await axios({
                        method: 'post',
                        url: createUrl,
                        headers: {
                            'Authorization': `Bearer ${token}`,
                            'Content-Type': 'application/json'
                        },
                        data: archiveData,
                        timeout: 15000
                    });
                    created++;
                }
            } catch (err) {
                errors.push({
                    orderNumber: item.orderNumber,
                    partNumber: item.partNumber,
                    error: err.message
                });
            }
        }

        console.log(`[GarmentArchive] Import complete: ${created} created, ${updated} updated, ${errors.length} errors`);

        res.json({
            success: errors.length === 0,
            message: 'Manual import complete',
            created,
            updated,
            errors: errors.length > 0 ? errors : undefined
        });
    } catch (error) {
        console.error('[GarmentArchive] Error importing:', error.message);
        res.status(500).json({ success: false, error: 'Failed to import data' });
    }
});

// ============================================================================
// LIVE TABLE CRUD ENDPOINTS (/:id routes must be AFTER /archive routes)
// ============================================================================

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

// POST /api/garment-tracker - Create or update record (UPSERT)
// Checks if OrderNumber + PartNumber already exists. If so, updates; otherwise creates.
// Body: { OrderNumber, DateInvoiced, RepName, CustomerName, CompanyName, PartNumber, StyleCategory, Quantity, BonusAmount, TrackedAt }
router.post('/garment-tracker', express.json(), async (req, res) => {
    try {
        const requestData = { ...req.body };

        // Validate required fields (both needed for uniqueness check)
        if (!requestData.OrderNumber) {
            return res.status(400).json({ success: false, error: 'Missing required field: OrderNumber' });
        }
        if (!requestData.PartNumber) {
            return res.status(400).json({ success: false, error: 'Missing required field: PartNumber' });
        }

        const token = await getCaspioAccessToken();

        // Check if record already exists (OrderNumber + PartNumber combination)
        const escapedPartNumber = String(requestData.PartNumber).replace(/'/g, "''");
        const whereClause = `OrderNumber=${requestData.OrderNumber} AND PartNumber='${escapedPartNumber}'`;
        const checkUrl = `${caspioApiBaseUrl}/tables/${TABLE_NAME}/records?q.where=${encodeURIComponent(whereClause)}&q.limit=1`;

        console.log(`[GarmentTracker] Checking for existing: Order=${requestData.OrderNumber}, Part=${requestData.PartNumber}`);

        const checkResponse = await axios({
            method: 'get',
            url: checkUrl,
            headers: { 'Authorization': `Bearer ${token}` },
            timeout: 15000
        });

        const existingRecords = checkResponse.data?.Result || [];

        if (existingRecords.length > 0) {
            // UPDATE existing record
            const existingId = existingRecords[0].ID_Garment;
            console.log(`[GarmentTracker] Record exists (ID=${existingId}), updating...`);

            // Update TrackedAt to current time
            requestData.TrackedAt = new Date().toISOString();

            const updateUrl = `${caspioApiBaseUrl}/tables/${TABLE_NAME}/records?q.where=ID_Garment=${existingId}`;
            await axios({
                method: 'put',
                url: updateUrl,
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'Content-Type': 'application/json'
                },
                data: requestData,
                timeout: 15000
            });

            return res.status(200).json({
                success: true,
                action: 'updated',
                ID_Garment: existingId,
                record: { ID_Garment: existingId, ...requestData }
            });
        }

        // CREATE new record
        console.log(`[GarmentTracker] Creating new record for Order=${requestData.OrderNumber}, Part=${requestData.PartNumber}`);

        // Auto-set TrackedAt if not provided
        if (!requestData.TrackedAt) {
            requestData.TrackedAt = new Date().toISOString();
        }

        const createUrl = `${caspioApiBaseUrl}/tables/${TABLE_NAME}/records`;
        const response = await axios({
            method: 'post',
            url: createUrl,
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

        console.log(`[GarmentTracker] Created new record with ID_Garment: ${newId}`);

        res.status(201).json({
            success: true,
            action: 'created',
            ID_Garment: newId,
            record: { ID_Garment: newId, ...requestData }
        });
    } catch (error) {
        console.error('[GarmentTracker] Error creating/updating record:',
            error.response ? JSON.stringify(error.response.data) : error.message);
        res.status(500).json({ success: false, error: 'Failed to create/update record' });
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
