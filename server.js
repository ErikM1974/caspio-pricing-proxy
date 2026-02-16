// server.js - Caspio API Proxy Server

const express = require('express');
const axios = require('axios');
const rateLimit = require('express-rate-limit');
const config = require('./config'); // Use unified configuration
const { requireCrmApiSecret } = require('./src/middleware');

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
app.use(express.json({ limit: '10mb' })); // Parse JSON bodies with 10MB limit (for file uploads)
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

// Pricing Routes (rate limiter is inside the router — NOT global to /api)
const pricingRoutes = require('./src/routes/pricing');
app.use('/api', pricingRoutes);
console.log('✓ Pricing routes loaded (rate limited: 100 req/min)');

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

// Gift Certificates Routes
const giftCertificatesRoutes = require('./src/routes/gift-certificates');
app.use('/api', giftCertificatesRoutes);
console.log('✓ Gift Certificates routes loaded');

// Pricing Matrix Routes
const pricingMatrixRoutes = require('./src/routes/pricing-matrix');
app.use('/api', pricingMatrixRoutes);
console.log('✓ Pricing Matrix routes loaded');

// Transfers Routes
const transferRoutes = require('./src/routes/transfers');
app.use('/api', transferRoutes);
console.log('✓ Transfer routes loaded');

// Art Routes (artrequests and art-invoices)
const artRoutes = require('./src/routes/art');
app.use('/api', artRoutes);
console.log('✓ Art routes loaded');

// Production Schedules Routes
const productionSchedulesRoutes = require('./src/routes/production-schedules');
app.use('/api', productionSchedulesRoutes);
console.log('✓ Production Schedules routes loaded');

// DTG Routes (including optimized product-bundle endpoint)
const dtgRoutes = require('./src/routes/dtg');
app.use('/api/dtg', dtgRoutes);
console.log('✓ DTG routes loaded');

// File Upload Routes (Caspio Files API v3)
const filesRoutes = require('./src/routes/files-simple');
app.use('/api', filesRoutes);
console.log('✓ File upload routes loaded');

// ManageOrders Routes (with rate limiting)
const manageOrdersLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 30, // Max 30 requests per minute (increased from 10 due to caching)
  message: {
    error: 'Too many requests to ManageOrders endpoints',
    retryAfter: '60 seconds'
  },
  standardHeaders: true,
  legacyHeaders: false,
  // Trust Heroku's proxy
  trustProxy: true
});
const manageOrdersRoutes = require('./src/routes/manageorders');
app.use('/api', manageOrdersLimiter, manageOrdersRoutes);
console.log('✓ ManageOrders routes loaded (rate limited: 30 req/min)');

// PC54 Optimized Inventory routes (aggregated multi-SKU queries)
const pc54InventoryRoutes = require('./src/routes/pc54-inventory');
app.use('/api', manageOrdersLimiter, pc54InventoryRoutes);
console.log('✓ PC54 Inventory routes loaded (rate limited: 30 req/min)');

// ManageOrders PUSH API routes (for sending orders TO OnSite)
const manageOrdersPushRoutes = require('./src/routes/manageorders-push');
app.use('/api/manageorders', manageOrdersPushRoutes);
console.log('✓ ManageOrders PUSH routes loaded');

// JDS Industries API routes (engravable products)
const jdsLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 60, // Max 60 requests per minute
  message: {
    error: 'Too many requests to JDS endpoints',
    retryAfter: '60 seconds'
  },
  standardHeaders: true,
  legacyHeaders: false,
  trustProxy: true
});
const jdsRoutes = require('./src/routes/jds');
app.use('/api/jds', jdsLimiter, jdsRoutes);
console.log('✓ JDS Industries routes loaded (rate limited: 60 req/min)');

// Sanmar-ShopWorks Mapping Routes
const sanmarShopworksRoutes = require('./src/routes/sanmar-shopworks');
app.use('/api', sanmarShopworksRoutes);
console.log('✓ Sanmar-ShopWorks mapping routes loaded');

// Thumbnail Lookup Routes
const thumbnailsRoutes = require('./src/routes/thumbnails');
app.use('/api', thumbnailsRoutes);
console.log('✓ Thumbnail routes loaded');

// Decorated Cap Prices Routes
const decoratedCapPricesRoutes = require('./src/routes/decorated-cap-prices');
app.use('/api', decoratedCapPricesRoutes);
console.log('✓ Decorated cap prices routes loaded');

// Designs Routes (InkSoft Transform integration)
const designsRoutes = require('./src/routes/designs');
app.use('/api', designsRoutes);
console.log('✓ Designs routes loaded');

// Daily Sales Archive Routes
const dailySalesRoutes = require('./src/routes/daily-sales');
app.use('/api', dailySalesRoutes);
console.log('✓ Daily Sales routes loaded');

// Daily Sales By Rep Archive Routes
const dailySalesByRepRoutes = require('./src/routes/daily-sales-by-rep');
app.use('/api', dailySalesByRepRoutes);
console.log('✓ Daily Sales By Rep routes loaded');

// Thread Colors Routes
const threadColorsRoutes = require('./src/routes/thread-colors');
app.use('/api', threadColorsRoutes);
console.log('✓ Thread Colors routes loaded');

// Tax Rate Routes (WA DOR + Caspio sales_tax_accounts_2026)
const taxRateRoutes = require('./src/routes/tax-rate');
app.use('/api', taxRateRoutes);
console.log('✓ Tax Rate routes loaded');

// Monograms Routes (CRUD for monogram orders)
const monogramsLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 30, // Max 30 requests per minute
  message: {
    error: 'Too many requests to Monograms endpoints',
    retryAfter: '60 seconds'
  },
  standardHeaders: true,
  legacyHeaders: false,
  trustProxy: true
});
const monogramsRoutes = require('./src/routes/monograms');
app.use('/api', monogramsLimiter, monogramsRoutes);
console.log('✓ Monograms routes loaded (rate limited: 30 req/min)');

// Garment Tracker Routes (staff dashboard tracking optimization)
const garmentTrackerRoutes = require('./src/routes/garment-tracker');
app.use('/api', garmentTrackerRoutes);
console.log('✓ Garment Tracker routes loaded');

// Quote Sequence Routes (atomic get-and-increment for quote IDs)
const quoteSequenceRoutes = require('./src/routes/quote-sequence');
app.use('/api', quoteSequenceRoutes);
console.log('✓ Quote Sequence routes loaded');

// Taneisha Accounts Routes (CRM for Taneisha's 800 customer accounts)
// Protected by requireCrmApiSecret - only authorized servers can access
const taneishaAccountsRoutes = require('./src/routes/taneisha-accounts');
app.use('/api/taneisha-accounts', requireCrmApiSecret);  // Auth middleware
app.use('/api', taneishaAccountsRoutes);
console.log('✓ Taneisha Accounts routes loaded (protected)');

// Taneisha Daily Sales Archive Routes (YTD tracking beyond ManageOrders 60-day limit)
const taneishaDailySalesRoutes = require('./src/routes/taneisha-daily-sales');
app.use('/api/taneisha', taneishaDailySalesRoutes);
console.log('✓ Taneisha Daily Sales Archive routes loaded');

// Nika Accounts Routes (CRM for Nika's customer accounts)
// Protected by requireCrmApiSecret - only authorized servers can access
const nikaAccountsRoutes = require('./src/routes/nika-accounts');
app.use('/api/nika-accounts', requireCrmApiSecret);  // Auth middleware
app.use('/api', nikaAccountsRoutes);
console.log('✓ Nika Accounts routes loaded (protected)');

// Nika Daily Sales Archive Routes (YTD tracking beyond ManageOrders 60-day limit)
const nikaDailySalesRoutes = require('./src/routes/nika-daily-sales');
app.use('/api/nika', nikaDailySalesRoutes);
console.log('✓ Nika Daily Sales Archive routes loaded');

// Rep Audit Routes (cross-check orders vs account assignments)
const repAuditRoutes = require('./src/routes/rep-audit');
app.use('/api', repAuditRoutes);
console.log('✓ Rep Audit routes loaded');

// House Accounts Routes (catch-all for non-sales-rep customers: Ruthie, House, Erik, Jim, Web)
// Protected by requireCrmApiSecret - only authorized servers can access
const houseAccountsRoutes = require('./src/routes/house-accounts');
app.use('/api/house-accounts', requireCrmApiSecret);  // Auth middleware
app.use('/api', houseAccountsRoutes);
console.log('✓ House Accounts routes loaded (protected)');

// House Daily Sales Archive Routes (YTD tracking beyond ManageOrders 60-day limit)
const houseDailySalesRoutes = require('./src/routes/house-daily-sales');
app.use('/api/house', houseDailySalesRoutes);
console.log('✓ House Daily Sales Archive routes loaded');

// Sales Reps 2026 Routes (master list of customer-to-sales-rep assignments)
// Protected by requireCrmApiSecret - only authorized servers can access
const salesReps2026Routes = require('./src/routes/sales-reps-2026');
app.use('/api/sales-reps-2026', requireCrmApiSecret);  // Auth middleware
app.use('/api', salesReps2026Routes);
console.log('✓ Sales Reps 2026 routes loaded (protected)');

// Assignment History Routes (audit trail for account assignments)
const assignmentHistoryRoutes = require('./src/routes/assignment-history');
app.use('/api', assignmentHistoryRoutes);
console.log('✓ Assignment History routes loaded');

// Company Contacts Routes (customer lookup for quote builders)
const companyContactsRoutes = require('./src/routes/company-contacts');
app.use('/api', companyContactsRoutes);
console.log('✓ Company Contacts routes loaded');

// Service Codes Routes (embroidery service codes, pricing tiers, fee structures)
const serviceCodesRoutes = require('./src/routes/service-codes');
app.use('/api', serviceCodesRoutes);
console.log('✓ Service Codes routes loaded');

// Non-SanMar Products Routes (Brooks Brothers, Carhartt direct, specialty items)
const nonSanmarProductsRoutes = require('./src/routes/non-sanmar-products');
app.use('/api', nonSanmarProductsRoutes);
console.log('✓ Non-SanMar Products routes loaded');

// --- Admin Metrics Endpoint ---
const apiTracker = require('./src/utils/api-tracker');

app.get('/api/admin/metrics', (req, res) => {
  try {
    const summary = apiTracker.getSummary();
    res.json({
      success: true,
      data: summary,
      message: `Tracking ${summary.todayCount} calls today. Monthly projection: ${summary.monthlyProjection.toLocaleString()} / 500,000 (${summary.percentOfLimit}%)`
    });
  } catch (error) {
    console.error('Error getting metrics:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});
console.log('✓ Admin metrics endpoint loaded at /api/admin/metrics');

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

// Export for testing and route modules
module.exports = { app, fetchAllCaspioPages, makeCaspioRequest, getCaspioAccessToken };