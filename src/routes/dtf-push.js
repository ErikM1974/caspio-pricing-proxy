/**
 * DTF Push Route
 *
 * Pushes saved DTF quotes to ShopWorks via ManageOrders PUSH API.
 *
 * Mirrors the EMB push pattern (src/routes/embroidery-push.js). Differs in:
 *   - Uses dtf-push-transformer (no logos, all-in line price)
 *   - Uses manageorders-dtf-config (DTF integration defaults)
 *   - ExtOrderID prefix is "DTF-" instead of "EMB-"
 *
 * Endpoints:
 *   POST /api/dtf-push/push-quote — Transform & push a quote
 *   GET  /api/dtf-push/verify/:extOrderId — Verify order exists in MO
 *   GET  /api/dtf-push/health — Test auth connectivity to DTF integration
 *   GET  /api/dtf-push/preview/:quoteId — Preview the payload that WOULD be pushed (no actual push)
 *
 * Created 2026-05-23 — Phase 8 scaffolding. Frontend button gated behind
 * ?enableDtfPush=1 until Erik confirms OnSite integration IDs.
 */

const express = require('express');
const router = express.Router();
const axios = require('axios');
const { fetchAllCaspioPages, makeCaspioRequest } = require('../utils/caspio');
const { getTokenForEndpoint } = require('../../lib/manageorders-push-auth');
const { transformQuoteToOrder } = require('../../lib/dtf-push-transformer');
const { DTF_BASE_URL, generateDtfExtOrderID, getQuoteYear } = require('../../config/manageorders-dtf-config');

/**
 * POST /api/dtf-push/push-quote
 *
 * Body: { quoteId: string, isTest?: boolean, force?: boolean }
 *
 * Flow:
 * 1. Validate quoteId
 * 2. Fetch quote_sessions + quote_items from Caspio
 * 3. Check PushedToShopWorks (reject if already pushed unless force=true)
 * 4. Transform to ExternalOrderJson
 * 5. Auth against MO PUSH API
 * 6. POST to MO PUSH API
 * 7. Update PushedToShopWorks timestamp in Caspio
 * 8. Return result with ExtOrderID
 */
router.post('/dtf-push/push-quote', express.json(), async (req, res) => {
  const { quoteId, isTest = false, force = false } = req.body;

  console.log(`[DTF Push] Push request for quote: ${quoteId} (test=${isTest}, force=${force})`);

  try {
    // 1. Validate quoteId
    if (!quoteId || typeof quoteId !== 'string') {
      return res.status(400).json({ error: 'quoteId is required' });
    }
    if (!/^[a-zA-Z0-9\-_]+$/.test(quoteId)) {
      return res.status(400).json({ error: 'Invalid quoteId format' });
    }

    // 2. Fetch session from Caspio
    console.log(`[DTF Push] Fetching session for ${quoteId}...`);
    const sessions = await fetchAllCaspioPages('/tables/Quote_Sessions/records', {
      'q.where': `QuoteID='${quoteId}'`,
      'q.orderBy': 'PK_ID DESC',  // newest save first — duplicate QuoteID rows must NOT push stale totals (Erik 2026-06-05)
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
        // [2026-06-11] year + isTest were hardcoded — a 2026 quote re-attempted in
        // 2027 echoed a nonexistent DTF-2027-… ID, and duplicate TEST pushes echoed
        // the non-test ID. The real push path already passes both.
        extOrderId: generateDtfExtOrderID(quoteId, isTest, getQuoteYear(session)),
        message: 'Use force=true to push again',
      });
    }

    // 4. Fetch items from Caspio
    console.log(`[DTF Push] Fetching items for ${quoteId}...`);
    const items = await fetchAllCaspioPages('/tables/Quote_Items/records', {
      'q.where': `QuoteID='${quoteId}'`,
    });
    if (!items || items.length === 0) {
      return res.status(404).json({ error: `No items found for quote ${quoteId}` });
    }
    console.log(`[DTF Push] Found ${items.length} items for ${quoteId}`);

    // 5. Transform to ExternalOrderJson
    const orderJson = transformQuoteToOrder(session, items, { isTest });
    console.log(
      `[DTF Push] Transformed to ExtOrderID: ${orderJson.ExtOrderID} ` +
      `with ${orderJson.LinesOE.length} line items, ` +
      `${orderJson.Designs.length} designs`
    );

    // Reject if no line items resulted from transform (caller can fix the quote)
    if (orderJson.LinesOE.length === 0) {
      return res.status(400).json({
        error: 'Transform produced zero line items',
        details: 'Quote has no DTF garment rows with size breakdown. Add a product before pushing.',
        quoteId,
      });
    }

    // Reject if any line price is $0 (guard against accidental free orders)
    const zeroPriceLine = orderJson.LinesOE.find(
      (l) => Number(l.Price) <= 0 && Number(l.Qty) > 0
    );
    if (zeroPriceLine) {
      return res.status(400).json({
        error: '$0 line item',
        details: `Line ${zeroPriceLine.PartNumber} (${zeroPriceLine.Size} × ${zeroPriceLine.Qty}) has no price. Fix the quote before pushing.`,
        quoteId,
      });
    }

    // 6. Authenticate
    const token = await getTokenForEndpoint(DTF_BASE_URL);

    // 7. POST to ManageOrders PUSH API
    console.log(`[DTF Push] Pushing to ${DTF_BASE_URL}/order-push...`);
    const pushResponse = await axios.post(
      `${DTF_BASE_URL}/order-push`,
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

    console.log(`[DTF Push] Push response:`, pushResponse.status,
                JSON.stringify(pushResponse.data).substring(0, 200));

    // 8. Update PushedToShopWorks timestamp in Caspio
    const timestamp = new Date().toISOString();
    try {
      await makeCaspioRequest('put', '/tables/Quote_Sessions/records',
        { 'q.where': `PK_ID=${session.PK_ID}` },
        { PushedToShopWorks: timestamp }
      );
      console.log(`[DTF Push] Updated PushedToShopWorks for ${quoteId} at PK_ID=${session.PK_ID}`);
    } catch (updateError) {
      console.error(`[DTF Push] WARNING: Push succeeded but failed to update PushedToShopWorks:`, updateError.message);
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
    console.error(`[DTF Push] Error pushing ${quoteId}:`, error.message);

    if (error.response) {
      return res.status(error.response.status || 500).json({
        error: 'ManageOrders API error',
        status: error.response.status,
        details: error.response.data,
        quoteId,
      });
    }

    res.status(500).json({
      error: 'Failed to push quote to ShopWorks',
      details: error.message,
      quoteId,
    });
  }
});

/**
 * GET /api/dtf-push/preview/:quoteId
 *
 * Build the payload that would be pushed, return it WITHOUT pushing.
 * Useful for debugging + showing the rep what's about to go to SW.
 * Skips the PushedToShopWorks check (always returns even if pushed).
 */
router.get('/dtf-push/preview/:quoteId', async (req, res) => {
  const { quoteId } = req.params;
  const isTest = req.query.test === 'true' || req.query.test === '1';

  try {
    if (!/^[a-zA-Z0-9\-_]+$/.test(quoteId)) {
      return res.status(400).json({ error: 'Invalid quoteId format' });
    }

    const sessions = await fetchAllCaspioPages('/tables/Quote_Sessions/records', {
      'q.where': `QuoteID='${quoteId}'`,
      'q.orderBy': 'PK_ID DESC',  // newest save first — duplicate QuoteID rows must NOT push stale totals (Erik 2026-06-05)
    });
    if (!sessions || sessions.length === 0) {
      return res.status(404).json({ error: `Quote ${quoteId} not found` });
    }
    const session = sessions[0];

    const items = await fetchAllCaspioPages('/tables/Quote_Items/records', {
      'q.where': `QuoteID='${quoteId}'`,
    });
    if (!items || items.length === 0) {
      return res.status(404).json({ error: `No items found for quote ${quoteId}` });
    }

    const orderJson = transformQuoteToOrder(session, items, { isTest });

    res.json({
      quoteId,
      session: { PK_ID: session.PK_ID, QuoteID: session.QuoteID, CustomerName: session.CustomerName },
      itemCount: items.length,
      orderJson,
    });
  } catch (error) {
    console.error(`[DTF Push Preview] Error for ${quoteId}:`, error.message);
    res.status(500).json({ error: 'Preview failed', details: error.message, quoteId });
  }
});

/**
 * GET /api/dtf-push/health
 *
 * Auth + token check against MO PUSH API. Returns 200 if token can be obtained.
 */
router.get('/dtf-push/health', async (req, res) => {
  try {
    const token = await getTokenForEndpoint(DTF_BASE_URL);
    res.json({
      status: 'ok',
      baseUrl: DTF_BASE_URL,
      tokenPrefix: token ? token.substring(0, 8) + '...' : null,
      message: 'DTF push integration auth working',
    });
  } catch (error) {
    res.status(500).json({
      status: 'error',
      baseUrl: DTF_BASE_URL,
      error: error.message,
    });
  }
});

/**
 * GET /api/dtf-push/verify/:extOrderId
 *
 * Pull an order back from MO to verify it landed.
 */
router.get('/dtf-push/verify/:extOrderId', async (req, res) => {
  const { extOrderId } = req.params;
  try {
    if (!extOrderId) {
      return res.status(400).json({ error: 'extOrderId is required' });
    }
    const token = await getTokenForEndpoint(DTF_BASE_URL);
    const pullResponse = await axios.get(`${DTF_BASE_URL}/order-pull`, {
      params: { ExtOrderID: extOrderId },
      headers: {
        'Accept': 'application/json',
        'Authorization': `Bearer ${token}`,
      },
      timeout: 15000,
    });
    res.json({
      success: true,
      extOrderId,
      data: pullResponse.data,
    });
  } catch (error) {
    if (error.response) {
      return res.status(error.response.status || 500).json({
        error: 'ManageOrders API error',
        status: error.response.status,
        details: error.response.data,
        extOrderId,
      });
    }
    res.status(500).json({ error: 'Verify failed', details: error.message, extOrderId });
  }
});

module.exports = router;
