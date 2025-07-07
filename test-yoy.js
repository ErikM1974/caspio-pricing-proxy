const axios = require('axios');

async function testYearOverYearEndpoint() {
    console.log('Testing Year-over-Year Comparison Endpoint...\n');
    
    const baseUrl = 'http://localhost:3002';
    const endpoint = '/api/order-dashboard?compareYoY=true';
    
    try {
        console.log(`Requesting: ${baseUrl}${endpoint}`);
        console.log('Please wait, this may take a minute to fetch all year-to-date data...\n');
        
        const startTime = Date.now();
        const response = await axios.get(`${baseUrl}${endpoint}`, {
            timeout: 120000 // 2 minute timeout for YTD data
        });
        const endTime = Date.now();
        
        console.log(`Response received in ${((endTime - startTime) / 1000).toFixed(1)} seconds\n`);
        
        if (response.data.yoyComparison) {
            const yoy = response.data.yoyComparison;
            console.log('✅ Year-over-Year Comparison Results:');
            console.log('=====================================');
            
            if (yoy.dateRanges) {
                console.log('\n📅 Date Ranges:');
                console.log(`Current Year: ${yoy.dateRanges.currentYear}`);
                console.log(`Last Year:    ${yoy.dateRanges.lastYear}`);
            }
            
            console.log('\n💰 Sales Totals:');
            console.log(`Current Year: $${yoy.currentYearTotal?.toLocaleString() || 'N/A'}`);
            console.log(`Last Year:    $${yoy.lastYearTotal?.toLocaleString() || 'N/A'}`);
            
            console.log('\n📦 Order Counts:');
            console.log(`Current Year: ${yoy.currentYearOrders?.toLocaleString() || 'N/A'} orders`);
            console.log(`Last Year:    ${yoy.lastYearOrders?.toLocaleString() || 'N/A'} orders`);
            
            console.log('\n📈 Growth Metrics:');
            console.log(`Sales Growth:  ${yoy.salesGrowthPercent}%`);
            console.log(`Order Growth:  ${yoy.orderGrowthPercent}%`);
            
            // Check if we're getting all records
            if (yoy.currentYearOrders === 1000 || yoy.lastYearOrders === 1000) {
                console.log('\n⚠️  WARNING: One or both years show exactly 1000 orders.');
                console.log('This may indicate pagination limits are being hit.');
            } else {
                console.log('\n✅ Record counts look realistic (not hitting 1000 limit)');
            }
            
        } else {
            console.log('❌ No yoyComparison data in response');
            console.log('Response structure:', Object.keys(response.data));
        }
        
    } catch (error) {
        console.error('❌ Error testing endpoint:', error.message);
        if (error.code === 'ECONNREFUSED') {
            console.log('\nMake sure the server is running on port 3002');
            console.log('Start it with: PORT=3002 node server.js');
        }
    }
}

// Run the test
testYearOverYearEndpoint();