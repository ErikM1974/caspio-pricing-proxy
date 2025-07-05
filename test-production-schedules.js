// Test script for Production Schedules endpoint
const axios = require('axios');

// Configuration - use local URL for testing
// const BASE_URL = 'https://northwest-pricing-proxy-af0f73fe5d56.herokuapp.com';
const BASE_URL = 'http://localhost:3002'; // Using local testing

async function testProductionSchedules() {
    console.log('Testing Production Schedules API...\n');

    try {
        // Test 1: Basic request without parameters
        console.log('Test 1: Basic request (no parameters)');
        const response1 = await axios.get(`${BASE_URL}/api/production-schedules`);
        console.log(`✓ Status: ${response1.status}`);
        console.log(`✓ Records returned: ${response1.data.length}`);
        if (response1.data.length > 0) {
            console.log('✓ Sample record:', JSON.stringify(response1.data[0], null, 2));
        }
        console.log('');

        // Test 2: With limit parameter
        console.log('Test 2: With limit parameter (q.limit=5)');
        const response2 = await axios.get(`${BASE_URL}/api/production-schedules?q.limit=5`);
        console.log(`✓ Status: ${response2.status}`);
        console.log(`✓ Records returned: ${response2.data.length}`);
        console.log('');

        // Test 3: With orderBy parameter
        console.log('Test 3: With orderBy parameter (q.orderBy=Date DESC)');
        const response3 = await axios.get(`${BASE_URL}/api/production-schedules?q.orderBy=Date DESC&q.limit=3`);
        console.log(`✓ Status: ${response3.status}`);
        console.log(`✓ Records returned: ${response3.data.length}`);
        if (response3.data.length > 0) {
            console.log('✓ First record date:', response3.data[0].Date);
        }
        console.log('');

        // Test 4: With where clause
        console.log('Test 4: With where clause (Employee=\'ruth\')');
        const response4 = await axios.get(`${BASE_URL}/api/production-schedules?q.where=Employee='ruth'&q.limit=3`);
        console.log(`✓ Status: ${response4.status}`);
        console.log(`✓ Records returned: ${response4.data.length}`);
        if (response4.data.length > 0) {
            console.log('✓ Employee in first record:', response4.data[0].Employee);
        }
        console.log('');

        // Test 5: Combined parameters
        console.log('Test 5: Combined parameters (where + orderBy + limit)');
        const response5 = await axios.get(`${BASE_URL}/api/production-schedules?q.where=Date>'2021-08-20'&q.orderBy=Date ASC&q.limit=3`);
        console.log(`✓ Status: ${response5.status}`);
        console.log(`✓ Records returned: ${response5.data.length}`);
        console.log('');

        // Test 6: Error case - invalid limit
        console.log('Test 6: Error handling - invalid limit');
        try {
            await axios.get(`${BASE_URL}/api/production-schedules?q.limit=2000`);
        } catch (error) {
            console.log(`✓ Expected error: ${error.response.status} - ${error.response.data.error}`);
        }
        console.log('');

        // Test 7: Error case - negative limit
        console.log('Test 7: Error handling - negative limit');
        try {
            await axios.get(`${BASE_URL}/api/production-schedules?q.limit=-5`);
        } catch (error) {
            console.log(`✓ Expected error: ${error.response.status} - ${error.response.data.error}`);
        }

        console.log('\n✅ All tests completed successfully!');

    } catch (error) {
        console.error('❌ Test failed:', error.response ? error.response.data : error.message);
    }
}

// Run the tests
testProductionSchedules();