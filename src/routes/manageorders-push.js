/**
 * ManageOrders PUSH API - Express Routes
 *
 * Endpoints for pushing orders to ManageOrders PUSH API
 */

const express = require('express');
const router = express.Router();
const { pushOrder, verifyOrder } = require('../../lib/manageorders-push-client');
const { testAuth } = require('../../lib/manageorders-push-auth');

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
      testAuth: 'POST /api/manageorders/auth/test'
    }
  });
});

module.exports = router;
