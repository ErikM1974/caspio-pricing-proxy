// server.js - Caspio API Proxy Server

const express = require('express');
const axios = require('axios');
const rateLimit = require('express-rate-limit');
const config = require('./config'); // Use unified configuration
const { requireCrmApiSecret } = require('./src/middleware');

const app = express();

// Heroku places the real client IP in X-Forwarded-For. Tell Express to trust
// the first proxy hop so req.ip reflects the actual user, not Heroku's router.
// Without this, express-rate-limit rate-limits ALL users as if they were one
// (router IP), causing widespread 429s when a single dashboard is chatty.
app.set('trust proxy', 1);

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
// `verify` stashes raw bytes on req.rawBody so signature-checking routes
// (e.g. /api/box/webhook for Box webhooks v2) can recompute the HMAC.
// Trivial overhead for non-signed routes.
app.use(express.json({
    limit: '10mb',
    verify: (req, res, buf) => { req.rawBody = buf; }
})); // Parse JSON bodies with 10MB limit (for file uploads)
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

// Quote Change Log Routes (audit trail of SW-side edits detected by sync diff)
const quoteChangeLogRoutes = require('./src/routes/quote-change-log');
app.use('/api', quoteChangeLogRoutes);
console.log('✓ Quote Change Log routes loaded');

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

// DTG Top Sellers — curated catalog backed by Caspio table DTG_Top_Sellers_2026.
// 20 styles × 6-8 colors each = ~150 SanMar-verified (style, color) combos with
// real NWCA sales data and per-size unit breakdowns. Used as the default
// catalog for the bot + form quick-pick pills.
const dtgTopSellersRoutes = require('./src/routes/dtg-top-sellers');
app.use('/api', dtgTopSellersRoutes);
console.log('✓ DTG Top Sellers routes loaded');

// EMB Top Sellers — backed by Caspio table EMB_Top_Sellers_2026 (Erik
// curates from 10 years of embroidery sales). Used by the EMB chat
// assistant's recommend_top_sellers_emb tool. 2026-05-24 (EMB Chat A).
const embTopSellersRoutes = require('./src/routes/emb-top-sellers');
app.use('/api', embTopSellersRoutes);
console.log('✓ EMB Top Sellers routes loaded');

// Industry Lookalikes — backed by Caspio table Industry_Lookalikes_2026
// (pre-aggregated quarterly from MO order history + industry inference +
// Tavily web classification, SanMar-only). Used by the EMB chat assistant's
// lookup_lookalike_customers tool to answer "what do other [industry]
// customers buy?". 2026-05-24 (EMB Smart A2).
// 2026-05-25 (EMB Smart E1): rebuilt from 10yr SanMar history keyed on Erik's
// manual Customer_Type (15 categories, not regex-inferred 18). Same endpoint.
const industryLookalikesRoutes = require('./src/routes/industry-lookalikes');
app.use('/api/industry-lookalikes', industryLookalikesRoutes);
console.log('✓ Industry Lookalikes routes loaded (15 Customer_Types, 10yr SanMar data)');

// Customer Profile 10yr — backed by Caspio table Customer_Profile_10yr_2026
// (one row per active SanMar-buying customer, pre-aggregated quarterly from
// contacts × bridge × line items). Powers the bot's lookup_customer_master_profile
// tool — replaces the old lookup_customer_history which only had 1yr of MO data.
// 2026-05-25 (EMB Smart E2).
const customerProfileRoutes = require('./src/routes/customer-profile');
app.use('/api/customer-profile', customerProfileRoutes);
console.log('✓ Customer Profile 10yr routes loaded (1,642 SanMar-buyer profiles)');

// SanMar Style Performance 10yr — backed by Caspio table
// Sanmar_Style_Performance_10yr_26 (one row per SanMar STYLE with 10yr units,
// revenue, margin, top colors, customer types, paired-with). Powers the bot's
// lookup_style_performance + recommend_high_margin_alternative tools.
// Caspio name suffix is _26 (not _2026) — original was too long. 2026-05-25 (EMB Smart E2).
const stylePerformanceRoutes = require('./src/routes/style-performance');
app.use('/api/style-performance', stylePerformanceRoutes);
console.log('✓ SanMar Style Performance 10yr routes loaded (2,162 styles, full margin data)');

// Sticker pricing route — backs Order Form sticker method (Caspio Sticker_Pricing + inline fallback)
const stickerPricingRoutes = require('./src/routes/sticker-pricing');
app.use('/api', stickerPricingRoutes);

// Banner pricing (2026-05-15) — rate card for continuous-sized banners.
// $10/sqft + $40 minimum + optional finishing add-ons. Used by the contract
// sticker AI bot's quote_banner_price tool.
const bannerPricingRoutes = require('./src/routes/banner-pricing');
app.use('/api', bannerPricingRoutes);
console.log('✓ Sticker pricing route loaded');

// Emblem pricing route — backs Order Form emblem method (Caspio Emblem_Pricing + inline fallback)
const emblemPricingRoutes = require('./src/routes/emblem-pricing');
app.use('/api', emblemPricingRoutes);
console.log('✓ Emblem pricing route loaded');

// File Upload Routes (Caspio Files API v3)
const filesRoutes = require('./src/routes/files-simple');
app.use('/api', filesRoutes);
console.log('✓ File upload routes loaded');

// Box Upload Routes (mockup file upload to Box → Caspio)
const boxUploadRoutes = require('./src/routes/box-upload');
app.use('/api', boxUploadRoutes);
console.log('✓ Box upload routes loaded');

// Digitizing Mockup Routes (Ruth's mockup workflow)
const mockupRoutes = require('./src/routes/mockup-routes');
app.use('/api', mockupRoutes);
console.log('✓ Digitizing Mockup routes loaded');

// Box Webhooks (Layer 2 of Box link-stability plan)
// Receives FILE.TRASHED / FILE.DELETED / ITEM.MOVED events from Box and
// auto-recovers any Caspio mockup rows that referenced the affected fileId.
const boxWebhookRoutes = require('./src/routes/box-webhooks');
app.use('/api', boxWebhookRoutes);
console.log('✓ Box webhook routes loaded');

// Transfer Orders Routes (Bradley's Supacolor workflow — heat-transfer subcontractor)
const transferOrdersRoutes = require('./src/routes/transfer-orders');
app.use('/api', transferOrdersRoutes);
console.log('✓ Transfer Orders routes loaded');

// Supacolor Jobs Routes (local mirror of Supacolor's job dashboard)
const supacolorJobsRoutes = require('./src/routes/supacolor-jobs');
app.use('/api', supacolorJobsRoutes);
console.log('✓ Supacolor Jobs routes loaded');

// Credit-Card Reconciliation Lookups (Atmos card formatter: vendors, POs, supacolor PO index)
const creditCardLookupRoutes = require('./src/routes/creditcard-lookups');
app.use('/api', creditCardLookupRoutes);
console.log('✓ Credit-Card Lookup routes loaded');

// EMB Design Files Routes (parsed EMB metadata + colorways)
const embDesignRoutes = require('./src/routes/emb-design-routes');
app.use('/api', embDesignRoutes);
console.log('✓ EMB Design Files routes loaded');

// ManageOrders Routes (with rate limiting)
// NOTE: This limiter is mounted at '/api' (not '/api/manageorders') because the
// router defines its routes as '/manageorders/...'. Without the skip filter
// below, the limiter counter increments for ANY /api/* request that falls
// through to this point (including /api/vision/*, /api/supacolor-jobs/*, etc.),
// which causes false 429s on unrelated endpoints once the budget is spent.
// The skip filter scopes counting to actual ManageOrders paths only.
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
  trustProxy: true,
  // Only count actual /manageorders/* requests, not all /api/* traffic
  skip: (req) => !req.path.startsWith('/manageorders/')
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

// ShipStation routes — outbound (our app → ShipStation) + inbound webhook
// (ShipStation → us) for tracking-number callbacks. The inbound webhook
// router is mounted at /api/webhooks so the URL stays canonical regardless
// of internal reorg.
const shipstationRoutes = require('./src/routes/shipstation');
app.use('/api/shipstation', shipstationRoutes.router);
app.use('/api/webhooks',    shipstationRoutes.webhookRouter);
console.log('✓ ShipStation routes loaded');

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

// JDS Catalog (curated NWCA-side product catalog backing the AE intake picker)
const jdsCatalogRoutes = require('./src/routes/jds-catalog');
app.use('/api/jds-catalog', jdsCatalogRoutes);
console.log('✓ JDS Catalog routes loaded');

// Sanmar-ShopWorks Mapping Routes (with rate limiting + server-side cache)
const sanmarShopworksRoutes = require('./src/routes/sanmar-shopworks');
const sanmarLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60, // 60 req/min — generous since import-format has server-side cache
  message: {
    error: 'Too many requests to SanMar-ShopWorks endpoints',
    retryAfter: '60 seconds'
  },
  standardHeaders: true,
  legacyHeaders: false,
});
app.use('/api', sanmarLimiter, sanmarShopworksRoutes);
console.log('✓ Sanmar-ShopWorks mapping routes loaded (rate limited: 60 req/min, cached)');

// SanMar PromoStandards Product Data Routes (discontinued color detection)
const sanmarProductDataRoutes = require('./src/routes/sanmar-product-data');
app.use('/api/sanmar', sanmarLimiter, sanmarProductDataRoutes);
console.log('✓ SanMar Product Data routes loaded (PromoStandards API)');

// SanMar Order Status & Shipment Routes (Order Lookup feature)
const sanmarOrderRoutes = require('./src/routes/sanmar-orders');
app.use('/api/sanmar-orders', sanmarLimiter, sanmarOrderRoutes);
console.log('✓ SanMar Order routes loaded (status, shipments, sync, backfill)');

// SanMar Invoice Routes (cost tracking, margin analysis)
const sanmarInvoiceRoutes = require('./src/routes/sanmar-invoices');
app.use('/api/sanmar-invoices', sanmarLimiter, sanmarInvoiceRoutes);
console.log('✓ SanMar Invoice routes loaded (invoices, unpaid, cost data)');

// SanMar Shipment Notification Routes (box-level shipment data for Box Labels)
const sanmarShipmentRoutes = require('./src/routes/sanmar-shipments');
app.use('/api/sanmar-shipments', sanmarLimiter, sanmarShipmentRoutes);
console.log('✓ SanMar Shipment routes loaded (box labels, tracking, shipment notifications)');

// Box Labels Data Routes (Caspio order lookup + partId resolution)
const boxLabelsDataRoutes = require('./src/routes/box-labels-data');
app.use('/api/box-labels', boxLabelsDataRoutes);
console.log('✓ Box Labels Data routes loaded (order lookup, partId resolution)');

// Thumbnail Lookup Routes
const thumbnailsRoutes = require('./src/routes/thumbnails');
app.use('/api', thumbnailsRoutes);
console.log('✓ Thumbnail routes loaded');

// DTG Designs Routes (Designs2026 filtered by DesignType=45)
const dtgDesignsRoutes = require('./src/routes/dtg-designs');
app.use('/api', dtgDesignsRoutes);
console.log('✓ DTG designs routes loaded');

// Phase 11.1 (2026-05-24) — generalized designs-by-method lookup for EMB/DTF/SCP/etc.
const designsByMethodRoutes = require('./src/routes/designs-by-method');
app.use('/api', designsByMethodRoutes);
console.log('✓ Designs by-method routes loaded');

// Decorated Cap Prices Routes
const decoratedCapPricesRoutes = require('./src/routes/decorated-cap-prices');
app.use('/api', decoratedCapPricesRoutes);
console.log('✓ Decorated cap prices routes loaded');

// Designs Routes (InkSoft Transform integration)
const designsRoutes = require('./src/routes/designs');
app.use('/api', designsRoutes);
console.log('✓ Designs routes loaded');

// Daily Sales By Rep Archive Routes (master truth for YTD displays)
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

// Customer History Routes — aggregated past-order profile for DTG form pill
const customerHistoryRoutes = require('./src/routes/customer-history');
app.use('/api', customerHistoryRoutes);
console.log('✓ Customer History routes loaded');

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

// Names & Numbers Rosters Routes (team roster management with OCR)
const rostersLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  message: { error: 'Too many requests to Rosters endpoints', retryAfter: '60 seconds' },
  standardHeaders: true,
  legacyHeaders: false,
  trustProxy: true
});
const rostersRoutes = require('./src/routes/rosters');
app.use('/api', rostersLimiter, rostersRoutes);
console.log('✓ Rosters routes loaded (rate limited: 30 req/min)');

// Garment Tracker Routes (staff dashboard tracking optimization)
const garmentTrackerRoutes = require('./src/routes/garment-tracker');
app.use('/api', garmentTrackerRoutes);
console.log('✓ Garment Tracker routes loaded');

// Online Store Commission Routes (InkSoft webstore commission tracking)
const onlineStoreCommissionRoutes = require('./src/routes/online-store-commissions');
app.use('/api', onlineStoreCommissionRoutes);
console.log('✓ Online Store Commission routes loaded');

// Commission Payouts Routes (unified commission tracking + payment history)
const commissionPayoutRoutes = require('./src/routes/commission-payouts');
app.use('/api', commissionPayoutRoutes);
console.log('✓ Commission Payouts routes loaded');

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

// Policies Hub Routes (Notion-like internal CMS for company policies & procedures)
// Two mount points:
//   /api/policies-public/*  → unprotected reads, Published+Active only (staff dashboard)
//   /api/policies/*         → protected reads + writes (admin via CRM proxy)
const { publicRouter: policiesPublicRouter, adminRouter: policiesAdminRouter } = require('./src/routes/policies');
app.use('/api/policies-public', policiesPublicRouter);
app.use('/api/policies', requireCrmApiSecret, policiesAdminRouter);
console.log('✓ Policies Hub routes loaded (public reads + protected admin)');

// Policies Hub AI Assist — Claude API streaming endpoint for the TipTap editor.
// Singular path on purpose: avoids conflict with the /api/policies/* admin router.
// Requires ANTHROPIC_API_KEY env var; protected by requireCrmApiSecret.
const policiesAIAssistRoute = require('./src/routes/policies-ai-assist');
app.use('/api/policies-ai-assist', requireCrmApiSecret, policiesAIAssistRoute);
console.log('✓ Policies AI Assist route loaded (Claude Sonnet 4.6 + prompt caching)');

// Policies Hub AI Semantic Search — open to all logged-in staff (no CRM secret).
// Rate-limited via the global apiLimiter (200 req/15min/IP). Cheap calls
// (~$0.01 each) but worth bounding. Lets any AE ask natural-language
// questions and get matched to relevant policies.
const policiesAISearchRoute = require('./src/routes/policies-ai-search');
app.use('/api/policies-ai-search', policiesAISearchRoute);
console.log('✓ Policies AI Search route loaded (public, Claude Sonnet 4.6)');

// Shared limiter for the public AI chat endpoints (contract-*-ai, dtg-quote-ai,
// emb-quote-ai). These are unauthenticated and each request spends Anthropic
// tokens (Sonnet + up to 6 tool iterations), so bound per-IP volume. 120/min is
// far above real staff usage — even a shared office IP with a dozen reps reading
// streamed replies won't sustain ~2 chat-turns/second — but it caps a single-IP
// runaway or scraper. (Coarse guard; true protection is auth — TODO.)
const aiChatLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 120,
  message: { error: 'Too many AI quote requests — please slow down and retry in a minute.', retryAfter: '60 seconds' },
  standardHeaders: true,
  legacyHeaders: false,
  trustProxy: true,
});

// Contract Embroidery AI Quote Assistant — Claude API streaming endpoint
// for the chat panel on /calculators/embroidery-contract/. Ruthie + reps
// draft email quotes by chatting with Claude; the calculator state is
// passed in calcContext on every request so prices are never re-derived.
// Public (no CRM secret) since the embroidery contract page itself is
// shareable; bounded by the global apiLimiter (200 req/15min/IP). Cost
// per quote ~$0.001-0.005 after cache warms up.
const contractEmbroideryAIRoute = require('./src/routes/contract-embroidery-ai');
app.use('/api/contract-embroidery-ai', aiChatLimiter, contractEmbroideryAIRoute);
console.log('✓ Contract Embroidery AI route loaded (public, Claude Sonnet 4.6 + prompt caching)');

// Contract DTG AI — parallel to contract-embroidery-ai. Streams Claude
// quote drafts for /calculators/dtg-contract/. CalcContext shape differs
// (locations + heavyweight instead of stitches/product), same SSE pipeline.
const contractDtgAIRoute = require('./src/routes/contract-dtg-ai');
app.use('/api/contract-dtg-ai', aiChatLimiter, contractDtgAIRoute);
console.log('✓ Contract DTG AI route loaded (public, Claude Sonnet 4.6 + prompt caching)');

// Contract Sticker AI (2026-05-15) — parallel pattern. Streams Claude
// quote drafts for /calculators/sticker-manual-pricing.html. Unlike CEMB/CDTG
// which read a pre-filled calculator state, this bot drives the inputs via
// the quote_sticker_price tool (bounding-box + qty round-up rules).
const contractStickerAIRoute = require('./src/routes/contract-sticker-ai');
app.use('/api/contract-sticker-ai', aiChatLimiter, contractStickerAIRoute);
console.log('✓ Contract Sticker AI route loaded (public, Claude Sonnet 4.6 + prompt caching)');

// Contract Emblem AI (2026-05-16) — mirrors sticker pattern. Streams Claude
// quote drafts for /calculators/embroidered-emblem/index.html. Single
// product line (embroidered patches), single quote tool (quote_emblem_price).
// Tool pulls pricing data from /api/emblem-pricing (Caspio + inline fallback).
const contractEmblemAIRoute = require('./src/routes/contract-emblem-ai');
app.use('/api/contract-emblem-ai', aiChatLimiter, contractEmblemAIRoute);
console.log('✓ Contract Emblem AI route loaded (public, Claude Sonnet 4.6 + prompt caching)');

// Contract Webstore AI (2026-05-16) — mirrors sticker dual-mode pattern.
// Streams Claude quote drafts + Q&A for /calculators/webstores.html.
// Two product modes (webstore-setup + fundraiser-item) through one chat.
// Four tools: lookup_customer + 2 pricing tools + web_search (Tavily-backed).
// New env var: TAVILY_API_KEY (free tier 1000 queries/mo) — bot gracefully
// reports "web search unavailable" if missing.
const contractWebstoreAIRoute = require('./src/routes/contract-webstore-ai');
app.use('/api/contract-webstore-ai', aiChatLimiter, contractWebstoreAIRoute);
console.log('✓ Contract Webstore AI route loaded (public, Claude Sonnet 4.6 + prompt caching + Tavily web search)');

// DTG Quote AI (2026-05-17) — chat-driven DTG retail quote builder. Single
// product line (DTG), 4 tools: lookup_customer + quote_dtg_pricing
// (calls /api/dtg/product-bundle for live pricing) + recommend_top_sellers
// (curated 6-product list from lib/dtg-curated-products.js) + web_search.
// ShopWorks push is FRONTEND-handled (button POSTs to /api/submit-order-form
// directly on sanmar-inventory-app, same as the order form does).
const dtgQuoteAIRoute = require('./src/routes/dtg-quote-ai');
app.use('/api/dtg-quote-ai', aiChatLimiter, dtgQuoteAIRoute);
console.log('✓ DTG Quote AI route loaded (public, Claude Sonnet 4.6 + prompt caching + Tavily web search + curated top-sellers)');

// EMB Quote AI (2026-05-24, Phase EMB Chat B) — research assistant for
// the Embroidery Quote Builder. 3 tools: lookup_customer, recommend_top_sellers_emb
// (Caspio EMB_Top_Sellers_2026 — Erik curates from 10yr sales),
// lookup_product_details (live SanMar query). No pricing tool — rep computes
// pricing in the form. Same SSE streaming + tool-loop pattern as DTG.
const embQuoteAIRoute = require('./src/routes/emb-quote-ai');
app.use('/api/emb-quote-ai', aiChatLimiter, embQuoteAIRoute);
console.log('✓ EMB Quote AI route loaded (Claude Sonnet 4.6 + Erik-curated 10yr EMB top-sellers)');

// Contract DTG Pricing — lean print-cost feed backing the contract DTG
// calculator. Reads Contract_DTG_Costs Caspio table (5 locations × 4 tiers)
// and returns the per-location × tier rate matrix + LTM/heavyweight policy.
const contractDtgPricingRoute = require('./src/routes/contract-dtg-pricing');
app.use('/api/contract-dtg', contractDtgPricingRoute);
console.log('✓ Contract DTG pricing route loaded (public, Caspio-backed)');

// Policies Hub Comments & Questions
//   /api/policy-comments-public/*  → unprotected reads + posts (any logged-in staff)
//   /api/policy-comments/*         → admin (resolve/hide/edit) via X-CRM-API-Secret
const { publicRouter: policyCommentsPublic, adminRouter: policyCommentsAdmin } = require('./src/routes/policy-comments');
app.use('/api/policy-comments-public', policyCommentsPublic);
app.use('/api/policy-comments', requireCrmApiSecret, policyCommentsAdmin);
console.log('✓ Policy Comments routes loaded (public reads/posts + admin moderation)');

// Assignment History Routes (audit trail for account assignments)
const assignmentHistoryRoutes = require('./src/routes/assignment-history');
app.use('/api', assignmentHistoryRoutes);
console.log('✓ Assignment History routes loaded');

// Company Contacts Routes (customer lookup for quote builders)
const companyContactsRoutes = require('./src/routes/company-contacts');
app.use('/api', companyContactsRoutes);
console.log('✓ Company Contacts routes loaded');

// Company Contacts 2026 Routes (Online Order Form autocomplete — CompanyContactsMerge2026 table)
const companyContacts2026Routes = require('./src/routes/company-contacts-2026');
app.use('/api', companyContacts2026Routes);
console.log('✓ Company Contacts 2026 routes loaded');

// Service Codes Routes (embroidery service codes, pricing tiers, fee structures)
const serviceCodesRoutes = require('./src/routes/service-codes');
app.use('/api', serviceCodesRoutes);
console.log('✓ Service Codes routes loaded');

// Order Form Customer Suggestions Routes (Phase 6c, 2026-05-03)
// Reads/writes Customer_Service_History to power the order form's
// "Suggested for {Company}" rail section.
const orderFormSuggestionsRoutes = require('./src/routes/order-form-suggestions');
app.use('/api', orderFormSuggestionsRoutes);
console.log('✓ Order Form Customer Suggestions routes loaded');

// Non-SanMar Products Routes (Brooks Brothers, Carhartt direct, specialty items)
const nonSanmarProductsRoutes = require('./src/routes/non-sanmar-products');
app.use('/api', nonSanmarProductsRoutes);
console.log('✓ Non-SanMar Products routes loaded');

// Digitized Designs Routes (design lookup for stitch count auto-detection)
const digitizedDesignsRoutes = require('./src/routes/digitized-designs');
app.use('/api', digitizedDesignsRoutes);
console.log('✓ Digitized Designs routes loaded');

// Embroidery Push Routes (push saved quotes to ShopWorks via ManageOrders PUSH API)
const embroideryPushRoutes = require('./src/routes/embroidery-push');
app.use('/api', embroideryPushRoutes);
console.log('✓ Embroidery Push routes loaded');

// DTF Push Routes (Phase 8 — same shape as EMB push, separate transformer + config)
const dtfPushRoutes = require('./src/routes/dtf-push');
app.use('/api', dtfPushRoutes);
console.log('✓ DTF Push routes loaded');

// SCP (Screen Print) Push Routes (Phase 8 — same shape as DTF push)
const scpPushRoutes = require('./src/routes/scp-push');
app.use('/api', scpPushRoutes);
console.log('✓ SCP Push routes loaded');

// Vision Routes (ShopWorks screenshot extraction via Claude Haiku)
const visionRoutes = require('./src/routes/vision');
const visionLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 10,
    message: { error: 'Too many vision requests. Please wait a moment.', retryAfter: '60 seconds' },
    standardHeaders: true,
    legacyHeaders: false
});
app.use('/api/vision', visionLimiter, visionRoutes);
console.log('✓ Vision routes loaded (rate limited: 10 req/min)');

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

    // Smoke check: Transfer_Order_Files child table reachability.
    // The transfer-orders route silently falls back to legacy-column synthesis
    // if this table is missing/dropped/permissioned-out, which masks a real
    // operational issue. Log a clear OK or WARN so Heroku log readers notice.
    try {
        const axios = require('axios');
        const token = await getCaspioAccessToken();
        const url = `${config.caspio.apiBaseUrl}/tables/Transfer_Order_Files/records?q.pageSize=1`;
        const resp = await axios.get(url, {
            headers: { 'Authorization': `Bearer ${token}` },
            timeout: 10000,
            validateStatus: () => true
        });
        if (resp.status === 200) {
            console.log('✅ [transfer-files] OK — Transfer_Order_Files reachable\n');
        } else {
            console.warn(`⚠️  [transfer-files] WARN — Transfer_Order_Files returned HTTP ${resp.status}. Falling back to legacy-column synthesis. Verify the table exists in Caspio.\n`);
        }
    } catch (error) {
        console.warn('⚠️  [transfer-files] WARN — Transfer_Order_Files smoke check failed:', error.message, '\n   Falling back to legacy-column synthesis until the table is reachable.\n');
    }

    // Schedule: daily broken-mockups digest email to Steve at 8 AM Pacific.
    // Runs in-dyno. Skipped when not in production or when EmailJS config
    // is missing (so local dev doesn't try to send real email).
    try {
        const cron = require('node-cron');
        const { runDailyDigest } = require('./src/utils/send-steve-digest');
        const digestConfigured = process.env.EMAILJS_PRIVATE_KEY
            && process.env.EMAILJS_TEMPLATE_STEVE_DIGEST;
        if (digestConfigured) {
            cron.schedule('0 8 * * *', () => {
                runDailyDigest().catch(err => {
                    console.error('[Digest] Cron failed:', err.message);
                });
            }, { timezone: 'America/Los_Angeles' });
            console.log('⏰ Steve digest cron scheduled: daily 8 AM Pacific');
        } else {
            console.log('⏰ Steve digest cron NOT scheduled — missing EmailJS env vars');
        }
    } catch (err) {
        console.error('⏰ Failed to schedule Steve digest cron:', err.message);
    }

    // Schedule: daily broken-mockups digest email to Ruth at 8 AM Pacific.
    // Sister of Steve's digest above — same pattern but scans
    // Digitizing_Mockups (Ruth's table) and emails ruth@nwcustomapparel.com.
    // Reuses EMAILJS_TEMPLATE_STEVE_DIGEST unless EMAILJS_TEMPLATE_RUTH_DIGEST
    // is set, so a single template can serve both audiences.
    try {
        const cron = require('node-cron');
        const { runDailyDigest: runRuthDigest } = require('./src/utils/send-ruth-digest');
        const ruthDigestConfigured = process.env.EMAILJS_PRIVATE_KEY
            && (process.env.EMAILJS_TEMPLATE_RUTH_DIGEST
                || process.env.EMAILJS_TEMPLATE_STEVE_DIGEST);
        if (ruthDigestConfigured) {
            cron.schedule('0 8 * * *', () => {
                runRuthDigest().catch(err => {
                    console.error('[Ruth Digest] Cron failed:', err.message);
                });
            }, { timezone: 'America/Los_Angeles' });
            console.log('⏰ Ruth digest cron scheduled: daily 8 AM Pacific');
        } else {
            console.log('⏰ Ruth digest cron NOT scheduled — missing EmailJS env vars');
        }
    } catch (err) {
        console.error('⏰ Failed to schedule Ruth digest cron:', err.message);
    }

    // Schedule: monthly orphan-Box-folder digest email to Erik at 8 AM Pacific
    // on the 1st of each month. Catches any folder that lands in Ruth's Box
    // area without a matching Caspio row (e.g. manual right-click → New Folder
    // in the Box UI). Uses the same EmailJS pipe as the Steve digest.
    try {
        const cron = require('node-cron');
        const { runOrphanDigest } = require('./src/utils/send-orphan-digest');
        const orphanDigestConfigured = process.env.EMAILJS_PRIVATE_KEY
            && process.env.EMAILJS_TEMPLATE_ORPHAN_DIGEST
            && process.env.BOX_CLIENT_ID;
        if (orphanDigestConfigured) {
            cron.schedule('0 8 1 * *', () => {
                runOrphanDigest().catch(err => {
                    console.error('[Orphan Digest] Cron failed:', err.message);
                });
            }, { timezone: 'America/Los_Angeles' });
            console.log('⏰ Orphan digest cron scheduled: 1st of month 8 AM Pacific');
        } else {
            console.log('⏰ Orphan digest cron NOT scheduled — missing env vars (EMAILJS_TEMPLATE_ORPHAN_DIGEST and/or BOX_CLIENT_ID)');
        }
    } catch (err) {
        console.error('⏰ Failed to schedule orphan digest cron:', err.message);
    }

    // Schedule: weekday AE Awaiting-Approval digest at 8 AM Pacific (Mon-Fri).
    // One email per AE listing their Awaiting Approval items, oldest first,
    // colored by days-waiting urgency. AEs with zero items get no email.
    try {
        const cron = require('node-cron');
        const { runAEApprovalDigest } = require('./src/utils/send-ae-approval-digest');
        const aeDigestConfigured = process.env.EMAILJS_PRIVATE_KEY
            && process.env.EMAILJS_TEMPLATE_AE_APPROVAL_DIGEST;
        if (aeDigestConfigured) {
            cron.schedule('0 8 * * 1-5', () => {
                runAEApprovalDigest().catch(err => {
                    console.error('[AE Digest] Cron failed:', err.message);
                });
            }, { timezone: 'America/Los_Angeles' });
            console.log('⏰ AE approval digest cron scheduled: weekdays 8 AM Pacific');
        } else {
            console.log('⏰ AE approval digest cron NOT scheduled — missing EMAILJS_TEMPLATE_AE_APPROVAL_DIGEST');
        }
    } catch (err) {
        console.error('⏰ Failed to schedule AE approval digest cron:', err.message);
    }
});

// Export for testing and route modules
module.exports = { app, fetchAllCaspioPages, makeCaspioRequest, getCaspioAccessToken };