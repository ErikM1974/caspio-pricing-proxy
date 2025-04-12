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
 * Fetches ALL records from a Caspio resource, handling pagination.
 * @param {string} resourcePath - Path relative to base API URL (e.g., '/tables/YourTable/records')
 * @param {object} [initialParams={}] - Initial URL query parameters (e.g., { 'q.where': "Field='value'" })
 * @returns {Promise<object[]>} - The combined 'Result' array from all pages.
 */
async function fetchAllCaspioPages(resourcePath, initialParams = {}) {
    let allResults = [];
    let params = { ...initialParams };
    // Ensure a reasonable limit is set, Caspio default is often 100, max might be 1000
    params['q.limit'] = params['q.limit'] || 1000;
    let nextPageUrl = `${caspioApiBaseUrl}${resourcePath}`; // Start with base resource URL

    console.log(`Fetching all pages for: ${resourcePath} with initial params: ${JSON.stringify(initialParams)}`);

    try {
        const token = await getCaspioAccessToken();
        let pageCount = 0;

        while (nextPageUrl) {
            pageCount++;
            console.log(`Fetching page ${pageCount} from: ${nextPageUrl.replace(caspioApiBaseUrl, '')}`);
            const config = {
                method: 'get',
                url: nextPageUrl, // Use the full URL provided by Caspio or the initial one
                headers: { 'Authorization': `Bearer ${token}` },
                // PARAMS for the *first* request are added here, subsequent requests use the full nextPageUrl from Caspio
                params: (pageCount === 1) ? params : undefined,
                timeout: 20000 // Increase timeout slightly for potentially longer multi-page fetches
            };

            const response = await axios(config);

            if (response.data && response.data.Result) {
                allResults = allResults.concat(response.data.Result);
                // Check for the @nextpage link in the response body
                nextPageUrl = response.data['@nextpage'] ? response.data['@nextpage'] : null;
                if (nextPageUrl) {
                     console.log(`Found next page link.`);
                     // Ensure the next URL uses the correct base if it's relative (it shouldn't be with Caspio v2)
                     if (!nextPageUrl.startsWith('http')) {
                          console.warn("Received relative next page URL, prepending base. Check Caspio API version/response.");
                          nextPageUrl = caspioApiBaseUrl + (nextPageUrl.startsWith('/') ? '' : '/') + nextPageUrl;
                     }
                } else {
                     console.log(`No more pages found.`);
                }
            } else {
                console.warn("Caspio API response page did not contain 'Result':", response.data);
                nextPageUrl = null; // Stop if response format is wrong
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
        const result = await makeCaspioRequest('get', resource, params);
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
        const result = await makeCaspioRequest('get', resource, params);
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
        const result = await makeCaspioRequest('get', resource, params);
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
        const result = await makeCaspioRequest('get', resource, params);
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
        const result = await makeCaspioRequest('get', resource, params);
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
            'q.select': 'size,case_price', // Select only needed fields
            'q.limit': 2000 // Fetch all relevant size/color records for the style
        };
        const result = await makeCaspioRequest('get', resource, params);

        // Process results server-side to find max case price per size
        const maxPrices = {};
        result.forEach(item => {
            if (item.size && item.case_price !== null && !isNaN(item.case_price)) {
                const size = item.size;
                const price = parseFloat(item.case_price);
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

        res.json(maxPrices); // Return object: { "S": 10.50, "M": 10.50, "L": 11.00 }

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
        const result = await makeCaspioRequest('get', resource, params);
        res.json(result);
    } catch (error) {
        res.status(500).json({ error: error.message || 'Failed to fetch Sanmar bulk data.' });
    }
});

// --- CORRECTED Endpoint: Style Search Autocomplete (Style Number Only) ---
// Example: /api/stylesearch?term=PC
app.get('/api/stylesearch', async (req, res) => {
    const { term } = req.query;
    if (!term || term.length < 2) { // Require at least 2 characters
        return res.json([]);
    }
    try {
        const resource = '/tables/Sanmar_Bulk_251816_Feb2024/records';
        // Use "Starts With" matching
        const whereClause = `STYLE LIKE '${term}%'`;
        const params = {
            'q.where': whereClause,
            // --- CHANGE 1: Select ONLY the STYLE field ---
            'q.select': 'STYLE',
            'q.distinct': true, // Now asks Caspio for distinct STYLE values directly
            'q.limit': 25 // Limit initial results
        };
        const result = await makeCaspioRequest('get', resource, params);

        // --- CHANGE 2: Ensure we have truly unique style numbers ---
        // Filter out nulls first
        const validResults = result.filter(item => item.STYLE);
        
        // Use a Set to deduplicate style numbers
        const uniqueStyles = [...new Set(validResults.map(item => item.STYLE))];
        
        // Limit to 15 results
        const limitedResults = uniqueStyles.slice(0, 15);
        
        // Format for autocomplete: label and value are both the STYLE
        const suggestions = limitedResults.map(style => ({
             label: style, // Show only the style number
             value: style  // Use the style number when selected
         }));

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
        const result = await makeCaspioRequest('get', resource, params);

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
        const imageResults = await makeCaspioRequest('get', resource, imageParams);
        
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

// --- NEW Endpoint: Product Search by Brand ---
// Example: /api/products-by-brand?brand=Bella+%2B+Canvas
app.get('/api/products-by-brand', async (req, res) => {
    const { brand } = req.query;
    if (!brand) {
        return res.status(400).json({ error: 'Missing required query parameter: brand' });
    }
    try {
        const resource = '/tables/Sanmar_Bulk_251816_Feb2024/records';
        const params = {
            'q.where': `BRAND='${brand}'`,
            'q.select': 'STYLE, PRODUCT_TITLE, COLOR_NAME, FRONT_FLAT',
            'q.distinct': true,
            'q.orderby': 'STYLE ASC',
            'q.limit': 100
        };
        
        const result = await makeCaspioRequest('get', resource, params);
        
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
            'q.where': `CATEGORY='${category}'`,
            'q.select': 'STYLE, PRODUCT_TITLE, COLOR_NAME, FRONT_FLAT',
            'q.distinct': true,
            'q.orderby': 'STYLE ASC',
            'q.limit': 100
        };
        
        const result = await makeCaspioRequest('get', resource, params);
        
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
            'q.where': `SUBCATEGORY='${subcategory}'`,
            'q.select': 'STYLE, PRODUCT_TITLE, COLOR_NAME, FRONT_FLAT',
            'q.distinct': true,
            'q.orderby': 'STYLE ASC',
            'q.limit': 100
        };
        
        const result = await makeCaspioRequest('get', resource, params);
        
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

// --- Error Handling Middleware (Basic) ---
// Catches errors from endpoint handlers
app.use((err, req, res, next) => {
    console.error("Unhandled Error:", err.stack || err);
    res.status(500).json({ error: 'An unexpected internal server error occurred.' });
});



// --- Start the Server ---
app.listen(PORT, () => {
    console.log(`Caspio Proxy Server listening on port ${PORT}`);
    console.log(`Using Caspio Domain: ${caspioDomain}`);
    // Optional: Try to get a token on startup to verify credentials early
    // getCaspioAccessToken().catch(err => console.error("Initial token fetch failed. Check credentials."));
});