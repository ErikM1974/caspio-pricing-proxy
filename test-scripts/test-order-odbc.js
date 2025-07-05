// Test script for Order ODBC endpoint
const axios = require('axios');

// Configuration
const BASE_URL = 'http://localhost:3002'; // Change to Heroku URL if needed

async function testOrderODBC() {
    console.log('Testing Order ODBC API...\n');

    try {
        // Test 1: Basic request without parameters
        console.log('Test 1: Basic request (no parameters)');
        const response1 = await axios.get(`${BASE_URL}/api/order-odbc`);
        console.log(`✓ Status: ${response1.status}`);
        console.log(`✓ Records returned: ${response1.data.length}`);
        if (response1.data.length > 0) {
            const firstOrder = response1.data[0];
            console.log(`✓ Sample order - ID: ${firstOrder.ID_Order}, Company: ${firstOrder.CompanyName}`);
        }
        console.log('');

        // Test 2: With limit parameter
        console.log('Test 2: With limit parameter (q.limit=3)');
        const response2 = await axios.get(`${BASE_URL}/api/order-odbc?q.limit=3`);
        console.log(`✓ Status: ${response2.status}`);
        console.log(`✓ Records returned: ${response2.data.length}`);
        console.log('');

        // Test 3: With orderBy parameter
        console.log('Test 3: With orderBy parameter (q.orderBy=date_OrderPlaced DESC)');
        const response3 = await axios.get(`${BASE_URL}/api/order-odbc?q.orderBy=date_OrderPlaced DESC&q.limit=3`);
        console.log(`✓ Status: ${response3.status}`);
        console.log(`✓ Records returned: ${response3.data.length}`);
        if (response3.data.length > 0) {
            console.log(`✓ First order date: ${response3.data[0].date_OrderPlaced}`);
        }
        console.log('');

        // Test 4: Filter by customer
        console.log('Test 4: Filter by customer ID (q.where=id_Customer=11824)');
        const response4 = await axios.get(`${BASE_URL}/api/order-odbc?q.where=id_Customer=11824`);
        console.log(`✓ Status: ${response4.status}`);
        console.log(`✓ Records returned: ${response4.data.length}`);
        if (response4.data.length > 0) {
            console.log(`✓ Customer name: ${response4.data[0].CompanyName}`);
        }
        console.log('');

        // Test 5: Filter by date range
        console.log('Test 5: Filter by date range');
        const response5 = await axios.get(`${BASE_URL}/api/order-odbc?q.where=date_OrderPlaced>'2021-03-01' AND date_OrderPlaced<'2021-03-31'&q.orderBy=date_OrderPlaced ASC`);
        console.log(`✓ Status: ${response5.status}`);
        console.log(`✓ Records returned: ${response5.data.length}`);
        console.log('');

        // Test 6: Filter by order status
        console.log('Test 6: Filter by shipped status (q.where=sts_Shipped=0)');
        const response6 = await axios.get(`${BASE_URL}/api/order-odbc?q.where=sts_Shipped=0&q.limit=5`);
        console.log(`✓ Status: ${response6.status}`);
        console.log(`✓ Unshipped orders found: ${response6.data.length}`);
        console.log('');

        // Test 7: Complex query - multiple filters
        console.log('Test 7: Complex query - invoiced but not shipped');
        const response7 = await axios.get(`${BASE_URL}/api/order-odbc?q.where=sts_Invoiced=1 AND sts_Shipped=0&q.orderBy=date_OrderInvoiced DESC`);
        console.log(`✓ Status: ${response7.status}`);
        console.log(`✓ Records returned: ${response7.data.length}`);
        console.log('');

        // Test 8: Error case - invalid limit
        console.log('Test 8: Error handling - invalid limit');
        try {
            await axios.get(`${BASE_URL}/api/order-odbc?q.limit=2000`);
        } catch (error) {
            console.log(`✓ Expected error: ${error.response.status} - ${error.response.data.error}`);
        }

        console.log('\n✅ All tests completed successfully!');
        
        // Display some useful stats
        console.log('\n📊 Order Statistics:');
        const allOrders = response1.data;
        const totalOrders = allOrders.length;
        const shippedOrders = allOrders.filter(o => o.sts_Shipped === 1).length;
        const invoicedOrders = allOrders.filter(o => o.sts_Invoiced === 1).length;
        
        console.log(`Total orders: ${totalOrders}`);
        console.log(`Shipped orders: ${shippedOrders}`);
        console.log(`Invoiced orders: ${invoicedOrders}`);
        
    } catch (error) {
        console.error('❌ Test failed:', error.response ? error.response.data : error.message);
    }
}

// Run the tests
testOrderODBC();