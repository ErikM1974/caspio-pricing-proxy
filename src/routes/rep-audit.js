// Rep Audit Routes - Cross-check orders against account assignments
// Ensures sales reps only get credit for customers on their list

const express = require('express');
const router = express.Router();
const { fetchAllCaspioPages } = require('../utils/caspio');

const TANEISHA_TABLE = 'Taneisha_All_Accounts_Caspio';
const NIKA_TABLE = 'Nika_All_Accounts_Caspio';

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

        // Step 1: Get both account lists
        console.log('Fetching account lists...');
        const [taneishaAccounts, nikaAccounts] = await Promise.all([
            fetchAllCaspioPages(`/tables/${TANEISHA_TABLE}/records`, {
                'q.select': 'ID_Customer,CompanyName'
            }),
            fetchAllCaspioPages(`/tables/${NIKA_TABLE}/records`, {
                'q.select': 'ID_Customer,CompanyName'
            })
        ]);

        const taneishaIds = new Set(taneishaAccounts.map(a => a.ID_Customer));
        const nikaIds = new Set(nikaAccounts.map(a => a.ID_Customer));

        console.log(`Taneisha: ${taneishaIds.size} accounts, Nika: ${nikaIds.size} accounts`);

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
            unassignedCustomers: []          // Customer not in either list
        };

        const customerSummary = new Map(); // Track totals per customer

        yearOrders.forEach(order => {
            const customerId = order.id_Customer;
            const rep = order.CustomerServiceRep;
            const inTaneisha = taneishaIds.has(customerId);
            const inNika = nikaIds.has(customerId);
            const orderTotal = parseFloat(order.cur_SubTotal) || 0;

            // Build order summary
            const orderInfo = {
                id_Order: order.id_Order,
                id_Customer: customerId,
                CustomerName: order.CustomerName,
                CustomerServiceRep: rep,
                date_Invoiced: order.date_Invoiced?.split('T')[0],
                cur_SubTotal: orderTotal,
                assignedTo: inTaneisha ? 'Taneisha' : (inNika ? 'Nika' : 'NONE')
            };

            // Check for mismatches
            if (rep === 'Nika Lao' && inTaneisha && !inNika) {
                // Nika wrote order for customer on Taneisha's list only
                mismatches.nikaOrdersTaneishaCustomer.push(orderInfo);
            } else if (rep === 'Taneisha Clark' && inNika && !inTaneisha) {
                // Taneisha wrote order for customer on Nika's list only
                mismatches.taneishaOrdersNikaCustomer.push(orderInfo);
            } else if (!inTaneisha && !inNika && includeUnassigned) {
                // Customer not in either list
                mismatches.unassignedCustomers.push(orderInfo);
            }
        });

        // Calculate totals
        const nikaWrongTotal = mismatches.nikaOrdersTaneishaCustomer.reduce((sum, o) => sum + o.cur_SubTotal, 0);
        const taneishaWrongTotal = mismatches.taneishaOrdersNikaCustomer.reduce((sum, o) => sum + o.cur_SubTotal, 0);
        const unassignedTotal = mismatches.unassignedCustomers.reduce((sum, o) => sum + o.cur_SubTotal, 0);

        // Sort by amount descending
        mismatches.nikaOrdersTaneishaCustomer.sort((a, b) => b.cur_SubTotal - a.cur_SubTotal);
        mismatches.taneishaOrdersNikaCustomer.sort((a, b) => b.cur_SubTotal - a.cur_SubTotal);
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
                    description: "Orders for customers not in either list"
                }
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

        // Get both account lists
        const [taneishaAccounts, nikaAccounts] = await Promise.all([
            fetchAllCaspioPages(`/tables/${TANEISHA_TABLE}/records`, {
                'q.select': 'ID_Customer'
            }),
            fetchAllCaspioPages(`/tables/${NIKA_TABLE}/records`, {
                'q.select': 'ID_Customer'
            })
        ]);

        const taneishaIds = new Set(taneishaAccounts.map(a => a.ID_Customer));
        const nikaIds = new Set(nikaAccounts.map(a => a.ID_Customer));

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
        let unassigned = 0, unassignedAmount = 0;

        yearOrders.forEach(order => {
            const customerId = order.id_Customer;
            const rep = order.CustomerServiceRep;
            const inTaneisha = taneishaIds.has(customerId);
            const inNika = nikaIds.has(customerId);
            const amount = parseFloat(order.cur_SubTotal) || 0;

            if (rep === 'Nika Lao' && inTaneisha && !inNika) {
                nikaWrong++;
                nikaWrongAmount += amount;
            } else if (rep === 'Taneisha Clark' && inNika && !inTaneisha) {
                taneishaWrong++;
                taneishaWrongAmount += amount;
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
            issues: {
                nikaOrdersTaneishaCustomer: { count: nikaWrong, total: nikaWrongAmount },
                taneishaOrdersNikaCustomer: { count: taneishaWrong, total: taneishaWrongAmount },
                unassignedCustomers: { count: unassigned, total: unassignedAmount }
            },
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
