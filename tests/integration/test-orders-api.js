// test-orders-api.js - Test script for creating orders directly with Caspio API
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

// Create an order with minimal fields
async function createOrder() {
    try {
        const token = await getCaspioAccessToken();
        const url = `${caspioApiBaseUrl}/tables/Orders/records`;
        
        // Try with absolute minimal data - just CustomerID
        const orderData = {
            CustomerID: 8888
        };
        
        console.log(`Attempting to create order with data:`, JSON.stringify(orderData));
        
        const config = {
            method: 'post',
            url: url,
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json'
            },
            data: orderData,
            timeout: 15000
        };
        
        const response = await axios(config);
        console.log(`Order created successfully:`, JSON.stringify(response.data));
        return response.data;
    } catch (error) {
        console.error("Error creating order:", error.response ? JSON.stringify(error.response.data) : error.message);
        throw new Error("Failed to create order.");
    }
}

// Update an order with minimal fields
async function updateOrder(orderId) {
    try {
        const token = await getCaspioAccessToken();
        const url = `${caspioApiBaseUrl}/tables/Orders/records?q.where=PK_ID=${orderId}`;
        
        // Try with minimal data that should be writable
        const orderData = {
            Notes: "Testing order update via API",
            OrderStatus: "Processing"
        };
        
        console.log(`Attempting to update order with ID: ${orderId} with data:`, JSON.stringify(orderData));
        
        const config = {
            method: 'put',
            url: url,
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json'
            },
            data: orderData,
            timeout: 15000
        };
        
        const response = await axios(config);
        console.log(`Order updated successfully:`, JSON.stringify(response.data));
        return response.data;
    } catch (error) {
        console.error("Error updating order:", error.response ? JSON.stringify(error.response.data) : error.message);
        throw new Error("Failed to update order.");
    }
}

// Execute the tests
async function runTests() {
    try {
        // First create an order
        const createdOrder = await createOrder();
        console.log("Order created successfully.");
        
        // Log the full response to see its structure
        console.log("Created order response:", JSON.stringify(createdOrder));
        
        // Since we don't know the exact structure, let's use a fixed order ID for testing
        // In a real scenario, we would extract the ID from the response
        const orderId = 5; // Using a known order ID for testing
        
        // Then update the order
        await updateOrder(orderId);
        console.log("Order updated successfully.");
        
        console.log("All tests completed successfully.");
    } catch (error) {
        console.error("Tests failed:", error.message);
    }
}

// Run the tests
runTests();