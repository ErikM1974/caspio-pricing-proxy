// Debug test for YoY to see actual fetching
const axios = require('axios');

async function debugYoY() {
    console.log('Testing YoY with debug output...\n');
    
    try {
        const response = await axios.get('http://localhost:3002/api/order-dashboard?days=7&compareYoY=true');
        
        if (response.data.yearOverYear) {
            const yoy = response.data.yearOverYear;
            console.log('Year-over-Year Data:');
            console.log('==================');
            console.log(`Current Year Orders: ${yoy.currentYear.orderCount}`);
            console.log(`Previous Year Orders: ${yoy.previousYear.orderCount}`);
            console.log(`\nCurrent Year Sales: $${yoy.currentYear.totalSales.toLocaleString()}`);
            console.log(`Previous Year Sales: $${yoy.previousYear.totalSales.toLocaleString()}`);
            
            if (yoy.currentYear.orderCount >= 5000 || yoy.previousYear.orderCount >= 5000) {
                console.log('\n⚠️  WARNING: One or both years hit the 5000 record limit!');
                console.log('This means we are NOT getting all orders for the year.');
            }
        }
        
        // Also show regular dashboard data for comparison
        console.log('\n\nRegular Dashboard (7 days):');
        console.log('===========================');
        console.log(`Orders: ${response.data.summary.totalOrders}`);
        console.log(`Sales: $${response.data.summary.totalSales.toLocaleString()}`);
        
    } catch (error) {
        console.error('Error:', error.message);
    }
}

debugYoY();