// ==========================================
// Box Labels Data Routes
// ==========================================
// Provides order info + partId resolution for the Box Labels feature.
// Uses Caspio ManageOrders tables (fast) instead of live ManageOrders API (slow).
//
// Endpoints:
//   GET  /api/box-labels/order-by-po/:po     — Order info by CustomerPurchaseOrder
//   GET  /api/box-labels/order/:orderId       — Order info by id_Order
//   GET  /api/box-labels/lineitems/:orderId   — Line items by order ID
//   POST /api/box-labels/resolve-parts        — Batch resolve partIds to size/color

const express = require('express');
const router = express.Router();
const { fetchAllCaspioPages } = require('../utils/caspio');

// ── GET /order-by-po/:po — Order info from Caspio ManageOrders_Orders ──
router.get('/order-by-po/:po', async (req, res) => {
  const po = req.params.po;

  try {
    const orders = await fetchAllCaspioPages('/tables/ManageOrders_Orders/records', {
      'q.where': `CustomerPurchaseOrder='${po.replace(/'/g, "''")}'`,
      'q.select': 'id_Order,id_Customer,CustomerName,ContactFirstName,ContactLastName,ContactEmail,ContactPhone,CustomerServiceRep,CustomerPurchaseOrder,DesignName,id_Design,Order_Type_Name,TermsName,date_RequestedToShip',
      'q.limit': 5
    });

    let o = orders?.[0] || null;

    // If no match by CustomerPurchaseOrder, try SanMar_Orders table (SanMar PO → id_Order)
    if (!o) {
      console.log(`[BoxLabels] No CustomerPO match for ${po}, checking SanMar_Orders table...`);
      try {
        const sanmarMatch = await fetchAllCaspioPages('/tables/SanMar_Orders/records', {
          'q.where': `SanMar_PO='${po.replace(/'/g, "''")}'`,
          'q.select': 'id_Order,Company_Name,Sales_Rep,id_Customer,ShopWorks_PO',
          'q.limit': 1
        });
        const sm = sanmarMatch?.[0];
        if (sm?.id_Order) {
          console.log(`[BoxLabels] Found SanMar_Orders match: PO ${po} → WO# ${sm.id_Order}`);
          // Now fetch the full order from ManageOrders_Orders using id_Order
          const moOrders = await fetchAllCaspioPages('/tables/ManageOrders_Orders/records', {
            'q.where': `id_Order=${sm.id_Order}`,
            'q.select': 'id_Order,id_Customer,CustomerName,ContactFirstName,ContactLastName,ContactEmail,ContactPhone,CustomerServiceRep,CustomerPurchaseOrder,DesignName,id_Design,Order_Type_Name,TermsName,date_RequestedToShip',
            'q.limit': 1
          });
          o = moOrders?.[0] || null;

          // If ManageOrders doesn't have this order, use what SanMar_Orders has
          if (!o && sm.Company_Name) {
            o = {
              id_Order: sm.id_Order,
              id_Customer: sm.id_Customer,
              CustomerName: sm.Company_Name,
              CustomerServiceRep: sm.Sales_Rep,
              ContactFirstName: '', ContactLastName: '', ContactEmail: '', ContactPhone: '',
              CustomerPurchaseOrder: sm.ShopWorks_PO || po,
              DesignName: '', id_Design: ''
            };
          }
        }
      } catch (e) {
        console.log(`[BoxLabels] SanMar_Orders lookup failed:`, e.message);
      }
    }

    if (!o) {
      return res.json({ success: true, order: null, message: `No order found for PO ${po}` });
    }

    res.json({
      success: true,
      order: {
        orderNumber: o.id_Order,
        customerId: o.id_Customer,
        company: o.CustomerName || '',
        contact: `${o.ContactFirstName || ''} ${o.ContactLastName || ''}`.trim(),
        contactEmail: o.ContactEmail || '',
        contactPhone: o.ContactPhone || '',
        salesRep: o.CustomerServiceRep || '',
        customerPO: o.CustomerPurchaseOrder || po,
        designName: o.DesignName || '',
        designNumber: o.id_Design || '',
        orderType: o.Order_Type_Name || '',
        terms: o.TermsName || '',
        requestedShipDate: o.date_RequestedToShip || ''
      }
    });
  } catch (err) {
    console.error(`[BoxLabels] Order lookup for PO ${po} failed:`, err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── GET /order/:orderId — Order info by id_Order ──
router.get('/order/:orderId', async (req, res) => {
  const orderId = req.params.orderId;

  try {
    const orders = await fetchAllCaspioPages('/tables/ManageOrders_Orders/records', {
      'q.where': `id_Order=${orderId}`,
      'q.select': 'id_Order,id_Customer,CustomerName,ContactFirstName,ContactLastName,ContactEmail,ContactPhone,CustomerServiceRep,CustomerPurchaseOrder,DesignName,id_Design,Order_Type_Name,TermsName,date_RequestedToShip',
      'q.limit': 1
    });

    if (!orders || orders.length === 0) {
      return res.json({ success: true, order: null, message: `No order found for ID ${orderId}` });
    }

    const o = orders[0];
    res.json({
      success: true,
      order: {
        orderNumber: o.id_Order,
        customerId: o.id_Customer,
        company: o.CustomerName || '',
        contact: `${o.ContactFirstName || ''} ${o.ContactLastName || ''}`.trim(),
        contactEmail: o.ContactEmail || '',
        contactPhone: o.ContactPhone || '',
        salesRep: o.CustomerServiceRep || '',
        customerPO: o.CustomerPurchaseOrder || '',
        designName: o.DesignName || '',
        designNumber: o.id_Design || ''
      }
    });
  } catch (err) {
    console.error(`[BoxLabels] Order lookup for ID ${orderId} failed:`, err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── GET /lineitems/:orderId — Line items from ManageOrders_LineItems ──
router.get('/lineitems/:orderId', async (req, res) => {
  const orderId = req.params.orderId;

  try {
    const items = await fetchAllCaspioPages('/tables/ManageOrders_LineItems/records', {
      'q.where': `id_Order=${orderId}`,
      'q.limit': 200
    });

    res.json({ success: true, lineItems: items || [] });
  } catch (err) {
    console.error(`[BoxLabels] Line items lookup for order ${orderId} failed:`, err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── POST /resolve-parts — Batch resolve partIds to size/color via Caspio bulk table ──
// UNIQUE_KEY in Sanmar_Bulk_251816_Feb2024 = supplierPartId from SanMar shipment API
// Single Caspio query, <1 second, no SOAP calls needed
router.post('/resolve-parts', async (req, res) => {
  const { partIds = [] } = req.body;

  if (!partIds.length) {
    return res.json({ success: true, partMap: {}, totalResolved: 0 });
  }

  try {
    // Sanitize partIds to integers only (prevent injection)
    const safeIds = partIds.map(id => parseInt(id, 10)).filter(id => !isNaN(id) && id > 0);
    if (!safeIds.length) {
      return res.json({ success: true, partMap: {}, totalResolved: 0 });
    }

    console.log(`[BoxLabels] Resolving ${safeIds.length} partIds via Caspio UNIQUE_KEY`);
    const startTime = Date.now();

    // Single Caspio query — UNIQUE_KEY is the supplierPartId
    const whereClause = `UNIQUE_KEY IN (${safeIds.join(',')})`;
    const records = await fetchAllCaspioPages('/tables/Sanmar_Bulk_251816_Feb2024/records', {
      'q.where': whereClause,
      'q.select': 'UNIQUE_KEY,STYLE,COLOR_NAME,SIZE,PRODUCT_TITLE,BRAND_NAME',
      'q.limit': 200
    });

    const partMap = {};
    for (const r of (records || [])) {
      // Clean description: remove trailing ". STYLE" (e.g., "Polo. CS412" → "Polo")
      let desc = r.PRODUCT_TITLE || '';
      const style = r.STYLE || '';
      if (style && desc.endsWith(`. ${style}`)) {
        desc = desc.slice(0, -(style.length + 2));
      }
      if (style && desc.endsWith(` ${style}`)) {
        desc = desc.slice(0, -(style.length + 1));
      }

      partMap[String(r.UNIQUE_KEY)] = {
        size: r.SIZE || '',
        color: r.COLOR_NAME || '',
        style,
        description: desc,
        brand: r.BRAND_NAME || ''
      };
    }

    const elapsed = Date.now() - startTime;
    console.log(`[BoxLabels] Resolved ${Object.keys(partMap).length}/${safeIds.length} partIds in ${elapsed}ms`);

    res.json({ success: true, partMap, totalResolved: Object.keys(partMap).length });
  } catch (err) {
    console.error(`[BoxLabels] Part resolution failed:`, err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
