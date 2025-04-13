// server.js - Caspio API Proxy Server

require('dotenv').config(); // Load .env file for local dev

const express = require('express');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 3000; // Use Heroku's port or 3000 locally

// --- Caspio Configuration ---
const caspioDomain = process.env.CASPIO_ACCOUNT_DOMAIN;
const clientId = process.env.CASPIO_CLIENT_ID;
const clientSecret = process.env.CASPIO_CLIENT_SECRET;

if (!caspioDomain || !clientId || !clientSecret) {
    console.error("FATAL ERROR: Caspio environment variables (DOMAIN, CLIENT_ID, CLIENT_SECRET) not set.");
    process.exit(1);
}

const caspioTokenUrl = `https://${caspioDomain}/oauth/token`;
const caspioApiBaseUrl = `https://${caspioDomain}/rest/v2`; // Using v2 API

// --- Simple In-Memory Token Cache ---
let caspioAccessToken = null;
let tokenExpiryTime = 0;

// --- Middleware ---
app.use(express.json()); // Parse JSON bodies (for potential future POST requests)

// CORS Middleware - Allow requests from all origins for testing
app.use((req, res, next) => {
    // Allow requests from any origin for testing purposes
    // In production, this should be restricted to specific domains
    res.setHeader('Access-Control-Allow-Origin', '*');
    
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    
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
    const bufferSeconds = 60; // Refresh token if it expires within 60 seconds

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
            timeout: 10000 // Add timeout (10 seconds)
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

        const config = {
            method: method,
            url: url,
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json'
            },
            params: params, // Axios handles query string building
            data: data,     // Axios handles request body
            timeout: 15000 // Add timeout (15 seconds)
        };

        console.log(`Request config: ${JSON.stringify(config, (key, value) =>
            key === 'Authorization' ? '***REDACTED***' : value)}`);

        const response = await axios(config);
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
 * IMPORTANT: Caspio API uses pagination, which means that results may be split across multiple pages.
 * When querying large datasets or when you're not sure about the size of the result set,
 * ALWAYS use this function instead of makeCaspioRequest to ensure you get ALL records.
 *
 * DEVELOPER NOTE: For ALL new endpoints, ALWAYS use this function instead of makeCaspioRequest.
 * Failure to do so will result in incomplete data when the result set spans multiple pages.
 * We've seen this issue with brands like "OGIO" which were on the second page and were not
 * being returned when using makeCaspioRequest.
 *
 * Fetches ALL records from a Caspio resource, handling pagination.
 * @param {string} resourcePath - Path relative to base API URL (e.g., '/tables/YourTable/records')
 * @param {object} [initialParams={}] - Initial URL query parameters (e.g., { 'q.where': "Field='value'" })
 * @returns {Promise<object[]>} - The combined 'Result' array from all pages.
 */
async function fetchAllCaspioPages(resourcePath, initialParams = {}, options = {}) {
    let allResults = [];
    let params = { ...initialParams };
    // Ensure a reasonable limit is set, Caspio default is often 100, max might be 1000
    params['q.limit'] = params['q.limit'] || 1000;
    let nextPageUrl = `${caspioApiBaseUrl}${resourcePath}`; // Start with base resource URL

    // Set default options
    const defaultOptions = {
        maxPages: 5, // Default max pages to fetch
        earlyExitCondition: null // Optional function to check if we should stop fetching
    };
    
    const mergedOptions = { ...defaultOptions, ...options };
    
    console.log(`Fetching up to ${mergedOptions.maxPages} pages for: ${resourcePath} with initial params: ${JSON.stringify(initialParams)}`);

    try {
        const token = await getCaspioAccessToken();
        let pageCount = 0;
        let morePages = true;
        let skipCount = 0;

        // Use a combination of @nextpage and manual pagination with q.skip
        while (morePages && pageCount < mergedOptions.maxPages) {
            pageCount++;
            
            // For the first page, use the initial URL and params
            // For subsequent pages, either use the @nextpage URL or manually construct with q.skip
            let currentUrl = nextPageUrl;
            let currentParams = undefined;
            
            if (pageCount === 1) {
                // First page - use initial params
                currentParams = params;
            } else if (!nextPageUrl.includes('@nextpage')) {
                // Manual pagination - add skip parameter
                skipCount = (pageCount - 1) * 1000;
                currentParams = { ...params, 'q.skip': skipCount };
                currentUrl = `${caspioApiBaseUrl}${resourcePath}`;
                console.log(`Using manual pagination with q.skip=${skipCount}`);
            }
            
            console.log(`Fetching page ${pageCount} from: ${currentUrl.replace(caspioApiBaseUrl, '')}`);
            const config = {
                method: 'get',
                url: currentUrl,
                headers: { 'Authorization': `Bearer ${token}` },
                params: currentParams,
                timeout: 30000 // Increase timeout for potentially longer multi-page fetches
            };

            const response = await axios(config);

            if (response.data && response.data.Result) {
                const pageResults = response.data.Result;
                // Log the number of records in this page
                console.log(`Page ${pageCount} contains ${pageResults.length} records.`);
                
                // Check if we're hitting the page size limit
                if (pageResults.length >= 1000) {
                    console.log(`WARNING: Page ${pageCount} has ${pageResults.length} records, which is at or near the maximum.`);
                }
                
                allResults = allResults.concat(pageResults);
                
                // Check early exit condition if provided
                if (mergedOptions.earlyExitCondition) {
                    const shouldExit = mergedOptions.earlyExitCondition(allResults);
                    if (shouldExit) {
                        console.log(`Early exit condition met after ${pageCount} pages. Stopping pagination.`);
                        break;
                    }
                }
                
                // Check if we've reached the max pages
                if (pageCount >= mergedOptions.maxPages) {
                    console.log(`Reached maximum page limit (${mergedOptions.maxPages}). Stopping pagination.`);
                    break;
                }
                
                // Check for the @nextpage link in the response body
                nextPageUrl = response.data['@nextpage'] ? response.data['@nextpage'] : null;
                
                if (nextPageUrl) {
                    console.log(`Found next page link: ${nextPageUrl}`);
                    // Ensure the next URL uses the correct base if it's relative (it shouldn't be with Caspio v2)
                    if (!nextPageUrl.startsWith('http')) {
                        console.warn("Received relative next page URL, prepending base. Check Caspio API version/response.");
                        nextPageUrl = caspioApiBaseUrl + (nextPageUrl.startsWith('/') ? '' : '/') + nextPageUrl;
                    }
                    morePages = true;
                } else if (pageResults.length >= 1000) {
                    // If we got 1000 records but no @nextpage, try manual pagination
                    console.log(`No @nextpage link found, but page is full. Trying manual pagination.`);
                    morePages = true;
                    nextPageUrl = "manual_pagination"; // Flag to use manual pagination
                } else {
                    console.log(`No more pages found (page has ${pageResults.length} records < 1000).`);
                    morePages = false;
                }
            } else {
                console.warn("Caspio API response page did not contain 'Result':", response.data);
                morePages = false;
            }
        } // End while loop

        console.log(`Finished fetching ${pageCount} page(s), total ${allResults.length} records for ${resourcePath}.`);
        return allResults;

    } catch (error) {
        console.error(`Error fetching all pages for ${resourcePath}:`, error.response ? JSON.stringify(error.response.data) : error.message);
        throw new Error(`Failed to fetch all data from Caspio resource: ${resourcePath}. Status: ${error.response?.status}`);
    }
}

// --- API Endpoints ---

// Simple status check
app.get('/status', (req, res) => {
    res.json({ status: 'Proxy server running', caspio_domain: caspioDomain });
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
        const params = {
            'q.where': `DecorationMethod='${method}'`,
            // Select only needed fields with correct column names
            'q.select': 'TierLabel,MinQuantity,MaxQuantity,LTM_Fee,MarginDenominator,TargetMargin',
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

// --- ENHANCED Endpoint: Style Search Autocomplete with Improved Pagination ---
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


// --- UPDATED Endpoint: Product Details with Color-Specific Images ---
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

// --- UPDATED Endpoint: Color Swatches (Handles Pagination) ---
// Example: /api/color-swatches?styleNumber=PC61
app.get('/api/color-swatches', async (req, res) => {
    const { styleNumber } = req.query;
    if (!styleNumber) {
        return res.status(400).json({ error: 'Missing required query parameter: styleNumber' });
    }
    try {
        const resource = '/tables/Sanmar_Bulk_251816_Feb2024/records';
        const params = {
            'q.where': `STYLE='${styleNumber}'`,
            'q.select': 'COLOR_NAME, CATALOG_COLOR, COLOR_SQUARE_IMAGE',
            // 'q.distinct': true, // Leave distinct OFF to get all variations
            'q.orderby': 'COLOR_NAME ASC',
            'q.limit': 1000 // Ask for max per page
        };
        // Use the new function to fetch all pages
        const result = await fetchAllCaspioPages(resource, params);
        // Filter out results where essential swatch info might be missing
        const validSwatches = result.filter(item => item.COLOR_NAME && item.CATALOG_COLOR && item.COLOR_SQUARE_IMAGE);
        
        // Deduplicate swatches based on COLOR_NAME to ensure each color appears only once
        const uniqueSwatches = [];
        const seenColors = new Set();
        
        for (const swatch of validSwatches) {
            if (!seenColors.has(swatch.COLOR_NAME)) {
                seenColors.add(swatch.COLOR_NAME);
                uniqueSwatches.push(swatch);
            }
        }
        
        console.log(`Returning ${uniqueSwatches.length} unique colors out of ${validSwatches.length} total swatches for style ${styleNumber}`);
        res.json(uniqueSwatches);
    } catch (error) {
        res.status(500).json({ error: error.message || 'Failed to fetch color swatches.' });
    }
});
// --- UPDATED Endpoint: Get Inventory Data (Handles Pagination) ---
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

// --- UPDATED Endpoint: Product Search by Brand ---
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

// --- NEW Endpoint: Product Search by Category ---
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

// --- NEW Endpoint: Product Search by Subcategory ---
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

// --- Endpoint: Get All Brands ---
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

// --- ENHANCED Endpoint: Get Maximum Prices Across All Colors for a Style with Size Surcharges ---
// Example: /api/max-prices-by-style?styleNumber=PC61
app.get('/api/max-prices-by-style', async (req, res) => {
    const { styleNumber } = req.query;
    if (!styleNumber) {
        return res.status(400).json({ error: 'Missing required query parameter: styleNumber' });
    }
    try {
        console.log(`Fetching max prices for style: ${styleNumber} across all colors`);
        
        // Define the expected sizes we want to find
        const expectedSizes = ['XS', 'S', 'M', 'L', 'XL', '2XL', 'XXL', '3XL', 'XXXL', '4XL', 'XXXXL', '5XL', 'XXXXXL', '6XL', 'XXXXXXL'];
        
        // Create an early exit condition function that looks for ALL sizes including 5XL and 6XL
        const foundSizes = new Set();
        const earlyExitCondition = (results) => {
            // Update the set of found sizes
            results.forEach(item => {
                if (item.size) {
                    foundSizes.add(item.size);
                }
            });
            
            // Check if we've found all the sizes we're looking for
            const hasS = foundSizes.has('S');
            const hasM = foundSizes.has('M');
            const hasL = foundSizes.has('L');
            const hasXL = foundSizes.has('XL');
            const has2XL = foundSizes.has('2XL') || foundSizes.has('XXL');
            const has3XL = foundSizes.has('3XL') || foundSizes.has('XXXL');
            const has4XL = foundSizes.has('4XL') || foundSizes.has('XXXXL');
            const has5XL = foundSizes.has('5XL') || foundSizes.has('XXXXXL');
            const has6XL = foundSizes.has('6XL') || foundSizes.has('XXXXXXL');
            
            // Log what sizes we've found so far
            console.log(`Sizes found so far: ${[...foundSizes].join(', ')}`);
            
            // Only exit early if we've found ALL sizes including 5XL and 6XL
            const foundAllSizes = hasS && hasM && hasL && hasXL && has2XL && has3XL && has4XL && has5XL && has6XL;
            
            if (foundAllSizes) {
                console.log(`Found all sizes including 5XL and 6XL: ${[...foundSizes].join(', ')}`);
                return true;
            }
            
            return false;
        };
        
        // First, try to get inventory records for this style
        const resource = '/tables/Inventory/records';
        // If the style is PC61, specifically check Ash color which seems to have 5XL and 6XL
        const whereClause = styleNumber === 'PC61' ?
            `catalog_no='${styleNumber}' AND catalog_color='Ash'` :
            `catalog_no='${styleNumber}'`;
            
        const params = {
            'q.where': whereClause,
            'q.select': 'size, case_price, SizeSortOrder, catalog_color, catalog_no',
            'q.limit': 1000 // Set to 1000 which is Caspio's max per page
        };
        
        // Use fetchAllCaspioPages to handle pagination with a higher max page limit and early exit condition
        const result = await fetchAllCaspioPages(resource, params, {
            maxPages: 20, // Increase to 20 pages (20,000 records) to be more thorough
            earlyExitCondition: earlyExitCondition
        });
        
        if (result.length === 0) {
            console.warn(`No inventory found for style: ${styleNumber}`);
            return res.status(404).json({ error: `No inventory found for style: ${styleNumber}` });
        }
        
        // Log all unique sizes found in the database for this style
        const allSizesFound = new Set();
        result.forEach(item => {
            if (item.size) {
                allSizesFound.add(item.size);
            }
        });
        console.log(`Found ${allSizesFound.size} unique sizes for style ${styleNumber}: ${[...allSizesFound].join(', ')}`);
        
        // Check if we have all expected sizes (up to 6XL)
        const missingSizes = expectedSizes.filter(size => !allSizesFound.has(size));
        if (missingSizes.length > 0) {
            console.log(`Missing expected sizes for style ${styleNumber}: ${missingSizes.join(', ')}`);
            // We don't check for related catalog numbers - only use the exact style number
        }
        
        // Process results to get MAX prices per size across all colors and sort orders
        const prices = {};
        const sortOrders = {};
        let basePrice = null; // Store the base price (typically size M or L)
        
        // First pass: collect all sizes, prices, and sort orders
        result.forEach(item => {
            if (item.size && item.case_price !== null && !isNaN(item.case_price)) {
                const size = item.size;
                const price = parseFloat(item.case_price);
                const sortOrder = item.SizeSortOrder || 999; // Default high value if missing
                const color = item.catalog_color || 'Unknown';
                const catalogNo = item.catalog_no || styleNumber;
                
                // Log each size/price/color combination for debugging
                console.log(`Found size ${size} with price $${price.toFixed(2)} for color ${color} (catalog: ${catalogNo}, sort order: ${sortOrder})`);
                
                // Store the MAX price for each size across all colors
                if (!prices[size] || price > prices[size]) {
                    prices[size] = price;
                    console.log(`  → New max price for size ${size}: $${price.toFixed(2)} (color: ${color}, catalog: ${catalogNo})`);
                }
                
                // Store the sort order for each size
                if (!sortOrders[size] || sortOrder < sortOrders[size]) {
                    sortOrders[size] = sortOrder;
                }
                
                // Try to identify the base price (typically M or L)
                if (size === 'M' || size === 'L') {
                    if (basePrice === null || price > basePrice) {
                        basePrice = price;
                        console.log(`  → New base price: $${basePrice.toFixed(2)} from size ${size} (catalog: ${catalogNo})`);
                    }
                }
            }
        });
        
        // If we couldn't find a base price from M or L, use the first available price
        if (basePrice === null && Object.keys(prices).length > 0) {
            basePrice = Object.values(prices)[0];
            console.log(`Using fallback base price: $${basePrice.toFixed(2)}`);
        }
        
        // Define size surcharges with alternative size naming conventions
        // Size surcharge rules:
        // 2XL/XXL: +$2.00, 3XL/XXXL: +$3.00, 4XL/XXXXL: +$4.00, 5XL: +$5.00, 6XL: +$6.00
        const sizeSurcharges = {
            // Standard naming
            '2XL': 2.00,
            '3XL': 3.00,
            '4XL': 4.00,
            '5XL': 5.00,
            '6XL': 6.00,
            // Alternative naming
            'XXL': 2.00,
            'XXXL': 3.00,
            'XXXXL': 4.00,
            'XXXXXL': 5.00,
            'XXXXXXL': 6.00
        };
        
        // Apply surcharges to larger sizes that exist in the database
        if (basePrice !== null) {
            Object.keys(prices).forEach(size => {
                // Check if this size has a surcharge
                if (sizeSurcharges[size]) {
                    const surcharge = sizeSurcharges[size];
                    const minimumPrice = basePrice + surcharge;
                    
                    // Only apply the surcharge if the actual price is less than base + surcharge
                    if (prices[size] < minimumPrice) {
                        console.log(`Adjusting price for ${size} from $${prices[size].toFixed(2)} to $${minimumPrice.toFixed(2)} (base + surcharge)`);
                        prices[size] = minimumPrice;
                    } else {
                        console.log(`Keeping original price for ${size}: $${prices[size].toFixed(2)} (higher than base + surcharge: $${minimumPrice.toFixed(2)})`);
                    }
                } else {
                    console.log(`Regular size ${size}: $${prices[size].toFixed(2)}`);
                }
            });
        }
        
        // Create an array of sizes sorted by SizeSortOrder
        const sortedSizes = Object.keys(prices).sort((a, b) => {
            return (sortOrders[a] || 999) - (sortOrders[b] || 999);
        });
        
        // Create the response with ordered sizes and MAX prices across all colors
        const response = {
            style: styleNumber,
            sizes: sortedSizes.map(size => ({
                size: size,
                price: prices[size],
                sortOrder: sortOrders[size]
            }))
        };
        
        console.log(`Returning MAX prices for ${sortedSizes.length} sizes for style: ${styleNumber} across all colors`);
        res.json(response);
    } catch (error) {
        console.error("Error fetching prices:", error.message);
        res.status(500).json({ error: 'Failed to fetch prices for the specified style.' });
    }
});

// --- Error Handling Middleware (Basic) ---
// Catches errors from endpoint handlers
app.use((err, req, res, next) => {
    console.error("Unhandled Error:", err.stack || err);
    res.status(500).json({ error: 'An unexpected internal server error occurred.' });
});

// --- NEW Endpoint: Get Size Pricing with Upcharges for Datapage Integration ---
// Example: /api/size-pricing?styleNumber=PC61&color=Ash
app.get('/api/size-pricing', async (req, res) => {
    const { styleNumber, color } = req.query;
    if (!styleNumber) {
        return res.status(400).json({ error: 'Missing required query parameter: styleNumber' });
    }
    
    try {
        console.log(`Fetching size pricing for style: ${styleNumber}, color: ${color || 'all colors'}`);
        
        // Define the standard size upcharges
        const standardUpcharges = {
            '2XL': 2.00,
            'XXL': 2.00,
            '3XL': 3.00,
            'XXXL': 3.00,
            '4XL': 4.00,
            'XXXXL': 4.00,
            '5XL': 5.00,
            'XXXXXL': 5.00,
            '6XL': 6.00,
            'XXXXXXL': 6.00
        };
        
        // Determine the query based on whether a color is specified
        const resource = '/tables/Inventory/records';
        
        // If the style is PC61 and no color is specified, specifically check Ash color which has all sizes
        let whereClause;
        if (styleNumber === 'PC61' && !color) {
            whereClause = `catalog_no='${styleNumber}' AND catalog_color='Ash'`;
        } else if (color) {
            whereClause = `catalog_no='${styleNumber}' AND catalog_color='${color}'`;
        } else {
            whereClause = `catalog_no='${styleNumber}'`;
        }
            
        const params = {
            'q.where': whereClause,
            'q.select': 'size, case_price, SizeSortOrder, catalog_color',
            'q.limit': 1000
        };
        
        // Fetch the data
        const result = await fetchAllCaspioPages(resource, params);
        
        if (result.length === 0) {
            console.warn(`No inventory found for style: ${styleNumber}${color ? ` and color: ${color}` : ''}`);
            return res.status(404).json({ error: `No inventory found for style: ${styleNumber}${color ? ` and color: ${color}` : ''}` });
        }
        
        // Process results to get max prices per size and sort orders
        const maxPrices = {};
        const sortOrders = {};
        
        // First pass: collect max prices and sort orders
        result.forEach(item => {
            if (item.size && item.case_price !== null && !isNaN(item.case_price)) {
                const size = item.size;
                const price = parseFloat(item.case_price);
                const sortOrder = item.SizeSortOrder || 999;
                
                // Store the max price for each size
                if (!maxPrices[size] || price > maxPrices[size]) {
                    maxPrices[size] = price;
                }
                
                // Store the sort order for each size
                if (!sortOrders[size] || sortOrder < sortOrders[size]) {
                    sortOrders[size] = sortOrder;
                }
            }
        });
        
        // Determine the base price (typically M or L)
        let basePrice = null;
        if (maxPrices['M']) {
            basePrice = maxPrices['M'];
        } else if (maxPrices['L']) {
            basePrice = maxPrices['L'];
        } else if (Object.keys(maxPrices).length > 0) {
            // Fallback to the first available price
            basePrice = Object.values(maxPrices)[0];
        }
        
        // Create an array of sizes sorted by SizeSortOrder
        const sortedSizes = Object.keys(maxPrices).sort((a, b) => {
            return (sortOrders[a] || 999) - (sortOrders[b] || 999);
        });
        
        // Create the response with detailed pricing information for each size
        const sizeDetails = sortedSizes.map(size => {
            const maxPrice = maxPrices[size];
            const standardUpcharge = standardUpcharges[size] || 0;
            const baseWithUpcharge = basePrice + standardUpcharge;
            
            // Determine if the standard upcharge is enough
            const isStandardUpchargeEnough = maxPrice <= baseWithUpcharge;
            
            // Calculate the actual upcharge needed
            const actualUpchargeNeeded = isStandardUpchargeEnough ? standardUpcharge : (maxPrice - basePrice);
            
            return {
                size: size,
                maxCasePrice: maxPrice,
                standardUpcharge: standardUpcharge,
                basePrice: basePrice,
                baseWithStandardUpcharge: baseWithUpcharge,
                isStandardUpchargeEnough: isStandardUpchargeEnough,
                actualUpchargeNeeded: actualUpchargeNeeded,
                recommendedPrice: Math.max(maxPrice, baseWithUpcharge),
                sortOrder: sortOrders[size]
            };
        });
        
        // Create the final response
        const response = {
            style: styleNumber,
            color: color || 'all colors',
            basePrice: basePrice,
            sizes: sizeDetails
        };
        
        console.log(`Returning size pricing for ${sortedSizes.length} sizes for style: ${styleNumber}${color ? `, color: ${color}` : ''}`);
        res.json(response);
        
    } catch (error) {
        console.error("Error fetching size pricing:", error.message);
        res.status(500).json({ error: 'Failed to fetch size pricing for the specified style.' });
    }
});


// --- Start the Server ---
app.listen(PORT, () => {
    console.log(`Caspio Proxy Server listening on port ${PORT}`);
    console.log(`Using Caspio Domain: ${caspioDomain}`);
    // Optional: Try to get a token on startup to verify credentials early
    // getCaspioAccessToken().catch(err => console.error("Initial token fetch failed. Check credentials."));
});