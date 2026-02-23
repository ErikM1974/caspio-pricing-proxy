/**
 * Embroidery Push Route
 *
 * Pushes saved embroidery quotes to ShopWorks via ManageOrders PUSH API.
 * Uses the dedicated /embroidery integration endpoint (separate from /onsite).
 *
 * Endpoints:
 *   POST /api/embroidery-push/push-quote  — Transform & push a quote
 *   GET  /api/embroidery-push/verify/:extOrderId — Verify order exists
 *   GET  /api/embroidery-push/health — Test auth connectivity
 */

const express = require('express');
const router = express.Router();
const axios = require('axios');
const { fetchAllCaspioPages, makeCaspioRequest } = require('../utils/caspio');
const { getTokenForEndpoint } = require('../../lib/manageorders-push-auth');
const { transformQuoteToOrder } = require('../../lib/embroidery-push-transformer');
const { EMB_BASE_URL, generateEmbExtOrderID } = require('../../config/manageorders-emb-config');

/**
 * POST /api/embroidery-push/push-quote
 *
 * Push a saved embroidery quote to ShopWorks via ManageOrders PUSH API.
 *
 * Body: { quoteId: string, isTest?: boolean, force?: boolean }
 *
 * Flow:
 * 1. Validate quoteId
 * 2. Fetch quote_sessions + quote_items from Caspio
 * 3. Check PushedToShopWorks (reject if already pushed unless force=true)
 * 4. Transform to ExternalOrderJson
 * 5. Auth against /embroidery/signin
 * 6. POST to /embroidery/order-push
 * 7. On success, update PushedToShopWorks timestamp in Caspio
 * 8. Return result
 */
router.post('/embroidery-push/push-quote', express.json(), async (req, res) => {
  const { quoteId, isTest = false, force = false } = req.body;

  console.log(`[EMB Push] Push request for quote: ${quoteId} (test=${isTest}, force=${force})`);

  try {
    // 1. Validate quoteId
    if (!quoteId || typeof quoteId !== 'string') {
      return res.status(400).json({ error: 'quoteId is required' });
    }

    // Sanitize: only allow alphanumeric, hyphens, underscores
    if (!/^[a-zA-Z0-9\-_]+$/.test(quoteId)) {
      return res.status(400).json({ error: 'Invalid quoteId format' });
    }

    // 2. Fetch session from Caspio
    console.log(`[EMB Push] Fetching session for ${quoteId}...`);
    const sessions = await fetchAllCaspioPages('/tables/Quote_Sessions/records', {
      'q.where': `QuoteID='${quoteId}'`,
    });

    if (!sessions || sessions.length === 0) {
      return res.status(404).json({ error: `Quote ${quoteId} not found` });
    }
    const session = sessions[0];

    // 3. Check duplicate push
    if (session.PushedToShopWorks && !force) {
      return res.status(409).json({
        error: 'Quote already pushed to ShopWorks',
        pushedAt: session.PushedToShopWorks,
        extOrderId: generateEmbExtOrderID(quoteId, false),
        message: 'Use force=true to push again',
      });
    }

    // 4. Fetch items from Caspio
    console.log(`[EMB Push] Fetching items for ${quoteId}...`);
    const items = await fetchAllCaspioPages('/tables/Quote_Items/records', {
      'q.where': `QuoteID='${quoteId}'`,
    });

    if (!items || items.length === 0) {
      return res.status(404).json({ error: `No items found for quote ${quoteId}` });
    }

    console.log(`[EMB Push] Found ${items.length} items for ${quoteId}`);

    // 5. Transform to ExternalOrderJson
    const orderJson = transformQuoteToOrder(session, items, { isTest });
    console.log(`[EMB Push] Transformed to ExtOrderID: ${orderJson.ExtOrderID} with ${orderJson.LinesOE.length} line items`);

    // 6. Authenticate against /embroidery endpoint
    const token = await getTokenForEndpoint(EMB_BASE_URL);

    // 7. POST to ManageOrders PUSH API
    console.log(`[EMB Push] Pushing to ${EMB_BASE_URL}/order-push...`);
    const pushResponse = await axios.post(
      `${EMB_BASE_URL}/order-push`,
      orderJson,
      {
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
          'Authorization': `Bearer ${token}`,
        },
        timeout: 30000,
      }
    );

    console.log(`[EMB Push] Push response:`, pushResponse.status, JSON.stringify(pushResponse.data).substring(0, 200));

    // 8. Update PushedToShopWorks timestamp in Caspio
    const timestamp = new Date().toISOString();
    try {
      await makeCaspioRequest('put', '/tables/Quote_Sessions/records',
        { 'q.where': `PK_ID=${session.PK_ID}` },
        { PushedToShopWorks: timestamp }
      );
      console.log(`[EMB Push] Updated PushedToShopWorks for ${quoteId} at PK_ID=${session.PK_ID}`);
    } catch (updateError) {
      // Non-fatal — the push succeeded, we just couldn't mark it
      console.error(`[EMB Push] WARNING: Push succeeded but failed to update PushedToShopWorks:`, updateError.message);
    }

    // 9. Return success
    res.json({
      success: true,
      extOrderId: orderJson.ExtOrderID,
      timestamp,
      quoteId,
      lineItemCount: orderJson.LinesOE.length,
      designCount: orderJson.Designs.length,
      message: `Quote ${quoteId} pushed to ShopWorks as ${orderJson.ExtOrderID}`,
      pushResponse: pushResponse.data,
    });

  } catch (error) {
    console.error(`[EMB Push] Error pushing ${quoteId}:`, error.message);

    // Axios error with response from ManageOrders API
    if (error.response) {
      return res.status(error.response.status || 500).json({
        error: 'ManageOrders API error',
        status: error.response.status,
        details: error.response.data,
        quoteId,
      });
    }

    // Network or transform error
    res.status(500).json({
      error: 'Failed to push quote to ShopWorks',
      details: error.message,
      quoteId,
    });
  }
});

/**
 * GET /api/embroidery-push/verify/:extOrderId
 *
 * Verify an order exists in ManageOrders by pulling it back.
 */
router.get('/embroidery-push/verify/:extOrderId', async (req, res) => {
  const { extOrderId } = req.params;

  try {
    if (!extOrderId) {
      return res.status(400).json({ error: 'extOrderId is required' });
    }

    const token = await getTokenForEndpoint(EMB_BASE_URL);

    // Pull orders from ManageOrders — search by ExtOrderID
    const pullResponse = await axios.get(
      `${EMB_BASE_URL}/order-pull`,
      {
        params: {
          ExtOrderID: extOrderId,
        },
        headers: {
          'Accept': 'application/json',
          'Authorization': `Bearer ${token}`,
        },
        timeout: 15000,
      }
    );

    const orders = pullResponse.data;
    const found = Array.isArray(orders) && orders.length > 0;

    res.json({
      found,
      extOrderId,
      orderCount: found ? orders.length : 0,
      orderData: found ? orders[0] : null,
    });

  } catch (error) {
    console.error(`[EMB Push] Verify error for ${extOrderId}:`, error.message);
    res.status(500).json({
      error: 'Failed to verify order',
      details: error.message,
      extOrderId,
    });
  }
});

/**
 * GET /api/embroidery-push/health
 *
 * Test authentication against the /embroidery endpoint.
 */
router.get('/embroidery-push/health', async (req, res) => {
  try {
    const token = await getTokenForEndpoint(EMB_BASE_URL, true); // Force fresh token

    res.json({
      success: true,
      message: 'Embroidery PUSH API authentication successful',
      endpoint: EMB_BASE_URL,
      tokenLength: token.length,
    });

  } catch (error) {
    console.error('[EMB Push] Health check failed:', error.message);
    res.status(500).json({
      success: false,
      message: 'Embroidery PUSH API authentication failed',
      endpoint: EMB_BASE_URL,
      error: error.message,
    });
  }
});

/**
 * GET /api/embroidery-push/preview/:quoteId
 *
 * Preview the ExternalOrderJson that would be sent (without actually pushing).
 * Useful for debugging and testing the transformation.
 */
router.get('/embroidery-push/preview/:quoteId', async (req, res) => {
  const { quoteId } = req.params;
  const isTest = req.query.test === 'true';

  try {
    if (!quoteId || !/^[a-zA-Z0-9\-_]+$/.test(quoteId)) {
      return res.status(400).json({ error: 'Invalid quoteId format' });
    }

    const sessions = await fetchAllCaspioPages('/tables/Quote_Sessions/records', {
      'q.where': `QuoteID='${quoteId}'`,
    });

    if (!sessions || sessions.length === 0) {
      return res.status(404).json({ error: `Quote ${quoteId} not found` });
    }

    const items = await fetchAllCaspioPages('/tables/Quote_Items/records', {
      'q.where': `QuoteID='${quoteId}'`,
    });

    if (!items || items.length === 0) {
      return res.status(404).json({ error: `No items found for quote ${quoteId}` });
    }

    const orderJson = transformQuoteToOrder(sessions[0], items, { isTest });

    res.json({
      quoteId,
      extOrderId: orderJson.ExtOrderID,
      lineItemCount: orderJson.LinesOE.length,
      designCount: orderJson.Designs.length,
      noteCount: orderJson.Notes.length,
      alreadyPushed: !!sessions[0].PushedToShopWorks,
      pushedAt: sessions[0].PushedToShopWorks || null,
      orderJson,
    });

  } catch (error) {
    console.error(`[EMB Push] Preview error for ${quoteId}:`, error.message);
    res.status(500).json({
      error: 'Failed to preview transformation',
      details: error.message,
      quoteId,
    });
  }
});

module.exports = router;
