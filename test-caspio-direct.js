// test-caspio-direct.js - Test script for directly accessing Caspio API
require('dotenv').config();
const axios = require('axios');

// Caspio configuration
const caspioDomain = process.env.CASPIO_ACCOUNT_DOMAIN;
const clientId = process.env.CASPIO_CLIENT_ID;
const clientSecret = process.env.CASPIO_CLIENT_SECRET;

const caspioTokenUrl = `https://${caspioDomain}/oauth/token`;
const caspioApiBaseUrl = `https://${caspioDomain}/rest/v2`;

// Get Caspio access token
async function getCaspioAccessToken() {
    try {
        console.log("Requesting Caspio access token...");
        const response = await axios.post(caspioTokenUrl, new URLSearchParams({
            'grant_type': 'client_credentials',
            'client_id': clientId,
            'client_secret': clientSecret
        }), {
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            timeout: 10000
        });

        if (response.data && response.data.access_token) {
            console.log("Token obtained successfully.");
            return response.data.access_token;
        } else {
            throw new Error("Invalid response structure from token endpoint.");
        }
    } catch (error) {
        console.error("Error getting token:", error.response ? JSON.stringify(error.response.data) : error.message);
        throw new Error("Could not obtain Caspio access token.");
    }
}

// Create a PricingMatrix record directly with Caspio API
async function createPricingMatrix() {
    try {
        const token = await getCaspioAccessToken();
        const url = `${caspioApiBaseUrl}/tables/PricingMatrix/records`;
        
        // Create test data
        const pricingMatrixData = {
            SessionID: "direct-test-" + Date.now(),
            StyleNumber: "PC61",
            Color: "RED",
            EmbellishmentType: "DTG",
            TierStructure: "DIRECT TEST TIER",
            SizeGroups: "DIRECT TEST SIZE",
            PriceMatrix: "DIRECT TEST PRICE"
        };
        
        console.log(`Attempting to create pricing matrix directly with data:`, JSON.stringify(pricingMatrixData));
        
        const config = {
            method: 'post',
            url: url,
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json'
            },
            data: pricingMatrixData,
            timeout: 15000
        };
        
        const response = await axios(config);
        console.log(`Pricing matrix created successfully:`, JSON.stringify(response.data));
        return response.data;
    } catch (error) {
        console.error("Error creating pricing matrix:", error.response ? JSON.stringify(error.response.data) : error.message);
        throw new Error("Failed to create pricing matrix.");
    }
}

// Get all PricingMatrix records directly with Caspio API
async function getAllPricingMatrix() {
    try {
        const token = await getCaspioAccessToken();
        const url = `${caspioApiBaseUrl}/tables/PricingMatrix/records`;
        
        console.log(`Fetching all pricing matrix records directly from Caspio API`);
        
        const config = {
            method: 'get',
            url: url,
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json'
            },
            timeout: 15000
        };
        
        const response = await axios(config);
        console.log(`Found ${response.data.Result.length} pricing matrix records`);
        console.log(`Records:`, JSON.stringify(response.data.Result));
        return response.data.Result;
    } catch (error) {
        console.error("Error fetching pricing matrix records:", error.response ? JSON.stringify(error.response.data) : error.message);
        throw new Error("Failed to fetch pricing matrix records.");
    }
}

// Execute the tests
async function runTests() {
    try {
        // First get all existing records
        console.log("Fetching existing records...");
        const existingRecords = await getAllPricingMatrix();
        
        // Then create a new record
        console.log("\nCreating new record...");
        const createdRecord = await createPricingMatrix();
        
        // Then get all records again to verify the new record was created
        console.log("\nFetching records after creation...");
        const updatedRecords = await getAllPricingMatrix();
        
        // Verify that a new record was created
        if (updatedRecords.length > existingRecords.length) {
            console.log("\nSUCCESS: New record was created successfully!");
        } else {
            console.log("\nWARNING: No new record was found after creation attempt.");
        }
        
        console.log("\nAll tests completed.");
    } catch (error) {
        console.error("Tests failed:", error.message);
    }
}

// Run the tests
runTests();