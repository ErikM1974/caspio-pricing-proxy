#!/usr/bin/env node

/**
 * Postman API Client for NWCA Caspio Proxy
 * 
 * Provides automated integration with Postman API to update collections
 * without manual JSON editing. Supports updating endpoint descriptions,
 * collection metadata, and syncing deployment status.
 */

const axios = require('axios');
const colors = require('colors');

class PostmanAPIClient {
    constructor(apiKey, collectionId) {
        if (!apiKey || !collectionId) {
            throw new Error('POSTMAN_API_KEY and POSTMAN_COLLECTION_ID are required');
        }
        
        this.apiKey = apiKey;
        this.collectionId = collectionId;
        this.baseURL = 'https://api.getpostman.com';
        
        this.client = axios.create({
            baseURL: this.baseURL,
            headers: {
                'X-API-Key': apiKey,
                'Content-Type': 'application/json'
            },
            timeout: 30000
        });
    }

    /**
     * Get the current collection from Postman
     */
    async getCollection() {
        try {
            console.log('📥 Fetching collection from Postman API...'.yellow);
            const response = await this.client.get(`/collections/${this.collectionId}`);
            console.log('✅ Successfully retrieved collection'.green);
            return response.data.collection;
        } catch (error) {
            console.error('❌ Failed to get collection:'.red, error.response?.data || error.message);
            throw error;
        }
    }

    /**
     * Update the entire collection
     */
    async updateCollection(collection) {
        try {
            console.log('📤 Updating collection in Postman...'.yellow);
            const response = await this.client.put(`/collections/${this.collectionId}`, {
                collection: collection
            });
            console.log('✅ Successfully updated collection in Postman'.green);
            return response.data;
        } catch (error) {
            console.error('❌ Failed to update collection:'.red, error.response?.data || error.message);
            throw error;
        }
    }

    /**
     * Find an endpoint by name in the collection
     */
    findEndpoint(collection, endpointName) {
        for (const category of collection.item) {
            if (category.item && Array.isArray(category.item)) {
                for (const endpoint of category.item) {
                    if (endpoint.name === endpointName) {
                        return { endpoint, category };
                    }
                }
            }
        }
        return null;
    }

    /**
     * Find an endpoint by URL path pattern
     */
    findEndpointByPath(collection, pathPattern) {
        const pathParts = pathPattern.split('/').filter(p => p);
        
        for (const category of collection.item) {
            if (category.item && Array.isArray(category.item)) {
                for (const endpoint of category.item) {
                    if (endpoint.request && endpoint.request.url && endpoint.request.url.path) {
                        const endpointPath = endpoint.request.url.path.join('/');
                        if (endpointPath.includes(pathParts.join('/'))) {
                            return { endpoint, category };
                        }
                    }
                }
            }
        }
        return null;
    }

    /**
     * Update an endpoint's description
     */
    async updateEndpointDescription(endpointName, newDescription) {
        try {
            const collection = await this.getCollection();
            const result = this.findEndpoint(collection, endpointName);
            
            if (!result) {
                throw new Error(`Endpoint "${endpointName}" not found in collection`);
            }

            console.log(`📝 Updating description for "${endpointName}"...`.yellow);
            result.endpoint.request.description = newDescription;
            
            await this.updateCollection(collection);
            console.log(`✅ Updated "${endpointName}" description`.green);
            return true;
        } catch (error) {
            console.error(`❌ Failed to update endpoint description:`.red, error.message);
            throw error;
        }
    }

    /**
     * Update endpoint description by URL path
     */
    async updateEndpointDescriptionByPath(pathPattern, newDescription) {
        try {
            const collection = await this.getCollection();
            const result = this.findEndpointByPath(collection, pathPattern);
            
            if (!result) {
                throw new Error(`Endpoint with path "${pathPattern}" not found in collection`);
            }

            const endpointName = result.endpoint.name;
            console.log(`📝 Updating description for "${endpointName}" (${pathPattern})...`.yellow);
            result.endpoint.request.description = newDescription;
            
            await this.updateCollection(collection);
            console.log(`✅ Updated "${endpointName}" description via path matching`.green);
            return true;
        } catch (error) {
            console.error(`❌ Failed to update endpoint description by path:`.red, error.message);
            throw error;
        }
    }

    /**
     * Update collection metadata (name, description)
     */
    async updateCollectionMetadata(name, description) {
        try {
            const collection = await this.getCollection();
            
            console.log('📝 Updating collection metadata...'.yellow);
            if (name) collection.info.name = name;
            if (description) collection.info.description = description;
            
            await this.updateCollection(collection);
            console.log('✅ Updated collection metadata'.green);
            return true;
        } catch (error) {
            console.error('❌ Failed to update collection metadata:'.red, error.message);
            throw error;
        }
    }

    /**
     * Add deployment status to an endpoint description
     */
    async markEndpointAsDeployed(endpointIdentifier, deploymentInfo = {}) {
        const {
            date = new Date().toISOString().split('T')[0],
            status = 'DEPLOYED & TESTED',
            performance = '',
            notes = ''
        } = deploymentInfo;

        try {
            const collection = await this.getCollection();
            let result;

            // Try to find by name first, then by path
            result = this.findEndpoint(collection, endpointIdentifier);
            if (!result) {
                result = this.findEndpointByPath(collection, endpointIdentifier);
            }

            if (!result) {
                throw new Error(`Endpoint "${endpointIdentifier}" not found in collection`);
            }

            const currentDesc = result.endpoint.request.description || '';
            
            // Check if already marked as deployed
            if (currentDesc.includes('✅ DEPLOYED')) {
                console.log(`⚠️  Endpoint "${result.endpoint.name}" already marked as deployed`.yellow);
                return false;
            }

            // Add deployment status to description
            let newDesc = currentDesc;
            
            // Add deployment marker at the beginning if description exists
            if (currentDesc) {
                const statusText = `✅ ${status} (${date})${performance ? '. ' + performance : ''}${notes ? '. ' + notes : ''}. `;
                
                // Insert after emoji and before first sentence
                if (currentDesc.startsWith('🚀')) {
                    newDesc = currentDesc.replace('🚀 OPTIMIZED:', `🚀 OPTIMIZED & TESTED: `);
                    if (!newDesc.includes('✅')) {
                        newDesc = newDesc.replace(': ', `: ${statusText}`);
                    }
                } else {
                    newDesc = statusText + currentDesc;
                }
            } else {
                newDesc = `✅ ${status} (${date})${performance ? '. ' + performance : ''}`;
            }

            console.log(`📝 Marking "${result.endpoint.name}" as deployed...`.yellow);
            result.endpoint.request.description = newDesc;
            
            await this.updateCollection(collection);
            console.log(`✅ Marked "${result.endpoint.name}" as ${status}`.green);
            return true;
        } catch (error) {
            console.error('❌ Failed to mark endpoint as deployed:'.red, error.message);
            throw error;
        }
    }

    /**
     * List all endpoints in the collection
     */
    async listEndpoints() {
        try {
            const collection = await this.getCollection();
            const endpoints = [];

            for (const category of collection.item) {
                if (category.item && Array.isArray(category.item)) {
                    for (const endpoint of category.item) {
                        endpoints.push({
                            category: category.name,
                            name: endpoint.name,
                            method: endpoint.request?.method || 'GET',
                            path: endpoint.request?.url?.path?.join('/') || 'unknown',
                            description: endpoint.request?.description || ''
                        });
                    }
                }
            }

            return endpoints;
        } catch (error) {
            console.error('❌ Failed to list endpoints:'.red, error.message);
            throw error;
        }
    }

    /**
     * Test the API connection
     */
    async testConnection() {
        try {
            console.log('🔍 Testing Postman API connection...'.yellow);
            const response = await this.client.get('/me');
            console.log(`✅ Connected successfully! User: ${response.data.user.username}`.green);
            return true;
        } catch (error) {
            console.error('❌ Failed to connect to Postman API:'.red, error.response?.data || error.message);
            return false;
        }
    }
}

module.exports = PostmanAPIClient;

// CLI usage
if (require.main === module) {
    require('dotenv').config();
    const PostmanAPIClient = require('./postman-api-client');
    
    async function main() {
        const apiKey = process.env.POSTMAN_API_KEY;
        const collectionId = process.env.POSTMAN_COLLECTION_ID;

        if (!apiKey || !collectionId) {
            console.error('❌ Missing required environment variables:'.red);
            console.log('POSTMAN_API_KEY and POSTMAN_COLLECTION_ID must be set in .env');
            process.exit(1);
        }

        try {
            const client = new PostmanAPIClient(apiKey, collectionId);
            
            const command = process.argv[2];
            
            switch (command) {
                case 'test':
                    await client.testConnection();
                    break;
                    
                case 'list':
                    const endpoints = await client.listEndpoints();
                    console.log('\n📋 Collection Endpoints:'.cyan.bold);
                    endpoints.forEach(ep => {
                        console.log(`${ep.category.gray} → ${ep.method.cyan} ${ep.name.white} (${ep.path.gray})`);
                    });
                    console.log(`\n📊 Total: ${endpoints.length} endpoints`.green);
                    break;
                    
                case 'deploy':
                    const endpoint = process.argv[3];
                    if (!endpoint) {
                        console.error('❌ Usage: node postman-api-client.js deploy <endpoint-name-or-path>'.red);
                        process.exit(1);
                    }
                    await client.markEndpointAsDeployed(endpoint);
                    break;
                    
                default:
                    console.log('\n🚀 Postman API Client for NWCA'.cyan.bold);
                    console.log('\nUsage:');
                    console.log('  node postman-api-client.js test         Test API connection');
                    console.log('  node postman-api-client.js list         List all endpoints');
                    console.log('  node postman-api-client.js deploy <id>  Mark endpoint as deployed');
                    console.log('\nEnvironment variables required:');
                    console.log('  POSTMAN_API_KEY        Your Postman API key');
                    console.log('  POSTMAN_COLLECTION_ID  Collection ID (6ece08ff-b668-4081-a062-cb02a2931869)');
            }
        } catch (error) {
            console.error('❌ Operation failed:'.red, error.message);
            process.exit(1);
        }
    }

    main();
}