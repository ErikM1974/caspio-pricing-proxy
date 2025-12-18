// Gift Certificate routes

const express = require('express');
const router = express.Router();
const { fetchAllCaspioPages } = require('../utils/caspio');
const { fetchOrderNoByExternalId, fetchOrderByNumber } = require('../utils/manageorders');

// Cache setup (5-minute TTL)
const giftCertCache = new Map();
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes
const MAX_CACHE_SIZE = 100;

// Input sanitization helpers
function sanitizeCertificateNumber(certNumber) {
  if (!certNumber || typeof certNumber !== 'string') return null;
  // Allow alphanumeric and hyphens only (format: XXXX-XXXX-XXXX-XXXX)
  const sanitized = certNumber.replace(/[^a-zA-Z0-9-]/g, '').toUpperCase();
  return (sanitized.length > 0 && sanitized.length <= 50) ? sanitized : null;
}

function sanitizeEmail(email) {
  if (!email || typeof email !== 'string') return null;
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return emailRegex.test(email) ? email : null;
}

function sanitizeStoreName(storeName) {
  if (!storeName || typeof storeName !== 'string') return null;
  // Allow alphanumeric, spaces, and common punctuation
  const sanitized = storeName.replace(/[^a-zA-Z0-9\s\-'&.]/g, '').trim();
  return (sanitized.length > 0 && sanitized.length <= 100) ? sanitized : null;
}

/**
 * Parse the History field to extract transaction details
 * Example history:
 *   "Issued: 12/12/25 ($150)\nRedeemed: 12/14/25 Order #52039 ($150)\nRefunded: 12/17/25 Order #52039 ($106.8)"
 */
function parseHistory(history) {
  if (!history || typeof history !== 'string') return [];

  const transactions = [];
  // Match patterns like: "Redeemed: 12/14/25 Order #52039 ($150)" or "Issued: 12/12/25 ($70)"
  const regex = /(\w+): (\d+\/\d+\/\d+)(?: Order #(\d+))? \(\$?([\d.]+)\)/g;

  let match;
  while ((match = regex.exec(history)) !== null) {
    transactions.push({
      type: match[1],
      date: match[2],
      externalOrderId: match[3] || null,
      amount: parseFloat(match[4])
    });
  }

  return transactions;
}

/**
 * Transform Caspio record to camelCase response format
 */
function transformCertificate(record) {
  const currentBalance = record.CurrentBalance;
  const status = (currentBalance !== null && currentBalance > 0) ? 'Active' : 'Depleted';

  return {
    id: record.PK_ID,
    certificateNumber: record.GiftCertificateNumber,
    status: status,
    currentBalance: currentBalance,
    initialBalance: record.InitialBalance,
    customerEmail: record.CustomerEmail,
    customerName: record.CustomerName,
    storeName: record.StoreName,
    dateIssued: record.DateIssued,
    issueReason: record.IssueReason,
    redemptions: [], // Will be populated with parsed history + ShopWorks IDs
    history: record.History,
    dateUpdated: record.Date_Updated
  };
}

/**
 * Resolve ShopWorks order IDs and order details for transactions that have external order IDs
 */
async function resolveShopWorksOrderIds(transactions) {
  // Get unique external order IDs
  const uniqueOrderIds = [...new Set(
    transactions
      .filter(t => t.externalOrderId)
      .map(t => t.externalOrderId)
  )];

  // Build a map of external ID -> { shopworksOrderId, orderTotal, orderCustomer }
  const orderDetailsMap = new Map();

  for (const extOrderId of uniqueOrderIds) {
    try {
      // Step 1: Get ShopWorks order ID from external order ID
      const result = await fetchOrderNoByExternalId(extOrderId);
      if (result && result.length > 0 && result[0].id_Order) {
        const shopworksOrderId = result[0].id_Order;

        // Step 2: Fetch full order details to get total and customer name
        try {
          const orderDetails = await fetchOrderByNumber(shopworksOrderId);
          if (orderDetails && orderDetails.length > 0) {
            const order = orderDetails[0];
            orderDetailsMap.set(extOrderId, {
              shopworksOrderId: shopworksOrderId,
              orderTotal: order.cur_TotalInvoice || null,
              orderCustomer: order.CustomerName || null
            });
          } else {
            orderDetailsMap.set(extOrderId, {
              shopworksOrderId: shopworksOrderId,
              orderTotal: null,
              orderCustomer: null
            });
          }
        } catch (orderError) {
          console.warn(`Failed to fetch order details for ShopWorks order ${shopworksOrderId}:`, orderError.message);
          orderDetailsMap.set(extOrderId, {
            shopworksOrderId: shopworksOrderId,
            orderTotal: null,
            orderCustomer: null
          });
        }
      } else {
        orderDetailsMap.set(extOrderId, {
          shopworksOrderId: null,
          orderTotal: null,
          orderCustomer: null
        });
      }
    } catch (error) {
      console.warn(`Failed to resolve ShopWorks order ID for external ID ${extOrderId}:`, error.message);
      orderDetailsMap.set(extOrderId, {
        shopworksOrderId: null,
        orderTotal: null,
        orderCustomer: null
      });
    }
  }

  // Add ShopWorks order details to transactions
  return transactions.map(t => {
    if (t.externalOrderId) {
      const details = orderDetailsMap.get(t.externalOrderId) || {};
      return {
        ...t,
        shopworksOrderId: details.shopworksOrderId || null,
        orderTotal: details.orderTotal || null,
        orderCustomer: details.orderCustomer || null
      };
    }
    return {
      ...t,
      shopworksOrderId: null,
      orderTotal: null,
      orderCustomer: null
    };
  });
}

/**
 * GET /api/gift-certificates
 *
 * Query gift certificates with optional filters.
 * When certificateNumber is provided, returns single certificate with resolved ShopWorks order IDs.
 * Otherwise returns array of matching certificates.
 */
router.get('/gift-certificates', async (req, res) => {
  console.log('GET /api/gift-certificates requested with query:', req.query);

  try {
    const { certificateNumber, email, storeName, hasBalance, refresh } = req.query;
    const forceRefresh = refresh === 'true';

    // Build cache key from query parameters
    const cacheKey = JSON.stringify({ certificateNumber, email, storeName, hasBalance });

    // Check cache (unless refresh requested)
    if (!forceRefresh) {
      const cached = giftCertCache.get(cacheKey);
      if (cached && (Date.now() - cached.timestamp) < CACHE_TTL) {
        console.log('Returning cached gift certificate data');
        return res.json(cached.data);
      }
    }

    // Build WHERE clause
    const whereConditions = [];

    if (certificateNumber) {
      const sanitized = sanitizeCertificateNumber(certificateNumber);
      if (!sanitized) {
        return res.status(400).json({ error: 'Invalid certificate number format' });
      }
      whereConditions.push(`GiftCertificateNumber='${sanitized}'`);
    }

    if (email) {
      const sanitized = sanitizeEmail(email);
      if (!sanitized) {
        return res.status(400).json({ error: 'Invalid email format' });
      }
      whereConditions.push(`CustomerEmail='${sanitized.replace(/'/g, "''")}'`);
    }

    if (storeName) {
      const sanitized = sanitizeStoreName(storeName);
      if (!sanitized) {
        return res.status(400).json({ error: 'Invalid store name format' });
      }
      whereConditions.push(`StoreName='${sanitized.replace(/'/g, "''")}'`);
    }

    if (hasBalance === 'true') {
      whereConditions.push('CurrentBalance > 0');
    }

    // Build params
    const params = {};
    if (whereConditions.length > 0) {
      params['q.where'] = whereConditions.join(' AND ');
    }
    params['q.orderBy'] = 'DateIssued DESC';

    // Fetch from Caspio
    const records = await fetchAllCaspioPages('/tables/Inksoft_Gift_Certificates/records', params);
    console.log(`Gift certificates: ${records.length} record(s) found`);

    // Transform records
    let result;

    if (certificateNumber && records.length === 1) {
      // Single certificate lookup - include resolved ShopWorks order IDs
      const cert = transformCertificate(records[0]);
      const transactions = parseHistory(records[0].History);
      cert.redemptions = await resolveShopWorksOrderIds(transactions);
      result = cert;
    } else if (certificateNumber && records.length === 0) {
      return res.status(404).json({ error: 'Gift certificate not found' });
    } else {
      // List mode - return array without resolving order IDs (for performance)
      result = records.map(record => {
        const cert = transformCertificate(record);
        cert.redemptions = parseHistory(record.History);
        return cert;
      });
    }

    // Cache the result
    giftCertCache.set(cacheKey, { data: result, timestamp: Date.now() });

    // Limit cache size
    if (giftCertCache.size > MAX_CACHE_SIZE) {
      const firstKey = giftCertCache.keys().next().value;
      giftCertCache.delete(firstKey);
    }

    res.json(result);

  } catch (error) {
    console.error('Error fetching gift certificates:', error.message);
    res.status(500).json({
      error: 'Failed to fetch gift certificates',
      details: error.message
    });
  }
});

/**
 * GET /api/gift-certificates/by-order/:orderId
 *
 * Reverse lookup: Find gift certificates used on a specific ShopWorks order.
 * Takes ShopWorks order ID, finds external order ID, then searches gift certificate history.
 */
router.get('/gift-certificates/by-order/:orderId', async (req, res) => {
  const shopworksOrderId = req.params.orderId;
  console.log(`GET /api/gift-certificates/by-order/${shopworksOrderId} requested`);

  // Validate order ID (must be numeric)
  if (!shopworksOrderId || !/^\d+$/.test(shopworksOrderId)) {
    return res.status(400).json({ error: 'Invalid order ID format. Must be a numeric ShopWorks order ID.' });
  }

  const forceRefresh = req.query.refresh === 'true';

  // Check cache
  const cacheKey = `by-order-${shopworksOrderId}`;
  if (!forceRefresh) {
    const cached = giftCertCache.get(cacheKey);
    if (cached && (Date.now() - cached.timestamp) < CACHE_TTL) {
      console.log('Returning cached gift certificate by-order data');
      return res.json(cached.data);
    }
  }

  try {
    // Step 1: Get order details from ManageOrders to find external order ID
    const orderDetails = await fetchOrderByNumber(shopworksOrderId);

    if (!orderDetails || orderDetails.length === 0) {
      return res.status(404).json({
        error: 'Order not found in ShopWorks',
        shopworksOrderId: parseInt(shopworksOrderId)
      });
    }

    const order = orderDetails[0];
    const externalOrderId = order.CustomerPurchaseOrder;

    if (!externalOrderId) {
      return res.json({
        shopworksOrderId: parseInt(shopworksOrderId),
        externalOrderId: null,
        giftCertificatesUsed: [],
        totalGiftCertificateAmount: 0,
        count: 0,
        message: 'No external order ID found for this ShopWorks order'
      });
    }

    // Step 2: Search Caspio for gift certificates with this order in History
    const params = {
      'q.where': `History LIKE '%Order #${externalOrderId}%'`
    };
    const certificates = await fetchAllCaspioPages('/tables/Inksoft_Gift_Certificates/records', params);
    console.log(`Found ${certificates.length} gift certificate(s) for order ${shopworksOrderId} (ext: ${externalOrderId})`);

    // Step 3: Transform results - extract the specific redemption for this order
    const giftCertificatesUsed = certificates.map(cert => {
      const transactions = parseHistory(cert.History);
      // Find transactions for this specific order
      const orderTransactions = transactions.filter(t => t.externalOrderId === externalOrderId);

      // Calculate total amount applied from this certificate to this order
      const amountApplied = orderTransactions
        .filter(t => t.type === 'Redeemed')
        .reduce((sum, t) => sum + t.amount, 0);

      const amountRefunded = orderTransactions
        .filter(t => t.type === 'Refunded')
        .reduce((sum, t) => sum + t.amount, 0);

      const redemptionDate = orderTransactions.find(t => t.type === 'Redeemed')?.date || null;

      const currentBalance = cert.CurrentBalance;
      const status = (currentBalance !== null && currentBalance > 0) ? 'Active' : 'Depleted';

      return {
        certificateNumber: cert.GiftCertificateNumber,
        amountApplied: amountApplied,
        amountRefunded: amountRefunded,
        netAmount: amountApplied - amountRefunded,
        redemptionDate: redemptionDate,
        currentBalance: currentBalance,
        status: status,
        customerName: cert.CustomerName,
        customerEmail: cert.CustomerEmail,
        storeName: cert.StoreName,
        initialBalance: cert.InitialBalance
      };
    });

    // Calculate totals
    const totalGiftCertificateAmount = giftCertificatesUsed.reduce((sum, gc) => sum + gc.netAmount, 0);

    const result = {
      shopworksOrderId: parseInt(shopworksOrderId),
      externalOrderId: externalOrderId,
      orderCustomer: order.CustomerName,
      orderTotal: order.cur_TotalInvoice,
      giftCertificatesUsed: giftCertificatesUsed,
      totalGiftCertificateAmount: totalGiftCertificateAmount,
      count: giftCertificatesUsed.length
    };

    // Cache the result
    giftCertCache.set(cacheKey, { data: result, timestamp: Date.now() });

    // Limit cache size
    if (giftCertCache.size > MAX_CACHE_SIZE) {
      const firstKey = giftCertCache.keys().next().value;
      giftCertCache.delete(firstKey);
    }

    res.json(result);

  } catch (error) {
    console.error(`Error in gift-certificates/by-order/${shopworksOrderId}:`, error.message);
    res.status(500).json({
      error: 'Failed to lookup gift certificates for order',
      details: error.message
    });
  }
});

module.exports = router;
