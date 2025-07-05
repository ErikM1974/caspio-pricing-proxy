#!/usr/bin/env node

// Start Test Server - A reliable way to start the server for local testing
const { spawn } = require('child_process');
const axios = require('axios');
const os = require('os');

// Force the correct port
process.env.PORT = '3002';

console.log('🚀 Starting Caspio Proxy Test Server...\n');

// Get WSL IP address
function getWSLIP() {
    const interfaces = os.networkInterfaces();
    for (const name of Object.keys(interfaces)) {
        for (const iface of interfaces[name]) {
            // Look for IPv4 addresses that aren't localhost
            if (iface.family === 'IPv4' && !iface.internal && iface.address.startsWith('172.')) {
                return iface.address;
            }
        }
    }
    return '127.0.0.1';
}

const wslIP = getWSLIP();
const PORT = 3002;

// Start the server
const server = spawn('node', ['server.js'], {
    env: { ...process.env, PORT: PORT.toString() },
    stdio: 'pipe'
});

let serverReady = false;

// Monitor server output
server.stdout.on('data', (data) => {
    const output = data.toString();
    process.stdout.write(output);
    
    // Check if server is ready
    if (output.includes('listening on port') && !serverReady) {
        serverReady = true;
        console.log('\n✅ Server is ready!\n');
        displayTestInfo();
    }
});

server.stderr.on('data', (data) => {
    console.error(`❌ Server Error: ${data}`);
});

server.on('close', (code) => {
    console.log(`\n🛑 Server stopped with code ${code}`);
    process.exit(code);
});

// Handle Ctrl+C gracefully
process.on('SIGINT', () => {
    console.log('\n\n👋 Shutting down server...');
    server.kill('SIGTERM');
    setTimeout(() => {
        process.exit(0);
    }, 1000);
});

function displayTestInfo() {
    console.log('=' .repeat(60));
    console.log('📋 QUICK TEST URLS - Copy these to Postman:');
    console.log('=' .repeat(60));
    console.log();
    console.log(`WSL IP Address: ${wslIP}`);
    console.log(`Server Port: ${PORT}`);
    console.log();
    console.log('🏥 Health Check:');
    console.log(`http://${wslIP}:${PORT}/api/health`);
    console.log();
    console.log('📊 Dashboard Endpoints:');
    console.log(`http://${wslIP}:${PORT}/api/order-dashboard`);
    console.log(`http://${wslIP}:${PORT}/api/order-dashboard?days=30`);
    console.log(`http://${wslIP}:${PORT}/api/order-dashboard?compareYoY=true`);
    console.log();
    console.log('🛍️ Product Search:');
    console.log(`http://${wslIP}:${PORT}/api/products/search?q=shirt`);
    console.log(`http://${wslIP}:${PORT}/api/products/PC54`);
    console.log();
    console.log('📦 Order Data:');
    console.log(`http://${wslIP}:${PORT}/api/order-odbc?q.limit=10`);
    console.log();
    console.log('=' .repeat(60));
    console.log('✨ Server is running! Press Ctrl+C to stop.');
    console.log('=' .repeat(60));
    
    // Test the health endpoint after a short delay
    setTimeout(async () => {
        try {
            const response = await axios.get(`http://localhost:${PORT}/api/health`);
            console.log('\n✅ Health check passed:', response.data.message);
        } catch (error) {
            console.log('\n⚠️  Health check endpoint not available yet');
        }
    }, 1000);
}

// If server doesn't start within 10 seconds, show troubleshooting
setTimeout(() => {
    if (!serverReady) {
        console.log('\n⚠️  Server is taking longer than expected to start.');
        console.log('Common issues:');
        console.log('1. Check if port 3002 is already in use: lsof -i :3002');
        console.log('2. Check for missing dependencies: npm install');
        console.log('3. Check for syntax errors in server.js');
    }
}, 10000);