/**
 * ManageOrders PUSH API - Express Routes
 *
 * Endpoints for pushing orders to ManageOrders PUSH API
 */

const express = require('express');
const router = express.Router();
const { pushOrder, verifyOrder } = require('../../lib/manageorders-push-client');
const { testAuth } = require('../../lib/manageorders-push-auth');
const { pushTracking, pullTracking, verifyTracking } = require('../../lib/manageorders-tracking-client');

/**
 * POST /api/manageorders/orders/create
 *
 * Create a new order in ManageOrders PUSH API
 *
 * Request Body:
 * {
 *   "orderNumber": "12345",
 *   "orderDate": "2025-10-27",
 *   "customer": {
 *     "firstName": "John",
 *     "lastName": "Doe",
 *     "email": "john@example.com",
 *     "phone": "360-555-1234",
 *     "company": "ABC Company"
 *   },
 *   "shipping": {
 *     "company": "ABC Company",
 *     "address1": "123 Main St",
 *     "address2": "Suite 100",
 *     "city": "Seattle",
 *     "state": "WA",
 *     "zip": "98101",
 *     "country": "USA",
 *     "method": "UPS Ground"
 *   },
 *   "lineItems": [
 *     {
 *       "partNumber": "PC54",
 *       "description": "Port & Company Core Cotton Tee",
 *       "color": "Red",
 *       "size": "L",
 *       "quantity": 12,
 *       "price": 8.50
 *     }
 *   ],
 *   "designs": [...],    // Optional
 *   "payments": [...],   // Optional
 *   "notes": [...]       // Optional
 * }
 *
 * Response:
 * {
 *   "success": true,
 *   "extOrderId": "NWCA-12345",
 *   "message": "Order successfully pushed to ManageOrders",
 *   "timestamp": "2025-10-27T10:30:00Z",
 *   "onsiteImportExpected": "2025-10-27T11:30:00Z"
 * }
 */
router.post('/orders/create', async (req, res) => {
  try {
    console.log('[ManageOrders PUSH Route] Received order creation request');

    const orderData = req.body;

    // Basic validation
    if (!orderData || typeof orderData !== 'object') {
      return res.status(400).json({
        success: false,
        error: 'Request body must be a valid JSON object',
        message: 'Invalid request format'
      });
    }

    // Push order to ManageOrders
    const result = await pushOrder(orderData);

    res.status(200).json({
      success: result.success,
      extOrderId: result.extOrderId,
      message: 'Order successfully pushed to ManageOrders',
      timestamp: result.timestamp,
      onsiteImportExpected: result.onsiteImportExpected,
      details: result.response
    });

  } catch (error) {
    console.error('[ManageOrders PUSH Route] Order creation failed:', error);

    // Determine appropriate status code
    let statusCode = 500;
    if (error.message.includes('is required') || error.message.includes('Invalid size')) {
      statusCode = 400; // Bad request
    }

    res.status(statusCode).json({
      success: false,
      error: error.message,
      message: 'Failed to push order to ManageOrders',
      timestamp: new Date().toISOString()
    });
  }
});

/**
 * GET /api/manageorders/orders/verify/:extOrderId
 *
 * Verify that an order was received by ManageOrders
 *
 * Parameters:
 *   extOrderId - External order ID (e.g., "NWCA-12345")
 *
 * Response:
 * {
 *   "success": true,
 *   "found": true,
 *   "extOrderId": "NWCA-12345",
 *   "uploadedAt": "2025-10-27",
 *   "orderData": {...}
 * }
 */
router.get('/orders/verify/:extOrderId', async (req, res) => {
  try {
    const { extOrderId } = req.params;

    console.log(`[ManageOrders PUSH Route] Verifying order: ${extOrderId}`);

    if (!extOrderId) {
      return res.status(400).json({
        success: false,
        error: 'extOrderId parameter is required',
        message: 'Missing order ID'
      });
    }

    const result = await verifyOrder(extOrderId);

    res.status(200).json(result);

  } catch (error) {
    console.error('[ManageOrders PUSH Route] Verification failed:', error);

    res.status(500).json({
      success: false,
      error: error.message,
      message: 'Failed to verify order',
      timestamp: new Date().toISOString()
    });
  }
});

/**
 * POST /api/manageorders/auth/test
 *
 * Test authentication with ManageOrders PUSH API
 *
 * Response:
 * {
 *   "success": true,
 *   "message": "Authentication successful",
 *   "tokenExpires": "2025-10-27T11:30:00Z"
 * }
 */
router.post('/auth/test', async (req, res) => {
  try {
    console.log('[ManageOrders PUSH Route] Testing authentication');

    const result = await testAuth();

    if (result.success) {
      res.status(200).json(result);
    } else {
      res.status(401).json(result);
    }

  } catch (error) {
    console.error('[ManageOrders PUSH Route] Auth test failed:', error);

    res.status(500).json({
      success: false,
      error: error.message,
      message: 'Authentication test failed',
      timestamp: new Date().toISOString()
    });
  }
});

/**
 * GET /api/manageorders/push/health
 *
 * Health check endpoint for PUSH API functionality
 */
router.get('/push/health', (req, res) => {
  res.status(200).json({
    status: 'healthy',
    service: 'ManageOrders PUSH API',
    timestamp: new Date().toISOString(),
    endpoints: {
      createOrder: 'POST /api/manageorders/orders/create',
      verifyOrder: 'GET /api/manageorders/orders/verify/:extOrderId',
      testAuth: 'POST /api/manageorders/auth/test',
      pushTracking: 'POST /api/manageorders/tracking/push',
      pullTracking: 'GET /api/manageorders/tracking/pull',
      verifyTracking: 'GET /api/manageorders/tracking/verify/:extOrderId'
    }
  });
});

// ============================================================================
// TRACKING ENDPOINTS
// ============================================================================

/**
 * POST /api/manageorders/tracking/push
 *
 * Push tracking information to ManageOrders
 *
 * Request Body (single tracking):
 * {
 *   "extOrderId": "NWCA-12345",
 *   "trackingNumber": "1Z999AA10123456784",
 *   "shippingMethod": "UPS Ground",
 *   "cost": 12.95,
 *   "weight": 2.5,
 *   "extShipId": "SHIP-1"  // optional, for split shipments
 * }
 *
 * Request Body (multiple tracking - array):
 * [
 *   { "extOrderId": "NWCA-12345", "trackingNumber": "1Z999AA10123456784", ... },
 *   { "extOrderId": "NWCA-12346", "trackingNumber": "1Z999AA10123456785", ... }
 * ]
 *
 * Response:
 * {
 *   "success": true,
 *   "trackingCount": 1,
 *   "trackingNumbers": ["1Z999AA10123456784"],
 *   "extOrderIds": ["NWCA-12345"],
 *   "timestamp": "2025-01-11T10:30:00Z"
 * }
 */
router.post('/tracking/push', async (req, res) => {
  try {
    console.log('[ManageOrders Tracking Route] Received tracking push request');

    const trackingData = req.body;

    // Basic validation
    if (!trackingData || (typeof trackingData !== 'object' && !Array.isArray(trackingData))) {
      return res.status(400).json({
        success: false,
        error: 'Request body must be a valid JSON object or array',
        message: 'Invalid request format'
      });
    }

    // Push tracking to ManageOrders
    const result = await pushTracking(trackingData);

    res.status(200).json(result);

  } catch (error) {
    console.error('[ManageOrders Tracking Route] Tracking push failed:', error);

    // Determine appropriate status code
    let statusCode = 500;
    if (error.message.includes('is required')) {
      statusCode = 400; // Bad request
    }

    res.status(statusCode).json({
      success: false,
      error: error.message,
      message: 'Failed to push tracking to ManageOrders',
      timestamp: new Date().toISOString()
    });
  }
});

/**
 * GET /api/manageorders/tracking/pull
 *
 * Pull/retrieve tracking data from ManageOrders by date range
 *
 * Query Parameters:
 *   dateFrom (required) - Start date (YYYY-MM-DD)
 *   dateTo (required) - End date (YYYY-MM-DD)
 *   timeFrom (optional) - Start time (HH-MM-SS)
 *   timeTo (optional) - End time (HH-MM-SS)
 *   apiSource (optional) - Filter: "all", "none", or specific source name
 *
 * Example: GET /api/manageorders/tracking/pull?dateFrom=2025-01-10&dateTo=2025-01-11&apiSource=NWCA
 *
 * Response:
 * {
 *   "success": true,
 *   "count": 5,
 *   "dateRange": { "from": "2025-01-10", "to": "2025-01-11" },
 *   "tracking": [...],
 *   "timestamp": "2025-01-11T10:30:00Z"
 * }
 */
router.get('/tracking/pull', async (req, res) => {
  try {
    const { dateFrom, dateTo, timeFrom, timeTo, apiSource } = req.query;

    console.log(`[ManageOrders Tracking Route] Pulling tracking: ${dateFrom} to ${dateTo}`);

    if (!dateFrom || !dateTo) {
      return res.status(400).json({
        success: false,
        error: 'dateFrom and dateTo query parameters are required',
        message: 'Missing required date parameters',
        example: '/api/manageorders/tracking/pull?dateFrom=2025-01-10&dateTo=2025-01-11'
      });
    }

    const result = await pullTracking({
      dateFrom,
      dateTo,
      timeFrom,
      timeTo,
      apiSource
    });

    res.status(200).json(result);

  } catch (error) {
    console.error('[ManageOrders Tracking Route] Tracking pull failed:', error);

    res.status(500).json({
      success: false,
      error: error.message,
      message: 'Failed to pull tracking from ManageOrders',
      timestamp: new Date().toISOString()
    });
  }
});

/**
 * GET /api/manageorders/tracking/verify/:extOrderId
 *
 * Verify tracking was pushed for a specific order
 *
 * Parameters:
 *   extOrderId - External order ID (e.g., "NWCA-12345")
 *
 * Query Parameters (optional):
 *   dateFrom - Start date to search (defaults to today)
 *   dateTo - End date to search (defaults to today)
 *
 * Response:
 * {
 *   "success": true,
 *   "found": true,
 *   "extOrderId": "NWCA-12345",
 *   "trackingCount": 1,
 *   "tracking": [...]
 * }
 */
router.get('/tracking/verify/:extOrderId', async (req, res) => {
  try {
    const { extOrderId } = req.params;
    const { dateFrom, dateTo } = req.query;

    console.log(`[ManageOrders Tracking Route] Verifying tracking for order: ${extOrderId}`);

    if (!extOrderId) {
      return res.status(400).json({
        success: false,
        error: 'extOrderId parameter is required',
        message: 'Missing order ID'
      });
    }

    const result = await verifyTracking(extOrderId, dateFrom, dateTo);

    res.status(200).json(result);

  } catch (error) {
    console.error('[ManageOrders Tracking Route] Tracking verification failed:', error);

    res.status(500).json({
      success: false,
      error: error.message,
      message: 'Failed to verify tracking',
      timestamp: new Date().toISOString()
    });
  }
});

module.exports = router;
