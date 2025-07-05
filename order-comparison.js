// Order ID Comparison Script
// Compares order IDs from the invoiced file vs API data to identify discrepancies

const axios = require('axios');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

const BASE_URL = 'http://localhost:3000';
const INVOICED_FILE_PATH = '/mnt/c/Users/erik/Downloads/invoiced 2025.txt';

async function compareOrderData() {
    console.log('='.repeat(60));
    console.log('ORDER DATA COMPARISON ANALYSIS');
    console.log('='.repeat(60));
    console.log();

    try {
        // Step 1: Extract order IDs from the invoiced file
        console.log('Step 1: Extracting order IDs from invoiced file...');
        const fileOrderIds = await extractOrderIdsFromFile();
        console.log(`✓ Found ${fileOrderIds.length} order IDs in invoiced file`);
        console.log(`  Range: ${Math.min(...fileOrderIds)} to ${Math.max(...fileOrderIds)}`);
        console.log();

        // Step 2: Get order IDs from API
        console.log('Step 2: Fetching order IDs from API...');
        const apiOrderIds = await getApiOrderIds();
        console.log(`✓ Found ${apiOrderIds.length} order IDs from API`);
        console.log(`  Range: ${Math.min(...apiOrderIds)} to ${Math.max(...apiOrderIds)}`);
        console.log();

        // Step 3: Compare the lists
        console.log('Step 3: Comparing order lists...');
        const comparison = compareOrderLists(fileOrderIds, apiOrderIds);
        
        // Step 4: Generate detailed report
        console.log('Step 4: Generating detailed analysis...');
        generateDetailedReport(comparison, fileOrderIds, apiOrderIds);

    } catch (error) {
        console.error('❌ Error during comparison:', error.message);
        if (error.code === 'ECONNREFUSED') {
            console.log('\n⚠️  Make sure the server is running on port 3002');
        }
    }
}

async function extractOrderIdsFromFile() {
    const fileContent = fs.readFileSync(INVOICED_FILE_PATH, 'utf8');
    const lines = fileContent.split('\n').filter(line => line.trim().length > 0);
    
    const orderIds = [];
    for (const line of lines) {
        // File is tab-separated with order ID as first column
        const columns = line.split('\t');
        if (columns.length > 0) {
            const orderIdStr = columns[0].trim();
            // Remove any non-numeric characters and convert to number
            const orderIdMatch = orderIdStr.match(/(\d+)/);
            if (orderIdMatch) {
                const orderId = parseInt(orderIdMatch[1]);
                if (!isNaN(orderId) && orderId > 0) {
                    orderIds.push(orderId);
                }
            }
        }
    }
    
    // Remove duplicates and sort
    return [...new Set(orderIds)].sort((a, b) => a - b);
}

async function getApiOrderIds() {
    console.log('  Making API request to order-dashboard with YoY to trigger full data fetch...');
    
    try {
        // Use the order-dashboard endpoint with YoY comparison to get full data
        const response = await axios.get(`${BASE_URL}/api/order-dashboard?compareYoY=true&days=365`, {
            timeout: 300000 // 5 minute timeout since this takes a while
        });
        
        if (response.data.yearOverYear && response.data.yearOverYear.currentYear) {
            const orderCount = response.data.yearOverYear.currentYear.orderCount;
            console.log(`  ✓ API returned ${orderCount} orders for current year`);
            
            // Now make direct calls to get the actual order IDs
            console.log('  Making direct API calls to get order IDs...');
            return await getOrderIdsDirectly();
        } else {
            throw new Error('YoY data not found in API response');
        }
    } catch (error) {
        console.log(`  ❌ Error with dashboard endpoint: ${error.message}`);
        console.log('  Falling back to direct API calls...');
        return await getOrderIdsDirectly();
    }
}

async function getOrderIdsDirectly() {
    // Get auth token first
    const token = await getCaspioToken();
    
    const orderIds = [];
    
    // Fetch by month like our API does
    const months = [
        { name: 'January', start: '2025-01-01', end: '2025-01-31' },
        { name: 'February', start: '2025-02-01', end: '2025-02-28' },
        { name: 'March', start: '2025-03-01', end: '2025-03-31' },
        { name: 'April', start: '2025-04-01', end: '2025-04-30' },
        { name: 'May', start: '2025-05-01', end: '2025-05-31' },
        { name: 'June', start: '2025-06-01', end: '2025-06-30' },
        { name: 'July', start: '2025-07-01', end: '2025-07-05' } // Up to current date
    ];
    
    for (const month of months) {
        console.log(`    Fetching ${month.name}...`);
        
        try {
            // Use the fetchAllCaspioPages approach for proper pagination
            let allMonthOrders = [];
            let offset = 0;
            const limit = 1000;
            let hasMore = true;
            
            while (hasMore) {
                const response = await axios.get(`https://${process.env.CASPIO_ACCOUNT_DOMAIN}/rest/v2/tables/ORDER_ODBC/records`, {
                    headers: {
                        'Authorization': `Bearer ${token}`
                    },
                    params: {
                        'q.where': `date_OrderInvoiced>='${month.start}' AND date_OrderInvoiced<='${month.end}' AND sts_Invoiced=1`,
                        'q.select': 'ID_Order',
                        'q.limit': limit,
                        'q.skip': offset,
                        'q.orderBy': 'ID_Order'
                    }
                });
                
                if (response.data.Result && response.data.Result.length > 0) {
                    allMonthOrders = allMonthOrders.concat(response.data.Result);
                    console.log(`      Offset ${offset}: ${response.data.Result.length} orders`);
                    
                    // If we got less than limit, we're done with this month
                    if (response.data.Result.length < limit) {
                        hasMore = false;
                    } else {
                        offset += limit;
                        // Safety check - don't fetch more than 10,000 per month
                        if (offset >= 10000) {
                            console.log(`      Safety limit reached for ${month.name}`);
                            hasMore = false;
                        }
                    }
                } else {
                    hasMore = false;
                }
            }
            
            // Extract order IDs
            const monthOrderIds = allMonthOrders.map(order => parseInt(order.ID_Order));
            orderIds.push(...monthOrderIds);
            console.log(`    ✓ ${month.name}: ${monthOrderIds.length} orders`);
            
        } catch (error) {
            console.log(`    ❌ Error fetching ${month.name}: ${error.message}`);
        }
    }
    
    // Remove duplicates and sort
    const uniqueOrderIds = [...new Set(orderIds)].sort((a, b) => a - b);
    console.log(`  ✓ Total unique order IDs from API: ${uniqueOrderIds.length}`);
    
    return uniqueOrderIds;
}

async function getCaspioToken() {
    const response = await axios.post(`https://${process.env.CASPIO_ACCOUNT_DOMAIN}/oauth/token`, 
        new URLSearchParams({
            'grant_type': 'client_credentials',
            'client_id': process.env.CASPIO_CLIENT_ID,
            'client_secret': process.env.CASPIO_CLIENT_SECRET
        }), {
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
        }
    );
    
    return response.data.access_token;
}

function compareOrderLists(fileOrderIds, apiOrderIds) {
    const fileSet = new Set(fileOrderIds);
    const apiSet = new Set(apiOrderIds);
    
    // Find orders that are in file but not in API
    const missingFromApi = fileOrderIds.filter(id => !apiSet.has(id));
    
    // Find orders that are in API but not in file
    const extraInApi = apiOrderIds.filter(id => !fileSet.has(id));
    
    // Find orders that are in both
    const inBoth = fileOrderIds.filter(id => apiSet.has(id));
    
    return {
        fileTotal: fileOrderIds.length,
        apiTotal: apiOrderIds.length,
        inBoth: inBoth.length,
        missingFromApi: missingFromApi,
        extraInApi: extraInApi
    };
}

function generateDetailedReport(comparison, fileOrderIds, apiOrderIds) {
    console.log('='.repeat(60));
    console.log('DETAILED COMPARISON REPORT');
    console.log('='.repeat(60));
    
    console.log(`\n📊 SUMMARY STATISTICS:`);
    console.log(`   File Total:        ${comparison.fileTotal.toLocaleString()} orders`);
    console.log(`   API Total:         ${comparison.apiTotal.toLocaleString()} orders`);
    console.log(`   In Both:           ${comparison.inBoth.toLocaleString()} orders`);
    console.log(`   Missing from API:  ${comparison.missingFromApi.length.toLocaleString()} orders`);
    console.log(`   Extra in API:      ${comparison.extraInApi.length.toLocaleString()} orders`);
    
    const discrepancy = comparison.fileTotal - comparison.apiTotal;
    console.log(`   Net Discrepancy:   ${discrepancy > 0 ? '+' : ''}${discrepancy.toLocaleString()} orders`);
    
    // Analysis of missing orders
    if (comparison.missingFromApi.length > 0) {
        console.log(`\n❌ ORDERS MISSING FROM API (first 20):`);
        const firstMissing = comparison.missingFromApi.slice(0, 20);
        firstMissing.forEach(id => console.log(`   Order ID: ${id}`));
        
        if (comparison.missingFromApi.length > 20) {
            console.log(`   ... and ${comparison.missingFromApi.length - 20} more`);
        }
        
        // Check for patterns in missing orders
        console.log(`\n🔍 MISSING ORDER PATTERNS:`);
        const minMissing = Math.min(...comparison.missingFromApi);
        const maxMissing = Math.max(...comparison.missingFromApi);
        console.log(`   Range: ${minMissing} to ${maxMissing}`);
        
        // Check if missing orders are in specific ranges
        analyzeOrderRanges(comparison.missingFromApi);
    }
    
    // Analysis of extra orders in API
    if (comparison.extraInApi.length > 0) {
        console.log(`\n➕ EXTRA ORDERS IN API (first 10):`);
        const firstExtra = comparison.extraInApi.slice(0, 10);
        firstExtra.forEach(id => console.log(`   Order ID: ${id}`));
        
        if (comparison.extraInApi.length > 10) {
            console.log(`   ... and ${comparison.extraInApi.length - 10} more`);
        }
    }
    
    // Coverage analysis
    const coverage = (comparison.inBoth / comparison.fileTotal * 100).toFixed(1);
    console.log(`\n📈 COVERAGE ANALYSIS:`);
    console.log(`   API covers ${coverage}% of invoiced orders from file`);
    
    if (coverage < 95) {
        console.log(`   ⚠️  Coverage is below 95% - significant data missing`);
    } else if (coverage < 99) {
        console.log(`   ⚠️  Coverage is below 99% - some data missing`);
    } else {
        console.log(`   ✅ Good coverage - minimal data missing`);
    }
    
    console.log(`\n💡 RECOMMENDATIONS:`);
    if (comparison.missingFromApi.length > 0) {
        console.log(`   1. Investigate why ${comparison.missingFromApi.length} orders are missing from API`);
        console.log(`   2. Check if sts_Invoiced filter is too restrictive`);
        console.log(`   3. Verify date range filters are correct`);
        console.log(`   4. Check for pagination issues in specific date ranges`);
    }
    
    if (comparison.extraInApi.length > 0) {
        console.log(`   5. Review why API has ${comparison.extraInApi.length} extra orders`);
        console.log(`   6. Verify the invoiced file date range (1/1/25 to 7/3/25)`);
    }
}

function analyzeOrderRanges(missingOrders) {
    if (missingOrders.length === 0) return;
    
    // Group consecutive missing orders into ranges
    const ranges = [];
    let currentRange = { start: missingOrders[0], end: missingOrders[0], count: 1 };
    
    for (let i = 1; i < missingOrders.length; i++) {
        if (missingOrders[i] === currentRange.end + 1) {
            // Consecutive order
            currentRange.end = missingOrders[i];
            currentRange.count++;
        } else {
            // Gap found, start new range
            ranges.push(currentRange);
            currentRange = { start: missingOrders[i], end: missingOrders[i], count: 1 };
        }
    }
    ranges.push(currentRange);
    
    // Show largest gaps
    const sortedRanges = ranges.sort((a, b) => b.count - a.count);
    console.log(`   Largest missing ranges:`);
    
    sortedRanges.slice(0, 5).forEach((range, index) => {
        if (range.count === 1) {
            console.log(`   ${index + 1}. Order ${range.start} (1 order)`);
        } else {
            console.log(`   ${index + 1}. Orders ${range.start}-${range.end} (${range.count} orders)`);
        }
    });
}

// Run the comparison
compareOrderData();