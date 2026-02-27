#!/usr/bin/env node

// Simple baseline test for critical endpoints
const axios = require('axios');
const fs = require('fs').promises;

const BASE_URL = 'http://localhost:3002';

const CRITICAL_ENDPOINTS = [
    { path: '/api/health', name: 'Health Check' },
    { path: '/api/order-dashboard', name: 'Order Dashboard' },
    { path: '/api/staff-announcements', name: 'Staff Announcements' },
    { path: '/api/pricing-tiers?method=DTG', name: 'Pricing Tiers' },
    { path: '/api/product-details?styleNumber=PC54', name: 'Product Details' },
    { path: '/api/inventory?styleNumber=PC54', name: 'Inventory' }
];

async function testEndpoints() {
    console.log('🧪 Testing Critical Endpoints - Baseline\n');
    
    const results = {
        timestamp: new Date().toISOString(),
        endpoints: {}
    };
    
    for (const endpoint of CRITICAL_ENDPOINTS) {
        process.stdout.write(`Testing ${endpoint.name}...`);
        
        try {
            const start = Date.now();
            const response = await axios.get(`${BASE_URL}${endpoint.path}`, { timeout: 10000 });
            const duration = Date.now() - start;
            
            results.endpoints[endpoint.path] = {
                name: endpoint.name,
                status: response.status,
                passed: response.status === 200,
                duration: duration,
                hasData: !!response.data
            };
            
            console.log(` ✅ [${response.status}] ${duration}ms`);
        } catch (error) {
            results.endpoints[endpoint.path] = {
                name: endpoint.name,
                status: error.response?.status || 0,
                passed: false,
                error: error.message
            };
            
            console.log(` ❌ [${error.response?.status || 'ERROR'}] ${error.message}`);
        }
    }
    
    // Save results
    await fs.mkdir('migration-logs', { recursive: true });
    await fs.writeFile('migration-logs/baseline-simple.json', JSON.stringify(results, null, 2));
    
    console.log('\n✅ Baseline saved to migration-logs/baseline-simple.json');
    
    return results;
}

testEndpoints().catch(console.error);