#!/usr/bin/env node
/**
 * NWCA Garment Tracker Daily Sync
 *
 * Syncs recent orders from ManageOrders into the live GarmentTracker table
 * AND the GarmentTrackerArchive table. This fills the gap where the dashboard
 * only synced when someone manually clicked the Sync button.
 *
 * Default: syncs last 7 days (safe overlap to catch delayed invoicing)
 * Options:
 *   --days N        Look back N days (default: 7)
 *   --start DATE    Explicit start date (YYYY-MM-DD)
 *   --end DATE      Explicit end date (YYYY-MM-DD, default: today)
 *
 * Usage:
 *   npm run sync-garment-tracker                     # Sync last 7 days
 *   npm run sync-garment-tracker -- --days 14        # Sync last 14 days
 *   npm run sync-garment-tracker -- --start 2026-03-01 --end 2026-03-25
 *
 * Heroku Scheduler:
 *   Run daily at 7 AM Pacific (15:00 UTC): npm run sync-garment-tracker
 *   (Run AFTER archive-garment-tracker which runs at 6 AM Pacific)
 */

const axios = require('axios');

const BASE_URL = process.env.BASE_URL || 'https://caspio-pricing-proxy-ab30a049961a.herokuapp.com';
const TIMEOUT = 30000; // 30s per individual request
const REQUEST_DELAY = 1500; // 1.5s between ManageOrders calls to avoid rate limits

// Single source of truth — edit config/garment-tracker-config.js to swap products each quarter
const gtConfig = require('../config/garment-tracker-config');
const TRACKED_REPS = gtConfig.trackedReps;
const EXCLUDED_ORDER_TYPE_IDS = gtConfig.excludedOrderTypeIds;
const EXCLUDED_CUSTOMER_IDS = gtConfig.excludedCustomerIds;
const PREMIUM_ITEMS = gtConfig.premiumItems;
const RICHARDSON_CAPS = gtConfig.richardsonStyles;
const RICHARDSON_BONUS = gtConfig.richardsonBonus;

function formatDate(date) {
    return date.toISOString().split('T')[0];
}

function matchesTrackedStyle(partNumber, trackedStyle) {
    if (!partNumber) return false;
    return partNumber === trackedStyle || partNumber.startsWith(trackedStyle + '_');
}

function getPremiumMatch(partNumber) {
    if (!partNumber) return null;
    for (const [base, info] of Object.entries(PREMIUM_ITEMS)) {
        if (matchesTrackedStyle(partNumber, base)) return { base, ...info };
    }
    return null;
}

function isRichardsonCap(partNumber) {
    if (!partNumber) return false;
    return RICHARDSON_CAPS.some(style => matchesTrackedStyle(partNumber, style));
}

function calculateLineItemQuantity(item) {
    return (parseInt(item.Size01) || 0) + (parseInt(item.Size02) || 0) +
           (parseInt(item.Size03) || 0) + (parseInt(item.Size04) || 0) +
           (parseInt(item.Size05) || 0) + (parseInt(item.Size06) || 0);
}

function getQuarter(dateStr) {
    const d = new Date(dateStr);
    const q = Math.floor(d.getMonth() / 3) + 1;
    return { quarter: `${d.getFullYear()}-Q${q}`, year: d.getFullYear() };
}

function parseArgs() {
    const args = process.argv.slice(2);
    const options = { days: 7, start: null, end: null };
    for (let i = 0; i < args.length; i++) {
        switch (args[i]) {
            case '--days': options.days = parseInt(args[++i]) || 7; break;
            case '--start': options.start = args[++i]; break;
            case '--end': options.end = args[++i]; break;
        }
    }
    return options;
}

async function delay(ms) {
    return new Promise(r => setTimeout(r, ms));
}

async function main() {
    const options = parseArgs();

    const endDate = options.end || formatDate(new Date());
    let startDate = options.start;
    if (!startDate) {
        const d = new Date();
        d.setDate(d.getDate() - options.days);
        startDate = formatDate(d);
    }

    console.log('='.repeat(60));
    console.log('NWCA Garment Tracker Daily Sync');
    console.log(`Started: ${new Date().toISOString()}`);
    console.log(`Target: ${BASE_URL}`);
    console.log(`Date range: ${startDate} to ${endDate}`);
    console.log(`Tracked reps: ${TRACKED_REPS.join(', ')}`);
    console.log('='.repeat(60));

    try {
        // Step 1: Fetch orders from ManageOrders
        console.log('\n[1/4] Fetching orders from ManageOrders...');
        const ordersResp = await axios.get(`${BASE_URL}/api/manageorders/orders`, {
            params: { date_Invoiced_start: startDate, date_Invoiced_end: endDate },
            timeout: 60000
        });
        const allOrders = ordersResp.data?.result || [];
        console.log(`  Found ${allOrders.length} total orders`);

        // Filter to tracked reps, exclude InkSoft (type 31) and excluded customers
        const repOrders = allOrders.filter(o =>
            TRACKED_REPS.includes(o.CustomerServiceRep) &&
            !EXCLUDED_ORDER_TYPE_IDS.includes(o.id_OrderType) &&
            !EXCLUDED_CUSTOMER_IDS.includes(o.id_Customer)
        );
        console.log(`  Filtered to ${repOrders.length} orders for tracked reps`);

        if (repOrders.length === 0) {
            console.log('\nNo qualifying orders found. Nothing to sync.');
            return;
        }

        // Step 2: Fetch line items and extract garment records
        console.log('\n[2/4] Fetching line items and extracting garment records...');
        const garmentRecords = [];
        const MAX_RETRIES = 3;

        for (let i = 0; i < repOrders.length; i++) {
            const order = repOrders[i];
            let retries = 0;
            let success = false;

            while (!success && retries < MAX_RETRIES) {
                try {
                    const lineResp = await axios.get(
                        `${BASE_URL}/api/manageorders/lineitems/${order.id_Order}`,
                        { timeout: TIMEOUT }
                    );
                    const lineItems = lineResp.data?.result || [];

                    for (const item of lineItems) {
                        const qty = calculateLineItemQuantity(item);
                        if (qty === 0 || !item.PartNumber) continue;

                        const premiumMatch = getPremiumMatch(item.PartNumber);
                        const isRichardson = !premiumMatch && isRichardsonCap(item.PartNumber);

                        if (!premiumMatch && !isRichardson) continue;

                        const quarterInfo = getQuarter(order.date_Invoiced);
                        const bonus = premiumMatch
                            ? qty * premiumMatch.bonus
                            : qty * RICHARDSON_BONUS;

                        garmentRecords.push({
                            OrderNumber: order.id_Order,
                            DateInvoiced: order.date_Invoiced ? order.date_Invoiced.split('T')[0] : '',
                            Quarter: quarterInfo.quarter,
                            Year: quarterInfo.year,
                            RepName: order.CustomerServiceRep,
                            CustomerName: order.Contact_Name || '',
                            CompanyName: order.CustomerName || '',
                            PartNumber: item.PartNumber,
                            StyleCategory: premiumMatch ? 'Premium' : 'Richardson',
                            Quantity: qty,
                            BonusAmount: bonus
                        });
                    }
                    success = true;
                } catch (e) {
                    retries++;
                    if (e.message.includes('429') && retries < MAX_RETRIES) {
                        const backoff = Math.pow(2, retries) * 2000;
                        console.log(`  Rate limited on order ${order.id_Order}, retry ${retries} in ${backoff}ms`);
                        await delay(backoff);
                    } else if (retries >= MAX_RETRIES) {
                        console.warn(`  Failed order ${order.id_Order} after ${MAX_RETRIES} retries: ${e.message}`);
                    } else {
                        console.warn(`  Error on order ${order.id_Order}: ${e.message}`);
                        break;
                    }
                }
            }

            if (i < repOrders.length - 1) await delay(REQUEST_DELAY);
            if ((i + 1) % 10 === 0) console.log(`  Processed ${i + 1}/${repOrders.length} orders`);
        }

        console.log(`  Found ${garmentRecords.length} garment records`);

        if (garmentRecords.length === 0) {
            console.log('\nNo garment records found in orders. Nothing to sync.');
            return;
        }

        // Step 3: Post to live GarmentTracker table (upserts)
        console.log('\n[3/4] Syncing to live GarmentTracker table...');
        let liveCreated = 0, liveUpdated = 0, liveErrors = 0;

        for (let i = 0; i < garmentRecords.length; i++) {
            try {
                const resp = await axios.post(`${BASE_URL}/api/garment-tracker`, garmentRecords[i], {
                    headers: { 'Content-Type': 'application/json' },
                    timeout: TIMEOUT
                });
                if (resp.data?.action === 'created') liveCreated++;
                else liveUpdated++;
            } catch (e) {
                liveErrors++;
                if (e.message.includes('429')) {
                    console.log(`  Rate limited, waiting 30s...`);
                    await delay(30000);
                    i--; // Retry
                    liveErrors--;
                } else {
                    console.warn(`  Error posting: ${e.response?.data?.error || e.message}`);
                }
            }
            await delay(REQUEST_DELAY);
        }

        console.log(`  Live table: ${liveCreated} created, ${liveUpdated} updated, ${liveErrors} errors`);

        // Step 4: Also archive (fire-and-forget, non-critical)
        console.log('\n[4/4] Archiving to permanent table...');
        try {
            const archiveResp = await axios.post(
                `${BASE_URL}/api/garment-tracker/archive-from-live`,
                {},
                { headers: { 'Content-Type': 'application/json' }, timeout: 60000 }
            );
            console.log(`  Archive: ${archiveResp.data?.created || 0} created, ${archiveResp.data?.updated || 0} updated`);
        } catch (e) {
            console.warn(`  Archive failed (non-critical): ${e.message}`);
        }

        // Summary
        console.log('\n' + '='.repeat(60));
        console.log('SYNC SUMMARY');
        console.log('='.repeat(60));
        console.log(`Orders processed: ${repOrders.length}`);
        console.log(`Garment records found: ${garmentRecords.length}`);
        console.log(`Live table: ${liveCreated} new, ${liveUpdated} existing`);
        console.log(`Status: SUCCESS`);
    } catch (error) {
        console.error('\nFATAL ERROR:', error.message);
        process.exit(1);
    }
}

main().catch(err => {
    console.error('\nFatal error:', err.message);
    process.exit(1);
});
