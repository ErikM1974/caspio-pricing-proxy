// ==========================================
// SanMar Shipment Notification Routes
// ==========================================
// Provides box-level shipment data from SanMar for the Box Labels feature.
//
// Endpoints:
//   GET  /api/sanmar-shipments/po/:po    — Shipment by PO number
//   GET  /api/sanmar-shipments/so/:so    — Shipment by SanMar Sales Order number
//   GET  /api/sanmar-shipments/by-date   — Shipments by date range

const express = require('express');
const router = express.Router();
const NodeCache = require('node-cache');
const {
  ENDPOINTS, NS,
  getPromoStandardsAuth, validateAuth,
  makeSoapRequest,
  buildShipmentRequest,
  extractAll, extractFirst, extractBlocks
} = require('../utils/sanmar-soap');

const shipmentCache = new NodeCache({ stdTTL: 300, checkperiod: 60 }); // 5 min cache

// ── Helper: Parse shipment notification response ──
function parseShipmentResponse(xml) {
  // Check for errors first
  const errorCode = extractFirst(xml, 'code');
  const errorDesc = extractFirst(xml, 'description');
  if (errorCode && errorCode !== '0' && errorCode !== '110') {
    throw new Error(`SanMar Shipment Error ${errorCode}: ${errorDesc || 'Unknown'}`);
  }

  // Extract sales orders
  const salesOrderBlocks = extractBlocks(xml, 'SalesOrder');
  if (!salesOrderBlocks.length) {
    // Log first 500 chars for debugging
    console.log('[SanMar Shipments] No SalesOrder found. Raw XML preview:', xml.substring(0, 500));
    return { salesOrders: [], boxes: [], totalBoxes: 0 };
  }

  const boxes = [];
  let boxIndex = 0;

  for (const soBlock of salesOrderBlocks) {
    const salesOrderNumber = extractFirst(soBlock, 'salesOrderNumber') || '';
    const complete = extractFirst(soBlock, 'complete') === 'true';

    // Extract shipment locations
    const locationBlocks = extractBlocks(soBlock, 'ShipmentLocation');

    for (const locBlock of locationBlocks) {
      // Extract addresses
      const shipFromBlock = extractBlocks(locBlock, 'shipFromAddress')[0] || '';
      const shipToBlock = extractBlocks(locBlock, 'shipToAddress')[0] || '';

      const shipFrom = shipFromBlock ? {
        address1: extractFirst(shipFromBlock, 'address1') || '',
        city: extractFirst(shipFromBlock, 'city') || '',
        region: extractFirst(shipFromBlock, 'region') || '',
        postalCode: extractFirst(shipFromBlock, 'postalCode') || '',
        country: extractFirst(shipFromBlock, 'country') || ''
      } : null;

      const shipTo = shipToBlock ? {
        address1: extractFirst(shipToBlock, 'address1') || '',
        city: extractFirst(shipToBlock, 'city') || '',
        region: extractFirst(shipToBlock, 'region') || '',
        postalCode: extractFirst(shipToBlock, 'postalCode') || '',
        country: extractFirst(shipToBlock, 'country') || ''
      } : null;

      // Extract packages (each package = one box)
      const packageBlocks = extractBlocks(locBlock, 'Package');

      for (const pkgBlock of packageBlocks) {
        boxIndex++;
        const trackingNumber = extractFirst(pkgBlock, 'trackingNumber') || '';
        const shipmentDate = extractFirst(pkgBlock, 'shipmentDate') || '';
        const carrier = extractFirst(pkgBlock, 'carrier') || '';
        const shippingMethod = extractFirst(pkgBlock, 'shippingMethod') || '';

        // Extract items in this package
        const itemBlocks = extractBlocks(pkgBlock, 'Item');
        const items = itemBlocks.map(itemBlock => ({
          supplierProductId: extractFirst(itemBlock, 'supplierProductId') || '',
          supplierPartId: extractFirst(itemBlock, 'supplierPartId') || '',
          quantity: parseInt(extractFirst(itemBlock, 'quantity') || '0', 10),
          quantityUOM: extractFirst(itemBlock, 'quantityUOM') || 'EA'
        }));

        boxes.push({
          boxNumber: boxIndex,
          salesOrderNumber,
          trackingNumber,
          shipmentDate,
          carrier,
          shippingMethod,
          shipFrom,
          shipTo,
          items
        });
      }
    }
  }

  return {
    salesOrders: salesOrderBlocks.length,
    boxes,
    totalBoxes: boxes.length
  };
}

// ── GET /po/:po — Shipment by Purchase Order ──
router.get('/po/:po', async (req, res) => {
  const po = req.params.po;
  const cacheKey = `sanmar-shipment-po-${po}`;
  const cached = shipmentCache.get(cacheKey);
  if (cached) return res.json({ ...cached, cached: true });

  try {
    const auth = getPromoStandardsAuth();
    if (!validateAuth(auth)) {
      return res.status(500).json({ error: 'SanMar credentials not configured' });
    }

    const soapBody = buildShipmentRequest('1', { referenceNumber: po });
    const xml = await makeSoapRequest(ENDPOINTS.shipmentNotification, soapBody, {
      namespaces: { ns: NS.shipment, shar: NS.shipmentShared }
    });

    const result = parseShipmentResponse(xml);
    const response = { success: true, data: result, purchaseOrder: po };
    shipmentCache.set(cacheKey, response);
    res.json(response);
  } catch (err) {
    console.error(`[SanMar Shipments] PO ${po} error:`, err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── GET /so/:so — Shipment by Sales Order ──
router.get('/so/:so', async (req, res) => {
  const so = req.params.so;
  const cacheKey = `sanmar-shipment-so-${so}`;
  const cached = shipmentCache.get(cacheKey);
  if (cached) return res.json({ ...cached, cached: true });

  try {
    const auth = getPromoStandardsAuth();
    if (!validateAuth(auth)) {
      return res.status(500).json({ error: 'SanMar credentials not configured' });
    }

    const soapBody = buildShipmentRequest('2', { referenceNumber: so });
    const xml = await makeSoapRequest(ENDPOINTS.shipmentNotification, soapBody, {
      namespaces: { ns: NS.shipment, shar: NS.shipmentShared }
    });

    const result = parseShipmentResponse(xml);
    const response = { success: true, data: result, salesOrder: so };
    shipmentCache.set(cacheKey, response);
    res.json(response);
  } catch (err) {
    console.error(`[SanMar Shipments] SO ${so} error:`, err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── GET /by-date — Shipments by date range ──
router.get('/by-date', async (req, res) => {
  const { date } = req.query; // UTC format: YYYY-MM-DDTHH:MM:SSZ

  if (!date) {
    return res.status(400).json({ error: 'Missing required date query parameter (UTC format: YYYY-MM-DDTHH:MM:SSZ)' });
  }

  try {
    const auth = getPromoStandardsAuth();
    if (!validateAuth(auth)) {
      return res.status(500).json({ error: 'SanMar credentials not configured' });
    }

    const soapBody = buildShipmentRequest('3', { shipmentDateTimeStamp: date });
    const xml = await makeSoapRequest(ENDPOINTS.shipmentNotification, soapBody, {
      namespaces: { ns: NS.shipment, shar: NS.shipmentShared }
    });

    const result = parseShipmentResponse(xml);
    res.json({ success: true, data: result, dateFilter: date });
  } catch (err) {
    console.error(`[SanMar Shipments] Date ${date} error:`, err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;