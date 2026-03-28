// ==========================================
// SanMar Order Status & Shipment Routes
// ==========================================
// Provides order tracking, shipment notifications, and Caspio archival
// for the SanMar Order Lookup feature on the Staff Dashboard.
//
// Endpoints:
//   GET  /api/sanmar-orders/open         — All open SanMar orders (cached)
//   GET  /api/sanmar-orders/status/:po   — Single PO status
//   GET  /api/sanmar-orders/shipments/:po — Tracking/shipment details for a PO
//   GET  /api/sanmar-orders/lookup       — Search by order#, company, rep, style
//   POST /api/sanmar-orders/link         — Save ShopWorks↔SanMar PO mapping
//   POST /api/sanmar-orders/sync         — Daily sync (Heroku Scheduler)
//   POST /api/sanmar-orders/backfill     — One-time 60-day backfill

const express = require('express');
const router = express.Router();
const NodeCache = require('node-cache');
const {
  ENDPOINTS, NS,
  getPromoStandardsAuth, validateAuth, xmlEscape,
  makeSoapRequest, checkSoapError,
  buildOrderStatusRequest, buildShipmentRequest,
  parseOrderStatusResponse, parseShipmentResponse
} = require('../utils/sanmar-soap');
const { makeCaspioRequest } = require('../utils/caspio');

// Cache: 15 min for allOpen (SanMar recommends max 3x/day)
const orderCache = new NodeCache({ stdTTL: 900, checkperiod: 120 });

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
  const { orderNo, company, rep, style, po } = req.query;

  if (!orderNo && !company && !rep && !style && !po) {
    return res.status(400).json({ error: 'Provide at least one search parameter: orderNo, company, rep, style, or po' });
  }

  try {
    // Build Caspio WHERE clause
    const conditions = [];
    if (po) conditions.push(`SanMar_PO='${xmlEscape(po)}'`);
    if (orderNo) conditions.push(`ShopWorks_PO='${xmlEscape(orderNo)}'`);
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
        if (caspioResult && caspioResult.Result) {
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

    if (existing && existing.Result && existing.Result.length > 0) {
      // Update existing
      await makeCaspioRequest('PUT',
        `/tables/${TABLES.orders}/records`,
        { 'q.where': `SanMar_PO='${xmlEscape(sanmarPO)}'` },
        { ShopWorks_PO: shopworksOrderNo, Company_Name: companyName, Sales_Rep: salesRep }
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

      // Upsert order record
      const orderData = {
        SanMar_PO: po,
        ShopWorks_PO: shopworksPO || '',
        SanMar_Sales_Order: salesOrderNum,
        SanMar_Status: overallStatus,
        Status_Updated_Date: validTimestamp || new Date().toISOString(),
        Last_Sync_Date: new Date().toISOString()
      };

      try {
        const existing = await makeCaspioRequest('GET',
          `/tables/${TABLES.orders}/records`,
          { 'q.where': `SanMar_PO='${xmlEscape(po)}'` }
        );

        if (existing && existing.Result && existing.Result.length > 0) {
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

            if (existingItem && existingItem.Result && existingItem.Result.length > 0) {
              await makeCaspioRequest('PUT', `/tables/${TABLES.items}/records`, { 'q.where': itemWhere }, itemData);
            } else {
              await makeCaspioRequest('POST', `/tables/${TABLES.items}/records`, {}, itemData);
            }
          } catch (e) {
            console.error(`Failed to upsert item ${product.productId} for ${po}:`, e.message);
          }
        }
      }

      // Fetch shipments for open orders
      if (!['Complete', 'Canceled'].includes(overallStatus)) {
        try {
          const shipSoapBody = buildShipmentRequest(1, { referenceNumber: po });
          const shipXml = await makeSoapRequest(ENDPOINTS.shipmentNotification, shipSoapBody, {
            timeout: 30000,
            namespaces: { ns: NS.shipment, shar: NS.shipmentShared }
          });

          const shipError = checkSoapError(shipXml);
          if (!shipError) {
            const shipData = parseShipmentResponse(shipXml);
            for (const shipment of shipData) {
              for (const so of shipment.salesOrders) {
                for (const loc of so.locations) {
                  for (const pkg of loc.packages) {
                    if (!pkg.trackingNumber) continue;
                    try {
                      const trackWhere = `SanMar_PO='${xmlEscape(po)}' AND Tracking_Number='${xmlEscape(pkg.trackingNumber)}'`;
                      const existingTrack = await makeCaspioRequest('GET',
                        `/tables/${TABLES.shipments}/records`,
                        { 'q.where': trackWhere }
                      );

                      const trackData = {
                        SanMar_PO: po,
                        Tracking_Number: pkg.trackingNumber,
                        Carrier: pkg.carrier || '',
                        Ship_Method: pkg.shipmentMethod || '',
                        Ship_Date: pkg.shipmentDate ? pkg.shipmentDate.split('T')[0] : '',
                        Ship_From_Warehouse: loc.shipFrom.city || '',
                        Ship_From_City: loc.shipFrom.city || '',
                        Ship_From_State: loc.shipFrom.region || '',
                        Ship_From_Zip: loc.shipFrom.postalCode || ''
                      };

                      if (!existingTrack || !existingTrack.Result || existingTrack.Result.length === 0) {
                        await makeCaspioRequest('POST', `/tables/${TABLES.shipments}/records`, {}, trackData);
                        shipmentsUpdated++;
                      }
                    } catch (e) {
                      console.error(`Failed to save tracking ${pkg.trackingNumber}:`, e.message);
                    }
                  }
                }
              }
            }
          }
        } catch (e) {
          console.error(`Failed to fetch shipments for ${po}:`, e.message);
        }
      }
    }

    syncLog.ordersUpserted = upserted;
    syncLog.shipmentsUpdated = shipmentsUpdated;
    syncLog.completed = new Date().toISOString();

    console.log('SanMar sync completed:', JSON.stringify(syncLog));
    res.json(syncLog);
  } catch (error) {
    console.error('SanMar sync failed:', error.message);
    res.status(500).json({ error: 'Sync failed', details: error.message });
  }
});

// ── POST /backfill — One-time 60-day backfill ──
router.post('/backfill', async (req, res) => {
  const secret = req.headers['x-api-secret'] || req.query.secret;
  if (secret !== process.env.CRM_API_SECRET) {
    return res.status(403).json({ error: 'Unauthorized' });
  }

  const daysBack = parseInt(req.query.days) || 60;
  const backfillLog = { started: new Date().toISOString(), daysBack };

  try {
    const auth = getPromoStandardsAuth();
    if (!validateAuth(auth)) {
      return res.status(500).json({ error: 'SanMar credentials not configured' });
    }

    // Step 1: Get all open orders
    const allOpenBody = buildOrderStatusRequest('allOpen', { returnProductDetail: true });
    const allOpenXml = await makeSoapRequest(ENDPOINTS.orderStatus, allOpenBody, {
      timeout: 60000,
      namespaces: { ns: NS.orderStatus, shar: NS.orderStatusShared }
    });
    const allOpenError = checkSoapError(allOpenXml);
    const openOrders = allOpenError ? [] : parseOrderStatusResponse(allOpenXml);
    backfillLog.openOrders = openOrders.length;

    // Step 2: Get orders updated in last N days
    const sinceDate = new Date();
    sinceDate.setDate(sinceDate.getDate() - daysBack);
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
    const updatedOrders = lastUpdateError ? [] : parseOrderStatusResponse(lastUpdateXml);
    backfillLog.updatedOrders = updatedOrders.length;

    // Merge (dedupe by PO)
    const allOrders = new Map();
    for (const order of [...openOrders, ...updatedOrders]) {
      if (order.purchaseOrderNumber) {
        allOrders.set(order.purchaseOrderNumber, order);
      }
    }
    backfillLog.totalUniqueOrders = allOrders.size;

    // Step 3: Save each order + items to Caspio (reuse sync logic)
    let saved = 0;
    for (const [po, order] of allOrders) {
      const statuses = order.details.map(d => d.status).filter(Boolean);
      const overallStatus = statuses.includes('Shipped') ? 'Shipped'
        : statuses.includes('Partially Shipped') ? 'Partially Shipped'
        : statuses.includes('Confirmed') ? 'Confirmed'
        : statuses.includes('Complete') ? 'Complete'
        : statuses.includes('Canceled') ? 'Canceled'
        : statuses[0] || 'Received';

      try {
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
          Matched_By: 'backfill'
        };

        if (!existing || !existing.Result || existing.Result.length === 0) {
          await makeCaspioRequest('POST', `/tables/${TABLES.orders}/records`, {}, orderData);
        } else {
          await makeCaspioRequest('PUT', `/tables/${TABLES.orders}/records`,
            { 'q.where': `SanMar_PO='${xmlEscape(po)}'` }, orderData);
        }

        // Save line items
        for (const detail of order.details) {
          for (const product of detail.products) {
            if (!product.productId) continue;
            try {
              await makeCaspioRequest('POST', `/tables/${TABLES.items}/records`, {}, {
                SanMar_PO: po,
                Style: product.productId,
                Part_ID: product.partId || '',
                Qty_Ordered: parseInt(product.qtyOrdered) || 0,
                Qty_Shipped: parseInt(product.qtyShipped) || 0,
                Item_Status: product.status || detail.status || ''
              });
            } catch (e) { /* may already exist */ }
          }
        }

        saved++;
      } catch (e) {
        console.error(`Backfill failed for PO ${po}:`, e.message);
      }
    }

    // Step 4: Fetch shipments (7-day windows)
    let totalShipments = 0;
    const windowDays = 7;
    for (let i = 0; i < daysBack; i += windowDays) {
      const windowStart = new Date();
      windowStart.setDate(windowStart.getDate() - daysBack + i);
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
                  } catch (e) { /* may already exist */ }
                }
              }
            }
          }
        }
      } catch (e) {
        console.error(`Shipment backfill window ${i} failed:`, e.message);
      }
    }

    backfillLog.ordersSaved = saved;
    backfillLog.shipmentsSaved = totalShipments;
    backfillLog.completed = new Date().toISOString();

    console.log('SanMar backfill completed:', JSON.stringify(backfillLog));
    res.json(backfillLog);
  } catch (error) {
    console.error('SanMar backfill failed:', error.message);
    res.status(500).json({ error: 'Backfill failed', details: error.message });
  }
});

module.exports = router;
