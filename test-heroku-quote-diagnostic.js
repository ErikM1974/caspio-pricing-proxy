// Diagnostic test to identify issues with Quote API POST operations on Heroku

const https = require('https');

const HEROKU_BASE_URL = 'https://caspio-pricing-proxy-ab30a049961a.herokuapp.com';

// Utility function to make HTTP requests with detailed logging
function makeRequest(method, path, data = null) {
    return new Promise((resolve, reject) => {
        const url = new URL(path, HEROKU_BASE_URL);
        
        const options = {
            hostname: url.hostname,
            port: 443,
            path: url.pathname + url.search,
            method: method,
            headers: {
                'Content-Type': 'application/json'
            }
        };

        console.log(`\n🔍 Making ${method} request to: ${url.href}`);
        if (data) {
            console.log(`📤 Request data: ${JSON.stringify(data, null, 2)}`);
        }

        const req = https.request(options, (res) => {
            let responseData = '';
            
            res.on('data', (chunk) => {
                responseData += chunk;
            });
            
            res.on('end', () => {
                console.log(`📥 Response status: ${res.statusCode}`);
                console.log(`📥 Response headers: ${JSON.stringify(res.headers, null, 2)}`);
                console.log(`📥 Raw response data: ${responseData}`);
                
                try {
                    const parsedData = responseData ? JSON.parse(responseData) : {};
                    resolve({
                        statusCode: res.statusCode,
                        data: parsedData,
                        headers: res.headers,
                        rawData: responseData
                    });
                } catch (error) {
                    console.log(`⚠️  JSON parse error: ${error.message}`);
                    resolve({
                        statusCode: res.statusCode,
                        data: responseData,
                        headers: res.headers,
                        rawData: responseData
                    });
                }
            });
        });

        req.on('error', (error) => {
            console.error(`❌ Request error: ${error.message}`);
            reject(error);
        });

        if (data) {
            req.write(JSON.stringify(data));
        }

        req.end();
    });
}

async function runDiagnosticTests() {
    const testSessionId = `diag-session-${Date.now()}`;
    const testQuoteId = `diag-quote-${Date.now()}`;

    console.log('🔬 DIAGNOSTIC TESTS FOR HEROKU QUOTE API');
    console.log(`Base URL: ${HEROKU_BASE_URL}`);
    console.log(`Test Session ID: ${testSessionId}`);
    console.log(`Test Quote ID: ${testQuoteId}`);
    console.log('='.repeat(60));

    try {
        // Test 1: Minimal Quote Analytics POST
        console.log('\n🧪 TEST 1: Minimal Quote Analytics POST');
        const minimalAnalyticsData = {
            SessionID: testSessionId,
            EventType: 'test_event'
        };

        const analyticsResult = await makeRequest('POST', '/api/quote_analytics', minimalAnalyticsData);
        console.log(`Result: ${analyticsResult.statusCode === 201 ? '✅ SUCCESS' : '❌ FAILED'}`);

        // Test 2: Minimal Quote Items POST
        console.log('\n🧪 TEST 2: Minimal Quote Items POST');
        const minimalItemData = {
            QuoteID: testQuoteId,
            StyleNumber: 'TEST123',
            Quantity: 1
        };

        const itemResult = await makeRequest('POST', '/api/quote_items', minimalItemData);
        console.log(`Result: ${itemResult.statusCode === 201 ? '✅ SUCCESS' : '❌ FAILED'}`);

        // Test 3: Minimal Quote Sessions POST
        console.log('\n🧪 TEST 3: Minimal Quote Sessions POST');
        const minimalSessionData = {
            QuoteID: testQuoteId,
            SessionID: testSessionId,
            Status: 'Active'
        };

        const sessionResult = await makeRequest('POST', '/api/quote_sessions', minimalSessionData);
        console.log(`Result: ${sessionResult.statusCode === 201 ? '✅ SUCCESS' : '❌ FAILED'}`);

        // Test 4: Check existing data structure
        console.log('\n🧪 TEST 4: Checking existing data structure');
        
        console.log('\n📊 Existing Quote Analytics:');
        const existingAnalytics = await makeRequest('GET', '/api/quote_analytics?limit=1');
        if (existingAnalytics.data && existingAnalytics.data.length > 0) {
            console.log(`Sample record: ${JSON.stringify(existingAnalytics.data[0], null, 2)}`);
        }

        console.log('\n📦 Existing Quote Items:');
        const existingItems = await makeRequest('GET', '/api/quote_items?limit=1');
        if (existingItems.data && existingItems.data.length > 0) {
            console.log(`Sample record: ${JSON.stringify(existingItems.data[0], null, 2)}`);
        }

        console.log('\n👥 Existing Quote Sessions:');
        const existingSessions = await makeRequest('GET', '/api/quote_sessions?limit=1');
        if (existingSessions.data && existingSessions.data.length > 0) {
            console.log(`Sample record: ${JSON.stringify(existingSessions.data[0], null, 2)}`);
        }

        // Test 5: Test server status
        console.log('\n🧪 TEST 5: Server Status Check');
        const statusResult = await makeRequest('GET', '/status');
        console.log(`Server status: ${statusResult.statusCode === 200 ? '✅ ONLINE' : '❌ ISSUES'}`);

    } catch (error) {
        console.error('\n❌ Diagnostic test failed:', error);
    }
}

// Run diagnostic tests
runDiagnosticTests().catch(console.error);
