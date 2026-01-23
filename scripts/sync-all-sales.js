#!/usr/bin/env node
/**
 * NWCA CRM Daily Sales Sync
 *
 * Scheduled task to sync YTD sales from ManageOrders for all rep CRMs.
 * Designed to run via Heroku Scheduler at 6 AM Pacific (14:00 UTC).
 *
 * Usage:
 *   npm run sync-sales
 *   heroku run npm run sync-sales -a caspio-pricing-proxy
 *
 * Environment:
 *   BASE_URL - API base URL (defaults to Heroku production)
 */

const axios = require('axios');

const BASE_URL = process.env.BASE_URL || 'https://caspio-pricing-proxy-ab30a049961a.herokuapp.com';

// 5 minute timeout for sync operations (they can take a while)
const TIMEOUT = 300000;

async function syncRepSales(repName, endpoint) {
    console.log(`\n[${new Date().toISOString()}] Starting ${repName} sync...`);

    try {
        const response = await axios.post(
            `${BASE_URL}${endpoint}/sync-sales`,
            {},
            { timeout: TIMEOUT }
        );

        const result = response.data;
        console.log(`[${new Date().toISOString()}] ${repName} sync complete:`);
        console.log(`  - Accounts updated: ${result.accountsUpdated || 'N/A'}`);
        console.log(`  - Total YTD revenue: $${(result.totalYTDRevenue || 0).toLocaleString()}`);

        return { success: true, repName, result };
    } catch (error) {
        console.error(`[${new Date().toISOString()}] ${repName} sync FAILED:`);
        console.error(`  - Error: ${error.message}`);

        return { success: false, repName, error: error.message };
    }
}

async function main() {
    console.log('='.repeat(60));
    console.log('NWCA CRM Daily Sales Sync');
    console.log(`Started: ${new Date().toISOString()}`);
    console.log(`Target: ${BASE_URL}`);
    console.log('='.repeat(60));

    const results = [];

    // Sync Taneisha's accounts
    results.push(await syncRepSales('Taneisha', '/api/taneisha-accounts'));

    // Sync Nika's accounts
    results.push(await syncRepSales('Nika', '/api/nika-accounts'));

    // Summary
    console.log('\n' + '='.repeat(60));
    console.log('SYNC SUMMARY');
    console.log('='.repeat(60));

    const successful = results.filter(r => r.success);
    const failed = results.filter(r => !r.success);

    console.log(`Completed: ${new Date().toISOString()}`);
    console.log(`Success: ${successful.length}/${results.length}`);

    if (failed.length > 0) {
        console.log('\nFailed syncs:');
        failed.forEach(f => console.log(`  - ${f.repName}: ${f.error}`));
    }

    // Exit with error code if any sync failed
    if (failed.length > 0) {
        process.exit(1);
    }

    console.log('\nAll syncs completed successfully!');
}

main().catch(err => {
    console.error('\nFatal error:', err.message);
    process.exit(1);
});
