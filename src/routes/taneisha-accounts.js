// Taneisha Accounts CRUD Routes - Taneisha_All_Accounts_Caspio table
// Endpoints for managing Taneisha Clark's 800 customer accounts with CRM tracking

const express = require('express');
const axios = require('axios');
const router = express.Router();
const config = require('../../config');
const { getCaspioAccessToken, fetchAllCaspioPages } = require('../utils/caspio');

const caspioApiBaseUrl = config.caspio.apiBaseUrl;
const TABLE_NAME = 'Taneisha_All_Accounts_Caspio';
const PRIMARY_KEY = 'ID_Customer';

// CRM fields that can be updated via the /crm endpoint
const CRM_FIELDS = [
    'Last_Contact_Date',
    'Contact_Status',
    'Contact_Notes',
    'Next_Follow_Up',
    'Follow_Up_Type',
    'Won_Back_Date'
];

// Month field mapping
const MONTH_FIELDS = {
    jan: 'Jan_Active',
    feb: 'Feb_Active',
    mar: 'Mar_Active',
    apr: 'Apr_Active',
    may: 'May_Active',
    jun: 'Jun_Active',
    jul: 'Jul_Active',
    aug: 'Aug_Active',
    sep: 'Sep_Active',
    oct: 'Oct_Active',
    nov: 'Nov_Active',
    dec: 'Dec_Active'
};

// Quarter field mapping
const QUARTER_FIELDS = {
    q1: 'Q1_Active',
    q2: 'Q2_Active',
    q3: 'Q3_Active',
    q4: 'Q4_Active'
};

// GET /api/taneisha-accounts - List all accounts with optional filters
router.get('/taneisha-accounts', async (req, res) => {
    try {
        console.log('Fetching Taneisha accounts with filters:', req.query);
        const resource = `/tables/${TABLE_NAME}/records`;
        const params = {};
        const whereConditions = [];

        // Tier filters
        if (req.query.accountTier) {
            whereConditions.push(`Account_Tier='${req.query.accountTier}'`);
        }
        if (req.query.priorityTier) {
            whereConditions.push(`Priority_Tier='${req.query.priorityTier}'`);
        }

        // Month activity filter
        if (req.query.month) {
            const monthField = MONTH_FIELDS[req.query.month.toLowerCase()];
            if (monthField) {
                whereConditions.push(`${monthField}=1`);
            }
        }

        // Quarter activity filter
        if (req.query.quarter) {
            const quarterField = QUARTER_FIELDS[req.query.quarter.toLowerCase()];
            if (quarterField) {
                whereConditions.push(`${quarterField}=1`);
            }
        }

        // Is Active filter
        if (req.query.isActive !== undefined) {
            whereConditions.push(`Is_Active=${req.query.isActive}`);
        }

        // Product preference filters
        if (req.query.buysCaps !== undefined) {
            whereConditions.push(`Buys_Caps=${req.query.buysCaps}`);
        }
        if (req.query.buysJackets !== undefined) {
            whereConditions.push(`Buys_Jackets=${req.query.buysJackets}`);
        }
        if (req.query.buysCarhartt !== undefined) {
            whereConditions.push(`Buys_Carhartt=${req.query.buysCarhartt}`);
        }
        if (req.query.buysPolos !== undefined) {
            whereConditions.push(`Buys_Polos=${req.query.buysPolos}`);
        }
        if (req.query.buysTShirts !== undefined) {
            whereConditions.push(`Buys_TShirts=${req.query.buysTShirts}`);
        }
        if (req.query.buysHoodies !== undefined) {
            whereConditions.push(`Buys_Hoodies=${req.query.buysHoodies}`);
        }
        if (req.query.buysSafety !== undefined) {
            whereConditions.push(`Buys_Safety=${req.query.buysSafety}`);
        }

        // Status filters
        if (req.query.atRisk !== undefined) {
            whereConditions.push(`At_Risk=${req.query.atRisk}`);
        }
        if (req.query.overdueForOrder !== undefined) {
            whereConditions.push(`Overdue_For_Order=${req.query.overdueForOrder}`);
        }
        if (req.query.contactStatus) {
            whereConditions.push(`Contact_Status='${req.query.contactStatus}'`);
        }
        if (req.query.trend) {
            whereConditions.push(`Trend='${req.query.trend}'`);
        }

        // Search by company name
        if (req.query.search) {
            whereConditions.push(`CompanyName LIKE '%${req.query.search}%'`);
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
        console.log(`Found ${result.length} Taneisha account records`);

        res.json({
            success: true,
            count: result.length,
            accounts: result
        });
    } catch (error) {
        console.error('Error fetching Taneisha accounts:', error.message);
        res.status(500).json({ success: false, error: 'Failed to fetch accounts' });
    }
});

// GET /api/taneisha-accounts/:id - Get single account by ID_Customer
router.get('/taneisha-accounts/:id', async (req, res) => {
    const { id } = req.params;

    if (!id) {
        return res.status(400).json({ success: false, error: 'Missing required parameter: id' });
    }

    try {
        console.log(`Fetching Taneisha account with ID_Customer: ${id}`);
        const resource = `/tables/${TABLE_NAME}/records`;
        const params = {
            'q.where': `${PRIMARY_KEY}=${id}`,
            'q.limit': 1
        };

        const result = await fetchAllCaspioPages(resource, params);

        if (result.length === 0) {
            return res.status(404).json({ success: false, error: 'Account not found' });
        }

        res.json({
            success: true,
            account: result[0]
        });
    } catch (error) {
        console.error('Error fetching Taneisha account:', error.message);
        res.status(500).json({ success: false, error: 'Failed to fetch account' });
    }
});

// POST /api/taneisha-accounts - Create new account
router.post('/taneisha-accounts', express.json(), async (req, res) => {
    try {
        const requestData = { ...req.body };

        // Validate required fields
        if (!requestData.ID_Customer) {
            return res.status(400).json({ success: false, error: 'Missing required field: ID_Customer' });
        }
        if (!requestData.CompanyName) {
            return res.status(400).json({ success: false, error: 'Missing required field: CompanyName' });
        }

        console.log(`Creating Taneisha account for ID_Customer: ${requestData.ID_Customer}`);

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
                error: `Account with ID_Customer ${requestData.ID_Customer} already exists`
            });
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

        console.log(`Created Taneisha account for ID_Customer: ${requestData.ID_Customer}`);

        res.status(201).json({
            success: true,
            message: 'Account created successfully',
            account: requestData
        });
    } catch (error) {
        console.error('Error creating Taneisha account:',
            error.response ? JSON.stringify(error.response.data) : error.message);
        res.status(500).json({ success: false, error: 'Failed to create account' });
    }
});

// PUT /api/taneisha-accounts/:id - Update account (any fields)
router.put('/taneisha-accounts/:id', express.json(), async (req, res) => {
    const { id } = req.params;

    if (!id) {
        return res.status(400).json({ success: false, error: 'Missing required parameter: id' });
    }

    try {
        console.log(`Updating Taneisha account with ID_Customer: ${id}`);

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
            message: 'Account updated successfully',
            updatedFields: Object.keys(updateData)
        });
    } catch (error) {
        console.error('Error updating Taneisha account:',
            error.response ? JSON.stringify(error.response.data) : error.message);
        res.status(500).json({ success: false, error: 'Failed to update account' });
    }
});

// PUT /api/taneisha-accounts/:id/crm - Update CRM fields only (whitelisted)
router.put('/taneisha-accounts/:id/crm', express.json(), async (req, res) => {
    const { id } = req.params;

    if (!id) {
        return res.status(400).json({ success: false, error: 'Missing required parameter: id' });
    }

    try {
        console.log(`Updating CRM fields for Taneisha account ID_Customer: ${id}`);

        // Only allow CRM fields
        const updateData = {};
        for (const field of CRM_FIELDS) {
            if (req.body[field] !== undefined) {
                updateData[field] = req.body[field];
            }
        }

        if (Object.keys(updateData).length === 0) {
            return res.status(400).json({
                success: false,
                error: 'No valid CRM fields to update',
                allowedFields: CRM_FIELDS
            });
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
            message: 'CRM fields updated successfully',
            updatedFields: Object.keys(updateData)
        });
    } catch (error) {
        console.error('Error updating CRM fields:',
            error.response ? JSON.stringify(error.response.data) : error.message);
        res.status(500).json({ success: false, error: 'Failed to update CRM fields' });
    }
});

// POST /api/taneisha-accounts/sync-sales - Sync YTD sales from ManageOrders
// Updates YTD_Sales_2026, Order_Count_2026, Last_Order_Date, Last_Sync_Date
router.post('/taneisha-accounts/sync-sales', express.json(), async (req, res) => {
    try {
        console.log('Starting Taneisha accounts sales sync from ManageOrders...');

        const { fetchOrders, getDateDaysAgo, getTodayDate } = require('../utils/manageorders');

        // Fetch last 60 days of orders from ManageOrders
        const startDate = getDateDaysAgo(60);
        const endDate = getTodayDate();

        const orders = await fetchOrders({
            startDate: startDate,
            endDate: endDate,
            dateType: 'dateInvoiced' // Only invoiced orders count toward sales
        });

        console.log(`Fetched ${orders.length} orders from ManageOrders for sync`);

        // First, get all Taneisha accounts to match customer IDs
        const resource = `/tables/${TABLE_NAME}/records`;
        const params = {
            'q.select': 'ID_Customer,CompanyName,YTD_Sales_2026,Order_Count_2026,Last_Order_Date,Last_Sync_Date'
        };

        const accounts = await fetchAllCaspioPages(resource, params);
        console.log(`Found ${accounts.length} Taneisha accounts to match`);

        // Create a map of customer IDs to accounts
        const accountMap = new Map();
        accounts.forEach(account => {
            accountMap.set(account.ID_Customer, account);
        });

        // Aggregate sales by customer ID
        const salesByCustomer = new Map();
        const currentYear = new Date().getFullYear();

        orders.forEach(order => {
            const customerId = order.id_Customer;

            // Only process orders for Taneisha's customers
            if (!accountMap.has(customerId)) return;

            // Only count 2026 invoiced orders
            const invoiceDate = new Date(order.date_Invoiced);
            if (invoiceDate.getFullYear() !== currentYear) return;

            const orderTotal = parseFloat(order.amount_Total) || 0;

            if (!salesByCustomer.has(customerId)) {
                salesByCustomer.set(customerId, {
                    totalSales: 0,
                    orderCount: 0,
                    lastOrderDate: null
                });
            }

            const customerSales = salesByCustomer.get(customerId);
            customerSales.totalSales += orderTotal;
            customerSales.orderCount += 1;

            // Track most recent order date
            if (!customerSales.lastOrderDate || invoiceDate > new Date(customerSales.lastOrderDate)) {
                customerSales.lastOrderDate = order.date_Invoiced.split('T')[0];
            }
        });

        console.log(`Found sales for ${salesByCustomer.size} Taneisha accounts`);

        // Update each account with new sales data
        const token = await getCaspioAccessToken();
        const today = getTodayDate();
        let updatedCount = 0;
        let errorCount = 0;

        for (const [customerId, sales] of salesByCustomer) {
            try {
                const account = accountMap.get(customerId);
                const existingSales = parseFloat(account.YTD_Sales_2026) || 0;
                const existingCount = parseInt(account.Order_Count_2026) || 0;

                // Calculate new totals (add to existing if this is an incremental sync)
                // For simplicity, we'll just set the values from the 60-day window
                // A more sophisticated approach would track lastSyncDate and only add new orders
                const updateData = {
                    YTD_Sales_2026: sales.totalSales,
                    Order_Count_2026: sales.orderCount,
                    Last_Order_Date: sales.lastOrderDate,
                    Last_Sync_Date: today
                };

                const url = `${caspioApiBaseUrl}/tables/${TABLE_NAME}/records?q.where=${PRIMARY_KEY}=${customerId}`;

                await axios({
                    method: 'put',
                    url: url,
                    headers: {
                        'Authorization': `Bearer ${token}`,
                        'Content-Type': 'application/json'
                    },
                    data: updateData,
                    timeout: 10000
                });

                updatedCount++;
            } catch (updateError) {
                console.error(`Error updating customer ${customerId}:`, updateError.message);
                errorCount++;
            }
        }

        console.log(`Sales sync complete: ${updatedCount} accounts updated, ${errorCount} errors`);

        res.json({
            success: true,
            message: 'Sales sync completed',
            ordersProcessed: orders.length,
            accountsUpdated: updatedCount,
            errors: errorCount,
            syncDate: today
        });
    } catch (error) {
        console.error('Error syncing Taneisha accounts sales:',
            error.response ? JSON.stringify(error.response.data) : error.message);
        res.status(500).json({ success: false, error: 'Failed to sync sales data' });
    }
});

// DELETE /api/taneisha-accounts/:id - Delete account
router.delete('/taneisha-accounts/:id', async (req, res) => {
    const { id } = req.params;

    if (!id) {
        return res.status(400).json({ success: false, error: 'Missing required parameter: id' });
    }

    try {
        console.log(`Deleting Taneisha account with ID_Customer: ${id}`);

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

        res.json({ success: true, message: 'Account deleted successfully' });
    } catch (error) {
        console.error('Error deleting Taneisha account:',
            error.response ? JSON.stringify(error.response.data) : error.message);
        res.status(500).json({ success: false, error: 'Failed to delete account' });
    }
});

module.exports = router;
