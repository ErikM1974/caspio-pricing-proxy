#!/usr/bin/env node
/**
 * NWCA Garment Tracker Archiver
 *
 * Archives garment tracking data from ManageOrders to Caspio (GarmentTrackerArchive).
 * Preserves quarterly garment sales by rep beyond ManageOrders' 60-day window.
 *
 * Modes:
 *   1. Daily mode (default): Archives yesterday's garment data
 *   2. Range mode: Archives a date range (--start YYYY-MM-DD --end YYYY-MM-DD)
 *   3. Live mode: Archives from existing GarmentTracker table (--from-live)
 *
 * Usage:
 *   npm run archive-garment-tracker                                    # Archive yesterday
 *   npm run archive-garment-tracker -- --start 2026-01-01 --end 2026-01-31  # Archive range
 *   npm run archive-garment-tracker -- --from-live                     # Archive from live table
 *
 * Environment:
 *   BASE_URL - API base URL (defaults to Heroku production)
 *
 * Heroku Scheduler:
 *   Run daily at 6 AM Pacific (14:00 UTC): npm run archive-garment-tracker
 */

const axios = require('axios');

const BASE_URL = process.env.BASE_URL || 'https://caspio-pricing-proxy-ab30a049961a.herokuapp.com';
const TIMEOUT = 300000; // 5 minutes for archiving operations

/**
 * Get yesterday's date in YYYY-MM-DD format
 */
function getYesterday() {
    const date = new Date();
    date.setDate(date.getDate() - 1);
    return date.toISOString().split('T')[0];
}

/**
 * Archive a date range from ManageOrders
 */
async function archiveRange(start, end) {
    console.log(`\n[${new Date().toISOString()}] Archiving range ${start} to ${end} from ManageOrders...`);

    try {
        const response = await axios.post(
            `${BASE_URL}/api/garment-tracker/archive-range`,
            { start, end },
            {
                headers: { 'Content-Type': 'application/json' },
                timeout: TIMEOUT
            }
        );

        const result = response.data;
        console.log(`  - Records processed: ${result.recordsProcessed || 0}`);
        console.log(`  - Created: ${result.created || 0}`);
        console.log(`  - Updated: ${result.updated || 0}`);

        if (result.errors?.length > 0) {
            console.log(`  - Errors: ${result.errors.length}`);
            result.errors.slice(0, 5).forEach(e =>
                console.log(`    - Order ${e.orderNumber}, Part ${e.partNumber}: ${e.error}`)
            );
            if (result.errors.length > 5) {
                console.log(`    ... and ${result.errors.length - 5} more errors`);
            }
        }

        return { success: result.success, result };
    } catch (error) {
        const errorMsg = error.response?.data?.error || error.message;
        console.error(`  - FAILED: ${errorMsg}`);
        return { success: false, error: errorMsg };
    }
}

/**
 * Archive from live GarmentTracker table
 */
async function archiveFromLive(startDate, endDate) {
    console.log(`\n[${new Date().toISOString()}] Archiving from live GarmentTracker table...`);
    if (startDate || endDate) {
        console.log(`  - Date filter: ${startDate || 'all'} to ${endDate || 'all'}`);
    }

    try {
        const response = await axios.post(
            `${BASE_URL}/api/garment-tracker/archive-from-live`,
            { startDate, endDate },
            {
                headers: { 'Content-Type': 'application/json' },
                timeout: TIMEOUT
            }
        );

        const result = response.data;
        console.log(`  - Created: ${result.created || 0}`);
        console.log(`  - Updated: ${result.updated || 0}`);

        if (result.errors?.length > 0) {
            console.log(`  - Errors: ${result.errors.length}`);
        }

        return { success: result.success !== false, result };
    } catch (error) {
        const errorMsg = error.response?.data?.error || error.message;
        console.error(`  - FAILED: ${errorMsg}`);
        return { success: false, error: errorMsg };
    }
}

/**
 * Parse command line arguments
 */
function parseArgs() {
    const args = process.argv.slice(2);
    const options = {
        fromLive: false,
        start: null,
        end: null
    };

    for (let i = 0; i < args.length; i++) {
        switch (args[i]) {
            case '--from-live':
                options.fromLive = true;
                break;
            case '--start':
                options.start = args[++i];
                break;
            case '--end':
                options.end = args[++i];
                break;
        }
    }

    return options;
}

async function main() {
    const options = parseArgs();

    console.log('='.repeat(60));
    console.log('NWCA Garment Tracker Archiver');
    console.log(`Started: ${new Date().toISOString()}`);
    console.log(`Target: ${BASE_URL}`);
    console.log('='.repeat(60));

    let result;

    if (options.fromLive) {
        // Archive from live GarmentTracker table
        console.log('Mode: Archive from live table');
        result = await archiveFromLive(options.start, options.end);
    } else if (options.start && options.end) {
        // Archive date range from ManageOrders
        console.log(`Mode: Archive range ${options.start} to ${options.end}`);
        result = await archiveRange(options.start, options.end);
    } else {
        // Default: archive yesterday
        const yesterday = getYesterday();
        console.log(`Mode: Daily (archiving yesterday: ${yesterday})`);
        result = await archiveRange(yesterday, yesterday);
    }

    console.log('\n' + '='.repeat(60));
    console.log('ARCHIVE SUMMARY');
    console.log('='.repeat(60));
    console.log(`Completed: ${new Date().toISOString()}`);
    console.log(`Status: ${result.success ? 'SUCCESS' : 'FAILED'}`);

    if (!result.success) {
        console.log(`Error: ${result.error}`);
        process.exit(1);
    }

    console.log('\nGarment tracker archiving completed successfully!');
}

main().catch(err => {
    console.error('\nFatal error:', err.message);
    process.exit(1);
});
