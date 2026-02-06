#!/usr/bin/env node
/**
 * NWCA Daily Sales Archiver
 *
 * Archives daily sales by rep from ManageOrders to Caspio (NW_Daily_Sales_By_Rep).
 * This preserves sales data beyond ManageOrders' 60-day rolling window.
 *
 * Modes:
 *   1. Daily mode (default): Archives yesterday's sales
 *   2. Backfill mode: Archives a date range (--backfill --start YYYY-MM-DD --end YYYY-MM-DD)
 *   3. Re-archive mode: Re-archives a specific date (--date YYYY-MM-DD)
 *
 * Usage:
 *   npm run archive-daily-sales                           # Archive yesterday
 *   npm run archive-daily-sales -- --date 2026-01-20     # Re-archive specific date
 *   npm run archive-daily-sales -- --backfill --start 2026-01-01 --end 2026-01-24  # Backfill range
 *
 * Environment:
 *   BASE_URL - API base URL (defaults to Heroku production)
 *
 * Heroku Scheduler:
 *   Run daily at 6 AM Pacific (14:00 UTC): npm run archive-daily-sales
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
 * Archive a single date
 */
async function archiveDate(date) {
  console.log(`\n[${new Date().toISOString()}] Archiving ${date}...`);

  try {
    const response = await axios.post(
      `${BASE_URL}/api/caspio/daily-sales-by-rep/archive-date`,
      { date },
      {
        headers: { 'Content-Type': 'application/json' },
        timeout: TIMEOUT
      }
    );

    const result = response.data;
    console.log(`  - Success: ${result.reps?.length || 0} reps`);
    console.log(`  - Total revenue: $${(result.totalRevenue || 0).toLocaleString()}`);
    console.log(`  - Total orders: ${result.totalOrders || 0}`);
    console.log(`  - Created: ${result.archived?.created || 0}, Updated: ${result.archived?.updated || 0}`);

    if ((result.totalOrders || 0) === 0 && (result.archived?.created || 0) === 0 && (result.archived?.updated || 0) === 0) {
      console.warn('WARNING: Zero records processed for this date — verify ManageOrders API is returning data');
    }

    return { success: true, date, result };
  } catch (error) {
    const errorMsg = error.response?.data?.error || error.message;
    console.error(`  - FAILED: ${errorMsg}`);
    return { success: false, date, error: errorMsg };
  }
}

/**
 * Archive a date range (backfill)
 */
async function archiveRange(start, end) {
  console.log(`\n[${new Date().toISOString()}] Archiving range ${start} to ${end}...`);

  try {
    const response = await axios.post(
      `${BASE_URL}/api/caspio/daily-sales-by-rep/archive-range`,
      { start, end },
      {
        headers: { 'Content-Type': 'application/json' },
        timeout: TIMEOUT
      }
    );

    const result = response.data;
    console.log(`  - Days processed: ${result.daysProcessed}`);
    console.log(`  - Days skipped (no orders): ${result.daysSkipped}`);
    console.log(`  - Records created: ${result.created}`);
    console.log(`  - Records updated: ${result.updated}`);

    if (result.errors?.length > 0) {
      console.log(`  - Errors: ${result.errors.length}`);
      result.errors.forEach(e => console.log(`    - ${e.date} ${e.rep}: ${e.error}`));
    }

    return { success: result.success, result };
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
    backfill: false,
    date: null,
    start: null,
    end: null
  };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--backfill':
        options.backfill = true;
        break;
      case '--date':
        options.date = args[++i];
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
  console.log('NWCA Daily Sales Archiver');
  console.log(`Started: ${new Date().toISOString()}`);
  console.log(`Target: ${BASE_URL}`);
  console.log('='.repeat(60));

  let result;

  if (options.backfill) {
    // Backfill mode: archive a date range
    if (!options.start || !options.end) {
      console.error('ERROR: --backfill requires --start and --end dates');
      console.error('Example: npm run archive-daily-sales -- --backfill --start 2026-01-01 --end 2026-01-24');
      process.exit(1);
    }
    result = await archiveRange(options.start, options.end);
  } else if (options.date) {
    // Re-archive mode: archive a specific date
    result = await archiveDate(options.date);
  } else {
    // Default: archive yesterday
    const yesterday = getYesterday();
    console.log(`Mode: Daily (archiving yesterday: ${yesterday})`);
    result = await archiveDate(yesterday);
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

  console.log('\nArchiving completed successfully!');
}

main().catch(err => {
  console.error('\nFatal error:', err.message);
  process.exit(1);
});
