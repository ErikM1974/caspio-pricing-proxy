#!/usr/bin/env node
/**
 * NWCA SanMar Order & Invoice Sync
 *
 * Syncs SanMar order statuses, shipments, and invoices to Caspio tables.
 * - Orders: allOpen on Mondays, lastUpdate (1 day) other days
 * - Invoices: GetInvoices (incremental) nightly
 *
 * Usage:
 *   npm run sync-sanmar                          # Normal daily sync (orders + invoices)
 *   npm run sync-sanmar -- --full                # Force allOpen (full) order sync
 *   npm run sync-sanmar -- --backfill 90         # Backfill orders (N days)
 *   npm run sync-sanmar -- --backfill-invoices 90 # Backfill invoices (N days)
 *   npm run sync-sanmar -- --status              # Check table counts and sync health
 *
 * Environment:
 *   BASE_URL - API base URL (defaults to Heroku production)
 *   CRM_API_SECRET - Required authentication secret
 *
 * Heroku Scheduler:
 *   Run daily at 5 AM Pacific (13:00 UTC): npm run sync-sanmar
 */

const axios = require('axios');

const BASE_URL = process.env.BASE_URL || 'https://caspio-pricing-proxy-ab30a049961a.herokuapp.com';
const CRM_API_SECRET = process.env.CRM_API_SECRET;
const TIMEOUT = 300000; // 5 minutes

if (!CRM_API_SECRET) {
  console.error('ERROR: CRM_API_SECRET environment variable is required');
  console.error('This should be set as a Heroku config var.');
  process.exit(1);
}

const AUTH_HEADERS = {
  'Content-Type': 'application/json',
  'x-api-secret': CRM_API_SECRET
};

async function syncOrders(full = false) {
  const url = `${BASE_URL}/api/sanmar-orders/sync${full ? '?full=true' : ''}`;
  console.log(`\n[${new Date().toISOString()}] Starting order sync (${full ? 'full' : 'incremental'})...`);

  const response = await axios.post(url, {}, { headers: AUTH_HEADERS, timeout: TIMEOUT });
  const result = response.data;
  console.log(`  Orders found: ${result.ordersFound || 0}`);
  console.log(`  Orders upserted: ${result.ordersUpserted || 0}`);
  console.log(`  Shipments updated: ${result.shipmentsUpdated || 0}`);
  console.log(`  Status: SUCCESS`);
  return result;
}

async function syncInvoices() {
  const url = `${BASE_URL}/api/sanmar-invoices/sync`;
  console.log(`\n[${new Date().toISOString()}] Starting invoice sync...`);

  const response = await axios.post(url, {}, { headers: AUTH_HEADERS, timeout: TIMEOUT });
  const result = response.data;
  console.log(`  Invoices found: ${result.invoicesFound || 0}`);
  console.log(`  Invoices saved: ${result.invoicesSaved || 0}`);
  console.log(`  Items saved: ${result.itemsSaved || 0}`);
  console.log(`  Status: SUCCESS`);
  return result;
}

async function pollBackfillStatus(endpoint, label) {
  const maxPolls = 80; // 20 minutes max (80 * 15s)
  for (let i = 0; i < maxPolls; i++) {
    await new Promise(r => setTimeout(r, 15000));
    try {
      const status = await axios.get(`${BASE_URL}${endpoint}`, { timeout: 10000 });
      const data = status.data;
      const progress = data.progress || {};
      console.log(`  [${label}] ${progress.phase || 'unknown'} — orders: ${progress.ordersSaved || progress.invoicesSaved || 0}, errors: ${progress.errors || 0}`);
      if (!data.running) {
        return data.lastResult;
      }
    } catch (e) {
      console.log(`  [${label}] Poll error: ${e.message}`);
    }
  }
  console.log(`  [${label}] Still running after 20 minutes. Exiting poll loop.`);
  return null;
}

async function runBackfill(days) {
  const url = `${BASE_URL}/api/sanmar-orders/backfill?days=${days}`;
  console.log(`\n[${new Date().toISOString()}] Starting order backfill (${days} days)...`);

  const response = await axios.post(url, {}, { headers: AUTH_HEADERS, timeout: 30000 });
  if (response.status === 202) {
    console.log('  Backfill started in background. Polling for completion...');
    const result = await pollBackfillStatus('/api/sanmar-orders/backfill-status', 'Order Backfill');
    if (result) {
      console.log(`\n  Backfill result: ${JSON.stringify(result)}`);
    }
    return result;
  }
  return response.data;
}

async function runInvoiceBackfill(days) {
  const url = `${BASE_URL}/api/sanmar-invoices/backfill?days=${days}`;
  console.log(`\n[${new Date().toISOString()}] Starting invoice backfill (${days} days)...`);

  const response = await axios.post(url, {}, { headers: AUTH_HEADERS, timeout: 30000 });
  if (response.status === 202) {
    console.log('  Invoice backfill started in background. Polling for completion...');
    const result = await pollBackfillStatus('/api/sanmar-invoices/backfill-status', 'Invoice Backfill');
    if (result) {
      console.log(`\n  Invoice backfill result: ${JSON.stringify(result)}`);
    }
    return result;
  }
  return response.data;
}

async function checkStatus() {
  const url = `${BASE_URL}/api/sanmar-orders/status-summary`;
  console.log(`\n[${new Date().toISOString()}] Checking SanMar sync status...`);

  const response = await axios.get(url, { timeout: 30000 });
  const data = response.data;

  console.log('\n  Table Row Counts:');
  for (const [table, info] of Object.entries(data.tables)) {
    console.log(`    ${table}: ${info.rows}${info.error ? ` (ERROR: ${info.error})` : ''}`);
  }

  console.log(`\n  Last Sync: ${data.lastSync}`);

  if (data.orderStatusDistribution && Object.keys(data.orderStatusDistribution).length > 0) {
    console.log('\n  Order Status Distribution:');
    for (const [status, count] of Object.entries(data.orderStatusDistribution)) {
      console.log(`    ${status}: ${count}`);
    }
  }

  if (data.dataQuality) {
    console.log(`\n  Data Quality:`);
    console.log(`    Items missing Unit_Price: ${data.dataQuality.itemsMissingUnitPrice}`);
  }

  if (data.backfill) {
    console.log(`\n  Backfill: ${data.backfill.running ? 'RUNNING' : 'idle'}`);
    if (data.backfill.lastRun) console.log(`    Last run: ${data.backfill.lastRun}`);
  }

  return data;
}

async function main() {
  const args = process.argv.slice(2);

  try {
    if (args.includes('--status')) {
      await checkStatus();
    } else if (args.includes('--backfill')) {
      const idx = args.indexOf('--backfill');
      const days = parseInt(args[idx + 1]) || 90;
      await runBackfill(days);
    } else if (args.includes('--backfill-invoices')) {
      const idx = args.indexOf('--backfill-invoices');
      const days = parseInt(args[idx + 1]) || 90;
      await runInvoiceBackfill(days);
    } else {
      // Normal daily sync: orders + invoices
      const full = args.includes('--full');
      await syncOrders(full);
      await syncInvoices();
    }

    console.log(`\n[${new Date().toISOString()}] SanMar sync completed successfully.`);
    process.exit(0);
  } catch (error) {
    console.error(`\n[${new Date().toISOString()}] SanMar sync FAILED:`, error.response?.data || error.message);
    process.exit(1);
  }
}

main();
