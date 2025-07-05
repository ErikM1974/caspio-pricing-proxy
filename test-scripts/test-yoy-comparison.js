// Test script for Year-over-Year comparison feature
const axios = require('axios');

const BASE_URL = 'http://localhost:3002';

async function testYoYComparison() {
    console.log('Testing Year-over-Year comparison feature...\n');
    
    try {
        // Test 1: Request without YoY comparison
        console.log('Test 1: Regular request (no YoY)');
        const response1 = await axios.get(`${BASE_URL}/api/order-dashboard?days=7`);
        console.log(`✓ Total orders (7 days): ${response1.data.summary.totalOrders}`);
        console.log(`✓ Total sales (7 days): $${response1.data.summary.totalSales}`);
        console.log(`✓ Has yearOverYear data: ${response1.data.yearOverYear ? 'Yes' : 'No'}`);
        
        // Test 2: Request with YoY comparison
        console.log('\nTest 2: Request with Year-over-Year comparison');
        const response2 = await axios.get(`${BASE_URL}/api/order-dashboard?days=7&compareYoY=true`);
        console.log(`✓ Status: ${response2.status}`);
        
        if (response2.data.yearOverYear) {
            const yoy = response2.data.yearOverYear;
            console.log('\nCurrent Year (YTD):');
            console.log(`  Period: ${yoy.currentYear.period}`);
            console.log(`  Orders: ${yoy.currentYear.orderCount}`);
            console.log(`  Sales: $${yoy.currentYear.totalSales}`);
            
            console.log('\nPrevious Year (Same period):');
            console.log(`  Period: ${yoy.previousYear.period}`);
            console.log(`  Orders: ${yoy.previousYear.orderCount}`);
            console.log(`  Sales: $${yoy.previousYear.totalSales}`);
            
            console.log('\nYear-over-Year Comparison:');
            console.log(`  Sales Growth: ${yoy.comparison.salesGrowth}%`);
            console.log(`  Sales Difference: $${yoy.comparison.salesDifference}`);
            console.log(`  Order Growth: ${yoy.comparison.orderGrowth}%`);
            console.log(`  Order Difference: ${yoy.comparison.orderDifference}`);
            
            // Visual indicator
            const growthIcon = yoy.comparison.salesGrowth >= 0 ? '📈' : '📉';
            console.log(`\n${growthIcon} Overall: ${yoy.comparison.salesGrowth >= 0 ? 'UP' : 'DOWN'} ${Math.abs(yoy.comparison.salesGrowth)}% compared to last year`);
        } else {
            console.log('❌ No yearOverYear data in response');
        }
        
        // Test 3: Verify cache works with YoY parameter
        console.log('\nTest 3: Testing cache with YoY parameter');
        const start = Date.now();
        await axios.get(`${BASE_URL}/api/order-dashboard?days=7&compareYoY=true`);
        const cacheTime = Date.now() - start;
        console.log(`✓ Cached YoY request took ${cacheTime}ms`);
        
        // Test 4: Different days parameter with YoY
        console.log('\nTest 4: 30-day period with YoY comparison');
        const response4 = await axios.get(`${BASE_URL}/api/order-dashboard?days=30&compareYoY=true`);
        console.log(`✓ 30-day orders: ${response4.data.summary.totalOrders}`);
        console.log(`✓ YTD orders: ${response4.data.yearOverYear?.currentYear.orderCount || 'N/A'}`);
        
    } catch (error) {
        console.error('Error:', error.response?.data || error.message);
        console.log('\nMake sure the server is running on port 3002');
    }
}

testYoYComparison();