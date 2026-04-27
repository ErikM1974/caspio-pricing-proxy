#!/usr/bin/env node
/**
 * NWCA Daily Sales Archiver
 *
 * Archives daily sales by rep from ManageOrders to Caspio (NW_Daily_Sales_By_Rep).
 * This preserves sales data beyond ManageOrders' 60-day rolling window.
 *
 * Modes:
 *   1. Rolling mode (default, 2026-04-27): Re-archives the trailing 60 days from
 *      yesterday backward. Catches order MODIFICATIONS (reopens, refunds, late
 *      shipping charges, etc.) that change a previously-invoiced day's totals.
 *      Without this, every post-invoice edit silently drifts the dashboard until
 *      the order falls off ManageOrders' 60-day window — at which point the
 *      stale total is locked in forever. Idempotent UPSERTs make this safe to
 *      run nightly even when nothing has changed.
 *   2. Single-date mode: Re-archive a specific date (--date YYYY-MM-DD)
 *   3. Backfill mode: Archive a date range (--backfill --start YYYY-MM-DD --end YYYY-MM-DD)
 *   4. Legacy mode: Archive yesterday only (--legacy-yesterday-only) — escape
 *      hatch in case the rolling window is too expensive to run nightly.
 *
 * Usage:
 *   npm run archive-daily-sales                                       # Rolling 60-day re-archive (default)
 *   npm run archive-daily-sales -- --days 30                          # Rolling 30-day window
 *   npm run archive-daily-sales -- --date 2026-01-20                  # Re-archive specific date
 *   npm run archive-daily-sales -- --backfill --start 2026-01-01 --end 2026-01-24
 *   npm run archive-daily-sales -- --legacy-yesterday-only            # Old "yesterday only" behavior
 *
 * Environment:
 *   BASE_URL - API base URL (defaults to Heroku production)
 *
 * Heroku Scheduler:
 *   Run daily at 7 AM Pacific (14:00 UTC): npm run archive-daily-sales
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
    legacyYesterdayOnly: false,
    date: null,
    start: null,
    end: null,
    days: 60     // rolling window size in days
  };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--backfill':
        options.backfill = true;
        break;
      case '--legacy-yesterday-only':
        options.legacyYesterdayOnly = true;
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
      case '--days':
        options.days = parseInt(args[++i], 10) || 60;
        break;
    }
  }

  return options;
}

/**
 * Compute a YYYY-MM-DD string for `daysAgo` days before today (UTC).
 */
function dateNDaysAgo(daysAgo) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - daysAgo);
  return d.toISOString().split('T')[0];
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
    // Explicit backfill: archive a user-specified range
    if (!options.start || !options.end) {
      console.error('ERROR: --backfill requires --start and --end dates');
      console.error('Example: npm run archive-daily-sales -- --backfill --start 2026-01-01 --end 2026-01-24');
      process.exit(1);
    }
    result = await archiveRange(options.start, options.end);
  } else if (options.date) {
    // Re-archive a single specific date
    result = await archiveDate(options.date);
  } else if (options.legacyYesterdayOnly) {
    // Escape hatch: original "yesterday only" behavior
    const yesterday = getYesterday();
    console.log(`Mode: Legacy (archiving yesterday only: ${yesterday})`);
    result = await archiveDate(yesterday);
  } else {
    // Default: rolling N-day re-archive (default N=60). Catches modifications
    // to previously-invoiced orders that ManageOrders is still showing within
    // its 60-day window. Idempotent — same numbers each night unless something
    // actually changed.
    const days = Math.max(1, Math.min(60, options.days));
    const end = getYesterday();
    const start = dateNDaysAgo(days);
    console.log(`Mode: Rolling ${days}-day re-archive (${start} through ${end})`);
    result = await archiveRange(start, end);
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
