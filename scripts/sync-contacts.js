#!/usr/bin/env node
/**
 * NWCA Contacts Sync from ManageOrders
 *
 * Scheduled task to sync customer contacts from recent ManageOrders orders
 * to the Caspio Company_Contacts_Merge_ODBC table.
 *
 * Designed to run via Heroku Scheduler every 1-4 hours.
 *
 * Usage:
 *   npm run sync-contacts
 *   heroku run npm run sync-contacts -a caspio-pricing-proxy
 *
 * Environment:
 *   BASE_URL - API base URL (defaults to Heroku production)
 *   SYNC_HOURS - Hours of orders to sync (defaults to 24)
 */

const axios = require('axios');

const BASE_URL = process.env.BASE_URL || 'https://caspio-pricing-proxy-ab30a049961a.herokuapp.com';
const SYNC_HOURS = parseInt(process.env.SYNC_HOURS) || 24;

// 5 minute timeout for sync operations
const TIMEOUT = 300000;

async function syncContacts() {
    console.log('='.repeat(60));
    console.log('NWCA Contacts Sync from ManageOrders');
    console.log(`Started: ${new Date().toISOString()}`);
    console.log(`Target: ${BASE_URL}`);
    console.log(`Sync window: Last ${SYNC_HOURS} hours`);
    console.log('='.repeat(60));

    try {
        console.log(`\n[${new Date().toISOString()}] Starting contacts sync...`);

        const response = await axios.post(
            `${BASE_URL}/api/company-contacts/sync`,
            {},
            {
                params: { hours: SYNC_HOURS },
                timeout: TIMEOUT
            }
        );

        const result = response.data;
        console.log(`\n[${new Date().toISOString()}] Sync complete!`);
        console.log('='.repeat(60));
        console.log('RESULTS:');
        console.log(`  - Orders processed: ${result.stats?.ordersProcessed || 0}`);
        console.log(`  - Contacts created: ${result.stats?.contactsCreated || 0}`);
        console.log(`  - Contacts updated: ${result.stats?.contactsUpdated || 0}`);
        console.log(`  - Contacts skipped: ${result.stats?.contactsSkipped || 0}`);

        if (result.stats?.errors?.length > 0) {
            console.log(`\nErrors (${result.stats.errors.length}):`);
            result.stats.errors.forEach(e => {
                console.log(`  - ${e.contact}: ${e.error}`);
            });
        }

        if ((result.stats?.ordersProcessed || 0) === 0 && (result.stats?.contactsCreated || 0) === 0 && (result.stats?.contactsUpdated || 0) === 0) {
            console.warn('WARNING: Zero contacts processed — verify ManageOrders API is returning data');
        }

        console.log('='.repeat(60));
        console.log(`Finished: ${new Date().toISOString()}`);

        // Exit successfully
        process.exit(0);

    } catch (error) {
        console.error(`\n[${new Date().toISOString()}] Sync FAILED!`);
        console.error(`Error: ${error.message}`);

        if (error.response?.data) {
            console.error('Response:', JSON.stringify(error.response.data, null, 2));
        }

        // Exit with error code
        process.exit(1);
    }
}

// Run the sync
syncContacts();
