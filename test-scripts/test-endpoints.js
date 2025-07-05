#!/usr/bin/env node

// Test Endpoints - Quick endpoint testing with automatic port detection
const axios = require('axios');
const os = require('os');

// Try different ports to find the server
const POSSIBLE_PORTS = [3002, 3000, process.env.PORT].filter(Boolean);

// Get WSL IP
function getWSLIP() {
    const interfaces = os.networkInterfaces();
    for (const name of Object.keys(interfaces)) {
        for (const iface of interfaces[name]) {
            if (iface.family === 'IPv4' && !iface.internal && iface.address.startsWith('172.')) {
                return iface.address;
            }
        }
    }
    return '127.0.0.1';
}

async function findRunningServer() {
    console.log('🔍 Looking for running server...\n');
    
    for (const port of POSSIBLE_PORTS) {
        try {
            const response = await axios.get(`http://localhost:${port}/api/health`, { timeout: 1000 });
            if (response.data.status === 'healthy') {
                console.log(`✅ Found server running on port ${port}!`);
                return { port, health: response.data };
            }
        } catch (error) {
            // Server not running on this port
        }
    }
    
    return null;
}

async function testEndpoint(name, url, expectedField) {
    process.stdout.write(`Testing ${name}... `);
    try {
        const response = await axios.get(url, { timeout: 5000 });
        if (response.data && (expectedField ? response.data[expectedField] : true)) {
            console.log('✅ OK');
            return true;
        } else {
            console.log('⚠️  Unexpected response format');
            return false;
        }
    } catch (error) {
        console.log(`❌ Failed: ${error.message}`);
        return false;
    }
}

async function main() {
    console.log('=' .repeat(60));
    console.log('🧪 CASPIO PROXY ENDPOINT TESTER');
    console.log('=' .repeat(60));
    console.log();
    
    // Find running server
    const serverInfo = await findRunningServer();
    
    if (!serverInfo) {
        console.log('❌ No server found running on ports:', POSSIBLE_PORTS.join(', '));
        console.log('\n💡 Start the server with: node start-test-server.js');
        process.exit(1);
    }
    
    const { port, health } = serverInfo;
    const wslIP = health.server.wslIP || getWSLIP();
    
    console.log(`\n📊 Server Info:`);
    console.log(`   Port: ${port} ${port !== 3002 ? '(⚠️  Expected 3002)' : ''}`);
    console.log(`   WSL IP: ${wslIP}`);
    console.log(`   Uptime: ${Math.floor(health.server.uptime / 60)} minutes`);
    console.log(`   Caspio Domain: ${health.caspio.domain}`);
    console.log(`   Token Cached: ${health.caspio.tokenCached ? '✅ Yes' : '❌ No'}`);
    
    console.log(`\n🧪 Running Endpoint Tests:\n`);
    
    const baseUrl = `http://localhost:${port}`;
    const tests = [
        { name: 'Health Check', url: `${baseUrl}/api/health`, field: 'status' },
        { name: 'Order Dashboard (7 days)', url: `${baseUrl}/api/order-dashboard`, field: 'summary' },
        { name: 'Order Dashboard (YoY)', url: `${baseUrl}/api/order-dashboard?compareYoY=true`, field: 'yearOverYear' },
        { name: 'Product Search', url: `${baseUrl}/api/products/search?q=shirt&limit=5`, field: null },
        { name: 'Pricing Tiers (DTG)', url: `${baseUrl}/api/pricing-tiers?method=DTG`, field: null },
        { name: 'Categories', url: `${baseUrl}/api/categories`, field: null },
    ];
    
    let passed = 0;
    for (const test of tests) {
        if (await testEndpoint(test.name, test.url, test.field)) {
            passed++;
        }
    }
    
    console.log(`\n📋 Test Results: ${passed}/${tests.length} passed`);
    
    if (passed === tests.length) {
        console.log('🎉 All tests passed! Server is working correctly.\n');
    } else {
        console.log('⚠️  Some tests failed. Check server logs for details.\n');
    }
    
    // Display ready-to-use URLs
    console.log('=' .repeat(60));
    console.log('📋 POSTMAN-READY URLS:');
    console.log('=' .repeat(60));
    console.log('\nCopy these URLs to test in Postman:\n');
    
    const endpoints = [
        { category: '🏥 Health & Status', urls: [
            `http://${wslIP}:${port}/api/health`,
            `http://${wslIP}:${port}/status`
        ]},
        { category: '📊 Order Dashboard', urls: [
            `http://${wslIP}:${port}/api/order-dashboard`,
            `http://${wslIP}:${port}/api/order-dashboard?days=30`,
            `http://${wslIP}:${port}/api/order-dashboard?days=7&includeDetails=true`,
            `http://${wslIP}:${port}/api/order-dashboard?compareYoY=true`
        ]},
        { category: '📦 Orders (ODBC)', urls: [
            `http://${wslIP}:${port}/api/order-odbc?q.limit=10`,
            `http://${wslIP}:${port}/api/order-odbc?q.where=date_OrderInvoiced>='2025-07-01'&q.limit=50`
        ]},
        { category: '🛍️ Products', urls: [
            `http://${wslIP}:${port}/api/products/search?q=shirt`,
            `http://${wslIP}:${port}/api/products/PC54`,
            `http://${wslIP}:${port}/api/categories`,
            `http://${wslIP}:${port}/api/brands`
        ]},
        { category: '💰 Pricing', urls: [
            `http://${wslIP}:${port}/api/pricing-tiers?method=DTG`,
            `http://${wslIP}:${port}/api/pricing-rules?method=DTG`
        ]}
    ];
    
    endpoints.forEach(({ category, urls }) => {
        console.log(`\n${category}:`);
        urls.forEach(url => console.log(`  ${url}`));
    });
    
    console.log('\n' + '=' .repeat(60));
}

main().catch(console.error);