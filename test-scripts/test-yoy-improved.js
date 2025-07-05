// Test script for improved YoY calculations
const axios = require('axios');

const BASE_URL = 'http://localhost:3002';

async function testImprovedYoY() {
    console.log('Testing improved Year-over-Year calculations...\n');
    
    try {
        // Test with YoY comparison
        console.log('Fetching YoY comparison data...');
        const startTime = Date.now();
        const response = await axios.get(`${BASE_URL}/api/order-dashboard?days=7&compareYoY=true`);
        const fetchTime = Date.now() - startTime;
        
        console.log(`\nFetch completed in ${fetchTime}ms`);
        
        if (response.data.yearOverYear) {
            const yoy = response.data.yearOverYear;
            
            console.log('\n========== Year-over-Year Results ==========');
            console.log('\nCurrent Year (2025 YTD):');
            console.log(`  Period: ${yoy.currentYear.period}`);
            console.log(`  Orders: ${yoy.currentYear.orderCount.toLocaleString()}`);
            console.log(`  Sales: $${yoy.currentYear.totalSales.toLocaleString()}`);
            console.log(`  Avg Order Value: $${(yoy.currentYear.totalSales / yoy.currentYear.orderCount).toFixed(2)}`);
            
            console.log('\nPrevious Year (2024 YTD):');
            console.log(`  Period: ${yoy.previousYear.period}`);
            console.log(`  Orders: ${yoy.previousYear.orderCount.toLocaleString()}`);
            console.log(`  Sales: $${yoy.previousYear.totalSales.toLocaleString()}`);
            console.log(`  Avg Order Value: $${(yoy.previousYear.totalSales / yoy.previousYear.orderCount).toFixed(2)}`);
            
            console.log('\nYear-over-Year Comparison:');
            console.log(`  Sales Growth: ${yoy.comparison.salesGrowth > 0 ? '+' : ''}${yoy.comparison.salesGrowth}%`);
            console.log(`  Sales Difference: ${yoy.comparison.salesDifference > 0 ? '+' : ''}$${yoy.comparison.salesDifference.toLocaleString()}`);
            console.log(`  Order Growth: ${yoy.comparison.orderGrowth > 0 ? '+' : ''}${yoy.comparison.orderGrowth}%`);
            console.log(`  Order Difference: ${yoy.comparison.orderDifference > 0 ? '+' : ''}${yoy.comparison.orderDifference.toLocaleString()}`);
            
            // Visual indicator
            const growthIcon = yoy.comparison.salesGrowth >= 0 ? '📈' : '📉';
            const growthText = yoy.comparison.salesGrowth >= 0 ? 'UP' : 'DOWN';
            console.log(`\n${growthIcon} Overall Performance: ${growthText} ${Math.abs(yoy.comparison.salesGrowth)}% compared to last year`);
            
            // Data quality check
            console.log('\n========== Data Quality Check ==========');
            if (yoy.currentYear.orderCount >= 1000 || yoy.previousYear.orderCount >= 1000) {
                console.log('✅ Fetching full YTD data (1000+ orders)');
            }
            if (yoy.note) {
                console.log(`⚠️  Note: ${yoy.note}`);
            }
        } else {
            console.log('❌ No yearOverYear data in response');
        }
        
        // Also show regular dashboard data for comparison
        console.log('\n========== Regular Dashboard (7 days) ==========');
        console.log(`Orders: ${response.data.summary.totalOrders}`);
        console.log(`Sales: $${response.data.summary.totalSales.toLocaleString()}`);
        console.log(`Avg Order Value: $${response.data.summary.avgOrderValue.toFixed(2)}`);
        
    } catch (error) {
        console.error('Error:', error.response?.data || error.message);
        if (error.code === 'ECONNREFUSED') {
            console.log('\n⚠️  Make sure the server is running on port 3002');
        }
    }
}

testImprovedYoY();