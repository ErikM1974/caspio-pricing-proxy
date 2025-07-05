// Test to check all ORDER_TYPE values in the database
const axios = require('axios');
require('dotenv').config();

async function checkOrderTypes() {
    console.log('Checking ORDER_TYPE distribution for 2025 YTD...\n');
    
    try {
        // Get auth token
        const authResponse = await axios.post('https://c3eku948.caspio.com/oauth/token', 
            'grant_type=client_credentials',
            {
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded',
                    'Authorization': 'Basic ' + Buffer.from(process.env.CLIENT_ID + ':' + process.env.CLIENT_SECRET).toString('base64')
                }
            }
        );
        const token = authResponse.data.access_token;
        
        // Test query to see actual ORDER_TYPE distribution
        console.log('Fetching sample of 2025 orders to check ORDER_TYPE values...');
        const response = await axios.get('https://c3eku948.caspio.com/rest/v2/tables/ORDER_ODBC/records', {
            headers: {
                'Authorization': `Bearer ${token}`
            },
            params: {
                'q.where': "date_OrderPlaced>='2025-01-01' AND date_OrderPlaced<='2025-07-05'",
                'q.select': 'ORDER_TYPE,ID_Order',
                'q.limit': 1000,
                'q.orderBy': 'ORDER_TYPE'
            }
        });
        
        // Count by ORDER_TYPE
        const typeCounts = {};
        response.data.Result.forEach(order => {
            const type = order.ORDER_TYPE || 'NULL/EMPTY';
            typeCounts[type] = (typeCounts[type] || 0) + 1;
        });
        
        console.log(`\nFound ${response.data.Result.length} orders in sample`);
        console.log('\nORDER_TYPE Distribution:');
        console.log('========================');
        Object.entries(typeCounts)
            .sort((a, b) => b[1] - a[1])
            .forEach(([type, count]) => {
                console.log(`${type}: ${count} orders`);
            });
        
        // Get total count using a different approach
        console.log('\n\nTrying to get total count with pagination info...');
        const countResponse = await axios.get('https://c3eku948.caspio.com/rest/v2/tables/ORDER_ODBC/records', {
            headers: {
                'Authorization': `Bearer ${token}`
            },
            params: {
                'q.where': "date_OrderPlaced>='2025-01-01' AND date_OrderPlaced<='2025-07-05'",
                'q.select': 'ID_Order',
                'q.limit': 1
            }
        });
        
        console.log('Response headers:', countResponse.headers);
        
        // Check if there's a total count in headers or response
        if (countResponse.headers['x-total-count']) {
            console.log(`Total records (from header): ${countResponse.headers['x-total-count']}`);
        }
        
    } catch (error) {
        console.error('Error:', error.response?.data || error.message);
    }
}

checkOrderTypes();