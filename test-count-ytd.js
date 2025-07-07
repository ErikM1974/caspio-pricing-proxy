const axios = require('axios');
require('dotenv').config();

const clientId = process.env.CASPIO_CLIENT_ID;
const clientSecret = process.env.CASPIO_CLIENT_SECRET;
const caspioDomain = process.env.CASPIO_DOMAIN || 'c3eku948.caspio.com';

async function getCaspioToken() {
    const tokenUrl = `https://${caspioDomain}/oauth/token`;
    const tokenData = new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: clientId,
        client_secret: clientSecret
    });

    const response = await axios.post(tokenUrl, tokenData.toString(), {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
    });
    
    return response.data.access_token;
}

async function countAllYTDOrders(year) {
    const token = await getCaspioToken();
    let allOrders = [];
    let page = 0;
    let hasMore = true;
    const pageSize = 1000;
    
    const yearStart = `${year}-01-01`;
    const yearEnd = year === 2025 ? '2025-07-07' : '2024-07-07';
    
    console.log(`\nCounting ${year} YTD orders (${yearStart} to ${yearEnd})...`);
    
    while (hasMore && page < 10) { // Safety limit of 10 pages
        const skip = page * pageSize;
        console.log(`  Page ${page + 1}: Fetching records ${skip + 1}-${skip + pageSize}...`);
        
        try {
            const response = await axios.get(`https://${caspioDomain}/integrations/rest/v3/tables/ORDER_ODBC/records`, {
                headers: { 'Authorization': `Bearer ${token}` },
                params: {
                    'q.where': `date_OrderInvoiced>='${yearStart}' AND date_OrderInvoiced<='${yearEnd}'`,
                    'q.limit': pageSize,
                    'q.skip': skip,
                    'q.orderby': 'ID_Order DESC'
                }
            });
            
            const records = response.data.Result || [];
            console.log(`    Got ${records.length} records`);
            
            if (records.length === 0) {
                hasMore = false;
            } else {
                // Check for duplicates by ID
                const newRecords = records.filter(r => !allOrders.some(existing => existing.ID_Order === r.ID_Order));
                allOrders = allOrders.concat(newRecords);
                console.log(`    Added ${newRecords.length} unique records (total: ${allOrders.length})`);
                
                if (records.length < pageSize) {
                    hasMore = false;
                }
            }
            
            page++;
        } catch (error) {
            console.error(`    Error on page ${page + 1}:`, error.message);
            hasMore = false;
        }
    }
    
    // Calculate total sales
    const totalSales = allOrders.reduce((sum, order) => sum + (parseFloat(order.cur_Subtotal) || 0), 0);
    
    console.log(`\n${year} YTD Summary:`);
    console.log(`- Total unique orders: ${allOrders.length}`);
    console.log(`- Total sales: $${totalSales.toFixed(2)}`);
    console.log(`- Pages fetched: ${page}`);
    
    return { orders: allOrders.length, sales: totalSales };
}

async function main() {
    try {
        console.log('Manually counting all YTD orders to verify actual totals...');
        
        const current = await countAllYTDOrders(2025);
        const previous = await countAllYTDOrders(2024);
        
        console.log('\n📊 Year-over-Year Comparison:');
        console.log('================================');
        console.log(`2025 YTD: ${current.orders} orders, $${current.sales.toFixed(2)}`);
        console.log(`2024 YTD: ${previous.orders} orders, $${previous.sales.toFixed(2)}`);
        console.log(`Growth: ${((current.sales - previous.sales) / previous.sales * 100).toFixed(2)}%`);
        
    } catch (error) {
        console.error('Error:', error.message);
    }
}

main();