/**
 * ShipStation V1 API Client
 *
 * Wraps the ShipStation V1 REST API for Northwest Custom Apparel's order →
 * ship-label pipeline. Pattern mirrors `lib/manageorders-push-client.js`
 * (external-API push with auth + retry + structured logging).
 *
 * AUTH: HTTP Basic — `Authorization: Basic <base64(API_KEY:API_SECRET)>`
 * BASE: https://ssapi.shipstation.com
 *
 * Env vars required:
 *   - SHIPSTATION_API_KEY     (from ShipStation Settings → Account → API Settings)
 *   - SHIPSTATION_API_SECRET
 *
 * V1 vs V2: we chose V1 (mature, fully documented, no deprecation date
 * announced as of 2026-05). V2 adds batch labels + manifests we don't need
 * yet. Easy to migrate later if features force it.
 *
 * Idempotency: each createOrder() sends orderKey = orderNumber so retrying
 * the same payload UPDATES the existing order instead of creating a duplicate.
 *
 * Rate limits: ShipStation rate-limits per-account at ~40 req/min for orders.
 * Headers `X-Rate-Limit-Remaining` and `X-Rate-Limit-Reset` are echoed back
 * — we surface them in console for debugging.
 */

'use strict';

const axios = require('axios');

const BASE_URL = process.env.SHIPSTATION_BASE_URL || 'https://ssapi.shipstation.com';
const API_KEY = process.env.SHIPSTATION_API_KEY || '';
const API_SECRET = process.env.SHIPSTATION_API_SECRET || '';

const DEFAULT_TIMEOUT_MS = 30000;

/**
 * Build the HTTP Basic auth header. Throws if env not set.
 */
function buildAuthHeader() {
  if (!API_KEY || !API_SECRET) {
    throw new Error(
      'ShipStation credentials missing — set SHIPSTATION_API_KEY + SHIPSTATION_API_SECRET ' +
      'env vars (Settings → Account → API Settings in ShipStation UI).'
    );
  }
  const token = Buffer.from(`${API_KEY}:${API_SECRET}`).toString('base64');
  return `Basic ${token}`;
}

/**
 * Generic ShipStation request wrapper. Returns parsed body on success;
 * throws Error with shape { status, body, rateLimit } on failure.
 */
async function ssRequest(method, pathname, { data, params } = {}) {
  try {
    const resp = await axios({
      method,
      url: `${BASE_URL}${pathname}`,
      headers: {
        Authorization: buildAuthHeader(),
        'Content-Type': 'application/json',
      },
      data,
      params,
      timeout: DEFAULT_TIMEOUT_MS,
      // Don't throw on 4xx — let caller decide what's fatal.
      validateStatus: status => status >= 200 && status < 500,
    });

    // Log rate-limit headers for visibility (free signal from every response)
    const remaining = resp.headers['x-rate-limit-remaining'];
    const reset = resp.headers['x-rate-limit-reset'];
    if (remaining != null && Number(remaining) < 5) {
      console.warn(`[shipstation] Rate limit low: ${remaining} requests left, resets in ${reset}s`);
    }

    if (resp.status >= 400) {
      const err = new Error(`ShipStation ${method} ${pathname} returned ${resp.status}`);
      err.status = resp.status;
      // resp.data is usually JSON ModelState; sometimes ShipStation returns
      // plain text or HTML. Capture whatever is there. Empty 400s do happen
      // when the order is structurally invalid — we always include status + url.
      err.body = (resp.data !== undefined && resp.data !== '') ? resp.data : {
        _note: 'ShipStation returned an empty body — typically means malformed request structure (missing required field).',
        contentType: resp.headers['content-type'] || 'unknown',
        statusText: resp.statusText || '',
      };
      err.rateLimit = { remaining, reset };
      throw err;
    }
    return resp.data;
  } catch (err) {
    // Re-throw with structured shape if it's an axios network error
    if (err.response) {
      const wrapped = new Error(`ShipStation ${method} ${pathname} failed: ${err.message}`);
      wrapped.status = err.response.status;
      wrapped.body = err.response.data;
      throw wrapped;
    }
    throw err;
  }
}

// ============================================================================
// SHIP-METHOD MAPPING
// ============================================================================

/**
 * Map NWCA's frontend ship-method values to ShipStation carrier + service codes.
 * NWCA values come from the OF form's ship-method dropdown (server.js:2748+
 * sets `ship.method`). When a value isn't in the map, the order still creates
 * in ShipStation but with no pre-selected carrier — warehouse picks at rate
 * time. That's a safe fallback.
 */
const SHIP_METHOD_MAP = {
  'UPS Ground':       { carrier: 'ups',        service: 'ups_ground' },
  'UPS 2nd Day':      { carrier: 'ups',        service: 'ups_2nd_day_air' },
  'UPS Next Day':     { carrier: 'ups',        service: 'ups_next_day_air' },
  'Priority Mail':    { carrier: 'stamps_com', service: 'usps_priority_mail' },
  'USPS Priority':    { carrier: 'stamps_com', service: 'usps_priority_mail' },
  'USPS First Class': { carrier: 'stamps_com', service: 'usps_first_class_mail' },
  'USPS Ground':      { carrier: 'stamps_com', service: 'usps_ground_advantage' },
  'FedEx Ground':     { carrier: 'fedex',      service: 'fedex_ground' },
  'FedEx 2Day':       { carrier: 'fedex',      service: 'fedex_2_day' },
  // 'Customer Pickup' never reaches this code — caller short-circuits before
  // hitting the ShipStation client.
};

function mapShipMethod(method) {
  if (!method) return { carrier: null, service: null };
  return SHIP_METHOD_MAP[method] || SHIP_METHOD_MAP[String(method).trim()] || { carrier: null, service: null };
}

// ============================================================================
// PUBLIC API
// ============================================================================

/**
 * Quick sanity check — calls ShipStation's /accounts/listtags endpoint
 * (smallest read-only endpoint we can hit to verify credentials work).
 * Returns { ok: true, tags: [...] } or throws.
 */
async function testAuth() {
  try {
    const tags = await ssRequest('GET', '/accounts/listtags');
    return { ok: true, tags: Array.isArray(tags) ? tags : [] };
  } catch (err) {
    return { ok: false, status: err.status, error: err.message, body: err.body };
  }
}

/**
 * Create or update an order in ShipStation.
 *
 * @param {Object} payload  Pre-built ShipStation order body (see plan for full
 *                          field reference). Required: orderNumber, orderDate,
 *                          orderStatus, billTo, shipTo. Use orderKey for idem.
 * @returns {Object} ShipStation response — includes the assigned `orderId`
 *                   and the order details echoed back.
 */
async function createOrder(payload) {
  if (!payload || !payload.orderNumber) {
    throw new Error('createOrder: payload.orderNumber is required');
  }
  // Default orderKey to orderNumber for built-in idempotency.
  if (!payload.orderKey) payload.orderKey = payload.orderNumber;
  if (!payload.orderStatus) payload.orderStatus = 'awaiting_shipment';
  if (!payload.orderDate) payload.orderDate = new Date().toISOString();

  console.log(`[shipstation] createOrder ${payload.orderNumber} (orderKey=${payload.orderKey})`);
  const result = await ssRequest('POST', '/orders/createorder', { data: payload });
  console.log(`[shipstation] createOrder ${payload.orderNumber} → SS#${result.orderId} (${result.orderStatus})`);
  return result;
}

/**
 * Fetch one order by ShipStation's internal orderId.
 */
async function getOrder(shipstationOrderId) {
  if (!shipstationOrderId) throw new Error('getOrder: shipstationOrderId is required');
  return ssRequest('GET', `/orders/${shipstationOrderId}`);
}

/**
 * Look up orders by our orderNumber (e.g., "OF-0048").
 * Used by the fallback sync cron when we already know the orderNumber but not
 * the shipstationOrderId. Returns an array (may be 0 or 1 results since
 * orderNumber is effectively unique per store).
 */
async function listOrdersByOrderNumber(orderNumber) {
  if (!orderNumber) throw new Error('listOrdersByOrderNumber: orderNumber is required');
  const result = await ssRequest('GET', '/orders', { params: { orderNumber } });
  return Array.isArray(result?.orders) ? result.orders : [];
}

/**
 * List shipments for a given ShipStation order. Used by the hourly fallback
 * sync cron — when an order has shipped but the SHIP_NOTIFY webhook missed
 * (network glitch, ShipStation outage), this polled lookup discovers the
 * tracking# and forwards to pricing-index for Caspio write-back.
 *
 * V1 API: GET /shipments?orderId=N
 * Response: { shipments: [{ shipmentId, orderId, orderNumber, trackingNumber,
 *                           carrierCode, serviceCode, shipDate, shipmentCost,
 *                           voided, ... }] }
 * Voided shipments still appear — filter on `voided: false` if needed.
 */
async function listShipmentsByOrderId(shipstationOrderId) {
  if (!shipstationOrderId) throw new Error('listShipmentsByOrderId: shipstationOrderId is required');
  const result = await ssRequest('GET', '/shipments', { params: { orderId: shipstationOrderId } });
  return Array.isArray(result?.shipments) ? result.shipments : [];
}

/**
 * Soft-delete an order in ShipStation. Removes it from the active queue but
 * keeps it in deleted-order history. Used by the SW-delete cascade — when
 * ShopWorks operator deletes the order, we propagate the cancellation so
 * warehouse doesn't pick + label a phantom order.
 *
 * DO NOT call this on already-shipped orders (label is bought + paid for;
 * voiding requires a separate /orders/voidlabel call by the warehouse).
 * Caller should check orderStatus !== 'shipped' before invoking.
 *
 * V1 API: DELETE /orders/{orderId}
 * Returns: { success: true, message: '...' } on success.
 */
async function deleteOrder(shipstationOrderId) {
  if (!shipstationOrderId) throw new Error('deleteOrder: shipstationOrderId is required');
  return ssRequest('DELETE', `/orders/${shipstationOrderId}`);
}

/**
 * Subscribe to a ShipStation webhook event. Called once during setup; the
 * resulting webhook_id is stored for future unsubscribe.
 *
 * @param {string} targetUrl  Public HTTPS URL ShipStation will POST to
 * @param {string} event      Event name — most useful: 'SHIP_NOTIFY'
 *                            Others: ORDER_NOTIFY, ITEM_ORDER_NOTIFY, ITEM_SHIP_NOTIFY
 * @param {Object} opts       Optional: { name, friendlyName, storeId }
 */
async function subscribeWebhook(targetUrl, event, opts = {}) {
  if (!targetUrl || !event) throw new Error('subscribeWebhook: targetUrl + event required');
  return ssRequest('POST', '/webhooks/subscribe', {
    data: {
      target_url: targetUrl,
      event,
      friendly_name: opts.friendlyName || `NWCA ${event}`,
      store_id: opts.storeId || null,
    },
  });
}

/**
 * Unsubscribe a previously-created webhook by its ShipStation webhook ID.
 */
async function unsubscribeWebhook(webhookId) {
  if (!webhookId) throw new Error('unsubscribeWebhook: webhookId is required');
  return ssRequest('DELETE', `/webhooks/${webhookId}`);
}

/**
 * List all current webhook subscriptions for this account. Handy for
 * verifying setup ("did the subscribe call work?") + cleanup.
 */
async function listWebhooks() {
  const result = await ssRequest('GET', '/webhooks');
  // ShipStation returns { webhooks: [...] }
  return Array.isArray(result?.webhooks) ? result.webhooks : [];
}

module.exports = {
  testAuth,
  createOrder,
  getOrder,
  listOrdersByOrderNumber,
  listShipmentsByOrderId,
  deleteOrder,
  subscribeWebhook,
  unsubscribeWebhook,
  listWebhooks,
  mapShipMethod,
  SHIP_METHOD_MAP,
  // Exposed for test/diagnostic use only
  _internal: { ssRequest, buildAuthHeader, BASE_URL },
};
