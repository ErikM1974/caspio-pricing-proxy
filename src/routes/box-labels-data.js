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
const NodeCache = require('node-cache');
const { fetchAllCaspioPages } = require('../utils/caspio');
const {
  ENDPOINTS, NS,
  getPromoStandardsAuth, validateAuth,
  makeSoapRequest,
  extractAll, extractFirst, extractBlocks
} = require('../utils/sanmar-soap');

// Cache inventory lookups for 30 minutes (SanMar inventory doesn't change fast)
const inventoryCache = new NodeCache({ stdTTL: 1800, checkperiod: 300 });

// ── GET /order-by-po/:po — Order info from Caspio ManageOrders_Orders ──
router.get('/order-by-po/:po', async (req, res) => {
  const po = req.params.po;

  try {
    const orders = await fetchAllCaspioPages('/tables/ManageOrders_Orders/records', {
      'q.where': `CustomerPurchaseOrder='${po.replace(/'/g, "''")}'`,
      'q.select': 'id_Order,id_Customer,CustomerName,ContactFirstName,ContactLastName,ContactEmail,ContactPhone,CustomerServiceRep,CustomerPurchaseOrder,DesignName,id_Design',
      'q.limit': 5
    });

    if (!orders || orders.length === 0) {
      return res.json({ success: true, order: null, message: `No order found for PO ${po}` });
    }

    // Return the most recent order (first match)
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
        customerPO: o.CustomerPurchaseOrder || po,
        designName: o.DesignName || '',
        designNumber: o.id_Design || ''
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
      'q.select': 'id_Order,id_Customer,CustomerName,ContactFirstName,ContactLastName,ContactEmail,ContactPhone,CustomerServiceRep,CustomerPurchaseOrder,DesignName,id_Design',
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

// ── POST /resolve-parts — Batch resolve partIds to size/color via SanMar inventory ──
router.post('/resolve-parts', async (req, res) => {
  const { partIds = [], styles = [] } = req.body;

  if (!styles.length) {
    return res.status(400).json({ success: false, error: 'styles array required' });
  }

  try {
    const partIdMap = {}; // { partId: { size, color, style } }

    // For each unique style, fetch inventory (cached)
    const uniqueStyles = [...new Set(styles)];
    console.log(`[BoxLabels] Resolving parts for ${uniqueStyles.length} styles: ${uniqueStyles.join(', ')}`);

    await Promise.allSettled(uniqueStyles.map(async (style) => {
      const cacheKey = `inv-parts-${style}`;
      let inventory = inventoryCache.get(cacheKey);

      if (!inventory) {
        // Call SanMar inventory SOAP API
        try {
          const auth = getPromoStandardsAuth();
          if (!validateAuth(auth)) return;

          const soapBody = `<ns:GetFilteredInventoryLevelsRequest xmlns:ns="http://www.promostandards.org/WSDL/Inventory/2.0.0/"
            xmlns:shar="http://www.promostandards.org/WSDL/Inventory/2.0.0/SharedObjects/">
            <shar:wsVersion>2.0.0</shar:wsVersion>
            <shar:id>${auth.id}</shar:id>
            <shar:password>${auth.password}</shar:password>
            <shar:productId>${style}</shar:productId>
          </ns:GetFilteredInventoryLevelsRequest>`;

          const xml = await makeSoapRequest(ENDPOINTS.inventory, soapBody, {
            timeout: 15000,
            namespaces: {
              ns: 'http://www.promostandards.org/WSDL/Inventory/2.0.0/',
              shar: 'http://www.promostandards.org/WSDL/Inventory/2.0.0/SharedObjects/'
            }
          });

          // Parse inventory response to extract partId → size/color
          inventory = [];
          const partBlocks = extractBlocks(xml, 'PartInventory');
          for (const block of partBlocks) {
            const partId = extractFirst(block, 'partId');
            const color = extractFirst(block, 'partColor') || extractFirst(block, 'labelSize') || '';
            const size = extractFirst(block, 'labelSize') || '';

            // SanMar inventory returns partColor and labelSize in PartInventory
            if (partId) {
              inventory.push({ partId, color, size });
            }
          }

          // If PartInventory parsing didn't get size/color, try the product-level parsing
          if (inventory.length === 0 || !inventory[0].size) {
            // Fallback: use the /api/sanmar/inventory/:style endpoint on this same server
            // which already parses the response correctly
            const https = require('https');
            const selfUrl = `https://${req.headers.host}/api/sanmar/inventory/${style}`;
            const selfResp = await fetch(selfUrl, { timeout: 12000 });
            if (selfResp.ok) {
              const selfData = await selfResp.json();
              inventory = (selfData.inventory || []).map(inv => ({
                partId: inv.partId,
                color: inv.color || '',
                size: inv.size || ''
              }));
            }
          }

          if (inventory.length > 0) {
            inventoryCache.set(cacheKey, inventory);
            console.log(`[BoxLabels] Cached ${inventory.length} parts for ${style}`);
          }
        } catch (e) {
          console.log(`[BoxLabels] Inventory fetch for ${style} failed: ${e.message}`);
        }
      }

      // Map partIds from this style's inventory
      if (inventory) {
        for (const inv of inventory) {
          if (inv.partId) {
            partIdMap[inv.partId] = { size: inv.size, color: inv.color, style };
          }
        }
      }
    }));

    // Filter to only requested partIds (if specified)
    const result = {};
    if (partIds.length > 0) {
      for (const pid of partIds) {
        if (partIdMap[pid]) result[pid] = partIdMap[pid];
      }
    } else {
      Object.assign(result, partIdMap);
    }

    console.log(`[BoxLabels] Resolved ${Object.keys(result).length} of ${partIds.length || 'all'} partIds`);
    res.json({ success: true, partMap: result, totalResolved: Object.keys(result).length });
  } catch (err) {
    console.error(`[BoxLabels] Part resolution failed:`, err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
