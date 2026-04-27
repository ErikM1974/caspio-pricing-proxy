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

/**
 * Archive a date range by looping day-by-day, calling archive-date for each.
 * Why not call archive-range directly? Heroku's router enforces a 30-second
 * response timeout on HTTP requests. archive-range for 60 days exceeds this
 * (it fetches all orders in one go + does dozens of Caspio upserts). Day-by-day
 * keeps each request short (~1-2s) and is also more resilient — one failed
 * day won't kill the whole run.
 */
async function archiveRollingWindow(start, end) {
  // Build inclusive list of dates from start through end (UTC)
  const dates = [];
  const cursor = new Date(start + 'T00:00:00Z');
  const endDate = new Date(end + 'T00:00:00Z');
  while (cursor <= endDate) {
    dates.push(cursor.toISOString().split('T')[0]);
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }

  console.log(`Will archive ${dates.length} day(s) one at a time…`);

  const summary = {
    succeeded: 0,
    failed: 0,
    skippedZeroOrderDays: 0,
    totalCreated: 0,
    totalUpdated: 0,
    totalRevenueChanges: [],  // dates where revenue changed (records updated)
    failures: []
  };

  // 500ms between days — gentle on ManageOrders + Caspio. 60 days × (~2s call + 0.5s pause) ≈ 2.5 min.
  const DAY_DELAY_MS = 500;

  for (let i = 0; i < dates.length; i++) {
    const date = dates[i];
    const r = await archiveDate(date);

    if (!r.success) {
      summary.failed++;
      summary.failures.push({ date, error: r.error });
      continue;
    }

    const created = r.result?.archived?.created || 0;
    const updated = r.result?.archived?.updated || 0;
    const totalOrders = r.result?.totalOrders || 0;

    summary.succeeded++;
    summary.totalCreated += created;
    summary.totalUpdated += updated;

    if (totalOrders === 0) {
      summary.skippedZeroOrderDays++;
    }
    if (updated > 0) {
      // A day with updated records means at least one rep's totals changed since
      // the last archive — likely an order modification we just caught.
      summary.totalRevenueChanges.push({ date, repsChanged: updated });
    }

    if ((i + 1) % 10 === 0 || i === dates.length - 1) {
      console.log(`Progress: ${i + 1}/${dates.length} days complete (${summary.totalUpdated} reps updated, ${summary.totalCreated} created so far)`);
    }

    if (i < dates.length - 1) {
      await new Promise(r => setTimeout(r, DAY_DELAY_MS));
    }
  }

  return {
    success: summary.failed === 0,
    error: summary.failed > 0 ? `${summary.failed} day(s) failed` : null,
    daysProcessed: summary.succeeded,
    daysFailed: summary.failed,
    skippedZeroOrderDays: summary.skippedZeroOrderDays,
    totalCreated: summary.totalCreated,
    totalUpdated: summary.totalUpdated,
    totalRevenueChanges: summary.totalRevenueChanges,
    failures: summary.failures
  };
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
    // Explicit backfill: archive a user-specified range, day-by-day to stay
    // under Heroku's 30s router timeout per request.
    if (!options.start || !options.end) {
      console.error('ERROR: --backfill requires --start and --end dates');
      console.error('Example: npm run archive-daily-sales -- --backfill --start 2026-01-01 --end 2026-01-24');
      process.exit(1);
    }
    result = await archiveRollingWindow(options.start, options.end);
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
    result = await archiveRollingWindow(start, end);
  }

  console.log('\n' + '='.repeat(60));
  console.log('ARCHIVE SUMMARY');
  console.log('='.repeat(60));
  console.log(`Completed: ${new Date().toISOString()}`);
  console.log(`Status: ${result.success ? 'SUCCESS' : 'FAILED'}`);

  // Surface what actually changed — the whole point of the rolling re-archive
  if (result.daysProcessed !== undefined) {
    console.log(`Days processed: ${result.daysProcessed}`);
    console.log(`Days with zero orders (weekends/holidays): ${result.skippedZeroOrderDays || 0}`);
    console.log(`Total rep-day records created: ${result.totalCreated || 0}`);
    console.log(`Total rep-day records updated (= changes detected): ${result.totalUpdated || 0}`);

    if (result.totalRevenueChanges?.length > 0) {
      console.log(`\nDays with detected modifications:`);
      result.totalRevenueChanges.forEach(c => {
        console.log(`  ${c.date}: ${c.repsChanged} rep total(s) updated`);
      });
    }

    if (result.failures?.length > 0) {
      console.log(`\nFAILURES:`);
      result.failures.forEach(f => console.log(`  ${f.date}: ${f.error}`));
    }
  }

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
