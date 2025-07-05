// Test script for chunked YoY calculations
const axios = require('axios');

const BASE_URL = 'http://localhost:3002';

async function testChunkedYoY() {
    console.log('Testing chunked Year-over-Year calculations...\n');
    console.log('This will take longer as it fetches data for each order type separately.\n');
    
    try {
        // Test with YoY comparison
        console.log('Fetching YoY comparison data (this may take 1-2 minutes)...');
        const startTime = Date.now();
        
        const response = await axios.get(`${BASE_URL}/api/order-dashboard?days=7&compareYoY=true`, {
            timeout: 300000 // 5 minute timeout
        });
        
        const fetchTime = Date.now() - startTime;
        console.log(`\nFetch completed in ${(fetchTime/1000).toFixed(1)} seconds`);
        
        if (response.data.yearOverYear) {
            const yoy = response.data.yearOverYear;
            
            console.log('\n========== Year-over-Year Results ==========');
            console.log('\nCurrent Year (2025 YTD):');
            console.log(`  Period: ${yoy.currentYear.period}`);
            console.log(`  Orders: ${yoy.currentYear.orderCount.toLocaleString()}`);
            console.log(`  Sales: $${yoy.currentYear.totalSales.toLocaleString()}`);
            if (yoy.currentYear.orderCount > 0) {
                console.log(`  Avg Order Value: $${(yoy.currentYear.totalSales / yoy.currentYear.orderCount).toFixed(2)}`);
            }
            
            console.log('\nPrevious Year (2024 YTD):');
            console.log(`  Period: ${yoy.previousYear.period}`);
            console.log(`  Orders: ${yoy.previousYear.orderCount.toLocaleString()}`);
            console.log(`  Sales: $${yoy.previousYear.totalSales.toLocaleString()}`);
            if (yoy.previousYear.orderCount > 0) {
                console.log(`  Avg Order Value: $${(yoy.previousYear.totalSales / yoy.previousYear.orderCount).toFixed(2)}`);
            }
            
            console.log('\nYear-over-Year Comparison:');
            console.log(`  Sales Growth: ${yoy.comparison.salesGrowth > 0 ? '+' : ''}${yoy.comparison.salesGrowth}%`);
            console.log(`  Sales Difference: ${yoy.comparison.salesDifference > 0 ? '+' : ''}$${yoy.comparison.salesDifference.toLocaleString()}`);
            console.log(`  Order Growth: ${yoy.comparison.orderGrowth > 0 ? '+' : ''}${yoy.comparison.orderGrowth}%`);
            console.log(`  Order Difference: ${yoy.comparison.orderDifference > 0 ? '+' : ''}${yoy.comparison.orderDifference.toLocaleString()}`);
            
            // Visual indicator
            const growthIcon = yoy.comparison.salesGrowth >= 0 ? '📈' : '📉';
            const growthText = yoy.comparison.salesGrowth >= 0 ? 'UP' : 'DOWN';
            console.log(`\n${growthIcon} Overall Performance: ${growthText} ${Math.abs(yoy.comparison.salesGrowth)}% compared to last year`);
            
            // Check if we got more data than before
            console.log('\n========== Data Completeness Check ==========');
            if (yoy.currentYear.orderCount > 1000 || yoy.previousYear.orderCount > 1000) {
                console.log('✅ SUCCESS: Fetched more than 1,000 orders using chunked approach!');
                console.log('   The chunking by ORDER_TYPE worked to bypass pagination limits.');
            } else {
                console.log('⚠️  Still limited to 1,000 orders or less');
            }
            
            if (yoy.note) {
                console.log(`\nNote: ${yoy.note}`);
            }
        } else {
            console.log('❌ No yearOverYear data in response');
        }
        
        // Also show regular dashboard data for comparison
        console.log('\n========== Regular Dashboard (7 days) ==========');
        console.log(`Orders: ${response.data.summary.totalOrders}`);
        console.log(`Sales: $${response.data.summary.totalSales.toLocaleString()}`);
        
    } catch (error) {
        if (error.code === 'ECONNABORTED') {
            console.error('Request timed out. The chunked approach takes longer but fetches all data.');
        } else {
            console.error('Error:', error.response?.data || error.message);
        }
        if (error.code === 'ECONNREFUSED') {
            console.log('\n⚠️  Make sure the server is running on port 3002');
        }
    }
}

testChunkedYoY();