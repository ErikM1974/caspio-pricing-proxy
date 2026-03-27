// ManageOrders customer data routes

const express = require('express');
const router = express.Router();
const {
  authenticateManageOrders,
  fetchOrders,
  fetchOrderByNumber,
  fetchOrderNoByExternalId,
  fetchLineItems,
  fetchPayments,
  fetchTracking,
  fetchInventoryLevels,
  deduplicateCustomers,
  getDateDaysAgo,
  getTodayDate,
  moClient
} = require('../utils/manageorders');
const config = require('../../config');

// ==============================================
// STALE-WHILE-REVALIDATE HELPER
// ==============================================
// Returns cached data immediately (even if expired) while refreshing in the background.
// The next request will get fresh data from the background refresh.

/**
 * Stale-while-revalidate cache check.
 * Returns { hit: true, data, stale: false } for fresh cache hits.
 * Returns { hit: true, data, stale: true } for expired cache (triggers background refresh).
 * Returns { hit: false } for cache miss.
 */
function checkCacheWithSWR(cache, cacheKey, cacheDuration, forceRefresh) {
  if (forceRefresh) return { hit: false };

  const cached = cache.get(cacheKey);
  if (!cached) return { hit: false };

  const age = Date.now() - cached.timestamp;
  if (age < cacheDuration) {
    return { hit: true, data: cached.data, stale: false, timestamp: cached.timestamp };
  }

  // Expired but we have data — return stale, let caller revalidate in background
  return { hit: true, data: cached.data, stale: true, timestamp: cached.timestamp };
}

/**
 * Background revalidation — fetches fresh data and updates the cache.
 * Errors are logged but not thrown (stale data was already served).
 */
function revalidateInBackground(cache, cacheKey, fetchFn, label) {
  fetchFn().then(data => {
    cache.set(cacheKey, { data, timestamp: Date.now() });
    console.log(`[SWR] Background refresh complete for ${label}`);
  }).catch(err => {
    console.warn(`[SWR] Background refresh failed for ${label}: ${err.message}`);
  });
}

// Customer data cache
let customersCache = null;
let cacheTimestamp = 0;

/**
 * GET /api/manageorders/customers
 *
 * Fetches unique customers from ManageOrders based on orders from the last 60 days.
 *
 * Query Parameters:
 *   - refresh (boolean): Force refresh of cached data (default: false)
 *
 * Response:
 *   {
 *     "customers": [...],
 *     "cached": true/false,
 *     "cacheDate": "2025-10-26",
 *     "count": 383
 *   }
 */
router.get('/manageorders/customers', async (req, res) => {
  console.log('GET /api/manageorders/customers requested');

  try {
    const now = Date.now();
    const forceRefresh = req.query.refresh === 'true';

    // Check if we can use cached data
    const cacheValid = customersCache &&
      cacheTimestamp &&
      (now - cacheTimestamp) < config.manageOrders.customerCacheDuration &&
      !forceRefresh;

    if (cacheValid) {
      console.log('Returning cached customer data');
      return res.json({
        customers: customersCache,
        cached: true,
        cacheDate: new Date(cacheTimestamp).toISOString().split('T')[0],
        count: customersCache.length
      });
    }

    // Fetch fresh data
    console.log('Fetching fresh customer data from ManageOrders...');

    const startDate = getDateDaysAgo(config.manageOrders.defaultDaysBack);
    const endDate = getTodayDate();

    console.log(`Date range: ${startDate} to ${endDate}`);

    // Fetch orders from ManageOrders
    const orders = await fetchOrders({
      date_Ordered_start: startDate,
      date_Ordered_end: endDate
    });

    if (!orders || orders.length === 0) {
      console.warn('No orders returned from ManageOrders');
      return res.json({
        customers: [],
        cached: false,
        cacheDate: new Date().toISOString().split('T')[0],
        count: 0
      });
    }

    // Deduplicate customers from orders
    const customers = deduplicateCustomers(orders);

    // Update cache
    customersCache = customers;
    cacheTimestamp = now;

    console.log(`Successfully fetched ${customers.length} unique customers`);

    res.json({
      customers: customers,
      cached: false,
      cacheDate: new Date(cacheTimestamp).toISOString().split('T')[0],
      count: customers.length
    });

  } catch (error) {
    console.error('Error in /api/manageorders/customers:', error.message);

    // Return appropriate error without exposing sensitive details
    const statusCode = error.message.includes('authentication') ? 401 : 500;
    res.status(statusCode).json({
      error: 'Failed to fetch customer data from ManageOrders',
      details: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

/**
 * GET /api/manageorders/cache-info
 *
 * Returns information about the current cache state (for debugging).
 */
router.get('/manageorders/cache-info', (req, res) => {
  const now = Date.now();
  const cacheAge = cacheTimestamp ? now - cacheTimestamp : null;
  const cacheValid = customersCache &&
    cacheTimestamp &&
    cacheAge < config.manageOrders.customerCacheDuration;

  res.json({
    cacheExists: !!customersCache,
    cacheValid: cacheValid,
    cacheTimestamp: cacheTimestamp ? new Date(cacheTimestamp).toISOString() : null,
    cacheAgeMs: cacheAge,
    cacheAgeMinutes: cacheAge ? Math.floor(cacheAge / 60000) : null,
    cacheDurationMs: config.manageOrders.customerCacheDuration,
    customerCount: customersCache ? customersCache.length : 0
  });
});

// ========================================
// ORDERS ENDPOINTS
// ========================================

// Orders cache (configurable, default 4 hours)
let ordersCache = new Map();
const ORDERS_CACHE_DURATION = config.manageOrders.ordersCacheDuration || 4 * 60 * 60 * 1000;

/**
 * GET /api/manageorders/orders
 *
 * Fetches orders by date range with multiple date filter options.
 * Date filters: date_Ordered, date_Invoiced, date_RequestedToShip, date_Produced, date_Shipped
 * Optional: id_Customer - Filter by specific customer ID (e.g., ?id_Customer=1821)
 */
router.get('/manageorders/orders', async (req, res) => {
  console.log('GET /api/manageorders/orders requested');

  try {
    const forceRefresh = req.query.refresh === 'true';
    const cacheKey = JSON.stringify(req.query);

    // Check cache with stale-while-revalidate
    const cacheResult = checkCacheWithSWR(ordersCache, cacheKey, ORDERS_CACHE_DURATION, forceRefresh);

    if (cacheResult.hit) {
      if (cacheResult.stale) {
        // Return stale data immediately, refresh in background
        console.log('[SWR] Returning stale orders, refreshing in background');
        revalidateInBackground(ordersCache, cacheKey, () => fetchOrders(req.query), 'orders');
      } else {
        console.log('Returning cached orders data');
      }
      return res.json({
        result: cacheResult.data,
        count: cacheResult.data.length,
        cached: true,
        stale: cacheResult.stale || false,
        cacheDate: new Date(cacheResult.timestamp).toISOString()
      });
    }

    // No cache at all — fetch fresh data
    const orders = await fetchOrders(req.query);

    ordersCache.set(cacheKey, { data: orders, timestamp: Date.now() });

    res.json({
      result: orders,
      count: orders.length,
      cached: false
    });

  } catch (error) {
    console.error('Error in /api/manageorders/orders:', error.message);
    res.status(500).json({
      error: 'Failed to fetch orders from ManageOrders',
      details: error.message
    });
  }
});

// Order by number cache (24 hours - historical data)
let orderByNumberCache = new Map();
const ORDER_CACHE_DURATION = 24 * 60 * 60 * 1000; // 24 hours

/**
 * GET /api/manageorders/orders/:order_no
 *
 * Fetches a specific order by order number.
 */
router.get('/manageorders/orders/:order_no', async (req, res) => {
  const orderNo = req.params.order_no;
  console.log(`GET /api/manageorders/orders/${orderNo} requested`);

  try {
    const now = Date.now();
    const forceRefresh = req.query.refresh === 'true';

    // Check cache
    const cached = orderByNumberCache.get(orderNo);
    if (!forceRefresh && cached && (now - cached.timestamp) < ORDER_CACHE_DURATION) {
      console.log(`Returning cached order #${orderNo}`);
      return res.json({
        result: cached.data,
        count: cached.data.length,
        cached: true,
        cacheDate: new Date(cached.timestamp).toISOString()
      });
    }

    // Fetch fresh data
    const order = await fetchOrderByNumber(orderNo);

    // Update cache
    orderByNumberCache.set(orderNo, {
      data: order,
      timestamp: now
    });

    res.json({
      result: order,
      count: order.length,
      cached: false
    });

  } catch (error) {
    console.error(`Error in /api/manageorders/orders/${orderNo}:`, error.message);
    res.status(500).json({
      error: 'Failed to fetch order from ManageOrders',
      details: error.message
    });
  }
});

/**
 * GET /api/manageorders/getorderno/:ext_order_id
 *
 * Gets the ManageOrders order number from an external order ID.
 */
router.get('/manageorders/getorderno/:ext_order_id', async (req, res) => {
  const extOrderId = req.params.ext_order_id;
  console.log(`GET /api/manageorders/getorderno/${extOrderId} requested`);

  try {
    const result = await fetchOrderNoByExternalId(extOrderId);

    res.json({
      result: result,
      count: result.length,
      cached: false
    });

  } catch (error) {
    console.error(`Error in /api/manageorders/getorderno/${extOrderId}:`, error.message);
    res.status(500).json({
      error: 'Failed to fetch order number from ManageOrders',
      details: error.message
    });
  }
});

// ========================================
// LINE ITEMS ENDPOINTS
// ========================================

let lineItemsCache = new Map();

/**
 * GET /api/manageorders/lineitems/:order_no
 *
 * Fetches line items for a specific order.
 */
router.get('/manageorders/lineitems/:order_no', async (req, res) => {
  const orderNo = req.params.order_no;
  console.log(`GET /api/manageorders/lineitems/${orderNo} requested`);

  try {
    const now = Date.now();
    const forceRefresh = req.query.refresh === 'true';

    // Check cache
    const cached = lineItemsCache.get(orderNo);
    if (!forceRefresh && cached && (now - cached.timestamp) < ORDER_CACHE_DURATION) {
      console.log(`Returning cached line items for order #${orderNo}`);
      return res.json({
        result: cached.data,
        count: cached.data.length,
        cached: true,
        cacheDate: new Date(cached.timestamp).toISOString()
      });
    }

    // Fetch fresh data
    const lineItems = await fetchLineItems(orderNo);

    // Update cache
    lineItemsCache.set(orderNo, {
      data: lineItems,
      timestamp: now
    });

    res.json({
      result: lineItems,
      count: lineItems.length,
      cached: false
    });

  } catch (error) {
    console.error(`Error in /api/manageorders/lineitems/${orderNo}:`, error.message);
    res.status(500).json({
      error: 'Failed to fetch line items from ManageOrders',
      details: error.message
    });
  }
});

// ========================================
// PAYMENTS ENDPOINTS
// ========================================

let paymentsCache = new Map();

/**
 * GET /api/manageorders/payments
 *
 * Fetches payments by date range.
 */
// Use payments-specific cache duration from config
const PAYMENTS_CACHE_DURATION = config.manageOrders.paymentsCacheDuration || 4 * 60 * 60 * 1000;

router.get('/manageorders/payments', async (req, res) => {
  console.log('GET /api/manageorders/payments requested');

  try {
    const forceRefresh = req.query.refresh === 'true';
    const cacheKey = JSON.stringify(req.query);

    // Check cache with stale-while-revalidate
    const cacheResult = checkCacheWithSWR(paymentsCache, cacheKey, PAYMENTS_CACHE_DURATION, forceRefresh);

    if (cacheResult.hit) {
      if (cacheResult.stale) {
        console.log('[SWR] Returning stale payments, refreshing in background');
        revalidateInBackground(paymentsCache, cacheKey, () => fetchPayments(req.query), 'payments');
      } else {
        console.log('Returning cached payments data');
      }
      return res.json({
        result: cacheResult.data,
        count: cacheResult.data.length,
        cached: true,
        stale: cacheResult.stale || false,
        cacheDate: new Date(cacheResult.timestamp).toISOString()
      });
    }

    // No cache — fetch fresh
    const payments = await fetchPayments(req.query);
    paymentsCache.set(cacheKey, { data: payments, timestamp: Date.now() });

    res.json({
      result: payments,
      count: payments.length,
      cached: false
    });

  } catch (error) {
    console.error('Error in /api/manageorders/payments:', error.message);
    res.status(500).json({
      error: 'Failed to fetch payments from ManageOrders',
      details: error.message
    });
  }
});

/**
 * GET /api/manageorders/payments/:order_no
 *
 * Fetches payments for a specific order.
 */
router.get('/manageorders/payments/:order_no', async (req, res) => {
  const orderNo = req.params.order_no;
  console.log(`GET /api/manageorders/payments/${orderNo} requested`);

  try {
    const forceRefresh = req.query.refresh === 'true';
    const cacheKey = `order_${orderNo}`;

    // Check cache with stale-while-revalidate
    const cacheResult = checkCacheWithSWR(paymentsCache, cacheKey, ORDER_CACHE_DURATION, forceRefresh);

    if (cacheResult.hit) {
      if (cacheResult.stale) {
        console.log(`[SWR] Returning stale payments for order #${orderNo}, refreshing in background`);
        revalidateInBackground(paymentsCache, cacheKey, () => fetchPayments(orderNo), `payments#${orderNo}`);
      } else {
        console.log(`Returning cached payments for order #${orderNo}`);
      }
      return res.json({
        result: cacheResult.data,
        count: cacheResult.data.length,
        cached: true,
        stale: cacheResult.stale || false,
        cacheDate: new Date(cacheResult.timestamp).toISOString()
      });
    }

    // No cache — fetch fresh
    const payments = await fetchPayments(orderNo);
    paymentsCache.set(cacheKey, { data: payments, timestamp: Date.now() });

    res.json({
      result: payments,
      count: payments.length,
      cached: false
    });

  } catch (error) {
    console.error(`Error in /api/manageorders/payments/${orderNo}:`, error.message);
    res.status(500).json({
      error: 'Failed to fetch payments from ManageOrders',
      details: error.message
    });
  }
});

// ========================================
// TRACKING ENDPOINTS
// ========================================

let trackingCache = new Map();
const TRACKING_CACHE_DURATION = config.manageOrders.trackingCacheDuration || 30 * 60 * 1000; // 30 minutes

/**
 * GET /api/manageorders/tracking
 *
 * Fetches tracking information by date range.
 */
router.get('/manageorders/tracking', async (req, res) => {
  console.log('GET /api/manageorders/tracking requested');

  try {
    const forceRefresh = req.query.refresh === 'true';
    const cacheKey = JSON.stringify(req.query);

    // Check cache with stale-while-revalidate
    const cacheResult = checkCacheWithSWR(trackingCache, cacheKey, TRACKING_CACHE_DURATION, forceRefresh);

    if (cacheResult.hit) {
      if (cacheResult.stale) {
        console.log('[SWR] Returning stale tracking, refreshing in background');
        revalidateInBackground(trackingCache, cacheKey, () => fetchTracking(req.query), 'tracking');
      } else {
        console.log('Returning cached tracking data');
      }
      return res.json({
        result: cacheResult.data,
        count: cacheResult.data.length,
        cached: true,
        stale: cacheResult.stale || false,
        cacheDate: new Date(cacheResult.timestamp).toISOString()
      });
    }

    // No cache — fetch fresh
    const tracking = await fetchTracking(req.query);
    trackingCache.set(cacheKey, { data: tracking, timestamp: Date.now() });

    res.json({
      result: tracking,
      count: tracking.length,
      cached: false
    });

  } catch (error) {
    console.error('Error in /api/manageorders/tracking:', error.message);
    res.status(500).json({
      error: 'Failed to fetch tracking from ManageOrders',
      details: error.message
    });
  }
});

/**
 * GET /api/manageorders/tracking/:order_no
 *
 * Fetches tracking information for a specific order.
 */
router.get('/manageorders/tracking/:order_no', async (req, res) => {
  const orderNo = req.params.order_no;
  console.log(`GET /api/manageorders/tracking/${orderNo} requested`);

  try {
    const now = Date.now();
    const forceRefresh = req.query.refresh === 'true';
    const cacheKey = `order_${orderNo}`;

    // Check cache
    const cached = trackingCache.get(cacheKey);
    if (!forceRefresh && cached && (now - cached.timestamp) < TRACKING_CACHE_DURATION) {
      console.log(`Returning cached tracking for order #${orderNo}`);
      return res.json({
        result: cached.data,
        count: cached.data.length,
        cached: true,
        cacheDate: new Date(cached.timestamp).toISOString()
      });
    }

    // Fetch fresh data
    const tracking = await fetchTracking(orderNo);

    // Update cache
    trackingCache.set(cacheKey, {
      data: tracking,
      timestamp: now
    });

    res.json({
      result: tracking,
      count: tracking.length,
      cached: false
    });

  } catch (error) {
    console.error(`Error in /api/manageorders/tracking/${orderNo}:`, error.message);
    res.status(500).json({
      error: 'Failed to fetch tracking from ManageOrders',
      details: error.message
    });
  }
});

// ========================================
// INVENTORY ENDPOINTS
// ========================================

let inventoryCache = new Map();
const INVENTORY_CACHE_DURATION = config.manageOrders.inventoryCacheDuration || 3 * 60 * 1000; // 3 minutes (was 1 min)

// Cache cleanup - Remove expired entries every 5 minutes
setInterval(() => {
  const now = Date.now();
  let cleanedCount = 0;

  for (const [key, value] of inventoryCache.entries()) {
    if (now - value.timestamp > INVENTORY_CACHE_DURATION) {
      inventoryCache.delete(key);
      cleanedCount++;
    }
  }

  if (cleanedCount > 0) {
    console.log(`[Cache Cleanup] Removed ${cleanedCount} expired inventory cache entries`);
  }
}, 5 * 60 * 1000); // Run cleanup every 5 minutes

/**
 * GET /api/manageorders/inventory-cache-stats
 *
 * Returns detailed statistics about the inventory cache (for debugging).
 */
router.get('/manageorders/inventory-cache-stats', (req, res) => {
  const now = Date.now();
  const stats = {
    totalEntries: inventoryCache.size,
    validEntries: 0,
    expiredEntries: 0,
    cacheDurationMs: INVENTORY_CACHE_DURATION,
    cacheDurationMinutes: INVENTORY_CACHE_DURATION / 60000,
    entries: []
  };

  for (const [key, value] of inventoryCache.entries()) {
    const age = now - value.timestamp;
    const isValid = age < INVENTORY_CACHE_DURATION;
    const params = JSON.parse(key);

    if (isValid) {
      stats.validEntries++;
    } else {
      stats.expiredEntries++;
    }

    stats.entries.push({
      params: params,
      timestamp: new Date(value.timestamp).toISOString(),
      ageMs: age,
      ageMinutes: Math.floor(age / 60000),
      isValid: isValid,
      recordCount: value.data.length,
      oldestDataModification: value.data.length > 0
        ? value.data.reduce((oldest, item) => {
            const modDate = new Date(item.date_Modification);
            return modDate < oldest ? modDate : oldest;
          }, new Date(value.data[0].date_Modification)).toISOString()
        : null
    });
  }

  res.json(stats);
});

/**
 * POST /api/manageorders/inventory-cache-clear
 *
 * Clears the entire inventory cache (for debugging/troubleshooting).
 */
router.post('/manageorders/inventory-cache-clear', (req, res) => {
  const entriesCleared = inventoryCache.size;
  inventoryCache.clear();

  console.log(`[Manual Cache Clear] Cleared ${entriesCleared} inventory cache entries`);

  res.json({
    success: true,
    message: `Cleared ${entriesCleared} inventory cache entries`,
    timestamp: new Date().toISOString()
  });
});

/**
 * GET /api/manageorders/inventorylevels
 *
 * Fetches inventory levels with optional filters.
 * Supports: PartNumber, ColorRange, Color, SKU, VendorName, etc.
 */
router.get('/manageorders/inventorylevels', async (req, res) => {
  const queryParams = Object.keys(req.query).filter(k => k !== 'refresh').map(k => `${k}=${req.query[k]}`).join(', ') || 'none';
  console.log(`GET /api/manageorders/inventorylevels requested (params: ${queryParams})`);

  try {
    const now = Date.now();
    const forceRefresh = req.query.refresh === 'true';
    const cacheKey = JSON.stringify(req.query);

    // Check cache (short duration for real-time inventory)
    const cached = inventoryCache.get(cacheKey);
    if (!forceRefresh && cached && (now - cached.timestamp) < INVENTORY_CACHE_DURATION) {
      const cacheAgeSeconds = Math.floor((now - cached.timestamp) / 1000);
      console.log(`[CACHE HIT] Returning cached inventory data (age: ${cacheAgeSeconds}s, entries: ${cached.data.length})`);

      // Check for stale data warning
      const warnings = [];
      if (cached.data.length > 0) {
        const oldestMod = cached.data.reduce((oldest, item) => {
          const modDate = new Date(item.date_Modification);
          return modDate < oldest ? modDate : oldest;
        }, new Date(cached.data[0].date_Modification));

        const daysOld = Math.floor((now - oldestMod.getTime()) / (1000 * 60 * 60 * 24));
        if (daysOld > 7) {
          warnings.push(`Data is ${daysOld} days old - ManageOrders may be out of sync with OnSite`);
        }
      }

      return res.json({
        result: cached.data,
        count: cached.data.length,
        cached: true,
        cacheDate: new Date(cached.timestamp).toISOString(),
        warnings: warnings.length > 0 ? warnings : undefined
      });
    }

    // Fetch fresh data
    console.log(`[CACHE MISS] Fetching fresh inventory data from ManageOrders...`);
    const inventory = await fetchInventoryLevels(req.query);
    console.log(`[API FETCH] Received ${inventory.length} inventory records from ManageOrders`);

    // Check for stale data warning
    const warnings = [];
    if (inventory.length > 0) {
      const oldestMod = inventory.reduce((oldest, item) => {
        const modDate = new Date(item.date_Modification);
        return modDate < oldest ? modDate : oldest;
      }, new Date(inventory[0].date_Modification));

      const daysOld = Math.floor((now - oldestMod.getTime()) / (1000 * 60 * 60 * 24));

      if (daysOld > 7) {
        const warningMsg = `⚠️  Data is ${daysOld} days old (last modified: ${oldestMod.toISOString().split('T')[0]}) - ManageOrders may be out of sync with OnSite`;
        warnings.push(warningMsg);
        console.warn(`[STALE DATA WARNING] ${warningMsg}`);
      }
    }

    // Update cache
    inventoryCache.set(cacheKey, {
      data: inventory,
      timestamp: now
    });

    res.json({
      result: inventory,
      count: inventory.length,
      cached: false,
      warnings: warnings.length > 0 ? warnings : undefined
    });

  } catch (error) {
    console.error('Error in /api/manageorders/inventorylevels:', error.message);
    res.status(500).json({
      error: 'Failed to fetch inventory levels from ManageOrders',
      details: error.message
    });
  }
});

// ========================================
// HEALTH / DIAGNOSTICS ENDPOINT
// ========================================

/**
 * GET /api/manageorders/health
 *
 * Measures ManageOrders API response times for diagnostics.
 * Tests auth + a lightweight orders query. Use this data when calling ShopWorks support.
 */
router.get('/manageorders/health', async (req, res) => {
  console.log('GET /api/manageorders/health - running diagnostics');

  const results = {
    timestamp: new Date().toISOString(),
    tests: {}
  };

  // Test 1: Authentication
  try {
    const authStart = Date.now();
    // Force fresh auth by testing the sign-in directly
    const authResponse = await moClient.post('/manageorders/signin', {
      username: config.manageOrders.username,
      password: config.manageOrders.password
    }, { timeout: 15000 });
    const authMs = Date.now() - authStart;

    results.tests.authentication = {
      status: 'ok',
      responseTimeMs: authMs,
      rating: authMs < 1000 ? 'fast' : authMs < 3000 ? 'normal' : authMs < 10000 ? 'slow' : 'very slow'
    };

    const token = authResponse.data?.id_token;

    // Test 2: Orders query (last 7 days, small window)
    if (token) {
      try {
        const ordersStart = Date.now();
        const sevenDaysAgo = getDateDaysAgo(7);
        const today = getTodayDate();
        const ordersResponse = await moClient.get('/manageorders/orders', {
          params: { date_Ordered_start: sevenDaysAgo, date_Ordered_end: today },
          headers: { 'Authorization': `Bearer ${token}` },
          timeout: 30000
        });
        const ordersMs = Date.now() - ordersStart;
        const recordCount = ordersResponse.data?.result?.length || 0;

        results.tests.ordersQuery = {
          status: 'ok',
          responseTimeMs: ordersMs,
          recordsReturned: recordCount,
          dateRange: `${sevenDaysAgo} to ${today}`,
          rating: ordersMs < 2000 ? 'fast' : ordersMs < 5000 ? 'normal' : ordersMs < 15000 ? 'slow' : 'very slow'
        };
      } catch (ordersErr) {
        results.tests.ordersQuery = {
          status: 'error',
          error: ordersErr.message,
          timedOut: ordersErr.code === 'ECONNABORTED'
        };
      }

      // Test 3: Inventory query (lightweight)
      try {
        const invStart = Date.now();
        const invResponse = await moClient.get('/manageorders/inventorylevels', {
          params: { PartNumber: 'PC54' }, // common style for quick test
          headers: { 'Authorization': `Bearer ${token}` },
          timeout: 30000
        });
        const invMs = Date.now() - invStart;
        const invCount = invResponse.data?.result?.length || 0;

        results.tests.inventoryQuery = {
          status: 'ok',
          responseTimeMs: invMs,
          recordsReturned: invCount,
          testPartNumber: 'PC54',
          rating: invMs < 2000 ? 'fast' : invMs < 5000 ? 'normal' : invMs < 15000 ? 'slow' : 'very slow'
        };
      } catch (invErr) {
        results.tests.inventoryQuery = {
          status: 'error',
          error: invErr.message,
          timedOut: invErr.code === 'ECONNABORTED'
        };
      }
    }
  } catch (authErr) {
    results.tests.authentication = {
      status: 'error',
      error: authErr.message,
      timedOut: authErr.code === 'ECONNABORTED'
    };
  }

  // Summary
  const totalMs = Object.values(results.tests)
    .filter(t => t.responseTimeMs)
    .reduce((sum, t) => sum + t.responseTimeMs, 0);

  results.summary = {
    totalResponseTimeMs: totalMs,
    overallRating: totalMs < 5000 ? 'healthy' : totalMs < 15000 ? 'degraded' : 'critical',
    cacheStatus: {
      customers: { cached: !!customersCache, entries: customersCache ? customersCache.length : 0 },
      orders: { entries: ordersCache.size },
      payments: { entries: paymentsCache.size },
      tracking: { entries: trackingCache.size },
      inventory: { entries: inventoryCache.size }
    },
    recommendations: []
  };

  if (totalMs > 15000) {
    results.summary.recommendations.push('ManageOrders API is critically slow. Contact ShopWorks support with this diagnostic data.');
  }
  if (totalMs > 5000 && totalMs <= 15000) {
    results.summary.recommendations.push('ManageOrders API is slower than expected. Consider increasing cache TTLs.');
  }

  res.json(results);
});

module.exports = router;
