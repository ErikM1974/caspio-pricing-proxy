/**
 * Commission Payouts Routes
 *
 * Unified commission tracking for Nika and Taneisha.
 * Calculates all quarterly commissions from their data sources,
 * stores payment records in Commission_Payouts Caspio table,
 * and provides a single API for the commission dashboard.
 *
 * Endpoints:
 *   GET  /api/commissions/quarterly-report  — Unified report (all 3 quarterly types)
 *   GET  /api/commissions/win-back          — Win-back bounty calculation
 *   GET  /api/commissions/history           — Payment history from Commission_Payouts
 *   POST /api/commissions/save              — Save/update commission payout record
 *   POST /api/commissions/approve           — Mark payout as approved
 *   POST /api/commissions/mark-paid         — Mark payout as paid
 */

const express = require('express');
const router = express.Router();
const { fetchAllCaspioPages, makeCaspioRequest } = require('../utils/caspio');
const config = require('../../config');

const COMMISSION_TABLE = 'Commission_Payouts';
const TANEISHA_ACCOUNTS_TABLE = 'Taneisha_All_Accounts_Caspio';
const NIKA_ACCOUNTS_TABLE = 'Nika_All_Accounts_Caspio';

const caspioApiBaseUrl = config.caspio.apiBaseUrl;

// ── Helpers ─────────────────────────────────────────────────────────────

function getCurrentQuarter() {
    const month = new Date().getMonth();
    return `Q${Math.floor(month / 3) + 1}`;
}

function getCurrentYear() {
    return new Date().getFullYear();
}

/**
 * Fetch online store commission data from existing endpoint (internal call)
 */
async function getOnlineStoreCommission(quarter, year) {
    try {
        // Import the commission calculation logic directly
        const commissionConfig = require('../../config/online-store-commission-config');
        const { fetchAllCaspioPages: fetchPages } = require('../utils/caspio');

        const qDef = commissionConfig.quarters[quarter];
        if (!qDef) return null;

        const dateRange = {
            start: `${year}-${qDef.start}`,
            end: `${year}-${qDef.end}`,
        };

        const where = `id_OrderType=31 AND sts_Invoiced=1 AND date_Invoiced>='${dateRange.start}' AND date_Invoiced<='${dateRange.end}'`;
        const orders = await fetchPages('/tables/ManageOrders_Orders/records', {
            'q.where': where,
            'q.select': 'id_Order,id_Customer,CustomerName,CustomerServiceRep,cur_SubTotal,date_Invoiced,ParentCompany',
            'q.limit': 1000,
        });

        // Aggregate by rep
        const byRep = {};
        for (const order of orders) {
            const rep = (order.CustomerServiceRep || '').trim();
            const parent = (order.ParentCompany || order.CustomerName || 'Unknown').trim();
            const revenue = parseFloat(order.cur_SubTotal) || 0;
            if (!rep) continue;

            if (!byRep[rep]) byRep[rep] = { totalRevenue: 0, orderCount: 0, companies: {} };
            byRep[rep].totalRevenue += revenue;
            byRep[rep].orderCount++;

            if (!byRep[rep].companies[parent]) {
                byRep[rep].companies[parent] = { revenue: 0, orderCount: 0 };
            }
            byRep[rep].companies[parent].revenue += revenue;
            byRep[rep].companies[parent].orderCount++;
        }

        // Calculate commission per rep
        const results = {};
        for (const [repName, repConfig] of Object.entries(commissionConfig.reps)) {
            const repData = byRep[repName] || { totalRevenue: 0, orderCount: 0, companies: {} };
            const baseline = repConfig.quarterlyBaseline;
            const baselineMet = repData.totalRevenue >= baseline;

            // For now, all stores are maintenance (1%)
            // New store logic handled separately via commissionConfig.newStores
            let maintenanceCommission = baselineMet ? repData.totalRevenue * 0.01 : 0;
            let newStoreCommission = 0;

            // Check new stores
            for (const newStore of commissionConfig.newStores) {
                if (newStore.rep !== repName) continue;
                const startDate = new Date(newStore.startDate);
                const endDate = new Date(dateRange.end);
                const monthsElapsed = (endDate.getFullYear() - startDate.getFullYear()) * 12
                    + (endDate.getMonth() - startDate.getMonth());

                if (monthsElapsed < commissionConfig.newStoreRateMonths) {
                    const rate = newStore.type === 'newCompany' ? 0.05 : 0.03;
                    const parentName = newStore.parentCompany;

                    // Find revenue for this new store's parent company
                    // For customer-specific (new location), we'd need to split
                    // For simplicity, check if parent exists in data
                    if (newStore.customerId) {
                        // New location within existing parent — find orders for this specific CID
                        let newLocRevenue = 0;
                        for (const order of orders) {
                            if (String(order.id_Customer) === String(newStore.customerId) &&
                                (order.CustomerServiceRep || '').trim() === repName) {
                                newLocRevenue += parseFloat(order.cur_SubTotal) || 0;
                            }
                        }
                        if (newLocRevenue > 0) {
                            newStoreCommission += newLocRevenue * rate;
                            // Remove this amount from maintenance calc
                            maintenanceCommission -= baselineMet ? newLocRevenue * 0.01 : 0;
                        }
                    } else {
                        // New company — entire parent company at higher rate
                        const companyData = repData.companies[parentName];
                        if (companyData) {
                            newStoreCommission += companyData.revenue * rate;
                            maintenanceCommission -= baselineMet ? companyData.revenue * 0.01 : 0;
                        }
                    }
                }
            }

            const companies = Object.entries(repData.companies)
                .map(([name, data]) => ({ parentCompany: name, ...data }))
                .sort((a, b) => b.revenue - a.revenue);

            results[repName] = {
                totalRevenue: Math.round(repData.totalRevenue * 100) / 100,
                orderCount: repData.orderCount,
                baseline,
                baselineMet,
                baselineProgress: Math.round((repData.totalRevenue / baseline) * 1000) / 10,
                maintenanceCommission: Math.round(Math.max(0, maintenanceCommission) * 100) / 100,
                newStoreCommission: Math.round(newStoreCommission * 100) / 100,
                totalCommission: Math.round((Math.max(0, maintenanceCommission) + newStoreCommission) * 100) / 100,
                companies,
            };
        }

        return { totalOrders: orders.length, dateRange, reps: results };
    } catch (err) {
        console.error('Online store commission error:', err.message);
        return null;
    }
}

/**
 * Fetch garment tracker spiff data from GarmentTrackerArchive
 */
async function getGarmentSpiffs(quarter, year) {
    try {
        const quarterLabel = `${year}-${quarter}`;
        const records = await fetchAllCaspioPages('/tables/GarmentTrackerArchive/records', {
            'q.where': `Quarter='${quarterLabel}'`,
        });

        const byRep = {};
        for (const record of records) {
            const rep = record.RepName;
            if (!byRep[rep]) {
                byRep[rep] = { totalBonus: 0, totalQuantity: 0, items: {}, orderCount: new Set() };
            }
            byRep[rep].totalBonus += record.BonusAmount || 0;
            byRep[rep].totalQuantity += record.Quantity || 0;
            byRep[rep].orderCount.add(record.OrderNumber);

            const key = record.StyleCategory === 'Richardson' ? 'Richardson Caps' : record.PartNumber;
            if (!byRep[rep].items[key]) {
                byRep[rep].items[key] = { name: record.StyleCategory === 'Richardson' ? 'Richardson Caps' : key, quantity: 0, bonus: 0 };
            }
            byRep[rep].items[key].quantity += record.Quantity || 0;
            byRep[rep].items[key].bonus += record.BonusAmount || 0;
        }

        const results = {};
        for (const [rep, data] of Object.entries(byRep)) {
            results[rep] = {
                totalBonus: Math.round(data.totalBonus * 100) / 100,
                totalQuantity: data.totalQuantity,
                orderCount: data.orderCount.size,
                items: Object.values(data.items).sort((a, b) => b.bonus - a.bonus),
            };
        }

        return results;
    } catch (err) {
        console.error('Garment spiff error:', err.message);
        return {};
    }
}

/**
 * Fetch win-back bounty data from rep account tables
 */
async function getWinBackBounty() {
    try {
        const results = {};

        for (const [rep, table] of [['Nika Lao', NIKA_ACCOUNTS_TABLE], ['Taneisha Clark', TANEISHA_ACCOUNTS_TABLE]]) {
            const accounts = await fetchAllCaspioPages(`/tables/${table}/records`, {
                'q.where': "Account_Tier LIKE '%WIN BACK%' OR Account_Tier LIKE '%Win Back%'",
                'q.select': 'ID_Customer,CompanyName,Account_Tier,YTD_Sales_2026,Order_Count_2026',
            });

            let totalRevenue = 0;
            let accountCount = 0;
            let accountsWithSales = 0;
            const topAccounts = [];

            for (const account of accounts) {
                const ytdSales = parseFloat(account.YTD_Sales_2026) || 0;
                accountCount++;
                totalRevenue += ytdSales;
                if (ytdSales > 0) {
                    accountsWithSales++;
                    topAccounts.push({
                        company: account.CompanyName,
                        customerId: account.ID_Customer,
                        revenue: ytdSales,
                        orderCount: parseInt(account.Order_Count_2026) || 0,
                    });
                }
            }

            topAccounts.sort((a, b) => b.revenue - a.revenue);

            results[rep] = {
                totalRevenue: Math.round(totalRevenue * 100) / 100,
                bountyAmount: Math.round(totalRevenue * 0.05 * 100) / 100,
                rate: 0.05,
                totalAccounts: accountCount,
                accountsWithSales,
                topAccounts: topAccounts.slice(0, 20), // Top 20 for display
            };
        }

        return results;
    } catch (err) {
        console.error('Win-back bounty error:', err.message);
        return {};
    }
}


// ── Routes ──────────────────────────────────────────────────────────────

/**
 * GET /api/commissions/quarterly-report
 * Unified quarterly commission report — all 3 types for both reps.
 *
 * Query params:
 *   quarter — "Q1", "Q2", "Q3", "Q4" (default: current)
 *   year    — 2026, 2027, etc. (default: current)
 */
router.get('/commissions/quarterly-report', async (req, res) => {
    const quarter = (req.query.quarter || getCurrentQuarter()).toUpperCase();
    const year = parseInt(req.query.year) || getCurrentYear();

    console.log(`GET /api/commissions/quarterly-report - ${quarter} ${year}`);

    try {
        // Fetch all 3 commission types in parallel
        const [onlineStore, garmentSpiffs, winBack] = await Promise.all([
            getOnlineStoreCommission(quarter, year),
            getGarmentSpiffs(quarter, year),
            getWinBackBounty(),
        ]);

        // Build unified report per rep
        const reps = {};
        for (const repName of ['Nika Lao', 'Taneisha Clark']) {
            const online = onlineStore?.reps?.[repName] || { totalCommission: 0, totalRevenue: 0 };
            const spiffs = garmentSpiffs?.[repName] || { totalBonus: 0 };
            const winBackData = winBack?.[repName] || { bountyAmount: 0, totalRevenue: 0 };

            const quarterlyTotal = Math.round((
                online.totalCommission +
                spiffs.totalBonus +
                winBackData.bountyAmount
            ) * 100) / 100;

            reps[repName] = {
                onlineStore: online,
                garmentSpiffs: spiffs,
                winBack: winBackData,
                quarterlyTotal,
            };
        }

        res.json({
            quarter,
            year,
            generatedAt: new Date().toISOString(),
            totalInkSoftOrders: onlineStore?.totalOrders || 0,
            reps,
        });
    } catch (err) {
        console.error('Quarterly report error:', err.message);
        res.status(500).json({ error: 'Failed to generate quarterly report', details: err.message });
    }
});

/**
 * GET /api/commissions/win-back
 * Win-back bounty calculation from rep account tables.
 *
 * Query params:
 *   rep — "nika" or "taneisha" (optional, returns both if omitted)
 */
router.get('/commissions/win-back', async (req, res) => {
    const repParam = (req.query.rep || '').toLowerCase();

    console.log(`GET /api/commissions/win-back - rep=${repParam || 'all'}`);

    try {
        const winBack = await getWinBackBounty();

        if (repParam) {
            const repMap = { 'nika': 'Nika Lao', 'taneisha': 'Taneisha Clark' };
            const repName = repMap[repParam];
            if (!repName) {
                return res.status(400).json({ error: 'Invalid rep. Use "nika" or "taneisha".' });
            }
            return res.json({ rep: repName, ...winBack[repName] });
        }

        res.json(winBack);
    } catch (err) {
        console.error('Win-back error:', err.message);
        res.status(500).json({ error: 'Failed to calculate win-back bounty', details: err.message });
    }
});

/**
 * GET /api/commissions/history
 * Payment history from Commission_Payouts table.
 *
 * Query params:
 *   rep     — "nika" or "taneisha" (optional)
 *   year    — 2026 (optional)
 *   quarter — "Q1" (optional)
 *   status  — "Pending", "Approved", "Paid" (optional)
 */
router.get('/commissions/history', async (req, res) => {
    const repParam = (req.query.rep || '').toLowerCase();
    const year = req.query.year;
    const quarter = req.query.quarter;
    const status = req.query.status;

    console.log(`GET /api/commissions/history`);

    try {
        const whereClauses = [];
        if (repParam) {
            const repMap = { 'nika': 'Nika Lao', 'taneisha': 'Taneisha Clark' };
            const repName = repMap[repParam];
            if (repName) whereClauses.push(`Rep='${repName}'`);
        }
        if (year) whereClauses.push(`Year=${year}`);
        if (quarter) whereClauses.push(`Quarter='${quarter}'`);
        if (status) whereClauses.push(`Status='${status}'`);

        const params = { 'q.orderBy': 'Year DESC, Quarter DESC, Commission_Type ASC' };
        if (whereClauses.length > 0) {
            params['q.where'] = whereClauses.join(' AND ');
        }

        const records = await fetchAllCaspioPages(`/tables/${COMMISSION_TABLE}/records`, params);
        res.json({ count: records.length, records });
    } catch (err) {
        console.error('Commission history error:', err.message);
        res.status(500).json({ error: 'Failed to fetch commission history', details: err.message });
    }
});

/**
 * POST /api/commissions/save
 * Save or update a commission payout record.
 * If a record exists for the same rep/type/quarter/year, it updates.
 * Otherwise creates a new record.
 */
router.post('/commissions/save', async (req, res) => {
    const { rep, commissionType, quarter, year, revenueBase, rateApplied,
            calculatedAmount, bonusTier, detailsJSON, notes } = req.body;

    if (!rep || !commissionType || !quarter || !year) {
        return res.status(400).json({ error: 'Missing required fields: rep, commissionType, quarter, year' });
    }

    console.log(`POST /api/commissions/save - ${rep} ${commissionType} ${quarter} ${year}`);

    try {
        // Check if record already exists
        const existing = await fetchAllCaspioPages(`/tables/${COMMISSION_TABLE}/records`, {
            'q.where': `Rep='${rep}' AND Commission_Type='${commissionType}' AND Quarter='${quarter}' AND Year=${year}`,
        });

        const record = {
            Rep: rep,
            Commission_Type: commissionType,
            Quarter: quarter,
            Year: parseInt(year),
            Revenue_Base: parseFloat(revenueBase) || 0,
            Rate_Applied: parseFloat(rateApplied) || 0,
            Calculated_Amount: parseFloat(calculatedAmount) || 0,
            Bonus_Tier: bonusTier || '',
            Details_JSON: typeof detailsJSON === 'string' ? detailsJSON : JSON.stringify(detailsJSON || {}),
            Status: 'Pending',
            Notes: notes || '',
            Last_Calculated: new Date().toISOString(),
        };

        if (existing.length > 0) {
            // Update existing
            const id = existing[0].ID_Commission;
            await makeCaspioRequest('put',
                `/tables/${COMMISSION_TABLE}/records?q.where=${encodeURIComponent(`ID_Commission=${id}`)}`,
                {}, record
            );
            res.json({ action: 'updated', id, ...record });
        } else {
            // Create new
            const result = await makeCaspioRequest('post',
                `/tables/${COMMISSION_TABLE}/records`,
                {}, record
            );
            res.json({ action: 'created', ...record });
        }
    } catch (err) {
        console.error('Save commission error:', err.message);
        res.status(500).json({ error: 'Failed to save commission', details: err.message });
    }
});

/**
 * POST /api/commissions/approve
 * Mark a commission payout as approved.
 * Body: { id, approvedBy }
 */
router.post('/commissions/approve', async (req, res) => {
    const { id, approvedBy } = req.body;

    if (!id) {
        return res.status(400).json({ error: 'Missing required field: id' });
    }

    console.log(`POST /api/commissions/approve - ID ${id}`);

    try {
        await makeCaspioRequest('put',
            `/tables/${COMMISSION_TABLE}/records?q.where=${encodeURIComponent(`ID_Commission=${id}`)}`,
            {}, {
                Status: 'Approved',
                Approved_By: approvedBy || 'Erik',
                Approved_Date: new Date().toISOString(),
            }
        );
        res.json({ success: true, id, status: 'Approved' });
    } catch (err) {
        console.error('Approve error:', err.message);
        res.status(500).json({ error: 'Failed to approve', details: err.message });
    }
});

/**
 * POST /api/commissions/mark-paid
 * Mark a commission payout as paid.
 * Body: { id, paidDate, paycheckDate }
 */
router.post('/commissions/mark-paid', async (req, res) => {
    const { id, paidDate, paycheckDate } = req.body;

    if (!id) {
        return res.status(400).json({ error: 'Missing required field: id' });
    }

    console.log(`POST /api/commissions/mark-paid - ID ${id}`);

    try {
        await makeCaspioRequest('put',
            `/tables/${COMMISSION_TABLE}/records?q.where=${encodeURIComponent(`ID_Commission=${id}`)}`,
            {}, {
                Status: 'Paid',
                Paid_Date: paidDate || new Date().toISOString(),
                Paycheck_Date: paycheckDate || null,
            }
        );
        res.json({ success: true, id, status: 'Paid' });
    } catch (err) {
        console.error('Mark paid error:', err.message);
        res.status(500).json({ error: 'Failed to mark paid', details: err.message });
    }
});

module.exports = router;
