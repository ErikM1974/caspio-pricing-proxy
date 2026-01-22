// Rep Audit Routes - Cross-check orders against account assignments
// Ensures sales reps only get credit for customers on their list

const express = require('express');
const router = express.Router();
const { fetchAllCaspioPages } = require('../utils/caspio');

const TANEISHA_TABLE = 'Taneisha_All_Accounts_Caspio';
const NIKA_TABLE = 'Nika_All_Accounts_Caspio';
const HOUSE_TABLE = 'House_Accounts';

// GET /api/rep-audit - Find orders where rep doesn't match account assignment
// Query params:
//   - year: Filter to specific year (default: current year)
//   - includeUnassigned: Include orders for customers not in either list (default: true)
router.get('/rep-audit', async (req, res) => {
    try {
        const currentYear = new Date().getFullYear();
        const filterYear = parseInt(req.query.year) || currentYear;
        const includeUnassigned = req.query.includeUnassigned !== 'false';

        console.log(`Running rep audit for ${filterYear}...`);

        const { fetchOrders, getDateDaysAgo } = require('../utils/manageorders');

        // Step 1: Get all account lists (Taneisha, Nika, House)
        console.log('Fetching account lists...');
        const [taneishaAccounts, nikaAccounts, houseAccounts] = await Promise.all([
            fetchAllCaspioPages(`/tables/${TANEISHA_TABLE}/records`, {
                'q.select': 'ID_Customer,CompanyName'
            }),
            fetchAllCaspioPages(`/tables/${NIKA_TABLE}/records`, {
                'q.select': 'ID_Customer,CompanyName'
            }),
            fetchAllCaspioPages(`/tables/${HOUSE_TABLE}/records`, {
                'q.select': 'ID_Customer,CompanyName,Assigned_To'
            }).catch(() => []) // House table may not exist yet
        ]);

        const taneishaIds = new Set(taneishaAccounts.map(a => a.ID_Customer));
        const nikaIds = new Set(nikaAccounts.map(a => a.ID_Customer));
        const houseIds = new Set(houseAccounts.map(a => a.ID_Customer));
        const houseAssignments = new Map(houseAccounts.map(a => [a.ID_Customer, a.Assigned_To]));

        console.log(`Taneisha: ${taneishaIds.size} accounts, Nika: ${nikaIds.size} accounts, House: ${houseIds.size} accounts`);

        // Step 2: Fetch orders (last 60 days in chunks)
        console.log('Fetching orders...');
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

        // Filter to requested year
        const yearOrders = allOrders.filter(o => {
            if (!o.date_Invoiced) return false;
            return new Date(o.date_Invoiced).getFullYear() === filterYear;
        });

        console.log(`Found ${yearOrders.length} orders for ${filterYear}`);

        // Step 3: Categorize mismatches
        const mismatches = {
            nikaOrdersTaneishaCustomer: [],  // Nika wrote order for Taneisha's customer
            taneishaOrdersNikaCustomer: [],  // Taneisha wrote order for Nika's customer
            houseAccountOrders: [],          // Orders for house account customers (for visibility)
            unassignedCustomers: []          // Customer not in ANY list
        };

        const customerSummary = new Map(); // Track totals per customer

        yearOrders.forEach(order => {
            const customerId = order.id_Customer;
            const rep = order.CustomerServiceRep;
            const inTaneisha = taneishaIds.has(customerId);
            const inNika = nikaIds.has(customerId);
            const inHouse = houseIds.has(customerId);
            const orderTotal = parseFloat(order.cur_SubTotal) || 0;

            // Determine assignment
            let assignedTo = 'NONE';
            if (inTaneisha) assignedTo = 'Taneisha';
            else if (inNika) assignedTo = 'Nika';
            else if (inHouse) assignedTo = `House (${houseAssignments.get(customerId) || 'Unknown'})`;

            // Build order summary
            const orderInfo = {
                id_Order: order.id_Order,
                id_Customer: customerId,
                CustomerName: order.CustomerName,
                CustomerServiceRep: rep,
                date_Invoiced: order.date_Invoiced?.split('T')[0],
                cur_SubTotal: orderTotal,
                assignedTo: assignedTo
            };

            // Check for mismatches
            if (rep === 'Nika Lao' && inTaneisha && !inNika) {
                // Nika wrote order for customer on Taneisha's list only
                mismatches.nikaOrdersTaneishaCustomer.push(orderInfo);
            } else if (rep === 'Taneisha Clark' && inNika && !inTaneisha) {
                // Taneisha wrote order for customer on Nika's list only
                mismatches.taneishaOrdersNikaCustomer.push(orderInfo);
            } else if (inHouse) {
                // Customer in house accounts - track for visibility but not an issue
                mismatches.houseAccountOrders.push(orderInfo);
            } else if (!inTaneisha && !inNika && includeUnassigned) {
                // Customer not in ANY list
                mismatches.unassignedCustomers.push(orderInfo);
            }
        });

        // Calculate totals
        const nikaWrongTotal = mismatches.nikaOrdersTaneishaCustomer.reduce((sum, o) => sum + o.cur_SubTotal, 0);
        const taneishaWrongTotal = mismatches.taneishaOrdersNikaCustomer.reduce((sum, o) => sum + o.cur_SubTotal, 0);
        const houseTotal = mismatches.houseAccountOrders.reduce((sum, o) => sum + o.cur_SubTotal, 0);
        const unassignedTotal = mismatches.unassignedCustomers.reduce((sum, o) => sum + o.cur_SubTotal, 0);

        // Sort by amount descending
        mismatches.nikaOrdersTaneishaCustomer.sort((a, b) => b.cur_SubTotal - a.cur_SubTotal);
        mismatches.taneishaOrdersNikaCustomer.sort((a, b) => b.cur_SubTotal - a.cur_SubTotal);
        mismatches.houseAccountOrders.sort((a, b) => b.cur_SubTotal - a.cur_SubTotal);
        mismatches.unassignedCustomers.sort((a, b) => b.cur_SubTotal - a.cur_SubTotal);

        // Get unique customers per category
        const getUniqueCustomers = (orders) => {
            const seen = new Set();
            return orders.filter(o => {
                if (seen.has(o.id_Customer)) return false;
                seen.add(o.id_Customer);
                return true;
            }).map(o => ({
                id_Customer: o.id_Customer,
                CustomerName: o.CustomerName,
                assignedTo: o.assignedTo
            }));
        };

        const summary = {
            year: filterYear,
            totalOrdersChecked: yearOrders.length,
            accountLists: {
                taneisha: taneishaIds.size,
                nika: nikaIds.size,
                house: houseIds.size
            },
            issues: {
                nikaOrdersTaneishaCustomer: {
                    count: mismatches.nikaOrdersTaneishaCustomer.length,
                    total: nikaWrongTotal,
                    uniqueCustomers: getUniqueCustomers(mismatches.nikaOrdersTaneishaCustomer).length,
                    description: "Nika wrote orders for customers on Taneisha's list"
                },
                taneishaOrdersNikaCustomer: {
                    count: mismatches.taneishaOrdersNikaCustomer.length,
                    total: taneishaWrongTotal,
                    uniqueCustomers: getUniqueCustomers(mismatches.taneishaOrdersNikaCustomer).length,
                    description: "Taneisha wrote orders for customers on Nika's list"
                },
                unassignedCustomers: {
                    count: mismatches.unassignedCustomers.length,
                    total: unassignedTotal,
                    uniqueCustomers: getUniqueCustomers(mismatches.unassignedCustomers).length,
                    description: "Orders for customers not in ANY list (Taneisha, Nika, or House)"
                }
            },
            houseAccounts: {
                count: mismatches.houseAccountOrders.length,
                total: houseTotal,
                uniqueCustomers: getUniqueCustomers(mismatches.houseAccountOrders).length,
                description: "Orders for House Account customers (not issues - for visibility)"
            },
            totalIssues: mismatches.nikaOrdersTaneishaCustomer.length +
                         mismatches.taneishaOrdersNikaCustomer.length +
                         mismatches.unassignedCustomers.length,
            totalMismatchedRevenue: nikaWrongTotal + taneishaWrongTotal + unassignedTotal
        };

        res.json({
            success: true,
            summary,
            details: mismatches
        });

    } catch (error) {
        console.error('Error running rep audit:', error.message);
        res.status(500).json({ success: false, error: 'Failed to run audit' });
    }
});

// GET /api/rep-audit/summary - Quick summary without order details
router.get('/rep-audit/summary', async (req, res) => {
    try {
        const currentYear = new Date().getFullYear();
        const filterYear = parseInt(req.query.year) || currentYear;

        console.log(`Running rep audit summary for ${filterYear}...`);

        const { fetchOrders, getDateDaysAgo } = require('../utils/manageorders');

        // Get all account lists (Taneisha, Nika, House)
        const [taneishaAccounts, nikaAccounts, houseAccounts] = await Promise.all([
            fetchAllCaspioPages(`/tables/${TANEISHA_TABLE}/records`, {
                'q.select': 'ID_Customer'
            }),
            fetchAllCaspioPages(`/tables/${NIKA_TABLE}/records`, {
                'q.select': 'ID_Customer'
            }),
            fetchAllCaspioPages(`/tables/${HOUSE_TABLE}/records`, {
                'q.select': 'ID_Customer'
            }).catch(() => []) // House table may not exist yet
        ]);

        const taneishaIds = new Set(taneishaAccounts.map(a => a.ID_Customer));
        const nikaIds = new Set(nikaAccounts.map(a => a.ID_Customer));
        const houseIds = new Set(houseAccounts.map(a => a.ID_Customer));

        // Fetch orders
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

        // Filter to requested year
        const yearOrders = allOrders.filter(o => {
            if (!o.date_Invoiced) return false;
            return new Date(o.date_Invoiced).getFullYear() === filterYear;
        });

        // Count issues
        let nikaWrong = 0, nikaWrongAmount = 0;
        let taneishaWrong = 0, taneishaWrongAmount = 0;
        let houseCount = 0, houseAmount = 0;
        let unassigned = 0, unassignedAmount = 0;

        yearOrders.forEach(order => {
            const customerId = order.id_Customer;
            const rep = order.CustomerServiceRep;
            const inTaneisha = taneishaIds.has(customerId);
            const inNika = nikaIds.has(customerId);
            const inHouse = houseIds.has(customerId);
            const amount = parseFloat(order.cur_SubTotal) || 0;

            if (rep === 'Nika Lao' && inTaneisha && !inNika) {
                nikaWrong++;
                nikaWrongAmount += amount;
            } else if (rep === 'Taneisha Clark' && inNika && !inTaneisha) {
                taneishaWrong++;
                taneishaWrongAmount += amount;
            } else if (inHouse) {
                // In house accounts - not an issue, just tracking
                houseCount++;
                houseAmount += amount;
            } else if (!inTaneisha && !inNika) {
                unassigned++;
                unassignedAmount += amount;
            }
        });

        const totalIssues = nikaWrong + taneishaWrong + unassigned;
        const hasIssues = totalIssues > 0;

        res.json({
            success: true,
            year: filterYear,
            status: hasIssues ? 'ISSUES_FOUND' : 'OK',
            totalOrdersChecked: yearOrders.length,
            accountLists: {
                taneisha: taneishaIds.size,
                nika: nikaIds.size,
                house: houseIds.size
            },
            issues: {
                nikaOrdersTaneishaCustomer: { count: nikaWrong, total: nikaWrongAmount },
                taneishaOrdersNikaCustomer: { count: taneishaWrong, total: taneishaWrongAmount },
                unassignedCustomers: { count: unassigned, total: unassignedAmount }
            },
            houseAccounts: { count: houseCount, total: houseAmount },
            totalIssues,
            totalMismatchedRevenue: nikaWrongAmount + taneishaWrongAmount + unassignedAmount,
            message: hasIssues
                ? `Found ${totalIssues} orders with rep/account mismatches`
                : 'All orders match account assignments'
        });

    } catch (error) {
        console.error('Error running rep audit summary:', error.message);
        res.status(500).json({ success: false, error: 'Failed to run audit' });
    }
});

module.exports = router;
