// Quick test to verify cache fix for different days parameters
const axios = require('axios');

const BASE_URL = 'http://localhost:3002';

async function testCacheFix() {
    console.log('Testing cache fix for order-dashboard...\n');
    
    try {
        // Test 1: Request with days=2
        console.log('Test 1: Requesting days=2');
        const response1 = await axios.get(`${BASE_URL}/api/order-dashboard?days=2`);
        const orders2days = response1.data.summary.totalOrders;
        const sales2days = response1.data.summary.totalSales;
        console.log(`Days=2: ${orders2days} orders, $${sales2days}`);
        
        // Test 2: Request with days=7
        console.log('\nTest 2: Requesting days=7');
        const response2 = await axios.get(`${BASE_URL}/api/order-dashboard?days=7`);
        const orders7days = response2.data.summary.totalOrders;
        const sales7days = response2.data.summary.totalSales;
        console.log(`Days=7: ${orders7days} orders, $${sales7days}`);
        
        // Test 3: Request with days=30
        console.log('\nTest 3: Requesting days=30');
        const response3 = await axios.get(`${BASE_URL}/api/order-dashboard?days=30`);
        const orders30days = response3.data.summary.totalOrders;
        const sales30days = response3.data.summary.totalSales;
        console.log(`Days=30: ${orders30days} orders, $${sales30days}`);
        
        // Verify results are different
        console.log('\n--- Verification ---');
        if (orders2days === orders7days && orders7days === orders30days) {
            console.log('❌ FAILED: All requests returned the same order count!');
        } else {
            console.log('✅ SUCCESS: Different day ranges return different results');
            console.log(`   2 days: ${orders2days} orders`);
            console.log(`   7 days: ${orders7days} orders`);
            console.log(`   30 days: ${orders30days} orders`);
        }
        
        // Test cache by requesting same parameter twice
        console.log('\n--- Testing Cache ---');
        const start = Date.now();
        await axios.get(`${BASE_URL}/api/order-dashboard?days=7`);
        const cacheTime = Date.now() - start;
        console.log(`Cached request took ${cacheTime}ms (should be very fast)`);
        
    } catch (error) {
        console.error('Error:', error.message);
        console.log('\nMake sure the server is running on port 3002');
    }
}

testCacheFix();