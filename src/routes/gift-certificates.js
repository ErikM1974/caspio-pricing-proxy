// Gift Certificate routes

const express = require('express');
const router = express.Router();
const { fetchAllCaspioPages, makeCaspioRequest } = require('../utils/caspio');
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

/**
 * DELETE /api/gift-certificates/clear
 *
 * Delete ALL records from the Inksoft_Gift_Certificates table.
 * WARNING: This is a destructive operation - use with caution!
 */
router.delete('/gift-certificates/clear', async (req, res) => {
  console.log('DELETE /api/gift-certificates/clear requested');

  try {
    // First, count how many records exist
    const existingRecords = await fetchAllCaspioPages('/tables/Inksoft_Gift_Certificates/records', {
      'q.select': 'PK_ID'
    });
    const totalCount = existingRecords.length;

    if (totalCount === 0) {
      return res.json({
        success: true,
        deletedCount: 0,
        message: 'Table was already empty'
      });
    }

    console.log(`Found ${totalCount} records to delete`);

    // Caspio REST API: DELETE with WHERE clause to delete matching records
    // Delete in batches by PK_ID to avoid timeout issues
    const batchSize = 500;
    let deletedCount = 0;

    // Get all PK_IDs
    const pkIds = existingRecords.map(r => r.PK_ID);

    // Delete in batches
    for (let i = 0; i < pkIds.length; i += batchSize) {
      const batchIds = pkIds.slice(i, i + batchSize);
      const idList = batchIds.join(',');

      // Delete records where PK_ID is in the batch
      const deleteResult = await makeCaspioRequest(
        'delete',
        '/tables/Inksoft_Gift_Certificates/records',
        { 'q.where': `PK_ID IN (${idList})` }
      );

      deletedCount += batchIds.length;
      console.log(`Deleted batch ${Math.floor(i / batchSize) + 1}: ${batchIds.length} records (total: ${deletedCount})`);
    }

    // Clear the cache since data has changed
    giftCertCache.clear();

    res.json({
      success: true,
      deletedCount: deletedCount
    });

  } catch (error) {
    console.error('Error clearing gift certificates:', error.message);
    res.status(500).json({
      error: 'Failed to clear gift certificates table',
      details: error.message
    });
  }
});

/**
 * POST /api/gift-certificates/bulk
 *
 * Bulk insert gift certificate records.
 * Caspio supports up to 1000 records per insert request.
 */
router.post('/gift-certificates/bulk', async (req, res) => {
  console.log('POST /api/gift-certificates/bulk requested');

  try {
    const { certificates } = req.body;

    if (!certificates || !Array.isArray(certificates)) {
      return res.status(400).json({
        error: 'Invalid request body. Expected { certificates: [...] }'
      });
    }

    if (certificates.length === 0) {
      return res.json({
        success: true,
        insertedCount: 0,
        message: 'No certificates to insert'
      });
    }

    console.log(`Received ${certificates.length} certificates for bulk insert`);

    // Validate and clean certificate data
    // Only include fields that should be inserted (not formula fields)
    const validFields = [
      'CustomerEmail',
      'CustomerName',
      'GiftCertificateNumber',
      'StoreName',
      'DateIssued',
      'InitialBalance',
      'CurrentBalance',
      'IssueReason',
      'History'
    ];

    const cleanedCertificates = certificates.map(cert => {
      const cleaned = {};
      for (const field of validFields) {
        if (cert[field] !== undefined) {
          cleaned[field] = cert[field];
        }
      }
      return cleaned;
    });

    // Caspio bulk insert limit is 1000 records per request
    const batchSize = 1000;
    let insertedCount = 0;
    const errors = [];

    for (let i = 0; i < cleanedCertificates.length; i += batchSize) {
      const batch = cleanedCertificates.slice(i, i + batchSize);
      const batchNumber = Math.floor(i / batchSize) + 1;

      try {
        console.log(`Inserting batch ${batchNumber}: ${batch.length} records`);

        // Caspio bulk insert expects an array in the request body
        const result = await makeCaspioRequest(
          'post',
          '/tables/Inksoft_Gift_Certificates/records',
          {},
          batch
        );

        insertedCount += batch.length;
        console.log(`Batch ${batchNumber} inserted successfully. Total: ${insertedCount}`);

      } catch (batchError) {
        console.error(`Error inserting batch ${batchNumber}:`, batchError.message);
        errors.push({
          batch: batchNumber,
          startIndex: i,
          count: batch.length,
          error: batchError.message
        });
      }
    }

    // Clear the cache since data has changed
    giftCertCache.clear();

    if (errors.length > 0) {
      res.status(207).json({
        success: false,
        insertedCount: insertedCount,
        totalRequested: certificates.length,
        errors: errors,
        message: `Partial success: ${insertedCount} of ${certificates.length} records inserted`
      });
    } else {
      res.json({
        success: true,
        insertedCount: insertedCount
      });
    }

  } catch (error) {
    console.error('Error bulk inserting gift certificates:', error.message);
    res.status(500).json({
      error: 'Failed to bulk insert gift certificates',
      details: error.message
    });
  }
});

module.exports = router;
