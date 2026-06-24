// ==========================================
// SanMar Order Status & Shipment Routes
// ==========================================
// Provides order tracking, shipment notifications, and Caspio archival
// for the SanMar Order Lookup feature on the Staff Dashboard.
//
// Endpoints:
//   GET  /api/sanmar-orders/open            — All open SanMar orders (cached)
//   GET  /api/sanmar-orders/status/:po      — Single PO status
//   GET  /api/sanmar-orders/shipments/:po   — Tracking/shipment details for a PO
//   GET  /api/sanmar-orders/lookup          — Search by order#, company, rep, style
//   GET  /api/sanmar-orders/backfill-status — Check backfill progress
//   GET  /api/sanmar-orders/status-summary  — Monitoring: table counts, sync health
//   GET  /api/sanmar-orders/batch-status    — Synced inbound status for many work orders (dashboard)
//   GET  /api/sanmar-orders/daily-inbound   — Daily arriving-blanks rollup by decoration method (dashboard graph)
//   GET  /api/sanmar-orders/inbound-today   — Detailed POs arriving on a day (line items + color), for the detail view + PDF
//   POST /api/sanmar-orders/link            — Save ShopWorks↔SanMar PO mapping
//   POST /api/sanmar-orders/sync            — Daily sync (Heroku Scheduler)
//   POST /api/sanmar-orders/backfill        — Fire-and-forget backfill with progress
//   POST /api/sanmar-orders/match-manageorders — Match SanMar orders to ManageOrders by style+date

const express = require('express');
const router = express.Router();
const NodeCache = require('node-cache');
const {
  ENDPOINTS, NS,
  getPromoStandardsAuth, getStandardAuth, validateAuth, xmlEscape,
  makeSoapRequest, checkSoapError,
  buildOrderStatusRequest, buildShipmentRequest,
  parseOrderStatusResponse, parseShipmentResponse,
  parseInvoiceResponse
} = require('../utils/sanmar-soap');
const { makeCaspioRequest, fetchAllCaspioPages } = require('../utils/caspio');

// Cache: 15 min for allOpen (SanMar recommends max 3x/day)
const orderCache = new NodeCache({ stdTTL: 900, checkperiod: 120 });

// Standard SanMar invoice namespace (for PO discovery via invoices)
const STANDARD_NS = 'http://webservice.integration.sanmar.com/';

// ── Backfill status tracker (in-memory) ──
let backfillStatus = {
  running: false,
  lastRun: null,
  lastResult: null,
  progress: null
};

// ── Caspio table names ──
const TABLES = {
  orders: 'SanMar_Orders',
  items: 'SanMar_Order_Items',
  shipments: 'SanMar_Shipments'
};

// ── PO Number Utilities ──
// SanMar POs = ShopWorks PO number + optional initials (e.g., "111352 BW")
// NOTE: ShopWorks PO number is NOT the same as ShopWorks order number.
// ManageOrders API only returns order numbers, not PO numbers.
// Matching is done by: style numbers, manual linking, or browsing open orders.

// Extract the numeric PO portion (strips initials like BW, EM, TC, NL)
function extractPONumber(sanmarPO) {
  if (!sanmarPO) return null;
  const match = String(sanmarPO).match(/^(\d+)/);
  return match ? match[1] : null;
}

// ── Inbound vendor-shipment helpers (2026-06-15) ──
// Build a carrier tracking URL (UPS / FedEx / USPS / Spee-Dee). Returns null
// for an unknown carrier — the UI then shows the number without a link rather
// than guessing a wrong URL.
function buildCarrierTrackingUrl(carrier, trackingNumber) {
  if (!trackingNumber) return null;
  const c = String(carrier || '').toLowerCase();
  const t = encodeURIComponent(String(trackingNumber).trim());
  if (c.includes('ups')) return `https://www.ups.com/track?tracknum=${t}`;
  if (c.includes('fedex')) return `https://www.fedex.com/fedextrack/?trknbr=${t}`;
  if (c.includes('usps')) return `https://tools.usps.com/go/TrackConfirmAction?tLabels=${t}`;
  if (c.includes('spee') || c.includes('speedee')) return `https://www.speedeedelivery.com/tools/track-shipment/?tracking=${t}`;
  return null;
}

// Map a SanMar_Status string (+ any synced shipment rows) to a clean indicator
// state. Defensive per Erik's #1 rule: never claim "shipped" without backing —
// a non-empty tracking number can promote a stale Confirmed/unknown to shipped,
// but a blank status never invents a shipment.
//   states: shipped | partial | complete | confirmed | canceled | unknown
function mapSanmarState(statusRaw, shipmentRows) {
  const s = String(statusRaw || '').trim().toLowerCase();
  const hasTracking = Array.isArray(shipmentRows)
    && shipmentRows.some(r => r && String(r.Tracking_Number || '').trim());
  let state;
  if (s === 'shipped') state = 'shipped';
  else if (s === 'partially shipped') state = 'partial';
  else if (s === 'complete') state = 'complete';
  else if (s === 'confirmed' || s === 'received') state = 'confirmed';
  else if (s === 'canceled' || s === 'cancelled') state = 'canceled';
  else state = 'unknown';
  if (hasTracking && (state === 'confirmed' || state === 'unknown')) state = 'shipped';
  const shipped = state === 'shipped' || state === 'partial' || state === 'complete';
  return { state, shipped };
}

// Roll-up precedence when one work order maps to multiple SanMar POs.
const SANMAR_STATE_RANK = { shipped: 5, partial: 4, complete: 3, confirmed: 2, canceled: 1, unknown: 0 };

// Pull SanMar's LIVE shipment feed for ONE po and INSERT any new tracking rows
// into SanMar_Shipments. Returns the count of rows added. Shared by the daily
// sync loop AND the /sync-shipments catch-up pass (Erik 2026-06-16). Idempotent:
// an existing (SanMar_PO, Tracking_Number) row is left untouched. This is the
// SAME logic the order-loop used inline — extracted so the catch-up can re-run it
// for orders whose order-status never changed (and so were skipped by the
// incremental order sync) but whose blanks have actually shipped.
async function pullAndStoreShipments(po) {
  let added = 0;
  const shipSoapBody = buildShipmentRequest(1, { referenceNumber: po });
  const shipXml = await makeSoapRequest(ENDPOINTS.shipmentNotification, shipSoapBody, {
    timeout: 30000,
    namespaces: { ns: NS.shipment, shar: NS.shipmentShared }
  });
  const shipError = checkSoapError(shipXml);
  if (shipError) return 0; // 160 = no shipments; any error → nothing to store
  const shipData = parseShipmentResponse(shipXml);
  for (const shipment of shipData) {
    for (const so of shipment.salesOrders) {
      for (const loc of so.locations) {
        for (const pkg of loc.packages) {
          if (!pkg.trackingNumber) continue;
          try {
            const trackWhere = `SanMar_PO='${xmlEscape(po)}' AND Tracking_Number='${xmlEscape(pkg.trackingNumber)}'`;
            const existingTrack = await makeCaspioRequest('GET',
              `/tables/${TABLES.shipments}/records`, { 'q.where': trackWhere });
            if (Array.isArray(existingTrack) && existingTrack.length > 0) continue;
            await makeCaspioRequest('POST', `/tables/${TABLES.shipments}/records`, {}, {
              SanMar_PO: po,
              Tracking_Number: pkg.trackingNumber,
              Carrier: pkg.carrier || '',
              Ship_Method: pkg.shipmentMethod || '',
              Ship_Date: pkg.shipmentDate ? pkg.shipmentDate.split('T')[0] : '',
              Ship_From_Warehouse: loc.shipFrom.city || '',
              Ship_From_City: loc.shipFrom.city || '',
              Ship_From_State: loc.shipFrom.region || '',
              Ship_From_Zip: loc.shipFrom.postalCode || '',
              Ship_From_Address: loc.shipFrom.address1 || '',
              Ship_To_Address: loc.shipTo.address1 || '',
              Package_Weight: pkg.weight || '',
              Package_Dimensions: pkg.dimensions || '',
              Package_Class: pkg.packageClass || ''
            });
            added++;
          } catch (e) {
            console.error(`Failed to save tracking ${pkg.trackingNumber} for ${po}:`, e.message);
          }
        }
      }
    }
  }
  return added;
}

// ── GET /open — All open SanMar orders ──
router.get('/open', async (req, res) => {
  const cacheKey = 'sanmar-all-open';
  const cached = orderCache.get(cacheKey);
  if (cached && !req.query.refresh) {
    return res.json({ ...cached, cached: true });
  }

  try {
    const auth = getPromoStandardsAuth();
    if (!validateAuth(auth)) {
      return res.status(500).json({ error: 'SanMar credentials not configured' });
    }

    const soapBody = buildOrderStatusRequest('allOpen', {
      returnProductDetail: true,
      returnIssueDetailType: 'allIssues'
    });

    const xml = await makeSoapRequest(ENDPOINTS.orderStatus, soapBody, {
      timeout: 60000,
      namespaces: { ns: NS.orderStatus, shar: NS.orderStatusShared }
    });

    const soapError = checkSoapError(xml);
    if (soapError) {
      if (soapError.code === 160) {
        const result = { orders: [], count: 0, message: 'No open orders found' };
        orderCache.set(cacheKey, result);
        return res.json(result);
      }
      return res.status(soapError.code === 105 ? 401 : 400).json({ error: soapError.message });
    }

    const orders = parseOrderStatusResponse(xml);
    const result = { orders, count: orders.length, fetchedAt: new Date().toISOString() };
    orderCache.set(cacheKey, result);

    res.json(result);
  } catch (error) {
    console.error('Error fetching SanMar open orders:', error.message);
    res.status(500).json({ error: 'Failed to fetch SanMar open orders', details: error.message });
  }
});

// ── GET /status/:po — Single PO status ──
router.get('/status/:po', async (req, res) => {
  const po = req.params.po;
  const cacheKey = `sanmar-status-${po}`;
  const cached = orderCache.get(cacheKey);
  if (cached) return res.json({ ...cached, cached: true });

  try {
    const auth = getPromoStandardsAuth();
    if (!validateAuth(auth)) {
      return res.status(500).json({ error: 'SanMar credentials not configured' });
    }

    const soapBody = buildOrderStatusRequest('poSearch', {
      referenceNumber: po,
      returnProductDetail: true,
      returnIssueDetailType: 'allIssues'
    });

    const xml = await makeSoapRequest(ENDPOINTS.orderStatus, soapBody, {
      timeout: 30000,
      namespaces: { ns: NS.orderStatus, shar: NS.orderStatusShared }
    });

    const soapError = checkSoapError(xml);
    if (soapError) {
      if (soapError.code === 160) return res.json({ orders: [], message: 'PO not found' });
      return res.status(soapError.code === 105 ? 401 : 400).json({ error: soapError.message });
    }

    const orders = parseOrderStatusResponse(xml);
    const result = { purchaseOrder: po, orders, fetchedAt: new Date().toISOString() };
    orderCache.set(cacheKey, result, 300); // 5 min cache for single PO

    res.json(result);
  } catch (error) {
    console.error(`Error fetching SanMar status for PO ${po}:`, error.message);
    res.status(500).json({ error: 'Failed to fetch SanMar order status', details: error.message });
  }
});

// ── GET /shipments/:po — Tracking details for a PO ──
router.get('/shipments/:po', async (req, res) => {
  const po = req.params.po;
  const cacheKey = `sanmar-shipments-${po}`;
  const cached = orderCache.get(cacheKey);
  if (cached) return res.json({ ...cached, cached: true });

  try {
    const auth = getPromoStandardsAuth();
    if (!validateAuth(auth)) {
      return res.status(500).json({ error: 'SanMar credentials not configured' });
    }

    const soapBody = buildShipmentRequest(1, { referenceNumber: po });

    const xml = await makeSoapRequest(ENDPOINTS.shipmentNotification, soapBody, {
      timeout: 30000,
      namespaces: { ns: NS.shipment, shar: NS.shipmentShared }
    });

    const soapError = checkSoapError(xml);
    if (soapError) {
      if (soapError.code === 160) return res.json({ shipments: [], message: 'No shipments found for this PO' });
      return res.status(soapError.code === 105 ? 401 : 400).json({ error: soapError.message });
    }

    const shipments = parseShipmentResponse(xml);
    const result = { purchaseOrder: po, shipments, fetchedAt: new Date().toISOString() };
    orderCache.set(cacheKey, result, 300);

    res.json(result);
  } catch (error) {
    console.error(`Error fetching SanMar shipments for PO ${po}:`, error.message);
    res.status(500).json({ error: 'Failed to fetch SanMar shipment data', details: error.message });
  }
});

// ── GET /lookup — Search by order#, company, rep, style, or PO ──
router.get('/lookup', async (req, res) => {
  const { orderNo, company, rep, style, po, woId } = req.query;

  if (!orderNo && !company && !rep && !style && !po && !woId) {
    return res.status(400).json({ error: 'Provide at least one search parameter: orderNo, company, rep, style, po, or woId' });
  }

  try {
    // Build Caspio WHERE clause
    const conditions = [];
    if (po) conditions.push(`SanMar_PO='${xmlEscape(po)}'`);
    if (orderNo) conditions.push(`ShopWorks_PO='${xmlEscape(orderNo)}'`);
    if (woId) conditions.push(`id_Order='${xmlEscape(woId)}'`);
    if (company) conditions.push(`Company_Name LIKE '%${xmlEscape(company)}%'`);
    if (rep) conditions.push(`Sales_Rep LIKE '%${xmlEscape(rep)}%'`);

    let orders = [];

    // Search archived orders in Caspio first
    if (conditions.length > 0) {
      const where = conditions.join(' AND ');
      try {
        const caspioResult = await makeCaspioRequest('GET',
          `/tables/${TABLES.orders}/records`,
          { 'q.where': where, 'q.orderBy': 'Order_Date DESC', 'q.limit': 50 }
        );
        if (Array.isArray(caspioResult)) {
          orders = caspioResult;
        } else if (caspioResult && caspioResult.Result) {
          orders = caspioResult.Result;
        }
      } catch (caspioErr) {
        console.log('Caspio search returned no results or error:', caspioErr.message);
      }
    }

    // If no Caspio results and searching by orderNo, try live style matching
    // Fetches ManageOrders line items → extracts styles → matches against SanMar allOpen
    if (orderNo && orders.length === 0) {
      try {
        // Step 1: Get line items from ManageOrders for this order
        const moResponse = await makeCaspioRequest('GET',
          `/tables/ManageOrders_Cache/records`,
          { 'q.where': `order_no='${xmlEscape(orderNo)}'` }
        ).catch(() => null);

        // Step 2: Get cached allOpen data (or fetch fresh)
        let allOpenData = orderCache.get('sanmar-all-open');
        if (!allOpenData) {
          const auth = getPromoStandardsAuth();
          if (validateAuth(auth)) {
            const soapBody = buildOrderStatusRequest('allOpen', { returnProductDetail: true, returnIssueDetailType: 'allIssues' });
            const xml = await makeSoapRequest(ENDPOINTS.orderStatus, soapBody, {
              timeout: 60000, namespaces: { ns: NS.orderStatus, shar: NS.orderStatusShared }
            });
            const soapError = checkSoapError(xml);
            if (!soapError) {
              const parsed = parseOrderStatusResponse(xml);
              allOpenData = { orders: parsed, count: parsed.length, fetchedAt: new Date().toISOString() };
              orderCache.set('sanmar-all-open', allOpenData);
            }
          }
        }

        // Step 3: Return all open orders for browsing (staff manually links)
        if (allOpenData && allOpenData.orders) {
          for (const sanmarOrder of allOpenData.orders) {
            const statuses = sanmarOrder.details.map(d => d.status).filter(Boolean);
            const overallStatus = statuses.includes('Shipped') ? 'Shipped'
              : statuses.includes('Partially Shipped') ? 'Partially Shipped'
              : statuses[0] || 'Received';

            orders.push({
              SanMar_PO: sanmarOrder.purchaseOrderNumber,
              SanMar_Sales_Order: sanmarOrder.details[0]?.salesOrderNumber || '',
              SanMar_Status: overallStatus,
              Status_Updated_Date: sanmarOrder.details[0]?.validTimestamp || '',
              Matched_By: 'live-browse',
              _products: sanmarOrder.details.flatMap(d => d.products.map(p => ({
                style: p.productId, qtyOrdered: p.qtyOrdered, qtyShipped: p.qtyShipped, status: p.status
              })))
            });
          }
        }
      } catch (liveErr) {
        console.log('Live SanMar browse error:', liveErr.message);
      }
    }

    // If searching by style, also check items table
    if (style && orders.length === 0) {
      try {
        const baseStyle = style.replace(/_\d?[xX]+$/i, '').toUpperCase();
        const itemResult = await makeCaspioRequest('GET',
          `/tables/${TABLES.items}/records`,
          { 'q.where': `Style='${xmlEscape(baseStyle)}'`, 'q.select': 'SanMar_PO', 'q.limit': 50 }
        );
        if (itemResult && itemResult.Result) {
          const pos = [...new Set(itemResult.Result.map(r => r.SanMar_PO))];
          if (pos.length > 0) {
            const poWhere = pos.map(p => `SanMar_PO='${xmlEscape(p)}'`).join(' OR ');
            const orderResult = await makeCaspioRequest('GET',
              `/tables/${TABLES.orders}/records`,
              { 'q.where': poWhere, 'q.orderBy': 'Order_Date DESC' }
            );
            if (orderResult && orderResult.Result) {
              orders = orderResult.Result;
            }
          }
        }
      } catch (styleErr) {
        console.log('Style search error:', styleErr.message);
      }
    }

    // For each order, fetch items and shipments
    const enrichedOrders = [];
    for (const order of orders.slice(0, 20)) {
      const poNumber = order.SanMar_PO;
      let items = [];
      let shipments = [];

      try {
        const itemResult = await makeCaspioRequest('GET',
          `/tables/${TABLES.items}/records`,
          { 'q.where': `SanMar_PO='${xmlEscape(poNumber)}'` }
        );
        if (itemResult && itemResult.Result) items = itemResult.Result;
      } catch (e) { /* no items yet */ }

      try {
        const shipResult = await makeCaspioRequest('GET',
          `/tables/${TABLES.shipments}/records`,
          { 'q.where': `SanMar_PO='${xmlEscape(poNumber)}'` }
        );
        if (shipResult && shipResult.Result) shipments = shipResult.Result;
      } catch (e) { /* no shipments yet */ }

      enrichedOrders.push({ ...order, items, shipments });
    }

    res.json({ orders: enrichedOrders, count: enrichedOrders.length });
  } catch (error) {
    console.error('Error in SanMar order lookup:', error.message);
    res.status(500).json({ error: 'Lookup failed', details: error.message });
  }
});

// ── GET /batch-status — synced inbound SanMar status for many work orders ──
// Dashboard use: ONE call for all visible rows. SYNCED Caspio data only (no
// SOAP/OSN) → at most two Caspio reads. WOs with no linked SanMar PO are
// OMITTED (the frontend treats absence as a neutral "no inbound PO").
router.get('/batch-status', async (req, res) => {
  try {
    const raw = String(req.query.woIds || '').trim();
    if (!raw) return res.status(400).json({ error: 'Provide woIds (comma-separated work order numbers)' });
    const woIds = [...new Set(raw.split(',').map(s => s.trim()).filter(s => /^\d+$/.test(s)))].slice(0, 200);
    if (woIds.length === 0) return res.json({});

    const cacheKey = `sanmar-batch-${woIds.slice().sort().join(',')}`;
    if (!req.query.refresh) {
      const cached = orderCache.get(cacheKey);
      if (cached) return res.json(cached);
    }

    // Read 1 — SanMar_Orders for these work orders (OR clause mirrors the
    // existing pattern in /lookup; id_Order is stored as text).
    const orderWhere = woIds.map(w => `id_Order='${xmlEscape(w)}'`).join(' OR ');
    let orderRows = [];
    try {
      orderRows = await fetchAllCaspioPages(`/tables/${TABLES.orders}/records`, {
        'q.where': orderWhere,
        'q.select': 'id_Order,SanMar_PO,SanMar_Status,SanMar_Sales_Order,Estimated_Delivery,Status_Updated_Date',
        'q.limit': 1000,
      });
    } catch (e) {
      return res.status(502).json({ error: 'SanMar_Orders read failed', details: e.message });
    }
    if (!Array.isArray(orderRows) || orderRows.length === 0) {
      orderCache.set(cacheKey, {}, 120);
      return res.json({});
    }

    // Read 2 — SanMar_Shipments for all POs we found (skip if none).
    const pos = [...new Set(orderRows.map(r => r.SanMar_PO).filter(Boolean))];
    const shipByPo = {};
    if (pos.length > 0) {
      try {
        const shipWhere = pos.map(p => `SanMar_PO='${xmlEscape(p)}'`).join(' OR ');
        const shipRows = await fetchAllCaspioPages(`/tables/${TABLES.shipments}/records`, {
          'q.where': shipWhere,
          'q.select': 'SanMar_PO,Tracking_Number,Carrier,Ship_Method,Ship_Date',
          'q.limit': 1000,
        });
        for (const r of (shipRows || [])) {
          (shipByPo[r.SanMar_PO] = shipByPo[r.SanMar_PO] || []).push(r);
        }
      } catch (e) { /* shipments optional — status alone is still useful */ }
    }

    // Compose per work order (a WO may map to multiple POs → roll up).
    const out = {};
    for (const row of orderRows) {
      const wo = String(row.id_Order);
      const po = row.SanMar_PO || null;
      const ships = (po && shipByPo[po]) || [];
      const { state, shipped } = mapSanmarState(row.SanMar_Status, ships);
      const firstTrack = ships.find(s => String(s.Tracking_Number || '').trim()) || null;
      const poEntry = {
        po,
        status: row.SanMar_Status || '',
        state,
        shipped,
        salesOrder: row.SanMar_Sales_Order || '',
        estimatedDelivery: row.Estimated_Delivery || '',
        trackingNumber: firstTrack ? firstTrack.Tracking_Number : null,
        carrier: firstTrack ? (firstTrack.Carrier || '') : null,
        trackingUrl: firstTrack ? buildCarrierTrackingUrl(firstTrack.Carrier, firstTrack.Tracking_Number) : null,
        shipDate: firstTrack ? (firstTrack.Ship_Date || '') : null,
      };
      if (!out[wo]) {
        out[wo] = { ...poEntry, pos: [poEntry] };
      } else {
        const posArr = out[wo].pos;
        posArr.push(poEntry);
        if (SANMAR_STATE_RANK[state] > SANMAR_STATE_RANK[out[wo].state]) {
          out[wo] = { ...poEntry, pos: posArr };
        }
      }
    }

    orderCache.set(cacheKey, out, 120);
    res.json(out);
  } catch (error) {
    console.error('[sanmar batch-status] error:', error.message);
    res.status(500).json({ error: 'batch-status failed', details: error.message });
  }
});

// ── GET /daily-inbound — daily arriving-blanks rollup for the dashboard graph ──
// Groups SanMar shipments by ESTIMATED ARRIVAL (actual ship date + a per-warehouse
// ground-transit estimate to NWCA in Milton, WA) and rolls up pieces / boxes /
// orders per day, broken down by decoration method (DTG/EMB/SCP/DTF/…). Caspio-only
// (no live SanMar/SOAP) — reads the three synced tables + joins ManageOrders_Orders
// for id_OrderType. Cached 30 min.
//
// WHY ship-date + transit (not a delivery date): SanMar's Order Status / Shipment
// APIs do NOT return an estimated delivery date (the field is always null), so the
// only forward-looking signal is the ACTUAL ship date plus a transit estimate.
const MO_TABLE = 'ManageOrders_Orders';

// id_OrderType → short decoration label (verified OnSite Order-Types, 2026-05-02)
const ORDER_TYPE_LABEL = {
  5: 'DTG', 13: 'Screen Print', 21: 'Embroidery', 18: 'DTF',
  41: 'Sticker', 7: 'Emblem', 6: 'Online Store'
};
// Legend/stack order for the graph (stable regardless of which methods appear).
const METHOD_ORDER = ['Embroidery', 'Screen Print', 'DTG', 'DTF', 'Sticker', 'Emblem', 'Online Store', 'Other'];

// Ground-transit estimate (calendar days) from each SanMar warehouse state to
// Milton, WA. ESTIMATES ONLY — SanMar provides no delivery ETA. Warehouses:
// WA Seattle · NV Reno · AZ Phoenix · TX Dallas · MN Minneapolis · OH Cincinnati
// · NJ Robbinsville · FL Jacksonville · VA Richmond.
const TRANSIT_DAYS_BY_STATE = {
  WA: 1, OR: 2, NV: 2, AZ: 2, TX: 3, MN: 3, OH: 4, NJ: 4, FL: 5, VA: 5
};
const DEFAULT_TRANSIT_DAYS = 3;

// Shift a 'YYYY-MM-DD' date by N days (UTC), returning 'YYYY-MM-DD' or null.
function addDaysISO(isoDate, days) {
  const d = new Date(isoDate + 'T00:00:00Z');
  if (isNaN(d.getTime())) return null;
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

router.get('/daily-inbound', async (req, res) => {
  try {
    const past = Math.min(Math.max(parseInt(req.query.past) || 3, 0), 30);
    const future = Math.min(Math.max(parseInt(req.query.future) || 21, 1), 90);
    const today = new Date().toISOString().slice(0, 10);
    const windowStart = addDaysISO(today, -past);
    const windowEnd = addDaysISO(today, future);

    const cacheKey = `sanmar-daily-inbound-${windowStart}-${windowEnd}`;
    if (!req.query.refresh) {
      const cached = orderCache.get(cacheKey);
      if (cached) return res.json(cached);
    }

    // 1. Recent shipments. Ship dates are in the past; arrivals = ship + transit, so
    //    a lookback of (future + ~10) days covers anything still arriving in-window.
    const shipLookback = addDaysISO(today, -(future + 10));
    const shipRows = await fetchAllCaspioPages(`/tables/${TABLES.shipments}/records`, {
      'q.where': `Ship_Date>='${shipLookback}'`,
      'q.select': 'SanMar_PO,Ship_Date,Ship_From_State',
      'q.limit': 1000,
    }) || [];

    // 2. Roll boxes up to the PO — a PO "arrives" on its earliest box arrival.
    const poAgg = new Map(); // po -> { boxes, arrival }
    for (const s of shipRows) {
      const po = s.SanMar_PO;
      const shipDate = (s.Ship_Date || '').slice(0, 10);
      if (!po || !shipDate) continue;
      const transit = TRANSIT_DAYS_BY_STATE[(s.Ship_From_State || '').toUpperCase()] || DEFAULT_TRANSIT_DAYS;
      const arrival = addDaysISO(shipDate, transit);
      if (!arrival) continue;
      const cur = poAgg.get(po) || { boxes: 0, arrival };
      cur.boxes += 1;
      if (arrival < cur.arrival) cur.arrival = arrival;
      poAgg.set(po, cur);
    }

    if (poAgg.size === 0) {
      const empty = {
        generatedAt: new Date().toISOString(), today, windowStart, windowEnd,
        methods: [], days: [], totals: { pieces: 0, boxes: 0, orders: 0 },
        pending: { orders: 0 }, note: 'No SanMar shipments in range.'
      };
      orderCache.set(cacheKey, empty, 600);
      return res.json(empty);
    }

    // 3. Pieces per PO (sum Qty_Shipped; fall back to Qty_Ordered if nothing shipped).
    const itemRows = await fetchAllCaspioPages(`/tables/${TABLES.items}/records`, {
      'q.select': 'SanMar_PO,Qty_Ordered,Qty_Shipped',
      'q.limit': 1000,
    }) || [];
    const piecesByPo = new Map();
    for (const it of itemRows) {
      if (!poAgg.has(it.SanMar_PO)) continue;
      const cur = piecesByPo.get(it.SanMar_PO) || { shipped: 0, ordered: 0 };
      cur.shipped += parseInt(it.Qty_Shipped) || 0;
      cur.ordered += parseInt(it.Qty_Ordered) || 0;
      piecesByPo.set(it.SanMar_PO, cur);
    }

    // 4. PO → id_Order (SanMar_Orders), then id_Order → id_OrderType (ManageOrders_Orders).
    const orderRows = await fetchAllCaspioPages(`/tables/${TABLES.orders}/records`, {
      'q.select': 'SanMar_PO,id_Order',
      'q.limit': 1000,
    }) || [];
    const idOrderByPo = new Map();
    for (const o of orderRows) {
      if (poAgg.has(o.SanMar_PO) && o.id_Order) idOrderByPo.set(o.SanMar_PO, String(o.id_Order));
    }
    const idOrders = [...new Set([...idOrderByPo.values()])];
    const typeByIdOrder = new Map();
    for (let i = 0; i < idOrders.length; i += 75) {
      const chunk = idOrders.slice(i, i + 75);
      const where = chunk.map(id => `id_Order='${xmlEscape(id)}'`).join(' OR ');
      try {
        const moRows = await fetchAllCaspioPages(`/tables/${MO_TABLE}/records`, {
          'q.where': where, 'q.select': 'id_Order,id_OrderType', 'q.limit': 1000,
        }) || [];
        for (const m of moRows) typeByIdOrder.set(String(m.id_Order), parseInt(m.id_OrderType) || 0);
      } catch (e) { /* MO join optional — unmatched POs fall to 'Other' */ }
    }

    // 5. Aggregate per arrival day, broken down by method.
    const dayMap = new Map(); // date -> { pieces, boxes, orders, byMethod }
    const methodsSeen = new Set();
    for (const [po, { boxes, arrival }] of poAgg) {
      if (arrival < windowStart || arrival > windowEnd) continue;
      const pc = piecesByPo.get(po) || { shipped: 0, ordered: 0 };
      const pieces = pc.shipped > 0 ? pc.shipped : pc.ordered;
      const idOrder = idOrderByPo.get(po);
      const method = ORDER_TYPE_LABEL[idOrder ? typeByIdOrder.get(idOrder) : 0] || 'Other';
      methodsSeen.add(method);
      const d = dayMap.get(arrival) || { pieces: 0, boxes: 0, orders: 0, byMethod: {} };
      d.pieces += pieces; d.boxes += boxes; d.orders += 1;
      const bm = d.byMethod[method] || { pieces: 0, boxes: 0, orders: 0 };
      bm.pieces += pieces; bm.boxes += boxes; bm.orders += 1;
      d.byMethod[method] = bm;
      dayMap.set(arrival, d);
    }

    const days = [...dayMap.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))
      .map(([date, v]) => ({ date, ...v }));
    const totals = days.reduce((t, d) => ({
      pieces: t.pieces + d.pieces, boxes: t.boxes + d.boxes, orders: t.orders + d.orders
    }), { pieces: 0, boxes: 0, orders: 0 });

    // 6. Pending = confirmed/received POs with no shipment yet (not on the graph).
    let pendingOrders = 0;
    try {
      const openRows = await fetchAllCaspioPages(`/tables/${TABLES.orders}/records`, {
        'q.where': "SanMar_Status='Received' OR SanMar_Status='Confirmed'",
        'q.select': 'SanMar_PO', 'q.limit': 1000,
      }) || [];
      pendingOrders = openRows.filter(o => !poAgg.has(o.SanMar_PO)).length;
    } catch (e) { /* pending is a nicety */ }

    const payload = {
      generatedAt: new Date().toISOString(),
      today, windowStart, windowEnd,
      methods: METHOD_ORDER.filter(m => methodsSeen.has(m)),
      days, totals,
      pending: { orders: pendingOrders },
      note: 'Arrival = actual SanMar ship date + ground-transit estimate to Milton, WA. SanMar provides no delivery ETA.',
    };
    orderCache.set(cacheKey, payload, 1800);
    res.json(payload);
  } catch (error) {
    console.error('[sanmar daily-inbound] error:', error.message);
    res.status(500).json({ error: 'daily-inbound failed', details: error.message });
  }
});

// ── GET /inbound-today — detailed POs ARRIVING on a given day (default today) ──
// Powers the dashboard "Today's Inbound" detail view + printable PDF report. Per PO:
// work order #, company, decoration method, carrier/tracking, box count, and full line
// items WITH color/size resolved from the Sanmar_Bulk product table (Part_ID = UNIQUE_KEY,
// the same join box-labels-data.js uses in prod). Caspio-only, no SOAP. Cached 10 min.
const SANMAR_BULK_TABLE = '/tables/Sanmar_Bulk_251816_Feb2024/records';

// Resolve SanMar Part_IDs (uniqueKey) → {style,colorName,catalogColor,size,title,brand}
// via Sanmar_Bulk.UNIQUE_KEY IN (...). Sanitize to ints (the column is integer + injection
// guard). Unresolved ids (e.g. discontinued, absent from the snapshot) simply aren't in the map.
async function resolvePartColors(partIds) {
  const ids = [...new Set(partIds.map(p => parseInt(p, 10)).filter(n => Number.isInteger(n) && n > 0))];
  const map = new Map();
  for (let i = 0; i < ids.length; i += 90) {
    const chunk = ids.slice(i, i + 90);
    try {
      const rows = await fetchAllCaspioPages(SANMAR_BULK_TABLE, {
        'q.where': `UNIQUE_KEY IN (${chunk.join(',')})`,
        'q.select': 'UNIQUE_KEY,STYLE,COLOR_NAME,CATALOG_COLOR,SIZE,PRODUCT_TITLE,BRAND_NAME',
        'q.limit': 1000,
      }) || [];
      for (const r of rows) {
        map.set(String(r.UNIQUE_KEY), {
          style: r.STYLE || '',
          colorName: r.COLOR_NAME || '',
          catalogColor: r.CATALOG_COLOR || '',
          size: r.SIZE || '',
          title: (r.PRODUCT_TITLE || '').replace(/\.\s*[A-Za-z0-9]+\s*$/, '').trim(),
          brand: r.BRAND_NAME || '',
        });
      }
    } catch (e) { /* unresolved ids fall back to Part_ID-only in the caller */ }
  }
  return map;
}

router.get('/inbound-today', async (req, res) => {
  try {
    const today = new Date().toISOString().slice(0, 10);
    const date = /^\d{4}-\d{2}-\d{2}$/.test(req.query.date || '') ? req.query.date : today;

    const cacheKey = `sanmar-inbound-today-${date}`;
    if (!req.query.refresh) { const c = orderCache.get(cacheKey); if (c) return res.json(c); }

    // 1. Shipments whose ESTIMATED ARRIVAL (ship date + transit) == the target day.
    const lookback = addDaysISO(date, -12);
    const shipRows = await fetchAllCaspioPages(`/tables/${TABLES.shipments}/records`, {
      'q.where': `Ship_Date>='${lookback}' AND Ship_Date<='${date}'`,
      'q.select': 'SanMar_PO,Ship_Date,Ship_From_State,Ship_From_City,Carrier,Ship_Method,Tracking_Number',
      'q.limit': 1000,
    }) || [];

    const poShip = new Map(); // po -> { boxes, shipDate, carrier, tracking, fromCity, fromState }
    for (const s of shipRows) {
      const po = s.SanMar_PO; const sd = (s.Ship_Date || '').slice(0, 10);
      if (!po || !sd) continue;
      const transit = TRANSIT_DAYS_BY_STATE[(s.Ship_From_State || '').toUpperCase()] || DEFAULT_TRANSIT_DAYS;
      if (addDaysISO(sd, transit) !== date) continue; // arrives a different day
      const cur = poShip.get(po) || { boxes: 0, shipDate: sd, carrier: s.Carrier || '', tracking: s.Tracking_Number || '', fromCity: s.Ship_From_City || '', fromState: s.Ship_From_State || '' };
      cur.boxes += 1;
      if (sd < cur.shipDate) cur.shipDate = sd;
      if (!cur.tracking && s.Tracking_Number) cur.tracking = s.Tracking_Number;
      poShip.set(po, cur);
    }

    if (poShip.size === 0) {
      const empty = { date, today, generatedAt: new Date().toISOString(), totals: { pos: 0, workOrders: 0, boxes: 0, piecesShipped: 0, piecesOrdered: 0, lines: 0 }, orders: [], note: `No SanMar shipments arriving ${date}.` };
      orderCache.set(cacheKey, empty, 300); return res.json(empty);
    }
    const pos = [...poShip.keys()];
    const poWhere = pos.map(p => `SanMar_PO='${xmlEscape(p)}'`).join(' OR ');

    // 2. Orders (work order #, company, sales order, status) for these POs.
    const orderRows = await fetchAllCaspioPages(`/tables/${TABLES.orders}/records`, {
      'q.where': poWhere,
      'q.select': 'SanMar_PO,id_Order,ShopWorks_PO,SanMar_Sales_Order,SanMar_Status,Company_Name,Sales_Rep',
      'q.limit': 1000,
    }) || [];
    const orderByPo = new Map(orderRows.map(o => [o.SanMar_PO, o]));

    // 3. Line items for these POs.
    const itemRows = await fetchAllCaspioPages(`/tables/${TABLES.items}/records`, {
      'q.where': poWhere,
      'q.select': 'SanMar_PO,Style,Part_ID,Qty_Ordered,Qty_Shipped,Item_Status',
      'q.limit': 1000,
    }) || [];

    // 3b. Live per-box contents (OSN) for each arriving PO — concurrency-capped, per-PO
    //     try/catch so one slow/failed PO degrades only itself (Rule #4: a PO that can't
    //     resolve its boxes keeps the PO-level line summary rather than showing blank-but-complete).
    const boxesByPo = new Map();
    const fetchBoxes = async (po) => {
      try {
        const xml = await makeSoapRequest(ENDPOINTS.shipmentNotification, buildShipmentRequest(1, { referenceNumber: po }), {
          timeout: 20000, namespaces: { ns: NS.shipment, shar: NS.shipmentShared },
        });
        if (checkSoapError(xml)) return;
        const boxes = [];
        for (const sh of parseShipmentResponse(xml)) {
          for (const so of (sh.salesOrders || [])) {
            for (const loc of (so.locations || [])) {
              for (const pkg of (loc.packages || [])) {
                if (!pkg.trackingNumber && !(pkg.items && pkg.items.length)) continue;
                boxes.push({
                  trackingNumber: pkg.trackingNumber || '', carrier: pkg.carrier || '',
                  shipmentDate: (pkg.shipmentDate || '').slice(0, 10),
                  items: (pkg.items || []).map(it => ({ partId: String(it.supplierPartId || ''), style: it.supplierProductId || '', qty: parseInt(it.quantity, 10) || 0 })),
                });
              }
            }
          }
        }
        boxesByPo.set(po, boxes);
      } catch (e) { /* unset → PO falls back to PO-level lines in the response */ }
    };
    for (let i = 0; i < pos.length; i += 5) { // pool of 5 to stay snappy + within SanMar cadence
      await Promise.all(pos.slice(i, i + 5).map(fetchBoxes));
    }

    // 4. Resolve color/size for every Part_ID — order-items AND box contents — in one lookup.
    const boxPartIds = [];
    for (const bs of boxesByPo.values()) for (const b of bs) for (const it of b.items) boxPartIds.push(it.partId);
    const colorMap = await resolvePartColors([...itemRows.map(it => it.Part_ID).filter(Boolean), ...boxPartIds]);

    // 5. Decoration method per work order (ManageOrders_Orders.id_OrderType).
    const idOrders = [...new Set(orderRows.map(o => o.id_Order).filter(Boolean).map(String))];
    const typeByIdOrder = new Map();
    for (let i = 0; i < idOrders.length; i += 75) {
      const chunk = idOrders.slice(i, i + 75);
      try {
        const moRows = await fetchAllCaspioPages(`/tables/${MO_TABLE}/records`, {
          'q.where': chunk.map(id => `id_Order='${xmlEscape(id)}'`).join(' OR '), 'q.select': 'id_Order,id_OrderType', 'q.limit': 1000,
        }) || [];
        for (const m of moRows) typeByIdOrder.set(String(m.id_Order), parseInt(m.id_OrderType) || 0);
      } catch (e) { /* method falls back to 'Other' */ }
    }

    // 6. Group line items by PO (color resolved; unresolved → Part_ID only, never dropped).
    const linesByPo = new Map();
    for (const it of itemRows) {
      const c = colorMap.get(String(it.Part_ID)) || null;
      let arr = linesByPo.get(it.SanMar_PO);
      if (!arr) { arr = []; linesByPo.set(it.SanMar_PO, arr); }
      arr.push({
        style: it.Style || (c && c.style) || '',
        partId: it.Part_ID || '',
        color: c ? c.colorName : '',
        catalogColor: c ? c.catalogColor : '',
        size: c ? c.size : '',
        title: c ? c.title : '',
        brand: c ? c.brand : '',
        qtyOrdered: parseInt(it.Qty_Ordered, 10) || 0,
        qtyShipped: parseInt(it.Qty_Shipped, 10) || 0,
        status: it.Item_Status || '',
        resolved: !!c,
      });
    }

    // 6b. Per-box contents with color/size resolved (one box block per package).
    const boxDetailByPo = new Map();
    for (const [po, bs] of boxesByPo) {
      boxDetailByPo.set(po, bs.map((b, i) => ({
        boxNumber: i + 1,
        trackingNumber: b.trackingNumber,
        carrier: b.carrier,
        trackingUrl: buildCarrierTrackingUrl(b.carrier, b.trackingNumber),
        shipmentDate: b.shipmentDate,
        pieces: b.items.reduce((t, it) => t + it.qty, 0),
        items: b.items.map(it => {
          const c = colorMap.get(it.partId) || null;
          return {
            style: it.style || (c && c.style) || '', partId: it.partId,
            color: c ? c.colorName : '', catalogColor: c ? c.catalogColor : '',
            size: c ? c.size : '', title: c ? c.title : '', brand: c ? c.brand : '',
            qty: it.qty, resolved: !!c,
          };
        }),
      })));
    }

    // 7. Compose per-PO records, sorted by company then PO.
    const orders = pos.map(po => {
      const sh = poShip.get(po); const o = orderByPo.get(po) || {};
      const lines = linesByPo.get(po) || [];
      const piecesShipped = lines.reduce((t, l) => t + l.qtyShipped, 0);
      const piecesOrdered = lines.reduce((t, l) => t + l.qtyOrdered, 0);
      const method = ORDER_TYPE_LABEL[o.id_Order ? typeByIdOrder.get(String(o.id_Order)) : 0] || 'Other';
      return {
        sanmarPO: po, workOrder: o.id_Order || '', shopworksPO: o.ShopWorks_PO || '',
        company: o.Company_Name || '', salesRep: o.Sales_Rep || '', salesOrder: o.SanMar_Sales_Order || '', status: o.SanMar_Status || '',
        method, arrival: date, shipDate: sh.shipDate, fromCity: sh.fromCity, fromState: sh.fromState,
        carrier: sh.carrier, tracking: sh.tracking, trackingUrl: buildCarrierTrackingUrl(sh.carrier, sh.tracking),
        boxes: (boxDetailByPo.get(po) || []).length || sh.boxes,
        boxDetail: boxDetailByPo.get(po) || null,
        boxDetailAvailable: boxesByPo.has(po),
        piecesShipped, piecesOrdered, lines,
      };
    }).sort((a, b) => (a.company || '').localeCompare(b.company || '') || a.sanmarPO.localeCompare(b.sanmarPO));

    const wos = new Set();
    const totals = orders.reduce((t, o) => {
      wos.add(o.workOrder || ('po:' + o.sanmarPO));
      return { pos: t.pos + 1, boxes: t.boxes + o.boxes, piecesShipped: t.piecesShipped + o.piecesShipped, piecesOrdered: t.piecesOrdered + o.piecesOrdered, lines: t.lines + o.lines.length };
    }, { pos: 0, boxes: 0, piecesShipped: 0, piecesOrdered: 0, lines: 0 });

    const payload = {
      date, today, generatedAt: new Date().toISOString(),
      totals: { pos: totals.pos, workOrders: wos.size, boxes: totals.boxes, piecesShipped: totals.piecesShipped, piecesOrdered: totals.piecesOrdered, lines: totals.lines },
      orders,
      note: 'Arriving = actual SanMar ship date + ground-transit estimate to Milton, WA. Per-box contents come live from SanMar\'s shipment feed; colors/sizes from the SanMar product table (unresolved SKUs show the Part_ID only).',
    };
    orderCache.set(cacheKey, payload, 600);
    res.json(payload);
  } catch (error) {
    console.error('[sanmar inbound-today] error:', error.message);
    res.status(500).json({ error: 'inbound-today failed', details: error.message });
  }
});

// ── POST /link — Save ShopWorks↔SanMar PO mapping ──
router.post('/link', async (req, res) => {
  const { sanmarPO, shopworksOrderNo, companyName, salesRep, idCustomer, matchedBy } = req.body;

  if (!sanmarPO || !shopworksOrderNo) {
    return res.status(400).json({ error: 'sanmarPO and shopworksOrderNo are required' });
  }

  try {
    // Check if mapping already exists
    const existing = await makeCaspioRequest('GET',
      `/tables/${TABLES.orders}/records`,
      { 'q.where': `SanMar_PO='${xmlEscape(sanmarPO)}'` }
    );

    if (Array.isArray(existing) && existing.length > 0) {
      // Update existing — include all provided fields
      const updateData = { ShopWorks_PO: shopworksOrderNo, Company_Name: companyName, Sales_Rep: salesRep };
      if (idCustomer) updateData.id_Customer = idCustomer;
      if (matchedBy) updateData.Matched_By = matchedBy;
      // Accept idOrder to set the ManageOrders order ID
      if (req.body.idOrder) updateData.id_Order = req.body.idOrder;
      await makeCaspioRequest('PUT',
        `/tables/${TABLES.orders}/records`,
        { 'q.where': `SanMar_PO='${xmlEscape(sanmarPO)}'` },
        updateData
      );
      return res.json({ message: 'Mapping updated', sanmarPO, shopworksOrderNo });
    }

    // Create new
    await makeCaspioRequest('POST',
      `/tables/${TABLES.orders}/records`,
      {},
      {
        SanMar_PO: sanmarPO,
        ShopWorks_PO: shopworksOrderNo,
        Company_Name: companyName || '',
        Sales_Rep: salesRep || '',
        id_Customer: idCustomer || 0,
        Matched_By: matchedBy || 'manual',
        Last_Sync_Date: new Date().toISOString()
      }
    );

    res.json({ message: 'Mapping saved', sanmarPO, shopworksOrderNo });
  } catch (error) {
    console.error('Error saving PO mapping:', error.message);
    res.status(500).json({ error: 'Failed to save mapping', details: error.message });
  }
});

// ── POST /sync — Daily sync (called by Heroku Scheduler) ──
router.post('/sync', async (req, res) => {
  // Protect with API secret
  const secret = req.headers['x-api-secret'] || req.query.secret;
  if (secret !== process.env.CRM_API_SECRET) {
    return res.status(403).json({ error: 'Unauthorized' });
  }

  const isWeekly = req.query.full === 'true' || new Date().getDay() === 1; // Monday = full sync
  const syncLog = { started: new Date().toISOString(), type: isWeekly ? 'weekly-full' : 'daily-incremental' };

  try {
    const auth = getPromoStandardsAuth();
    if (!validateAuth(auth)) {
      return res.status(500).json({ error: 'SanMar credentials not configured' });
    }

    let orders = [];

    if (isWeekly) {
      // Full sync: allOpen
      const soapBody = buildOrderStatusRequest('allOpen', { returnProductDetail: true });
      const xml = await makeSoapRequest(ENDPOINTS.orderStatus, soapBody, {
        timeout: 60000,
        namespaces: { ns: NS.orderStatus, shar: NS.orderStatusShared }
      });
      const soapError = checkSoapError(xml);
      if (!soapError) {
        orders = parseOrderStatusResponse(xml);
      }
      syncLog.queryType = 'allOpen';
    } else {
      // Daily: lastUpdate since yesterday
      const yesterday = new Date();
      yesterday.setDate(yesterday.getDate() - 1);
      const timestamp = yesterday.toISOString().replace('Z', '');

      const soapBody = buildOrderStatusRequest('lastUpdate', {
        statusTimeStamp: timestamp,
        returnProductDetail: true
      });
      const xml = await makeSoapRequest(ENDPOINTS.orderStatus, soapBody, {
        timeout: 60000,
        namespaces: { ns: NS.orderStatus, shar: NS.orderStatusShared }
      });
      const soapError = checkSoapError(xml);
      if (!soapError) {
        orders = parseOrderStatusResponse(xml);
      } else if (soapError.code === 160) {
        orders = []; // No updates since yesterday
      }
      syncLog.queryType = 'lastUpdate';
      syncLog.since = timestamp;
    }

    syncLog.ordersFound = orders.length;

    // Upsert orders to Caspio
    let upserted = 0;
    let shipmentsUpdated = 0;

    for (const order of orders) {
      const po = order.purchaseOrderNumber;
      if (!po) continue;

      // Determine overall status from details
      const statuses = order.details.map(d => d.status).filter(Boolean);
      const overallStatus = statuses.includes('Shipped') ? 'Shipped'
        : statuses.includes('Partially Shipped') ? 'Partially Shipped'
        : statuses.includes('Confirmed') ? 'Confirmed'
        : statuses.includes('Complete') ? 'Complete'
        : statuses.includes('Canceled') ? 'Canceled'
        : statuses[0] || 'Received';

      const salesOrderNum = order.details[0]?.salesOrderNumber || '';
      const validTimestamp = order.details[0]?.validTimestamp || '';

      // Auto-extract ShopWorks PO from SanMar PO (strip initials like BW, EM, TC, NL)
      const shopworksPO = extractPONumber(po);

      // Collect issue details and estimated delivery from all details
      const allIssues = [];
      let estDelivery = '';
      for (const detail of order.details) {
        if (detail.issues) allIssues.push(...detail.issues);
        for (const prod of detail.products) {
          if (prod.estimatedDeliveryDate && !estDelivery) estDelivery = prod.estimatedDeliveryDate;
        }
      }

      // Upsert order record
      const orderData = {
        SanMar_PO: po,
        ShopWorks_PO: shopworksPO || '',
        SanMar_Sales_Order: salesOrderNum,
        SanMar_Status: overallStatus,
        Status_Updated_Date: validTimestamp || new Date().toISOString(),
        Last_Sync_Date: new Date().toISOString(),
        Issue_Details: allIssues.length > 0 ? JSON.stringify(allIssues) : '',
        Estimated_Delivery: estDelivery
      };

      try {
        const existing = await makeCaspioRequest('GET',
          `/tables/${TABLES.orders}/records`,
          { 'q.where': `SanMar_PO='${xmlEscape(po)}'` }
        );

        if (Array.isArray(existing) && existing.length > 0) {
          await makeCaspioRequest('PUT',
            `/tables/${TABLES.orders}/records`,
            { 'q.where': `SanMar_PO='${xmlEscape(po)}'` },
            orderData
          );
        } else {
          await makeCaspioRequest('POST',
            `/tables/${TABLES.orders}/records`,
            {},
            { ...orderData, Matched_By: 'sync' }
          );
        }
        upserted++;
      } catch (e) {
        console.error(`Failed to upsert order ${po}:`, e.message);
      }

      // Upsert line items from product details
      for (const detail of order.details) {
        for (const product of detail.products) {
          if (!product.productId) continue;
          try {
            const itemWhere = `SanMar_PO='${xmlEscape(po)}' AND Style='${xmlEscape(product.productId)}' AND Part_ID='${xmlEscape(product.partId || '')}'`;
            const existingItem = await makeCaspioRequest('GET',
              `/tables/${TABLES.items}/records`,
              { 'q.where': itemWhere }
            );

            const itemData = {
              SanMar_PO: po,
              Style: product.productId,
              Part_ID: product.partId || '',
              Qty_Ordered: parseInt(product.qtyOrdered) || 0,
              Qty_Shipped: parseInt(product.qtyShipped) || 0,
              Item_Status: product.status || detail.status || ''
            };

            if (Array.isArray(existingItem) && existingItem.length > 0) {
              await makeCaspioRequest('PUT', `/tables/${TABLES.items}/records`, { 'q.where': itemWhere }, itemData);
            } else {
              await makeCaspioRequest('POST', `/tables/${TABLES.items}/records`, {}, itemData);
            }
          } catch (e) {
            console.error(`Failed to upsert item ${product.productId} for ${po}:`, e.message);
          }
        }
      }

      // Fetch shipments for open orders (shared helper — same logic the
      // /sync-shipments catch-up pass re-runs for status-unchanged orders).
      if (!['Complete', 'Canceled'].includes(overallStatus)) {
        try {
          shipmentsUpdated += await pullAndStoreShipments(po);
        } catch (e) {
          console.error(`Failed to fetch shipments for ${po}:`, e.message);
        }
      }
    }

    syncLog.ordersUpserted = upserted;
    syncLog.shipmentsUpdated = shipmentsUpdated;

    // Auto-match unlinked orders using Caspio tables (fast, no live API calls)
    try {
      const matchResult = await runQuickMatch();
      syncLog.quickMatch = matchResult;
      console.log(`[Sync] Quick match: ${matchResult.matched} matched, ${matchResult.unmatched} unmatched`);
    } catch (e) {
      console.error('[Sync] Quick match failed:', e.message);
      syncLog.quickMatch = { error: e.message };
    }

    syncLog.completed = new Date().toISOString();

    console.log('SanMar sync completed:', JSON.stringify(syncLog));
    res.json(syncLog);
  } catch (error) {
    console.error('SanMar sync failed:', error.message);
    res.status(500).json({ error: 'Sync failed', details: error.message });
  }
});

// ── POST /sync-shipments — catch-up shipment pull for stuck "confirmed" orders ──
// Closes the OSS-vs-OSN gap (Erik 2026-06-16): SanMar's order-status feed and its
// shipment feed are separate services, so an order can SHIP without its status
// flipping off "Confirmed". The daily incremental order sync only re-touches
// status-changed orders, so a ship-without-status-change never gets its tracking
// pulled — the Inbound dot stays "confirmed" until the weekly full sync. This
// endpoint fills the gap: for a BOUNDED batch of recent open/confirmed orders that
// have NO tracking row yet (most-recently-updated first), pull the live shipment
// feed and store any tracking. mapSanmarState() then shows them shipped. Bounded
// to stay under Heroku's 30s request limit; the daily sync script drains it in
// rounds. Secret-protected like /sync.
router.post('/sync-shipments', async (req, res) => {
  const secret = req.headers['x-api-secret'] || req.query.secret;
  if (secret !== process.env.CRM_API_SECRET) {
    return res.status(403).json({ error: 'Unauthorized' });
  }
  const cap = Math.min(Math.max(parseInt(req.query.limit) || 8, 1), 15);
  const log = { started: new Date().toISOString() };
  try {
    // Open (non-terminal) orders, most-recently-updated first (likeliest to have
    // just shipped). EXCLUDE terminal states rather than match specific open ones:
    // SanMar stores the raw status casing (e.g. lowercase "confirmed"), so an
    // exclusion is robust to casing AND to any new open-status string. Already-
    // "shipped"/"complete" orders are skipped (their dot is already correct, and a
    // status-shipped order doesn't need a tracking-based promotion). No date math
    // in the q.where (avoids Caspio datetime-format pitfalls) — orderBy + cap focus
    // on recency.
    const openOrders = await fetchAllCaspioPages(`/tables/${TABLES.orders}/records`, {
      'q.where': "SanMar_Status<>'Shipped' AND SanMar_Status<>'Complete' AND SanMar_Status<>'Canceled' AND SanMar_Status<>'Cancelled'",
      'q.select': 'SanMar_PO,Status_Updated_Date',
      'q.orderBy': 'Status_Updated_Date DESC',
      'q.limit': 1000,
    });
    const pos = [...new Set((openOrders || []).map(o => o.SanMar_PO).filter(Boolean))]; // preserves recency order
    // Which already have a tracking row? Skip those.
    let withTracking = new Set();
    if (pos.length) {
      const tw = pos.map(p => `SanMar_PO='${xmlEscape(p)}'`).join(' OR ');
      const tr = await fetchAllCaspioPages(`/tables/${TABLES.shipments}/records`,
        { 'q.where': tw, 'q.select': 'SanMar_PO', 'q.limit': 2000 });
      withTracking = new Set((tr || []).map(r => r.SanMar_PO));
    }
    const pending = pos.filter(p => !withTracking.has(p));
    const batch = pending.slice(0, cap);
    let added = 0;
    for (const po of batch) {
      try { added += await pullAndStoreShipments(po); }
      catch (e) { console.error(`[sync-shipments] ${po}:`, e.message); }
    }
    log.openConfirmed = pos.length;
    log.pendingNoTracking = pending.length;
    log.checked = batch.length;
    log.shipmentsAdded = added;
    log.remaining = Math.max(0, pending.length - batch.length);
    log.completed = new Date().toISOString();
    console.log('[sync-shipments]', JSON.stringify(log));
    res.json(log);
  } catch (error) {
    console.error('[sync-shipments] failed:', error.message);
    res.status(500).json({ error: 'sync-shipments failed', details: error.message });
  }
});

// ── GET /backfill-status — Check progress of running or last backfill ──
router.get('/backfill-status', (req, res) => {
  res.json(backfillStatus);
});

// ── GET /status-summary — Monitoring: table counts, sync health, data quality ──
router.get('/status-summary', async (req, res) => {
  try {
    const tableNames = [
      'SanMar_Orders', 'SanMar_Order_Items', 'SanMar_Shipments',
      'SanMar_Invoices', 'SanMar_Invoice_Items'
    ];

    // Fetch a small set from each table to get counts
    const tableResults = await Promise.all(
      tableNames.map(t =>
        makeCaspioRequest('GET', `/tables/${t}/records`, { 'q.select': 'PK_ID', 'q.limit': '1000' })
          .then(r => ({ table: t, count: Array.isArray(r) ? r.length : 0, error: null }))
          .catch(e => ({ table: t, count: 0, error: e.message }))
      )
    );

    const tables = {};
    for (const r of tableResults) {
      tables[r.table] = { rows: r.count, error: r.error };
    }

    // Get latest sync date from orders
    let lastSync = 'Never';
    try {
      const latest = await makeCaspioRequest('GET', `/tables/${TABLES.orders}/records`, {
        'q.orderBy': 'Last_Sync_Date DESC', 'q.limit': '1', 'q.select': 'Last_Sync_Date'
      });
      if (Array.isArray(latest) && latest.length > 0 && latest[0].Last_Sync_Date) {
        lastSync = latest[0].Last_Sync_Date;
      }
    } catch (e) { /* ignore */ }

    // Get order status distribution
    const statusCounts = {};
    try {
      const allOrders = await makeCaspioRequest('GET', `/tables/${TABLES.orders}/records`, {
        'q.select': 'SanMar_Status', 'q.limit': '1000'
      });
      if (Array.isArray(allOrders)) {
        for (const o of allOrders) {
          const s = o.SanMar_Status || 'Unknown';
          statusCounts[s] = (statusCounts[s] || 0) + 1;
        }
      }
    } catch (e) { /* ignore */ }

    // Data quality: items missing Unit_Price
    let itemsMissingPrice = 0;
    try {
      const missing = await makeCaspioRequest('GET', `/tables/${TABLES.items}/records`, {
        'q.where': 'Unit_Price IS NULL', 'q.select': 'PK_ID', 'q.limit': '1000'
      });
      itemsMissingPrice = Array.isArray(missing) ? missing.length : 0;
    } catch (e) { /* ignore */ }

    res.json({
      tables,
      lastSync,
      orderStatusDistribution: statusCounts,
      dataQuality: { itemsMissingUnitPrice: itemsMissingPrice },
      backfill: {
        running: backfillStatus.running,
        lastRun: backfillStatus.lastRun,
        lastResult: backfillStatus.lastResult ? {
          success: backfillStatus.lastResult.success,
          ordersSaved: backfillStatus.lastResult.ordersSaved,
          shipmentsSaved: backfillStatus.lastResult.shipmentsSaved
        } : null
      },
      checkedAt: new Date().toISOString()
    });
  } catch (error) {
    console.error('Status summary error:', error.message);
    res.status(500).json({ error: 'Failed to generate status summary', details: error.message });
  }
});

// ── POST /backfill — Fire-and-forget backfill with progress tracking ──
router.post('/backfill', async (req, res) => {
  const secret = req.headers['x-api-secret'] || req.query.secret;
  if (secret !== process.env.CRM_API_SECRET) {
    return res.status(403).json({ error: 'Unauthorized' });
  }

  if (backfillStatus.running) {
    // Auto-reset if stuck for more than 2 hours
    const stuckThreshold = 2 * 60 * 60 * 1000;
    if (backfillStatus.startedAt && (Date.now() - backfillStatus.startedAt > stuckThreshold)) {
      console.warn('[Backfill] Resetting stuck backfill state (>2 hours)');
      backfillStatus.running = false;
      backfillStatus.progress = null;
    } else {
      return res.status(409).json({
        error: 'Backfill already in progress',
        progress: backfillStatus.progress,
        startedAt: backfillStatus.startedAt ? new Date(backfillStatus.startedAt).toISOString() : null
      });
    }
  }

  const auth = getPromoStandardsAuth();
  if (!validateAuth(auth)) {
    return res.status(500).json({ error: 'SanMar credentials not configured' });
  }

  const daysBack = parseInt(req.query.days) || 60;

  // Return immediately — work runs in background
  res.status(202).json({
    message: 'Backfill started in background',
    daysBack,
    startedAt: new Date().toISOString(),
    checkProgressAt: '/api/sanmar-orders/backfill-status'
  });

  // Run in background (no await)
  runBackfillBackground(daysBack);
});

// ── Helper: Build SanMar standard invoice SOAP body ──
function buildInvoiceRequest(methodName, methodBody) {
  const auth = getStandardAuth();
  return `<web:${methodName} xmlns:web="${STANDARD_NS}">
      <web:CustomerNo>${xmlEscape(auth.customerNumber)}</web:CustomerNo>
      <web:UserName>${xmlEscape(auth.username)}</web:UserName>
      <web:Password>${xmlEscape(auth.password)}</web:Password>
      ${methodBody}
    </web:${methodName}>`;
}

// ── Helper: Discover PO numbers from invoices (for orders older than 30 days) ──
async function discoverPOsFromInvoices(daysBack) {
  const pos = new Set();
  const endDate = new Date();
  const startDate = new Date();
  startDate.setDate(startDate.getDate() - daysBack);

  // Walk 30-day windows
  let windowStart = new Date(startDate);
  while (windowStart < endDate) {
    const windowEnd = new Date(Math.min(windowStart.getTime() + 30 * 86400000, endDate.getTime()));
    const start = windowStart.toISOString().split('T')[0];
    const end = windowEnd.toISOString().split('T')[0];

    try {
      console.log(`[Backfill] Invoice PO discovery: ${start} to ${end}`);
      const soapBody = buildInvoiceRequest('GetInvoicesByInvoiceDateRange',
        `<web:StartDate>${xmlEscape(start)}</web:StartDate>
         <web:EndDate>${xmlEscape(end)}</web:EndDate>`
      );
      const xml = await makeSoapRequest(ENDPOINTS.standardInvoice, soapBody, {
        timeout: 20000,
        namespaces: { web: STANDARD_NS }
      });
      const soapError = checkSoapError(xml);
      if (!soapError) {
        const invoices = parseInvoiceResponse(xml);
        for (const inv of invoices) {
          if (inv.purchaseOrderNo) pos.add(inv.purchaseOrderNo);
        }
        console.log(`[Backfill] Invoice window ${start}-${end}: ${invoices.length} invoices, ${pos.size} unique POs`);
      }
    } catch (e) {
      console.error(`Invoice PO discovery window ${start}-${end} failed:`, e.message);
    }

    windowStart = new Date(windowEnd);
  }
  return pos;
}

// ── Helper: Fetch a single order by PO number ──
async function fetchOrderByPO(po) {
  try {
    const soapBody = buildOrderStatusRequest('poSearch', {
      referenceNumber: po,
      returnProductDetail: true
    });
    const xml = await makeSoapRequest(ENDPOINTS.orderStatus, soapBody, {
      timeout: 30000,
      namespaces: { ns: NS.orderStatus, shar: NS.orderStatusShared }
    });
    const error = checkSoapError(xml);
    if (error) return null;
    const orders = parseOrderStatusResponse(xml);
    return orders[0] || null;
  } catch (e) {
    return null;
  }
}

// ── Helper: Determine overall status from order details ──
function getOverallStatus(order) {
  const statuses = order.details.map(d => d.status).filter(Boolean);
  return statuses.includes('Shipped') ? 'Shipped'
    : statuses.includes('Partially Shipped') ? 'Partially Shipped'
    : statuses.includes('Confirmed') ? 'Confirmed'
    : statuses.includes('Complete') ? 'Complete'
    : statuses.includes('Canceled') ? 'Canceled'
    : statuses[0] || 'Received';
}

// ── Helper: Upsert a single order + its line items to Caspio ──
async function upsertOrderToCaspio(po, order, matchedBy) {
  const overallStatus = getOverallStatus(order);

  const existing = await makeCaspioRequest('GET',
    `/tables/${TABLES.orders}/records`,
    { 'q.where': `SanMar_PO='${xmlEscape(po)}'` }
  );

  const orderData = {
    SanMar_PO: po,
    ShopWorks_PO: extractPONumber(po) || '',
    SanMar_Sales_Order: order.details[0]?.salesOrderNumber || '',
    SanMar_Status: overallStatus,
    Status_Updated_Date: order.details[0]?.validTimestamp || new Date().toISOString(),
    Last_Sync_Date: new Date().toISOString(),
    Matched_By: matchedBy
  };

  if (Array.isArray(existing) && existing.length > 0) {
    await makeCaspioRequest('PUT', `/tables/${TABLES.orders}/records`,
      { 'q.where': `SanMar_PO='${xmlEscape(po)}'` }, orderData);
  } else {
    await makeCaspioRequest('POST', `/tables/${TABLES.orders}/records`, {}, orderData);
  }

  // Upsert line items
  for (const detail of order.details) {
    for (const product of detail.products) {
      if (!product.productId) continue;
      try {
        const itemWhere = `SanMar_PO='${xmlEscape(po)}' AND Style='${xmlEscape(product.productId)}' AND Part_ID='${xmlEscape(product.partId || '')}'`;
        const existingItem = await makeCaspioRequest('GET',
          `/tables/${TABLES.items}/records`, { 'q.where': itemWhere });
        const itemData = {
          SanMar_PO: po,
          Style: product.productId,
          Part_ID: product.partId || '',
          Qty_Ordered: parseInt(product.qtyOrdered) || 0,
          Qty_Shipped: parseInt(product.qtyShipped) || 0,
          Item_Status: product.status || detail.status || ''
        };
        if (Array.isArray(existingItem) && existingItem.length > 0) {
          await makeCaspioRequest('PUT', `/tables/${TABLES.items}/records`, { 'q.where': itemWhere }, itemData);
        } else {
          await makeCaspioRequest('POST', `/tables/${TABLES.items}/records`, {}, itemData);
        }
      } catch (e) {
        console.error(`Upsert item ${product.productId} for ${po}:`, e.message);
      }
    }
  }
}

// ── Background backfill runner ──
async function runBackfillBackground(daysBack) {
  backfillStatus = {
    running: true,
    startedAt: Date.now(),
    lastRun: new Date().toISOString(),
    lastResult: null,
    progress: { phase: 'starting', openOrders: 0, updatedOrders: 0, invoicePOs: 0, ordersSaved: 0, shipmentsSaved: 0, errors: 0 }
  };

  try {
    // Phase 1: Get all open orders
    backfillStatus.progress.phase = 'fetching allOpen orders';
    console.log('[Backfill] Phase 1: Fetching all open orders...');
    const allOpenBody = buildOrderStatusRequest('allOpen', { returnProductDetail: true });
    const allOpenXml = await makeSoapRequest(ENDPOINTS.orderStatus, allOpenBody, {
      timeout: 60000,
      namespaces: { ns: NS.orderStatus, shar: NS.orderStatusShared }
    });
    const allOpenError = checkSoapError(allOpenXml);
    const openOrders = allOpenError ? [] : parseOrderStatusResponse(allOpenXml);
    backfillStatus.progress.openOrders = openOrders.length;
    console.log(`[Backfill] Phase 1: ${openOrders.length} open orders found`);

    // Phase 2: Get orders updated in last 30 days (SanMar API max)
    const effectiveDays = Math.min(daysBack, 30);
    backfillStatus.progress.phase = `fetching lastUpdate (${effectiveDays} days)`;
    console.log(`[Backfill] Phase 2: Fetching orders updated in last ${effectiveDays} days...`);
    const sinceDate = new Date();
    sinceDate.setDate(sinceDate.getDate() - effectiveDays);
    const sinceTimestamp = sinceDate.toISOString().replace('Z', '');

    const lastUpdateBody = buildOrderStatusRequest('lastUpdate', {
      statusTimeStamp: sinceTimestamp,
      returnProductDetail: true
    });
    const lastUpdateXml = await makeSoapRequest(ENDPOINTS.orderStatus, lastUpdateBody, {
      timeout: 60000,
      namespaces: { ns: NS.orderStatus, shar: NS.orderStatusShared }
    });
    const lastUpdateError = checkSoapError(lastUpdateXml);
    const updatedOrders = (lastUpdateError && lastUpdateError.code !== 160) ? [] : parseOrderStatusResponse(lastUpdateXml);
    backfillStatus.progress.updatedOrders = updatedOrders.length;
    console.log(`[Backfill] Phase 2: ${updatedOrders.length} updated orders found`);

    // Merge (dedupe by PO)
    const allOrders = new Map();
    for (const order of [...openOrders, ...updatedOrders]) {
      if (order.purchaseOrderNumber) {
        allOrders.set(order.purchaseOrderNumber, order);
      }
    }

    // Phase 3: Invoice-based PO discovery for older orders (>30 days)
    if (daysBack > 30) {
      backfillStatus.progress.phase = `discovering POs from invoices (${daysBack} days)`;
      console.log(`[Backfill] Phase 3: Discovering POs from invoices (${daysBack} day window)...`);
      const invoicePOs = await discoverPOsFromInvoices(daysBack);
      let newFromInvoices = 0;

      for (const po of invoicePOs) {
        if (allOrders.has(po)) continue;
        // Rate limit: 1 request per second
        await new Promise(r => setTimeout(r, 1000));
        const order = await fetchOrderByPO(po);
        if (order) {
          allOrders.set(po, order);
          newFromInvoices++;
        }
      }
      backfillStatus.progress.invoicePOs = newFromInvoices;
      console.log(`[Backfill] Phase 3: ${newFromInvoices} additional orders from invoice PO discovery`);
    }

    console.log(`[Backfill] Total unique orders to save: ${allOrders.size}`);

    // Phase 4: Save each order + items to Caspio
    backfillStatus.progress.phase = 'saving orders to Caspio';
    let saved = 0;
    for (const [po, order] of allOrders) {
      try {
        await upsertOrderToCaspio(po, order, 'backfill');
        saved++;
        backfillStatus.progress.ordersSaved = saved;
        if (saved % 10 === 0) {
          console.log(`[Backfill] Phase 4: ${saved}/${allOrders.size} orders saved`);
        }
      } catch (e) {
        backfillStatus.progress.errors++;
        console.error(`[Backfill] Failed PO ${po}:`, e.message);
      }
    }
    console.log(`[Backfill] Phase 4: ${saved} orders saved`);

    // Phase 5: Fetch shipments (7-day windows)
    backfillStatus.progress.phase = 'fetching shipments';
    console.log('[Backfill] Phase 5: Fetching shipments...');
    let totalShipments = 0;
    const shipDays = Math.min(daysBack, 90); // Cap shipment lookback
    const windowDays = 7;
    for (let i = 0; i < shipDays; i += windowDays) {
      const windowStart = new Date();
      windowStart.setDate(windowStart.getDate() - shipDays + i);
      const timestamp = windowStart.toISOString();

      try {
        const shipBody = buildShipmentRequest(3, { shipmentDateTimeStamp: timestamp });
        const shipXml = await makeSoapRequest(ENDPOINTS.shipmentNotification, shipBody, {
          timeout: 30000,
          namespaces: { ns: NS.shipment, shar: NS.shipmentShared }
        });

        const shipError = checkSoapError(shipXml);
        if (!shipError) {
          const shipments = parseShipmentResponse(shipXml);
          for (const shipment of shipments) {
            for (const so of shipment.salesOrders) {
              for (const loc of so.locations) {
                for (const pkg of loc.packages) {
                  if (!pkg.trackingNumber) continue;
                  try {
                    const trackWhere = `SanMar_PO='${xmlEscape(shipment.purchaseOrderNumber)}' AND Tracking_Number='${xmlEscape(pkg.trackingNumber)}'`;
                    const existingTrack = await makeCaspioRequest('GET',
                      `/tables/${TABLES.shipments}/records`, { 'q.where': trackWhere });
                    if (!Array.isArray(existingTrack) || existingTrack.length === 0) {
                      await makeCaspioRequest('POST', `/tables/${TABLES.shipments}/records`, {}, {
                        SanMar_PO: shipment.purchaseOrderNumber,
                        Tracking_Number: pkg.trackingNumber,
                        Carrier: pkg.carrier || '',
                        Ship_Method: pkg.shipmentMethod || '',
                        Ship_Date: pkg.shipmentDate ? pkg.shipmentDate.split('T')[0] : '',
                        Ship_From_Warehouse: loc.shipFrom.city || '',
                        Ship_From_City: loc.shipFrom.city || '',
                        Ship_From_State: loc.shipFrom.region || '',
                        Ship_From_Zip: loc.shipFrom.postalCode || ''
                      });
                      totalShipments++;
                    }
                  } catch (e) { /* may already exist */ }
                }
              }
            }
          }
        }
      } catch (e) {
        console.error(`[Backfill] Shipment window ${i} failed:`, e.message);
      }
      backfillStatus.progress.shipmentsSaved = totalShipments;
    }
    console.log(`[Backfill] Phase 5: ${totalShipments} shipments saved`);

    // Done
    backfillStatus.progress.phase = 'complete';
    backfillStatus.lastResult = {
      success: true,
      ordersSaved: saved,
      shipmentsSaved: totalShipments,
      errors: backfillStatus.progress.errors,
      completedAt: new Date().toISOString()
    };
    console.log('[Backfill] Complete:', JSON.stringify(backfillStatus.lastResult));
  } catch (error) {
    console.error('[Backfill] Fatal error:', error.message);
    backfillStatus.progress.phase = 'failed';
    backfillStatus.lastResult = { success: false, error: error.message, failedAt: new Date().toISOString() };
  } finally {
    backfillStatus.running = false;
  }
}

// ── ManageOrders matching status (in-memory) ──
let moMatchStatus = { running: false, lastRun: null, lastResult: null, progress: null };

// ── GET /match-status — Check ManageOrders matching progress ──
router.get('/match-status', (req, res) => {
  res.json(moMatchStatus);
});

// ── POST /quick-match — Fast Caspio-only matching (no live ManageOrders API) ──
router.post('/quick-match', async (req, res) => {
  const secret = req.headers['x-api-secret'] || req.query.secret;
  if (secret !== process.env.CRM_API_SECRET) {
    return res.status(403).json({ error: 'Unauthorized' });
  }

  try {
    const result = await runQuickMatch();
    res.json({ success: true, ...result });
  } catch (err) {
    console.error('[QuickMatch] Error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── Dynamic PO↔WO offset — self-learning from confirmed matches ──
const DEFAULT_PO_WO_OFFSET = 28856;

async function calculateDynamicOffset() {
  try {
    // Get recent confirmed matches (have both numeric PO and id_Order)
    const confirmed = await fetchAllCaspioPages('/tables/SanMar_Orders/records', {
      'q.where': "id_Order IS NOT NULL AND id_Order<>'' AND Company_Name IS NOT NULL AND Company_Name<>''",
      'q.select': 'SanMar_PO,id_Order',
      'q.orderBy': 'Last_Sync_Date DESC',
      'q.limit': 100
    });

    const offsets = [];
    for (const row of (confirmed || [])) {
      const poNum = parseInt(extractPONumber(row.SanMar_PO));
      const woNum = parseInt(row.id_Order);
      if (poNum > 100000 && woNum > 100000) {
        offsets.push(woNum - poNum);
      }
    }

    if (offsets.length < 5) {
      console.log(`[DynamicOffset] Only ${offsets.length} confirmed matches — using default ${DEFAULT_PO_WO_OFFSET}`);
      return DEFAULT_PO_WO_OFFSET;
    }

    // Use median (resistant to outliers)
    offsets.sort((a, b) => a - b);
    const median = offsets[Math.floor(offsets.length / 2)];
    console.log(`[DynamicOffset] Calculated from ${offsets.length} matches: median=${median}, min=${offsets[0]}, max=${offsets[offsets.length - 1]}`);
    return median;
  } catch (e) {
    console.error(`[DynamicOffset] Failed: ${e.message} — using default ${DEFAULT_PO_WO_OFFSET}`);
    return DEFAULT_PO_WO_OFFSET;
  }
}

async function runQuickMatch() {
  console.log('[QuickMatch] Starting Caspio-only matching...');
  const startTime = Date.now();

  // 0. Calculate dynamic PO↔WO offset from confirmed matches
  const poWoOffset = await calculateDynamicOffset();

  // 1. Get unlinked SanMar orders
  const unlinked = await makeCaspioRequest('GET',
    `/tables/${TABLES.orders}/records`,
    { 'q.where': "(Company_Name='' OR Company_Name IS NULL) AND SanMar_PO IS NOT NULL", 'q.limit': '500' }
  );
  const unlinkedList = Array.isArray(unlinked) ? unlinked : (unlinked?.Result || []);
  console.log(`[QuickMatch] ${unlinkedList.length} unlinked orders`);

  if (unlinkedList.length === 0) {
    return { matched: 0, unmatched: 0, message: 'All orders already linked' };
  }

  // 2. Get all SanMar order items (styles per PO)
  const allItems = await fetchAllCaspioPages(`/tables/${TABLES.items}/records`, {
    'q.limit': 1000, 'q.select': 'SanMar_PO,Style'
  });
  const itemsList = Array.isArray(allItems) ? allItems : [];

  const poStyles = new Map(); // SanMar_PO → Set of styles
  for (const item of itemsList) {
    if (!item.SanMar_PO || !item.Style) continue;
    if (!poStyles.has(item.SanMar_PO)) poStyles.set(item.SanMar_PO, new Set());
    poStyles.get(item.SanMar_PO).add(item.Style.toUpperCase());
  }

  // 2b. Backfill items from SanMar for POs with no items in Caspio
  const posWithoutItems = unlinkedList
    .map(o => o.SanMar_PO)
    .filter(po => po && (!poStyles.has(po) || poStyles.get(po).size === 0));

  if (posWithoutItems.length > 0) {
    console.log(`[QuickMatch] ${posWithoutItems.length} POs missing items — backfilling from SanMar...`);
    let backfilled = 0;

    for (const po of posWithoutItems) {
      try {
        const soapBody = buildOrderStatusRequest('poSearch', {
          referenceNumber: po,
          returnProductDetail: true
        });
        const xml = await makeSoapRequest(ENDPOINTS.orderStatus, soapBody, {
          timeout: 15000,
          namespaces: { ns: NS.orderStatus, shar: NS.orderStatusShared }
        });
        const soapError = checkSoapError(xml);
        if (soapError) continue;

        const orders = parseOrderStatusResponse(xml);
        for (const order of orders) {
          for (const detail of order.details) {
            for (const product of detail.products) {
              if (!product.productId) continue;
              const itemWhere = `SanMar_PO='${xmlEscape(po)}' AND Style='${xmlEscape(product.productId)}' AND Part_ID='${xmlEscape(product.partId || '')}'`;
              const existing = await makeCaspioRequest('GET',
                `/tables/${TABLES.items}/records`, { 'q.where': itemWhere }
              );
              if (Array.isArray(existing) && existing.length > 0) continue;

              await makeCaspioRequest('POST', `/tables/${TABLES.items}/records`, {}, {
                SanMar_PO: po,
                Style: product.productId,
                Part_ID: product.partId || '',
                Qty_Ordered: parseInt(product.qtyOrdered) || 0,
                Qty_Shipped: parseInt(product.qtyShipped) || 0,
                Item_Status: product.status || detail.status || ''
              });

              // Update local map
              if (!poStyles.has(po)) poStyles.set(po, new Set());
              poStyles.get(po).add(product.productId.toUpperCase());
            }
          }
        }
        backfilled++;
      } catch (e) {
        console.error(`[QuickMatch] Item backfill failed for ${po}:`, e.message);
      }
    }
    console.log(`[QuickMatch] Backfilled items for ${backfilled}/${posWithoutItems.length} POs`);
  }

  // 3. Build style→order index from ManageOrders_LineItems + ManageOrders_Orders (Caspio tables)
  // Get all recent ManageOrders
  const moOrders = await fetchAllCaspioPages('/tables/ManageOrders_Orders/records', {
    'q.select': 'id_Order,id_Customer,CustomerName,CustomerServiceRep,date_Ordered',
    'q.limit': 1000
  });
  const orderMap = new Map(); // id_Order → order object
  for (const o of (moOrders || [])) {
    if (o.id_Order) orderMap.set(String(o.id_Order), o);
  }

  // Get line items and build style→order index
  // NOTE: q.limit must be ≤1000 (Caspio max page size) for pagination to work correctly
  const moLineItems = await fetchAllCaspioPages('/tables/ManageOrders_LineItems/records', {
    'q.select': 'id_Order,PartNumber',
    'q.limit': 1000
  });

  const styleToOrders = new Map(); // style → Set of id_Order
  for (const li of (moLineItems || [])) {
    const pn = (li.PartNumber || '').toUpperCase();
    if (!pn || FEE_PARTS.has(pn)) continue;
    const baseStyle = pn.replace(/_(OSFA|S\/M|L\/XL|ONE SIZE)$/i, '').replace(/_\d?[xXsSmMlL]+$/i, '').replace(/_\d+$/, '');
    if (!baseStyle || !li.id_Order) continue;

    if (!styleToOrders.has(baseStyle)) styleToOrders.set(baseStyle, new Set());
    styleToOrders.get(baseStyle).add(String(li.id_Order));
  }

  console.log(`[QuickMatch] Built index: ${orderMap.size} MO orders, ${styleToOrders.size} styles`);

  // 4. Match each unlinked order by style overlap
  let matched = 0, unmatched = 0;

  for (const sanmarOrder of unlinkedList) {
    const po = sanmarOrder.SanMar_PO;
    const styles = poStyles.get(po);
    if (!styles || styles.size === 0) { unmatched++; continue; }

    // Score candidates
    const scores = new Map(); // id_Order → score
    for (const style of styles) {
      const orderIds = styleToOrders.get(style);
      if (!orderIds) continue;
      for (const oid of orderIds) {
        scores.set(oid, (scores.get(oid) || 0) + 1);
      }
    }

    // Find best match — use PO↔WO number correlation as tiebreaker
    // SanMar PO numbers correlate with ShopWorks order numbers: WO ≈ PO + ~28856
    // This is far more reliable than date-based matching for repeat customers
    const poNum = parseInt(extractPONumber(po)) || 0;
    const expectedWO = poNum + poWoOffset; // Dynamic offset from confirmed matches
    let bestId = null, bestScore = 0, bestProximity = Infinity;
    for (const [oid, score] of scores) {
      const proximity = Math.abs(parseInt(oid) - expectedWO);
      if (score > bestScore || (score === bestScore && proximity < bestProximity)) {
        bestScore = score;
        bestId = oid;
        bestProximity = proximity;
      }
    }

    // Require 50%+ style overlap to avoid false positives (e.g., 1/3 match)
    const minScore = styles.size > 1 ? Math.ceil(styles.size / 2) : 1;
    if (bestId && bestScore >= minScore) {
      const mo = orderMap.get(bestId);
      if (mo) {
        try {
          await makeCaspioRequest('PUT', `/tables/${TABLES.orders}/records`,
            { 'q.where': `SanMar_PO='${xmlEscape(po)}'` },
            {
              Company_Name: (mo.CustomerName || '').trim(),
              Sales_Rep: mo.CustomerServiceRep || '',
              id_Customer: mo.id_Customer || 0,
              id_Order: bestId,
              Matched_By: `auto-quick-match (score:${bestScore})`
            }
          );
          matched++;
          if (matched % 10 === 0) console.log(`[QuickMatch] Matched ${matched} so far...`);
        } catch (e) {
          console.error(`[QuickMatch] Failed to update ${po}:`, e.message);
        }
      }
    } else {
      unmatched++;
    }
  }

  // 5. Live API fallback — for still-unmatched orders, fetch MO line items from live API
  if (unmatched > 0) {
    const unmatchedWithStyles = unlinkedList.filter(o => {
      const styles = poStyles.get(o.SanMar_PO);
      return styles && styles.size > 0 && !styleToOrders.has([...styles][0]);
    }).slice(0, 30); // Cap at 30 to limit API calls

    if (unmatchedWithStyles.length > 0) {
      console.log(`[QuickMatch] ${unmatchedWithStyles.length} orders unmatched — trying live ManageOrders API...`);
      try {
        const { fetchLineItems } = require('../utils/manageorders');

        // Find MO orders missing line items in Caspio — newest first
        const moIdsWithItems = new Set((moLineItems || []).map(li => String(li.id_Order)));
        const moOrdersMissingItems = [...orderMap.values()]
          .filter(o => !moIdsWithItems.has(String(o.id_Order)))
          .sort((a, b) => (b.id_Order || 0) - (a.id_Order || 0)) // Recent orders first
          .slice(0, 500); // Cap API calls — needs to reach far enough for older unmatched orders

        console.log(`[QuickMatch] ${moOrdersMissingItems.length} MO orders missing line items — fetching from API...`);

        // Fetch line items and extend style index
        let fetched = 0;
        for (const mo of moOrdersMissingItems) {
          try {
            const lineItems = await fetchLineItems(mo.id_Order);
            if (!lineItems || lineItems.length === 0) continue;

            for (const li of lineItems) {
              const pn = (li.PartNumber || '').toUpperCase();
              if (!pn || FEE_PARTS.has(pn)) continue;
              const baseStyle = pn.replace(/_(OSFA|S\/M|L\/XL|ONE SIZE)$/i, '').replace(/_\d?[xXsSmMlL]+$/i, '').replace(/_\d+$/, '');
              if (!baseStyle) continue;
              if (!styleToOrders.has(baseStyle)) styleToOrders.set(baseStyle, new Set());
              styleToOrders.get(baseStyle).add(String(mo.id_Order));
            }
            fetched++;
          } catch (e) { /* skip failed fetches */ }
        }
        console.log(`[QuickMatch] Fetched line items for ${fetched} MO orders, style index now ${styleToOrders.size} styles`);

        // Re-run matching for unmatched orders
        let liveMatched = 0;
        for (const sanmarOrder of unmatchedWithStyles) {
          const po = sanmarOrder.SanMar_PO;
          const styles = poStyles.get(po);
          if (!styles) continue;

          const scores = new Map();
          for (const style of styles) {
            const orderIds = styleToOrders.get(style);
            if (!orderIds) continue;
            for (const oid of orderIds) {
              scores.set(oid, (scores.get(oid) || 0) + 1);
            }
          }

          const livePoNum = parseInt(extractPONumber(po)) || 0;
          const liveExpectedWO = livePoNum + poWoOffset;
          let bestId = null, bestScore = 0, bestProx = Infinity;
          for (const [oid, score] of scores) {
            const prox = Math.abs(parseInt(oid) - liveExpectedWO);
            if (score > bestScore || (score === bestScore && prox < bestProx)) {
              bestScore = score; bestId = oid; bestProx = prox;
            }
          }

          const minScore = styles.size > 1 ? Math.ceil(styles.size / 2) : 1;
          if (bestId && bestScore >= minScore) {
            const mo = orderMap.get(bestId);
            if (mo) {
              try {
                await makeCaspioRequest('PUT', `/tables/${TABLES.orders}/records`,
                  { 'q.where': `SanMar_PO='${xmlEscape(po)}'` },
                  {
                    Company_Name: (mo.CustomerName || '').trim(),
                    Sales_Rep: mo.CustomerServiceRep || '',
                    id_Customer: mo.id_Customer || 0,
                    id_Order: bestId,
                    Matched_By: `auto-live-match (score:${bestScore})`
                  }
                );
                matched++;
                liveMatched++;
                unmatched--;
              } catch (e) {
                console.error(`[QuickMatch] Live match update failed for ${po}:`, e.message);
              }
            }
          }
        }
        if (liveMatched > 0) console.log(`[QuickMatch] Live API matched ${liveMatched} additional orders`);
      } catch (e) {
        console.error(`[QuickMatch] Live API fallback error:`, e.message);
      }
    }
  }

  const elapsed = Math.round((Date.now() - startTime) / 1000);
  console.log(`[QuickMatch] Done: ${matched} matched, ${unmatched} unmatched in ${elapsed}s`);

  // Debug: show why matches failed
  const debugMatches = [];
  for (const sanmarOrder of unlinkedList.slice(0, 5)) {
    const po = sanmarOrder.SanMar_PO;
    const styles = poStyles.get(po);
    const entry = { po, styles: styles ? [...styles] : 'NO_ITEMS', candidates: [] };

    if (styles) {
      for (const style of styles) {
        const moOrderIds = styleToOrders.get(style);
        entry.candidates.push({
          style,
          foundInMO: !!moOrderIds,
          moOrderCount: moOrderIds ? moOrderIds.size : 0
        });
      }
    }
    debugMatches.push(entry);
  }

  // Sample MO styles for comparison
  const sampleMOStyles = [...styleToOrders.keys()].slice(0, 20);

  return {
    matched, unmatched, elapsed, totalProcessed: unlinkedList.length,
    debug: {
      sanmarOrderItemsCount: itemsList.length,
      poStylesMapSize: poStyles.size,
      moOrdersCount: orderMap.size,
      moLineItemsCount: (moLineItems || []).length,
      moStyleIndexSize: styleToOrders.size,
      sampleMOStyles,
      debugMatches
    }
  };
}

// ── POST /match-manageorders — Match SanMar orders to ManageOrders by style ──
// Fire-and-forget: returns 202, runs in background, poll /match-status
router.post('/match-manageorders', async (req, res) => {
  const secret = req.headers['x-api-secret'] || req.query.secret;
  if (secret !== process.env.CRM_API_SECRET) {
    return res.status(403).json({ error: 'Unauthorized' });
  }

  if (moMatchStatus.running) {
    return res.status(409).json({ error: 'Match already running', progress: moMatchStatus.progress });
  }

  res.status(202).json({
    message: 'ManageOrders matching started in background',
    checkProgressAt: '/api/sanmar-orders/match-status'
  });

  runManageOrdersMatch();
});

// Known non-SanMar part numbers to skip during matching
const FEE_PARTS = new Set(['ART', 'GRT-50', 'GRT-75', 'LTM', 'SETUP', 'DIGITIZE', 'RUSH',
  'SHIPPING', 'TAX', 'DISCOUNT', 'ARTWORK', 'SCREEN', 'FILM', 'TRANSFER']);

async function runManageOrdersMatch() {
  moMatchStatus = {
    running: true,
    lastRun: new Date().toISOString(),
    lastResult: null,
    progress: { phase: 'starting', moOrdersIndexed: 0, matched: 0, unmatched: 0, errors: 0 }
  };

  try {
    const { fetchOrders, fetchLineItems } = require('../utils/manageorders');

    // 0. Calculate dynamic PO↔WO offset
    const poWoOffset = await calculateDynamicOffset();

    // 1. Get SanMar orders missing Company_Name
    moMatchStatus.progress.phase = 'fetching unlinked SanMar orders';
    const sanmarOrders = await makeCaspioRequest('GET',
      `/tables/${TABLES.orders}/records`,
      { 'q.where': "(Company_Name='' OR Company_Name IS NULL) AND SanMar_PO IS NOT NULL", 'q.limit': '1000' }
    );
    const unlinked = Array.isArray(sanmarOrders) ? sanmarOrders : (sanmarOrders?.Result || []);
    console.log(`[MO Match] ${unlinked.length} SanMar orders need linking`);

    if (unlinked.length === 0) {
      moMatchStatus.lastResult = { success: true, matched: 0, message: 'All orders already linked' };
      moMatchStatus.running = false;
      return;
    }

    // 2. Get SanMar order items (styles) for matching — paginate to get ALL items
    moMatchStatus.progress.phase = 'fetching SanMar order items';
    const itemsList = await fetchAllCaspioPages(`/tables/${TABLES.items}/records`, {
      'q.limit': 1000
    }) || [];

    // Build map: SanMar_PO → Set of styles
    const poStyles = new Map();
    for (const item of itemsList) {
      if (!item.SanMar_PO || !item.Style) continue;
      if (!poStyles.has(item.SanMar_PO)) poStyles.set(item.SanMar_PO, new Set());
      poStyles.get(item.SanMar_PO).add(item.Style.toUpperCase());
    }

    // 3. Fetch ALL ManageOrders orders (last 90 days)
    moMatchStatus.progress.phase = 'fetching ManageOrders orders';
    const endDate = new Date().toISOString().split('T')[0];
    const startDate = new Date(Date.now() - 90 * 86400000).toISOString().split('T')[0];
    console.log(`[MO Match] Fetching ManageOrders orders ${startDate} to ${endDate}...`);

    const moOrders = await fetchOrders({
      date_Ordered_start: startDate,
      date_Ordered_end: endDate
    });
    console.log(`[MO Match] Got ${moOrders.length} ManageOrders orders`);

    // 4. Build reverse index: style → [MO orders] by fetching ALL line items
    // This is the key step — we index EVERY MO order's line items
    moMatchStatus.progress.phase = `indexing line items for ${moOrders.length} ManageOrders orders`;
    const styleToOrders = new Map(); // style → [{ order, orderId }]
    let indexed = 0;

    for (const moOrder of moOrders) {
      const orderId = moOrder.id_Order;
      if (!orderId) continue;

      try {
        const lineItems = await fetchLineItems(orderId);
        if (!lineItems || lineItems.length === 0) continue;

        for (const li of lineItems) {
          const pn = (li.PartNumber || '').toUpperCase();
          if (!pn || FEE_PARTS.has(pn)) continue;
          const baseStyle = pn.replace(/_(OSFA|S\/M|L\/XL|ONE SIZE)$/i, '').replace(/_\d?[xXsSmMlL]+$/i, '').replace(/_\d+$/, '');
          if (!baseStyle) continue;

          if (!styleToOrders.has(baseStyle)) styleToOrders.set(baseStyle, []);
          // Avoid duplicates — same order might have multiple sizes of same style
          const existing = styleToOrders.get(baseStyle);
          if (!existing.some(e => e.orderId === orderId)) {
            existing.push({ orderId, order: moOrder });
          }
        }

        indexed++;
        moMatchStatus.progress.moOrdersIndexed = indexed;
        if (indexed % 100 === 0) {
          console.log(`[MO Match] Indexed ${indexed}/${moOrders.length} MO orders, ${styleToOrders.size} unique styles`);
        }
      } catch (e) {
        // Skip failed line item fetches
      }
    }
    console.log(`[MO Match] Index complete: ${indexed} orders, ${styleToOrders.size} unique styles`);
    moMatchStatus.progress.phase = 'matching SanMar orders';

    // 5. For each unlinked SanMar order, find best match using the style index
    let matched = 0, unmatched = 0;

    for (const sanmarOrder of unlinked) {
      const po = sanmarOrder.SanMar_PO;
      const sanmarStyles = poStyles.get(po);
      if (!sanmarStyles || sanmarStyles.size === 0) {
        unmatched++;
        moMatchStatus.progress.unmatched = unmatched;
        continue;
      }

      // Score each candidate MO order by style overlap
      const candidateScores = new Map(); // orderId → { order, score }

      for (const style of sanmarStyles) {
        const moMatches = styleToOrders.get(style) || [];
        for (const { orderId, order } of moMatches) {
          if (!candidateScores.has(orderId)) {
            candidateScores.set(orderId, { order, score: 0 });
          }
          candidateScores.get(orderId).score++;
        }
      }

      // Find best match — highest style overlap, PO↔WO number correlation as tiebreaker
      const moPoNum = parseInt(extractPONumber(po)) || 0;
      const moExpectedWO = moPoNum + poWoOffset;
      let bestMatch = null;
      let bestScore = 0;
      let bestProximity = Infinity;
      for (const [orderId, { order, score }] of candidateScores) {
        const proximity = Math.abs(parseInt(orderId) - moExpectedWO);
        if (score > bestScore || (score === bestScore && proximity < bestProximity)) {
          bestScore = score;
          bestMatch = order;
          bestProximity = proximity;
        }
      }

      const minScore = sanmarStyles.size > 1 ? Math.ceil(sanmarStyles.size / 2) : 1;
      if (bestMatch && bestScore >= minScore) {
        try {
          const updateData = {
            Company_Name: (bestMatch.CustomerName || '').trim(),
            Sales_Rep: bestMatch.CustomerServiceRep || '',
            id_Customer: bestMatch.id_Customer || 0,
            Matched_By: `auto-style-match (score:${bestScore})`,
            id_Order: String(bestMatch.id_Order || '')
          };

          await makeCaspioRequest('PUT', `/tables/${TABLES.orders}/records`,
            { 'q.where': `SanMar_PO='${xmlEscape(po)}'` },
            updateData
          );

          console.log(`[MO Match] ${po} → ${updateData.Company_Name} (score:${bestScore})`);
          matched++;
          moMatchStatus.progress.matched = matched;
        } catch (e) {
          console.error(`[MO Match] Failed to update ${po}:`, e.message);
          moMatchStatus.progress.errors++;
        }
      } else {
        unmatched++;
        moMatchStatus.progress.unmatched = unmatched;
      }
    }

    moMatchStatus.lastResult = {
      success: true,
      matched,
      unmatched,
      moOrdersIndexed: indexed,
      uniqueStyles: styleToOrders.size,
      completedAt: new Date().toISOString()
    };
    console.log('[MO Match] Complete:', JSON.stringify(moMatchStatus.lastResult));
  } catch (error) {
    console.error('[MO Match] Fatal error:', error.message);
    moMatchStatus.lastResult = { success: false, error: error.message };
  } finally {
    moMatchStatus.running = false;
  }
}

module.exports = router;
