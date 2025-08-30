#!/usr/bin/env node

/**
 * Update Endpoint Status Script
 * 
 * Automatically updates endpoint descriptions with deployment status,
 * performance metrics, and testing information. This script can be run
 * after successful Heroku deployment to mark endpoints as production-ready.
 * 
 * Usage:
 *   node update-endpoint-status.js --endpoint="dtg/product-bundle" --status="DEPLOYED & TESTED"
 *   node update-endpoint-status.js --path="api/products/search" --performance="1-2s response"
 *   node update-endpoint-status.js --name="Enhanced Product Search" --deployed
 */

const colors = require('colors');
require('dotenv').config();
const PostmanAPIClient = require('./postman-api-client');

// Parse command line arguments
function parseArgs() {
    const args = {};
    process.argv.slice(2).forEach(arg => {
        if (arg.startsWith('--')) {
            const [key, value] = arg.substring(2).split('=');
            args[key] = value || true;
        }
    });
    return args;
}

function printUsage() {
    console.log('\n🚀 Update Endpoint Status - NWCA Caspio Proxy'.cyan.bold);
    console.log('\nMark endpoints as deployed and tested with production status updates');
    console.log('\nUsage:');
    console.log('  node update-endpoint-status.js --endpoint=<identifier> [options]');
    console.log('  node update-endpoint-status.js --name=<endpoint-name> [options]');
    console.log('  node update-endpoint-status.js --path=<url-path> [options]');
    console.log('\nOptions:');
    console.log('  --endpoint=<path>         Endpoint path (e.g., "dtg/product-bundle")');
    console.log('  --name=<name>            Exact endpoint name in collection');
    console.log('  --path=<path>            URL path pattern matching');
    console.log('  --status=<text>          Deployment status (default: "DEPLOYED & TESTED")');
    console.log('  --performance=<text>     Performance info (e.g., "1-2s response, 5min cache")');
    console.log('  --notes=<text>           Additional deployment notes');
    console.log('  --date=<YYYY-MM-DD>      Deployment date (default: today)');
    console.log('  --deployed               Quick flag for standard deployment marking');
    console.log('  --test                   Test connection only');
    console.log('  --list                   List all endpoints');
    console.log('\nExamples:');
    console.log('  # Mark DTG endpoint as deployed');
    console.log('  node update-endpoint-status.js --endpoint="dtg/product-bundle" --deployed');
    console.log('');
    console.log('  # Update with performance details');
    console.log('  node update-endpoint-status.js --name="Enhanced Product Search" \\');
    console.log('    --performance="1-2s response, cached" --notes="Handles 250K+ records"');
    console.log('');
    console.log('  # Update by path matching');
    console.log('  node update-endpoint-status.js --path="api/products/search" --deployed');
    console.log('\nEnvironment variables required:');
    console.log('  POSTMAN_API_KEY        Your Postman API key');
    console.log('  POSTMAN_COLLECTION_ID  Collection ID');
}

async function main() {
    const args = parseArgs();

    // Show help if no arguments
    if (Object.keys(args).length === 0 || args.help) {
        printUsage();
        return;
    }

    // Check environment variables
    const apiKey = process.env.POSTMAN_API_KEY;
    const collectionId = process.env.POSTMAN_COLLECTION_ID;

    if (!apiKey || !collectionId || apiKey === 'your-postman-api-key-here') {
        console.error('❌ Postman API credentials not configured'.red);
        console.log('\n💡 Setup instructions:'.yellow);
        console.log('1. Get API key from https://postman.co/settings/me/api-keys');
        console.log('2. Set POSTMAN_API_KEY in your .env file');
        console.log('3. Collection ID is already set in .env.example');
        process.exit(1);
    }

    try {
        const client = new PostmanAPIClient(apiKey, collectionId);

        // Handle different commands
        if (args.test) {
            console.log('🧪 Testing Postman API connection...'.yellow);
            await client.testConnection();
            return;
        }

        if (args.list) {
            console.log('📋 Fetching endpoint list...'.yellow);
            const endpoints = await client.listEndpoints();
            
            console.log('\n📋 Collection Endpoints:'.cyan.bold);
            endpoints.forEach((ep, index) => {
                const hasDeployedStatus = ep.description.includes('✅ DEPLOYED') || ep.description.includes('✅ TESTED');
                const statusIcon = hasDeployedStatus ? '✅' : '⏳';
                console.log(`${(index + 1).toString().padStart(2, ' ')}.`.gray + ` ${statusIcon} ${ep.name.white}`);
                console.log(`     ${ep.category.gray} → ${ep.method.cyan} /${ep.path.gray}`);
                if (ep.description) {
                    const shortDesc = ep.description.substring(0, 80) + (ep.description.length > 80 ? '...' : '');
                    console.log(`     ${shortDesc.dim}`);
                }
                console.log('');
            });
            
            const deployedCount = endpoints.filter(ep => 
                ep.description.includes('✅ DEPLOYED') || ep.description.includes('✅ TESTED')
            ).length;
            
            console.log(`📊 Status Summary:`.cyan.bold);
            console.log(`   Total endpoints: ${endpoints.length}`);
            console.log(`   Deployed: ${deployedCount} ✅`);
            console.log(`   Pending: ${endpoints.length - deployedCount} ⏳`);
            return;
        }

        // Determine endpoint identifier
        const identifier = args.endpoint || args.name || args.path;
        if (!identifier) {
            console.error('❌ Must specify --endpoint, --name, or --path'.red);
            console.log('Use --help for usage information');
            process.exit(1);
        }

        // Prepare deployment info
        const deploymentInfo = {};
        
        if (args.status) {
            deploymentInfo.status = args.status;
        } else if (args.deployed) {
            deploymentInfo.status = 'DEPLOYED & TESTED';
        }

        if (args.performance) {
            deploymentInfo.performance = args.performance;
        }

        if (args.notes) {
            deploymentInfo.notes = args.notes;
        }

        if (args.date) {
            deploymentInfo.date = args.date;
        }

        console.log(`\n🎯 Updating deployment status for: ${identifier.cyan}`);
        if (deploymentInfo.status) {
            console.log(`📍 Status: ${deploymentInfo.status.green}`);
        }
        if (deploymentInfo.performance) {
            console.log(`⚡ Performance: ${deploymentInfo.performance.yellow}`);
        }
        if (deploymentInfo.notes) {
            console.log(`📝 Notes: ${deploymentInfo.notes.gray}`);
        }

        // Update the endpoint
        const updated = await client.markEndpointAsDeployed(identifier, deploymentInfo);
        
        if (updated) {
            console.log('\n🎉 Successfully updated endpoint status!'.green.bold);
            console.log('💫 Changes are now live in your Postman workspace'.cyan);
        } else {
            console.log('\n⚠️  Endpoint was already marked as deployed'.yellow);
            console.log('Use --list to see current status of all endpoints'.gray);
        }

    } catch (error) {
        console.error('\n❌ Operation failed:'.red.bold, error.message);
        
        if (error.message.includes('not found')) {
            console.log('\n💡 Try using --list to see available endpoints'.yellow);
            console.log('You can match by:');
            console.log('  • Endpoint name: --name="Enhanced Product Search"');
            console.log('  • URL path: --path="api/products/search" or --endpoint="products/search"');
        }
        
        process.exit(1);
    }
}

// Handle uncaught errors gracefully
process.on('uncaughtException', (error) => {
    console.error('\n💥 Unexpected error:'.red.bold, error.message);
    process.exit(1);
});

process.on('unhandledRejection', (error) => {
    console.error('\n💥 Unhandled promise rejection:'.red.bold, error.message);
    process.exit(1);
});

main();