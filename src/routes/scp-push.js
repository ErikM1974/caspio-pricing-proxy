/**
 * SCP (Screen Print) Push Route
 *
 * Pushes saved SCP quotes to ShopWorks via ManageOrders PUSH API.
 *
 * Mirrors DTF push pattern (src/routes/dtf-push.js). Differs only in:
 *   - Uses scp-push-transformer (handles 'screenprint' EmbellishmentType +
 *     SPSU/SPRESET screen-setup fees + LTM fees)
 *   - Uses manageorders-scp-config (SCP integration defaults)
 *   - ExtOrderID prefix is "SCP-" instead of "DTF-"
 *
 * Endpoints:
 *   POST /api/scp-push/push-quote — Transform & push
 *   GET  /api/scp-push/preview/:id — Preview payload (no push)
 *   GET  /api/scp-push/health — Auth check
 *   GET  /api/scp-push/verify/:extId — Pull order back to verify
 *
 * Created 2026-05-23 — Phase 8.
 */

const express = require('express');
const router = express.Router();
const axios = require('axios');
const { fetchAllCaspioPages, makeCaspioRequest } = require('../utils/caspio');
const { getTokenForEndpoint } = require('../../lib/manageorders-push-auth');
const { transformQuoteToOrder } = require('../../lib/scp-push-transformer');
const { SCP_BASE_URL, generateScpExtOrderID } = require('../../config/manageorders-scp-config');

router.post('/scp-push/push-quote', express.json(), async (req, res) => {
  const { quoteId, isTest = false, force = false } = req.body;
  console.log(`[SCP Push] Push request for quote: ${quoteId} (test=${isTest}, force=${force})`);

  try {
    if (!quoteId || typeof quoteId !== 'string') {
      return res.status(400).json({ error: 'quoteId is required' });
    }
    if (!/^[a-zA-Z0-9\-_]+$/.test(quoteId)) {
      return res.status(400).json({ error: 'Invalid quoteId format' });
    }

    const sessions = await fetchAllCaspioPages('/tables/Quote_Sessions/records', {
      'q.where': `QuoteID='${quoteId}'`,
    });
    if (!sessions || sessions.length === 0) {
      return res.status(404).json({ error: `Quote ${quoteId} not found` });
    }
    const session = sessions[0];

    if (session.PushedToShopWorks && !force) {
      return res.status(409).json({
        error: 'Quote already pushed to ShopWorks',
        pushedAt: session.PushedToShopWorks,
        extOrderId: generateScpExtOrderID(quoteId, false),
        message: 'Use force=true to push again',
      });
    }

    const items = await fetchAllCaspioPages('/tables/Quote_Items/records', {
      'q.where': `QuoteID='${quoteId}'`,
    });
    if (!items || items.length === 0) {
      return res.status(404).json({ error: `No items found for quote ${quoteId}` });
    }

    const orderJson = transformQuoteToOrder(session, items, { isTest });
    console.log(
      `[SCP Push] Transformed to ExtOrderID: ${orderJson.ExtOrderID} ` +
      `with ${orderJson.LinesOE.length} line items, ${orderJson.Designs.length} designs`
    );

    if (orderJson.LinesOE.length === 0) {
      return res.status(400).json({
        error: 'Transform produced zero line items',
        details: 'Quote has no screenprint garment rows. Add a product before pushing.',
        quoteId,
      });
    }

    const zeroPriceLine = orderJson.LinesOE.find(
      (l) => Number(l.Price) <= 0 && Number(l.Qty) > 0
    );
    if (zeroPriceLine) {
      return res.status(400).json({
        error: '$0 line item',
        details: `Line ${zeroPriceLine.PartNumber} (${zeroPriceLine.Size || '-'} × ${zeroPriceLine.Qty}) has no price. Fix the quote before pushing.`,
        quoteId,
      });
    }

    const token = await getTokenForEndpoint(SCP_BASE_URL);

    console.log(`[SCP Push] Pushing to ${SCP_BASE_URL}/order-push...`);
    const pushResponse = await axios.post(`${SCP_BASE_URL}/order-push`, orderJson, {
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'Authorization': `Bearer ${token}`,
      },
      timeout: 30000,
    });

    console.log(`[SCP Push] Push response:`, pushResponse.status,
                JSON.stringify(pushResponse.data).substring(0, 200));

    const timestamp = new Date().toISOString();
    try {
      await makeCaspioRequest('put', '/tables/Quote_Sessions/records',
        { 'q.where': `PK_ID=${session.PK_ID}` },
        { PushedToShopWorks: timestamp }
      );
      console.log(`[SCP Push] Updated PushedToShopWorks for ${quoteId} at PK_ID=${session.PK_ID}`);
    } catch (updateError) {
      console.error(`[SCP Push] WARNING: Push succeeded but failed to update PushedToShopWorks:`, updateError.message);
    }

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
    console.error(`[SCP Push] Error pushing ${quoteId}:`, error.message);
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

router.get('/scp-push/preview/:quoteId', async (req, res) => {
  const { quoteId } = req.params;
  const isTest = req.query.test === 'true' || req.query.test === '1';

  try {
    if (!/^[a-zA-Z0-9\-_]+$/.test(quoteId)) {
      return res.status(400).json({ error: 'Invalid quoteId format' });
    }

    const sessions = await fetchAllCaspioPages('/tables/Quote_Sessions/records', {
      'q.where': `QuoteID='${quoteId}'`,
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
    console.error(`[SCP Push Preview] Error for ${quoteId}:`, error.message);
    res.status(500).json({ error: 'Preview failed', details: error.message, quoteId });
  }
});

router.get('/scp-push/health', async (req, res) => {
  try {
    const token = await getTokenForEndpoint(SCP_BASE_URL);
    res.json({
      status: 'ok',
      baseUrl: SCP_BASE_URL,
      tokenPrefix: token ? token.substring(0, 8) + '...' : null,
      message: 'SCP push integration auth working',
    });
  } catch (error) {
    res.status(500).json({
      status: 'error',
      baseUrl: SCP_BASE_URL,
      error: error.message,
    });
  }
});

router.get('/scp-push/verify/:extOrderId', async (req, res) => {
  const { extOrderId } = req.params;
  try {
    if (!extOrderId) {
      return res.status(400).json({ error: 'extOrderId is required' });
    }
    const token = await getTokenForEndpoint(SCP_BASE_URL);
    const pullResponse = await axios.get(`${SCP_BASE_URL}/order-pull`, {
      params: { ExtOrderID: extOrderId },
      headers: { 'Accept': 'application/json', 'Authorization': `Bearer ${token}` },
      timeout: 15000,
    });
    res.json({ success: true, extOrderId, data: pullResponse.data });
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
