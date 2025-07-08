// server.js - Caspio API Proxy Server

const express = require('express');
const axios = require('axios');
const config = require('./config'); // Use unified configuration

const app = express();

// Extract configuration values
const PORT = config.server.port;
const caspioDomain = config.caspio.domain;
const clientId = config.caspio.clientId;
const clientSecret = config.caspio.clientSecret;
const caspioTokenUrl = config.caspio.tokenUrl;
const caspioApiBaseUrl = config.caspio.apiBaseUrl; // Using v2 API from config

// --- Simple In-Memory Token Cache ---
let caspioAccessToken = null;
let tokenExpiryTime = 0;

// --- Middleware ---
app.use(express.json()); // Parse JSON bodies (for potential future POST requests)
app.use(express.static('.')); // Serve static files from the current directory

// CORS Middleware - Using config settings
app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', config.cors.origin);
    res.setHeader('Access-Control-Allow-Methods', config.cors.methods.join(', '));
    res.setHeader('Access-Control-Allow-Headers', config.cors.allowedHeaders.join(', '));
    
    if (req.method === 'OPTIONS') {
        return res.sendStatus(200);
    }
    next();
});


// --- Helper Functions ---

/**
 * Gets a valid Caspio Access Token, requesting a new one if needed.
 * Uses simple in-memory cache.
 */
async function getCaspioAccessToken() {
    const now = Math.floor(Date.now() / 1000); // Time in seconds
    const bufferSeconds = config.timeouts.tokenBuffer;

    if (caspioAccessToken && now < (tokenExpiryTime - bufferSeconds)) {
        // console.log("Using cached Caspio token."); // Uncomment for debugging
        return caspioAccessToken;
    }

    console.log("Requesting new Caspio access token...");
    try {
        const response = await axios.post(caspioTokenUrl, new URLSearchParams({
            'grant_type': 'client_credentials',
            'client_id': clientId,
            'client_secret': clientSecret
        }), {
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            timeout: config.timeouts.perRequest
        });

        if (response.data && response.data.access_token) {
            caspioAccessToken = response.data.access_token;
            tokenExpiryTime = now + response.data.expires_in;
            console.log("New Caspio token obtained. Expires around:", new Date(tokenExpiryTime * 1000).toLocaleTimeString());
            return caspioAccessToken;
        } else {
            throw new Error("Invalid response structure from token endpoint.");
        }
    } catch (error) {
        console.error("Error getting Caspio access token:", error.response ? JSON.stringify(error.response.data) : error.message);
        caspioAccessToken = null; // Clear invalid token
        tokenExpiryTime = 0;
        throw new Error("Could not obtain Caspio access token.");
    }
}

/**
 * Makes an authenticated request to the Caspio API.
 * @param {string} method - HTTP method ('get', 'post', etc.)
 * @param {string} resourcePath - Path relative to base API URL (e.g., '/tables/YourTable/records')
 * @param {object} [params={}] - URL query parameters (e.g., { 'q.where': "Field='value'" })
 * @param {object} [data=null] - Request body data (for POST/PUT)
 * @returns {Promise<object>} - The 'Result' array from the Caspio response
 *
 * @deprecated Use fetchAllCaspioPages instead to handle Caspio pagination properly
 * This function only fetches a single page of results and should not be used for endpoints
 * where the result set might be large or paginated.
 */
async function makeCaspioRequest(method, resourcePath, params = {}, data = null) {
    try {
        const token = await getCaspioAccessToken();
        const url = `${caspioApiBaseUrl}${resourcePath}`;
        console.log(`Making Caspio Request: ${method.toUpperCase()} ${url} PARAMS: ${JSON.stringify(params)}`);

        const axiosConfig = {
            method: method,
            url: url,
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json'
            },
            params: params, // Axios handles query string building
            data: data,     // Axios handles request body
            timeout: config.timeouts.perRequest
        };

        console.log(`Request config: ${JSON.stringify(axiosConfig, (key, value) =>
            key === 'Authorization' ? '***REDACTED***' : value)}`);

        const response = await axios(axiosConfig);
        console.log(`Response status: ${response.status}`);

        if (response.data && response.data.Result) {
            return response.data.Result;
        } else {
            console.warn("Caspio API response did not contain 'Result':", response.data);
            return []; // Return empty array if structure is unexpected
        }
    } catch (error) {
        console.error(`Error making Caspio request to ${resourcePath}:`, error.response ? JSON.stringify(error.response.data) : error.message);
        // Throw a more specific error to be caught by the endpoint handler
        throw new Error(`Failed to fetch data from Caspio resource: ${resourcePath}. Status: ${error.response?.status}`);
    }
}

/**
 * IMPORTANT: Caspio API uses pagination. This function fetches ALL records
 * from a Caspio resource, handling pagination.
 * @param {string} resourcePath - Path relative to base API URL (e.g., '/tables/YourTable/records')
 * @param {object} [initialParams={}] - Initial URL query parameters
 * @param {object} [options={}] - Options like maxPages, earlyExitCondition, pageCallback
 * @returns {Promise<object[]>} - The combined 'Result' array from all pages.
 */
async function fetchAllCaspioPages(resourcePath, initialParams = {}, options = {}) {
    let allResults = [];
    let params = { ...initialParams };
    params['q.limit'] = params['q.limit'] || config.pagination.defaultLimit;
    let nextPageUrl = `${caspioApiBaseUrl}${resourcePath}`;

    const defaultOptions = {
        maxPages: config.pagination.maxPages,
        earlyExitCondition: null,
        pageCallback: null,
        totalTimeout: config.timeouts.totalPagination
    };
    const mergedOptions = { ...defaultOptions, ...options };
    
    // console.log(`Fetching up to ${mergedOptions.maxPages} pages for: ${resourcePath} with initial params: ${JSON.stringify(params)}`); // Verbose

    // Set up a total timeout for the entire pagination process
    const startTime = Date.now();
    const checkTotalTimeout = () => {
        if (Date.now() - startTime > mergedOptions.totalTimeout) {
            console.log(`Total timeout reached for ${resourcePath} after ${Date.now() - startTime}ms`);
            return true;
        }
        return false;
    };

    try {
        const token = await getCaspioAccessToken(); // Ensure getCaspioAccessToken is defined and working
        let pageCount = 0;
        let morePages = true;
        let currentRequestParams = { ...params };

        while (morePages && pageCount < mergedOptions.maxPages && !checkTotalTimeout()) {
            pageCount++;
            let currentUrl = nextPageUrl;

            if (pageCount === 1 || !nextPageUrl || !nextPageUrl.includes('@nextpage')) {
                 if (pageCount > 1) {
                    currentRequestParams['q.skip'] = (pageCount - 1) * (params['q.limit']);
                 }
                 currentUrl = `${caspioApiBaseUrl}${resourcePath}`;
            } else {
                currentRequestParams = undefined;
            }
            
            // console.log(`Fetching page ${pageCount} from: ${currentUrl.replace(caspioApiBaseUrl, '')} with params: ${JSON.stringify(currentRequestParams)}`); // Verbose
            const requestConfig = {
                method: 'get', url: currentUrl,
                headers: { 'Authorization': `Bearer ${token}` },
                params: currentRequestParams,
                timeout: config.timeouts.perRequest
            };

            try {
                const response = await axios(requestConfig);

            if (response.data && response.data.Result) {
                const pageResults = response.data.Result;
                // console.log(`Page ${pageCount} of ${resourcePath} contains ${pageResults.length} records.`); // Verbose

                const processedResults = mergedOptions.pageCallback ? mergedOptions.pageCallback(pageCount, pageResults) : pageResults;
                allResults = allResults.concat(processedResults);

                if (mergedOptions.earlyExitCondition && mergedOptions.earlyExitCondition(allResults)) {
                    console.log(`Early exit condition met after ${pageCount} pages for ${resourcePath}.`);
                    morePages = false;
                } else {
                    nextPageUrl = response.data['@nextpage'] ? response.data['@nextpage'] : null;
                    if (nextPageUrl) {
                        if (!nextPageUrl.startsWith('http')) {
                            nextPageUrl = caspioApiBaseUrl + (nextPageUrl.startsWith('/') ? '' : '/') + nextPageUrl;
                        }
                        morePages = true;
                    } else if (pageResults.length >= (params['q.limit']) && pageCount < mergedOptions.maxPages) {
                        console.log(`No @nextpage link for ${resourcePath} (page ${pageCount}), but page was full. Will attempt manual pagination if not at maxPages.`);
                        morePages = true;
                    } else {
                        morePages = false;
                    }
                }
            } else {
                console.warn(`Caspio API response page for ${resourcePath} did not contain 'Result':`, response.data);
                morePages = false;
            }
            } catch (pageError) {
                if (pageError.code === 'ECONNABORTED' || pageError.message.includes('timeout')) {
                    console.log(`Timeout on page ${pageCount} for ${resourcePath}, continuing with collected data`);
                    morePages = false; // Stop pagination on timeout
                } else {
                    throw pageError; // Re-throw non-timeout errors
                }
            }
        }
        console.log(`Finished fetching ${pageCount} page(s), total ${allResults.length} records for ${resourcePath}.`);
        return allResults;
    } catch (error) {
        console.error(`Error in fetchAllCaspioPages for ${resourcePath}:`, error.response ? JSON.stringify(error.response.data) : error.message, error.stack);
        throw new Error(`Failed to fetch all data from Caspio resource: ${resourcePath}. Original error: ${error.message}`);
    }
}

// --- API Endpoints ---

// Simple status check
app.get('/status', (req, res) => {
    res.json({ status: 'Proxy server running', caspio_domain: caspioDomain });
});

// Health check endpoint with comprehensive info
app.get('/api/health', (req, res) => {
    const os = require('os');
    
    // Get WSL IP
    const interfaces = os.networkInterfaces();
    let wslIP = '127.0.0.1';
    for (const name of Object.keys(interfaces)) {
        for (const iface of interfaces[name]) {
            if (iface.family === 'IPv4' && !iface.internal && iface.address.startsWith('172.')) {
                wslIP = iface.address;
                break;
            }
        }
    }
    
    res.json({
        status: 'healthy',
        message: 'Caspio Proxy Server is running',
        server: {
            port: PORT,
            actualPort: req.socket.localPort,
            environment: process.env.NODE_ENV || 'development',
            uptime: process.uptime(),
            wslIP: wslIP
        },
        caspio: {
            domain: caspioDomain,
            tokenCached: !!caspioAccessToken,
            tokenExpiry: tokenExpiryTime ? new Date(tokenExpiryTime * 1000).toISOString() : null
        },
        testUrls: {
            dashboard: `http://${wslIP}:${PORT}/api/order-dashboard`,
            products: `http://${wslIP}:${PORT}/api/products/PC54`,
            health: `http://${wslIP}:${PORT}/api/health`
        },
        timestamp: new Date().toISOString()
    });
});

// Test endpoint
app.get('/test', (req, res) => {
    res.json({ message: 'Test endpoint is working!' });
});

// Get Pricing Tiers based on Decoration Method
// Example: /api/pricing-tiers?method=DTG
app.get('/api/pricing-tiers', async (req, res) => {
    const { method } = req.query;
    if (!method) {
        return res.status(400).json({ error: 'Missing required query parameter: method' });
    }
    try {
        // Use Pricing_Tiers table instead of view
        const resource = '/tables/Pricing_Tiers/records';
        
        // Special handling for Embroidery - map to EmbroideryShirts
        let whereClause;
        if (method === 'Embroidery') {
            whereClause = `DecorationMethod='EmbroideryShirts'`;
            console.log(`Special handling for Embroidery method: querying for EmbroideryShirts`);
        } else {
            whereClause = `DecorationMethod='${method}'`;
        }
        
        const params = {
            'q.where': whereClause,
            // Select all fields from the Pricing_Tiers table
            'q.select': 'PK_ID,TierID,DecorationMethod,TierLabel,MinQuantity,MaxQuantity,MarginDenominator,TargetMargin,LTM_Fee',
            'q.limit': 100 // Ensure all tiers are fetched
        };
        // Use fetchAllCaspioPages to handle pagination
        const result = await fetchAllCaspioPages(resource, params);
        res.json(result);
    } catch (error) {
        res.status(500).json({ error: error.message || 'Failed to fetch pricing tiers.' });
    }
});


// Get Embroidery Costs
// Example: /api/embroidery-costs?itemType=Cap&stitchCount=8000
app.get('/api/embroidery-costs', async (req, res) => {
    const { itemType, stitchCount } = req.query;
    if (!itemType || !stitchCount) {
        return res.status(400).json({ error: 'Missing required query parameters: itemType, stitchCount' });
    }
    // Basic validation for stitch count
    const validStitches = ['5000', '8000', '10000'];
    if (!validStitches.includes(stitchCount)) {
         return res.status(400).json({ error: 'Invalid stitchCount parameter.' });
    }

    try {
        const resource = '/tables/Embroidery_Costs/records'; // Using table instead of view
        const params = {
            'q.where': `ItemType='${itemType}' AND StitchCount=${stitchCount}`,
            'q.select': 'TierLabel,EmbroideryCost', // Select needed fields
            'q.limit': 100
        };
        // Use fetchAllCaspioPages to handle pagination
        const result = await fetchAllCaspioPages(resource, params);
        // Return as an object keyed by TierLabel for easier lookup in frontend
        const costs = {};
        result.forEach(item => {
             costs[item.TierLabel] = item.EmbroideryCost;
        });
        res.json(costs);
    } catch (error) {
        res.status(500).json({ error: error.message || 'Failed to fetch embroidery costs.' });
    }
});

// Get DTG Costs (Fetch all and let frontend filter/use as needed)
// Example: /api/dtg-costs
app.get('/api/dtg-costs', async (req, res) => {
    try {
        const resource = '/tables/DTG_Costs/records'; // Using table instead of view
        const params = {
             'q.select': 'PrintLocationCode,TierLabel,PrintCost',
             'q.limit': 500 // Ensure all location/tier combos are fetched
        };
        // Use fetchAllCaspioPages to handle pagination
        const result = await fetchAllCaspioPages(resource, params);
         // Return as nested object: { LC: { '1-23': 7.00, ... }, FF: { ... } }
         const costs = {};
         result.forEach(item => {
             if (!costs[item.PrintLocationCode]) {
                 costs[item.PrintLocationCode] = {};
             }
             costs[item.PrintLocationCode][item.TierLabel] = item.PrintCost;
         });
        res.json(costs);
    } catch (error) {
        res.status(500).json({ error: error.message || 'Failed to fetch DTG costs.' });
    }
});

// Get Screenprint Costs
// Example: /api/screenprint-costs?costType=PrimaryLocation
// Example: /api/screenprint-costs?costType=AdditionalLocation
app.get('/api/screenprint-costs', async (req, res) => {
     const { costType } = req.query;
     if (!costType || (costType !== 'PrimaryLocation' && costType !== 'AdditionalLocation')) {
         return res.status(400).json({ error: 'Missing or invalid required query parameter: costType (PrimaryLocation or AdditionalLocation)' });
     }
    try {
        const resource = '/tables/Screenprint_Costs/records'; // Using table instead of view
        const params = {
             'q.where': `CostType='${costType}'`,
             'q.select': 'TierLabel,ColorCount,BasePrintCost',
             'q.limit': 500 // Ensure all tier/color combos are fetched
        };
        // Use fetchAllCaspioPages to handle pagination
        const result = await fetchAllCaspioPages(resource, params);
         // Return as nested object: { '13-36': { 1: 2.35, 2: 2.85, ... }, '37-72': { ... } }
         const costs = {};
         result.forEach(item => {
             if (!costs[item.TierLabel]) {
                 costs[item.TierLabel] = {};
             }
             costs[item.TierLabel][item.ColorCount] = item.BasePrintCost;
         });
        res.json(costs);
    } catch (error) {
        res.status(500).json({ error: error.message || 'Failed to fetch screenprint costs.' });
    }
});

// Get Pricing Rules based on Decoration Method
// Example: /api/pricing-rules?method=ScreenPrint
app.get('/api/pricing-rules', async (req, res) => {
     const { method } = req.query;
     if (!method) {
         return res.status(400).json({ error: 'Missing required query parameter: method' });
     }
    try {
        const resource = '/tables/Pricing_Rules/records'; // Using table instead of view
        // Fetch rules specific to the method OR 'All'
        const whereClause = `DecorationMethod='${method}' OR DecorationMethod='All'`;
        const params = {
             'q.where': whereClause,
             'q.select': 'RuleName,RuleValue',
             'q.limit': 100
        };
        // Use fetchAllCaspioPages to handle pagination
        const result = await fetchAllCaspioPages(resource, params);
         // Return as object: { RoundingMethod: 'CeilDollar', FlashCharge: '0.35', ... }
         const rules = {};
         result.forEach(item => {
             rules[item.RuleName] = item.RuleValue;
         });
        res.json(rules);
    } catch (error) {
        res.status(500).json({ error: error.message || 'Failed to fetch pricing rules.' });
    }
});

// Get Pricing Bundle - Consolidates tiers, rules, and costs for DTG
// Example: /api/pricing-bundle?method=DTG
// COMMENTED OUT - Now handled by pricing routes module
/*
app.get('/api/pricing-bundle', async (req, res) => {
    const { method, styleNumber } = req.query;
    console.log(`GET /api/pricing-bundle requested with method=${method}, styleNumber=${styleNumber || 'none'}`);

    if (!method) {
        return res.status(400).json({ error: 'Decoration method is required' });
    }

    if (method !== 'DTG') {
        return res.status(400).json({ error: 'Currently only DTG method is supported for pricing bundle' });
    }

    try {
        // Base queries that always run
        const baseQueries = [
            // Fetch pricing tiers
            fetchAllCaspioPages('/tables/Pricing_Tiers/records', {
                'q.where': `DecorationMethod='${method}'`,
                'q.select': 'PK_ID,TierID,DecorationMethod,TierLabel,MinQuantity,MaxQuantity,MarginDenominator,TargetMargin,LTM_Fee',
                'q.limit': 100
            }),
            
            // Fetch pricing rules  
            fetchAllCaspioPages('/tables/Pricing_Rules/records', {
                'q.where': `DecorationMethod='${method}' OR DecorationMethod='All'`,
                'q.select': 'RuleName,RuleValue',
                'q.limit': 100
            }),
            
            // Fetch DTG costs
            fetchAllCaspioPages('/tables/DTG_Costs/records', {
                'q.select': 'PrintLocationCode,TierLabel,PrintCost',
                'q.limit': 500
            }),
            
            // Fetch locations
            fetchAllCaspioPages('/tables/location/records', {
                'q.where': `Type='${method}'`,
                'q.select': 'location_code,location_name',
                'q.orderBy': 'PK_ID ASC',
                'q.limit': 100
            })
        ];

        // If styleNumber is provided, also fetch size-specific data
        if (styleNumber) {
            // Add the size upcharges query
            baseQueries.push(
                fetchAllCaspioPages('/tables/Standard_Size_Upcharges/records', {
                    'q.select': 'SizeDesignation,StandardAddOnAmount',
                    'q.orderby': 'SizeDesignation ASC',
                    'q.limit': 200
                })
            );
            
            // Add the Sanmar query for sizes
            baseQueries.push(
                fetchAllCaspioPages('/tables/Sanmar_Bulk_251816_Feb2024/records', {
                    'q.where': `STYLE='${styleNumber}'`,
                    'q.select': 'SIZE, MAX(CASE_PRICE) AS MAX_PRICE',
                    'q.groupBy': 'SIZE',
                    'q.limit': 100
                })
            );
            
            // Add the Size Display Order query
            baseQueries.push(
                fetchAllCaspioPages('/tables/Size_Display_Order/records', {
                    'q.select': 'size,sort_order',
                    'q.limit': 200
                })
            );
        }

        // Execute all queries in parallel
        const results = await Promise.all(baseQueries);
        
        // Destructure base results
        const [tiersResult, rulesResult, dtgCostsResult, locationsResult] = results;

        // Format rules as object (like the original pricing-rules endpoint)
        const rulesObject = {};
        rulesResult.forEach(item => {
            rulesObject[item.RuleName] = item.RuleValue;
        });

        console.log(`Pricing bundle for ${method}: ${tiersResult.length} tier(s), ${rulesResult.length} rule(s), ${dtgCostsResult.length} cost record(s), ${locationsResult.length} location(s)`);

        // Format locations for response
        const locations = locationsResult.map(loc => ({
            code: loc.location_code,
            name: loc.location_name
        }));

        // Prepare the base response
        const response = {
            tiersR: tiersResult,
            rulesR: rulesObject,  // Return as object, not array
            allDtgCostsR: dtgCostsResult,
            locations: locations
        };

        // If styleNumber was provided, process and add size-specific data
        if (styleNumber && results.length >= 7) {
            const [, , , , upchargeResults, inventoryResult, sizeOrderResults] = results;
            
            // Process selling price display add-ons
            let sellingPriceDisplayAddOns = {};
            upchargeResults.forEach(rule => {
                if (rule.SizeDesignation && rule.StandardAddOnAmount !== null && !isNaN(parseFloat(rule.StandardAddOnAmount))) {
                    sellingPriceDisplayAddOns[String(rule.SizeDesignation).trim().toUpperCase()] = parseFloat(rule.StandardAddOnAmount);
                }
            });
            
            // Create size order lookup map
            const sizeOrderMap = {};
            sizeOrderResults.forEach(item => {
                if (item.size && item.sort_order !== null) {
                    sizeOrderMap[item.size.toUpperCase()] = item.sort_order;
                }
            });
            
            // Process Sanmar data to get sizes
            const garmentCosts = {};
            
            inventoryResult.forEach(item => {
                if (item.SIZE && item.MAX_PRICE !== null && !isNaN(parseFloat(item.MAX_PRICE))) {
                    const sizeKey = String(item.SIZE).trim().toUpperCase();
                    const price = parseFloat(item.MAX_PRICE);
                    
                    // Data is already grouped by SIZE with MAX price
                    garmentCosts[sizeKey] = price;
                }
            });
            
            // Sort sizes by sort order from Size_Display_Order table
            const sortedSizeKeys = Object.keys(garmentCosts).sort((a, b) => {
                const orderA = sizeOrderMap[a] || 999;
                const orderB = sizeOrderMap[b] || 999;
                return orderA - orderB;
            });
            
            // Add size-specific data to response
            response.sizes = sortedSizeKeys.map(sizeKey => ({
                size: sizeKey,
                price: garmentCosts[sizeKey],
                sortOrder: sizeOrderMap[sizeKey] || 999
            }));
            response.sellingPriceDisplayAddOns = sellingPriceDisplayAddOns;
            
            console.log(`Added size data for ${styleNumber}: ${sortedSizeKeys.length} sizes found`);
        }

        res.json(response);
    } catch (error) {
        console.error('Error fetching pricing bundle:', error.message);
        res.status(500).json({ error: 'Failed to fetch pricing bundle', details: error.message });
    }
});
*/

// Get Base Item Costs (Max Case Price per Size for a Style)
// Example: /api/base-item-costs?styleNumber=XYZ123
app.get('/api/base-item-costs', async (req, res) => {
    const { styleNumber } = req.query;
    if (!styleNumber) {
        return res.status(400).json({ error: 'Missing required query parameter: styleNumber' });
    }
    try {
        // Use Inventory table
        const resource = '/tables/Inventory/records'; // Using Inventory table
        const params = {
            'q.where': `catalog_no='${styleNumber}'`, // Ensure field name matches your table/view
            'q.select': 'size,case_price,SizeSortOrder', // Added SizeSortOrder for proper size sorting
            'q.limit': 2000 // Fetch all relevant size/color records for the style
        };
        // Use fetchAllCaspioPages to handle pagination
        const result = await fetchAllCaspioPages(resource, params);

        // Process results server-side to find max case price per size
        const maxPrices = {};
        const sizeSortOrders = {};
        
        result.forEach(item => {
            if (item.size && item.case_price !== null && !isNaN(item.case_price)) {
                const size = item.size;
                const price = parseFloat(item.case_price);
                const sortOrder = item.SizeSortOrder || 999; // Default high value if missing
                
                // Store the sort order for each size
                if (!sizeSortOrders[size] || sortOrder < sizeSortOrders[size]) {
                    sizeSortOrders[size] = sortOrder;
                }
                
                // Find the max price for each size
                if (!maxPrices[size] || price > maxPrices[size]) {
                    maxPrices[size] = price;
                }
            }
        });

        if (Object.keys(maxPrices).length === 0) {
            // Optional: Return 404 if no data found for the style? Or just empty object?
            console.warn(`No inventory cost data found for style: ${styleNumber}`);
            // return res.status(404).json({ error: `No inventory cost data found for style: ${styleNumber}` });
        }

        // Create a response that includes both the original format and the sort orders
        const response = {
            prices: maxPrices,
            sortOrders: sizeSortOrders
        };

        res.json(response); // Return object: { prices: { "S": 10.50, "M": 10.50 }, sortOrders: { "S": 10, "M": 20 } }

    } catch (error) {
        res.status(500).json({ error: error.message || 'Failed to fetch base item costs.' });
    }
});

// Test endpoint for Sanmar_Bulk_251816_Feb2024 table
app.get('/api/test-sanmar-bulk', async (req, res) => {
    try {
        const resource = '/tables/Sanmar_Bulk_251816_Feb2024/records';
        const params = {
            'q.limit': 10 // Limit to 10 records for testing
        };
        // Use fetchAllCaspioPages to handle pagination
        const result = await fetchAllCaspioPages(resource, params);
        res.json(result);
    } catch (error) {
        res.status(500).json({ error: error.message || 'Failed to fetch Sanmar bulk data.' });
    }
});

// GET /api/locations - Get all print locations
// Example: /api/locations or /api/locations?type=DTG
app.get('/api/locations', async (req, res) => {
    const { type } = req.query;
    console.log(`GET /api/locations requested with type=${type || 'all'}`);

    try {
        const params = {
            'q.select': 'location_code,location_name,Type',
            'q.orderBy': 'PK_ID ASC',
            'q.limit': 100
        };
        
        if (type) {
            params['q.where'] = `Type='${type}'`;
        }
        
        const locations = await fetchAllCaspioPages('/tables/location/records', params);
        console.log(`Locations: ${locations.length} record(s) found`);
        res.json(locations);
    } catch (error) {
        console.error('Error fetching locations:', error.message);
        res.status(500).json({ error: 'Failed to fetch locations', details: error.message });
    }
});

// GET /api/staff-announcements - Get active staff announcements
// NOTE: This endpoint is now loaded from src/routes/misc.js
/*
app.get('/api/staff-announcements', async (req, res) => {
    console.log('GET /api/staff-announcements requested');
    
    try {
        // Fetch active announcements from Caspio
        const announcements = await fetchAllCaspioPages('/tables/staff_announcements/records', {
            'q.where': 'IsActive=1',  // Only get active announcements (1 = true in Caspio)
            'q.orderBy': 'Priority ASC',  // Show highest priority first (1 is highest)
            'q.limit': 100
        });
        
        console.log(`Staff announcements: ${announcements.length} active announcement(s) found`);
        res.json(announcements);
    } catch (error) {
        console.error('Error fetching staff announcements:', error.message);
        res.status(500).json({ error: 'Failed to fetch staff announcements', details: error.message });
    }
});
*/

// GET /api/size-upcharges - Get standard size upcharges
// Example: /api/size-upcharges
app.get('/api/size-upcharges', async (req, res) => {
    console.log('GET /api/size-upcharges requested');

    try {
        const upcharges = await fetchAllCaspioPages('/tables/Standard_Size_Upcharges/records', {
            'q.select': 'SizeDesignation,StandardAddOnAmount',
            'q.orderBy': 'SizeDesignation ASC',
            'q.limit': 200
        });
        
        console.log(`Size upcharges: ${upcharges.length} record(s) found`);
        res.json(upcharges);
    } catch (error) {
        console.error('Error fetching size upcharges:', error.message);
        res.status(500).json({ error: 'Failed to fetch size upcharges', details: error.message });
    }
});

// GET /api/size-sort-order - Get size display order
// Example: /api/size-sort-order
app.get('/api/size-sort-order', async (req, res) => {
    console.log('GET /api/size-sort-order requested');

    try {
        const sortOrders = await fetchAllCaspioPages('/tables/Size_Display_Order/records', {
            'q.select': 'size,sort_order',
            'q.orderBy': 'sort_order ASC',
            'q.limit': 200
        });
        
        console.log(`Size sort orders: ${sortOrders.length} record(s) found`);
        res.json(sortOrders);
    } catch (error) {
        console.error('Error fetching size sort orders:', error.message);
        res.status(500).json({ error: 'Failed to fetch size sort orders', details: error.message });
    }
});

// --- ENHANCED Endpoint: Style Search Autocomplete with Improved Pagination ---
// MOVED TO src/routes/products.js
/*
// Example: /api/stylesearch?term=PC
app.get('/api/stylesearch', async (req, res) => {
    const { term } = req.query;
    if (!term || term.length < 2) { // Require at least 2 characters
        return res.json([]);
    }
    try {
        console.log(`Style search for term: "${term}" (${term.length} characters)`);
        const resource = '/tables/Sanmar_Bulk_251816_Feb2024/records';
        
        // IMPORTANT: Set a very high limit to ensure we get as many results per page as possible
        // This helps with pagination by reducing the number of API calls needed
        const MAX_LIMIT = 1000;
        
        // First, try to find styles that START with the search term (highest priority)
        const startsWithClause = `STYLE LIKE '${term}%'`;
        
        const startsWithParams = {
            'q.where': startsWithClause,
            'q.select': 'STYLE, PRODUCT_TITLE',
            'q.orderby': 'STYLE ASC',
            'q.limit': MAX_LIMIT // Use maximum limit for better pagination handling
        };
        
        console.log(`Fetching all styles that START with "${term}" using pagination...`);
        // Use fetchAllCaspioPages to handle pagination - this will get ALL pages
        const startsWithResults = await fetchAllCaspioPages(resource, startsWithParams);
        console.log(`Style search found ${startsWithResults.length} total "starts with" matches for "${term}" across all pages`);

        // If we have enough "starts with" results, we can skip the "contains" search
        let containsResults = [];
        if (startsWithResults.length < 20 && term.length >= 3) {
            // If we don't have many "starts with" results and the term is at least 3 chars,
            // also look for styles that CONTAIN the search term (lower priority)
            const containsClause = `STYLE LIKE '%${term}%' AND NOT STYLE LIKE '${term}%'`;
            
            const containsParams = {
                'q.where': containsClause,
                'q.select': 'STYLE, PRODUCT_TITLE',
                'q.orderby': 'STYLE ASC',
                'q.limit': MAX_LIMIT // Use maximum limit for better pagination handling
            };
            
            console.log(`Fetching all styles that CONTAIN "${term}" using pagination...`);
            containsResults = await fetchAllCaspioPages(resource, containsParams);
            console.log(`Style search found ${containsResults.length} additional "contains" matches for "${term}" across all pages`);
        }
        
        // Combine results, with "starts with" matches first
        const combinedResults = [...startsWithResults, ...containsResults];
        console.log(`Combined results before filtering: ${combinedResults.length}`);
        
        // Filter out nulls and empty strings
        const validResults = combinedResults.filter(item => item.STYLE && item.STYLE.trim() !== '');
        console.log(`Valid results after filtering: ${validResults.length}`);
        
        // Deduplicate by STYLE
        const styleMap = new Map();
        validResults.forEach(item => {
            if (!styleMap.has(item.STYLE)) {
                styleMap.set(item.STYLE, item);
            }
        });
        
        // Convert to array and sort alphabetically
        const uniqueResults = Array.from(styleMap.values());
        uniqueResults.sort((a, b) => a.STYLE.localeCompare(b.STYLE));
        console.log(`Unique styles after deduplication: ${uniqueResults.length}`);
        
        // Limit to 100 results (increased from 50 for more comprehensive results)
        const limitedResults = uniqueResults.slice(0, 100);
        
        // Format for autocomplete with enhanced labels
        const suggestions = limitedResults.map(item => {
            const titleSuffix = item.PRODUCT_TITLE ? ` - ${item.PRODUCT_TITLE}` : '';
            
            return {
                label: `${item.STYLE}${titleSuffix}`, // Show style number and title for better context
                value: item.STYLE  // Use the style number when selected
            };
        });

        console.log(`Style search returning ${suggestions.length} suggestions for "${term}"`);
        res.json(suggestions);
    } catch (error) {
        console.error("Style search error:", error.message);
        res.status(500).json({ error: 'Failed to perform style search.' });
    }
});
*/


// --- UPDATED Endpoint: Product Details with Color-Specific Images ---
// MOVED TO src/routes/products.js
/*
// Example: /api/product-details?styleNumber=PC61&color=Red or /api/product-details?styleNumber=PC61&COLOR_NAME=Red
app.get('/api/product-details', async (req, res) => {
    // Accept both 'color' and 'COLOR_NAME' parameters for flexibility
    const { styleNumber, color, COLOR_NAME, CATALOG_COLOR } = req.query;
    // Use the first available color parameter (prioritize 'color' for backward compatibility)
    const colorParam = color || COLOR_NAME || CATALOG_COLOR;
    
    if (!styleNumber) {
        return res.status(400).json({ error: 'Missing required query parameter: styleNumber' });
    }
    try {
        // First, get basic product details (title, description)
        const resource = '/tables/Sanmar_Bulk_251816_Feb2024/records';
        let whereClause = `STYLE='${styleNumber}'`;
        
        // If color is provided, use it to filter results
        if (colorParam) {
            whereClause += ` AND (CATALOG_COLOR='${colorParam}' OR COLOR_NAME='${colorParam}')`;
        }
        
        const params = {
            'q.where': whereClause,
            'q.select': 'PRODUCT_TITLE, PRODUCT_DESCRIPTION, COLOR_NAME, CATALOG_COLOR',
            'q.limit': 1 // Just need one row for basic details
        };
        console.log(`Product Details: Fetching for Style=${styleNumber}, Color=${colorParam || 'Any'}`);
        // Use fetchAllCaspioPages to handle pagination
        const result = await fetchAllCaspioPages(resource, params);


        if (result.length === 0) {
            return res.status(404).json({ error: `Product details not found for style: ${styleNumber}${colorParam ? ` and color: ${colorParam}` : ''}` });
        }
        
        // Get the basic product details
        const productDetails = result[0];
        const colorName = productDetails.COLOR_NAME || colorParam || '';
        
        // Now, get color-specific images
        // If color is provided, get images for that specific color
        // Otherwise, get images for any color of the style
        const imageParams = {
            'q.where': colorParam ?
                `STYLE='${styleNumber}' AND (CATALOG_COLOR='${colorParam}' OR COLOR_NAME='${colorParam}')` :
                `STYLE='${styleNumber}'`,
            'q.select': 'FRONT_FLAT, FRONT_MODEL, BACK_FLAT, BACK_MODEL, COLOR_NAME, CATALOG_COLOR',
            'q.limit': 10 // Get a few records to find one with images
        };
        console.log(`Product Images: Fetching for Style=${styleNumber}, Color=${colorParam || 'Any'}`);
        // Use fetchAllCaspioPages to handle pagination
        const imageResults = await fetchAllCaspioPages(resource, imageParams);
        
        
        // First, try to find a record with the exact requested color that has images
        let imageRecord = null;
        
        if (colorParam) {
            // Look for records that match the requested color AND have images
            imageRecord = imageResults.find(record =>
                (record.CATALOG_COLOR === colorParam || record.COLOR_NAME === colorParam) &&
                (record.FRONT_MODEL || record.FRONT_FLAT || record.BACK_MODEL || record.BACK_FLAT)
            );
            
            console.log(`Product Images: ${imageRecord ? 'Found' : 'Did not find'} images for exact color match: ${colorParam}`);
        }
        
        // If no color-specific record with images was found, fall back to any record with images
        if (!imageRecord) {
            imageRecord = imageResults.find(record =>
                record.FRONT_MODEL || record.FRONT_FLAT || record.BACK_MODEL || record.BACK_FLAT
            ) || {};
            
            console.log(`Product Images: Using fallback images from color: ${imageRecord.COLOR_NAME || 'unknown'}`);
        }
        
        // Combine the basic details with the images
        const response = {
            ...productDetails,
            FRONT_FLAT: imageRecord.FRONT_FLAT || '',
            FRONT_MODEL: imageRecord.FRONT_MODEL || '',
            BACK_FLAT: imageRecord.BACK_FLAT || '',
            BACK_MODEL: imageRecord.BACK_MODEL || '',
            // Include the color information from the image record if it exists
            COLOR_NAME: productDetails.COLOR_NAME || imageRecord.COLOR_NAME || '',
            CATALOG_COLOR: productDetails.CATALOG_COLOR || imageRecord.CATALOG_COLOR || ''
        };
        
        console.log(`Product Details: Returning details for Style=${styleNumber}, Color=${response.COLOR_NAME}`);
        res.json(response);

    } catch (error) {
        console.error("Product Details Error:", error);
        res.status(500).json({ error: error.message || 'Failed to fetch product details.' });
    }
});
*/

/* --- DUPLICATE ENDPOINT: Color Swatches (Migrated to src/routes/products.js) ---
// Example: /api/color-swatches?styleNumber=PC61
app.get('/api/color-swatches', async (req, res) => {
    const { styleNumber } = req.query;
    if (!styleNumber) {
        return res.status(400).json({ error: 'Missing required query parameter: styleNumber' });
    }
    try {
        console.log(`Fetching color swatches for style: ${styleNumber}`);
        const resource = '/tables/Sanmar_Bulk_251816_Feb2024/records';
        
        // First, get a small sample to find the first available size
        const sampleParams = {
            'q.where': `STYLE='${styleNumber}'`,
            'q.select': 'size',
            'q.orderby': 'SizeSortOrder ASC, size ASC',
            'q.limit': 1 // Just get the first record to find a size
        };
        
        // Get the first available size
        let firstSize = null;
        try {
            const sampleResult = await fetchAllCaspioPages(resource, sampleParams, { maxPages: 1 });
            if (sampleResult && sampleResult.length > 0 && sampleResult[0].size) {
                firstSize = sampleResult[0].size;
                console.log(`Using first available size: ${firstSize} for style ${styleNumber}`);
            }
        } catch (sampleError) {
            console.log(`Could not fetch sample size, proceeding without size filter`);
        }
        
        // Now get colors, filtering by the first size if available
        const params = {
            'q.where': firstSize ?
                `STYLE='${styleNumber}' AND size='${firstSize}'` :
                `STYLE='${styleNumber}'`, // Fallback to no size filter if needed
            'q.select': 'COLOR_NAME, CATALOG_COLOR, COLOR_SQUARE_IMAGE',
            'q.orderby': 'COLOR_NAME ASC',
            'q.limit': 1000 // Increased page size to get more records per request
        };
        
        // Custom page callback to track progress
        let pageCount = 0;
        const allColors = [];
        const seenColors = new Set();
        
        const pageCallback = (pageNum, pageData) => {
            pageCount++;
            console.log(`Color swatches - Page ${pageNum}: ${pageData.length} records`);
            
            // Process colors immediately as we get them
            pageData.forEach(item => {
                // Include colors even if they don't have images
                const colorName = item.COLOR_NAME || item.CATALOG_COLOR;
                if (colorName && !seenColors.has(colorName)) {
                    seenColors.add(colorName);
                    allColors.push({
                        COLOR_NAME: item.COLOR_NAME || '',
                        CATALOG_COLOR: item.CATALOG_COLOR || '',
                        COLOR_SQUARE_IMAGE: item.COLOR_SQUARE_IMAGE || '' // Allow empty image URLs
                    });
                }
            });
            
            // Don't stop early - we want ALL colors
            console.log(`Collected ${allColors.length} unique colors so far...`);
            
            return pageData;
        };
        
        try {
            // Use fetchAllCaspioPages with optimized settings
            const result = await fetchAllCaspioPages(resource, params, {
                maxPages: 100, // Further increased to ensure we get all colors
                pageCallback: pageCallback,
                totalTimeout: 29000 // Increased timeout to 29 seconds (just under Heroku's 30s limit)
            });
            
            console.log(`Fetched ${result.length} total records for style ${styleNumber}`);
        } catch (fetchError) {
            // If we timeout but have some colors, return what we have
            console.log(`Fetch error occurred, but returning ${allColors.length} colors collected so far`);
            if (allColors.length > 0) {
                // Sort and return partial results
                allColors.sort((a, b) => a.COLOR_NAME.localeCompare(b.COLOR_NAME));
                return res.json(allColors);
            }
            throw fetchError; // Re-throw if we have no data
        }
        
        // The colors have already been collected and deduplicated in allColors
        // Sort colors alphabetically for consistent output
        allColors.sort((a, b) => a.COLOR_NAME.localeCompare(b.COLOR_NAME));
        
        console.log(`Returning ${allColors.length} unique colors for style ${styleNumber}`);
        res.json(allColors);
    } catch (error) {
        console.error(`Error in /api/color-swatches for style ${styleNumber}:`, error.message);
        // Return a more graceful error response
        res.status(500).json({
            error: 'Failed to fetch color swatches.',
            message: error.message,
            styleNumber: styleNumber
        });
    }
});
*/
/* --- DUPLICATE ENDPOINT: Get Inventory Data (Migrated to src/routes/inventory.js) ---
// Example: /api/inventory?styleNumber=S100&color=Red
app.get('/api/inventory', async (req, res) => {
    const { styleNumber, color } = req.query;
    if (!styleNumber) {
        return res.status(400).json({ error: 'Missing required query parameter: styleNumber' });
    }
    try {
        const resource = '/tables/Inventory/records';
        let whereClause = `catalog_no='${styleNumber}'`;
        if (color) {
            whereClause += ` AND catalog_color='${color}'`;
        }
        const params = {
            'q.where': whereClause,
            'q.select': 'WarehouseName, size, quantity, WarehouseSort, SizeSortOrder',
            'q.orderby': 'WarehouseSort ASC, SizeSortOrder ASC',
            'q.limit': 1000 // Ask for max per page
        };
        // Use the new function to fetch all pages
        const result = await fetchAllCaspioPages(resource, params);
        
        if (result.length === 0) {
            console.warn(`No inventory data found for style: ${styleNumber}${color ? ` and color: ${color}` : ''}`);
        }
        
        res.json(result);
        
    } catch (error) {
        res.status(500).json({ error: error.message || 'Failed to fetch inventory data.' });
    }
});
*/

/* --- DUPLICATE ENDPOINT: Product Search by Brand (Migrated to src/routes/products.js) ---
// Example: /api/products-by-brand?brand=Bella+%2B+Canvas
app.get('/api/products-by-brand', async (req, res) => {
    const { brand } = req.query;
    if (!brand) {
        return res.status(400).json({ error: 'Missing required query parameter: brand' });
    }
    try {
        console.log(`Searching for products with brand containing: "${brand}"`);
        const resource = '/tables/Sanmar_Bulk_251816_Feb2024/records';
        const params = {
            // Try a simpler approach without UPPER() function
            'q.where': `BRAND_NAME LIKE '%${brand}%'`,
            'q.select': 'STYLE, PRODUCT_TITLE, COLOR_NAME, FRONT_FLAT, BRAND_NAME, BRAND_LOGO_IMAGE',
            // Remove distinct to get all results
            'q.orderby': 'STYLE ASC',
            'q.limit': 5000 // Increase limit to get more results
        };
        
        console.log(`Fetching all pages from Caspio for brand: ${brand}`);
        
        // Use fetchAllCaspioPages to get all results
        const result = await fetchAllCaspioPages(resource, params);
        console.log(`Found ${result.length} total records matching brand: ${brand}`);
        
        // Log the first few results to see what brands are being returned
        if (result.length > 0) {
            console.log("Sample brands found:");
            const sampleBrands = new Set();
            result.slice(0, Math.min(10, result.length)).forEach(item => {
                sampleBrands.add(item.BRAND_NAME);
            });
            console.log([...sampleBrands]);
        }
        
        // Deduplicate by STYLE to get unique products
        const uniqueProducts = [];
        const seenStyles = new Set();
        
        for (const product of result) {
            if (!seenStyles.has(product.STYLE)) {
                seenStyles.add(product.STYLE);
                uniqueProducts.push(product);
            }
        }
        
        console.log(`Returning ${uniqueProducts.length} unique products for brand: ${brand}`);
        res.json(uniqueProducts);
    } catch (error) {
        console.error("Error in products-by-brand:", error);
        res.status(500).json({ error: error.message || 'Failed to fetch products by brand.' });
    }
});
*/

/* --- DUPLICATE ENDPOINT: Product Search by Category (Migrated to src/routes/misc.js) ---
// Example: /api/products-by-category?category=T-Shirts
app.get('/api/products-by-category', async (req, res) => {
    const { category } = req.query;
    if (!category) {
        return res.status(400).json({ error: 'Missing required query parameter: category' });
    }
    try {
        const resource = '/tables/Sanmar_Bulk_251816_Feb2024/records';
        const params = {
            // Use exact match for category name to ensure we get all T-shirts
            'q.where': `CATEGORY_NAME='${category}'`,
            'q.select': 'STYLE, PRODUCT_TITLE, COLOR_NAME, FRONT_FLAT, BRAND_NAME, BRAND_LOGO_IMAGE',
            // Remove distinct to get all results
            'q.orderby': 'STYLE ASC',
            'q.limit': 10000 // Increase limit to get more results
        };
        
        console.log(`Fetching all pages from Caspio for category: ${category}`);
        // Use fetchAllCaspioPages to handle pagination
        const result = await fetchAllCaspioPages(resource, params);
        console.log(`Found ${result.length} total records matching category: ${category}`);
        
        
        // Deduplicate by STYLE to get unique products
        const uniqueProducts = [];
        const seenStyles = new Set();
        
        for (const product of result) {
            if (!seenStyles.has(product.STYLE)) {
                seenStyles.add(product.STYLE);
                uniqueProducts.push(product);
            }
        }
        
        console.log(`Returning ${uniqueProducts.length} unique products for category: ${category}`);
        res.json(uniqueProducts);
    } catch (error) {
        res.status(500).json({ error: error.message || 'Failed to fetch products by category.' });
    }
});
*/

/* --- DUPLICATE ENDPOINT: Product Search by Subcategory (Migrated to src/routes/products.js) ---
// Example: /api/products-by-subcategory?subcategory=Youth
app.get('/api/products-by-subcategory', async (req, res) => {
    const { subcategory } = req.query;
    if (!subcategory) {
        return res.status(400).json({ error: 'Missing required query parameter: subcategory' });
    }
    try {
        const resource = '/tables/Sanmar_Bulk_251816_Feb2024/records';
        const params = {
            // Use LIKE instead of exact equality to be more flexible
            'q.where': `SUBCATEGORY_NAME LIKE '%${subcategory}%' OR PRODUCT_TITLE LIKE '%${subcategory}%'`,
            'q.select': 'STYLE, PRODUCT_TITLE, COLOR_NAME, FRONT_FLAT, BRAND_NAME, BRAND_LOGO_IMAGE',
            // Remove distinct to get all results
            'q.orderby': 'STYLE ASC',
            'q.limit': 5000 // Increase limit to get more results
        };
        
        console.log(`Fetching all pages from Caspio for subcategory: ${subcategory}`);
        // Use fetchAllCaspioPages to handle pagination
        const result = await fetchAllCaspioPages(resource, params);
        console.log(`Found ${result.length} total records matching subcategory: ${subcategory}`);
        
        
        // Deduplicate by STYLE to get unique products
        const uniqueProducts = [];
        const seenStyles = new Set();
        
        for (const product of result) {
            if (!seenStyles.has(product.STYLE)) {
                seenStyles.add(product.STYLE);
                uniqueProducts.push(product);
            }
        }
        
        console.log(`Returning ${uniqueProducts.length} unique products for subcategory: ${subcategory}`);
        res.json(uniqueProducts);
    } catch (error) {
        res.status(500).json({ error: error.message || 'Failed to fetch products by subcategory.' });
    }
});
*/

/* --- DUPLICATE ENDPOINT: Get All Brands (Migrated to src/routes/products.js) ---
// Example: /api/all-brands
app.get('/api/all-brands', async (req, res) => {
    try {
        console.log("Fetching all unique brands from Caspio");
        
        const resource = '/tables/Sanmar_Bulk_251816_Feb2024/records';
        const params = {
            'q.select': 'BRAND_NAME',
            'q.orderby': 'BRAND_NAME ASC',
            'q.limit': 5000 // Set a high limit to get all brands
        };
        
        // Use fetchAllCaspioPages to handle pagination
        const result = await fetchAllCaspioPages(resource, params);
        console.log(`Found ${result.length} brand records`);
        
        // Extract brand names and filter out nulls or empty strings
        const brands = result
            .map(item => item.BRAND_NAME)
            .filter(name => name && name.trim() !== '');
        
        // Remove duplicates
        const uniqueBrands = [...new Set(brands)];
        
        // Format the response to match the expected structure
        const formattedBrands = uniqueBrands.map(brandName => ({
            name: brandName,
            styles: [] // We're not collecting styles here for simplicity
        }));
        
        console.log(`Returning ${formattedBrands.length} unique brands from database`);
        res.json(formattedBrands);
    } catch (error) {
        console.error("Error fetching brands:", error);
        res.status(500).json({ error: error.message || 'Failed to fetch brands.' });
    }
});
*/

// --- NEW Endpoint: Get All Subcategories ---
// Example: /api/all-subcategories
app.get('/api/all-subcategories', async (req, res) => {
    try {
        console.log("Fetching all unique subcategories from Caspio");
        
        const resource = '/tables/Sanmar_Bulk_251816_Feb2024/records';
        const params = {
            'q.select': 'SUBCATEGORY_NAME',
            'q.orderby': 'SUBCATEGORY_NAME ASC',
            'q.limit': 5000 // Set a high limit to get all subcategories
        };
        
        // Use fetchAllCaspioPages to handle pagination
        const result = await fetchAllCaspioPages(resource, params);
        
        // Extract subcategory names and filter out nulls or empty strings
        const subcategories = result
            .map(item => item.SUBCATEGORY_NAME)
            .filter(name => name && name.trim() !== '');
        
        // Remove duplicates
        const uniqueSubcategories = [...new Set(subcategories)];
        
        console.log(`Returning ${uniqueSubcategories.length} unique subcategories from database`);
        res.json(uniqueSubcategories.sort());
    } catch (error) {
        console.error("Error fetching subcategories:", error);
        res.status(500).json({ error: error.message || 'Failed to fetch subcategories.' });
    }
});

// --- NEW Endpoint: Get All Categories ---
// Example: /api/all-categories
app.get('/api/all-categories', async (req, res) => {
    try {
        console.log("Fetching all unique categories from Caspio");
        
        const resource = '/tables/Sanmar_Bulk_251816_Feb2024/records';
        const params = {
            'q.select': 'CATEGORY_NAME',
            'q.orderby': 'CATEGORY_NAME ASC',
            'q.limit': 5000 // Set a high limit to get all categories
        };
        
        // Use fetchAllCaspioPages to handle pagination
        const result = await fetchAllCaspioPages(resource, params);
        
        // Extract category names and filter out nulls or empty strings
        const categories = result
            .map(item => item.CATEGORY_NAME)
            .filter(name => name && name.trim() !== '');
        
        // Remove duplicates
        const uniqueCategories = [...new Set(categories)];
        
        console.log(`Returning ${uniqueCategories.length} unique categories from database`);
        res.json(uniqueCategories.sort());
    } catch (error) {
        console.error("Error fetching categories:", error);
        res.status(500).json({ error: error.message || 'Failed to fetch categories.' });
    }
});

// --- NEW Endpoint: Get Subcategories by Category ---
// Example: /api/subcategories-by-category?category=Caps
app.get('/api/subcategories-by-category', async (req, res) => {
    try {
        const { category } = req.query;
        if (!category) {
            return res.status(400).json({ error: 'Missing required query parameter: category' });
        }

        console.log(`Fetching subcategories for category: ${category} from Caspio`);
        
        const resource = '/tables/Sanmar_Bulk_251816_Feb2024/records';
        const params = {
            'q.where': `CATEGORY_NAME LIKE '%${category}%'`,
            'q.select': 'SUBCATEGORY_NAME',
            'q.distinct': true,
            'q.orderby': 'SUBCATEGORY_NAME ASC',
            'q.limit': 5000 // Set a high limit to get all subcategories
        };
        
        // Use fetchAllCaspioPages to handle pagination
        const result = await fetchAllCaspioPages(resource, params);
        
        // Extract subcategory names and filter out nulls or empty strings
        const subcategories = result
            .map(item => item.SUBCATEGORY_NAME)
            .filter(name => name && name.trim() !== '');
        
        // Remove duplicates (just in case)
        const uniqueSubcategories = [...new Set(subcategories)];
        
        console.log(`Returning ${uniqueSubcategories.length} unique subcategories for category: ${category} from database`);
        res.json(uniqueSubcategories.sort());
    } catch (error) {
        console.error("Error fetching subcategories by category:", error);
        res.status(500).json({ error: error.message || 'Failed to fetch subcategories by category.' });
    }
});

// --- NEW Endpoint: Get Products by Category and Subcategory ---
// Example: /api/products-by-category-subcategory?category=Caps&subcategory=Mesh%20Back
app.get('/api/products-by-category-subcategory', async (req, res) => {
    try {
        const { category, subcategory } = req.query;
        if (!category || !subcategory) {
            return res.status(400).json({ error: 'Missing required query parameters: category, subcategory' });
        }

        console.log(`Searching for products with category: "${category}" and subcategory: "${subcategory}"`);
        
        const resource = '/tables/Sanmar_Bulk_251816_Feb2024/records';
        const params = {
            // Use LIKE for more flexible matching
            'q.where': `(CATEGORY_NAME LIKE '%${category}%' OR PRODUCT_TITLE LIKE '%${category}%') AND
                        (SUBCATEGORY_NAME LIKE '%${subcategory}%' OR PRODUCT_TITLE LIKE '%${subcategory}%')`,
            'q.select': 'STYLE, PRODUCT_TITLE, COLOR_NAME, FRONT_FLAT, BRAND_NAME, BRAND_LOGO_IMAGE, CASE_PRICE, PRODUCT_STATUS',
            'q.orderby': 'STYLE ASC',
            'q.limit': 5000 // Increase limit to get more results
        };
        
        console.log(`Fetching all pages from Caspio for category: ${category} and subcategory: ${subcategory}`);
        
        // Use fetchAllCaspioPages to get all results
        const result = await fetchAllCaspioPages(resource, params);
        console.log(`Found ${result.length} total records matching category: ${category} and subcategory: ${subcategory}`);
        
        // Deduplicate by STYLE to get unique products
        const uniqueProducts = [];
        const seenStyles = new Set();
        
        for (const product of result) {
            if (!seenStyles.has(product.STYLE)) {
                seenStyles.add(product.STYLE);
                
                // Format the product for the gallery view
                const formattedProduct = {
                    style: product.STYLE,
                    title: product.PRODUCT_TITLE,
                    image: product.FRONT_FLAT,
                    brand: product.BRAND_NAME,
                    brandLogo: product.BRAND_LOGO_IMAGE,
                    price: product.CASE_PRICE ? `$${product.CASE_PRICE}+` : 'Call for pricing',
                    isNew: product.PRODUCT_STATUS === 'New' || product.PRODUCT_STATUS === 'Active'
                };
                
                uniqueProducts.push(formattedProduct);
            }
        }
        
        console.log(`Returning ${uniqueProducts.length} unique products for category: ${category} and subcategory: ${subcategory}`);
        res.json(uniqueProducts);
    } catch (error) {
        console.error("Error in products-by-category-subcategory:", error);
        res.status(500).json({ error: error.message || 'Failed to fetch products by category and subcategory.' });
    }
});
// --- NEW Endpoint: Search Across All Products ---
// Example: /api/search?q=hoodie
app.get('/api/search', async (req, res) => {
    const { q } = req.query;
    if (!q || q.length < 2) { // Require at least 2 characters
        return res.status(400).json({ error: 'Search query must be at least 2 characters' });
    }
    try {
        console.log(`Performing search for query: "${q}"`);
        const resource = '/tables/Sanmar_Bulk_251816_Feb2024/records';
        const params = {
            // Search across multiple fields
            'q.where': `STYLE LIKE '%${q}%' OR PRODUCT_TITLE LIKE '%${q}%' OR PRODUCT_DESCRIPTION LIKE '%${q}%' OR BRAND_NAME LIKE '%${q}%' OR CATEGORY_NAME LIKE '%${q}%' OR SUBCATEGORY_NAME LIKE '%${q}%'`,
            'q.select': 'STYLE, PRODUCT_TITLE, COLOR_NAME, FRONT_FLAT, BRAND_NAME, BRAND_LOGO_IMAGE, CATEGORY_NAME, SUBCATEGORY_NAME',
            'q.orderby': 'STYLE ASC',
            'q.limit': 10000 // High limit to get comprehensive results
        };
        
        console.log(`Fetching search results from Caspio for query: ${q}`);
        const result = await fetchAllCaspioPages(resource, params);
        console.log(`Found ${result.length} total records matching search query: ${q}`);
        
        // Deduplicate by STYLE to get unique products
        const uniqueProducts = [];
        const seenStyles = new Set();
        
        for (const product of result) {
            if (!seenStyles.has(product.STYLE)) {
                seenStyles.add(product.STYLE);
                uniqueProducts.push(product);
            }
        }
        
        console.log(`Returning ${uniqueProducts.length} unique products for search query: ${q}`);
        res.json(uniqueProducts);
    } catch (error) {
        console.error("Search error:", error.message);
        res.status(500).json({ error: 'Failed to perform search.' });
    }
});

// --- NEW Endpoint: Featured/New Products ---
// Example: /api/featured-products
app.get('/api/featured-products', async (req, res) => {
    try {
        console.log("Fetching featured/new products");
        const resource = '/tables/Sanmar_Bulk_251816_Feb2024/records';
        const params = {
            // Get products with "New" status
            'q.where': `PRODUCT_STATUS='New'`,
            'q.select': 'STYLE, PRODUCT_TITLE, COLOR_NAME, FRONT_FLAT, BRAND_NAME, BRAND_LOGO_IMAGE, CATEGORY_NAME, PRODUCT_STATUS',
            'q.orderby': 'STYLE ASC',
            'q.limit': 100 // Limit to a reasonable number for featured items
        };
        
        const result = await fetchAllCaspioPages(resource, params);
        console.log(`Found ${result.length} total new/featured products`);
        
        // Deduplicate by STYLE to get unique products
        const uniqueProducts = [];
        const seenStyles = new Set();
        
        for (const product of result) {
            if (!seenStyles.has(product.STYLE)) {
                seenStyles.add(product.STYLE);
                uniqueProducts.push(product);
            }
        }
        
        console.log(`Returning ${uniqueProducts.length} unique featured products`);
        res.json(uniqueProducts);
    } catch (error) {
        console.error("Featured products error:", error.message);
        res.status(500).json({ error: 'Failed to fetch featured products.' });
    }
});

// --- NEW Endpoint: Related Products ---
// Example: /api/related-products?styleNumber=PC61
app.get('/api/related-products', async (req, res) => {
    const { styleNumber } = req.query;
    if (!styleNumber) {
        return res.status(400).json({ error: 'Missing required query parameter: styleNumber' });
    }
    
    try {
        // First, get the category and subcategory of the reference product
        console.log(`Finding related products for style: ${styleNumber}`);
        const resource = '/tables/Sanmar_Bulk_251816_Feb2024/records';
        
        // Get the reference product details
        const referenceParams = {
            'q.where': `STYLE='${styleNumber}'`,
            'q.select': 'CATEGORY_NAME, SUBCATEGORY_NAME, BRAND_NAME',
            'q.limit': 1
        };
        
        const referenceResult = await fetchAllCaspioPages(resource, referenceParams);
        
        if (referenceResult.length === 0) {
            return res.status(404).json({ error: `Product not found: ${styleNumber}` });
        }
        
        const referenceProduct = referenceResult[0];
        const category = referenceProduct.CATEGORY_NAME;
        const subcategory = referenceProduct.SUBCATEGORY_NAME;
        const brand = referenceProduct.BRAND_NAME;
        
        console.log(`Finding products related to ${styleNumber} (Category: ${category}, Subcategory: ${subcategory}, Brand: ${brand})`);
        
        // Find products in the same category/subcategory but exclude the reference product
        const relatedParams = {
            'q.where': `STYLE<>'${styleNumber}' AND (CATEGORY_NAME='${category}' OR SUBCATEGORY_NAME='${subcategory}' OR BRAND_NAME='${brand}')`,
            'q.select': 'STYLE, PRODUCT_TITLE, COLOR_NAME, FRONT_FLAT, BRAND_NAME, BRAND_LOGO_IMAGE, CATEGORY_NAME, SUBCATEGORY_NAME',
            'q.orderby': 'STYLE ASC',
            'q.limit': 50 // Limit to a reasonable number of related products
        };
        
        const relatedResult = await fetchAllCaspioPages(resource, relatedParams);
        console.log(`Found ${relatedResult.length} total related records`);
        
        // Deduplicate by STYLE to get unique products
        const uniqueProducts = [];
        const seenStyles = new Set();
        
        for (const product of relatedResult) {
            if (!seenStyles.has(product.STYLE)) {
                seenStyles.add(product.STYLE);
                uniqueProducts.push(product);
            }
        }
        
        console.log(`Returning ${uniqueProducts.length} unique related products for style: ${styleNumber}`);
        res.json(uniqueProducts);
    } catch (error) {
        console.error("Related products error:", error.message);
        res.status(500).json({ error: 'Failed to fetch related products.' });
    }
});

// --- NEW Endpoint: Advanced Filtering ---
// Example: /api/filter-products?category=T-Shirts&color=Red&minPrice=10&maxPrice=30&brand=Bella
app.get('/api/filter-products', async (req, res) => {
    const { category, subcategory, color, brand, minPrice, maxPrice } = req.query;
    
    // At least one filter must be provided
    if (!category && !subcategory && !color && !brand && !minPrice && !maxPrice) {
        return res.status(400).json({ error: 'At least one filter parameter must be provided' });
    }
    
    try {
        console.log(`Filtering products with criteria: ${JSON.stringify(req.query)}`);
        const resource = '/tables/Sanmar_Bulk_251816_Feb2024/records';
        
        // Build the where clause based on provided filters
        let whereClause = [];
        
        if (category) {
            whereClause.push(`CATEGORY_NAME='${category}'`);
        }
        
        if (subcategory) {
            whereClause.push(`SUBCATEGORY_NAME='${subcategory}'`);
        }
        
        if (color) {
            whereClause.push(`(COLOR_NAME LIKE '%${color}%' OR CATALOG_COLOR LIKE '%${color}%')`);
        }
        
        if (brand) {
            whereClause.push(`BRAND_NAME LIKE '%${brand}%'`);
        }
        
        if (minPrice && !isNaN(minPrice)) {
            whereClause.push(`CASE_PRICE >= ${minPrice}`);
        }
        
        if (maxPrice && !isNaN(maxPrice)) {
            whereClause.push(`CASE_PRICE <= ${maxPrice}`);
        }
        
        const params = {
            'q.where': whereClause.join(' AND '),
            'q.select': 'STYLE, PRODUCT_TITLE, COLOR_NAME, FRONT_FLAT, BRAND_NAME, BRAND_LOGO_IMAGE, CATEGORY_NAME, SUBCATEGORY_NAME, CASE_PRICE',
            'q.orderby': 'STYLE ASC',
            'q.limit': 10000 // High limit to get comprehensive results
        };
        
        console.log(`Filter query: ${whereClause.join(' AND ')}`);
        const result = await fetchAllCaspioPages(resource, params);
        console.log(`Found ${result.length} total records matching filters`);
        
        // Deduplicate by STYLE to get unique products
        const uniqueProducts = [];
        const seenStyles = new Set();
        
        for (const product of result) {
            if (!seenStyles.has(product.STYLE)) {
                seenStyles.add(product.STYLE);
                uniqueProducts.push(product);
            }
        }
        
        console.log(`Returning ${uniqueProducts.length} unique filtered products`);
        res.json(uniqueProducts);
    } catch (error) {
        console.error("Filter products error:", error.message);
        res.status(500).json({ error: 'Failed to filter products.' });
    }
});

// --- NEW Endpoint: Quick View ---
// Example: /api/quick-view?styleNumber=PC61
app.get('/api/quick-view', async (req, res) => {
    const { styleNumber } = req.query;
    if (!styleNumber) {
        return res.status(400).json({ error: 'Missing required query parameter: styleNumber' });
    }
    
    try {
        console.log(`Fetching quick view data for style: ${styleNumber}`);
        const resource = '/tables/Sanmar_Bulk_251816_Feb2024/records';
        
        const params = {
            'q.where': `STYLE='${styleNumber}'`,
            // Select only essential fields for a lightweight response
            'q.select': 'STYLE, PRODUCT_TITLE, FRONT_FLAT, BRAND_NAME, CATEGORY_NAME, CASE_PRICE',
            'q.limit': 1
        };
        
        const result = await fetchAllCaspioPages(resource, params);
        
        if (result.length === 0) {
            return res.status(404).json({ error: `Product not found: ${styleNumber}` });
        }
        
        // Get the first result as the quick view data
        const quickViewData = result[0];
        
        // Get available colors (just the count)
        const colorParams = {
            'q.where': `STYLE='${styleNumber}'`,
            'q.select': 'COLOR_NAME',
            'q.distinct': true,
            'q.limit': 1000
        };
        
        const colorResults = await fetchAllCaspioPages(resource, colorParams);
        const uniqueColors = [...new Set(colorResults.map(item => item.COLOR_NAME).filter(Boolean))];
        
        // Add color count to the response
        quickViewData.availableColors = uniqueColors.length;
        
        console.log(`Returning quick view data for style: ${styleNumber}`);
        res.json(quickViewData);
    } catch (error) {
        console.error("Quick view error:", error.message);
        res.status(500).json({ error: 'Failed to fetch quick view data.' });
    }
});

// --- NEW Endpoint: Product Comparison ---
// Example: /api/compare-products?styles=PC61,3001C,5000
app.get('/api/compare-products', async (req, res) => {
    const { styles } = req.query;
    if (!styles) {
        return res.status(400).json({ error: 'Missing required query parameter: styles (comma-separated list)' });
    }
    
    try {
        const styleList = styles.split(',').map(s => s.trim());
        if (styleList.length < 2) {
            return res.status(400).json({ error: 'At least 2 styles are required for comparison' });
        }
        
        console.log(`Comparing products: ${styleList.join(', ')}`);
        const resource = '/tables/Sanmar_Bulk_251816_Feb2024/records';
        
        // Create a where clause to match any of the provided styles
        const whereClause = styleList.map(style => `STYLE='${style}'`).join(' OR ');
        
        const params = {
            'q.where': whereClause,
            'q.select': 'STYLE, PRODUCT_TITLE, PRODUCT_DESCRIPTION, FRONT_FLAT, BRAND_NAME, CATEGORY_NAME, SUBCATEGORY_NAME, CASE_PRICE, PRODUCT_STATUS',
            'q.limit': 10000
        };
        
        const result = await fetchAllCaspioPages(resource, params);
        console.log(`Found ${result.length} total records for comparison`);
        
        // Group by style and take the first record for each style
        const comparisonData = {};
        
        for (const product of result) {
            if (!comparisonData[product.STYLE]) {
                comparisonData[product.STYLE] = product;
            }
        }
        
        // Convert to array for the response
        const comparisonArray = Object.values(comparisonData);
        
        console.log(`Returning comparison data for ${comparisonArray.length} products`);
        res.json(comparisonArray);
    } catch (error) {
        console.error("Product comparison error:", error.message);
        res.status(500).json({ error: 'Failed to fetch product comparison data.' });
    }
});

// --- NEW Endpoint: Product Recommendations ---
// Example: /api/recommendations?styleNumber=PC61
app.get('/api/recommendations', async (req, res) => {
    const { styleNumber } = req.query;
    if (!styleNumber) {
        return res.status(400).json({ error: 'Missing required query parameter: styleNumber' });
    }
    
    try {
        // First, get the category and brand of the reference product
        console.log(`Finding recommendations for style: ${styleNumber}`);
        const resource = '/tables/Sanmar_Bulk_251816_Feb2024/records';
        
        // Get the reference product details
        const referenceParams = {
            'q.where': `STYLE='${styleNumber}'`,
            'q.select': 'CATEGORY_NAME, BRAND_NAME, CASE_PRICE',
            'q.limit': 1
        };
        
        const referenceResult = await fetchAllCaspioPages(resource, referenceParams);
        
        if (referenceResult.length === 0) {
            return res.status(404).json({ error: `Product not found: ${styleNumber}` });
        }
        
        const referenceProduct = referenceResult[0];
        const category = referenceProduct.CATEGORY_NAME;
        const brand = referenceProduct.BRAND_NAME;
        const price = referenceProduct.CASE_PRICE || 0;
        
        // Find popular products in the same category or from the same brand
        // but exclude the reference product
        // Also find products in a similar price range (±30%)
        const minPrice = price * 0.7;
        const maxPrice = price * 1.3;
        
        const recommendParams = {
            'q.where': `STYLE<>'${styleNumber}' AND (CATEGORY_NAME='${category}' OR BRAND_NAME='${brand}') AND (CASE_PRICE BETWEEN ${minPrice} AND ${maxPrice} OR CASE_PRICE IS NULL)`,
            'q.select': 'STYLE, PRODUCT_TITLE, COLOR_NAME, FRONT_FLAT, BRAND_NAME, BRAND_LOGO_IMAGE, CATEGORY_NAME, CASE_PRICE',
            'q.orderby': 'STYLE ASC',
            'q.limit': 20 // Limit to a reasonable number of recommendations
        };
        
        const recommendResult = await fetchAllCaspioPages(resource, recommendParams);
        console.log(`Found ${recommendResult.length} total recommendation records`);
        
        // Deduplicate by STYLE to get unique products
        const uniqueProducts = [];
        const seenStyles = new Set();
        
        for (const product of recommendResult) {
            if (!seenStyles.has(product.STYLE)) {
                seenStyles.add(product.STYLE);
                uniqueProducts.push(product);
            }
        }
        
        console.log(`Returning ${uniqueProducts.length} unique product recommendations for style: ${styleNumber}`);
        res.json(uniqueProducts);
    } catch (error) {
        console.error("Recommendations error:", error.message);
        res.status(500).json({ error: 'Failed to fetch product recommendations.' });
    }
});

// --- NEW Endpoint: Get Inventory Table by Style and Color ---
// Example: /api/sizes-by-style-color?styleNumber=PC61&color=Red
app.get('/api/sizes-by-style-color', async (req, res) => {
    const { styleNumber, color } = req.query;
    if (!styleNumber || !color) {
        return res.status(400).json({ error: 'Missing required query parameters: styleNumber, color' });
    }
    try {
        console.log(`Fetching inventory table for style: ${styleNumber}, color: ${color}`);
        const resource = '/tables/Inventory/records';
        const params = {
            'q.where': `catalog_no='${styleNumber}' AND catalog_color='${color}'`,
            'q.select': 'catalog_no, catalog_color, size, SizeSortOrder, WarehouseName, quantity, WarehouseSort',
            'q.orderby': 'WarehouseSort ASC, SizeSortOrder ASC', // Order by warehouse, then size
            'q.limit': 1000 // Set a high limit to ensure we get all sizes and warehouses
        };
        
        // Use fetchAllCaspioPages to handle pagination
        const result = await fetchAllCaspioPages(resource, params);
        
        if (result.length === 0) {
            console.warn(`No inventory found for style: ${styleNumber} and color: ${color}`);
            return res.status(404).json({ error: `No inventory found for style: ${styleNumber} and color: ${color}` });
        }
        
        // Extract unique sizes and warehouses
        const sizesSet = new Set();
        const warehousesSet = new Set();
        
        result.forEach(item => {
            if (item.size) sizesSet.add(item.size);
            if (item.WarehouseName) warehousesSet.add(item.WarehouseName);
        });
        
        // Get size sort order mapping
        const sizeSortMap = {};
        result.forEach(item => {
            if (item.size && item.SizeSortOrder) {
                sizeSortMap[item.size] = item.SizeSortOrder;
            }
        });
        
        // Sort sizes by SizeSortOrder
        const sizes = Array.from(sizesSet).sort((a, b) => {
            return (sizeSortMap[a] || 0) - (sizeSortMap[b] || 0);
        });
        
        // Get warehouse sort order mapping
        const warehouseSortMap = {};
        result.forEach(item => {
            if (item.WarehouseName && item.WarehouseSort) {
                warehouseSortMap[item.WarehouseName] = item.WarehouseSort;
            }
        });
        
        // Sort warehouses by WarehouseSort
        const warehouses = Array.from(warehousesSet).sort((a, b) => {
            return (warehouseSortMap[a] || 0) - (warehouseSortMap[b] || 0);
        });
        
        // Create inventory matrix
        const inventoryMatrix = {};
        const sizeTotals = {};
        
        // Initialize the matrix with zeros and size totals
        warehouses.forEach(warehouse => {
            inventoryMatrix[warehouse] = {};
            sizes.forEach(size => {
                inventoryMatrix[warehouse][size] = 0;
                if (!sizeTotals[size]) sizeTotals[size] = 0;
            });
        });
        
        // Fill in the inventory quantities
        result.forEach(item => {
            if (item.WarehouseName && item.size && item.quantity !== null) {
                inventoryMatrix[item.WarehouseName][item.size] = item.quantity;
                sizeTotals[item.size] += item.quantity;
            }
        });
        
        // Calculate warehouse totals
        const warehouseTotals = {};
        warehouses.forEach(warehouse => {
            warehouseTotals[warehouse] = sizes.reduce((total, size) => {
                return total + (inventoryMatrix[warehouse][size] || 0);
            }, 0);
        });
        
        // Calculate grand total
        const grandTotal = sizes.reduce((total, size) => {
            return total + (sizeTotals[size] || 0);
        }, 0);
        
        // Format the response for a tabular display
        const response = {
            style: styleNumber,
            color: color,
            sizes: sizes,
            warehouses: warehouses.map(warehouse => ({
                name: warehouse,
                inventory: sizes.map(size => inventoryMatrix[warehouse][size]),
                total: warehouseTotals[warehouse]
            })),
            sizeTotals: sizes.map(size => sizeTotals[size]),
            grandTotal: grandTotal
        };
        
        console.log(`Returning inventory table with ${warehouses.length} warehouses and ${sizes.length} sizes for style: ${styleNumber}, color: ${color}`);
        res.json(response);
    } catch (error) {
        console.error("Error fetching sizes:", error.message);
        res.status(500).json({ error: 'Failed to fetch sizes for the specified style and color.' });
    }
});

// --- NEW Endpoint: Get Prices by Style and Color with Ordered Sizes ---
// Example: /api/prices-by-style-color?styleNumber=PC61&color=White
app.get('/api/prices-by-style-color', async (req, res) => {
    const { styleNumber, color } = req.query;
    if (!styleNumber || !color) {
        return res.status(400).json({ error: 'Missing required query parameters: styleNumber, color' });
    }
    try {
        console.log(`Fetching prices for style: ${styleNumber}, color: ${color}`);
        const resource = '/tables/Inventory/records';
        const params = {
            'q.where': `catalog_no='${styleNumber}' AND catalog_color='${color}'`,
            'q.select': 'size, case_price, SizeSortOrder',
            'q.limit': 1000 // Set a high limit to ensure we get all sizes
        };
        
        // Use fetchAllCaspioPages to handle pagination
        const result = await fetchAllCaspioPages(resource, params);
        
        if (result.length === 0) {
            console.warn(`No inventory found for style: ${styleNumber} and color: ${color}`);
            return res.status(404).json({ error: `No inventory found for style: ${styleNumber} and color: ${color}` });
        }
        
        // Process results to get prices per size and sort orders
        const prices = {};
        const sortOrders = {};
        
        result.forEach(item => {
            if (item.size && item.case_price !== null && !isNaN(item.case_price)) {
                const size = item.size;
                const price = parseFloat(item.case_price);
                const sortOrder = item.SizeSortOrder || 999; // Default high value if missing
                
                // Store the price for each size
                if (!prices[size] || price > prices[size]) {
                    prices[size] = price;
                }
                
                // Store the sort order for each size
                if (!sortOrders[size] || sortOrder < sortOrders[size]) {
                    sortOrders[size] = sortOrder;
                }
            }
        });
        
        // Create an array of sizes sorted by SizeSortOrder
        const sortedSizes = Object.keys(prices).sort((a, b) => {
            return (sortOrders[a] || 999) - (sortOrders[b] || 999);
        });
        
        // Create the response with ordered sizes and prices
        const response = {
            style: styleNumber,
            color: color,
            sizes: sortedSizes.map(size => ({
                size: size,
                price: prices[size],
                sortOrder: sortOrders[size]
            }))
        };
        
        console.log(`Returning prices for ${sortedSizes.length} sizes for style: ${styleNumber}, color: ${color}`);
        res.json(response);
    } catch (error) {
        console.error("Error fetching prices:", error.message);
        res.status(500).json({ error: 'Failed to fetch prices for the specified style and color.' });
    }
});

// --- NEW Endpoint: Get Unique Sizes by Style and Color ---
// Example: /api/product-variant-sizes?styleNumber=PC61&color=Aquatic%20Blue
// Fetches STYLE, COLOR_NAME, CATALOG_COLOR from Sanmar_Bulk and SIZES (sorted) from Inventory.
app.get('/api/product-variant-sizes', async (req, res) => {
    const { styleNumber, color, colorName, catalogColor } = req.query;
    const actualColorParam = color || colorName || catalogColor;

    if (!styleNumber || !actualColorParam) {
        return res.status(400).json({ error: 'Missing required query parameters: styleNumber and one of (color, colorName, catalogColor)' });
    }

    try {
        console.log(`Fetching product variant info for style: ${styleNumber}, color: ${actualColorParam}`);

        // 1. Fetch Style/Color display info from Sanmar_Bulk_251816_Feb2024
        const sanmarBulkResource = '/tables/Sanmar_Bulk_251816_Feb2024/records';
        const sanmarBulkParams = {
            'q.where': `STYLE='${styleNumber}' AND (CATALOG_COLOR='${actualColorParam}' OR COLOR_NAME='${actualColorParam}')`,
            'q.select': 'STYLE, COLOR_NAME, CATALOG_COLOR',
            'q.limit': 1
        };

        const sanmarBulkResults = await fetchAllCaspioPages(sanmarBulkResource, sanmarBulkParams);

        if (!sanmarBulkResults || sanmarBulkResults.length === 0) {
            console.warn(`No product info found in Sanmar_Bulk for style: ${styleNumber}, color: ${actualColorParam}`);
            return res.status(404).json({
                error: `Product information not found for style: ${styleNumber} and color: ${actualColorParam} in Sanmar_Bulk table.`,
                STYLE: styleNumber,
                COLOR_NAME: actualColorParam, // Fallback to requested color
                CATALOG_COLOR: actualColorParam, // Fallback to requested color
                SIZES: []
            });
        }

        const displayStyle = sanmarBulkResults[0].STYLE;
        const displayColorName = sanmarBulkResults[0].COLOR_NAME;
        const displayCatalogColor = sanmarBulkResults[0].CATALOG_COLOR;

        // 2. Fetch Sizes and SizeSortOrder from Inventory
        const inventoryResource = '/tables/Inventory/records';
        const inventoryParams = {
            'q.where': `catalog_no='${styleNumber}' AND catalog_color='${actualColorParam}'`, // Match Inventory table's color field
            'q.select': 'size, SizeSortOrder',
            'q.orderby': 'SizeSortOrder ASC', // Order by size sort order
            'q.limit': 1000 // High limit to get all relevant records for the style/color
        };

        const inventoryResults = await fetchAllCaspioPages(inventoryResource, inventoryParams);

        let sortedSizes = [];
        if (inventoryResults.length > 0) {
            const uniqueSizes = new Set();
            const sizeSortOrders = {};

            inventoryResults.forEach(item => {
                if (item.size) {
                    uniqueSizes.add(item.size);
                    if (!sizeSortOrders[item.size] || item.SizeSortOrder < sizeSortOrders[item.size]) {
                        sizeSortOrders[item.size] = item.SizeSortOrder || 999;
                    }
                }
            });

            sortedSizes = Array.from(uniqueSizes).sort((a, b) => {
                return (sizeSortOrders[a] || 999) - (sizeSortOrders[b] || 999);
            });
        } else {
            console.warn(`No sizes found in Inventory for style: ${styleNumber}, color: ${actualColorParam}`);
        }
        
        const responsePayload = {
            STYLE: displayStyle,
            COLOR_NAME: displayColorName,
            CATALOG_COLOR: displayCatalogColor,
            SIZES: sortedSizes
        };

        console.log(`Returning ${sortedSizes.length} unique sizes for style: ${displayStyle}, color: ${displayColorName}`);
        res.json(responsePayload);

    } catch (error) {
        console.error(`Error fetching product variant sizes for style ${styleNumber}, color ${actualColorParam}:`, error.message, error.stack);
        res.status(500).json({ error: `Failed to fetch product variant sizes. ${error.message}` });
    }
});

// --- MODIFIED Endpoint: /api/max-prices-by-style ---
// Provides raw garment costs (max across colors for a style/size)
// and separate sellingPriceDisplayAddOns from Standard_Size_Upcharges table.
app.get('/api/max-prices-by-style', async (req, res) => {
    const { styleNumber } = req.query;
    if (!styleNumber) {
        return res.status(400).json({ error: 'Missing required query parameter: styleNumber' });
    }
    try {
        console.log(`Fetching data for /api/max-prices-by-style for style: ${styleNumber}`);

        // 1. Fetch Selling Price Display Add-Ons from Caspio
        let sellingPriceDisplayAddOns = {};
        try {
            const upchargeResourcePath = '/tables/Standard_Size_Upcharges/records';
            const upchargeParams = {
                'q.select': 'SizeDesignation,StandardAddOnAmount',
                'q.orderby': 'SizeDesignation ASC',
                'q.limit': 200
            };
            const upchargeResults = await fetchAllCaspioPages(upchargeResourcePath, upchargeParams);
            upchargeResults.forEach(rule => {
                if (rule.SizeDesignation && rule.StandardAddOnAmount !== null && !isNaN(parseFloat(rule.StandardAddOnAmount))) {
                    sellingPriceDisplayAddOns[String(rule.SizeDesignation).trim().toUpperCase()] = parseFloat(rule.StandardAddOnAmount);
                }
            });
            console.log("Fetched Selling Price Display Add-Ons for /max-prices-by-style:", sellingPriceDisplayAddOns);
            if (Object.keys(sellingPriceDisplayAddOns).length === 0) {
                console.warn(`No Selling Price Display Add-On rules found from Caspio for /max-prices-by-style.`);
            }
        } catch (upchargeError) {
            console.error("CRITICAL ERROR fetching Selling Price Display Add-Ons for /max-prices-by-style:", upchargeError.message);
            sellingPriceDisplayAddOns = {};
        }

        // 2. Fetch Inventory Data to get base garment costs (max case price per size/style)
        const inventoryResource = '/tables/Inventory/records';
        // Fetches all colors for the style to determine max price per size.
        // The PC61 'Ash' special case is removed here for simplicity, assuming this endpoint should always get max across all colors.
        // If PC61 'Ash' logic is vital here, it can be added back to the whereClause.
        const inventoryWhereClause = `catalog_no='${styleNumber}'`;
        const inventoryParams = {
            'q.where': inventoryWhereClause,
            'q.select': 'size,case_price,SizeSortOrder',
            'q.limit': 1000
        };
        const inventoryResult = await fetchAllCaspioPages(inventoryResource, inventoryParams, { maxPages: 20 }); // Ensure maxPages is sufficient

        if (inventoryResult.length === 0) {
            console.warn(`No inventory found for style: ${styleNumber} in /max-prices-by-style with where: ${inventoryWhereClause}.`);
            return res.json({
                style: styleNumber, sizes: [], sellingPriceDisplayAddOns: sellingPriceDisplayAddOns,
                message: `No inventory records found for style ${styleNumber} with where: ${inventoryWhereClause}`
            });
        }

        const garmentCosts = {}; const sortOrders = {};
        inventoryResult.forEach(item => {
            if (item.size && item.case_price !== null && !isNaN(parseFloat(item.case_price))) {
                const size = String(item.size).trim().toUpperCase();
                const price = parseFloat(item.case_price);
                const sortOrder = parseInt(item.SizeSortOrder, 10) || 999;
                if (!garmentCosts[size] || price > garmentCosts[size]) { garmentCosts[size] = price; }
                if (!sortOrders[size] || sortOrder < sortOrders[size]) { sortOrders[size] = sortOrder; }
            }
        });
        
        if (Object.keys(garmentCosts).length === 0) {
             console.warn(`No valid garment costs derived for style: ${styleNumber} from inventory for /max-prices-by-style.`);
             return res.json({ style: styleNumber, sizes: [], sellingPriceDisplayAddOns: sellingPriceDisplayAddOns, message: `No valid garment costs for style ${styleNumber}.`});
        }

        const sortedSizeKeys = Object.keys(garmentCosts).sort((a, b) => (sortOrders[a] || 999) - (sortOrders[b] || 999));

        // Construct the response
        const responsePayload = {
            style: styleNumber,
            sizes: sortedSizeKeys.map(size => ({
                size: size,
                price: garmentCosts[size],
                sortOrder: sortOrders[size]
            })),
            sellingPriceDisplayAddOns: sellingPriceDisplayAddOns
        };
        console.log(`Returning data for /api/max-prices-by-style, style: ${styleNumber}, sizes found: ${sortedSizeKeys.length}`);
        res.json(responsePayload);

    } catch (error) {
        console.error(`Error in /api/max-prices-by-style for ${styleNumber}:`, error.message, error.stack);
        res.status(500).json({ error: `Failed to fetch data for style ${styleNumber}. ${error.message}` });
    }
});

// --- Modular Routes Disabled ---
// Removed duplicate modular routes to prevent conflicts
// All routes are now handled inline in this file

// --- Error Handling Middleware (Basic) ---
// Catches errors from endpoint handlers
app.use((err, req, res, next) => {
    console.error("Unhandled Error:", err.stack || err);
    res.status(500).json({ error: 'An unexpected internal server error occurred.' });
});

// --- MODIFIED Endpoint: /api/size-pricing ---
// Fetches ALL sizes from Inventory and includes sellingPriceDisplayAddOns.
app.get('/api/size-pricing', async (req, res) => {
    const { styleNumber, color } = req.query;
    if (!styleNumber) {
        return res.status(400).json({ error: 'Missing required query parameter: styleNumber' });
    }
    
    try {
        console.log(`Fetching data for /api/size-pricing: Style=${styleNumber}, Color=${color || 'ALL (max price per size if no color specified)'}`);

        // 1. Fetch Selling Price Display Add-Ons from Caspio
        let sellingPriceDisplayAddOns = {};
        try {
            const upchargeResourcePath = '/tables/Standard_Size_Upcharges/records';
            const upchargeParams = {
                'q.select': 'SizeDesignation,StandardAddOnAmount',
                'q.orderby': 'SizeDesignation ASC',
                'q.limit': 200
            };
            const upchargeResults = await fetchAllCaspioPages(upchargeResourcePath, upchargeParams);
            upchargeResults.forEach(rule => {
                if (rule.SizeDesignation && rule.StandardAddOnAmount !== null && !isNaN(parseFloat(rule.StandardAddOnAmount))) {
                    sellingPriceDisplayAddOns[String(rule.SizeDesignation).trim().toUpperCase()] = parseFloat(rule.StandardAddOnAmount);
                }
            });
            console.log("Fetched Selling Price Display Add-Ons for /api/size-pricing:", sellingPriceDisplayAddOns);
            if (Object.keys(sellingPriceDisplayAddOns).length === 0) {
                console.warn(`No Selling Price Display Add-On rules found for /api/size-pricing.`);
            }
        } catch (upchargeError) {
            console.error("CRITICAL ERROR fetching Selling Price Display Add-Ons for /api/size-pricing:", upchargeError.message);
            sellingPriceDisplayAddOns = {};
        }

        // 2. Fetch Inventory Data
        const inventoryResource = '/tables/Inventory/records';
        let inventoryWhereClause = `catalog_no='${styleNumber}'`;
        if (color) {
            inventoryWhereClause += ` AND catalog_color='${String(color).trim()}'`;
        }
        
        const inventoryParams = {
            'q.where': inventoryWhereClause,
            'q.select': 'size, case_price, SizeSortOrder, catalog_color',
            'q.limit': 1000
        };
        
        console.log(`Fetching ALL inventory pages for style ${styleNumber} (color filter: ${color || 'none'}) with params: ${JSON.stringify(inventoryParams)}`);
        
        // Create a custom callback to track progress and detect when we have all sizes
        const pageCallback = (pageNum, pageData) => {
            console.log(`Inventory fetch - Page ${pageNum}: ${pageData.length} records`);
            return pageData;
        };
        
        // Create an early exit condition to stop when we've likely found all sizes for this style
        const earlyExitCondition = (allResults) => {
            // Extract unique sizes from current results
            const uniqueSizes = new Set();
            allResults.forEach(item => {
                if (item.size) uniqueSizes.add(item.size.trim().toUpperCase());
            });
            
            // Check if we have the expected large sizes (5XL, 6XL) - if so, we probably have everything
            const hasLargeSizes = uniqueSizes.has('5XL') && uniqueSizes.has('6XL');
            const sizeCount = uniqueSizes.size;
            
            // Log current progress
            console.log(`Current unique sizes found: ${Array.from(uniqueSizes).sort()}`);
            console.log(`Size count: ${sizeCount}, Has large sizes (5XL, 6XL): ${hasLargeSizes}`);
            
            // Exit early if we have a reasonable number of sizes AND the large sizes
            // This prevents unnecessary API calls while ensuring completeness
            if (sizeCount >= 7 && hasLargeSizes) {
                console.log(`Early exit: Found ${sizeCount} sizes including large sizes (5XL, 6XL)`);
                return true;
            }
            
            return false;
        };
        
        // Fetch ALL pages from Inventory with significantly increased maxPages and smart early exit
        const inventoryResult = await fetchAllCaspioPages(inventoryResource, inventoryParams, {
            maxPages: 100, // Dramatically increased from 20 to 100 to ensure we get all records
            pageCallback: pageCallback,
            earlyExitCondition: earlyExitCondition
        });

        if (inventoryResult.length === 0) {
            console.warn(`No inventory found for style: ${styleNumber} with criteria: ${inventoryWhereClause} in /api/size-pricing`);
            return res.json({
                style: styleNumber, color: color || 'all (no inventory found)', baseSizePrice: null,
                sizes: [], sellingPriceDisplayAddOns: sellingPriceDisplayAddOns,
                message: `No inventory records found for style ${styleNumber} with where: ${inventoryWhereClause}`
            });
        }

        // Log detailed information about what we found
        const uniqueSizesFound = new Set();
        inventoryResult.forEach(item => {
            if (item.size) uniqueSizesFound.add(item.size.trim().toUpperCase());
        });
        console.log(`Total inventory records fetched: ${inventoryResult.length}`);
        console.log(`Unique sizes found: ${Array.from(uniqueSizesFound).sort()}`);
        console.log(`Size count: ${uniqueSizesFound.size}`);

        const garmentCosts = {};
        const sortOrders = {};
        let processedColor = color ? String(color).trim() : null;

        inventoryResult.forEach(item => {
            if (item.size && item.case_price !== null && !isNaN(parseFloat(item.case_price))) {
                const sizeKey = String(item.size).trim().toUpperCase();
                const price = parseFloat(item.case_price);
                const itemColor = String(item.catalog_color || '').trim();
                const sortOrder = parseInt(item.SizeSortOrder, 10) || 999;

                if (color) {
                     if (itemColor.toUpperCase() === color.trim().toUpperCase()) {
                         if (!garmentCosts[sizeKey] || price > garmentCosts[sizeKey]) {
                             garmentCosts[sizeKey] = price;
                         }
                     }
                } else {
                    if (!garmentCosts[sizeKey] || price > garmentCosts[sizeKey]) {
                        garmentCosts[sizeKey] = price;
                    }
                    if (!processedColor && inventoryResult.length > 0) {
                        const firstColorInResults = inventoryResult[0]?.catalog_color;
                        processedColor = firstColorInResults ? String(firstColorInResults).trim() : "all colors (aggregated)";
                    } else if (!processedColor) {
                        processedColor = "all colors (aggregated)";
                    }
                }
                
                if (!sortOrders[sizeKey] || sortOrder < sortOrders[sizeKey]) {
                    sortOrders[sizeKey] = sortOrder;
                }
            }
        });
        
        if (Object.keys(garmentCosts).length === 0) {
             console.warn(`No valid garment costs derived for style: ${styleNumber} (color: ${color || 'any'}) from inventory for /api/size-pricing.`);
             return res.json({
                style: styleNumber, color: color || 'all (no costs derived)', baseSizePrice: null,
                sizes: [], sellingPriceDisplayAddOns: sellingPriceDisplayAddOns,
                message: `No valid garment costs could be derived for style ${styleNumber} (color: ${color || 'any'}).`
            });
        }
        
        let baseSizePrice = null;
        const preferredBaseSizes = ['XL', 'L', 'M', 'S'];
        for (const bSize of preferredBaseSizes) {
            if (garmentCosts[bSize] !== undefined) {
                baseSizePrice = garmentCosts[bSize];
                break;
            }
        }
        if (baseSizePrice === null && Object.keys(garmentCosts).length > 0) {
            const firstSortedSize = Object.keys(garmentCosts).sort((a,b) => (sortOrders[a]||999) - (sortOrders[b]||999))[0];
            if(firstSortedSize) baseSizePrice = garmentCosts[firstSortedSize];
        }
        
        const sortedSizeKeys = Object.keys(garmentCosts).sort((a, b) => (sortOrders[a] || 999) - (sortOrders[b] || 999));
        
        const responsePayload = {
            style: styleNumber,
            color: processedColor || (color ? String(color).trim() : 'all colors (aggregated)'),
            baseSizePrice: baseSizePrice,
            sizes: sortedSizeKeys.map(sizeKey => ({
                size: sizeKey,
                price: garmentCosts[sizeKey],
                sortOrder: sortOrders[sizeKey]
            })),
            sellingPriceDisplayAddOns: sellingPriceDisplayAddOns,
            // Add debugging information to help track pagination completeness
            debug: {
                totalInventoryRecords: inventoryResult.length,
                uniqueSizesFound: uniqueSizesFound.size,
                allSizesFound: Array.from(uniqueSizesFound).sort()
            }
        };
        
        console.log(`Returning data for /api/size-pricing, style: ${styleNumber}, sizes found: ${sortedSizeKeys.length}`);
        console.log(`Debug info - Total records: ${inventoryResult.length}, Unique sizes: ${uniqueSizesFound.size}`);
        res.json(responsePayload);
        
    } catch (error) {
        console.error(`Error in /api/size-pricing for ${styleNumber} (color: ${color || 'any'}):`, error.message, error.stack);
        res.status(500).json({ error: `Failed to fetch size pricing for style ${styleNumber}. ${error.message}` });
    }
});

// --- NEW Endpoint: Customer Information CRUD Operations ---
// MOVED TO src/routes/orders.js
/*
// GET: /api/customers - Get all customers or filter by query parameters
// POST: /api/customers - Create a new customer
// PUT: /api/customers/:id - Update a customer by ID
// DELETE: /api/customers/:id - Delete a customer by ID
app.get('/api/customers', async (req, res) => {
    try {
        console.log("Fetching customer information");
        const resource = '/tables/Customer_Info/records';
        
        // Build query parameters based on request query
        const params = {};
        
        // Add any filter parameters from the request
        if (Object.keys(req.query).length > 0) {
            const whereConditions = [];
            
            // Handle common filter fields
            if (req.query.name) {
                whereConditions.push(`Name LIKE '%${req.query.name}%'`);
            }
            if (req.query.email) {
                whereConditions.push(`Email='${req.query.email}'`);
            }
            if (req.query.company) {
                whereConditions.push(`Company LIKE '%${req.query.company}%'`);
            }
            if (req.query.customerID) {
                whereConditions.push(`CustomerID=${req.query.customerID}`);
            }
            
            // Add the WHERE clause if we have conditions
            if (whereConditions.length > 0) {
                params['q.where'] = whereConditions.join(' AND ');
            }
        }
        
        // Set ordering and limit
        params['q.orderby'] = 'CustomerID ASC';
        params['q.limit'] = 1000;
        
        // Use fetchAllCaspioPages to handle pagination
        const result = await fetchAllCaspioPages(resource, params);
        console.log(`Found ${result.length} customer records`);
        
        res.json(result);
    } catch (error) {
        console.error("Error fetching customer information:", error.message);
        res.status(500).json({ error: 'Failed to fetch customer information.' });
    }
});

// Create a new customer
app.post('/api/customers', express.json(), async (req, res) => {
    try {
        // Create a copy of the request body to avoid modifying the original
        const customerData = { ...req.body };
        
        // Check if Name is missing but FirstName and LastName are provided
        if (!customerData.Name && customerData.FirstName && customerData.LastName) {
            customerData.Name = `${customerData.FirstName} ${customerData.LastName}`;
            console.log(`Added Name field from FirstName and LastName: ${customerData.Name}`);
        }
        
        // Validate required fields
        const requiredFields = ['Name', 'Email'];
        for (const field of requiredFields) {
            if (!customerData[field]) {
                return res.status(400).json({ error: `Missing required field: ${field}` });
            }
        }
        
        console.log(`Creating new customer: ${customerData.Name}`);
        const resource = '/tables/Customer_Info/records';
        
        // Get token for the request
        const token = await getCaspioAccessToken();
        const url = `${caspioApiBaseUrl}${resource}`;
        
        // Prepare the request
        const requestConfig = {
            method: 'post',
            url: url,
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json'
            },
            data: customerData,
            timeout: 15000
        };
        
        // Make the request directly using axios
        const response = await axios(requestConfig);
        
        console.log(`Customer created successfully: ${response.status}`);
        res.status(201).json({
            message: 'Customer created successfully',
            customer: response.data
        });
    } catch (error) {
        console.error("Error creating customer:", error.response ? JSON.stringify(error.response.data) : error.message);
        res.status(500).json({ error: 'Failed to create customer.' });
    }
});

// Update a customer by ID
app.put('/api/customers/:id', express.json(), async (req, res) => {
    const { id } = req.params;
    if (!id) {
        return res.status(400).json({ error: 'Missing required parameter: id' });
    }
    
    try {
        console.log(`Updating customer with ID: ${id}`);
        const resource = `/tables/Customer_Info/records?q.where=PK_ID=${id}`;
        
        // Get token for the request
        const token = await getCaspioAccessToken();
        const url = `${caspioApiBaseUrl}${resource}`;
        
        // Prepare the request
        const requestConfig = {
            method: 'put',
            url: url,
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json'
            },
            data: req.body,
            timeout: 15000
        };
        
        // Make the request directly using axios
        const response = await axios(requestConfig);
        
        console.log(`Customer updated successfully: ${response.status}`);
        res.json({
            message: 'Customer updated successfully',
            customer: response.data
        });
    } catch (error) {
        console.error("Error updating customer:", error.response ? JSON.stringify(error.response.data) : error.message);
        res.status(500).json({ error: 'Failed to update customer.' });
    }
});

// Delete a customer by ID
app.delete('/api/customers/:id', async (req, res) => {
    const { id } = req.params;
    if (!id) {
        return res.status(400).json({ error: 'Missing required parameter: id' });
    }
    
    try {
        console.log(`Deleting customer with ID: ${id}`);
        const resource = `/tables/Customer_Info/records?q.where=PK_ID=${id}`;
        
        // Get token for the request
        const token = await getCaspioAccessToken();
        const url = `${caspioApiBaseUrl}${resource}`;
        
        // Prepare the request
        const requestConfig = {
            method: 'delete',
            url: url,
            headers: {
                'Authorization': `Bearer ${token}`
            },
            timeout: 15000
        };
        
        // Make the request directly using axios
        const response = await axios(requestConfig);
        
        console.log(`Customer deleted successfully: ${response.status}`);
        res.json({ message: 'Customer deleted successfully' });
    } catch (error) {
        console.error("Error deleting customer:", error.response ? JSON.stringify(error.response.data) : error.message);
        res.status(500).json({ error: 'Failed to delete customer.' });
    }
});
*/

// --- NEW Endpoint: Art Requests ---
// GET: /api/artrequests - Get all art requests or filter by query parameters
app.get('/api/artrequests', async (req, res) => {
    try {
        console.log("Fetching art requests information");
        const resource = '/tables/ArtRequests/records';
        
        // Build query parameters based on request query
        const params = {};
        
        // Handle filter parameters from the request
        if (Object.keys(req.query).length > 0) {
            const whereConditions = [];
            
            // Handle common filter fields based on the ArtRequests table structure
            if (req.query.pk_id) {
                whereConditions.push(`PK_ID=${req.query.pk_id}`);
            }
            if (req.query.status) {
                whereConditions.push(`Status='${req.query.status}'`);
            }
            if (req.query.id_design) {
                whereConditions.push(`ID_Design=${req.query.id_design}`);
            }
            if (req.query.companyName) {
                whereConditions.push(`CompanyName LIKE '%${req.query.companyName}%'`);
            }
            if (req.query.customerServiceRep) {
                whereConditions.push(`CustomerServiceRep='${req.query.customerServiceRep}'`);
            }
            if (req.query.priority) {
                whereConditions.push(`Priority='${req.query.priority}'`);
            }
            if (req.query.mockup) {
                whereConditions.push(`Mockup=${req.query.mockup}`);
            }
            if (req.query.orderType) {
                whereConditions.push(`Order_Type='${req.query.orderType}'`);
            }
            if (req.query.customerType) {
                whereConditions.push(`CustomerType='${req.query.customerType}'`);
            }
            if (req.query.happyStatus) {
                whereConditions.push(`Happy_Status='${req.query.happyStatus}'`);
            }
            if (req.query.salesRep) {
                whereConditions.push(`Sales_Rep='${req.query.salesRep}'`);
            }
            if (req.query.id_customer) {
                whereConditions.push(`id_customer=${req.query.id_customer}`);
            }
            if (req.query.id_contact) {
                whereConditions.push(`id_contact=${req.query.id_contact}`);
            }
            
            // Date range filters
            if (req.query.dateCreatedFrom) {
                whereConditions.push(`Date_Created>='${req.query.dateCreatedFrom}'`);
            }
            if (req.query.dateCreatedTo) {
                whereConditions.push(`Date_Created<='${req.query.dateCreatedTo}'`);
            }
            if (req.query.dueDateFrom) {
                whereConditions.push(`Due_Date>='${req.query.dueDateFrom}'`);
            }
            if (req.query.dueDateTo) {
                whereConditions.push(`Due_Date<='${req.query.dueDateTo}'`);
            }
            
            // Add the WHERE clause if we have conditions
            if (whereConditions.length > 0) {
                params['q.where'] = whereConditions.join(' AND ');
            }
        }
        
        // Handle select parameter for specific fields
        if (req.query.select) {
            params['q.select'] = req.query.select;
        }
        
        // Handle orderBy parameter
        if (req.query.orderBy) {
            params['q.orderBy'] = req.query.orderBy;
        } else {
            // Default ordering by most recent first
            params['q.orderBy'] = 'Date_Created DESC';
        }
        
        // Handle groupBy parameter
        if (req.query.groupBy) {
            params['q.groupBy'] = req.query.groupBy;
        }
        
        // Handle pagination parameters
        if (req.query.pageNumber && req.query.pageSize) {
            params['q.pageNumber'] = req.query.pageNumber;
            params['q.pageSize'] = req.query.pageSize;
        } else if (req.query.limit) {
            params['q.limit'] = Math.min(parseInt(req.query.limit) || 100, 1000);
        } else {
            params['q.limit'] = 100; // Default limit
        }
        
        console.log(`Fetching art requests with params: ${JSON.stringify(params)}`);
        const artRequests = await fetchAllCaspioPages(resource, params);
        
        console.log(`Found ${artRequests.length} art request records`);
        res.json(artRequests);
    } catch (error) {
        console.error("Error in /api/artrequests:", error);
        res.status(500).json({ error: 'Failed to fetch art requests' });
    }
});

// Get a specific art request by ID
app.get('/api/artrequests/:id', async (req, res) => {
    const { id } = req.params;
    if (!id) {
        return res.status(400).json({ error: 'Missing required parameter: id' });
    }
    
    try {
        console.log(`Fetching art request with ID: ${id}`);
        const resource = `/tables/ArtRequests/records?q.where=PK_ID=${id}`;
        
        const result = await makeCaspioRequest('get', resource);
        
        if (result && result.length > 0) {
            res.json(result[0]);
        } else {
            res.status(404).json({ error: 'Art request not found.' });
        }
    } catch (error) {
        console.error("Error fetching art request:", error.message);
        res.status(500).json({ error: 'Failed to fetch art request.' });
    }
});

// Create a new art request
app.post('/api/artrequests', express.json(), async (req, res) => {
    try {
        const requestData = req.body;
        
        console.log(`Creating new art request`);
        const resource = '/tables/ArtRequests/records';
        
        // Get token for the request
        const token = await getCaspioAccessToken();
        const url = `${caspioApiBaseUrl}${resource}`;
        
        // Prepare the request
        const requestConfig = {
            method: 'post',
            url: url,
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json'
            },
            data: requestData,
            timeout: 15000
        };
        
        // Make the request directly using axios
        const response = await axios(requestConfig);
        
        console.log(`Art request created successfully: ${response.status}`);
        res.status(201).json({
            message: 'Art request created successfully',
            request: response.data
        });
    } catch (error) {
        console.error("Error creating art request:", error.response ? JSON.stringify(error.response.data) : error.message);
        res.status(500).json({ error: 'Failed to create art request.' });
    }
});

// Update an art request by ID
app.put('/api/artrequests/:id', express.json(), async (req, res) => {
    const { id } = req.params;
    if (!id) {
        return res.status(400).json({ error: 'Missing required parameter: id' });
    }
    
    try {
        console.log(`Updating art request with ID: ${id}`);
        const resource = `/tables/ArtRequests/records?q.where=PK_ID=${id}`;
        
        // Get token for the request
        const token = await getCaspioAccessToken();
        const url = `${caspioApiBaseUrl}${resource}`;
        
        // Prepare the request
        const requestConfig = {
            method: 'put',
            url: url,
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json'
            },
            data: req.body,
            timeout: 15000
        };
        
        // Make the request directly using axios
        const response = await axios(requestConfig);
        
        console.log(`Art request updated successfully: ${response.status}`);
        res.json({
            message: 'Art request updated successfully',
            request: response.data
        });
    } catch (error) {
        console.error("Error updating art request:", error.response ? JSON.stringify(error.response.data) : error.message);
        res.status(500).json({ error: 'Failed to update art request.' });
    }
});

// Delete an art request by ID
app.delete('/api/artrequests/:id', async (req, res) => {
    const { id } = req.params;
    if (!id) {
        return res.status(400).json({ error: 'Missing required parameter: id' });
    }
    
    try {
        console.log(`Deleting art request with ID: ${id}`);
        const resource = `/tables/ArtRequests/records?q.where=PK_ID=${id}`;
        
        // Get token for the request
        const token = await getCaspioAccessToken();
        const url = `${caspioApiBaseUrl}${resource}`;
        
        // Prepare the request
        const requestConfig = {
            method: 'delete',
            url: url,
            headers: {
                'Authorization': `Bearer ${token}`
            },
            timeout: 15000
        };
        
        // Make the request directly using axios
        const response = await axios(requestConfig);
        
        console.log(`Art request deleted successfully: ${response.status}`);
        res.json({
            message: 'Art request deleted successfully'
        });
    } catch (error) {
        console.error("Error deleting art request:", error.response ? JSON.stringify(error.response.data) : error.message);
        res.status(500).json({ error: 'Failed to delete art request.' });
    }
});

// --- NEW Endpoint: Art Invoices CRUD Operations ---
// GET: /api/art-invoices - Get all art invoices or filter by query parameters
// GET: /api/art-invoices/:id - Get a specific art invoice by ID
// POST: /api/art-invoices - Create a new art invoice
// PUT: /api/art-invoices/:id - Update an art invoice by ID
// DELETE: /api/art-invoices/:id - Delete an art invoice by ID
app.get('/api/art-invoices', async (req, res) => {
    try {
        console.log("Fetching art invoices information");
        const resource = '/tables/Art_Invoices/records';
        
        // Build query parameters based on request query
        const params = {};
        
        // Add any filter parameters from the request
        if (Object.keys(req.query).length > 0) {
            const whereConditions = [];
            
            // Handle common filter fields
            if (req.query.invoiceID) {
                whereConditions.push(`InvoiceID='${req.query.invoiceID}'`);
            }
            if (req.query.artRequestID) {
                whereConditions.push(`ArtRequestID='${req.query.artRequestID}'`);
            }
            if (req.query.sessionID) {
                whereConditions.push(`SessionID='${req.query.sessionID}'`);
            }
            if (req.query.status) {
                whereConditions.push(`Status='${req.query.status}'`);
            }
            if (req.query.artistName) {
                whereConditions.push(`ArtistName LIKE '%${req.query.artistName}%'`);
            }
            if (req.query.customerName) {
                whereConditions.push(`CustomerName LIKE '%${req.query.customerName}%'`);
            }
            if (req.query.customerCompany) {
                whereConditions.push(`CustomerCompany LIKE '%${req.query.customerCompany}%'`);
            }
            if (req.query.projectName) {
                whereConditions.push(`ProjectName LIKE '%${req.query.projectName}%'`);
            }
            if (req.query.isDeleted) {
                whereConditions.push(`IsDeleted=${req.query.isDeleted}`);
            }
            
            // Add the WHERE clause if we have conditions
            if (whereConditions.length > 0) {
                params['q.where'] = whereConditions.join(' AND ');
            }
        }
        
        // Set ordering and limit
        params['q.orderby'] = 'PK_ID DESC';
        params['q.limit'] = 1000;
        
        // Use fetchAllCaspioPages to handle pagination
        const result = await fetchAllCaspioPages(resource, params);
        console.log(`Found ${result.length} art invoice records`);
        
        res.json(result);
    } catch (error) {
        console.error("Error fetching art invoices:", error.message);
        res.status(500).json({ error: 'Failed to fetch art invoices.' });
    }
});

// Get a specific art invoice by ID
app.get('/api/art-invoices/:id', async (req, res) => {
    const { id } = req.params;
    if (!id) {
        return res.status(400).json({ error: 'Missing required parameter: id' });
    }
    
    try {
        console.log(`Fetching art invoice with ID: ${id}`);
        const resource = `/tables/Art_Invoices/records?q.where=PK_ID=${id}`;
        
        const result = await makeCaspioRequest('get', resource);
        
        if (result && result.length > 0) {
            res.json(result[0]);
        } else {
            res.status(404).json({ error: 'Art invoice not found.' });
        }
    } catch (error) {
        console.error("Error fetching art invoice:", error.message);
        res.status(500).json({ error: 'Failed to fetch art invoice.' });
    }
});

// Create a new art invoice
app.post('/api/art-invoices', express.json(), async (req, res) => {
    try {
        const invoiceData = req.body;
        
        // Validate required fields
        const requiredFields = ['InvoiceID', 'ArtRequestID'];
        for (const field of requiredFields) {
            if (!invoiceData[field]) {
                return res.status(400).json({ error: `Missing required field: ${field}` });
            }
        }
        
        console.log(`Creating new art invoice: ${invoiceData.InvoiceID}`);
        const resource = '/tables/Art_Invoices/records';
        
        // Get token for the request
        const token = await getCaspioAccessToken();
        const url = `${caspioApiBaseUrl}${resource}`;
        
        // Prepare the request
        const requestConfig = {
            method: 'post',
            url: url,
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json'
            },
            data: invoiceData,
            timeout: 15000
        };
        
        // Make the request directly using axios
        const response = await axios(requestConfig);
        
        console.log(`Art invoice created successfully: ${response.status}`);
        res.status(201).json({
            message: 'Art invoice created successfully',
            invoice: response.data
        });
    } catch (error) {
        console.error("Error creating art invoice:", error.response ? JSON.stringify(error.response.data) : error.message);
        res.status(500).json({ error: 'Failed to create art invoice.' });
    }
});

// Update an art invoice by ID
app.put('/api/art-invoices/:id', express.json(), async (req, res) => {
    const { id } = req.params;
    if (!id) {
        return res.status(400).json({ error: 'Missing required parameter: id' });
    }
    
    try {
        console.log(`Updating art invoice with ID: ${id}`);
        const resource = `/tables/Art_Invoices/records?q.where=PK_ID=${id}`;
        
        // Get token for the request
        const token = await getCaspioAccessToken();
        const url = `${caspioApiBaseUrl}${resource}`;
        
        // Prepare the request
        const requestConfig = {
            method: 'put',
            url: url,
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json'
            },
            data: req.body,
            timeout: 15000
        };
        
        // Make the request directly using axios
        const response = await axios(requestConfig);
        
        console.log(`Art invoice updated successfully: ${response.status}`);
        res.json({
            message: 'Art invoice updated successfully',
            invoice: response.data
        });
    } catch (error) {
        console.error("Error updating art invoice:", error.response ? JSON.stringify(error.response.data) : error.message);
        res.status(500).json({ error: 'Failed to update art invoice.' });
    }
});

// Delete an art invoice by ID
app.delete('/api/art-invoices/:id', async (req, res) => {
    const { id } = req.params;
    if (!id) {
        return res.status(400).json({ error: 'Missing required parameter: id' });
    }
    
    try {
        console.log(`Deleting art invoice with ID: ${id}`);
        const resource = `/tables/Art_Invoices/records?q.where=PK_ID=${id}`;
        
        // Get token for the request
        const token = await getCaspioAccessToken();
        const url = `${caspioApiBaseUrl}${resource}`;
        
        // Prepare the request
        const requestConfig = {
            method: 'delete',
            url: url,
            headers: {
                'Authorization': `Bearer ${token}`
            },
            timeout: 15000
        };
        
        // Make the request directly using axios
        const response = await axios(requestConfig);
        
        console.log(`Art invoice deleted successfully: ${response.status}`);
        res.json({
            message: 'Art invoice deleted successfully'
        });
    } catch (error) {
        console.error("Error deleting art invoice:", error.response ? JSON.stringify(error.response.data) : error.message);
        res.status(500).json({ error: 'Failed to delete art invoice.' });
    }
});

// --- NEW Endpoint: Cart Items CRUD Operations ---
// MOVED TO src/routes/cart.js
/*
// GET: /api/cart-items - Get all cart items or filter by query parameters
// POST: /api/cart-items - Create a new cart item
// PUT: /api/cart-items/:id - Update a cart item by ID
// DELETE: /api/cart-items/:id - Delete a cart item by ID
app.get('/api/cart-items', async (req, res) => {
    try {
        console.log("Fetching cart items information");
        const resource = '/tables/Cart_Items/records';
        
        // Build query parameters based on request query
        const params = {};
        
        // Add any filter parameters from the request
        if (Object.keys(req.query).length > 0) {
            const whereConditions = [];
            
            // Handle common filter fields
            if (req.query.sessionID) {
                whereConditions.push(`SessionID='${req.query.sessionID}'`);
            }
            if (req.query.productID) {
                whereConditions.push(`ProductID='${req.query.productID}'`);
            }
            if (req.query.styleNumber) {
                whereConditions.push(`StyleNumber='${req.query.styleNumber}'`);
            }
            if (req.query.color) {
                whereConditions.push(`Color='${req.query.color}'`);
            }
            if (req.query.cartStatus) {
                whereConditions.push(`CartStatus='${req.query.cartStatus}'`);
            }
            if (req.query.orderID) {
                whereConditions.push(`OrderID=${req.query.orderID}`);
            }
            
            // Add the WHERE clause if we have conditions
            if (whereConditions.length > 0) {
                params['q.where'] = whereConditions.join(' AND ');
            }
        }
        
        // Set ordering and limit
        params['q.orderby'] = 'CartItemID ASC';
        params['q.limit'] = 1000;
        
        // Use fetchAllCaspioPages to handle pagination
        const result = await fetchAllCaspioPages(resource, params);
        console.log(`Found ${result.length} cart item records`);
        
        res.json(result);
    } catch (error) {
        console.error("Error fetching cart items information:", error.message);
        res.status(500).json({ error: 'Failed to fetch cart items information.' });
    }
});

// Create a new cart item
app.post('/api/cart-items', express.json(), async (req, res) => {
    try {
        // Validate required fields
        const requiredFields = ['SessionID', 'ProductID', 'StyleNumber', 'Color'];
        for (const field of requiredFields) {
            if (!req.body[field]) {
                return res.status(400).json({ error: `Missing required field: ${field}` });
            }
        }
        
        // Create a new object with only the allowed fields
        // Exclude auto-generated fields like CartItemID, PK_ID, and DateAdded
        const cartItemData = {
            SessionID: req.body.SessionID,
            ProductID: req.body.ProductID,
            StyleNumber: req.body.StyleNumber,
            Color: req.body.Color,
            PRODUCT_TITLE: req.body.PRODUCT_TITLE || null,
            ImprintType: req.body.ImprintType || null,
            CartStatus: req.body.CartStatus || 'Active',
            OrderID: req.body.OrderID || null,
            imageUrl: req.body.imageUrl || null
            // DateAdded is excluded as it might be auto-generated by Caspio
        };
        
        // Log detailed information about the request
        console.log(`Creating new cart item for product: ${cartItemData.ProductID}, style: ${cartItemData.StyleNumber}`);
        console.log(`Image URL from request: ${req.body.imageUrl}`);
        console.log(`Cart item data being sent to Caspio: ${JSON.stringify(cartItemData)}`);
        
        const resource = '/tables/Cart_Items/records';
        
        // Get token for the request
        const token = await getCaspioAccessToken();
        const url = `${caspioApiBaseUrl}${resource}`;
        
        // Prepare the request
        const requestConfig = {
            method: 'post',
            url: url,
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json'
            },
            data: cartItemData,
            timeout: 15000
        };
        
        // Make the request directly using axios
        const response = await axios(requestConfig);
        
        console.log(`Cart item created successfully: ${response.status}`);
        console.log(`Response data: ${JSON.stringify(response.data)}`);
        
        // Log the raw response for debugging
        console.log(`Raw Caspio response: ${JSON.stringify(response.data)}`);
        
        // Extract the cart item data from the Caspio response
        let cartItem = {};
        
        // Based on the Swagger response, we know Caspio returns a Result array for GET requests
        // For POST requests, it might return the created item directly or in a different format
        if (response.data && response.data.Result && Array.isArray(response.data.Result) && response.data.Result.length > 0) {
            // If Result is an array, take the first item
            cartItem = response.data.Result[0];
        } else if (response.data && response.data.Result) {
            // If Result is an object, use it directly
            cartItem = response.data.Result;
        } else if (response.data) {
            // Fallback to using the entire response data
            cartItem = response.data;
        }
        
        // If we don't have a CartItemID, we need to make a follow-up request to get the full record
        // This is necessary because the POST response might not include all fields
        if (!cartItem.CartItemID) {
            try {
                // Use the PK_ID to fetch the complete record if available
                const pkId = cartItem.PK_ID || cartItem.pk_id;
                
                if (pkId) {
                    console.log(`No CartItemID found in response, fetching complete record using PK_ID: ${pkId}`);
                    
                    const fetchResource = `/tables/Cart_Items/records?q.where=PK_ID=${pkId}`;
                    const fetchUrl = `${caspioApiBaseUrl}${fetchResource}`;
                    
                    const fetchConfig = {
                        method: 'get',
                        url: fetchUrl,
                        headers: {
                            'Authorization': `Bearer ${token}`,
                            'Content-Type': 'application/json'
                        },
                        timeout: 15000
                    };
                    
                    const fetchResponse = await axios(fetchConfig);
                    
                    if (fetchResponse.data && fetchResponse.data.Result && Array.isArray(fetchResponse.data.Result) && fetchResponse.data.Result.length > 0) {
                        // Use the fetched record which should have the CartItemID
                        cartItem = fetchResponse.data.Result[0];
                        console.log(`Successfully fetched complete record with CartItemID: ${cartItem.CartItemID}`);
                    }
                } else {
                    // If we don't have a PK_ID, try to fetch by the input parameters
                    console.log(`No PK_ID found, trying to fetch by input parameters`);
                    
                    // Create a where clause based on the input parameters
                    const whereClause = `SessionID='${req.body.SessionID}' AND ProductID='${req.body.ProductID}' AND StyleNumber='${req.body.StyleNumber}' AND Color='${req.body.Color}'`;
                    const fetchResource = `/tables/Cart_Items/records?q.where=${encodeURIComponent(whereClause)}&q.orderby=DateAdded DESC`;
                    const fetchUrl = `${caspioApiBaseUrl}${fetchResource}`;
                    
                    const fetchConfig = {
                        method: 'get',
                        url: fetchUrl,
                        headers: {
                            'Authorization': `Bearer ${token}`,
                            'Content-Type': 'application/json'
                        },
                        timeout: 15000
                    };
                    
                    const fetchResponse = await axios(fetchConfig);
                    
                    if (fetchResponse.data && fetchResponse.data.Result && Array.isArray(fetchResponse.data.Result) && fetchResponse.data.Result.length > 0) {
                        // Use the most recent record (should be the one we just created)
                        cartItem = fetchResponse.data.Result[0];
                        console.log(`Successfully fetched most recent record with CartItemID: ${cartItem.CartItemID}`);
                    }
                }
            } catch (fetchError) {
                console.error("Error fetching complete cart item record:", fetchError.message);
                // Continue with what we have even if the fetch fails
            }
        }
        
        // Ensure we have a properly formatted response with all fields
        // This is critical for the frontend to work correctly
        const formattedCartItem = {
            CartItemID: cartItem.CartItemID || cartItem.PK_ID || null,
            SessionID: cartItem.SessionID || req.body.SessionID,
            ProductID: cartItem.ProductID || req.body.ProductID,
            StyleNumber: cartItem.StyleNumber || req.body.StyleNumber,
            Color: cartItem.Color || req.body.Color,
            PRODUCT_TITLE: cartItem.PRODUCT_TITLE || req.body.PRODUCT_TITLE || null,
            ImprintType: cartItem.ImprintType || req.body.ImprintType || null,
            CartStatus: cartItem.CartStatus || req.body.CartStatus || 'Active',
            OrderID: cartItem.OrderID || req.body.OrderID || null,
            DateAdded: cartItem.DateAdded || new Date().toISOString(),
            imageUrl: cartItem.imageUrl || req.body.imageUrl || null
        };
        
        console.log(`Returning cart item with ID: ${formattedCartItem.CartItemID}`);
        
        // Return the formatted response
        res.status(201).json({
            message: 'Cart item created successfully',
            cartItem: formattedCartItem
        });
    } catch (error) {
        console.error("Error creating cart item:", error.response ? JSON.stringify(error.response.data) : error.message);
        res.status(500).json({ error: 'Failed to create cart item.' });
    }
});

// Update a cart item by ID
app.put('/api/cart-items/:id', express.json(), async (req, res) => {
    const { id } = req.params;
    if (!id) {
        return res.status(400).json({ error: 'Missing required parameter: id' });
    }
    
    try {
        console.log(`Updating cart item with ID: ${id}, data:`, JSON.stringify(req.body));
        
        // First, check if the cart item exists by CartItemID
        const checkResource = '/tables/Cart_Items/records';
        const checkParams = {
            'q.where': `CartItemID=${id}`,
            'q.select': 'PK_ID,CartItemID,SessionID,ProductID,StyleNumber,Color,CartStatus,OrderID',
            'q.limit': 1
        };
        
        // Get token for the request
        const token = await getCaspioAccessToken();
        
        // Check if the cart item exists
        const checkResult = await fetchAllCaspioPages(checkResource, checkParams);
        
        if (!checkResult || checkResult.length === 0) {
            console.error(`Cart item with ID ${id} not found`);
            return res.status(404).json({ error: `Cart item with ID ${id} not found` });
        }
        
        // Get the PK_ID from the check result
        const pkId = checkResult[0].PK_ID;
        console.log(`Found cart item with PK_ID: ${pkId}`);
        
        // Create a new object with only the allowed fields
        // Exclude auto-generated fields like CartItemID and PK_ID
        const cartItemData = {};
        
        // Only include fields that are provided in the request body
        if (req.body.SessionID !== undefined) cartItemData.SessionID = req.body.SessionID;
        if (req.body.ProductID !== undefined) cartItemData.ProductID = req.body.ProductID;
        if (req.body.StyleNumber !== undefined) cartItemData.StyleNumber = req.body.StyleNumber;
        if (req.body.Color !== undefined) cartItemData.Color = req.body.Color;
        if (req.body.PRODUCT_TITLE !== undefined) cartItemData.PRODUCT_TITLE = req.body.PRODUCT_TITLE;
        if (req.body.ImprintType !== undefined) cartItemData.ImprintType = req.body.ImprintType;
        if (req.body.CartStatus !== undefined) cartItemData.CartStatus = req.body.CartStatus;
        if (req.body.OrderID !== undefined) cartItemData.OrderID = req.body.OrderID;
        if (req.body.imageUrl !== undefined) cartItemData.imageUrl = req.body.imageUrl;
        // Don't update DateAdded as it should be set only when the item is created
        
        // Log the data we're sending to Caspio
        console.log(`Sending to Caspio:`, JSON.stringify(cartItemData));
        
        // Use the PK_ID for the update
        const resource = `/tables/Cart_Items/records?q.where=PK_ID=${pkId}`;
        const url = `${caspioApiBaseUrl}${resource}`;
        
        // Prepare the request
        const requestConfig = {
            method: 'put',
            url: url,
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json'
            },
            data: cartItemData,
            timeout: 15000
        };
        
        // Make the request directly using axios
        const response = await axios(requestConfig);
        
        console.log(`Cart item updated successfully: ${response.status}`);
        res.json({
            message: 'Cart item updated successfully',
            cartItem: response.data
        });
    } catch (error) {
        console.error("Error updating cart item:", error.response ? JSON.stringify(error.response.data) : error.message);
        res.status(500).json({ error: 'Failed to update cart item.' });
    }
});

// Delete a cart item by ID
app.delete('/api/cart-items/:id', async (req, res) => {
    const { id } = req.params;
    if (!id) {
        return res.status(400).json({ error: 'Missing required parameter: id' });
    }
    
    try {
        console.log(`Deleting cart item with ID: ${id}`);
        const resource = `/tables/Cart_Items/records?q.where=PK_ID=${id}`;
        
        // Get token for the request
        const token = await getCaspioAccessToken();
        const url = `${caspioApiBaseUrl}${resource}`;
        
        // Prepare the request
        const requestConfig = {
            method: 'delete',
            url: url,
            headers: {
                'Authorization': `Bearer ${token}`
            },
            timeout: 15000
        };
        
        // Make the request directly using axios
        const response = await axios(requestConfig);
        
        console.log(`Cart item deleted successfully: ${response.status}`);
        res.json({
            message: 'Cart item deleted successfully',
            recordsAffected: response.data.RecordsAffected
        });
    } catch (error) {
        console.error("Error deleting cart item:", error.response ? JSON.stringify(error.response.data) : error.message);
        res.status(500).json({ error: 'Failed to delete cart item.' });
    }
});
*/

// --- NEW Endpoint: Cart Item Sizes CRUD Operations ---
// MOVED TO src/routes/cart.js
/*
// GET: /api/cart-item-sizes - Get all cart item sizes or filter by query parameters
// POST: /api/cart-item-sizes - Create a new cart item size
// PUT: /api/cart-item-sizes/:id - Update a cart item size
// DELETE: /api/cart-item-sizes/:id - Delete a cart item size
app.get('/api/cart-item-sizes', async (req, res) => {
    try {
        console.log("Fetching cart item sizes information");
        console.log(`Raw request query parameters: ${JSON.stringify(req.query)}`);
        const resource = '/tables/Cart_Item_Sizes/records';
        
        // Build query parameters based on request query
        const params = {};
        
        // Add any filter parameters from the request
        if (Object.keys(req.query).length > 0) {
            const whereConditions = [];
            
            // Handle common filter fields - normalize parameter names to handle case sensitivity
            // Check for cartItemID in various formats (cartItemID, CartItemID, cartitemid)
            const cartItemID = req.query.cartItemID || req.query.CartItemID || req.query.cartitemid;
            if (cartItemID) {
                console.log(`Filtering cart item sizes by CartItemID=${cartItemID}`);
                whereConditions.push(`CartItemID=${cartItemID}`);
            }
            
            if (req.query.size) {
                whereConditions.push(`Size='${req.query.size}'`);
            }
            
            // Add the WHERE clause if we have conditions
            if (whereConditions.length > 0) {
                params['q.where'] = whereConditions.join(' AND ');
            }
        }
        
        // Set ordering and limit
        params['q.orderby'] = 'SizeItemID ASC';
        params['q.limit'] = 1000;
        
        // Log the full query for debugging
        console.log(`Cart item sizes query: ${JSON.stringify(params)}`);
        
        // Create a custom callback to log each page of results
        const pageCallback = (pageNum, pageData) => {
            console.log(`Page ${pageNum} contains ${pageData.length} records.`);
            console.log(`Page ${pageNum} data sample: ${JSON.stringify(pageData.slice(0, 2))}`);
            return pageData;
        };
        
        // Use fetchAllCaspioPages to handle pagination with increased maxPages and page callback
        const result = await fetchAllCaspioPages(resource, params, {
            maxPages: 20,  // Increase max pages to ensure we get all records
            pageCallback: pageCallback
        });
        
        console.log(`Found ${result.length} cart item size records`);
        console.log(`All CartItemIDs in result: ${result.map(item => item.CartItemID).join(', ')}`);
        
        // Log the first few results for debugging
        if (result.length > 0) {
            console.log(`First result: ${JSON.stringify(result[0])}`);
            if (result.length > 1) {
                console.log(`Second result: ${JSON.stringify(result[1])}`);
            }
        }
        
        // Log all results for the specific CartItemID if filtering by CartItemID
        const cartItemID = req.query.cartItemID || req.query.CartItemID || req.query.cartitemid;
        if (cartItemID) {
            const filteredResults = result.filter(item => item.CartItemID == cartItemID);
            console.log(`Found ${filteredResults.length} records specifically for CartItemID=${cartItemID}`);
            console.log(`All records for CartItemID=${cartItemID}: ${JSON.stringify(filteredResults)}`);
        }
        
        res.json(result);
    } catch (error) {
        console.error("Error fetching cart item sizes information:", error.message);
        res.status(500).json({ error: 'Failed to fetch cart item sizes information.' });
    }
});

// Create a new cart item size
app.post('/api/cart-item-sizes', express.json(), async (req, res) => {
    try {
        // Validate required fields
        const requiredFields = ['CartItemID', 'Size', 'Quantity'];
        for (const field of requiredFields) {
            if (!req.body[field]) {
                return res.status(400).json({ error: `Missing required field: ${field}` });
            }
        }
        
        // Create a new object with only the allowed fields
        // Exclude auto-generated fields like SizeItemID and PK_ID
        const cartItemSizeData = {
            CartItemID: req.body.CartItemID,
            Size: req.body.Size,
            Quantity: req.body.Quantity,
            UnitPrice: req.body.UnitPrice || null
        };
        
        console.log(`Creating new cart item size for cart item: ${cartItemSizeData.CartItemID}, size: ${cartItemSizeData.Size}`);
        const resource = '/tables/Cart_Item_Sizes/records';
        
        // Get token for the request
        const token = await getCaspioAccessToken();
        const url = `${caspioApiBaseUrl}${resource}`;
        
        // Prepare the request
        const requestConfig = {
            method: 'post',
            url: url,
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json'
            },
            data: cartItemSizeData,
            timeout: 15000
        };
        
        // Make the request directly using axios
        const response = await axios(requestConfig);
        
        console.log(`Cart item size created successfully: ${response.status}`);
        
        // Extract the cart item size data from the Caspio response
        let cartItemSize = {};
        
        // Log the raw response for debugging
        console.log(`Raw Caspio response: ${JSON.stringify(response.data)}`);
        
        // Based on the Swagger response, we know Caspio returns a Result array for GET requests
        // For POST requests, it might return the created item directly or in a different format
        if (response.data && response.data.Result && Array.isArray(response.data.Result) && response.data.Result.length > 0) {
            // If Result is an array, take the first item
            cartItemSize = response.data.Result[0];
        } else if (response.data && response.data.Result) {
            // If Result is an object, use it directly
            cartItemSize = response.data.Result;
        } else if (response.data) {
            // Fallback to using the entire response data
            cartItemSize = response.data;
        }
        
        // If we don't have a SizeItemID, we need to make a follow-up request to get the full record
        if (!cartItemSize.SizeItemID) {
            try {
                // Use the PK_ID to fetch the complete record if available
                const pkId = cartItemSize.PK_ID || cartItemSize.pk_id;
                
                if (pkId) {
                    console.log(`No SizeItemID found in response, fetching complete record using PK_ID: ${pkId}`);
                    
                    const fetchResource = `/tables/Cart_Item_Sizes/records?q.where=PK_ID=${pkId}`;
                    const fetchUrl = `${caspioApiBaseUrl}${fetchResource}`;
                    
                    const fetchConfig = {
                        method: 'get',
                        url: fetchUrl,
                        headers: {
                            'Authorization': `Bearer ${token}`,
                            'Content-Type': 'application/json'
                        },
                        timeout: 15000
                    };
                    
                    const fetchResponse = await axios(fetchConfig);
                    
                    if (fetchResponse.data && fetchResponse.data.Result && Array.isArray(fetchResponse.data.Result) && fetchResponse.data.Result.length > 0) {
                        // Use the fetched record which should have the SizeItemID
                        cartItemSize = fetchResponse.data.Result[0];
                        console.log(`Successfully fetched complete record with SizeItemID: ${cartItemSize.SizeItemID}`);
                    }
                } else {
                    // If we don't have a PK_ID, try to fetch by the input parameters
                    console.log(`No PK_ID found, trying to fetch by input parameters`);
                    
                    // Create a where clause based on the input parameters
                    const whereClause = `CartItemID=${req.body.CartItemID} AND Size='${req.body.Size}'`;
                    const fetchResource = `/tables/Cart_Item_Sizes/records?q.where=${encodeURIComponent(whereClause)}&q.orderby=SizeItemID DESC`;
                    const fetchUrl = `${caspioApiBaseUrl}${fetchResource}`;
                    
                    const fetchConfig = {
                        method: 'get',
                        url: fetchUrl,
                        headers: {
                            'Authorization': `Bearer ${token}`,
                            'Content-Type': 'application/json'
                        },
                        timeout: 15000
                    };
                    
                    const fetchResponse = await axios(fetchConfig);
                    
                    if (fetchResponse.data && fetchResponse.data.Result && Array.isArray(fetchResponse.data.Result) && fetchResponse.data.Result.length > 0) {
                        // Use the most recent record (should be the one we just created)
                        cartItemSize = fetchResponse.data.Result[0];
                        console.log(`Successfully fetched record with SizeItemID: ${cartItemSize.SizeItemID}`);
                    }
                }
            } catch (fetchError) {
                console.error("Error fetching complete cart item size record:", fetchError.message);
                // Continue with what we have even if the fetch fails
            }
        }
        
        // Ensure we have a properly formatted response with all fields
        // This is critical for the frontend to work correctly
        // Based on the Swagger response, we know the exact field names and structure
        const formattedCartItemSize = {
            SizeItemID: cartItemSize.SizeItemID || cartItemSize.PK_ID || null,
            CartItemID: cartItemSize.CartItemID || req.body.CartItemID,
            Size: cartItemSize.Size || req.body.Size,
            Quantity: cartItemSize.Quantity || parseInt(req.body.Quantity, 10) || 0,
            UnitPrice: cartItemSize.UnitPrice || req.body.UnitPrice || null
        };
        
        console.log(`Returning cart item size with ID: ${formattedCartItemSize.SizeItemID}`);
        
        // Return the formatted response
        res.status(201).json({
            message: 'Cart item size created successfully',
            cartItemSize: formattedCartItemSize
        });
    } catch (error) {
        console.error("Error creating cart item size:", error.response ? JSON.stringify(error.response.data) : error.message);
        res.status(500).json({ error: 'Failed to create cart item size.' });
    }
});

// Update a cart item size by ID
app.put('/api/cart-item-sizes/:id', express.json(), async (req, res) => {
    const { id } = req.params;
    if (!id) {
        return res.status(400).json({ error: 'Missing required parameter: id' });
    }
    
    try {
        console.log(`Updating cart item size with ID: ${id}`);
        const resource = `/tables/Cart_Item_Sizes/records?q.where=PK_ID=${id}`;
        
        // Create a new object with only the allowed fields
        // Exclude auto-generated fields like SizeItemID and PK_ID
        const cartItemSizeData = {};
        
        // Only include fields that are provided in the request body
        if (req.body.CartItemID !== undefined) cartItemSizeData.CartItemID = req.body.CartItemID;
        if (req.body.Size !== undefined) cartItemSizeData.Size = req.body.Size;
        if (req.body.Quantity !== undefined) cartItemSizeData.Quantity = req.body.Quantity;
        if (req.body.UnitPrice !== undefined) cartItemSizeData.UnitPrice = req.body.UnitPrice;
        
        // Get token for the request
        const token = await getCaspioAccessToken();
        const url = `${caspioApiBaseUrl}${resource}`;
        
        // Prepare the request
        const requestConfig = {
            method: 'put',
            url: url,
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json'
            },
            data: cartItemSizeData,
            timeout: 15000
        };
        
        // Make the request directly using axios
        const response = await axios(requestConfig);
        
        console.log(`Cart item size updated successfully: ${response.status}`);
        res.json({
            message: 'Cart item size updated successfully',
            cartItemSize: response.data
        });
    } catch (error) {
        console.error("Error updating cart item size:", error.response ? JSON.stringify(error.response.data) : error.message);
        res.status(500).json({ error: 'Failed to update cart item size.' });
    }
});

// Delete a cart item size by ID
app.delete('/api/cart-item-sizes/:id', async (req, res) => {
    const { id } = req.params;
    if (!id) {
        return res.status(400).json({ error: 'Missing required parameter: id' });
    }
    
    try {
        console.log(`Deleting cart item size with ID: ${id}`);
        const resource = `/tables/Cart_Item_Sizes/records?q.where=PK_ID=${id}`;
        
        // Get token for the request
        const token = await getCaspioAccessToken();
        const url = `${caspioApiBaseUrl}${resource}`;
        
        // Prepare the request
        const requestConfig = {
            method: 'delete',
            url: url,
            headers: {
                'Authorization': `Bearer ${token}`
            },
            timeout: 15000
        };
        
        // Make the request directly using axios
        const response = await axios(requestConfig);
        
        console.log(`Cart item size deleted successfully: ${response.status}`);
        res.json({
            message: 'Cart item size deleted successfully',
            recordsAffected: response.data.RecordsAffected
        });
    } catch (error) {
        console.error("Error deleting cart item size:", error.response ? JSON.stringify(error.response.data) : error.message);
        res.status(500).json({ error: 'Failed to delete cart item size.' });
    }
});
*/

// --- NEW Endpoint: Cart Sessions CRUD Operations ---
// MOVED TO src/routes/cart.js
/*
// GET: /api/cart-sessions - Get all cart sessions or filter by query parameters
// POST: /api/cart-sessions - Create a new cart session
// PUT: /api/cart-sessions/:id - Update a cart session by ID
// DELETE: /api/cart-sessions/:id - Delete a cart session by ID
app.get('/api/cart-sessions', async (req, res) => {
    try {
        console.log("Fetching cart sessions information");
        const resource = '/tables/Cart_Sessions/records';
        
        // Build query parameters based on request query
        const params = {};
        
        // Add any filter parameters from the request
        if (Object.keys(req.query).length > 0) {
            const whereConditions = [];
            
            // Handle common filter fields
            if (req.query.sessionID) {
                whereConditions.push(`SessionID='${req.query.sessionID}'`);
            }
            if (req.query.userID) {
                whereConditions.push(`UserID=${req.query.userID}`);
            }
            if (req.query.isActive !== undefined) {
                whereConditions.push(`IsActive=${req.query.isActive}`);
            }
            
            // Add the WHERE clause if we have conditions
            if (whereConditions.length > 0) {
                params['q.where'] = whereConditions.join(' AND ');
            }
        }
        
        // Set ordering and limit
        params['q.orderby'] = 'PK_ID ASC';
        params['q.limit'] = 1000;
        
        // Use fetchAllCaspioPages to handle pagination
        const result = await fetchAllCaspioPages(resource, params);
        console.log(`Found ${result.length} cart session records`);
        
        res.json(result);
    } catch (error) {
        console.error("Error fetching cart sessions information:", error.message);
        res.status(500).json({ error: 'Failed to fetch cart sessions information.' });
    }
});

// Create a new cart session
app.post('/api/cart-sessions', express.json(), async (req, res) => {
    try {
        // Validate required fields
        const requiredFields = ['SessionID'];
        for (const field of requiredFields) {
            if (!req.body[field]) {
                return res.status(400).json({ error: `Missing required field: ${field}` });
            }
        }
        
        // Create a new object with only the allowed fields
        // Exclude auto-generated fields like PK_ID
        // Create an object with properly typed fields based on the Caspio table structure
        const cartSessionData = {
            SessionID: req.body.SessionID, // Text (255)
            
            // Optional fields with proper type handling
            UserID: req.body.UserID ? Number(req.body.UserID) : null, // Number
            // CreateDate is excluded as it's likely auto-generated
            // LastActivity is excluded as it's likely auto-managed
            IPAddress: req.body.IPAddress || null, // Text (255)
            UserAgent: req.body.UserAgent || null, // Text (255)
            IsActive: req.body.IsActive === true // Yes/No (boolean)
        };
        
        console.log(`Creating new cart session: ${cartSessionData.SessionID}`);
        const resource = '/tables/Cart_Sessions/records';
        
        // Get token for the request
        const token = await getCaspioAccessToken();
        const url = `${caspioApiBaseUrl}${resource}`;
        
        // Prepare the request
        const requestConfig = {
            method: 'post',
            url: url,
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json'
            },
            data: cartSessionData,
            timeout: 15000
        };
        
        // Make the request directly using axios
        const response = await axios(requestConfig);
        
        console.log(`Cart session created successfully: ${response.status}`);
        res.status(201).json({
            message: 'Cart session created successfully',
            cartSession: response.data
        });
    } catch (error) {
        console.error("Error creating cart session:", error.response ? JSON.stringify(error.response.data) : error.message);
        res.status(500).json({ error: 'Failed to create cart session.' });
    }
});

// Update a cart session by ID
app.put('/api/cart-sessions/:id', express.json(), async (req, res) => {
    const { id } = req.params;
    if (!id) {
        return res.status(400).json({ error: 'Missing required parameter: id' });
    }
    
    try {
        console.log(`Updating cart session with ID: ${id}`);
        const resource = `/tables/Cart_Sessions/records?q.where=SessionID='${id}'`;
        
        // Create a new object with only the allowed fields
        // Exclude auto-generated fields like PK_ID
        const cartSessionData = {};
        
        // Only include fields that are provided in the request body
        if (req.body.SessionID !== undefined) cartSessionData.SessionID = req.body.SessionID;
        if (req.body.UserID !== undefined) cartSessionData.UserID = req.body.UserID;
        if (req.body.LastActivity !== undefined) cartSessionData.LastActivity = req.body.LastActivity;
        if (req.body.IPAddress !== undefined) cartSessionData.IPAddress = req.body.IPAddress;
        if (req.body.UserAgent !== undefined) cartSessionData.UserAgent = req.body.UserAgent;
        if (req.body.IsActive !== undefined) cartSessionData.IsActive = req.body.IsActive;
        // Don't update CreateDate as it should be set only when the session is created
        
        // Get token for the request
        const token = await getCaspioAccessToken();
        const url = `${caspioApiBaseUrl}${resource}`;
        
        // Prepare the request
        const requestConfig = {
            method: 'put',
            url: url,
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json'
            },
            data: cartSessionData,
            timeout: 15000
        };
        
        // Make the request directly using axios
        const response = await axios(requestConfig);
        
        console.log(`Cart session updated successfully: ${response.status}`);
        res.json({
            message: 'Cart session updated successfully',
            cartSession: response.data
        });
    } catch (error) {
        console.error("Error updating cart session:", error.response ? JSON.stringify(error.response.data) : error.message);
        res.status(500).json({ error: 'Failed to update cart session.' });
    }
});

// Delete a cart session by ID
app.delete('/api/cart-sessions/:id', async (req, res) => {
    const { id } = req.params;
    if (!id) {
        return res.status(400).json({ error: 'Missing required parameter: id' });
    }
    
    try {
        console.log(`Deleting cart session with ID: ${id}`);
        const resource = `/tables/Cart_Sessions/records?q.where=SessionID='${id}'`;
        
        // Get token for the request
        const token = await getCaspioAccessToken();
        const url = `${caspioApiBaseUrl}${resource}`;
        
        // Prepare the request
        const requestConfig = {
            method: 'delete',
            url: url,
            headers: {
                'Authorization': `Bearer ${token}`
            },
            timeout: 15000
        };
        
        // Make the request directly using axios
        const response = await axios(requestConfig);
        
        console.log(`Cart session deleted successfully: ${response.status}`);
        res.json({
            message: 'Cart session deleted successfully',
            recordsAffected: response.data.RecordsAffected
        });
    } catch (error) {
        console.error("Error deleting cart session:", error.response ? JSON.stringify(error.response.data) : error.message);
        res.status(500).json({ error: 'Failed to delete cart session.' });
    }
});
*/

// --- NEW Endpoint: Orders CRUD Operations ---
// MOVED TO src/routes/orders.js
/*
// GET: /api/orders - Get all orders or filter by query parameters
// POST: /api/orders - Create a new order
// PUT: /api/orders/:id - Update an order by ID
// DELETE: /api/orders/:id - Delete an order by ID
app.get('/api/orders', async (req, res) => {
    try {
        console.log("Fetching orders information");
        const resource = '/tables/Orders/records';
        
        // Build query parameters based on request query
        const params = {};
        
        // Add any filter parameters from the request
        if (Object.keys(req.query).length > 0) {
            const whereConditions = [];
            
            // Handle common filter fields
            if (req.query.orderID) {
                whereConditions.push(`OrderID=${req.query.orderID}`);
            }
            if (req.query.customerID) {
                whereConditions.push(`CustomerID=${req.query.customerID}`);
            }
            if (req.query.orderStatus) {
                whereConditions.push(`OrderStatus='${req.query.orderStatus}'`);
            }
            if (req.query.paymentStatus) {
                whereConditions.push(`PaymentStatus='${req.query.paymentStatus}'`);
            }
            if (req.query.imprintType) {
                whereConditions.push(`ImprintType='${req.query.imprintType}'`);
            }
            
            // Add the WHERE clause if we have conditions
            if (whereConditions.length > 0) {
                params['q.where'] = whereConditions.join(' AND ');
            }
        }
        
        // Set ordering and limit
        params['q.orderby'] = 'OrderID DESC'; // Most recent orders first
        params['q.limit'] = 1000;
        
        // Use fetchAllCaspioPages to handle pagination
        const result = await fetchAllCaspioPages(resource, params);
        console.log(`Found ${result.length} order records`);
        
        res.json(result);
    } catch (error) {
        console.error("Error fetching orders information:", error.message);
        res.status(500).json({ error: 'Failed to fetch orders information.' });
    }
});

// Create a new order
app.post('/api/orders', express.json(), async (req, res) => {
    try {
        // Log the request for debugging
        console.log(`Creating new order with data:`, JSON.stringify(req.body));
        
        // Validate required fields
        const requiredFields = ['CustomerID'];
        for (const field of requiredFields) {
            if (!req.body[field]) {
                return res.status(400).json({ error: `Missing required field: ${field}` });
            }
        }
        
        // Create an order object with all fields from the schema except OrderID (Autonumber) and OrderDate (Timestamp)
        const orderData = {
            // Required fields - CustomerID must be numeric
            CustomerID: parseInt(req.body.CustomerID, 10),
            
            // Optional fields from the schema (excluding OrderDate which is a timestamp)
            OrderNumber: req.body.OrderNumber || `ORD-${Date.now()}`,
            SessionID: req.body.SessionID || null,
            TotalAmount: req.body.TotalAmount || null,
            OrderStatus: req.body.OrderStatus || 'New',
            ImprintType: req.body.ImprintType || null,
            PaymentMethod: req.body.PaymentMethod || null,
            PaymentStatus: req.body.PaymentStatus || 'Pending',
            ShippingMethod: req.body.ShippingMethod || null,
            TrackingNumber: req.body.TrackingNumber || null,
            EstimatedDelivery: req.body.EstimatedDelivery || null,
            Notes: req.body.Notes || null,
            InternalNotes: req.body.InternalNotes || null
        };
        
        // Special handling for "guest" CustomerID
        if (req.body.CustomerID === 'guest' || isNaN(orderData.CustomerID)) {
            console.log('Using special handling for guest or non-numeric CustomerID');
            
            // Check if we need to create a guest customer first
            const guestCustomerData = {
                Name: 'Guest Customer',
                Email: `guest-${Date.now()}@example.com`,
                CustomerType: 'Guest'
            };
            
            // Create a guest customer
            const customerResource = '/tables/Customer_Info/records';
            const customerToken = await getCaspioAccessToken();
            const customerUrl = `${caspioApiBaseUrl}${customerResource}`;
            
            console.log(`Creating guest customer:`, JSON.stringify(guestCustomerData));
            
            const customerConfig = {
                method: 'post',
                url: customerUrl,
                headers: {
                    'Authorization': `Bearer ${customerToken}`,
                    'Content-Type': 'application/json'
                },
                data: guestCustomerData,
                timeout: 15000
            };
            
            try {
                const customerResponse = await axios(customerConfig);
                console.log(`Guest customer created successfully:`, JSON.stringify(customerResponse.data));
                
                // Use the newly created customer ID
                if (customerResponse.data && customerResponse.data.Result && customerResponse.data.Result.CustomerID) {
                    orderData.CustomerID = parseInt(customerResponse.data.Result.CustomerID, 10);
                    console.log(`Using new guest CustomerID: ${orderData.CustomerID}`);
                } else {
                    // Default to CustomerID 1 if we couldn't create a new customer
                    orderData.CustomerID = 1;
                    console.log(`Using default CustomerID: ${orderData.CustomerID}`);
                }
            } catch (customerError) {
                console.error("Error creating guest customer:", customerError.response ?
                    JSON.stringify(customerError.response.data) : customerError.message);
                // Default to CustomerID 1 if we couldn't create a new customer
                orderData.CustomerID = 1;
                console.log(`Using default CustomerID: ${orderData.CustomerID}`);
            }
        }
        
        // Log the data we're sending to Caspio
        console.log(`Sending to Caspio:`, JSON.stringify(orderData));
        
        console.log(`Creating new order for customer: ${orderData.CustomerID}`);
        const resource = '/tables/Orders/records';
        
        // Get token for the request
        const token = await getCaspioAccessToken();
        const url = `${caspioApiBaseUrl}${resource}`;
        
        // Prepare the request
        const requestConfig = {
            method: 'post',
            url: url,
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json'
            },
            data: orderData,
            timeout: 15000
        };
        
        // Make the request directly using axios
        const response = await axios(requestConfig);
        
        console.log(`Order created successfully: ${response.status}`);
        res.status(201).json({
            message: 'Order created successfully',
            order: response.data
        });
    } catch (error) {
        console.error("Error creating order:", error.response ? JSON.stringify(error.response.data) : error.message);
        res.status(500).json({ error: 'Failed to create order.' });
    }
});

// Update an order by ID
app.put('/api/orders/:id', express.json(), async (req, res) => {
    const { id } = req.params;
    if (!id) {
        return res.status(400).json({ error: 'Missing required parameter: id' });
    }
    
    try {
        console.log(`Updating order with ID: ${id}`);
        const resource = `/tables/Orders/records?q.where=PK_ID=${id}`;
        
        // Log the request for debugging
        console.log(`Updating order with data:`, JSON.stringify(req.body));
        
        // Create a minimal object with only writable fields
        // Based on our testing, we need to limit the fields to avoid "AlterReadOnlyData" errors
        const orderData = {};
        
        // Only include specific fields that are known to be writable
        // Exclude fields that might be read-only in Caspio
        if (req.body.OrderStatus !== undefined) orderData.OrderStatus = req.body.OrderStatus;
        if (req.body.ImprintType !== undefined) orderData.ImprintType = req.body.ImprintType;
        if (req.body.PaymentStatus !== undefined) orderData.PaymentStatus = req.body.PaymentStatus;
        if (req.body.ShippingMethod !== undefined) orderData.ShippingMethod = req.body.ShippingMethod;
        if (req.body.TrackingNumber !== undefined) orderData.TrackingNumber = req.body.TrackingNumber;
        if (req.body.EstimatedDelivery !== undefined) orderData.EstimatedDelivery = req.body.EstimatedDelivery;
        if (req.body.Notes !== undefined) orderData.Notes = req.body.Notes;
        if (req.body.InternalNotes !== undefined) orderData.InternalNotes = req.body.InternalNotes;
        
        // Log the data we're sending to Caspio
        console.log(`Sending to Caspio:`, JSON.stringify(orderData));
        
        // Get token for the request
        const token = await getCaspioAccessToken();
        const url = `${caspioApiBaseUrl}${resource}`;
        
        // Prepare the request
        const requestConfig = {
            method: 'put',
            url: url,
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json'
            },
            data: orderData,
            timeout: 15000
        };
        
        // Make the request directly using axios
        const response = await axios(requestConfig);
        
        console.log(`Order updated successfully: ${response.status}`);
        res.json({
            message: 'Order updated successfully',
            order: response.data
        });
    } catch (error) {
        console.error("Error updating order:", error.response ? JSON.stringify(error.response.data) : error.message);
        res.status(500).json({ error: 'Failed to update order.' });
    }
});

// Delete an order by ID
app.delete('/api/orders/:id', async (req, res) => {
    const { id } = req.params;
    if (!id) {
        return res.status(400).json({ error: 'Missing required parameter: id' });
    }
    
    try {
        console.log(`Deleting order with ID: ${id}`);
        const resource = `/tables/Orders/records?q.where=PK_ID=${id}`;
        
        // Get token for the request
        const token = await getCaspioAccessToken();
        const url = `${caspioApiBaseUrl}${resource}`;
        
        // Prepare the request
        const requestConfig = {
            method: 'delete',
            url: url,
            headers: {
                'Authorization': `Bearer ${token}`
            },
            timeout: 15000
        };
        
        // Make the request directly using axios
        const response = await axios(requestConfig);
        
        console.log(`Order deleted successfully: ${response.status}`);
        res.json({
            message: 'Order deleted successfully',
            recordsAffected: response.data.RecordsAffected
        });
    } catch (error) {
        console.error("Error deleting order:", error.response ? JSON.stringify(error.response.data) : error.message);
        res.status(500).json({ error: 'Failed to delete order.' });
    }
});
*/

// --- ENHANCED Endpoint: Cart Integration JavaScript ---
// MOVED TO src/routes/cart.js
/*
// Example: /api/cart-integration.js
app.get('/api/cart-integration.js', (req, res) => {
    console.log("Serving cart integration JavaScript");
    
    // Set the content type to JavaScript
    res.setHeader('Content-Type', 'application/javascript');
    // Add cache control headers to prevent caching issues
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    
    // Use fs to read the file
    const fs = require('fs');
    const path = require('path');
    
    const filePath = path.join(__dirname, 'cart-integration.js');
    console.log(`Reading file from: ${filePath}`);
    
    try {
        // Read the file synchronously for simplicity
        const data = fs.readFileSync(filePath, 'utf8');
        console.log(`Successfully read ${data.length} characters from cart-integration.js`);
        
        // Filter out any non-JavaScript content at the beginning of the file
        // Look for the first valid JavaScript line (comment or function declaration)
        let cleanedData = data;
        
        // Check if the file contains explanatory text at the beginning
        if (data.includes('The user is offering to manually create the file')) {
            console.log('Detected explanatory text at the beginning of the file, cleaning it up...');
            
            // Find the start of the actual JavaScript code
            // Look for common JavaScript patterns like comments or function declarations
            const jsStartPatterns = [
                '// Cart integration',
                'function init',
                '/*',
                'const ',
                'let ',
                'var '
            ];
            
            let startIndex = -1;
            for (const pattern of jsStartPatterns) {
                const index = data.indexOf(pattern);
                if (index !== -1 && (startIndex === -1 || index < startIndex)) {
                    startIndex = index;
                }
            }
            
            if (startIndex !== -1) {
                cleanedData = data.substring(startIndex);
                console.log(`Removed ${startIndex} characters of non-JavaScript content from the beginning of the file`);
            } else {
                console.warn('Could not find the start of JavaScript code, serving the file as-is');
            }
        }
        
        // Send the cleaned file content
        res.send(cleanedData);
        console.log("Successfully sent cart integration JavaScript");
    } catch (err) {
        console.error(`Error reading cart-integration.js: ${err.message}`);
        res.status(500).send('// Error loading cart integration script');
    }
});

*/

// Redirect cart integration script from root path to API path
app.get('/cart-integration.js', (req, res) => {
    console.log("Redirecting to /api/cart-integration.js");
    res.redirect('/api/cart-integration.js');
});

// --- NEW Endpoint: Process Checkout ---
// Example: POST /api/process-checkout
app.post('/api/process-checkout', express.json(), async (req, res) => {
    try {
        // Extract sessionId and customerId from request body
        // Also check for CustomerInfo object for backward compatibility
        const { sessionId, customerId, CustomerInfo } = req.body;
        
        // Get the customer ID from either customerId or CustomerInfo.CustomerID
        const effectiveCustomerId = customerId || (CustomerInfo && CustomerInfo.CustomerID);
        
        // Validate required fields
        if (!sessionId || !effectiveCustomerId) {
            return res.status(400).json({
                error: 'Missing required fields: sessionId and customerId (or CustomerInfo.CustomerID) are required'
            });
        }
        
        console.log(`Processing checkout for session: ${sessionId}, customer: ${effectiveCustomerId}`);
        
        // Get cart items for the session
        const cartItemsResource = '/tables/Cart_Items/records';
        const cartItemsParams = {
            'q.where': `SessionID='${sessionId}'`,
            'q.select': '*',
            'q.limit': 1000
        };
        
        const cartItems = await fetchAllCaspioPages(cartItemsResource, cartItemsParams);
        
        if (!cartItems || cartItems.length === 0) {
            return res.status(400).json({ error: 'No items in cart' });
        }
        
        console.log(`Found ${cartItems.length} items in cart for session: ${sessionId}`);
        
        // Generate a unique order ID
        const orderId = 'ORD-' + Math.random().toString(36).substring(2, 10).toUpperCase();
        
        // Create an order record without updating cart items
        // This avoids the 500 Internal Server Error when updating cart items
        try {
            // Create order with minimal data
            const orderResource = '/tables/Orders/records';
            const orderData = {
                CustomerID: effectiveCustomerId,
                OrderID: orderId,
                SessionID: sessionId,
                OrderStatus: 'New',
                OrderDate: new Date().toISOString()
            };
            
            console.log(`Creating order with ID: ${orderId}`);
            
            // Get token for the request
            const token = await getCaspioAccessToken();
            const url = `${caspioApiBaseUrl}${orderResource}`;
            
            // Prepare the request
            const requestConfig = {
                method: 'post',
                url: url,
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'Content-Type': 'application/json'
                },
                data: orderData,
                timeout: 15000
            };
            
            // Make the request directly using axios
            const response = await axios(requestConfig);
            
            console.log(`Order created successfully: ${response.status}`);
            
            // Return success response with order ID
            return res.status(201).json({
                success: true,
                message: 'Checkout processed successfully',
                orderId: orderId,
                orderData: response.data
            });
        } catch (error) {
            console.error("Error creating order:", error.response ? JSON.stringify(error.response.data) : error.message);
            
            // Return error response with fallback
            return res.status(500).json({
                success: false,
                error: 'Failed to create order',
                fallback: true,
                orderId: orderId
            });
        }
    } catch (error) {
        console.error("Error processing checkout:", error.message);
        res.status(500).json({ error: 'Failed to process checkout.' });
    }
});

// --- NEW Endpoint: PricingMatrix CRUD Operations ---
// GET: /api/pricing-matrix - Get all pricing matrix records or filter by query parameters
// GET: /api/pricing-matrix/lookup - Lookup a pricing matrix ID based on style, color, and embellishment type
// GET: /api/pricing-matrix/:id - Get a specific pricing matrix record by ID
// POST: /api/pricing-matrix - Create a new pricing matrix record
// PUT: /api/pricing-matrix/:id - Update a pricing matrix record by ID
// DELETE: /api/pricing-matrix/:id - Delete a pricing matrix record by ID

app.get('/api/pricing-matrix', async (req, res) => {
    try {
        console.log("Fetching pricing matrix information");
        const resource = '/tables/PricingMatrix/records';
        
        // Build query parameters based on request query
        const params = {};
        
        // Add any filter parameters from the request
        if (Object.keys(req.query).length > 0) {
            const whereConditions = [];
            
            // Handle common filter fields
            if (req.query.pricingMatrixID) {
                whereConditions.push(`PricingMatrixID=${req.query.pricingMatrixID}`);
            }
            if (req.query.sessionID) {
                whereConditions.push(`SessionID='${req.query.sessionID}'`);
            }
            if (req.query.styleNumber) {
                whereConditions.push(`StyleNumber='${req.query.styleNumber}'`);
            }
            if (req.query.color) {
                whereConditions.push(`Color='${req.query.color}'`);
            }
            if (req.query.embellishmentType) {
                whereConditions.push(`EmbellishmentType='${req.query.embellishmentType}'`);
            }
            
            // Add the WHERE clause if we have conditions
            if (whereConditions.length > 0) {
                params['q.where'] = whereConditions.join(' AND ');
            }
        }
        
        // Set ordering and limit
        params['q.orderby'] = 'PricingMatrixID DESC'; // Most recent records first
        params['q.limit'] = 1000;
        
        // Use fetchAllCaspioPages to handle pagination
        const result = await fetchAllCaspioPages(resource, params);
        console.log(`Found ${result.length} pricing matrix records`);
        
        res.json(result);
    } catch (error) {
        console.error("Error fetching pricing matrix information:", error.message);
        res.status(500).json({ error: 'Failed to fetch pricing matrix information.' });
    }
});

// --- NEW Endpoint: Lookup Pricing Matrix ID ---
// Example: /api/pricing-matrix/lookup?styleNumber=PC61&color=RED&embellishmentType=DTG&sessionID=direct-test-1745497242701
app.get('/api/pricing-matrix/lookup', async (req, res) => {
    const { styleNumber, color, embellishmentType, sessionID } = req.query;

    // Validate required parameters
    if (!styleNumber || !color || !embellishmentType) {
        return res.status(400).json({ error: 'Missing required query parameters (styleNumber, color, embellishmentType)' });
    }

    try {
        console.log(`Looking up PricingMatrixID for Style: ${styleNumber}, Color: ${color}, Type: ${embellishmentType}, Session: ${sessionID || 'N/A'}`);
        const resource = '/tables/PricingMatrix/records';

        // Build the where clause
        const whereConditions = [
            `StyleNumber='${styleNumber}'`,
            `Color='${color}'`,
            `EmbellishmentType='${embellishmentType}'`
        ];
        if (sessionID) {
            whereConditions.push(`SessionID='${sessionID}'`);
        }

        const params = {
            'q.where': whereConditions.join(' AND '),
            'q.select': 'PricingMatrixID', // Select only the ID field
            'q.orderby': 'CaptureDate DESC', // Get the most recent one
            'q.limit': 1 // We only need the first match
        };

        // Use fetchAllCaspioPages (even though limit is 1, it's the standard way)
        const result = await fetchAllCaspioPages(resource, params);

        if (!result || result.length === 0) {
            console.log(`Pricing matrix not found for criteria: ${JSON.stringify(req.query)}`);
            return res.status(404).json({ error: 'Pricing matrix not found for the given criteria' });
        }

        // Extract the ID from the first result
        const pricingMatrixId = result[0].PricingMatrixID;
        console.log(`Found PricingMatrixID: ${pricingMatrixId}`);

        res.json({ pricingMatrixId: pricingMatrixId });

    } catch (error) {
        console.error("Error during pricing matrix lookup:", error.message);
        // Check if it's a Caspio API error
        if (error.message.includes('Caspio')) {
             res.status(500).json({ error: `Caspio API error during lookup: ${error.message}` });
        } else {
             res.status(500).json({ error: 'Internal server error during lookup' });
        }
    }
});

// Get a specific pricing matrix record by ID
app.get('/api/pricing-matrix/:id', async (req, res) => {
    const { id } = req.params;
    if (!id) {
        return res.status(400).json({ error: 'Missing required parameter: id' });
    }
    
    try {
        console.log(`Fetching pricing matrix with ID: ${id}`);
        const resource = '/tables/PricingMatrix/records';
        const params = {
            'q.where': `PricingMatrixID=${id}`,
            'q.limit': 1
        };
        
        // Use fetchAllCaspioPages to handle pagination
        const result = await fetchAllCaspioPages(resource, params);
        
        if (!result || result.length === 0) {
            return res.status(404).json({ error: `Pricing matrix with ID ${id} not found` });
        }
        
        res.json(result[0]);
    } catch (error) {
        console.error(`Error fetching pricing matrix with ID ${id}:`, error.message);
        res.status(500).json({ error: 'Failed to fetch pricing matrix information.' });
    }
});
// Create a new pricing matrix record
app.post('/api/pricing-matrix', express.json(), async (req, res) => {
    try {
        // Validate required fields
        const requiredFields = ['SessionID', 'StyleNumber', 'Color', 'EmbellishmentType'];
        for (const field of requiredFields) {
            if (!req.body[field]) {
                return res.status(400).json({ error: `Missing required field: ${field}` });
            }
        }
        
        // Create a new object with only the allowed fields
        // Exclude auto-generated fields like PK_ID and PricingMatrixID
        const pricingMatrixData = {
            SessionID: req.body.SessionID,
            StyleNumber: req.body.StyleNumber,
            Color: req.body.Color,
            EmbellishmentType: req.body.EmbellishmentType,
            CaptureDate: req.body.CaptureDate || new Date().toISOString(),
            TierStructure: req.body.TierStructure || null,
            SizeGroups: req.body.SizeGroups || null,
            PriceMatrix: req.body.PriceMatrix || null
        };
        
        console.log(`Creating new pricing matrix for style: ${pricingMatrixData.StyleNumber}, color: ${pricingMatrixData.Color}`);
        const resource = '/tables/PricingMatrix/records';
        
        // Get token for the request
        const token = await getCaspioAccessToken();
        const url = `${caspioApiBaseUrl}${resource}`;
        
        // Prepare the request
        const requestConfig = {
            method: 'post',
            url: url,
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json'
            },
            data: pricingMatrixData,
            timeout: 15000
        };
        
        // Make the request directly using axios
        const response = await axios(requestConfig);
        
        console.log(`Pricing matrix created successfully: ${response.status}`);
        res.status(201).json({
            message: 'Pricing matrix created successfully',
            pricingMatrix: response.data
        });
    } catch (error) {
        console.error("Error creating pricing matrix:", error.response ? JSON.stringify(error.response.data) : error.message);
        res.status(500).json({ error: 'Failed to create pricing matrix.' });
    }
});

// Update a pricing matrix record by ID
app.put('/api/pricing-matrix/:id', express.json(), async (req, res) => {
    const { id } = req.params;
    if (!id) {
        return res.status(400).json({ error: 'Missing required parameter: id' });
    }
    
    try {
        console.log(`Updating pricing matrix with ID: ${id}`);
        const resource = `/tables/PricingMatrix/records?q.where=PricingMatrixID=${id}`;
        
        // Create a new object with only the allowed fields
        // Exclude auto-generated fields like PK_ID and PricingMatrixID
        const pricingMatrixData = {};
        
        // Only include fields that are provided in the request body
        if (req.body.SessionID !== undefined) pricingMatrixData.SessionID = req.body.SessionID;
        if (req.body.StyleNumber !== undefined) pricingMatrixData.StyleNumber = req.body.StyleNumber;
        if (req.body.Color !== undefined) pricingMatrixData.Color = req.body.Color;
        if (req.body.EmbellishmentType !== undefined) pricingMatrixData.EmbellishmentType = req.body.EmbellishmentType;
        if (req.body.CaptureDate !== undefined) pricingMatrixData.CaptureDate = req.body.CaptureDate;
        if (req.body.TierStructure !== undefined) pricingMatrixData.TierStructure = req.body.TierStructure;
        if (req.body.SizeGroups !== undefined) pricingMatrixData.SizeGroups = req.body.SizeGroups;
        if (req.body.PriceMatrix !== undefined) pricingMatrixData.PriceMatrix = req.body.PriceMatrix;
        
        // Get token for the request
        const token = await getCaspioAccessToken();
        const url = `${caspioApiBaseUrl}${resource}`;
        
        // Prepare the request
        const requestConfig = {
            method: 'put',
            url: url,
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json'
            },
            data: pricingMatrixData,
            timeout: 15000
        };
        
        // Make the request directly using axios
        const response = await axios(requestConfig);
        
        console.log(`Pricing matrix updated successfully: ${response.status}`);
        res.json({
            message: 'Pricing matrix updated successfully',
            pricingMatrix: response.data
        });
    } catch (error) {
        console.error("Error updating pricing matrix:", error.response ? JSON.stringify(error.response.data) : error.message);
        res.status(500).json({ error: 'Failed to update pricing matrix.' });
    }
});

// Delete a pricing matrix record by ID
app.delete('/api/pricing-matrix/:id', async (req, res) => {
    const { id } = req.params;
    if (!id) {
        return res.status(400).json({ error: 'Missing required parameter: id' });
    }
    
    try {
        console.log(`Deleting pricing matrix with ID: ${id}`);
        const resource = `/tables/PricingMatrix/records?q.where=PricingMatrixID=${id}`;
        
        // Get token for the request
        const token = await getCaspioAccessToken();
        const url = `${caspioApiBaseUrl}${resource}`;
        
        // Prepare the request
        const requestConfig = {
            method: 'delete',
            url: url,
            headers: {
                'Authorization': `Bearer ${token}`
            },
            timeout: 15000
        };
        
        // Make the request directly using axios
        const response = await axios(requestConfig);
        
        console.log(`Pricing matrix deleted successfully: ${response.status}`);
        res.json({
            message: 'Pricing matrix deleted successfully',
            recordsAffected: response.data.RecordsAffected
        });
    } catch (error) {
        console.error("Error deleting pricing matrix:", error.response ? JSON.stringify(error.response.data) : error.message);
        res.status(500).json({ error: 'Failed to delete pricing matrix.' });
    }
});
// --- NEW Endpoint: Quote_Analytics CRUD Operations ---
// Table Name: Quote_Analytics
// Primary Key Field: PK_ID

// GET: /api/quote_analytics - Get all quote analytics records or filter by query parameters
app.get('/api/quote_analytics', async (req, res) => {
    try {
        console.log("Fetching Quote_Analytics records");
        const resource = '/tables/Quote_Analytics/records';
        const params = {
            'q.orderby': 'PK_ID DESC', // Most recent records first
            'q.limit': 1000 // Default limit, fetchAllCaspioPages handles pagination
        };

        const whereConditions = [];
        if (req.query.SessionID) {
            whereConditions.push(`SessionID='${req.query.SessionID}'`);
        }
        if (req.query.QuoteID) {
            whereConditions.push(`QuoteID='${req.query.QuoteID}'`);
        }
        // Add other potential filters here if needed in the future

        if (whereConditions.length > 0) {
            params['q.where'] = whereConditions.join(' AND ');
        }
        
        console.log(`Fetching Quote_Analytics with params: ${JSON.stringify(params)}`);
        const result = await fetchAllCaspioPages(resource, params);
        console.log(`Found ${result.length} Quote_Analytics records`);
        res.json(result);
    } catch (error) {
        console.error("Error fetching Quote_Analytics records:", error.message, error.stack);
        res.status(500).json({ error: 'Failed to fetch Quote_Analytics records.' });
    }
});

// GET: /api/quote_analytics/:id - Get a specific quote analytics record by PK_ID
app.get('/api/quote_analytics/:id', async (req, res) => {
    const { id } = req.params;
    if (!id || isNaN(parseInt(id))) {
        return res.status(400).json({ error: 'Missing or invalid required parameter: id (must be a number for PK_ID)' });
    }
    
    try {
        console.log(`Fetching Quote_Analytics record with PK_ID: ${id}`);
        const resource = '/tables/Quote_Analytics/records';
        const params = {
            'q.where': `PK_ID=${id}`,
            'q.limit': 1
        };
        
        const result = await fetchAllCaspioPages(resource, params);
        
        if (!result || result.length === 0) {
            return res.status(404).json({ error: `Quote_Analytics record with PK_ID ${id} not found` });
        }
        
        res.json(result[0]);
    } catch (error) {
        console.error(`Error fetching Quote_Analytics record with PK_ID ${id}:`, error.message, error.stack);
        res.status(500).json({ error: 'Failed to fetch Quote_Analytics record.' });
    }
});

// POST: /api/quote_analytics - Create a new quote analytics record
app.post('/api/quote_analytics', express.json(), async (req, res) => {
    try {
        const {
            SessionID, QuoteID, EventType, StyleNumber, Color, PrintLocation,
            Quantity, HasLTM, PriceShown, UserAgent, IPAddress, AnalyticsID
            // PK_ID is auto-generated by Caspio
            // Timestamp can be auto-generated by Caspio if field type is Timestamp (auto)
            // NoName is likely unused
        } = req.body;

        // Basic validation
        if (!SessionID || !EventType) {
            return res.status(400).json({ error: 'Missing required fields: SessionID and EventType are required.' });
        }

        // Get the next available AnalyticsID if not provided
        let nextAnalyticsID = AnalyticsID || 100; // Default starting value
        if (!AnalyticsID) {
            try {
                // Try to get the highest existing AnalyticsID
                const resource = '/tables/Quote_Analytics/records';
                const params = {
                    'q.select': 'AnalyticsID',
                    'q.orderby': 'AnalyticsID DESC',
                    'q.limit': 1
                };
                
                const result = await fetchAllCaspioPages(resource, params);
                if (result && result.length > 0 && result[0].AnalyticsID) {
                    nextAnalyticsID = parseInt(result[0].AnalyticsID) + 1;
                }
            } catch (error) {
                console.warn("Could not determine next AnalyticsID, using default:", error.message);
            }
        }

        const recordData = {
            SessionID,
            QuoteID: QuoteID || null,
            EventType,
            StyleNumber: StyleNumber || null,
            Color: Color || null,
            PrintLocation: PrintLocation || null,
            Quantity: Quantity !== undefined ? Quantity : null,
            HasLTM: HasLTM || null,
            PriceShown: PriceShown !== undefined ? PriceShown : null,
            UserAgent: UserAgent || null,
            IPAddress: IPAddress || null,
            Timestamp: new Date().toISOString(), // Set timestamp on creation
            AnalyticsID: nextAnalyticsID // Add the required AnalyticsID field
        };
        
        console.log(`Creating new Quote_Analytics record: ${JSON.stringify(recordData)}`);
        const resource = '/tables/Quote_Analytics/records';
        
        const token = await getCaspioAccessToken();
        const url = `${caspioApiBaseUrl}${resource}`;
        
        const requestConfig = {
            method: 'post',
            url: url,
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json'
            },
            data: recordData,
            timeout: 15000
        };
        
        const response = await axios(requestConfig);
        
        console.log(`Quote_Analytics record created successfully: ${response.status}`);
        // Caspio POST response usually includes the created record with its auto-generated IDs
        res.status(201).json(response.data); 
    } catch (error) {
        console.error("Error creating Quote_Analytics record:", error.response ? JSON.stringify(error.response.data) : error.message, error.stack);
        res.status(500).json({ error: 'Failed to create Quote_Analytics record.' });
    }
});

// PUT: /api/quote_analytics/:id - Update a quote analytics record by PK_ID
app.put('/api/quote_analytics/:id', express.json(), async (req, res) => {
    const { id } = req.params;
     if (!id || isNaN(parseInt(id))) {
        return res.status(400).json({ error: 'Missing or invalid required parameter: id (must be a number for PK_ID)' });
    }
    
    try {
        const updateData = { ...req.body };
        // Remove fields that should not be updated directly or are auto-managed
        delete updateData.PK_ID;
        delete updateData.AnalyticsID;
        // Timestamp might be updated if provided, or Caspio might auto-update an "updated_at" field if configured
        if (Object.keys(updateData).length === 0) {
            return res.status(400).json({ error: 'No fields provided for update.' });
        }

        console.log(`Updating Quote_Analytics record with PK_ID: ${id} with data: ${JSON.stringify(updateData)}`);
        const resource = `/tables/Quote_Analytics/records?q.where=PK_ID=${id}`;
        
        const token = await getCaspioAccessToken();
        const url = `${caspioApiBaseUrl}${resource}`;
        
        const requestConfig = {
            method: 'put',
            url: url,
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json'
            },
            data: updateData,
            timeout: 15000
        };
        
        const response = await axios(requestConfig);
        
        console.log(`Quote_Analytics record updated successfully: ${response.status}`);
        // Caspio PUT response for a single record update (by where clause) usually returns the number of records affected.
        // To return the updated record, a subsequent GET might be needed, or rely on client-side data.
        // For simplicity, returning the Caspio response.
        if (response.data && response.data.RecordsAffected > 0) {
             // Fetch the updated record to return it
            const fetchParams = { 'q.where': `PK_ID=${id}`, 'q.limit': 1 };
            const updatedRecord = await fetchAllCaspioPages('/tables/Quote_Analytics/records', fetchParams);
            if (updatedRecord && updatedRecord.length > 0) {
                res.json(updatedRecord[0]);
            } else {
                res.json({ message: `Quote_Analytics record with PK_ID ${id} updated. Record not found after update.` });
            }
        } else if (response.data && response.data.RecordsAffected === 0) {
            return res.status(404).json({ error: `Quote_Analytics record with PK_ID ${id} not found or no changes made.` });
        } else {
            res.json(response.data);
        }

    } catch (error) {
        console.error("Error updating Quote_Analytics record:", error.response ? JSON.stringify(error.response.data) : error.message, error.stack);
        res.status(500).json({ error: 'Failed to update Quote_Analytics record.' });
    }
});

// DELETE: /api/quote_analytics/:id - Delete a quote analytics record by PK_ID
app.delete('/api/quote_analytics/:id', async (req, res) => {
    const { id } = req.params;
    if (!id || isNaN(parseInt(id))) {
        return res.status(400).json({ error: 'Missing or invalid required parameter: id (must be a number for PK_ID)' });
    }
    
    try {
        console.log(`Deleting Quote_Analytics record with PK_ID: ${id}`);
        const resource = `/tables/Quote_Analytics/records?q.where=PK_ID=${id}`;
        
        const token = await getCaspioAccessToken();
        const url = `${caspioApiBaseUrl}${resource}`;
        
        const requestConfig = {
            method: 'delete',
            url: url,
            headers: {
                'Authorization': `Bearer ${token}`
            },
            timeout: 15000
        };
        
        const response = await axios(requestConfig);
        
        console.log(`Quote_Analytics record deleted successfully: ${response.status}`);
        if (response.data && response.data.RecordsAffected > 0) {
            res.status(204).send(); // No Content
        } else {
            return res.status(404).json({ error: `Quote_Analytics record with PK_ID ${id} not found.` });
        }
    } catch (error) {
        console.error("Error deleting Quote_Analytics record:", error.response ? JSON.stringify(error.response.data) : error.message, error.stack);
        res.status(500).json({ error: 'Failed to delete Quote_Analytics record.' });
    }
});
// --- NEW Endpoint: Quote_Items CRUD Operations ---
// Table Name: Quote_Items
// Primary Key Field: PK_ID

// GET: /api/quote_items - Get all quote items or filter by query parameters
app.get('/api/quote_items', async (req, res) => {
    try {
        console.log("Fetching Quote_Items records");
        const resource = '/tables/Quote_Items/records';
        const params = {
            'q.orderby': 'PK_ID ASC', // Order by PK_ID
            'q.limit': 1000 // Default limit, fetchAllCaspioPages handles pagination
        };

        const whereConditions = [];
        if (req.query.QuoteID) {
            whereConditions.push(`QuoteID='${req.query.QuoteID}'`);
        }
        if (req.query.StyleNumber) {
            whereConditions.push(`StyleNumber='${req.query.StyleNumber}'`);
        }
        // Add other potential filters here if needed

        if (whereConditions.length > 0) {
            params['q.where'] = whereConditions.join(' AND ');
        }
        
        console.log(`Fetching Quote_Items with params: ${JSON.stringify(params)}`);
        const result = await fetchAllCaspioPages(resource, params);
        console.log(`Found ${result.length} Quote_Items records`);
        res.json(result);
    } catch (error) {
        console.error("Error fetching Quote_Items records:", error.message, error.stack);
        res.status(500).json({ error: 'Failed to fetch Quote_Items records.' });
    }
});

// GET: /api/quote_items/:id - Get a specific quote item by PK_ID
app.get('/api/quote_items/:id', async (req, res) => {
    const { id } = req.params;
    if (!id || isNaN(parseInt(id))) {
        return res.status(400).json({ error: 'Missing or invalid required parameter: id (must be a number for PK_ID)' });
    }
    
    try {
        console.log(`Fetching Quote_Items record with PK_ID: ${id}`);
        const resource = '/tables/Quote_Items/records';
        const params = {
            'q.where': `PK_ID=${id}`,
            'q.limit': 1
        };
        
        const result = await fetchAllCaspioPages(resource, params);
        
        if (!result || result.length === 0) {
            return res.status(404).json({ error: `Quote_Items record with PK_ID ${id} not found` });
        }
        
        res.json(result[0]);
    } catch (error) {
        console.error(`Error fetching Quote_Items record with PK_ID ${id}:`, error.message, error.stack);
        res.status(500).json({ error: 'Failed to fetch Quote_Items record.' });
    }
});

// POST: /api/quote_items - Create a new quote item
app.post('/api/quote_items', express.json(), async (req, res) => {
    try {
        const {
            QuoteID, LineNumber, StyleNumber, ProductName, Color, ColorCode,
            EmbellishmentType, PrintLocation, PrintLocationName, Quantity,
            HasLTM, BaseUnitPrice, LTMPerUnit, FinalUnitPrice, LineTotal,
            SizeBreakdown, PricingTier, ImageURL
            // PK_ID is auto-generated by Caspio
            // AddedAt will be set by the server
            // ItemID removed - no longer exists in the table
        } = req.body;

        // Basic validation for required fields (adjust as necessary)
        if (!QuoteID || !StyleNumber || Quantity === undefined) {
            return res.status(400).json({ error: 'Missing required fields: QuoteID, StyleNumber, and Quantity are required.' });
        }

        const recordData = {
            QuoteID,
            LineNumber: LineNumber !== undefined ? LineNumber : null,
            StyleNumber,
            ProductName: ProductName || null,
            Color: Color || null,
            ColorCode: ColorCode || null,
            EmbellishmentType: EmbellishmentType || null,
            PrintLocation: PrintLocation || null,
            PrintLocationName: PrintLocationName || null,
            Quantity,
            HasLTM: HasLTM || null,
            BaseUnitPrice: BaseUnitPrice !== undefined ? BaseUnitPrice : null,
            LTMPerUnit: LTMPerUnit !== undefined ? LTMPerUnit : null,
            FinalUnitPrice: FinalUnitPrice !== undefined ? FinalUnitPrice : null,
            LineTotal: LineTotal !== undefined ? LineTotal : null,
            SizeBreakdown: SizeBreakdown || null, // Expected to be a JSON string
            PricingTier: PricingTier || null,
            ImageURL: ImageURL || null,
            AddedAt: new Date().toISOString() // Set AddedAt timestamp
            // ItemID removed - no longer exists in the table
        };
        
        console.log(`Creating new Quote_Items record: ${JSON.stringify(recordData)}`);
        const resource = '/tables/Quote_Items/records';
        
        const token = await getCaspioAccessToken();
        const url = `${caspioApiBaseUrl}${resource}`;
        
        const requestConfig = {
            method: 'post',
            url: url,
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json'
            },
            data: recordData,
            timeout: 15000
        };
        
        const response = await axios(requestConfig);
        
        console.log(`Quote_Items record created successfully: ${response.status}`);
        // Caspio POST response usually includes the created record with its auto-generated IDs
        res.status(201).json(response.data); 
    } catch (error) {
        console.error("Error creating Quote_Items record:", error.response ? JSON.stringify(error.response.data) : error.message, error.stack);
        res.status(500).json({ error: 'Failed to create Quote_Items record.' });
    }
});

// PUT: /api/quote_items/:id - Update a quote item by PK_ID
app.put('/api/quote_items/:id', express.json(), async (req, res) => {
    const { id } = req.params;
     if (!id || isNaN(parseInt(id))) {
        return res.status(400).json({ error: 'Missing or invalid required parameter: id (must be a number for PK_ID)' });
    }
    
    try {
        const updateData = { ...req.body };
        // Remove fields that should not be updated directly or are auto-managed
        delete updateData.PK_ID;
        // ItemID removed - no longer exists in the table
        delete updateData.AddedAt; // AddedAt should not be updated

        if (Object.keys(updateData).length === 0) {
            return res.status(400).json({ error: 'No fields provided for update.' });
        }

        console.log(`Updating Quote_Items record with PK_ID: ${id} with data: ${JSON.stringify(updateData)}`);
        const resource = `/tables/Quote_Items/records?q.where=PK_ID=${id}`;
        
        const token = await getCaspioAccessToken();
        const url = `${caspioApiBaseUrl}${resource}`;
        
        const requestConfig = {
            method: 'put',
            url: url,
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json'
            },
            data: updateData,
            timeout: 15000
        };
        
        const response = await axios(requestConfig);
        
        console.log(`Quote_Items record updated successfully: ${response.status}`);
        
        if (response.data && response.data.RecordsAffected > 0) {
             // Fetch the updated record to return it
            const fetchParams = { 'q.where': `PK_ID=${id}`, 'q.limit': 1 };
            const updatedRecord = await fetchAllCaspioPages('/tables/Quote_Items/records', fetchParams);
            if (updatedRecord && updatedRecord.length > 0) {
                res.json(updatedRecord[0]);
            } else {
                // This case should ideally not happen if RecordsAffected > 0
                res.json({ message: `Quote_Items record with PK_ID ${id} updated. Record not found after update.` });
            }
        } else if (response.data && response.data.RecordsAffected === 0) {
            return res.status(404).json({ error: `Quote_Items record with PK_ID ${id} not found or no changes made.` });
        } else {
            // Fallback for unexpected Caspio response
            res.json(response.data);
        }

    } catch (error) {
        console.error("Error updating Quote_Items record:", error.response ? JSON.stringify(error.response.data) : error.message, error.stack);
        res.status(500).json({ error: 'Failed to update Quote_Items record.' });
    }
});

// DELETE: /api/quote_items/:id - Delete a quote item by PK_ID
app.delete('/api/quote_items/:id', async (req, res) => {
    const { id } = req.params;
    if (!id || isNaN(parseInt(id))) {
        return res.status(400).json({ error: 'Missing or invalid required parameter: id (must be a number for PK_ID)' });
    }
    
    try {
        console.log(`Deleting Quote_Items record with PK_ID: ${id}`);
        const resource = `/tables/Quote_Items/records?q.where=PK_ID=${id}`;
        
        const token = await getCaspioAccessToken();
        const url = `${caspioApiBaseUrl}${resource}`;
        
        const requestConfig = {
            method: 'delete',
            url: url,
            headers: {
                'Authorization': `Bearer ${token}`
            },
            timeout: 15000
        };
        
        const response = await axios(requestConfig);
        
        console.log(`Quote_Items record deleted successfully: ${response.status}`);
        if (response.data && response.data.RecordsAffected > 0) {
            res.status(204).send(); // No Content
        } else {
            return res.status(404).json({ error: `Quote_Items record with PK_ID ${id} not found.` });
        }
    } catch (error) {
        console.error("Error deleting Quote_Items record:", error.response ? JSON.stringify(error.response.data) : error.message, error.stack);
        res.status(500).json({ error: 'Failed to delete Quote_Items record.' });
    }
});
// --- NEW Endpoint: Quote_Sessions CRUD Operations ---
// Table Name: Quote_Sessions
// Primary Key Field: PK_ID

// GET: /api/quote_sessions - Get all quote sessions or filter by query parameters
app.get('/api/quote_sessions', async (req, res) => {
    try {
        console.log("Fetching Quote_Sessions records");
        const resource = '/tables/Quote_Sessions/records';
        const params = {
            'q.orderby': 'PK_ID DESC', // Most recent records first
            'q.limit': 1000 // Default limit, fetchAllCaspioPages handles pagination
        };

        const whereConditions = [];
        if (req.query.SessionID) {
            whereConditions.push(`SessionID='${req.query.SessionID}'`);
        }
        if (req.query.QuoteID) {
            whereConditions.push(`QuoteID='${req.query.QuoteID}'`);
        }
        if (req.query.CustomerEmail) {
            whereConditions.push(`CustomerEmail='${req.query.CustomerEmail}'`);
        }
        if (req.query.Status) {
            whereConditions.push(`Status='${req.query.Status}'`);
        }
        // Add other potential filters here if needed

        if (whereConditions.length > 0) {
            params['q.where'] = whereConditions.join(' AND ');
        }
        
        console.log(`Fetching Quote_Sessions with params: ${JSON.stringify(params)}`);
        const result = await fetchAllCaspioPages(resource, params);
        console.log(`Found ${result.length} Quote_Sessions records`);
        res.json(result);
    } catch (error) {
        console.error("Error fetching Quote_Sessions records:", error.message, error.stack);
        res.status(500).json({ error: 'Failed to fetch Quote_Sessions records.' });
    }
});

// GET: /api/quote_sessions/:id - Get a specific quote session by PK_ID
app.get('/api/quote_sessions/:id', async (req, res) => {
    const { id } = req.params;
    if (!id || isNaN(parseInt(id))) {
        return res.status(400).json({ error: 'Missing or invalid required parameter: id (must be a number for PK_ID)' });
    }
    
    try {
        console.log(`Fetching Quote_Sessions record with PK_ID: ${id}`);
        const resource = '/tables/Quote_Sessions/records';
        const params = {
            'q.where': `PK_ID=${id}`,
            'q.limit': 1
        };
        
        const result = await fetchAllCaspioPages(resource, params);
        
        if (!result || result.length === 0) {
            return res.status(404).json({ error: `Quote_Sessions record with PK_ID ${id} not found` });
        }
        
        res.json(result[0]);
    } catch (error) {
        console.error(`Error fetching Quote_Sessions record with PK_ID ${id}:`, error.message, error.stack);
        res.status(500).json({ error: 'Failed to fetch Quote_Sessions record.' });
    }
});

// POST: /api/quote_sessions - Create a new quote session
app.post('/api/quote_sessions', express.json(), async (req, res) => {
    try {
        const {
            QuoteID, SessionID, CustomerEmail, CustomerName, CompanyName, Phone,
            TotalQuantity, SubtotalAmount, LTMFeeTotal, TotalAmount, Status,
            ExpiresAt, Notes
            // PK_ID is auto-generated
            // CreatedAt, UpdatedAt will be set by the server
        } = req.body;

        // Basic validation for required fields (adjust as necessary)
        if (!QuoteID || !SessionID || !Status) {
            return res.status(400).json({ error: 'Missing required fields: QuoteID, SessionID, and Status are required.' });
        }

        const now = new Date().toISOString();
        const recordData = {
            QuoteID,
            SessionID,
            CustomerEmail: CustomerEmail || null,
            CustomerName: CustomerName || null,
            CompanyName: CompanyName || null,
            Phone: Phone || null,
            TotalQuantity: TotalQuantity !== undefined ? TotalQuantity : null,
            SubtotalAmount: SubtotalAmount !== undefined ? SubtotalAmount : null,
            LTMFeeTotal: LTMFeeTotal !== undefined ? LTMFeeTotal : null,
            TotalAmount: TotalAmount !== undefined ? TotalAmount : null,
            Status,
            CreatedAt: now,
            UpdatedAt: now,
            ExpiresAt: ExpiresAt || null,
            Notes: Notes || null
        };
        
        console.log(`Creating new Quote_Sessions record: ${JSON.stringify(recordData)}`);
        const resource = '/tables/Quote_Sessions/records';
        
        const token = await getCaspioAccessToken();
        const url = `${caspioApiBaseUrl}${resource}`;
        
        const requestConfig = {
            method: 'post',
            url: url,
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json'
            },
            data: recordData,
            timeout: 15000
        };
        
        const response = await axios(requestConfig);
        
        console.log(`Quote_Sessions record created successfully: ${response.status}`);
        // Caspio POST response usually includes the created record with its auto-generated PK_ID
        res.status(201).json(response.data); 
    } catch (error) {
        console.error("Error creating Quote_Sessions record:", error.response ? JSON.stringify(error.response.data) : error.message, error.stack);
        res.status(500).json({ error: 'Failed to create Quote_Sessions record.' });
    }
});

// PUT: /api/quote_sessions/:id - Update a quote session by PK_ID
app.put('/api/quote_sessions/:id', express.json(), async (req, res) => {
    const { id } = req.params;
     if (!id || isNaN(parseInt(id))) {
        return res.status(400).json({ error: 'Missing or invalid required parameter: id (must be a number for PK_ID)' });
    }
    
    try {
        const updatePayload = { ...req.body };
        // Fields that should not be updated by the client or are auto-managed
        delete updatePayload.PK_ID;
        delete updatePayload.QuoteID;    // Typically not changed after creation
        delete updatePayload.SessionID; // Typically not changed after creation
        delete updatePayload.CreatedAt; // Should not be changed

        if (Object.keys(updatePayload).length === 0) {
            return res.status(400).json({ error: 'No fields provided for update.' });
        }

        updatePayload.UpdatedAt = new Date().toISOString(); // Always update UpdatedAt timestamp

        console.log(`Updating Quote_Sessions record with PK_ID: ${id} with data: ${JSON.stringify(updatePayload)}`);
        const resource = `/tables/Quote_Sessions/records?q.where=PK_ID=${id}`;
        
        const token = await getCaspioAccessToken();
        const url = `${caspioApiBaseUrl}${resource}`;
        
        const requestConfig = {
            method: 'put',
            url: url,
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json'
            },
            data: updatePayload,
            timeout: 15000
        };
        
        const response = await axios(requestConfig);
        
        console.log(`Quote_Sessions record updated successfully: ${response.status}`);
        
        if (response.data && response.data.RecordsAffected > 0) {
             // Fetch the updated record to return it
            const fetchParams = { 'q.where': `PK_ID=${id}`, 'q.limit': 1 };
            const updatedRecord = await fetchAllCaspioPages('/tables/Quote_Sessions/records', fetchParams);
            if (updatedRecord && updatedRecord.length > 0) {
                res.json(updatedRecord[0]);
            } else {
                res.json({ message: `Quote_Sessions record with PK_ID ${id} updated. Record not found after update.` });
            }
        } else if (response.data && response.data.RecordsAffected === 0) {
            return res.status(404).json({ error: `Quote_Sessions record with PK_ID ${id} not found or no changes made.` });
        } else {
            res.json(response.data); // Fallback for unexpected Caspio response
        }

    } catch (error) {
        console.error("Error updating Quote_Sessions record:", error.response ? JSON.stringify(error.response.data) : error.message, error.stack);
        res.status(500).json({ error: 'Failed to update Quote_Sessions record.' });
    }
});

// DELETE: /api/quote_sessions/:id - Delete a quote session by PK_ID
app.delete('/api/quote_sessions/:id', async (req, res) => {
    const { id } = req.params;
    if (!id || isNaN(parseInt(id))) {
        return res.status(400).json({ error: 'Missing or invalid required parameter: id (must be a number for PK_ID)' });
    }
    
    try {
        console.log(`Deleting Quote_Sessions record with PK_ID: ${id}`);
        const resource = `/tables/Quote_Sessions/records?q.where=PK_ID=${id}`;
        
        const token = await getCaspioAccessToken();
        const url = `${caspioApiBaseUrl}${resource}`;
        
        const requestConfig = {
            method: 'delete',
            url: url,
            headers: {
                'Authorization': `Bearer ${token}`
            },
            timeout: 15000
        };
        
        const response = await axios(requestConfig);
        
        console.log(`Quote_Sessions record deleted successfully: ${response.status}`);
        if (response.data && response.data.RecordsAffected > 0) {
            res.status(204).send(); // No Content
        } else {
            return res.status(404).json({ error: `Quote_Sessions record with PK_ID ${id} not found.` });
        }
    } catch (error) {
        console.error("Error deleting Quote_Sessions record:", error.response ? JSON.stringify(error.response.data) : error.message, error.stack);
        res.status(500).json({ error: 'Failed to delete Quote_Sessions record.' });
    }
});

// --- END Quote_Sessions CRUD Operations ---

// --- UPDATED Endpoint: Product Colors (Refactored to use Live Caspio Data) ---
// Example: /api/product-colors?styleNumber=PC61
app.get('/api/product-colors', async (req, res) => {
    const { styleNumber } = req.query;

    if (!styleNumber) {
        return res.status(400).json({ error: 'Missing required query parameter: styleNumber' });
    }

    try {
        // Add debug logging
        console.log(`DEBUG: Processing request for product colors with styleNumber: ${styleNumber}`);
        
        // First, try to get product info from Sanmar_Bulk table
        const resourcePath = '/tables/Sanmar_Bulk_251816_Feb2024/records';
        
        // Use an EXACT match for the style number to avoid fetching related styles (e.g., LPC61 when PC61 is requested)
        const params = {
            'q.where': `STYLE='${styleNumber.trim()}'`, // Use exact match
            'q.select': 'STYLE, PRODUCT_TITLE, PRODUCT_DESCRIPTION, COLOR_NAME, CATALOG_COLOR, COLOR_SQUARE_IMAGE, FRONT_MODEL, FRONT_FLAT, BACK_MODEL, SIDE_MODEL, THREE_Q_MODEL, BACK_FLAT, DECORATION_SPEC_SHEET, BRAND_LOGO_IMAGE, SPEC_SHEET, AVAILABLE_SIZES, BRAND_NAME, CATEGORY_NAME, SUBCATEGORY_NAME, MSRP, CASE_PRICE, PRODUCT_STATUS',
            'q.limit': 1000 // fetchAllCaspioPages handles pagination, this is per-page limit
        };

        console.log(`DEBUG: Query params for Caspio: ${JSON.stringify(params)}`);
        console.log(`Fetching product colors for styleNumber: ${styleNumber} from Caspio.`);
        
        const records = await fetchAllCaspioPages(resourcePath, params);
        console.log(`DEBUG: Received ${records ? records.length : 0} records from Caspio for exact style match.`);
        
        // If no records found for the exact style, return empty result
        if (!records || records.length === 0) {
            console.log(`No product color data found for exact styleNumber: ${styleNumber}`);
            return res.json({
                productTitle: `Product ${styleNumber}`,
                PRODUCT_DESCRIPTION: "Sample product description.",
                styleNumber: styleNumber,
                AVAILABLE_SIZES: "",
                BRAND_NAME: "",
                CATEGORY_NAME: "",
                SUBCATEGORY_NAME: "",
                PRODUCT_STATUS: "",
                basePriceRange: "",
                MSRP: null,
                colors: []
            });
        }
        
        // Process the records (which are now guaranteed to be for the correct style)
        return processProductColorRecords(records, styleNumber, res);
    } catch (error) {
        console.error(`Error fetching product colors for styleNumber ${styleNumber}:`, error.response ? JSON.stringify(error.response.data) : error.message);
        res.status(500).json({ error: `Failed to fetch product colors. ${error.message}` });
    }
});

// Helper function to process product color records
function processProductColorRecords(records, styleNumber, res) {
    if (!records || records.length === 0) {
        console.log(`No product color data found for styleNumber: ${styleNumber}`);
        return res.json({
            productTitle: `Product ${styleNumber}`,
            PRODUCT_DESCRIPTION: "Sample product description.",
            styleNumber: styleNumber,
            AVAILABLE_SIZES: "",
            BRAND_NAME: "",
            CATEGORY_NAME: "",
            SUBCATEGORY_NAME: "",
            PRODUCT_STATUS: "",
            basePriceRange: "",
            MSRP: null,
            colors: []
        });
    }

    // Debug: Log the first record to see its structure
    console.log(`DEBUG: First record structure: ${JSON.stringify(records[0])}`);
    
    const productTitle = records[0]?.PRODUCT_TITLE || `Product ${styleNumber}`;
    const productDescription = records[0]?.PRODUCT_DESCRIPTION || "Sample product description.";
    
    // Extract new fields from the first record
    const availableSizes = records[0]?.AVAILABLE_SIZES || "";
    const brandName = records[0]?.BRAND_NAME || "";
    const categoryName = records[0]?.CATEGORY_NAME || "";
    const subcategoryName = records[0]?.SUBCATEGORY_NAME || "";
    const productStatus = records[0]?.PRODUCT_STATUS || "";
    const msrp = records[0]?.MSRP || null;
    
    // Calculate price range from all CASE_PRICE values
    let minPrice = Number.MAX_VALUE;
    let maxPrice = 0;
    
    records.forEach(record => {
        if (record.CASE_PRICE && !isNaN(parseFloat(record.CASE_PRICE))) {
            const price = parseFloat(record.CASE_PRICE);
            if (price < minPrice) minPrice = price;
            if (price > maxPrice) maxPrice = price;
        }
    });
    
    let basePriceRange = "";
    if (minPrice !== Number.MAX_VALUE && maxPrice > 0) {
        if (minPrice === maxPrice) {
            basePriceRange = `$${minPrice.toFixed(2)}`;
        } else {
            basePriceRange = `$${minPrice.toFixed(2)} - $${maxPrice.toFixed(2)}`;
        }
    }
    
    const colorsMap = new Map();

    for (const record of records) {
        // Skip records without color information
        if (!record.COLOR_NAME && !record.CATALOG_COLOR) {
            console.log(`DEBUG: Skipping record without color information: ${JSON.stringify(record)}`);
            continue;
        }
        
        const colorName = record.COLOR_NAME || record.CATALOG_COLOR || '';
        
        // Skip if we've already processed this color
        if (colorName && !colorsMap.has(colorName)) {
            // Get the color square image (required)
            const colorSquareImage = record.COLOR_SQUARE_IMAGE || '';
            
            // Get the main image URL following the priority order:
            // 1. MAIN_IMAGE_URL (preferred)
            // 2. FRONT_MODEL (fallback)
            // 3. FRONT_FLAT (fallback)
            const mainImageUrl = record.MAIN_IMAGE_URL || record.FRONT_MODEL || record.FRONT_FLAT || '';
            
            // Base URL for SanMar images
            const baseImageUrl = "https://cdnm.sanmar.com/imglib/mresjpg/";
            
            // Function to ensure complete URLs
            const ensureCompleteUrl = (url) => {
                if (!url) return '';
                if (url.startsWith('http')) return url;
                
                // For SanMar images, we need to add the full path
                // Most images are in the format: https://cdnm.sanmar.com/imglib/mresjpg/YYYY/fXX/STYLE_COLOR_type_etc.jpg
                // If the URL already has a year/folder structure (like 2020/f14/), just add the base domain
                if (url.includes('/')) {
                    return `${baseImageUrl}${url}`;
                }
                
                // For images without a year/folder prefix, we'll use a default path
                return `${baseImageUrl}2016/f17/${url}`;
            };
            
            // Create the color object with all required fields
            const colorObject = {
                COLOR_NAME: colorName,
                CATALOG_COLOR: record.CATALOG_COLOR || colorName,
                COLOR_SQUARE_IMAGE: ensureCompleteUrl(record.COLOR_SQUARE_IMAGE || ''),
                MAIN_IMAGE_URL: ensureCompleteUrl(record.MAIN_IMAGE_URL || record.FRONT_MODEL || record.FRONT_FLAT || ''),
                FRONT_MODEL_IMAGE_URL: ensureCompleteUrl(record.FRONT_MODEL || ''), // Match the field name in the response
                FRONT_MODEL: ensureCompleteUrl(record.FRONT_MODEL || ''), // Keep original for backward compatibility
                FRONT_FLAT: ensureCompleteUrl(record.FRONT_FLAT || ''),
                // Add the new image fields here with complete URLs:
                BACK_MODEL: ensureCompleteUrl(record.BACK_MODEL || ''),
                SIDE_MODEL: ensureCompleteUrl(record.SIDE_MODEL || ''),
                THREE_Q_MODEL: ensureCompleteUrl(record.THREE_Q_MODEL || ''),
                BACK_FLAT: ensureCompleteUrl(record.BACK_FLAT || ''),
                // Add the additional fields:
                DECORATION_SPEC_SHEET: record.DECORATION_SPEC_SHEET || '',
                BRAND_LOGO_IMAGE: record.BRAND_LOGO_IMAGE || '',
                SPEC_SHEET: record.SPEC_SHEET || ''
            };
            
            colorsMap.set(colorName, colorObject);
            
            console.log(`DEBUG: Added color: ${colorName} with image: ${colorSquareImage.substring(0, 30)}...`);
        }
    }

    const colorsArray = Array.from(colorsMap.values());
    
    // Sort colors alphabetically by COLOR_NAME for consistent output
    colorsArray.sort((a, b) => {
        if (a.COLOR_NAME && b.COLOR_NAME) {
            return a.COLOR_NAME.localeCompare(b.COLOR_NAME);
        }
        return 0;
    });

    console.log(`Returning ${colorsArray.length} unique colors for styleNumber: ${styleNumber}`);
    
    return res.json({
        productTitle: productTitle,
        PRODUCT_DESCRIPTION: productDescription,
        styleNumber: styleNumber,
        AVAILABLE_SIZES: availableSizes,
        BRAND_NAME: brandName,
        CATEGORY_NAME: categoryName,
        SUBCATEGORY_NAME: subcategoryName,
        PRODUCT_STATUS: productStatus,
        basePriceRange: basePriceRange,
        MSRP: msrp,
        colors: colorsArray
    });
}

// Get Production Schedules
// Example: /api/production-schedules
// Example: /api/production-schedules?q.where=Date>'2021-08-01'
// Example: /api/production-schedules?q.orderBy=Date DESC&q.limit=50
app.get('/api/production-schedules', async (req, res) => {
    console.log(`GET /api/production-schedules requested with params:`, req.query);
    
    try {
        const resource = '/tables/Production_Schedules/records';
        const params = {};
        
        // Handle query parameters
        if (req.query['q.where']) {
            params['q.where'] = req.query['q.where'];
        }
        
        if (req.query['q.orderBy']) {
            params['q.orderby'] = req.query['q.orderBy']; // Note: Caspio uses lowercase 'orderby'
        }
        
        if (req.query['q.limit']) {
            // Validate limit is within allowed range
            const limit = parseInt(req.query['q.limit']);
            if (isNaN(limit) || limit < 1) {
                return res.status(400).json({ error: 'Invalid limit parameter. Must be a positive integer.' });
            }
            if (limit > 1000) {
                return res.status(400).json({ error: 'Limit parameter cannot exceed 1000.' });
            }
            params['q.limit'] = limit;
        } else {
            // Default limit
            params['q.limit'] = 100;
        }
        
        // Use fetchAllCaspioPages to handle pagination
        const result = await fetchAllCaspioPages(resource, params);
        console.log(`Found ${result.length} production schedule records`);
        
        res.json(result);
    } catch (error) {
        console.error("Error fetching production schedules:", error.message);
        res.status(500).json({ error: 'Failed to fetch production schedules.' });
    }
});

// Get Order ODBC Records
// Example: /api/order-odbc
// Example: /api/order-odbc?q.where=id_Customer=11824
// Example: /api/order-odbc?q.where=date_OrderInvoiced>'2021-03-01'&q.orderBy=date_OrderInvoiced DESC
// Example: /api/order-odbc?q.where=sts_Shipped=0&q.limit=50
// MOVED TO src/routes/orders.js
/*
app.get('/api/order-odbc', async (req, res) => {
    console.log(`GET /api/order-odbc requested with params:`, req.query);
    
    try {
        const resource = '/tables/ORDER_ODBC/records';
        const params = {};
        
        // Handle query parameters
        if (req.query['q.where']) {
            params['q.where'] = req.query['q.where'];
        }
        
        if (req.query['q.orderBy']) {
            params['q.orderby'] = req.query['q.orderBy']; // Note: Caspio uses lowercase 'orderby'
        }
        
        if (req.query['q.limit']) {
            // Validate limit is within allowed range
            const limit = parseInt(req.query['q.limit']);
            if (isNaN(limit) || limit < 1) {
                return res.status(400).json({ error: 'Invalid limit parameter. Must be a positive integer.' });
            }
            if (limit > 1000) {
                return res.status(400).json({ error: 'Limit parameter cannot exceed 1000.' });
            }
            params['q.limit'] = limit;
        } else {
            // Default limit
            params['q.limit'] = 100;
        }
        
        // Use fetchAllCaspioPages to handle pagination
        const result = await fetchAllCaspioPages(resource, params);
        console.log(`Found ${result.length} order records`);
        
        res.json(result);
    } catch (error) {
        console.error("Error fetching order records:", error.message);
        res.status(500).json({ error: 'Failed to fetch order records.' });
    }
});
*/

// --- Order Dashboard Endpoint ---
// MOVED TO src/routes/orders.js
/*
// Parameter-aware in-memory cache for dashboard data
const dashboardCache = new Map();

app.get('/api/order-dashboard', async (req, res) => {
    console.log(`GET /api/order-dashboard requested with params:`, req.query);
    
    try {
        // Parse parameters first
        const days = parseInt(req.query.days) || 7;
        const includeDetails = req.query.includeDetails === 'true';
        const compareYoY = req.query.compareYoY === 'true';
        
        // Create cache key based on parameters
        const cacheKey = `days:${days}-details:${includeDetails}-yoy:${compareYoY}`;
        
        // Check cache (60 seconds)
        const now = Date.now();
        const cachedEntry = dashboardCache.get(cacheKey);
        if (cachedEntry && now - cachedEntry.timestamp < 60000) {
            console.log(`Returning cached dashboard data for ${cacheKey}`);
            return res.json(cachedEntry.data);
        }
        
        // Calculate date range
        const endDate = new Date();
        const startDate = new Date();
        startDate.setDate(startDate.getDate() - days);
        
        // Format dates for Caspio (YYYY-MM-DD)
        const formatDate = (date) => date.toISOString().split('T')[0];
        
        // Fetch orders in date range
        const whereClause = `date_OrderInvoiced>='${formatDate(startDate)}' AND date_OrderInvoiced<='${formatDate(endDate)}'`;
        console.log(`Fetching orders with whereClause: ${whereClause}`);
        
        const orders = await fetchAllCaspioPages('/tables/ORDER_ODBC/records', {
            'q.where': whereClause,
            'q.limit': 1000,
            'q.orderby': 'date_OrderInvoiced DESC'
        });
        
        console.log(`Found ${orders.length} orders in the last ${days} days`);
        
        // Calculate summary metrics
        const summary = {
            totalOrders: orders.length,
            totalSales: orders.reduce((sum, order) => sum + (parseFloat(order.cur_Subtotal) || 0), 0),
            notInvoiced: orders.filter(order => order.sts_Invoiced === 0).length,
            notShipped: orders.filter(order => order.sts_Shipped === 0).length,
            avgOrderValue: 0
        };
        
        // Calculate average order value
        if (summary.totalOrders > 0) {
            summary.avgOrderValue = summary.totalSales / summary.totalOrders;
        }
        
        // Calculate date range info
        const dateRange = {
            start: formatDate(startDate) + 'T00:00:00Z',
            end: formatDate(endDate) + 'T23:59:59Z',
            mostRecentOrder: null
        };
        
        if (orders.length > 0) {
            dateRange.mostRecentOrder = orders[0].date_OrderInvoiced;
        }
        
        // CSR name normalization mapping
        const csrNameMap = {
            'Ruth  Nhoung': 'Ruthie Nhoung',  // Ruth with 2 spaces
            'Ruth Nhoung': 'Ruthie Nhoung',   // Ruth with 1 space
            'ruth': 'Ruthie Nhoung',           // Lowercase ruth
            'House ': 'House Account',         // House with trailing space
            'House': 'House Account',          // House without space
            'Unknown': 'Unassigned',           // Make it clearer
            // Add more mappings as needed
        };
        
        // Function to normalize CSR names
        const normalizeCSRName = (name) => {
            return csrNameMap[name] || name;
        };
        
        // Group by CSR with name normalization
        const csrMap = {};
        orders.forEach(order => {
            const originalCsr = order.CustomerServiceRep || 'Unknown';
            const csr = normalizeCSRName(originalCsr);
            if (!csrMap[csr]) {
                csrMap[csr] = { name: csr, orders: 0, sales: 0 };
            }
            csrMap[csr].orders++;
            csrMap[csr].sales += parseFloat(order.cur_Subtotal) || 0;
        });
        
        const byCsr = Object.values(csrMap)
            .sort((a, b) => b.sales - a.sales)
            .map(csr => ({
                name: csr.name,
                orders: csr.orders,
                sales: parseFloat(csr.sales.toFixed(2))
            }));
        
        // Order Type normalization mapping
        const orderTypeMap = {
            'Wow Embroidery': 'WOW',
            'Sample Return to Vendor': 'Sample Returns',
            'Inksoft': 'Webstores',
            '77 Account': 'Samples',
            'Digital Printing': 'DTG',
            'Transfers': 'DTF',
            'Shopify': '253GEAR',
            // Add more mappings as needed
        };
        
        // Function to normalize Order Types
        const normalizeOrderType = (type) => {
            return orderTypeMap[type] || type;
        };
        
        // Group by Order Type with normalization
        const typeMap = {};
        orders.forEach(order => {
            const originalType = order.ORDER_TYPE || 'Unknown';
            const type = normalizeOrderType(originalType);
            if (!typeMap[type]) {
                typeMap[type] = { type: type, orders: 0, sales: 0 };
            }
            typeMap[type].orders++;
            typeMap[type].sales += parseFloat(order.cur_Subtotal) || 0;
        });
        
        const byOrderType = Object.values(typeMap)
            .sort((a, b) => b.sales - a.sales)
            .map(type => ({
                type: type.type,
                orders: type.orders,
                sales: parseFloat(type.sales.toFixed(2))
            }));
        
        // Calculate today's stats
        const today = new Date();
        const todayStr = formatDate(today);
        const todayOrders = orders.filter(order => 
            order.date_OrderInvoiced && order.date_OrderInvoiced.startsWith(todayStr)
        );
        
        const todayStats = {
            ordersToday: todayOrders.length,
            salesToday: todayOrders.reduce((sum, order) => sum + (parseFloat(order.cur_Subtotal) || 0), 0),
            shippedToday: todayOrders.filter(order => order.sts_Shipped === 1).length
        };
        
        // Round sales values to 2 decimal places
        summary.totalSales = parseFloat(summary.totalSales.toFixed(2));
        summary.avgOrderValue = parseFloat(summary.avgOrderValue.toFixed(2));
        todayStats.salesToday = parseFloat(todayStats.salesToday.toFixed(2));
        
        // Build response
        const response = {
            summary,
            dateRange,
            breakdown: {
                byCsr,
                byOrderType
            },
            todayStats
        };
        
        // Add recent orders if requested
        if (includeDetails) {
            response.recentOrders = orders.slice(0, 10).map(order => ({
                ID_Order: order.ID_Order,
                date_OrderInvoiced: order.date_OrderInvoiced,
                CompanyName: order.CompanyName,
                CustomerServiceRep: order.CustomerServiceRep,
                ORDER_TYPE: order.ORDER_TYPE,
                cur_Subtotal: parseFloat(order.cur_Subtotal) || 0,
                sts_Invoiced: order.sts_Invoiced,
                sts_Shipped: order.sts_Shipped
            }));
        }
        
        // Add year-over-year comparison if requested
        if (compareYoY) {
            console.log('Calculating year-over-year comparison...');
            
            // Calculate year-to-date ranges
            const currentYear = new Date();
            const currentYearStart = new Date(currentYear.getFullYear(), 0, 1); // Jan 1 of current year
            
            const lastYear = new Date();
            lastYear.setFullYear(lastYear.getFullYear() - 1);
            const lastYearStart = new Date(lastYear.getFullYear(), 0, 1); // Jan 1 of last year
            const lastYearEnd = new Date(lastYear.getFullYear(), lastYear.getMonth(), lastYear.getDate()); // Same day last year
            
            // Format dates for Caspio
            const currentYearWhereClause = `date_OrderInvoiced>='${formatDate(currentYearStart)}' AND date_OrderInvoiced<='${formatDate(currentYear)}'`;
            const lastYearWhereClause = `date_OrderInvoiced>='${formatDate(lastYearStart)}' AND date_OrderInvoiced<='${formatDate(lastYearEnd)}'`;
            
            console.log(`Current year range: ${formatDate(currentYearStart)} to ${formatDate(currentYear)}`);
            console.log(`Last year range: ${formatDate(lastYearStart)} to ${formatDate(lastYearEnd)}`);
            
            // Fetch last year's data - chunk by month for reliability
            console.log('Fetching last year YTD data in chunks by month...');
            
            // Helper function to get last day of month
            const getLastDayOfMonth = (year, month) => {
                return new Date(year, month, 0).getDate();
            };
            
            let lastYearOrders = [];
            let lastYearTotalByMonth = {};
            
            // Fetch each month separately (up to same month as current date)
            const lastYearNum = lastYear.getFullYear();
            const endMonth = lastYear.getMonth() + 1; // July = 7
            
            for (let month = 1; month <= endMonth; month++) {
                const monthStart = `${lastYearNum}-${month.toString().padStart(2, '0')}-01`;
                let monthEnd;
                
                if (month === endMonth) {
                    // For the final month, only go up to the same day as current year
                    monthEnd = formatDate(lastYearEnd);
                } else {
                    // For other months, get the full month
                    const lastDay = getLastDayOfMonth(lastYearNum, month);
                    monthEnd = `${lastYearNum}-${month.toString().padStart(2, '0')}-${lastDay}`;
                }
                
                console.log(`Fetching ${lastYearNum} ${getMonthName(month)} (${monthStart} to ${monthEnd})...`);
                
                try {
                    const monthOrders = await fetchAllCaspioPages('/tables/ORDER_ODBC/records', {
                        'q.where': `date_OrderInvoiced>='${monthStart}' AND date_OrderInvoiced<='${monthEnd}' AND sts_Invoiced=1`,
                        'q.limit': 1000,
                        'q.select': 'ID_Order,cur_Subtotal,date_OrderInvoiced,ORDER_TYPE,sts_Invoiced',
                        'q.orderby': 'ID_Order DESC'
                    }, { maxPages: 2 }); // Allow up to 2000 per month (safety margin)
                    
                    console.log(`  Found ${monthOrders.length} orders in ${getMonthName(month)} ${lastYearNum}`);
                    lastYearTotalByMonth[getMonthName(month)] = monthOrders.length;
                    lastYearOrders = lastYearOrders.concat(monthOrders);
                } catch (error) {
                    console.error(`  Error fetching ${getMonthName(month)} orders:`, error.message);
                }
            }
            
            console.log(`Last year total fetched: ${lastYearOrders.length} records`);
            
            // Helper function for month names
            function getMonthName(monthNum) {
                const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
                return months[monthNum - 1];
            }
            
            // Remove duplicates based on ID_Order
            const uniqueLastYearOrders = Array.from(
                new Map(lastYearOrders.map(order => [order.ID_Order, order])).values()
            );
            console.log(`Fetched ${lastYearOrders.length} records, ${uniqueLastYearOrders.length} unique orders from last year YTD`);
            
            // Fetch current year's data - chunk by month for reliability
            console.log('Fetching current year YTD data in chunks by month...');
            
            let currentYearOrders = [];
            let currentYearTotalByMonth = {};
            
            // Fetch each month separately (up to current month)
            const currentYearNum = currentYear.getFullYear();
            const currentEndMonth = currentYear.getMonth() + 1; // July = 7
            
            for (let month = 1; month <= currentEndMonth; month++) {
                const monthStart = `${currentYearNum}-${month.toString().padStart(2, '0')}-01`;
                let monthEnd;
                
                if (month === currentEndMonth) {
                    // For the current month, only go up to today
                    monthEnd = formatDate(currentYear);
                } else {
                    // For previous months, get the full month
                    const lastDay = getLastDayOfMonth(currentYearNum, month);
                    monthEnd = `${currentYearNum}-${month.toString().padStart(2, '0')}-${lastDay}`;
                }
                
                console.log(`Fetching ${currentYearNum} ${getMonthName(month)} (${monthStart} to ${monthEnd})...`);
                
                try {
                    const monthOrders = await fetchAllCaspioPages('/tables/ORDER_ODBC/records', {
                        'q.where': `date_OrderInvoiced>='${monthStart}' AND date_OrderInvoiced<='${monthEnd}' AND sts_Invoiced=1`,
                        'q.limit': 1000,
                        'q.select': 'ID_Order,cur_Subtotal,date_OrderInvoiced,ORDER_TYPE,sts_Invoiced',
                        'q.orderby': 'ID_Order DESC'
                    }, { maxPages: 2 }); // Allow up to 2000 per month (safety margin)
                    
                    console.log(`  Found ${monthOrders.length} orders in ${getMonthName(month)} ${currentYearNum}`);
                    currentYearTotalByMonth[getMonthName(month)] = monthOrders.length;
                    currentYearOrders = currentYearOrders.concat(monthOrders);
                } catch (error) {
                    console.error(`  Error fetching ${getMonthName(month)} orders:`, error.message);
                }
            }
            
            console.log(`Current year total fetched: ${currentYearOrders.length} records`);
            
            // Remove duplicates based on ID_Order
            const uniqueCurrentYearOrders = Array.from(
                new Map(currentYearOrders.map(order => [order.ID_Order, order])).values()
            );
            console.log(`Fetched ${currentYearOrders.length} records, ${uniqueCurrentYearOrders.length} unique orders from current year YTD`);
            
            // Log summary
            console.log(`\nYTD Summary:`);
            console.log(`  Last year: ${uniqueLastYearOrders.length} unique orders from ${lastYearOrders.length} total records`);
            console.log(`  Current year: ${uniqueCurrentYearOrders.length} unique orders from ${currentYearOrders.length} total records`);
            
            // Show breakdown by month for current year
            console.log(`\nCurrent Year Breakdown by Month:`);
            Object.entries(currentYearTotalByMonth).forEach(([month, count]) => {
                console.log(`  ${month}: ${count} orders`);
            });
            
            console.log(`\nLast Year Breakdown by Month:`);
            Object.entries(lastYearTotalByMonth).forEach(([month, count]) => {
                console.log(`  ${month}: ${count} orders`);
            });
            
            // Check invoice status
            const currentYearInvoiced = uniqueCurrentYearOrders.filter(order => order.sts_Invoiced === 1).length;
            const currentYearNotInvoiced = uniqueCurrentYearOrders.filter(order => order.sts_Invoiced === 0).length;
            console.log(`\nCurrent Year Invoice Status:`);
            console.log(`  Invoiced: ${currentYearInvoiced} orders`);
            console.log(`  Not Invoiced: ${currentYearNotInvoiced} orders`);
            
            // Log if we found duplicates
            if (uniqueCurrentYearOrders.length < currentYearOrders.length || uniqueLastYearOrders.length < lastYearOrders.length) {
                const lastYearDupes = lastYearOrders.length - uniqueLastYearOrders.length;
                const currentYearDupes = currentYearOrders.length - uniqueCurrentYearOrders.length;
                console.log(`  Removed ${lastYearDupes + currentYearDupes} duplicate records`);
            }
            
            // Calculate YoY metrics using unique orders
            const currentYearSales = uniqueCurrentYearOrders.reduce((sum, order) => sum + (parseFloat(order.cur_Subtotal) || 0), 0);
            const lastYearSales = uniqueLastYearOrders.reduce((sum, order) => sum + (parseFloat(order.cur_Subtotal) || 0), 0);
            const salesDifference = currentYearSales - lastYearSales;
            const salesGrowth = lastYearSales > 0 ? ((salesDifference / lastYearSales) * 100) : 0;
            
            const orderDifference = uniqueCurrentYearOrders.length - uniqueLastYearOrders.length;
            const orderGrowth = uniqueLastYearOrders.length > 0 ? ((orderDifference / uniqueLastYearOrders.length) * 100) : 0;
            
            response.yearOverYear = {
                currentYear: {
                    period: `${formatDate(currentYearStart)} to ${formatDate(currentYear)}`,
                    totalSales: parseFloat(currentYearSales.toFixed(2)),
                    orderCount: uniqueCurrentYearOrders.length
                },
                previousYear: {
                    period: `${formatDate(lastYearStart)} to ${formatDate(lastYearEnd)}`,
                    totalSales: parseFloat(lastYearSales.toFixed(2)),
                    orderCount: uniqueLastYearOrders.length
                },
                comparison: {
                    salesGrowth: parseFloat(salesGrowth.toFixed(2)),
                    salesDifference: parseFloat(salesDifference.toFixed(2)),
                    orderGrowth: parseFloat(orderGrowth.toFixed(2)),
                    orderDifference: orderDifference
                }
            };
            
            console.log(`YoY comparison: ${currentYear.getFullYear()} vs ${lastYear.getFullYear()}`);
            console.log(`Sales: $${currentYearSales.toFixed(2)} vs $${lastYearSales.toFixed(2)} (${salesGrowth.toFixed(1)}% growth)`);
        }
        
        // Cache the response with parameter-based key
        dashboardCache.set(cacheKey, { data: response, timestamp: now });
        console.log(`Cached dashboard data for ${cacheKey}`);
        
        res.json(response);
    } catch (error) {
        console.error("Error fetching dashboard data:", error.message);
        res.status(500).json({ error: 'Failed to fetch dashboard data.' });
    }
});
*/

// --- Order Dashboard endpoint for UI ---
// NOTE: This endpoint is now loaded from src/routes/orders.js
/*
// Parameter-aware in-memory cache for dashboard data
const dashboardCache = new Map();

app.get('/api/order-dashboard', async (req, res) => {
    console.log(`GET /api/order-dashboard requested with params:`, req.query);
    
    try {
        // Parse parameters first
        const days = parseInt(req.query.days) || 7;
        const includeDetails = req.query.includeDetails === 'true';
        const compareYoY = req.query.compareYoY === 'true';
        
        // Create cache key based on parameters
        const cacheKey = `days:${days}-details:${includeDetails}-yoy:${compareYoY}`;
        
        // Check cache (60 seconds)
        const now = Date.now();
        const cachedEntry = dashboardCache.get(cacheKey);
        if (cachedEntry && now - cachedEntry.timestamp < 60000) {
            console.log(`Returning cached dashboard data for ${cacheKey}`);
            return res.json(cachedEntry.data);
        }
        
        // Calculate date range
        const endDate = new Date();
        const startDate = new Date();
        startDate.setDate(startDate.getDate() - days);
        
        // Format dates for Caspio (YYYY-MM-DD)
        const formatDate = (date) => date.toISOString().split('T')[0];
        
        // Fetch orders in date range
        const whereClause = `date_OrderInvoiced>='${formatDate(startDate)}' AND date_OrderInvoiced<='${formatDate(endDate)}'`;
        console.log(`Fetching orders with whereClause: ${whereClause}`);
        
        const orders = await fetchAllCaspioPages('/tables/ORDER_ODBC/records', {
            'q.where': whereClause,
            'q.limit': 1000,
            'q.orderby': 'date_OrderInvoiced DESC'
        });
        
        console.log(`Found ${orders.length} orders in the last ${days} days`);
        
        // Calculate summary metrics
        const summary = {
            totalOrders: orders.length,
            totalSales: orders.reduce((sum, order) => sum + (parseFloat(order.cur_Subtotal) || 0), 0),
            notInvoiced: orders.filter(order => order.sts_Invoiced === 0).length,
            notShipped: orders.filter(order => order.sts_Shipped === 0).length,
            avgOrderValue: 0
        };
        
        // Calculate average order value
        if (summary.totalOrders > 0) {
            summary.avgOrderValue = summary.totalSales / summary.totalOrders;
        }
        
        // Calculate date range info
        const dateRange = {
            start: formatDate(startDate) + 'T00:00:00Z',
            end: formatDate(endDate) + 'T23:59:59Z',
            mostRecentOrder: null
        };
        
        if (orders.length > 0) {
            dateRange.mostRecentOrder = orders[0].date_OrderInvoiced;
        }
        
        // CSR name normalization mapping
        const csrNameMap = {
            'Ruth  Nhoung': 'Ruthie Nhoung',
            'Ruth Nhoung': 'Ruthie Nhoung',
            'ruth': 'Ruthie Nhoung',
            'House ': 'House Account',
            'House': 'House Account',
            'Unknown': 'Unassigned'
        };
        
        // Function to normalize CSR names
        const normalizeCSRName = (name) => {
            return csrNameMap[name] || name;
        };
        
        // Group by CSR with name normalization
        const csrMap = {};
        orders.forEach(order => {
            const originalCsr = order.CustomerServiceRep || 'Unknown';
            const csr = normalizeCSRName(originalCsr);
            if (!csrMap[csr]) {
                csrMap[csr] = { name: csr, orders: 0, sales: 0 };
            }
            csrMap[csr].orders++;
            csrMap[csr].sales += parseFloat(order.cur_Subtotal) || 0;
        });
        
        const byCsr = Object.values(csrMap)
            .sort((a, b) => b.sales - a.sales)
            .map(csr => ({
                name: csr.name,
                orders: csr.orders,
                sales: parseFloat(csr.sales.toFixed(2))
            }));
        
        // Order Type normalization mapping
        const orderTypeMap = {
            'Wow Embroidery': 'WOW',
            'Sample Return to Vendor': 'Sample Returns',
            'Inksoft': 'Webstores',
            '77 Account': 'Samples',
            'Digital Printing': 'DTG',
            'Transfers': 'DTF',
            'Shopify': '253GEAR'
        };
        
        // Function to normalize Order Types
        const normalizeOrderType = (type) => {
            return orderTypeMap[type] || type;
        };
        
        // Group by Order Type with normalization
        const typeMap = {};
        orders.forEach(order => {
            const originalType = order.ORDER_TYPE || 'Unknown';
            const type = normalizeOrderType(originalType);
            if (!typeMap[type]) {
                typeMap[type] = { type: type, orders: 0, sales: 0 };
            }
            typeMap[type].orders++;
            typeMap[type].sales += parseFloat(order.cur_Subtotal) || 0;
        });
        
        const byOrderType = Object.values(typeMap)
            .sort((a, b) => b.sales - a.sales)
            .map(type => ({
                type: type.type,
                orders: type.orders,
                sales: parseFloat(type.sales.toFixed(2))
            }));
        
        // Calculate today's stats
        const today = new Date();
        const todayStr = formatDate(today);
        const todayOrders = orders.filter(order => 
            order.date_OrderInvoiced && order.date_OrderInvoiced.startsWith(todayStr)
        );
        
        const todayStats = {
            ordersToday: todayOrders.length,
            salesToday: todayOrders.reduce((sum, order) => sum + (parseFloat(order.cur_Subtotal) || 0), 0),
            shippedToday: todayOrders.filter(order => order.sts_Shipped === 1).length
        };
        
        // Round sales values to 2 decimal places
        summary.totalSales = parseFloat(summary.totalSales.toFixed(2));
        summary.avgOrderValue = parseFloat(summary.avgOrderValue.toFixed(2));
        todayStats.salesToday = parseFloat(todayStats.salesToday.toFixed(2));
        
        // Build response
        const response = {
            summary,
            dateRange,
            breakdown: {
                byCsr,
                byOrderType
            },
            todayStats
        };
        
        // Add recent orders if requested
        if (includeDetails) {
            response.recentOrders = orders.slice(0, 10).map(order => ({
                ID_Order: order.ID_Order,
                date_OrderInvoiced: order.date_OrderInvoiced,
                CompanyName: order.CompanyName,
                CustomerServiceRep: order.CustomerServiceRep,
                ORDER_TYPE: order.ORDER_TYPE,
                cur_Subtotal: parseFloat(order.cur_Subtotal) || 0,
                sts_Invoiced: order.sts_Invoiced,
                sts_Shipped: order.sts_Shipped
            }));
        }
        
        // Add year-over-year comparison if requested
        if (compareYoY) {
            console.log('Year-over-year comparison requested but not implemented in this simplified version');
            response.yearOverYear = {
                note: 'YoY comparison requires additional implementation'
            };
        }
        
        // Cache the response with parameter-based key
        dashboardCache.set(cacheKey, { data: response, timestamp: now });
        console.log(`Cached dashboard data for ${cacheKey}`);
        
        res.json(response);
    } catch (error) {
        console.error("Error fetching dashboard data:", error.message);
        res.status(500).json({ error: 'Failed to fetch dashboard data.' });
    }
});
*/

// --- Load all modular routes ---
// MIGRATION IN PROGRESS: Enabling all modular routes for endpoint migration

// Orders Routes (contains order-dashboard endpoint)
const orderRoutes = require('./src/routes/orders');
app.use('/api', orderRoutes);
console.log('✓ Orders routes loaded');

// Miscellaneous Routes (contains staff-announcements endpoint)
const miscRoutes = require('./src/routes/misc');
app.use('/api', miscRoutes);
console.log('✓ Misc routes loaded');

// Pricing Routes
const pricingRoutes = require('./src/routes/pricing');
app.use('/api', pricingRoutes);
console.log('✓ Pricing routes loaded');

// --- Enhanced Error Handling Middleware ---
app.use((err, req, res, next) => {
    const timestamp = new Date().toISOString();
    const errorId = Math.random().toString(36).substring(7);
    
    // Log detailed error information
    console.error(`[${timestamp}] Error ID: ${errorId}`);
    console.error(`Path: ${req.method} ${req.path}`);
    console.error(`Error:`, err.stack || err);
    
    // Determine error type and status code
    let statusCode = 500;
    let errorMessage = 'An unexpected error occurred';
    
    if (err.response?.status === 401) {
        statusCode = 401;
        errorMessage = 'Caspio authentication failed';
    } else if (err.response?.status === 404) {
        statusCode = 404;
        errorMessage = 'Caspio resource not found';
    } else if (err.message?.includes('timeout')) {
        statusCode = 504;
        errorMessage = 'Request timeout';
    }
    
    res.status(statusCode).json({
        error: errorMessage,
        errorId: errorId,
        timestamp: timestamp,
        path: req.path,
        details: config.server.env === 'development' ? err.message : undefined
    });
});

// --- Graceful Shutdown Handler ---
process.on('SIGTERM', () => {
    console.log('SIGTERM received: closing HTTP server');
    server.close(() => {
        console.log('HTTP server closed');
        process.exit(0);
    });
});

process.on('SIGINT', () => {
    console.log('\nSIGINT received: closing HTTP server');
    server.close(() => {
        console.log('HTTP server closed');
        process.exit(0);
    });
});

// --- Start the Server with Enhanced Logging ---
const server = app.listen(PORT, async () => {
    console.log('\n' + '='.repeat(60));
    console.log('🚀 CASPIO PROXY SERVER STARTED');
    console.log('='.repeat(60));
    console.log(`📍 Port: ${PORT}`);
    console.log(`🌐 Caspio Domain: ${caspioDomain}`);
    console.log(`🔧 Environment: ${config.server.env}`);
    console.log(`📚 API Version: ${config.caspio.apiVersion}`);
    console.log('='.repeat(60));
    
    // Try to get a token on startup to verify credentials
    try {
        console.log('🔐 Verifying Caspio credentials...');
        await getCaspioAccessToken();
        console.log('✅ Caspio authentication successful!');
    } catch (err) {
        console.error('❌ Caspio authentication failed:', err.message);
        console.error('   Please check your .env file credentials');
    }
    
    console.log('\n📋 Available endpoints:');
    console.log('   Health Check: http://localhost:' + PORT + '/api/health');
    console.log('   Status: http://localhost:' + PORT + '/status');
    console.log('\n✨ Server is ready to handle requests!');
    console.log('='.repeat(60) + '\n');
});