#!/usr/bin/env node

// Enhanced Server Starter - Reliable local server startup with diagnostics
const { spawn } = require('child_process');
const axios = require('axios');
const os = require('os');
const fs = require('fs');
const path = require('path');

// Terminal colors
const colors = {
    reset: '\x1b[0m',
    bright: '\x1b[1m',
    green: '\x1b[32m',
    red: '\x1b[31m',
    yellow: '\x1b[33m',
    blue: '\x1b[34m',
    cyan: '\x1b[36m'
};

// Force the correct port from config
process.env.PORT = '3002';

console.log(`${colors.cyan}${colors.bright}\n🚀 CASPIO PROXY SERVER LAUNCHER${colors.reset}`);
console.log('='.repeat(60) + '\n');

// Check if .env file exists
const envPath = path.join(__dirname, '.env');
if (!fs.existsSync(envPath)) {
    console.error(`${colors.red}❌ ERROR: .env file not found!${colors.reset}`);
    console.log('\nPlease create a .env file with the following variables:');
    console.log('  CASPIO_ACCOUNT_DOMAIN=your-domain.caspio.com');
    console.log('  CASPIO_CLIENT_ID=your-client-id');
    console.log('  CASPIO_CLIENT_SECRET=your-client-secret');
    console.log('  PORT=3002\n');
    process.exit(1);
}

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
    // Fallback to localhost
    return '127.0.0.1';
}

// Check if port is already in use
function checkPort(port) {
    return new Promise((resolve) => {
        const net = require('net');
        const server = net.createServer();
        
        server.once('error', (err) => {
            if (err.code === 'EADDRINUSE') {
                resolve(false);
            } else {
                resolve(true);
            }
        });
        
        server.once('listening', () => {
            server.close();
            resolve(true);
        });
        
        server.listen(port);
    });
}

// Main startup function
async function startServer() {
    const PORT = 3002;
    const wslIP = getWSLIP();
    
    // Check if port is available
    console.log(`${colors.yellow}🔍 Checking port ${PORT} availability...${colors.reset}`);
    const portAvailable = await checkPort(PORT);
    
    if (!portAvailable) {
        console.error(`${colors.red}❌ Port ${PORT} is already in use!${colors.reset}`);
        console.log('\nOptions:');
        console.log('1. Stop the existing server: killall node');
        console.log('2. Find what\'s using the port: lsof -i :3002');
        console.log('3. Use a different port in .env file\n');
        process.exit(1);
    }
    
    console.log(`${colors.green}✅ Port ${PORT} is available${colors.reset}\n`);
    
    // Start the server
    console.log(`${colors.yellow}🏗️  Starting server...${colors.reset}\n`);
    
    const server = spawn('node', ['server.js'], {
        env: { ...process.env, PORT: PORT.toString() },
        stdio: 'pipe'
    });
    
    let serverReady = false;
    let startupTimeout;
    
    // Set a timeout for server startup
    startupTimeout = setTimeout(() => {
        if (!serverReady) {
            console.error(`\n${colors.red}❌ Server failed to start within 30 seconds${colors.reset}`);
            server.kill('SIGTERM');
            process.exit(1);
        }
    }, 30000);
    
    // Monitor server output
    server.stdout.on('data', (data) => {
        const output = data.toString();
        process.stdout.write(output);
        
        // Check if server is ready
        if ((output.includes('listening on port') || output.includes('Server is ready')) && !serverReady) {
            clearTimeout(startupTimeout);
            serverReady = true;
            setTimeout(() => {
                displaySuccessInfo(PORT, wslIP);
                testHealthEndpoint(PORT);
            }, 1000);
        }
    });
    
    server.stderr.on('data', (data) => {
        console.error(`${colors.red}❌ Server Error: ${data}${colors.reset}`);
    });
    
    server.on('close', (code) => {
        clearTimeout(startupTimeout);
        console.log(`\n${colors.yellow}🛑 Server stopped with code ${code}${colors.reset}`);
        process.exit(code);
    });
    
    // Handle Ctrl+C gracefully
    process.on('SIGINT', () => {
        console.log(`\n\n${colors.yellow}👋 Shutting down server gracefully...${colors.reset}`);
        server.kill('SIGTERM');
        setTimeout(() => {
            process.exit(0);
        }, 1000);
    });
}

// Display success information
function displaySuccessInfo(port, wslIP) {
    console.log('\n' + '='.repeat(60));
    console.log(`${colors.green}${colors.bright}✨ SERVER STARTED SUCCESSFULLY!${colors.reset}`);
    console.log('='.repeat(60));
    console.log(`\n${colors.cyan}📋 CONNECTION INFORMATION:${colors.reset}`);
    console.log(`   Local URL: http://localhost:${port}`);
    console.log(`   WSL IP: ${wslIP}`);
    console.log(`   WSL URL: http://${wslIP}:${port}`);
    
    console.log(`\n${colors.cyan}🧪 TEST ENDPOINTS:${colors.reset}`);
    console.log(`   Health Check: http://${wslIP}:${port}/api/health`);
    console.log(`   Order Dashboard: http://${wslIP}:${port}/api/order-dashboard`);
    console.log(`   Product Search: http://${wslIP}:${port}/api/products/search?q=shirt`);
    
    console.log(`\n${colors.cyan}📮 POSTMAN TIPS:${colors.reset}`);
    console.log(`   • Use the WSL IP (${wslIP}) when testing from Windows`);
    console.log(`   • The WSL IP changes when Windows restarts`);
    console.log(`   • All endpoints start with /api/`);
    
    console.log('\n' + '='.repeat(60));
    console.log(`${colors.bright}Press Ctrl+C to stop the server${colors.reset}`);
    console.log('='.repeat(60) + '\n');
}

// Test the health endpoint
async function testHealthEndpoint(port) {
    try {
        const response = await axios.get(`http://localhost:${port}/api/health`, { timeout: 5000 });
        if (response.data.status === 'healthy') {
            console.log(`${colors.green}✅ Health check passed${colors.reset}`);
            console.log(`   Caspio Domain: ${response.data.caspio.domain}`);
            console.log(`   Token Cached: ${response.data.caspio.tokenCached ? 'Yes' : 'No'}\n`);
        }
    } catch (error) {
        console.log(`${colors.yellow}⚠️  Health check endpoint not responding${colors.reset}`);
        console.log(`   This is normal if the server is still initializing\n`);
    }
}

// Run the startup
startServer().catch(error => {
    console.error(`${colors.red}❌ Fatal error:${colors.reset}`, error.message);
    process.exit(1);
});