// ManageOrders customer data routes

const express = require('express');
const router = express.Router();
const {
  fetchOrders,
  deduplicateCustomers,
  getDateDaysAgo,
  getTodayDate
} = require('../utils/manageorders');
const config = require('../../config');

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
    const orders = await fetchOrders(startDate, endDate);

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

module.exports = router;
