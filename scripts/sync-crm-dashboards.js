#!/usr/bin/env node
/**
 * NWCA CRM Dashboard Sync
 *
 * Syncs all CRM dashboard data from ManageOrders to Caspio:
 * - Account ownership (which customers belong to each rep)
 * - Sales data (YTD totals with hybrid archive+fresh pattern)
 *
 * This script runs:
 * 1. Ownership sync for Nika and Taneisha (from ShopWorks Sales_Reps_2026)
 * 2. Sales sync for Nika, Taneisha, and House (from ManageOrders + archive)
 *
 * Usage:
 *   npm run sync-crm-dashboards                    # Sync all CRM dashboards
 *   npm run sync-crm-dashboards -- --sales-only   # Skip ownership, sync sales only
 *   npm run sync-crm-dashboards -- --ownership-only # Sync ownership only
 *
 * Environment:
 *   BASE_URL - API base URL (defaults to Heroku production)
 *
 * Heroku Scheduler:
 *   Run daily at 6 AM Pacific (14:00 UTC): npm run sync-crm-dashboards
 */

const axios = require('axios');

const BASE_URL = process.env.BASE_URL || 'https://caspio-pricing-proxy-ab30a049961a.herokuapp.com';
const TIMEOUT = 300000; // 5 minutes for sync operations

/**
 * Sync ownership for a rep dashboard
 */
async function syncOwnership(repName, endpoint) {
    console.log(`\n[${new Date().toISOString()}] Syncing ${repName} account ownership...`);

    try {
        const response = await axios.post(
            `${BASE_URL}${endpoint}`,
            {},
            {
                headers: { 'Content-Type': 'application/json' },
                timeout: TIMEOUT
            }
        );

        const result = response.data;
        if (result.summary) {
            console.log(`  - Added: ${result.summary.added || 0}`);
            console.log(`  - Removed: ${result.summary.removed || 0}`);
            console.log(`  - Unchanged: ${result.summary.unchanged || 0}`);
        }
        console.log(`  - Status: SUCCESS`);

        return { success: true, rep: repName, result };
    } catch (error) {
        const errorMsg = error.response?.data?.error || error.message;
        console.error(`  - FAILED: ${errorMsg}`);
        return { success: false, rep: repName, error: errorMsg };
    }
}

/**
 * Sync sales for a dashboard
 */
async function syncSales(dashboardName, endpoint) {
    console.log(`\n[${new Date().toISOString()}] Syncing ${dashboardName} sales...`);

    try {
        const response = await axios.post(
            `${BASE_URL}${endpoint}`,
            {},
            {
                headers: { 'Content-Type': 'application/json' },
                timeout: TIMEOUT
            }
        );

        const result = response.data;
        console.log(`  - Accounts updated: ${result.accountsUpdated || result.results?.updated || 'N/A'}`);
        console.log(`  - Total YTD: $${(result.totalYtd || result.summary?.totalYtdRevenue || 0).toLocaleString()}`);

        if (result.archived) {
            console.log(`  - Days archived: ${result.archived.daysArchived || 0}`);
            console.log(`  - Records archived: ${result.archived.totalRecords || 0}`);
        }

        console.log(`  - Status: SUCCESS`);

        return { success: true, dashboard: dashboardName, result };
    } catch (error) {
        const errorMsg = error.response?.data?.error || error.message;
        console.error(`  - FAILED: ${errorMsg}`);
        return { success: false, dashboard: dashboardName, error: errorMsg };
    }
}

/**
 * Parse command line arguments
 */
function parseArgs() {
    const args = process.argv.slice(2);
    const options = {
        salesOnly: false,
        ownershipOnly: false
    };

    for (const arg of args) {
        switch (arg) {
            case '--sales-only':
                options.salesOnly = true;
                break;
            case '--ownership-only':
                options.ownershipOnly = true;
                break;
        }
    }

    return options;
}

async function main() {
    const options = parseArgs();

    console.log('='.repeat(60));
    console.log('NWCA CRM Dashboard Sync');
    console.log(`Started: ${new Date().toISOString()}`);
    console.log(`Target: ${BASE_URL}`);
    console.log('='.repeat(60));

    const results = {
        ownership: [],
        sales: [],
        errors: []
    };

    // Step 1: Sync account ownership (if not --sales-only)
    if (!options.salesOnly) {
        console.log('\n--- PHASE 1: Account Ownership Sync ---');

        const ownershipSyncs = [
            { name: 'Nika', endpoint: '/api/nika-accounts/sync-ownership' },
            { name: 'Taneisha', endpoint: '/api/taneisha-accounts/sync-ownership' }
        ];

        for (const sync of ownershipSyncs) {
            const result = await syncOwnership(sync.name, sync.endpoint);
            results.ownership.push(result);
            if (!result.success) {
                results.errors.push(`${sync.name} ownership: ${result.error}`);
            }
        }
    } else {
        console.log('\n--- Skipping ownership sync (--sales-only) ---');
    }

    // Step 2: Sync sales data (if not --ownership-only)
    if (!options.ownershipOnly) {
        console.log('\n--- PHASE 2: Sales Data Sync ---');

        const salesSyncs = [
            { name: 'Nika', endpoint: '/api/nika-accounts/sync-sales' },
            { name: 'Taneisha', endpoint: '/api/taneisha-accounts/sync-sales' },
            { name: 'House', endpoint: '/api/house-accounts/sync-sales' }
        ];

        for (const sync of salesSyncs) {
            const result = await syncSales(sync.name, sync.endpoint);
            results.sales.push(result);
            if (!result.success) {
                results.errors.push(`${sync.name} sales: ${result.error}`);
            }
        }
    } else {
        console.log('\n--- Skipping sales sync (--ownership-only) ---');
    }

    // Summary
    console.log('\n' + '='.repeat(60));
    console.log('SYNC SUMMARY');
    console.log('='.repeat(60));
    console.log(`Completed: ${new Date().toISOString()}`);

    if (!options.salesOnly) {
        const ownershipSuccess = results.ownership.filter(r => r.success).length;
        console.log(`Ownership syncs: ${ownershipSuccess}/${results.ownership.length} successful`);
    }

    if (!options.ownershipOnly) {
        const salesSuccess = results.sales.filter(r => r.success).length;
        console.log(`Sales syncs: ${salesSuccess}/${results.sales.length} successful`);
    }

    if (results.errors.length > 0) {
        console.log(`\nErrors (${results.errors.length}):`);
        results.errors.forEach(e => console.log(`  - ${e}`));
        console.log('\nStatus: COMPLETED WITH ERRORS');
        process.exit(1);
    }

    console.log('\nStatus: SUCCESS');
    console.log('\nCRM dashboard sync completed successfully!');
}

main().catch(err => {
    console.error('\nFatal error:', err.message);
    process.exit(1);
});
