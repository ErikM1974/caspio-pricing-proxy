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

// --- Load all modular routes ---
// All endpoints are now organized into logical route modules

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

// Inventory Routes
const inventoryRoutes = require('./src/routes/inventory');
app.use('/api', inventoryRoutes);
console.log('✓ Inventory routes loaded');

// Products Routes
const productRoutes = require('./src/routes/products');
app.use('/api', productRoutes);
console.log('✓ Product routes loaded');

// Cart Routes
const cartRoutes = require('./src/routes/cart');
app.use('/api', cartRoutes);
console.log('✓ Cart routes loaded');

// Quotes Routes
const quotesRoutes = require('./src/routes/quotes');
app.use('/api', quotesRoutes);
console.log('✓ Quotes routes loaded');

// Pricing Matrix Routes
const pricingMatrixRoutes = require('./src/routes/pricing-matrix');
app.use('/api', pricingMatrixRoutes);
console.log('✓ Pricing Matrix routes loaded');

// Transfers Routes
const transferRoutes = require('./src/routes/transfers');
app.use('/api', transferRoutes);
console.log('✓ Transfer routes loaded');

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

// --- Server Startup ---
const server = app.listen(PORT, async () => {
    console.log('\n========================================');
    console.log('🚀 Caspio Pricing Proxy Server Started');
    console.log('========================================');
    console.log(`📡 Port: ${PORT}`);
    console.log(`🌐 Caspio Domain: ${caspioDomain}`);
    console.log(`🔧 API Version: ${config.caspio.apiVersion}`);
    console.log(`🏃 Environment: ${config.server.env}`);
    console.log('========================================\n');
    
    // Validate Caspio credentials on startup
    try {
        await getCaspioAccessToken();
        console.log('✅ Caspio credentials validated successfully\n');
    } catch (error) {
        console.error('❌ Failed to validate Caspio credentials:', error.message);
        console.error('Please check your environment variables.\n');
    }
});

// Export for testing
module.exports = { app, fetchAllCaspioPages, makeCaspioRequest };