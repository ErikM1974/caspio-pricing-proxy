/**
 * ShipStation routes — proxy endpoints for our pricing-index app + inbound
 * webhook handler for events back from ShipStation.
 *
 * Mounted at /api/shipstation in server.js (plus /api/webhooks/shipstation
 * exposed at the root for the webhook target — needs the canonical URL).
 *
 * Endpoints exposed:
 *
 *   GET  /api/shipstation/test-auth
 *        Quick sanity check that our API key + secret work.
 *
 *   POST /api/shipstation/create-order
 *        Body = a fully-built ShipStation order payload (the caller — pricing-
 *        index server.js — knows about the customer + line items, so it builds
 *        the body; we just relay).
 *
 *   GET  /api/shipstation/orders/:shipstationOrderId
 *        Fetch one order by its ShipStation internal ID. Used by the hourly
 *        fallback sync to refresh tracking when webhooks miss.
 *
 *   GET  /api/shipstation/orders?orderNumber=OF-0048
 *        Look up by our orderNumber (works without us knowing the SS internal ID).
 *
 *   GET  /api/shipstation/webhooks
 *        Inspect current webhook subscriptions for this account.
 *
 *   POST /api/webhooks/shipstation
 *        Inbound: ShipStation calls this when an order is shipped (or other
 *        subscribed events). We fetch the resource_url it provides, extract
 *        tracking#, and forward to our pricing-index app via callback URL.
 */

'use strict';

const express = require('express');
const axios = require('axios');

const router = express.Router();
const webhookRouter = express.Router(); // mounted at /api/webhooks for the inbound endpoint

const ss = require('../../lib/shipstation-client');
const slack = require('../utils/slack-shipstation-notify');

// ============================================================================
// OUTBOUND: WE → SHIPSTATION
// ============================================================================

/**
 * GET /api/shipstation/test-auth — verify credentials.
 */
router.get('/test-auth', async (req, res) => {
    try {
        const result = await ss.testAuth();
        if (!result.ok) {
            return res.status(401).json(result);
        }
        return res.json({
            ok: true,
            message: 'ShipStation credentials valid',
            tagsCount: result.tags.length,
        });
    } catch (err) {
        console.error('[shipstation/test-auth] error:', err.message);
        return res.status(500).json({ ok: false, error: err.message });
    }
});

/**
 * POST /api/shipstation/create-order — push a pre-built order to ShipStation.
 *
 * Pricing-index server.js builds the full ShipStation payload (it knows the
 * customer + line items from quote_sessions) and POSTs here. We forward
 * verbatim. orderKey = orderNumber gives us idempotency for free.
 */
router.post('/create-order', express.json({ limit: '2mb' }), async (req, res) => {
    const payload = req.body || {};
    const orderNumber = payload.orderNumber || '(missing)';
    try {
        if (!payload.orderNumber) {
            return res.status(400).json({ success: false, error: 'orderNumber is required' });
        }
        const result = await ss.createOrder(payload);
        // result.orderId is what ShipStation assigned. Result also echoes back
        // the full normalized order.
        slack.notifyOrderSent({
            quoteId: orderNumber,
            shipstationOrderId: result.orderId,
            customerName: payload.shipTo?.company || payload.shipTo?.name,
            carrierCode: payload.carrierCode,
            serviceCode: payload.serviceCode,
            total: Number(payload.amountPaid) || undefined,
        });
        return res.json({
            success: true,
            shipstationOrderId: result.orderId,
            orderNumber: result.orderNumber,
            orderKey: result.orderKey,
            orderStatus: result.orderStatus,
            createdAt: result.createDate,
        });
    } catch (err) {
        console.error(`[shipstation/create-order] FAILED for ${orderNumber}:`, err.message, err.body || '');
        slack.notifyPushFailed({
            quoteId: orderNumber,
            error: err.message,
            status: err.status,
            details: err.body,
        });
        return res.status(err.status || 500).json({
            success: false,
            error: err.message,
            details: err.body || null,
        });
    }
});

/**
 * GET /api/shipstation/orders/:shipstationOrderId — read one order.
 */
router.get('/orders/:shipstationOrderId', async (req, res) => {
    try {
        const order = await ss.getOrder(req.params.shipstationOrderId);
        return res.json({ success: true, order });
    } catch (err) {
        return res.status(err.status || 500).json({
            success: false, error: err.message, details: err.body || null,
        });
    }
});

/**
 * GET /api/shipstation/orders?orderNumber=OF-0048 — search by orderNumber.
 */
router.get('/orders', async (req, res) => {
    const { orderNumber } = req.query;
    if (!orderNumber) {
        return res.status(400).json({ success: false, error: 'orderNumber query param required' });
    }
    try {
        const orders = await ss.listOrdersByOrderNumber(orderNumber);
        return res.json({ success: true, count: orders.length, orders });
    } catch (err) {
        return res.status(err.status || 500).json({
            success: false, error: err.message, details: err.body || null,
        });
    }
});

/**
 * GET /api/shipstation/webhooks — inspect current subscriptions.
 */
router.get('/webhooks', async (req, res) => {
    try {
        const webhooks = await ss.listWebhooks();
        return res.json({ success: true, count: webhooks.length, webhooks });
    } catch (err) {
        return res.status(err.status || 500).json({
            success: false, error: err.message, details: err.body || null,
        });
    }
});

// ============================================================================
// INBOUND: SHIPSTATION → US
// ============================================================================

/**
 * POST /api/webhooks/shipstation — ShipStation calls this when events fire.
 *
 * Payload shape (V1):
 *   { resource_url: 'https://ssapi.shipstation.com/...', resource_type: 'SHIP_NOTIFY' }
 *
 * We:
 *   1. GET resource_url to fetch the actual shipped-orders payload
 *   2. Extract tracking# + carrier + cost for each shipment
 *   3. Forward to the pricing-index app's callback endpoint (which writes
 *      to Caspio quote_sessions). This split lets the proxy stay stateless
 *      and the pricing-index own the Caspio-write logic.
 *
 * Authentication: ShipStation doesn't sign webhooks. Best practice is to
 * validate the resource_url hostname (must be ssapi.shipstation.com) so a
 * spoofed POST can't trick us into fetching arbitrary URLs.
 */
webhookRouter.post('/shipstation', express.json({ limit: '512kb' }), async (req, res) => {
    const { resource_url, resource_type } = req.body || {};
    console.log(`[webhook/shipstation] received ${resource_type} → ${resource_url}`);

    // Always 200 OK fast — ShipStation retries on non-2xx. Process async.
    res.status(200).json({ received: true });

    // Validate resource_url is ShipStation's (defense against spoofed POSTs)
    if (!resource_url || !/^https:\/\/ssapi\.shipstation\.com\//i.test(resource_url)) {
        console.warn('[webhook/shipstation] invalid resource_url — refusing to fetch:', resource_url);
        return;
    }

    try {
        // Re-use the client's auth helper by piggy-backing on an internal request
        const resource = await ss._internal.ssRequest('GET',
            resource_url.replace(ss._internal.BASE_URL, ''));

        // Resource shape varies by event type. For SHIP_NOTIFY:
        //   { shipments: [{ orderNumber, trackingNumber, carrierCode, serviceCode,
        //                   shipDate, shipmentCost, shipmentId, ... }] }
        const shipments = Array.isArray(resource?.shipments) ? resource.shipments : [];
        console.log(`[webhook/shipstation] processing ${shipments.length} shipment(s)`);

        for (const ship of shipments) {
            // Build a tracking URL based on carrier
            const trackingUrl = buildTrackingUrl(ship.carrierCode, ship.trackingNumber);

            slack.notifyLabelShipped({
                quoteId: ship.orderNumber,
                trackingNumber: ship.trackingNumber,
                carrierCode: ship.carrierCode,
                serviceCode: ship.serviceCode,
                labelCost: ship.shipmentCost,
                trackingUrl,
            });

            // Forward to pricing-index — it owns the Caspio write.
            await forwardToTrackingCallback({
                quoteId: ship.orderNumber,
                trackingNumber: ship.trackingNumber,
                trackingCarrier: ship.carrierCode,
                trackingUrl,
                shippedAt: ship.shipDate || new Date().toISOString(),
                labelCost: ship.shipmentCost,
                shipstationOrderId: ship.orderId,
                shipstationStatus: 'shipped',
            });
        }
    } catch (err) {
        console.error('[webhook/shipstation] processing failed:', err.message);
        // We already 200'd; ShipStation won't retry. Slack notify so we know.
        slack.notifyPushFailed({
            quoteId: '(webhook)',
            error: `Webhook processing failed: ${err.message}`,
            status: err.status,
            details: err.body,
        });
    }
});

/**
 * Carrier tracking-URL templates. Add carriers here as they show up.
 */
function buildTrackingUrl(carrierCode, trackingNumber) {
    if (!trackingNumber) return '';
    const map = {
        'ups':        `https://www.ups.com/track?tracknum=${encodeURIComponent(trackingNumber)}`,
        'stamps_com': `https://tools.usps.com/go/TrackConfirmAction?tLabels=${encodeURIComponent(trackingNumber)}`,
        'usps':       `https://tools.usps.com/go/TrackConfirmAction?tLabels=${encodeURIComponent(trackingNumber)}`,
        'fedex':      `https://www.fedex.com/fedextrack/?trknbr=${encodeURIComponent(trackingNumber)}`,
        'dhl':        `https://www.dhl.com/en/express/tracking.html?AWB=${encodeURIComponent(trackingNumber)}`,
    };
    return map[String(carrierCode || '').toLowerCase()] || '';
}

/**
 * Forward a parsed tracking event to pricing-index. We're not stateless
 * about Caspio (the proxy doesn't talk to Caspio directly here); we let
 * pricing-index own the write so it can also apply its TZ-corrected
 * timestamp parsing + audit log.
 */
async function forwardToTrackingCallback(payload) {
    const callbackUrl = process.env.PRICING_INDEX_BASE_URL
        || 'https://sanmar-inventory-app-4cd7b252508d.herokuapp.com';
    const target = `${callbackUrl}/api/quote-sessions/${encodeURIComponent(payload.quoteId)}/shipstation-tracking`;
    try {
        await axios.post(target, payload, { timeout: 15000 });
        console.log(`[webhook/shipstation] forwarded ${payload.quoteId} tracking to pricing-index`);
    } catch (err) {
        console.warn(`[webhook/shipstation] forward FAILED for ${payload.quoteId}:`, err.message);
    }
}

module.exports = { router, webhookRouter };
