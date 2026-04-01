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

    if (Array.isArray(existing) && existing.length > 0) {
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

                      if (!Array.isArray(existingTrack) || existingTrack.length === 0) {
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

async function runQuickMatch() {
  console.log('[QuickMatch] Starting Caspio-only matching...');
  const startTime = Date.now();

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
    'q.select': 'id_Order,id_Customer,CustomerName,CustomerServiceRep',
    'q.limit': 1000
  });
  const orderMap = new Map(); // id_Order → order object
  for (const o of (moOrders || [])) {
    if (o.id_Order) orderMap.set(String(o.id_Order), o);
  }

  // Get line items and build style→order index
  const moLineItems = await fetchAllCaspioPages('/tables/ManageOrders_LineItems/records', {
    'q.select': 'id_Order,PartNumber',
    'q.limit': 5000
  });

  const styleToOrders = new Map(); // style → Set of id_Order
  for (const li of (moLineItems || [])) {
    const pn = (li.PartNumber || '').toUpperCase();
    if (!pn || FEE_PARTS.has(pn)) continue;
    const baseStyle = pn.replace(/_\d?[xXsSmMlL]+$/i, '').replace(/_\d+$/, '');
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

    // Find best match
    let bestId = null, bestScore = 0;
    for (const [oid, score] of scores) {
      if (score > bestScore) { bestScore = score; bestId = oid; }
    }

    if (bestId && bestScore >= 1) {
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

        // Find MO orders missing line items in Caspio
        const moIdsWithItems = new Set((moLineItems || []).map(li => String(li.id_Order)));
        const moOrdersMissingItems = [...orderMap.values()]
          .filter(o => !moIdsWithItems.has(String(o.id_Order)))
          .slice(0, 200); // Cap API calls

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
              const baseStyle = pn.replace(/_\d?[xXsSmMlL]+$/i, '').replace(/_\d+$/, '');
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

          let bestId = null, bestScore = 0;
          for (const [oid, score] of scores) {
            if (score > bestScore) { bestScore = score; bestId = oid; }
          }

          if (bestId && bestScore >= 1) {
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

    // 1. Get SanMar orders missing Company_Name
    moMatchStatus.progress.phase = 'fetching unlinked SanMar orders';
    const sanmarOrders = await makeCaspioRequest('GET',
      `/tables/${TABLES.orders}/records`,
      { 'q.where': "Company_Name='' OR Company_Name IS NULL", 'q.limit': '1000' }
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
          const baseStyle = pn.replace(/_\d?[xXsSmMlL]+$/i, '').replace(/_\d+$/, '');
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

      // Find best match (highest style overlap)
      let bestMatch = null;
      let bestScore = 0;
      for (const [orderId, { order, score }] of candidateScores) {
        if (score > bestScore) {
          bestScore = score;
          bestMatch = order;
        }
      }

      if (bestMatch && bestScore >= 1) {
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
