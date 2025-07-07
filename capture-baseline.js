#!/usr/bin/env node

/**
 * Capture Baseline Responses
 * This script captures sample responses from all endpoints
 * to ensure responses remain identical after refactoring
 */

const axios = require('axios');
const fs = require('fs');
const path = require('path');

const BASE_URL = process.env.TEST_URL || 'http://localhost:3002';

// Sample endpoints to capture (GET endpoints that don't require parameters)
const ENDPOINTS_TO_CAPTURE = [
    '/api/health',
    '/api/pricing-tiers',
    '/api/embroidery-costs',
    '/api/dtg-costs',
    '/api/screenprint-costs',
    '/api/pricing-rules',
    '/api/base-item-costs',
    '/api/size-upcharges',
    '/api/products/categories',
    '/api/products/base-categories',
    '/api/inventory',
    '/api/customers',
    '/api/artrequests',
    '/api/art-invoices',
    '/api/cart-items',
    '/api/cart-item-sizes',
    '/api/cart-sessions',
    '/api/orders',
    '/api/order-dashboard',
    '/api/order-odbc',
    '/api/pricing-matrix',
    '/api/quote_analytics',
    '/api/quote_items',
    '/api/quote_sessions',
    '/api/production-schedules',
    '/api/transfers',
    '/api/orders-with-tracking'
];

async function captureEndpoint(endpoint) {
    try {
        console.log(`Capturing ${endpoint}...`);
        const response = await axios.get(`${BASE_URL}${endpoint}`, {
            timeout: 30000,
            validateStatus: () => true // Accept any status
        });
        
        return {
            endpoint,
            status: response.status,
            headers: response.headers,
            data: response.data,
            capturedAt: new Date().toISOString()
        };
    } catch (error) {
        console.error(`Failed to capture ${endpoint}:`, error.message);
        return {
            endpoint,
            error: error.message,
            capturedAt: new Date().toISOString()
        };
    }
}

async function captureAllBaselines() {
    console.log('Capturing baseline responses...');
    console.log(`Server: ${BASE_URL}`);
    
    const baselines = {};
    
    for (const endpoint of ENDPOINTS_TO_CAPTURE) {
        const result = await captureEndpoint(endpoint);
        baselines[endpoint] = result;
        
        // Add small delay to avoid overwhelming the server
        await new Promise(resolve => setTimeout(resolve, 500));
    }
    
    // Save baselines
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `baseline-responses-${timestamp}.json`;
    const filepath = path.join(__dirname, 'test-results', filename);
    
    // Create directory if needed
    const dir = path.dirname(filepath);
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
    
    // Save file
    fs.writeFileSync(filepath, JSON.stringify(baselines, null, 2));
    console.log(`\nBaseline responses saved to: ${filename}`);
    
    // Create a symlink to latest baseline
    const latestPath = path.join(dir, 'latest-baseline.json');
    if (fs.existsSync(latestPath)) {
        fs.unlinkSync(latestPath);
    }
    fs.symlinkSync(filename, latestPath);
    
    return baselines;
}

// Check server
async function checkServer() {
    try {
        await axios.get(`${BASE_URL}/api/health`, { timeout: 5000 });
        return true;
    } catch (error) {
        console.error(`Cannot connect to server at ${BASE_URL}`);
        console.log('Please start the server with: node start-test-server.js');
        return false;
    }
}

// Main
(async () => {
    const serverRunning = await checkServer();
    if (!serverRunning) {
        process.exit(1);
    }
    
    await captureAllBaselines();
    console.log('\nBaseline capture complete!');
})();