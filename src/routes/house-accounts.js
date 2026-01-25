// House Accounts CRUD Routes - House_Accounts table
// Endpoints for managing non-sales-rep customers (Ruthie, House, Erik, Jim, Web, etc.)
// These are catch-all accounts that shouldn't show as "unassigned" in rep audits

const express = require('express');
const axios = require('axios');
const router = express.Router();
const config = require('../../config');
const { getCaspioAccessToken, fetchAllCaspioPages } = require('../utils/caspio');

const caspioApiBaseUrl = config.caspio.apiBaseUrl;
const TABLE_NAME = 'House_Accounts';
const PRIMARY_KEY = 'ID_Customer';

// Valid "Assigned_To" values for reference
const VALID_ASSIGNEES = ['Ruthie', 'House', 'Erik', 'Jim', 'Web', 'Other'];

// GET /api/house-accounts - List all house accounts with optional filters
router.get('/house-accounts', async (req, res) => {
    try {
        console.log('Fetching house accounts with filters:', req.query);
        const resource = `/tables/${TABLE_NAME}/records`;
        const params = {};
        const whereConditions = [];

        // Filter by assigned person
        if (req.query.assignedTo) {
            whereConditions.push(`Assigned_To='${req.query.assignedTo}'`);
        }

        // Filter by reviewed status
        if (req.query.reviewed !== undefined) {
            const reviewedVal = req.query.reviewed === '1' || req.query.reviewed === 'true' ? 1 : 0;
            whereConditions.push(`Reviewed=${reviewedVal}`);
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
        console.log(`Found ${result.length} house account records`);

        res.json({
            success: true,
            count: result.length,
            accounts: result
        });
    } catch (error) {
        console.error('Error fetching house accounts:', error.message);
        res.status(500).json({ success: false, error: 'Failed to fetch house accounts' });
    }
});

// GET /api/house-accounts/stats - Get summary statistics
router.get('/house-accounts/stats', async (req, res) => {
    try {
        console.log('Fetching house accounts statistics...');
        const resource = `/tables/${TABLE_NAME}/records`;

        const accounts = await fetchAllCaspioPages(resource, {});

        // Aggregate by Assigned_To
        const byAssignee = {};
        let reviewedCount = 0;
        let unreviewedCount = 0;

        accounts.forEach(account => {
            const assignee = account.Assigned_To || 'Unassigned';
            byAssignee[assignee] = (byAssignee[assignee] || 0) + 1;

            if (account.Reviewed) {
                reviewedCount++;
            } else {
                unreviewedCount++;
            }
        });

        res.json({
            success: true,
            total: accounts.length,
            reviewed: reviewedCount,
            unreviewed: unreviewedCount,
            byAssignee: byAssignee
        });
    } catch (error) {
        console.error('Error fetching house accounts stats:', error.message);
        res.status(500).json({ success: false, error: 'Failed to fetch statistics' });
    }
});

// GET /api/house-accounts/sales - Calculate YTD sales for House Account customers
// Groups sales by Assigned_To field (Ruthie, Erik, Web, Jim, House)
// Uses ManageOrders data for orders where customer is in House_Accounts table
router.get('/house-accounts/sales', async (req, res) => {
    try {
        console.log('Calculating House Accounts YTD sales...');

        const { fetchOrders, getDateDaysAgo } = require('../utils/manageorders');

        // 1. Get all House Account customer IDs with their Assigned_To
        const accounts = await fetchAllCaspioPages(`/tables/${TABLE_NAME}/records`, {
            'q.select': 'ID_Customer,CompanyName,Assigned_To'
        });

        // Create map of customer ID -> Assigned_To
        const customerAssignee = new Map();
        accounts.forEach(account => {
            customerAssignee.set(account.ID_Customer, account.Assigned_To || 'House');
        });

        console.log(`Found ${accounts.length} House accounts to check`);

        // 2. Fetch 2026 orders from ManageOrders (last 60 days in chunks)
        let allOrders = [];
        for (let chunk = 0; chunk < 3; chunk++) {
            const chunkEnd = getDateDaysAgo(chunk * 20);
            const chunkStart = getDateDaysAgo((chunk + 1) * 20);
            try {
                const chunkOrders = await fetchOrders({
                    date_Invoiced_start: chunkStart,
                    date_Invoiced_end: chunkEnd
                });
                allOrders = allOrders.concat(chunkOrders);
            } catch (e) {
                console.warn(`Chunk ${chunk + 1} failed: ${e.message}`);
            }
        }

        console.log(`Fetched ${allOrders.length} orders to filter`);

        // 3. Calculate sales by Assigned_To
        const salesByAssignee = {
            'Ruthie': { revenue: 0, orderCount: 0 },
            'Erik': { revenue: 0, orderCount: 0 },
            'Web': { revenue: 0, orderCount: 0 },
            'Jim': { revenue: 0, orderCount: 0 },
            'House': { revenue: 0, orderCount: 0 },
            'Other': { revenue: 0, orderCount: 0 }
        };

        const currentYear = new Date().getFullYear();
        let totalRevenue = 0;
        let totalOrders = 0;

        allOrders.forEach(order => {
            const customerId = order.id_Customer;

            // Only count orders for House Account customers
            if (!customerAssignee.has(customerId)) return;

            // Only count current year invoiced orders
            const invoiceDate = new Date(order.date_Invoiced);
            if (invoiceDate.getFullYear() !== currentYear) return;

            const orderTotal = parseFloat(order.cur_SubTotal) || 0;
            const assignee = customerAssignee.get(customerId);

            // Map to known assignees or 'Other'
            if (salesByAssignee[assignee]) {
                salesByAssignee[assignee].revenue += orderTotal;
                salesByAssignee[assignee].orderCount += 1;
            } else {
                salesByAssignee['Other'].revenue += orderTotal;
                salesByAssignee['Other'].orderCount += 1;
            }

            totalRevenue += orderTotal;
            totalOrders += 1;
        });

        console.log(`House Accounts YTD: $${totalRevenue.toFixed(2)} from ${totalOrders} orders`);

        res.json({
            success: true,
            year: currentYear,
            totalRevenue,
            totalOrders,
            byAssignee: salesByAssignee,
            accountsTracked: accounts.length,
            ordersChecked: allOrders.length
        });

    } catch (error) {
        console.error('Error calculating House Accounts sales:', error.message);
        res.status(500).json({ success: false, error: 'Failed to calculate sales' });
    }
});

// GET /api/house-accounts/reconcile - Find customers with orders not in ANY account list
// NOW USES Sales_Reps_2026 (SOURCE OF TRUTH from ShopWorks) + House_Accounts
// Query params:
//   - autoAdd=true: Automatically add missing customers to House_Accounts
router.get('/house-accounts/reconcile', async (req, res) => {
    try {
        const autoAdd = req.query.autoAdd === 'true';
        console.log(`Reconciling all accounts (autoAdd: ${autoAdd})...`);

        const { fetchOrders, getDateDaysAgo } = require('../utils/manageorders');

        // Get all customer IDs from Sales_Reps_2026 (Nika + Taneisha) + House_Accounts
        const [salesRepsData, houseAccounts] = await Promise.all([
            fetchAllCaspioPages('/tables/Sales_Reps_2026/records', {
                'q.select': 'ID_Customer,CustomerServiceRep'
            }),
            fetchAllCaspioPages('/tables/House_Accounts/records', {
                'q.select': 'ID_Customer'
            })
        ]);

        // Count by rep for logging
        const nikaCount = salesRepsData.filter(a => a.CustomerServiceRep === 'Nika Lao').length;
        const taneishaCount = salesRepsData.filter(a => a.CustomerServiceRep === 'Taneisha Clark').length;
        const otherRepsCount = salesRepsData.length - nikaCount - taneishaCount;

        const allKnownIds = new Set([
            ...salesRepsData.map(a => a.ID_Customer),
            ...houseAccounts.map(a => a.ID_Customer)
        ]);

        console.log(`Found ${allKnownIds.size} total known customers`);
        console.log(`  - Sales_Reps_2026: ${salesRepsData.length} (Nika=${nikaCount}, Taneisha=${taneishaCount}, Other=${otherRepsCount})`);
        console.log(`  - House: ${houseAccounts.length}`);

        // Fetch recent orders from ManageOrders (last 60 days in 3 chunks)
        let allOrders = [];
        for (let chunk = 0; chunk < 3; chunk++) {
            const chunkEnd = getDateDaysAgo(chunk * 20);
            const chunkStart = getDateDaysAgo((chunk + 1) * 20);
            try {
                const chunkOrders = await fetchOrders({
                    date_Invoiced_start: chunkStart,
                    date_Invoiced_end: chunkEnd
                });
                allOrders = allOrders.concat(chunkOrders);
            } catch (e) {
                console.warn(`Chunk ${chunk + 1} failed: ${e.message}`);
            }
        }

        console.log(`Fetched ${allOrders.length} total orders from last 60 days`);

        // Find orders for customers NOT in any list
        const missingCustomers = new Map();

        allOrders.forEach(order => {
            if (!allKnownIds.has(order.id_Customer)) {
                if (!missingCustomers.has(order.id_Customer)) {
                    missingCustomers.set(order.id_Customer, {
                        ID_Customer: order.id_Customer,
                        // Use CustomerName if available, otherwise show ID as fallback
                        companyName: order.CustomerName || `ID: ${order.id_Customer}`,
                        rep: order.CustomerServiceRep || '',
                        orderCount: 0,
                        totalSales: 0,
                        lastOrderDate: null,
                        orders: []  // Array of individual order details
                    });
                }
                const cust = missingCustomers.get(order.id_Customer);
                cust.orderCount++;
                const orderAmount = parseFloat(order.cur_SubTotal) || 0;
                cust.totalSales += orderAmount;
                const orderDate = order.date_Invoiced?.split('T')[0];
                if (!cust.lastOrderDate || orderDate > cust.lastOrderDate) {
                    cust.lastOrderDate = orderDate;
                }
                // Add individual order details
                cust.orders.push({
                    orderNumber: order.Order_ID || order.id_Order || 'N/A',
                    amount: orderAmount,
                    date: orderDate,
                    rep: order.CustomerServiceRep || ''
                });
            }
        });

        // Sort orders within each customer by date (most recent first)
        missingCustomers.forEach(cust => {
            cust.orders.sort((a, b) => (b.date || '').localeCompare(a.date || ''));
        });

        const missingList = [...missingCustomers.values()].sort((a, b) => b.totalSales - a.totalSales);
        const totalMissingSales = missingList.reduce((sum, c) => sum + c.totalSales, 0);

        console.log(`Found ${missingList.length} customers with orders not in any account list`);

        // Auto-add if requested
        let addedCount = 0;
        if (autoAdd && missingList.length > 0) {
            const token = await getCaspioAccessToken();
            const today = new Date().toISOString().split('T')[0];

            for (const customer of missingList) {
                try {
                    // Intelligent Assigned_To based on rep field
                    let assignedTo = 'House';
                    const repLower = (customer.rep || '').toLowerCase();
                    if (repLower.includes('ruthie')) {
                        assignedTo = 'Ruthie';
                    } else if (repLower.includes('erik')) {
                        assignedTo = 'Erik';
                    } else if (!repLower || repLower === '') {
                        assignedTo = 'Web';
                    }

                    await axios({
                        method: 'post',
                        url: `${caspioApiBaseUrl}/tables/${TABLE_NAME}/records`,
                        headers: {
                            'Authorization': `Bearer ${token}`,
                            'Content-Type': 'application/json'
                        },
                        data: {
                            ID_Customer: customer.ID_Customer,
                            CompanyName: customer.companyName,
                            Assigned_To: assignedTo,
                            Notes: `Auto-added from reconcile. Rep: ${customer.rep || 'Unknown'}. Orders: ${customer.orderCount}. Sales: $${customer.totalSales.toFixed(2)}`,
                            Date_Added: today,
                            Reviewed: false
                        },
                        timeout: 10000
                    });
                    addedCount++;
                    console.log(`Added customer ${customer.ID_Customer}: ${customer.companyName} -> ${assignedTo}`);
                } catch (addError) {
                    console.error(`Failed to add customer ${customer.ID_Customer}:`, addError.message);
                }
            }
        }

        res.json({
            success: true,
            knownAccounts: allKnownIds.size,
            missingCustomers: missingList,
            missingCount: missingList.length,
            totalMissingSales: totalMissingSales,
            addedCount: autoAdd ? addedCount : undefined,
            message: autoAdd && addedCount > 0
                ? `Added ${addedCount} missing customers to House Accounts`
                : `Found ${missingList.length} customers with $${totalMissingSales.toFixed(2)} in sales not in any account list`
        });
    } catch (error) {
        console.error('Error reconciling accounts:', error.message);
        res.status(500).json({ success: false, error: 'Failed to reconcile accounts' });
    }
});

// GET /api/house-accounts/full-reconciliation - Find ALL authority conflicts across ALL reps
// Shows orders where the writer doesn't match the customer's CRM owner
// Returns conflicts grouped by rep with fix instructions
// NOW USES Sales_Reps_2026 as SOURCE OF TRUTH (syncs from ShopWorks)
router.get('/house-accounts/full-reconciliation', async (req, res) => {
    try {
        console.log('Running full reconciliation report...');
        const { fetchOrders, getDateDaysAgo } = require('../utils/manageorders');

        // 1. Get customer assignments from Sales_Reps_2026 (SOURCE OF TRUTH from ShopWorks)
        // Plus House_Accounts for non-rep customers (Ruthie, Erik, Jim, Web, House)
        const [salesRepsData, houseAccounts] = await Promise.all([
            fetchAllCaspioPages('/tables/Sales_Reps_2026/records', {
                'q.where': `CustomerServiceRep='Nika Lao' OR CustomerServiceRep='Taneisha Clark'`,
                'q.select': 'ID_Customer,CompanyName,CustomerServiceRep'
            }),
            fetchAllCaspioPages('/tables/House_Accounts/records', {
                'q.select': 'ID_Customer,CompanyName'
            })
        ]);

        // Count by rep for logging
        const nikaCount = salesRepsData.filter(a => a.CustomerServiceRep === 'Nika Lao').length;
        const taneishaCount = salesRepsData.filter(a => a.CustomerServiceRep === 'Taneisha Clark').length;
        console.log(`Sales_Reps_2026: Nika=${nikaCount}, Taneisha=${taneishaCount}, House=${houseAccounts.length}`);

        // 2. Build customer->owner lookup directly from CustomerServiceRep field
        const customerOwner = new Map();
        const customerName = new Map();

        // Sales reps from Sales_Reps_2026 (Nika & Taneisha)
        salesRepsData.forEach(a => {
            customerOwner.set(a.ID_Customer, a.CustomerServiceRep);
            customerName.set(a.ID_Customer, a.CompanyName);
        });
        // House accounts (non-rep customers)
        houseAccounts.forEach(a => {
            customerOwner.set(a.ID_Customer, 'House');
            customerName.set(a.ID_Customer, a.CompanyName);
        });

        // 3. Fetch recent orders (60 days in 3 chunks)
        let allOrders = [];
        for (let chunk = 0; chunk < 3; chunk++) {
            const chunkEnd = getDateDaysAgo(chunk * 20);
            const chunkStart = getDateDaysAgo((chunk + 1) * 20);
            try {
                const chunkOrders = await fetchOrders({
                    date_Invoiced_start: chunkStart,
                    date_Invoiced_end: chunkEnd
                });
                allOrders = allOrders.concat(chunkOrders);
            } catch (e) {
                console.warn(`Chunk ${chunk + 1} failed: ${e.message}`);
            }
        }

        console.log(`Fetched ${allOrders.length} orders for reconciliation`);

        // 4. Find all conflicts - group by rep
        // Track reps we care about: Nika and Taneisha
        const trackedReps = ['Nika Lao', 'Taneisha Clark'];
        const conflicts = {};
        trackedReps.forEach(rep => {
            conflicts[rep] = {
                outbound: new Map(), // Orders BY this rep for customers NOT in their CRM
                inbound: new Map()   // Orders by OTHER reps for customers IN this rep's CRM
            };
        });

        // Build sets for faster lookup (filter from single Sales_Reps_2026 dataset)
        const nikaCustomerIds = new Set(
            salesRepsData.filter(a => a.CustomerServiceRep === 'Nika Lao').map(a => a.ID_Customer)
        );
        const taneishaCustomerIds = new Set(
            salesRepsData.filter(a => a.CustomerServiceRep === 'Taneisha Clark').map(a => a.ID_Customer)
        );

        allOrders.forEach(order => {
            const customerId = order.id_Customer;
            const writer = order.CustomerServiceRep || '';
            const owner = customerOwner.get(customerId) || null;
            const orderAmount = parseFloat(order.cur_SubTotal) || 0;
            const orderDate = order.date_Invoiced?.split('T')[0];
            const orderNumber = order.Order_ID || order.id_Order || 'N/A';
            const companyName = order.CustomerName || customerName.get(customerId) || `ID: ${customerId}`;

            // Helper to add conflict to a rep's list
            // explicitOwner: For inbound conflicts, use the rep name (not from Map which may be overwritten)
            const addConflict = (repName, type, custId, orderData, explicitOwner = null) => {
                const map = conflicts[repName][type];
                if (!map.has(custId)) {
                    map.set(custId, {
                        ID_Customer: custId,
                        companyName: companyName,
                        owner: explicitOwner || owner, // Use explicit owner for inbound
                        orders: [],
                        totalSales: 0,
                        orderCount: 0,
                        repNames: new Set() // For inbound: who wrote the orders
                    });
                }
                const cust = map.get(custId);
                cust.orders.push(orderData);
                cust.totalSales += orderData.amount;
                cust.orderCount++;
                if (type === 'inbound' && orderData.writer) {
                    cust.repNames.add(orderData.writer);
                }
            };

            // Check Nika
            if (writer === 'Nika Lao') {
                // Outbound: Nika wrote for customer NOT in her CRM
                if (!nikaCustomerIds.has(customerId)) {
                    addConflict('Nika Lao', 'outbound', customerId, {
                        orderNumber,
                        amount: orderAmount,
                        date: orderDate,
                        writer: writer
                    });
                }
            } else if (nikaCustomerIds.has(customerId) && writer && writer !== 'Nika Lao') {
                // Inbound: Someone else wrote for Nika's customer
                // Pass 'Nika Lao' as explicit owner (customer is in HER CRM)
                addConflict('Nika Lao', 'inbound', customerId, {
                    orderNumber,
                    amount: orderAmount,
                    date: orderDate,
                    writer: writer
                }, 'Nika Lao');
            }

            // Check Taneisha
            if (writer === 'Taneisha Clark') {
                // Outbound: Taneisha wrote for customer NOT in her CRM
                if (!taneishaCustomerIds.has(customerId)) {
                    addConflict('Taneisha Clark', 'outbound', customerId, {
                        orderNumber,
                        amount: orderAmount,
                        date: orderDate,
                        writer: writer
                    });
                }
            } else if (taneishaCustomerIds.has(customerId) && writer && writer !== 'Taneisha Clark') {
                // Inbound: Someone else wrote for Taneisha's customer
                // Pass 'Taneisha Clark' as explicit owner (customer is in HER CRM)
                addConflict('Taneisha Clark', 'inbound', customerId, {
                    orderNumber,
                    amount: orderAmount,
                    date: orderDate,
                    writer: writer
                }, 'Taneisha Clark');
            }
        });

        // 5. Format response
        const formatConflicts = (map, type) => {
            return [...map.values()]
                .map(c => ({
                    ...c,
                    repNames: c.repNames ? [...c.repNames] : [],
                    conflictType: type,
                    fixInstruction: type === 'outbound'
                        ? `Add customer to CRM OR change orders to "${c.owner || 'House'}"`
                        : `Change orders to match CRM owner`
                }))
                .sort((a, b) => b.totalSales - a.totalSales);
        };

        const result = trackedReps.map(rep => {
            const outbound = formatConflicts(conflicts[rep].outbound, 'outbound');
            const inbound = formatConflicts(conflicts[rep].inbound, 'inbound');
            const allConflicts = [...outbound, ...inbound];

            return {
                rep,
                conflictCount: allConflicts.length,
                totalAmount: allConflicts.reduce((sum, c) => sum + c.totalSales, 0),
                outboundCount: outbound.length,
                outboundAmount: outbound.reduce((sum, c) => sum + c.totalSales, 0),
                inboundCount: inbound.length,
                inboundAmount: inbound.reduce((sum, c) => sum + c.totalSales, 0),
                conflicts: allConflicts
            };
        });

        console.log(`Full reconciliation complete: ${result.reduce((sum, r) => sum + r.conflictCount, 0)} total conflicts`);

        res.json({
            success: true,
            generatedAt: new Date().toISOString(),
            ordersPeriod: '60 days',
            totalOrdersChecked: allOrders.length,
            reps: result
        });
    } catch (error) {
        console.error('Error running full reconciliation:', error.message);
        res.status(500).json({ success: false, error: 'Failed to run full reconciliation' });
    }
});

// GET /api/house-accounts/:id - Get single account by ID_Customer
router.get('/house-accounts/:id', async (req, res) => {
    const { id } = req.params;

    if (!id) {
        return res.status(400).json({ success: false, error: 'Missing required parameter: id' });
    }

    try {
        console.log(`Fetching house account with ID_Customer: ${id}`);
        const resource = `/tables/${TABLE_NAME}/records`;
        const params = {
            'q.where': `${PRIMARY_KEY}=${id}`,
            'q.limit': 1
        };

        const result = await fetchAllCaspioPages(resource, params);

        if (result.length === 0) {
            return res.status(404).json({ success: false, error: 'House account not found' });
        }

        res.json({
            success: true,
            account: result[0]
        });
    } catch (error) {
        console.error('Error fetching house account:', error.message);
        res.status(500).json({ success: false, error: 'Failed to fetch account' });
    }
});

// POST /api/house-accounts - Create new house account
router.post('/house-accounts', express.json(), async (req, res) => {
    try {
        const requestData = { ...req.body };

        // Validate required fields
        if (!requestData.ID_Customer) {
            return res.status(400).json({ success: false, error: 'Missing required field: ID_Customer' });
        }
        if (!requestData.CompanyName) {
            return res.status(400).json({ success: false, error: 'Missing required field: CompanyName' });
        }

        console.log(`Creating house account for ID_Customer: ${requestData.ID_Customer}`);

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
                error: `House account with ID_Customer ${requestData.ID_Customer} already exists`
            });
        }

        // Set Date_Added if not provided
        if (!requestData.Date_Added) {
            requestData.Date_Added = new Date().toISOString().split('T')[0];
        }

        // Default Reviewed to false if not provided
        if (requestData.Reviewed === undefined) {
            requestData.Reviewed = false;
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

        console.log(`Created house account for ID_Customer: ${requestData.ID_Customer}`);

        res.status(201).json({
            success: true,
            message: 'House account created successfully',
            account: requestData
        });
    } catch (error) {
        console.error('Error creating house account:',
            error.response ? JSON.stringify(error.response.data) : error.message);
        res.status(500).json({ success: false, error: 'Failed to create house account' });
    }
});

// PUT /api/house-accounts/:id - Update house account
router.put('/house-accounts/:id', express.json(), async (req, res) => {
    const { id } = req.params;

    if (!id) {
        return res.status(400).json({ success: false, error: 'Missing required parameter: id' });
    }

    try {
        console.log(`Updating house account with ID_Customer: ${id}`);

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
            message: 'House account updated successfully',
            updatedFields: Object.keys(updateData)
        });
    } catch (error) {
        console.error('Error updating house account:',
            error.response ? JSON.stringify(error.response.data) : error.message);
        res.status(500).json({ success: false, error: 'Failed to update house account' });
    }
});

// DELETE /api/house-accounts/:id - Delete house account
router.delete('/house-accounts/:id', async (req, res) => {
    const { id } = req.params;

    if (!id) {
        return res.status(400).json({ success: false, error: 'Missing required parameter: id' });
    }

    try {
        console.log(`Deleting house account with ID_Customer: ${id}`);

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

        res.json({ success: true, message: 'House account deleted successfully' });
    } catch (error) {
        console.error('Error deleting house account:',
            error.response ? JSON.stringify(error.response.data) : error.message);
        res.status(500).json({ success: false, error: 'Failed to delete house account' });
    }
});

// POST /api/house-accounts/bulk - Add multiple house accounts at once
router.post('/house-accounts/bulk', express.json(), async (req, res) => {
    try {
        const { accounts } = req.body;

        if (!accounts || !Array.isArray(accounts) || accounts.length === 0) {
            return res.status(400).json({
                success: false,
                error: 'Missing or empty accounts array'
            });
        }

        console.log(`Bulk adding ${accounts.length} house accounts...`);

        const token = await getCaspioAccessToken();
        const url = `${caspioApiBaseUrl}/tables/${TABLE_NAME}/records`;
        const today = new Date().toISOString().split('T')[0];

        let added = 0;
        let skipped = 0;
        let errors = [];

        for (const account of accounts) {
            if (!account.ID_Customer || !account.CompanyName) {
                skipped++;
                continue;
            }

            // Check if already exists
            const existing = await fetchAllCaspioPages(`/tables/${TABLE_NAME}/records`, {
                'q.where': `ID_Customer=${account.ID_Customer}`,
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
                    data: {
                        ID_Customer: account.ID_Customer,
                        CompanyName: account.CompanyName,
                        Assigned_To: account.Assigned_To || 'House',
                        Notes: account.Notes || '',
                        Date_Added: today,
                        Reviewed: false
                    },
                    timeout: 10000
                });
                added++;
            } catch (addError) {
                errors.push({ ID_Customer: account.ID_Customer, error: addError.message });
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
        console.error('Error bulk adding house accounts:', error.message);
        res.status(500).json({ success: false, error: 'Failed to bulk add house accounts' });
    }
});

module.exports = router;
