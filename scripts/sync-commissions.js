#!/usr/bin/env node
/**
 * NWCA Commission Auto-Sync
 *
 * Runs daily to calculate and save quarterly commission records
 * for Nika Lao and Taneisha Clark to the Commission_Payouts Caspio table.
 *
 * Status flow:
 *   Calculated → Approved (by Erik) → Paid (with paycheck date)
 *
 * IMPORTANT: Records with Status "Approved" or "Paid" are LOCKED.
 * The daily sync will NOT overwrite them — only "Calculated" or new records
 * get updated. This protects approved payouts from being changed.
 *
 * Usage:
 *   npm run sync-commissions                    # Normal daily sync (quarterly only)
 *   npm run sync-commissions -- --annual        # Also calculate annual bonuses
 *   npm run sync-commissions -- --force         # Force recalculate even locked records
 *
 * Annual bonuses auto-run in December. Use --annual flag to run on demand.
 *
 * Heroku Scheduler: npm run sync-commissions (daily at 3 PM UTC / 8 AM Pacific)
 * Should run AFTER sync-manageorders (noon UTC) so order data is fresh.
 */

require('dotenv').config();
const axios = require('axios');

const BASE_URL = process.env.BASE_URL || 'https://caspio-pricing-proxy-ab30a049961a.herokuapp.com';
const CASPIO_BASE = 'https://c3eku948.caspio.com/rest/v2';
const CASPIO_CLIENT_ID = process.env.CASPIO_CLIENT_ID;
const CASPIO_CLIENT_SECRET = process.env.CASPIO_CLIENT_SECRET;
const COMMISSION_TABLE = 'Commission_Payouts';

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── Caspio Auth ─────────────────────────────────────────────────────────
let caspioToken = null;

async function getCaspioToken() {
    if (caspioToken) return caspioToken;
    const resp = await axios.post('https://c3eku948.caspio.com/oauth/token',
        `grant_type=client_credentials&client_id=${CASPIO_CLIENT_ID}&client_secret=${CASPIO_CLIENT_SECRET}`,
        { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
    );
    caspioToken = resp.data.access_token;
    return caspioToken;
}

async function caspioRequest(endpoint, method = 'GET', body = null, retryCount = 0) {
    const token = await getCaspioToken();
    const config = {
        method,
        url: `${CASPIO_BASE}${endpoint}`,
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
        validateStatus: () => true,
        timeout: 30000
    };
    if (body) config.data = body;
    const resp = await axios(config);
    if (resp.status === 429 && retryCount < 3) {
        console.log(`  Rate limited, waiting 62s... (attempt ${retryCount + 1}/3)`);
        await sleep(62000);
        return caspioRequest(endpoint, method, body, retryCount + 1);
    }
    if (resp.status >= 400) {
        const msg = typeof resp.data === 'string' ? resp.data : JSON.stringify(resp.data);
        throw new Error(`Caspio ${method}: ${resp.status} - ${msg.substring(0, 200)}`);
    }
    return resp.data || {};
}

async function caspioReadAll(table, where) {
    const records = [];
    let page = 1;
    while (true) {
        const w = where ? `&q.where=${encodeURIComponent(where)}` : '';
        const data = await caspioRequest(`/tables/${table}/records?q.pageSize=1000&q.pageNumber=${page}${w}`);
        const rows = data.Result || [];
        records.push(...rows);
        if (rows.length < 1000) break;
        page++;
    }
    return records;
}

// ── Quarter Helpers ─────────────────────────────────────────────────────

function getCurrentQuarter() {
    const month = new Date().getMonth();
    return `Q${Math.floor(month / 3) + 1}`;
}

function getCurrentYear() {
    return new Date().getFullYear();
}

function getQuarterPayoutDate(quarter, year) {
    const payoutDates = {
        'Q1': `${year}-04-01`,
        'Q2': `${year}-07-01`,
        'Q3': `${year}-10-01`,
        'Q4': `${year + 1}-01-01`,
    };
    return payoutDates[quarter] || null;
}

// ── Main Sync ───────────────────────────────────────────────────────────

async function main() {
    const args = process.argv.slice(2);
    const isForce = args.includes('--force');
    const isAnnual = args.includes('--annual');
    const isDecember = new Date().getMonth() === 11;
    const runAnnual = isAnnual || isDecember;

    const quarter = getCurrentQuarter();
    const year = getCurrentYear();

    console.log('=== Commission Auto-Sync ===');
    console.log(`Quarter: ${quarter} ${year}`);
    console.log(`Mode: ${isForce ? 'FORCE (will overwrite locked records)' : 'Normal (respects locked records)'}`);
    if (runAnnual) console.log(`Annual bonuses: YES (${isAnnual ? '--annual flag' : 'December auto-run'})`);
    console.log(`Time: ${new Date().toISOString()}`);
    console.log();

    if (!CASPIO_CLIENT_ID || !CASPIO_CLIENT_SECRET) {
        console.error('Missing CASPIO_CLIENT_ID or CASPIO_CLIENT_SECRET');
        process.exit(1);
    }

    // Step 1: Fetch quarterly commission report from API
    console.log('Step 1: Fetching quarterly commission report...');
    let reportData;
    try {
        const resp = await axios.get(
            `${BASE_URL}/api/commissions/quarterly-report?quarter=${quarter}&year=${year}`,
            { timeout: 60000 }
        );
        reportData = resp.data;
        console.log(`  Total InkSoft orders: ${reportData.totalInkSoftOrders}`);
    } catch (err) {
        console.error(`  FATAL: Could not fetch commission report: ${err.message}`);
        process.exit(1);
    }
    console.log();

    // Step 2: Read existing Commission_Payouts records for this quarter
    console.log('Step 2: Reading existing Commission_Payouts records...');
    await getCaspioToken();
    const existingRecords = await caspioReadAll(
        COMMISSION_TABLE,
        `Quarter='${quarter}' AND Year=${year}`
    );
    console.log(`  Found ${existingRecords.length} existing records for ${quarter} ${year}`);

    // Index by rep + type for fast lookup
    const existingMap = {};
    for (const rec of existingRecords) {
        const key = `${rec.Rep}|${rec.Commission_Type}`;
        existingMap[key] = rec;
    }
    console.log();

    // Step 3: Build commission records to save
    console.log('Step 3: Saving commission records...');
    let stats = { created: 0, updated: 0, locked: 0, errors: 0 };

    for (const [repName, repData] of Object.entries(reportData.reps || {})) {
        const online = repData.onlineStore || {};
        const spiffs = repData.garmentSpiffs || {};
        const winBack = repData.winBack || {};

        // Commission types to save
        const commissions = [
            {
                type: 'Online Store',
                revenueBase: online.totalRevenue || 0,
                rateApplied: 0.01,
                calculatedAmount: online.totalCommission || 0,
                bonusTier: online.baselineMet ? 'Baseline Met' : 'Below Baseline',
                details: {
                    baseline: online.baseline,
                    baselineMet: online.baselineMet,
                    baselineProgress: online.baselineProgress,
                    maintenanceCommission: online.maintenanceCommission,
                    newStoreCommission: online.newStoreCommission,
                    companyCount: (online.companies || []).length,
                    orderCount: online.orderCount,
                },
            },
            {
                type: 'Garment Spiff',
                revenueBase: 0, // Not revenue-based
                rateApplied: 0,
                calculatedAmount: spiffs.totalBonus || 0,
                bonusTier: '',
                details: {
                    totalQuantity: spiffs.totalQuantity,
                    orderCount: spiffs.orderCount,
                    items: spiffs.items,
                },
            },
            {
                type: 'Win-Back Bounty',
                revenueBase: winBack.totalRevenue || 0,
                rateApplied: 0.05,
                calculatedAmount: winBack.bountyAmount || 0,
                bonusTier: '',
                details: {
                    totalAccounts: winBack.totalAccounts,
                    accountsWithSales: winBack.accountsWithSales,
                    topAccounts: (winBack.topAccounts || []).slice(0, 10),
                },
            },
        ];

        for (const comm of commissions) {
            const key = `${repName}|${comm.type}`;
            const existing = existingMap[key];

            const record = {
                Rep: repName,
                Commission_Type: comm.type,
                Quarter: quarter,
                Year: year,
                Revenue_Base: Math.round(comm.revenueBase * 100) / 100,
                Rate_Applied: comm.rateApplied,
                Calculated_Amount: Math.round(comm.calculatedAmount * 100) / 100,
                Bonus_Tier: comm.bonusTier,
                Details_JSON: JSON.stringify(comm.details),
                Last_Calculated: new Date().toISOString(),
            };

            try {
                if (existing) {
                    // Check if locked
                    const status = (existing.Status || '').trim();
                    if ((status === 'Approved' || status === 'Paid') && !isForce) {
                        console.log(`  LOCKED: ${repName} | ${comm.type} (Status: ${status}) — skipping`);
                        stats.locked++;
                        continue;
                    }

                    // Update existing
                    record.Status = existing.Status || 'Calculated';
                    await caspioRequest(
                        `/tables/${COMMISSION_TABLE}/records?q.where=${encodeURIComponent(`ID_Commission=${existing.ID_Commission}`)}`,
                        'PUT', record
                    );
                    console.log(`  UPDATED: ${repName} | ${comm.type} = $${record.Calculated_Amount}`);
                    stats.updated++;
                } else {
                    // Create new
                    record.Status = 'Calculated';
                    await caspioRequest(`/tables/${COMMISSION_TABLE}/records`, 'POST', record);
                    console.log(`  CREATED: ${repName} | ${comm.type} = $${record.Calculated_Amount}`);
                    stats.created++;
                }
                await sleep(300);
            } catch (err) {
                console.error(`  ERROR: ${repName} | ${comm.type}: ${err.message}`);
                stats.errors++;
            }
        }
    }

    // Summary
    console.log();
    console.log('=== SYNC COMPLETE ===');
    console.log(`  Created:  ${stats.created}`);
    console.log(`  Updated:  ${stats.updated}`);
    console.log(`  Locked:   ${stats.locked} (Approved/Paid — not overwritten)`);
    console.log(`  Errors:   ${stats.errors}`);
    console.log();

    // Print quarterly totals
    for (const [repName, repData] of Object.entries(reportData.reps || {})) {
        console.log(`  ${repName}: $${repData.quarterlyTotal} total`);
        console.log(`    Online Store: $${repData.onlineStore?.totalCommission || 0}`);
        console.log(`    Garment Spiffs: $${repData.garmentSpiffs?.totalBonus || 0}`);
        console.log(`    Win-Back: $${repData.winBack?.bountyAmount || 0}`);
    }

    // ── Step 4: Annual Bonus Calculations ──────────────────────────────
    if (runAnnual) {
        console.log();
        console.log('Step 4: Calculating annual bonuses...');

        let annualData;
        try {
            const resp = await axios.get(
                `${BASE_URL}/api/commissions/annual-report?year=${year}`,
                { timeout: 120000 } // 2 min timeout — heavier queries
            );
            annualData = resp.data;
        } catch (err) {
            console.error(`  FATAL: Could not fetch annual report: ${err.message}`);
            console.log('  Annual sync skipped. Quarterly sync was successful.');
            return;
        }

        // Read existing annual records
        const existingAnnual = await caspioReadAll(
            COMMISSION_TABLE,
            `Quarter='Annual' AND Year=${year}`
        );
        const annualMap = {};
        for (const rec of existingAnnual) {
            annualMap[`${rec.Rep}|${rec.Commission_Type}`] = rec;
        }

        let annualStats = { created: 0, updated: 0, locked: 0, errors: 0 };

        for (const [repName, repData] of Object.entries(annualData.reps || {})) {
            const annualCommissions = [
                {
                    type: 'Retention Bonus',
                    revenueBase: 0,
                    rateApplied: 0,
                    calculatedAmount: repData.retention?.bonusAmount || 0,
                    bonusTier: repData.retention?.bonusTier || '',
                    details: repData.retention || {},
                },
                {
                    type: 'Growth Bonus',
                    revenueBase: repData.growth?.prevYearRevenue || 0,
                    rateApplied: 0,
                    calculatedAmount: repData.growth?.bonusAmount || 0,
                    bonusTier: repData.growth?.bonusTier || '',
                    details: repData.growth || {},
                },
                {
                    type: 'New Business Bonus',
                    revenueBase: repData.newBusiness?.totalNewRevenue || 0,
                    rateApplied: 0,
                    calculatedAmount: repData.newBusiness?.bonusAmount || 0,
                    bonusTier: repData.newBusiness?.bonusTier || '',
                    details: repData.newBusiness || {},
                },
            ];

            for (const comm of annualCommissions) {
                const key = `${repName}|${comm.type}`;
                const existing = annualMap[key];

                const record = {
                    Rep: repName,
                    Commission_Type: comm.type,
                    Quarter: 'Annual',
                    Year: year,
                    Revenue_Base: Math.round(comm.revenueBase * 100) / 100,
                    Rate_Applied: comm.rateApplied,
                    Calculated_Amount: Math.round(comm.calculatedAmount * 100) / 100,
                    Bonus_Tier: comm.bonusTier,
                    Details_JSON: JSON.stringify(comm.details),
                    Last_Calculated: new Date().toISOString(),
                };

                try {
                    if (existing) {
                        const status = (existing.Status || '').trim();
                        if ((status === 'Approved' || status === 'Paid') && !isForce) {
                            console.log(`  LOCKED: ${repName} | ${comm.type} (Status: ${status})`);
                            annualStats.locked++;
                            continue;
                        }
                        record.Status = existing.Status || 'Calculated';
                        await caspioRequest(
                            `/tables/${COMMISSION_TABLE}/records?q.where=${encodeURIComponent(`ID_Commission=${existing.ID_Commission}`)}`,
                            'PUT', record
                        );
                        console.log(`  UPDATED: ${repName} | ${comm.type} = $${record.Calculated_Amount} (${comm.bonusTier})`);
                        annualStats.updated++;
                    } else {
                        record.Status = 'Calculated';
                        await caspioRequest(`/tables/${COMMISSION_TABLE}/records`, 'POST', record);
                        console.log(`  CREATED: ${repName} | ${comm.type} = $${record.Calculated_Amount} (${comm.bonusTier})`);
                        annualStats.created++;
                    }
                    await sleep(300);
                } catch (err) {
                    console.error(`  ERROR: ${repName} | ${comm.type}: ${err.message}`);
                    annualStats.errors++;
                }
            }
        }

        console.log();
        console.log('=== ANNUAL BONUS SYNC COMPLETE ===');
        console.log(`  Created:  ${annualStats.created}`);
        console.log(`  Updated:  ${annualStats.updated}`);
        console.log(`  Locked:   ${annualStats.locked}`);
        console.log(`  Errors:   ${annualStats.errors}`);
        console.log();

        for (const [repName, repData] of Object.entries(annualData.reps || {})) {
            console.log(`  ${repName}: $${repData.totalAnnualBonus} total annual bonus`);
            console.log(`    Retention: $${repData.retention?.bonusAmount || 0} (${repData.retention?.retentionPct || 0}%)`);
            console.log(`    Growth: $${repData.growth?.bonusAmount || 0} (${repData.growth?.growthPct || 0}%)`);
            console.log(`    New Business: $${repData.newBusiness?.bonusAmount || 0} ($${repData.newBusiness?.totalNewRevenue || 0})`);
        }
    }
}

main().catch(err => {
    console.error(`\nFATAL: ${err.message}`);
    process.exit(1);
});
