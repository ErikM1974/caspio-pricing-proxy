// Assignment History Routes - Account_Assignment_History table
// Tracks all account assignment changes for audit trail

const express = require('express');
const axios = require('axios');
const router = express.Router();
const config = require('../../config');
const { getCaspioAccessToken, fetchAllCaspioPages } = require('../utils/caspio');

const caspioApiBaseUrl = config.caspio.apiBaseUrl;
const TABLE_NAME = 'Account_Assignment_History';

// Valid action types
const ACTION_TYPES = ['ASSIGNED', 'REASSIGNED', 'REMOVED'];
// Valid change sources
const CHANGE_SOURCES = ['RECONCILE', 'CRM_MANUAL', 'SYNC', 'ADMIN'];

// GET /api/assignment-history - Query assignment history
// Query params:
//   - customerId: Filter by specific customer
//   - limit: Max records to return (default 100)
//   - offset: Pagination offset
router.get('/assignment-history', async (req, res) => {
    try {
        const { customerId, limit = 100, offset = 0 } = req.query;
        console.log('Fetching assignment history:', { customerId, limit, offset });

        const resource = `/tables/${TABLE_NAME}/records`;
        const params = {
            'q.orderBy': 'Action_Date DESC',
            'q.limit': Math.min(parseInt(limit) || 100, 500),
            'q.skip': parseInt(offset) || 0
        };

        if (customerId) {
            params['q.where'] = `Customer_ID=${customerId}`;
        }

        const records = await fetchAllCaspioPages(resource, params);
        console.log(`Found ${records.length} assignment history records`);

        res.json({
            success: true,
            count: records.length,
            records: records
        });
    } catch (error) {
        console.error('Error fetching assignment history:', error.message);
        res.status(500).json({ success: false, error: 'Failed to fetch assignment history' });
    }
});

// POST /api/assignment-history - Log a new assignment action
router.post('/assignment-history', express.json(), async (req, res) => {
    try {
        const {
            customerId,
            customerName,
            previousRep,
            newRep,
            actionType,
            changedBy,
            changeSource,
            notes,
            relatedOrders
        } = req.body;

        // Validate required fields
        if (!customerId) {
            return res.status(400).json({ success: false, error: 'Missing required field: customerId' });
        }
        if (!newRep) {
            return res.status(400).json({ success: false, error: 'Missing required field: newRep' });
        }
        if (!actionType) {
            return res.status(400).json({ success: false, error: 'Missing required field: actionType' });
        }

        // Validate action type
        if (!ACTION_TYPES.includes(actionType)) {
            return res.status(400).json({
                success: false,
                error: `Invalid actionType. Must be one of: ${ACTION_TYPES.join(', ')}`
            });
        }

        // Validate change source if provided
        if (changeSource && !CHANGE_SOURCES.includes(changeSource)) {
            return res.status(400).json({
                success: false,
                error: `Invalid changeSource. Must be one of: ${CHANGE_SOURCES.join(', ')}`
            });
        }

        console.log(`Logging assignment history: Customer ${customerId} -> ${newRep} (${actionType})`);

        const token = await getCaspioAccessToken();
        const url = `${caspioApiBaseUrl}/tables/${TABLE_NAME}/records`;

        const historyRecord = {
            Action_Date: new Date().toISOString(),
            Action_Type: actionType,
            Customer_ID: customerId,
            Customer_Name: customerName || `Customer ${customerId}`,
            Previous_Rep: previousRep || 'Unassigned',
            New_Rep: newRep,
            Changed_By: changedBy || 'System',
            Change_Source: changeSource || 'RECONCILE',
            Notes: notes || '',
            Related_Orders: relatedOrders || ''
        };

        await axios({
            method: 'post',
            url: url,
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json'
            },
            data: historyRecord,
            timeout: 15000
        });

        console.log(`Assignment history logged for customer ${customerId}`);

        res.status(201).json({
            success: true,
            message: 'Assignment history logged successfully',
            record: historyRecord
        });
    } catch (error) {
        console.error('Error logging assignment history:',
            error.response ? JSON.stringify(error.response.data) : error.message);
        res.status(500).json({ success: false, error: 'Failed to log assignment history' });
    }
});

// GET /api/assignment-history/recent - Get recent assignment activity
// Returns last N assignments across all customers
router.get('/assignment-history/recent', async (req, res) => {
    try {
        const { limit = 50 } = req.query;
        console.log(`Fetching ${limit} most recent assignment changes...`);

        const resource = `/tables/${TABLE_NAME}/records`;
        const params = {
            'q.orderBy': 'Action_Date DESC',
            'q.limit': Math.min(parseInt(limit) || 50, 200)
        };

        const records = await fetchAllCaspioPages(resource, params);

        res.json({
            success: true,
            count: records.length,
            records: records
        });
    } catch (error) {
        console.error('Error fetching recent assignments:', error.message);
        res.status(500).json({ success: false, error: 'Failed to fetch recent assignments' });
    }
});

// ── ShopWorks To-Do (2026-07-19) ─────────────────────────────────────────
// ShopWorks has NO write-back path (Erik keys CustomerServiceRep by hand), so
// every dashboard-made assignment is provisional until ShopWorks matches. The
// contract: dashboard flows log a history row (RECONCILE/CRM_MANUAL/ADMIN);
// when the bandit ODBC agent later posts that customer (Erik's ShopWorks edit
// triggers it within ~15 min), sync-sales-reps logs a SYNC row — confirmed if
// the rep matches, a ⚠ REVERT row if ShopWorks says someone else. The to-do =
// per customer, latest row is still a dashboard row.

const TODO_WINDOW_DAYS = 90;

/** Direct table write for system rows (bypasses the POST route's validation —
 *  used by the ODBC sync to log SYNC confirm/revert outcomes). */
async function logAssignmentRow(record) {
    const token = await getCaspioAccessToken();
    await axios.post(`${caspioApiBaseUrl}/tables/${TABLE_NAME}/records`, {
        Action_Date: new Date().toISOString(),
        Action_Type: 'REASSIGNED',
        Changed_By: 'System',
        Change_Source: 'SYNC',
        Notes: '',
        Related_Orders: '',
        ...record,
    }, { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, timeout: 15000 });
}

/** Latest history row per customer over the window → pending / reverted lists. */
async function computeShopWorksTodo() {
    const since = new Date(Date.now() - TODO_WINDOW_DAYS * 86400000).toISOString();
    const records = await fetchAllCaspioPages(`/tables/${TABLE_NAME}/records`, {
        'q.where': `Action_Date>='${since}'`,
        'q.orderBy': 'Action_Date DESC, PK_ID DESC',
        'q.pageSize': 500,
    }, { maxPages: 4 });

    const latestByCustomer = new Map();
    for (const r of records) {
        const key = String(r.Customer_ID);
        if (!latestByCustomer.has(key)) latestByCustomer.set(key, r);
    }

    const pending = [], reverted = [];
    for (const r of latestByCustomer.values()) {
        const item = {
            customerId: r.Customer_ID,
            customerName: r.Customer_Name,
            previousRep: r.Previous_Rep,
            newRep: r.New_Rep,
            actionDate: r.Action_Date,
            changedBy: r.Changed_By,
            source: r.Change_Source,
            notes: r.Notes || '',
        };
        if (r.Change_Source !== 'SYNC') pending.push(item);
        else if (String(r.Notes || '').startsWith('⚠')) reverted.push(item);
    }
    pending.sort((a, b) => String(a.actionDate).localeCompare(String(b.actionDate)));
    return { pending, reverted, windowDays: TODO_WINDOW_DAYS };
}

// GET /api/assignment-history/shopworks-todo — the manual-keying checklist.
router.get('/assignment-history/shopworks-todo', async (req, res) => {
    try {
        const todo = await computeShopWorksTodo();
        res.json({ success: true, ...todo });
    } catch (error) {
        console.error('Error computing ShopWorks to-do:', error.message);
        res.status(500).json({ success: false, error: 'Failed to compute ShopWorks to-do' });
    }
});

// GET /api/assignment-history/stats - Get assignment statistics
router.get('/assignment-history/stats', async (req, res) => {
    try {
        console.log('Fetching assignment history statistics...');

        const resource = `/tables/${TABLE_NAME}/records`;
        const records = await fetchAllCaspioPages(resource, {});

        // Aggregate stats
        const stats = {
            total: records.length,
            byActionType: {},
            byChangeSource: {},
            byRep: {},
            last30Days: 0
        };

        const thirtyDaysAgo = new Date();
        thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

        records.forEach(record => {
            // By action type
            const action = record.Action_Type || 'Unknown';
            stats.byActionType[action] = (stats.byActionType[action] || 0) + 1;

            // By change source
            const source = record.Change_Source || 'Unknown';
            stats.byChangeSource[source] = (stats.byChangeSource[source] || 0) + 1;

            // By new rep
            const rep = record.New_Rep || 'Unknown';
            stats.byRep[rep] = (stats.byRep[rep] || 0) + 1;

            // Last 30 days
            if (record.Action_Date && new Date(record.Action_Date) >= thirtyDaysAgo) {
                stats.last30Days++;
            }
        });

        res.json({
            success: true,
            stats: stats
        });
    } catch (error) {
        console.error('Error fetching assignment stats:', error.message);
        res.status(500).json({ success: false, error: 'Failed to fetch assignment statistics' });
    }
});

module.exports = router;
// In-process reuse: shopworks-odbc-sync.js logs SYNC confirm/revert outcomes
// against pending dashboard assignments (router is a function object).
module.exports.helpers = { computeShopWorksTodo, logAssignmentRow };
