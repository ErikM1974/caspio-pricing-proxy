const axios = require('axios');
require('dotenv').config();

// Get Caspio credentials
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

async function testCaspioPagination() {
    console.log('Testing Caspio API pagination directly...\n');
    
    try {
        const token = await getCaspioToken();
        console.log('✅ Got Caspio token\n');
        
        // Test current year YTD
        const currentYearUrl = `https://${caspioDomain}/integrations/rest/v3/tables/ORDER_ODBC/records`;
        const params = {
            'q.where': "date_OrderInvoiced>='2025-01-01' AND date_OrderInvoiced<='2025-07-07'",
            'q.limit': 1000,
            'q.orderby': 'ID_Order DESC'
        };
        
        console.log('Making request with params:', params);
        
        const response = await axios.get(currentYearUrl, {
            headers: { 'Authorization': `Bearer ${token}` },
            params: params
        });
        
        console.log('\nResponse details:');
        console.log('- Status:', response.status);
        console.log('- TotalRecords:', response.data.TotalRecords);
        console.log('- Result.length:', response.data.Result?.length);
        console.log('- HasMoreResults:', response.data.HasMoreResults);
        console.log('- NextPageUrl:', response.data.NextPageUrl || 'Not provided');
        
        // Check response headers
        console.log('\nRelevant headers:');
        Object.keys(response.headers).forEach(key => {
            if (key.toLowerCase().includes('page') || key.toLowerCase().includes('link')) {
                console.log(`- ${key}:`, response.headers[key]);
            }
        });
        
        if (response.data.TotalRecords > response.data.Result?.length) {
            console.log(`\n⚠️  WARNING: TotalRecords (${response.data.TotalRecords}) > Result.length (${response.data.Result?.length})`);
            console.log('This indicates there are more records available but pagination info may be missing.');
        }
        
    } catch (error) {
        console.error('Error:', error.message);
        if (error.response) {
            console.error('Response data:', error.response.data);
        }
    }
}

testCaspioPagination();