const axios = require('axios');
require('dotenv').config();

const clientId = process.env.CASPIO_CLIENT_ID;
const clientSecret = process.env.CASPIO_CLIENT_SECRET;
const caspioDomain = process.env.CASPIO_DOMAIN || 'c3eku948.caspio.com';

async function getCaspioToken() {
    const tokenUrl = `https://${caspioDomain}/oauth/token`;
    const tokenData = new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: clientId,
        client_secret: clientSecret
    });

    const response = await axios.post(tokenUrl, tokenData.toString(), {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
    });
    
    return response.data.access_token;
}

async function testSkipPagination() {
    console.log('Testing Caspio API pagination with skip parameter...\n');
    
    try {
        const token = await getCaspioToken();
        
        // First request - no skip
        console.log('Request 1: No skip parameter');
        const response1 = await axios.get(`https://${caspioDomain}/integrations/rest/v3/tables/ORDER_ODBC/records`, {
            headers: { 'Authorization': `Bearer ${token}` },
            params: {
                'q.where': "date_OrderInvoiced>='2025-01-01' AND date_OrderInvoiced<='2025-07-07'",
                'q.limit': 1000,
                'q.orderby': 'ID_Order DESC'
            }
        });
        
        console.log(`- Got ${response1.data.Result?.length || 0} records`);
        const firstId = response1.data.Result?.[0]?.ID_Order;
        const lastId = response1.data.Result?.[response1.data.Result.length - 1]?.ID_Order;
        console.log(`- First ID: ${firstId}, Last ID: ${lastId}`);
        
        // Second request - skip 1000
        console.log('\nRequest 2: Skip 1000 records');
        const response2 = await axios.get(`https://${caspioDomain}/integrations/rest/v3/tables/ORDER_ODBC/records`, {
            headers: { 'Authorization': `Bearer ${token}` },
            params: {
                'q.where': "date_OrderInvoiced>='2025-01-01' AND date_OrderInvoiced<='2025-07-07'",
                'q.limit': 1000,
                'q.skip': 1000,
                'q.orderby': 'ID_Order DESC'
            }
        });
        
        console.log(`- Got ${response2.data.Result?.length || 0} records`);
        if (response2.data.Result?.length > 0) {
            const firstId2 = response2.data.Result[0].ID_Order;
            const lastId2 = response2.data.Result[response2.data.Result.length - 1].ID_Order;
            console.log(`- First ID: ${firstId2}, Last ID: ${lastId2}`);
            console.log('\n✅ Skip parameter is working! We can fetch all records.');
        } else {
            console.log('\n❌ No records returned with skip=1000');
        }
        
    } catch (error) {
        console.error('Error:', error.message);
        if (error.response) {
            console.error('Status:', error.response.status);
            console.error('Data:', error.response.data);
        }
    }
}

testSkipPagination();