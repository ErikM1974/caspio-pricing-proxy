// Test script for Order Dashboard endpoint
const axios = require('axios');

// Configuration
const BASE_URL = 'http://localhost:3002'; // Change to Heroku URL if needed

async function testOrderDashboard() {
    console.log('Testing Order Dashboard API...\n');

    try {
        // Test 1: Default request (7 days)
        console.log('Test 1: Default request (7 days, no details)');
        const response1 = await axios.get(`${BASE_URL}/api/order-dashboard`);
        console.log(`✓ Status: ${response1.status}`);
        console.log(`✓ Total orders: ${response1.data.summary.totalOrders}`);
        console.log(`✓ Total sales: $${response1.data.summary.totalSales}`);
        console.log(`✓ Not invoiced: ${response1.data.summary.notInvoiced}`);
        console.log(`✓ Not shipped: ${response1.data.summary.notShipped}`);
        console.log(`✓ Average order: $${response1.data.summary.avgOrderValue.toFixed(2)}`);
        console.log('');

        // Test 2: Different time period (30 days)
        console.log('Test 2: 30-day period');
        const response2 = await axios.get(`${BASE_URL}/api/order-dashboard?days=30`);
        console.log(`✓ Status: ${response2.status}`);
        console.log(`✓ Total orders (30 days): ${response2.data.summary.totalOrders}`);
        console.log(`✓ Date range: ${response2.data.dateRange.start} to ${response2.data.dateRange.end}`);
        console.log('');

        // Test 3: Include order details
        console.log('Test 3: With order details (includeDetails=true)');
        const response3 = await axios.get(`${BASE_URL}/api/order-dashboard?days=7&includeDetails=true`);
        console.log(`✓ Status: ${response3.status}`);
        console.log(`✓ Recent orders included: ${response3.data.recentOrders ? response3.data.recentOrders.length : 0}`);
        if (response3.data.recentOrders && response3.data.recentOrders.length > 0) {
            const firstOrder = response3.data.recentOrders[0];
            console.log(`✓ Most recent order: ID ${firstOrder.ID_Order} - ${firstOrder.CompanyName} - $${firstOrder.cur_Subtotal}`);
        }
        console.log('');

        // Test 4: Today's stats
        console.log('Test 4: Today\'s statistics');
        console.log(`✓ Orders today: ${response1.data.todayStats.ordersToday}`);
        console.log(`✓ Sales today: $${response1.data.todayStats.salesToday}`);
        console.log(`✓ Shipped today: ${response1.data.todayStats.shippedToday}`);
        console.log('');

        // Test 5: Breakdown analysis
        console.log('Test 5: Sales breakdown');
        console.log('By CSR:');
        response1.data.breakdown.byCsr.slice(0, 3).forEach(csr => {
            console.log(`  - ${csr.name}: ${csr.orders} orders, $${csr.sales}`);
        });
        console.log('\nBy Order Type:');
        response1.data.breakdown.byOrderType.slice(0, 3).forEach(type => {
            console.log(`  - ${type.type}: ${type.orders} orders, $${type.sales}`);
        });
        console.log('');

        // Test 6: Cache test
        console.log('Test 6: Cache test (second request should be faster)');
        const start = Date.now();
        await axios.get(`${BASE_URL}/api/order-dashboard`);
        const firstTime = Date.now() - start;
        
        const start2 = Date.now();
        await axios.get(`${BASE_URL}/api/order-dashboard`);
        const secondTime = Date.now() - start2;
        
        console.log(`✓ First request: ${firstTime}ms`);
        console.log(`✓ Second request (cached): ${secondTime}ms`);
        console.log(`✓ Cache working: ${secondTime < firstTime ? 'Yes' : 'No'}`);
        
        console.log('\n✅ All tests completed successfully!');
        
    } catch (error) {
        console.error('❌ Test failed:', error.response ? error.response.data : error.message);
    }
}

// Run the tests
testOrderDashboard();