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

// POST /api/taneisha-accounts/sync-sales - Sync YTD sales from ManageOrders with archive support
// HYBRID PATTERN: Archive (pre-60 days) + Fresh ManageOrders (last 60 days) = True YTD
// Updates YTD_Sales_2026, Order_Count_2026, Last_Order_Date, Last_Sync_Date
router.post('/taneisha-accounts/sync-sales', express.json(), async (req, res) => {
    try {
        console.log('Starting Taneisha accounts HYBRID sales sync...');

        const { fetchOrders, getDateDaysAgo, getTodayDate } = require('../utils/manageorders');
        const currentYear = new Date().getFullYear();

        // Step 1: Get archived YTD totals per customer (pre-60 day boundary)
        console.log('Step 1: Fetching archived YTD totals per customer...');
        const ARCHIVE_TABLE = 'Taneisha_Daily_Sales_By_Account';
        const archiveBoundary = getDateDaysAgo(60); // Only archive data older than this
        let archivedByCustomer = new Map();

        try {
            const archivedRecords = await fetchAllCaspioPages(`/tables/${ARCHIVE_TABLE}/records`, {
                'q.where': `SalesDate>='${currentYear}-01-01' AND SalesDate<'${archiveBoundary}'`,
                'q.limit': 5000
            });

            // Aggregate archived data by CustomerID
            for (const record of archivedRecords) {
                const customerId = parseInt(record.CustomerID);
                if (!archivedByCustomer.has(customerId)) {
                    archivedByCustomer.set(customerId, { totalSales: 0, orderCount: 0 });
                }
                const archived = archivedByCustomer.get(customerId);
                archived.totalSales += parseFloat(record.Revenue) || 0;
                archived.orderCount += parseInt(record.OrderCount) || 0;
            }
            console.log(`Found archived data for ${archivedByCustomer.size} customers`);
        } catch (archiveError) {
            console.warn('Could not fetch archived data (table may not exist yet):', archiveError.message);
            // Continue without archived data - fresh data only
        }

        // Step 2: Fetch fresh ManageOrders data (last 60 days)
        // Use smaller chunks to avoid ManageOrders API timeout (504)
        console.log('Step 2: Fetching fresh ManageOrders data (last 60 days in chunks)...');
        const endDate = getTodayDate();
        let allOrders = [];

        // Fetch in 20-day chunks to avoid timeout
        for (let chunk = 0; chunk < 3; chunk++) {
            const chunkEnd = getDateDaysAgo(chunk * 20);
            const chunkStart = getDateDaysAgo((chunk + 1) * 20);
            console.log(`  Fetching chunk ${chunk + 1}/3: ${chunkStart} to ${chunkEnd}`);

            try {
                const chunkOrders = await fetchOrders({
                    date_Invoiced_start: chunkStart,
                    date_Invoiced_end: chunkEnd
                });
                allOrders = allOrders.concat(chunkOrders);
                console.log(`  Chunk ${chunk + 1}: ${chunkOrders.length} orders`);
            } catch (chunkError) {
                console.warn(`  Chunk ${chunk + 1} failed: ${chunkError.message}`);
                // Continue with other chunks
            }
        }

        const orders = allOrders;

        console.log(`Fetched ${orders.length} orders from ManageOrders`);

        // Step 3: Get all Taneisha accounts
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

        // Step 4: Aggregate fresh sales by customer ID (and by date for archiving)
        const freshSalesByCustomer = new Map();
        const salesByDateAndCustomer = new Map(); // For archiving: date -> Map(customerId -> {revenue, orderCount, customerName})

        orders.forEach(order => {
            const customerId = order.id_Customer;

            // Only process orders for Taneisha's customers
            if (!accountMap.has(customerId)) return;

            // Only count current year invoiced orders
            const invoiceDate = new Date(order.date_Invoiced);
            if (invoiceDate.getFullYear() !== currentYear) return;

            const orderTotal = parseFloat(order.cur_SubTotal) || 0;
            const invoiceDateStr = order.date_Invoiced.split('T')[0];

            // Aggregate for account updates
            if (!freshSalesByCustomer.has(customerId)) {
                freshSalesByCustomer.set(customerId, {
                    totalSales: 0,
                    orderCount: 0,
                    lastOrderDate: null
                });
            }

            const customerSales = freshSalesByCustomer.get(customerId);
            customerSales.totalSales += orderTotal;
            customerSales.orderCount += 1;

            if (!customerSales.lastOrderDate || invoiceDate > new Date(customerSales.lastOrderDate)) {
                customerSales.lastOrderDate = invoiceDateStr;
            }

            // Also track by date for archiving
            if (!salesByDateAndCustomer.has(invoiceDateStr)) {
                salesByDateAndCustomer.set(invoiceDateStr, new Map());
            }
            const dateMap = salesByDateAndCustomer.get(invoiceDateStr);
            if (!dateMap.has(customerId)) {
                const account = accountMap.get(customerId);
                dateMap.set(customerId, {
                    revenue: 0,
                    orderCount: 0,
                    customerName: account.CompanyName || ''
                });
            }
            const dayCustomer = dateMap.get(customerId);
            dayCustomer.revenue += orderTotal;
            dayCustomer.orderCount += 1;
        });

        console.log(`Aggregated fresh sales for ${freshSalesByCustomer.size} Taneisha accounts`);

        // Step 5: Combine archived + fresh for true YTD and update accounts
        const token = await getCaspioAccessToken();
        const today = getTodayDate();
        let updatedCount = 0;
        let errorCount = 0;

        // Get all customer IDs that have either archived or fresh data
        const allCustomerIds = new Set([
            ...archivedByCustomer.keys(),
            ...freshSalesByCustomer.keys()
        ]);

        for (const customerId of allCustomerIds) {
            if (!accountMap.has(customerId)) continue;

            try {
                const archived = archivedByCustomer.get(customerId) || { totalSales: 0, orderCount: 0 };
                const fresh = freshSalesByCustomer.get(customerId) || { totalSales: 0, orderCount: 0, lastOrderDate: null };

                // True YTD = Archived + Fresh
                const trueYTDSales = archived.totalSales + fresh.totalSales;
                const trueYTDOrders = archived.orderCount + fresh.orderCount;

                const updateData = {
                    YTD_Sales_2026: trueYTDSales,
                    Order_Count_2026: trueYTDOrders,
                    Last_Sync_Date: today
                };

                // Only update last order date if we have fresh data
                if (fresh.lastOrderDate) {
                    updateData.Last_Order_Date = fresh.lastOrderDate;
                }

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

        // Step 6: Archive days 55-60 (soon to expire from ManageOrders)
        let daysArchived = 0;
        let customersArchived = 0;
        console.log('Step 6: Archiving days 55-60 (before they expire from ManageOrders)...');

        try {
            // Archive days 55-60
            for (let daysAgo = 55; daysAgo <= 60; daysAgo++) {
                const archiveDate = getDateDaysAgo(daysAgo);
                const customersForDay = salesByDateAndCustomer.get(archiveDate);

                if (customersForDay && customersForDay.size > 0) {
                    // Archive this day's per-customer data
                    const customersToArchive = [];
                    for (const [custId, data] of customersForDay) {
                        customersToArchive.push({
                            customerId: custId,
                            customerName: data.customerName,
                            revenue: data.revenue,
                            orderCount: data.orderCount
                        });
                    }

                    // Post to archive endpoint
                    try {
                        for (const customer of customersToArchive) {
                            // Check if already archived
                            const existing = await fetchAllCaspioPages(`/tables/${ARCHIVE_TABLE}/records`, {
                                'q.where': `SalesDate='${archiveDate}' AND CustomerID='${customer.customerId}'`,
                                'q.limit': 1
                            });

                            if (existing.length === 0) {
                                await axios({
                                    method: 'post',
                                    url: `${caspioApiBaseUrl}/tables/${ARCHIVE_TABLE}/records`,
                                    headers: {
                                        'Authorization': `Bearer ${token}`,
                                        'Content-Type': 'application/json'
                                    },
                                    data: {
                                        SalesDate: archiveDate,
                                        CustomerID: String(customer.customerId),
                                        CustomerName: customer.customerName,
                                        Revenue: customer.revenue,
                                        OrderCount: customer.orderCount
                                    },
                                    timeout: 10000
                                });
                                customersArchived++;
                            }
                        }
                        daysArchived++;
                        console.log(`Archived ${archiveDate}: ${customersToArchive.length} customers`);
                    } catch (archivePostError) {
                        console.warn(`Could not archive ${archiveDate}:`, archivePostError.message);
                    }
                }
            }
        } catch (archiveError) {
            console.warn('Error during archiving (continuing):', archiveError.message);
        }

        console.log(`HYBRID Sales sync complete: ${updatedCount} accounts updated, ${daysArchived} days archived (${customersArchived} customer records), ${errorCount} errors`);

        res.json({
            success: true,
            message: 'Hybrid sales sync completed (Archive + Fresh = True YTD)',
            ordersProcessed: orders.length,
            accountsUpdated: updatedCount,
            archivedCustomers: archivedByCustomer.size,
            freshCustomers: freshSalesByCustomer.size,
            daysArchived: daysArchived,
            customerRecordsArchived: customersArchived,
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
