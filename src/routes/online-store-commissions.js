/**
 * Online Store Commission Routes
 *
 * Calculates quarterly commissions for Nika and Taneisha based on
 * InkSoft webstore revenue from the ManageOrders_Orders Caspio table.
 *
 * Endpoints:
 *   GET /api/online-store-commissions/config      — Current config (rates, baselines)
 *   GET /api/online-store-commissions/summary      — Both reps' commission summary
 *   GET /api/online-store-commissions/detail       — Per-company breakdown for one rep
 *
 * Query params:
 *   quarter  — "Q1", "Q2", "Q3", "Q4" (default: current quarter)
 *   year     — 2026, 2027, etc. (default: current year)
 *   rep      — "nika" or "taneisha" (detail endpoint only)
 */

const express = require('express');
const router = express.Router();
const { fetchAllCaspioPages } = require('../utils/caspio');
const commissionConfig = require('../../config/online-store-commission-config');

const TABLE = 'ManageOrders_Orders';

// ── Helpers ─────────────────────────────────────────────────────────────

function getCurrentQuarter() {
    const month = new Date().getMonth(); // 0-indexed
    return `Q${Math.floor(month / 3) + 1}`;
}

function getCurrentYear() {
    return new Date().getFullYear();
}

function getQuarterDateRange(quarter, year) {
    const qDef = commissionConfig.quarters[quarter];
    if (!qDef) return null;
    return {
        start: `${year}-${qDef.start}`,
        end: `${year}-${qDef.end}`,
    };
}

/**
 * Determine the commission rate for a parent company (or specific customer).
 * Checks the newStores registry — if the store is within its 6-month
 * new period, returns the higher rate. Otherwise returns maintenance.
 *
 * For new locations within existing parent companies (e.g., a new Stella Jones
 * department), the newStore entry uses customerId to target only that specific
 * location, not the entire parent company.
 */
function getCommissionRate(parentCompany, rep, quarterEndDate, customerId) {
    // First check for customer-specific new store entries (new locations within existing parents)
    let newStore = null;
    if (customerId) {
        newStore = commissionConfig.newStores.find(
            s => s.customerId && String(s.customerId) === String(customerId) && s.rep === rep
        );
    }
    // Fall back to parent company match (for new companies)
    if (!newStore) {
        newStore = commissionConfig.newStores.find(
            s => !s.customerId && s.parentCompany === parentCompany && s.rep === rep
        );
    }

    if (!newStore) {
        return {
            rate: commissionConfig.commissionRates.maintenance,
            tier: 'maintenance',
            requiresBaseline: true,
        };
    }

    // Check if still within the new store rate period
    const startDate = new Date(newStore.startDate);
    const endDate = new Date(quarterEndDate);
    const monthsElapsed = (endDate.getFullYear() - startDate.getFullYear()) * 12
        + (endDate.getMonth() - startDate.getMonth());

    if (monthsElapsed < commissionConfig.newStoreRateMonths) {
        const rate = newStore.type === 'newCompany'
            ? commissionConfig.commissionRates.newCompany
            : commissionConfig.commissionRates.newLocation;
        return {
            rate,
            tier: newStore.type,
            requiresBaseline: false,
            startDate: newStore.startDate,
            monthsRemaining: commissionConfig.newStoreRateMonths - monthsElapsed,
        };
    }

    // Past 6 months — dropped to maintenance
    return {
        rate: commissionConfig.commissionRates.maintenance,
        tier: 'maintenance',
        requiresBaseline: true,
        transitionedFrom: newStore.type,
    };
}

/**
 * Check setup bonus eligibility for new stores.
 * Returns bonus info if the store has hit the revenue threshold
 * within 12 months and the bonus hasn't been paid yet.
 */
function checkSetupBonus(parentCompany, rep, cumulativeRevenue) {
    const newStore = commissionConfig.newStores.find(
        s => s.parentCompany === parentCompany && s.rep === rep
    );

    if (!newStore || newStore.setupBonusPaid) return null;

    const bonusConfig = commissionConfig.setupBonuses[newStore.type];
    if (!bonusConfig) return null;

    // Check if within 12 months of start
    const startDate = new Date(newStore.startDate);
    const now = new Date();
    const monthsElapsed = (now.getFullYear() - startDate.getFullYear()) * 12
        + (now.getMonth() - startDate.getMonth());

    if (monthsElapsed > 12) return null;

    if (cumulativeRevenue >= bonusConfig.threshold) {
        return {
            eligible: true,
            amount: bonusConfig.amount,
            threshold: bonusConfig.threshold,
            revenueToDate: cumulativeRevenue,
            paid: false,
        };
    }

    return {
        eligible: false,
        amount: bonusConfig.amount,
        threshold: bonusConfig.threshold,
        revenueToDate: cumulativeRevenue,
        remaining: bonusConfig.threshold - cumulativeRevenue,
    };
}

/**
 * Fetch InkSoft orders from Caspio for a given quarter/year.
 * Uses the Is_InkSoft formula field and date_Invoiced range.
 */
async function fetchInkSoftOrders(quarter, year) {
    const dateRange = getQuarterDateRange(quarter, year);
    if (!dateRange) {
        throw new Error(`Invalid quarter: ${quarter}`);
    }

    // Query ManageOrders_Orders for invoiced InkSoft orders in the quarter
    // Using id_OrderType=31 since Is_InkSoft is a formula (can't filter on formulas via API)
    const where = `id_OrderType=31 AND sts_Invoiced=1 AND date_Invoiced>='${dateRange.start}' AND date_Invoiced<='${dateRange.end}'`;

    console.log(`Fetching InkSoft orders: ${where}`);

    const records = await fetchAllCaspioPages(`/tables/${TABLE}/records`, {
        'q.where': where,
        'q.select': 'id_Order,id_Customer,CustomerName,CustomerServiceRep,cur_SubTotal,date_Invoiced,ParentCompany',
        'q.limit': 1000,
    });

    return records;
}

/**
 * Aggregate orders by rep and parent company.
 */
function aggregateOrders(orders) {
    const byRep = {};

    for (const order of orders) {
        const rep = (order.CustomerServiceRep || '').trim();
        const parent = (order.ParentCompany || order.CustomerName || 'Unknown').trim();
        const revenue = parseFloat(order.cur_SubTotal) || 0;

        if (!rep) continue; // Skip orders with no rep

        if (!byRep[rep]) {
            byRep[rep] = { totalRevenue: 0, orderCount: 0, companies: {} };
        }

        byRep[rep].totalRevenue += revenue;
        byRep[rep].orderCount++;

        if (!byRep[rep].companies[parent]) {
            byRep[rep].companies[parent] = { revenue: 0, orderCount: 0, customers: new Set(), customerRevenue: {} };
        }

        byRep[rep].companies[parent].revenue += revenue;
        byRep[rep].companies[parent].orderCount++;
        byRep[rep].companies[parent].customers.add(order.id_Customer);

        // Track per-customer revenue (needed for mixed parent companies with new locations)
        const custId = String(order.id_Customer);
        if (!byRep[rep].companies[parent].customerRevenue[custId]) {
            byRep[rep].companies[parent].customerRevenue[custId] = { revenue: 0, orders: 0 };
        }
        byRep[rep].companies[parent].customerRevenue[custId].revenue += revenue;
        byRep[rep].companies[parent].customerRevenue[custId].orders++;
    }

    return byRep;
}

/**
 * Calculate commission for a rep.
 *
 * Handles mixed parent companies where some locations are new (3%) and
 * others are existing (1%). For example, Stella Jones has 9 departments
 * at 1% but Western Operations (CID 2592) is a new location at 3%.
 */
function calculateRepCommission(rep, repData, quarterEndDate) {
    const repConfig = commissionConfig.reps[rep];
    if (!repConfig) {
        return {
            rep,
            error: `No config for rep: ${rep}`,
        };
    }

    const baseline = repConfig.quarterlyBaseline;
    const totalRevenue = repData.totalRevenue;
    const baselineMet = totalRevenue >= baseline;

    // Check if any new store entries target specific customer IDs within a parent company
    const customerSpecificNewStores = commissionConfig.newStores.filter(s => s.customerId && s.rep === rep);
    const newStoreCustomerIds = new Set(customerSpecificNewStores.map(s => String(s.customerId)));

    // Calculate per-company commissions
    const companies = [];
    let totalMaintenanceCommission = 0;
    let totalNewStoreCommission = 0;

    for (const [parentCompany, companyData] of Object.entries(repData.companies)) {
        // Check if this parent company has any customer-specific new store entries
        const hasNewLocations = customerSpecificNewStores.some(s => s.parentCompany === parentCompany);

        if (hasNewLocations && companyData.customerRevenue) {
            // Split revenue: new location CIDs get their rate, rest gets maintenance
            let newLocationRevenue = 0;
            let maintenanceRevenue = 0;
            let newLocationOrders = 0;
            let maintenanceOrders = 0;

            for (const [cid, custData] of Object.entries(companyData.customerRevenue)) {
                if (newStoreCustomerIds.has(cid)) {
                    newLocationRevenue += custData.revenue;
                    newLocationOrders += custData.orders;
                } else {
                    maintenanceRevenue += custData.revenue;
                    maintenanceOrders += custData.orders;
                }
            }

            // Add maintenance portion
            if (maintenanceRevenue > 0) {
                const maintenanceRate = getCommissionRate(parentCompany, rep, quarterEndDate);
                const maintenanceComm = baselineMet ? maintenanceRevenue * maintenanceRate.rate : 0;
                totalMaintenanceCommission += maintenanceComm;

                companies.push({
                    parentCompany,
                    revenue: Math.round(maintenanceRevenue * 100) / 100,
                    orderCount: maintenanceOrders,
                    locationCount: companyData.customers.size - 1, // Exclude the new location
                    commissionRate: maintenanceRate.rate,
                    commissionTier: 'maintenance',
                    commission: Math.round(maintenanceComm * 100) / 100,
                    requiresBaseline: true,
                });
            }

            // Add new location portion
            if (newLocationRevenue > 0) {
                const newLocStore = customerSpecificNewStores.find(s => s.parentCompany === parentCompany);
                const newLocRate = getCommissionRate(parentCompany, rep, quarterEndDate, newLocStore.customerId);
                const newLocComm = newLocationRevenue * newLocRate.rate;
                totalNewStoreCommission += newLocComm;

                companies.push({
                    parentCompany: `${parentCompany} (New Location)`,
                    revenue: Math.round(newLocationRevenue * 100) / 100,
                    orderCount: newLocationOrders,
                    locationCount: 1,
                    commissionRate: newLocRate.rate,
                    commissionTier: newLocRate.tier,
                    commission: Math.round(newLocComm * 100) / 100,
                    requiresBaseline: false,
                    isNewStore: true,
                });
            }
        } else {
            // Standard case: entire parent company gets one rate
            const rateInfo = getCommissionRate(parentCompany, rep, quarterEndDate);
            let commission = 0;

            if (rateInfo.requiresBaseline) {
                commission = baselineMet ? companyData.revenue * rateInfo.rate : 0;
                totalMaintenanceCommission += commission;
            } else {
                commission = companyData.revenue * rateInfo.rate;
                totalNewStoreCommission += commission;
            }

            companies.push({
                parentCompany,
                revenue: Math.round(companyData.revenue * 100) / 100,
                orderCount: companyData.orderCount,
                locationCount: companyData.customers.size,
                commissionRate: rateInfo.rate,
                commissionTier: rateInfo.tier,
                commission: Math.round(commission * 100) / 100,
                requiresBaseline: rateInfo.requiresBaseline,
                isNewStore: !rateInfo.requiresBaseline,
            });
        }
    }

    // Sort by revenue descending
    companies.sort((a, b) => b.revenue - a.revenue);

    const totalCommission = Math.round((totalMaintenanceCommission + totalNewStoreCommission) * 100) / 100;

    return {
        rep,
        totalRevenue: Math.round(totalRevenue * 100) / 100,
        totalOrders: repData.orderCount,
        quarterlyBaseline: baseline,
        baselineMet,
        baselineProgress: Math.round((totalRevenue / baseline) * 100 * 10) / 10,
        shortfall: baselineMet ? 0 : Math.round((baseline - totalRevenue) * 100) / 100,
        maintenanceCommission: Math.round(totalMaintenanceCommission * 100) / 100,
        newStoreCommission: Math.round(totalNewStoreCommission * 100) / 100,
        totalCommission,
        companyCount: companies.length,
        companies,
    };
}


// ── Routes ──────────────────────────────────────────────────────────────

/**
 * GET /api/online-store-commissions/config
 * Returns current commission configuration (rates, baselines, new stores)
 */
router.get('/online-store-commissions/config', (req, res) => {
    res.json({
        commissionRates: commissionConfig.commissionRates,
        setupBonuses: commissionConfig.setupBonuses,
        newStoreRateMonths: commissionConfig.newStoreRateMonths,
        reps: commissionConfig.reps,
        newStores: commissionConfig.newStores,
        quarters: commissionConfig.quarters,
        revenueField: commissionConfig.revenueField,
    });
});

/**
 * GET /api/online-store-commissions/summary
 * Returns commission summary for both reps.
 *
 * Query params:
 *   quarter — "Q1", "Q2", "Q3", "Q4" (default: current quarter)
 *   year    — 2026, 2027, etc. (default: current year)
 */
router.get('/online-store-commissions/summary', async (req, res) => {
    const quarter = (req.query.quarter || getCurrentQuarter()).toUpperCase();
    const year = parseInt(req.query.year) || getCurrentYear();

    console.log(`GET /api/online-store-commissions/summary - ${quarter} ${year}`);

    try {
        const orders = await fetchInkSoftOrders(quarter, year);
        const byRep = aggregateOrders(orders);

        const dateRange = getQuarterDateRange(quarter, year);
        const results = {};

        for (const [repName, repConfig] of Object.entries(commissionConfig.reps)) {
            const repData = byRep[repName] || { totalRevenue: 0, orderCount: 0, companies: {} };
            results[repName] = calculateRepCommission(repName, repData, dateRange.end);
        }

        res.json({
            quarter,
            year,
            dateRange,
            generatedAt: new Date().toISOString(),
            totalInkSoftOrders: orders.length,
            reps: results,
        });
    } catch (error) {
        console.error('Commission summary error:', error.message);
        res.status(500).json({ error: 'Failed to calculate commissions', details: error.message });
    }
});

/**
 * GET /api/online-store-commissions/detail
 * Returns detailed per-company commission breakdown for one rep.
 *
 * Query params:
 *   quarter — "Q1", "Q2", "Q3", "Q4" (default: current quarter)
 *   year    — 2026, 2027, etc. (default: current year)
 *   rep     — "nika" or "taneisha" (required)
 */
router.get('/online-store-commissions/detail', async (req, res) => {
    const quarter = (req.query.quarter || getCurrentQuarter()).toUpperCase();
    const year = parseInt(req.query.year) || getCurrentYear();
    const repParam = (req.query.rep || '').toLowerCase();

    // Map shorthand to full name
    const repMap = { 'nika': 'Nika Lao', 'taneisha': 'Taneisha Clark' };
    const repName = repMap[repParam];

    if (!repName) {
        return res.status(400).json({ error: 'Missing or invalid rep parameter. Use "nika" or "taneisha".' });
    }

    console.log(`GET /api/online-store-commissions/detail - ${repName} ${quarter} ${year}`);

    try {
        const orders = await fetchInkSoftOrders(quarter, year);
        const byRep = aggregateOrders(orders);

        const dateRange = getQuarterDateRange(quarter, year);
        const repData = byRep[repName] || { totalRevenue: 0, orderCount: 0, companies: {} };
        const result = calculateRepCommission(repName, repData, dateRange.end);

        // Check setup bonuses for new stores
        const setupBonuses = [];
        for (const company of result.companies) {
            const bonus = checkSetupBonus(company.parentCompany, repName, company.revenue);
            if (bonus) {
                setupBonuses.push({
                    parentCompany: company.parentCompany,
                    ...bonus,
                });
            }
        }

        res.json({
            quarter,
            year,
            dateRange,
            generatedAt: new Date().toISOString(),
            ...result,
            setupBonuses,
        });
    } catch (error) {
        console.error('Commission detail error:', error.message);
        res.status(500).json({ error: 'Failed to calculate commissions', details: error.message });
    }
});

module.exports = router;
