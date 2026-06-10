/**
 * Embroidery Push Route
 *
 * Pushes saved embroidery quotes to ShopWorks via ManageOrders PUSH API.
 * Uses the dedicated /embroidery integration endpoint (separate from /onsite).
 *
 * Endpoints:
 *   POST /api/embroidery-push/push-quote  — Transform & push a quote
 *   GET  /api/embroidery-push/health — Test auth connectivity
 *   GET  /api/embroidery-push/preview/:quoteId — Preview ExternalOrderJson without pushing
 *
 * REMOVED (audit 2026-06-10): GET /verify/:extOrderId — it queried MO order-pull with
 * only an ExtOrderID param, which MO rejects (order-pull requires date-range params),
 * so it always 400'd. The frontend verifies imports via the working
 * GET /api/manageorders/getorderno/:ext_order_id instead (src/routes/manageorders.js).
 */

const express = require('express');
const router = express.Router();
const axios = require('axios');
const { fetchAllCaspioPages, makeCaspioRequest } = require('../utils/caspio');
const { getTokenForEndpoint } = require('../../lib/manageorders-push-auth');
const { transformQuoteToOrder, parseImportNotes } = require('../../lib/embroidery-push-transformer');
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
      'q.orderBy': 'PK_ID DESC',  // newest save first — duplicate QuoteID rows must NOT push stale totals (Erik 2026-06-05)
    });

    if (!sessions || sessions.length === 0) {
      return res.status(404).json({ error: `Quote ${quoteId} not found` });
    }
    if (sessions.length > 1) console.warn(`[EMB Push] ${sessions.length} session rows for ${quoteId} — using newest PK_ID=${sessions[0].PK_ID} (Subtotal ${sessions[0].SubtotalAmount}). Possible duplicate QuoteID.`);
    const session = sessions[0];

    // 2a. Guard: a REAL (non-test) push must carry a VALID Customer #. Without it the transformer
    //     silently routes the order to the embroidery catch-all customer 3739 — a wrong-account
    //     order. The frontend gates on this, but a force re-push or direct API call can bypass
    //     that, so backstop it here. Test pushes intentionally use 3739. (2026-06-04 audit)
    //     Strict digits-only: parseInt truncated typos at the first non-digit ('12B45' → customer 12),
    //     silently pushing the order to the WRONG ShopWorks account. (audit 2026-06-10)
    if (!isTest) {
      const rawCust = String(session.CustomerNumber == null ? '' : session.CustomerNumber).trim();
      if (!rawCust || /^0+$/.test(rawCust)) {
        return res.status(400).json({
          error: 'Customer # required',
          details: 'This quote has no ShopWorks Customer #. Set it before pushing — otherwise the order would land on the catch-all customer 3739.',
          quoteId,
        });
      }
      if (!/^\d+$/.test(rawCust)) {
        return res.status(400).json({
          error: 'Invalid Customer #',
          details: `Customer # "${rawCust}" is not a valid ShopWorks customer number (digits only). Fix it before pushing — a partial-numeric typo would silently push the order to the wrong customer account.`,
          quoteId,
        });
      }
    }

    // P2-12 (audit 2026-06-06): server-side backstop — if artwork was uploaded but the design wasn't named,
    // the order pushes with the art silently dropped and a "NO DESIGN LINKED" note. The frontend gates this,
    // but a direct API call / force re-push bypasses it. Mirror the frontend gate here. (test pushes skip)
    if (!isTest) {
      const _notes = parseImportNotes(session);
      const _hasArt = (_notes.referenceArtwork || []).some((f) => f && f.hostedUrl);
      if (_hasArt && !(_notes.newDesignName || '').trim()) {
        return res.status(400).json({
          error: 'Design name required',
          details: 'Artwork was uploaded but the design has no name. Name it before pushing — otherwise the artwork is dropped and the order pushes with "NO DESIGN LINKED".',
          quoteId,
        });
      }
    }

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

    // 5a. Guard: never push an empty order. Zero line items means the
    //     transformer recognized no products/fees — fix the quote, don't push.
    //     (Parity with the scp-push / dtf-push guards.)
    if (orderJson.LinesOE.length === 0) {
      return res.status(400).json({
        error: 'Transform produced zero line items',
        details: 'Quote has no embroidery products. Add a product before pushing.',
        quoteId,
      });
    }

    // 5b. Guard: a GARMENT line (one with a Size) priced at $0 is a pricing bug —
    //     block it so we never push a free order. Service/fee lines are
    //     deliberately NOT checked here: the AS-Garm / AS-CAP primary stitch
    //     surcharge is a flat $0/$4/$10 tier and legitimately emits a $0 line at
    //     the base tier, so the broad scp/dtf "$0 line" check would false-block EMB.
    const zeroPricedGarment = orderJson.LinesOE.find(
      (l) => String(l.Size || '').trim() !== '' && Number(l.Price) <= 0 && Number(l.Qty) > 0
    );
    if (zeroPricedGarment) {
      return res.status(400).json({
        error: '$0 garment line',
        details: `Line ${zeroPricedGarment.PartNumber} (${zeroPricedGarment.Size} × ${zeroPricedGarment.Qty}) has no price. Fix the quote before pushing.`,
        quoteId,
      });
    }

    // 6. Authenticate against /embroidery endpoint
    const token = await getTokenForEndpoint(EMB_BASE_URL);

    // 6a. Duplicate-push TOCTOU guard (audit 2026-06-10): the step-3 check read
    //     PushedToShopWorks seconds ago — two concurrent pushes (two tabs, rep +
    //     manager, retry racing a slow first attempt) could BOTH pass it and create
    //     two ShopWorks orders. Re-read the flag right before the MO POST and 409 if
    //     someone else won the race. NOTE: this NARROWS the window (from the whole
    //     fetch+transform span down to recheck→POST, milliseconds) but does NOT
    //     eliminate it — Caspio has no atomic conditional-write claim we can take
    //     here. force=true intentionally bypasses, same as the step-3 check.
    if (!force) {
      try {
        const recheck = await fetchAllCaspioPages('/tables/Quote_Sessions/records', {
          'q.where': `PK_ID=${session.PK_ID}`,
          'q.select': 'PushedToShopWorks',
        });
        if (recheck && recheck[0] && recheck[0].PushedToShopWorks) {
          return res.status(409).json({
            error: 'Quote already pushed to ShopWorks',
            pushedAt: recheck[0].PushedToShopWorks,
            extOrderId: generateEmbExtOrderID(quoteId, false),
            message: 'A concurrent push completed first. Use force=true to push again.',
          });
        }
      } catch (recheckError) {
        // Recheck is a best-effort guard — never block a push on its failure
        // (the step-3 check already passed). Log and continue.
        console.warn(`[EMB Push] Duplicate-push recheck failed (continuing): ${recheckError.message}`);
      }
    }

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
    // P2-3 (audit 2026-06-06): if this PUT fails the dup-guard (the 409 above) is disarmed → a later push
    // creates a SECOND ShopWorks order. Retry once, and if it still fails surface a warning in the response
    // so the rep knows not to re-push.
    let dedupFlagSet = false;
    for (let attempt = 1; attempt <= 2 && !dedupFlagSet; attempt++) {
      try {
        await makeCaspioRequest('put', '/tables/Quote_Sessions/records',
          { 'q.where': `PK_ID=${session.PK_ID}` },
          { PushedToShopWorks: timestamp }
        );
        dedupFlagSet = true;
        console.log(`[EMB Push] Updated PushedToShopWorks for ${quoteId} at PK_ID=${session.PK_ID}`);
      } catch (updateError) {
        console.error(`[EMB Push] WARNING (attempt ${attempt}/2): push succeeded but failed to set PushedToShopWorks:`, updateError.message);
      }
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
      // P2-3 (audit 2026-06-06): warn loudly if the dedup flag couldn't be saved — re-pushing would duplicate.
      ...(dedupFlagSet ? {} : { warning: 'Order pushed, but the duplicate-prevention flag could NOT be saved. Do NOT re-push this quote — it would create a SECOND ShopWorks order. Contact dev.' }),
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

// GET /verify/:extOrderId was REMOVED here (audit 2026-06-10) — see file header.
// Import verification lives at GET /api/manageorders/getorderno/:ext_order_id.

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
      'q.orderBy': 'PK_ID DESC',  // newest save first — duplicate QuoteID rows must NOT push stale totals (Erik 2026-06-05)
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
