// Test to check for duplicate records
const axios = require('axios');

async function checkDuplicates() {
    console.log('Checking for duplicate records in ORDER_ODBC...\n');
    
    try {
        // Make a direct API call to get a small sample
        const token = await getToken();
        const response = await axios.get('https://c3eku948.caspio.com/integrations/rest/v2/tables/ORDER_ODBC/records', {
            headers: {
                'Authorization': `Bearer ${token}`
            },
            params: {
                'q.where': "date_OrderPlaced>='2025-07-01' AND date_OrderPlaced<='2025-07-01'",
                'q.select': 'ID_Order,cur_Subtotal,date_OrderPlaced,PK_ID',
                'q.limit': 20,
                'q.orderBy': 'ID_Order'
            }
        });
        
        console.log(`Fetched ${response.data.Result.length} records for July 1, 2025:`);
        
        // Group by ID_Order to check for duplicates
        const orderMap = {};
        response.data.Result.forEach(record => {
            if (!orderMap[record.ID_Order]) {
                orderMap[record.ID_Order] = [];
            }
            orderMap[record.ID_Order].push(record);
        });
        
        // Check for duplicates
        Object.keys(orderMap).forEach(orderId => {
            const records = orderMap[orderId];
            if (records.length > 1) {
                console.log(`\nOrder ${orderId} has ${records.length} duplicate records:`);
                records.forEach(r => {
                    console.log(`  PK_ID: ${r.PK_ID}, Subtotal: ${r.cur_Subtotal}`);
                });
            }
        });
        
        // Summary
        const uniqueOrders = Object.keys(orderMap).length;
        console.log(`\nSummary: ${response.data.Result.length} total records, ${uniqueOrders} unique orders`);
        
        if (response.data.Result.length > uniqueOrders) {
            console.log(`\n⚠️  Found ${response.data.Result.length - uniqueOrders} duplicate records!`);
            console.log('This explains why we\'re getting 20x more records than expected.');
        }
        
    } catch (error) {
        console.error('Error:', error.message);
    }
}

// Get auth token
async function getToken() {
    const authResponse = await axios.post('https://c3eku948.caspio.com/v2/oauth/token', 
        'grant_type=client_credentials',
        {
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                'Authorization': 'Basic ' + Buffer.from(process.env.CLIENT_ID + ':' + process.env.CLIENT_SECRET).toString('base64')
            }
        }
    );
    return authResponse.data.access_token;
}

// Load env vars
require('dotenv').config();
checkDuplicates();