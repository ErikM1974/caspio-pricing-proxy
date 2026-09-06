// Order and customer-related routes

const express = require('express');
const router = express.Router();
const { makeCaspioRequest, fetchAllCaspioPages } = require('../utils/caspio');

// Parameter-aware in-memory cache for dashboard data
const dashboardCache = new Map();

// GET /api/orders
router.get('/orders', async (req, res) => {
  console.log('GET /api/orders requested with query:', req.query);

  try {
    let whereConditions = [];
    
    if (req.query.orderID) {
      whereConditions.push(`OrderID=${req.query.orderID}`);
    }
    if (req.query.customerID) {
      whereConditions.push(`CustomerID=${req.query.customerID}`);
    }
    if (req.query.orderStatus) {
      whereConditions.push(`OrderStatus='${req.query.orderStatus}'`);
    }
    if (req.query.paymentStatus) {
      whereConditions.push(`PaymentStatus='${req.query.paymentStatus}'`);
    }
    if (req.query.imprintType) {
      whereConditions.push(`ImprintType='${req.query.imprintType}'`);
    }

    const params = {};
    if (whereConditions.length > 0) {
      params['q.where'] = whereConditions.join(' AND ');
    }

    const records = await fetchAllCaspioPages('/tables/Orders/records', params);
    console.log(`Orders: ${records.length} record(s) found`);
    res.json(records);
  } catch (error) {
    console.error('Error fetching orders:', error.message);
    res.status(500).json({ error: 'Failed to fetch orders', details: error.message });
  }
});

// POST /api/orders
router.post('/orders', express.json(), async (req, res) => {
  console.log('POST /api/orders requested with body:', req.body);

  try {
    const { CustomerID } = req.body;

    if (!CustomerID) {
      return res.status(400).json({ error: 'CustomerID is required' });
    }

    const orderData = {
      CustomerID,
      OrderNumber: req.body.OrderNumber || `ORD-${Date.now()}`,
      SessionID: req.body.SessionID || null,
      TotalAmount: req.body.TotalAmount || null,
      OrderStatus: req.body.OrderStatus || 'New',
      ImprintType: req.body.ImprintType || null,
      PaymentMethod: req.body.PaymentMethod || null,
      PaymentStatus: req.body.PaymentStatus || 'Pending',
      ShippingMethod: req.body.ShippingMethod || null,
      TrackingNumber: req.body.TrackingNumber || null,
      EstimatedDelivery: req.body.EstimatedDelivery || null,
      Notes: req.body.Notes || null,
      InternalNotes: req.body.InternalNotes || null
    };

    const result = await makeCaspioRequest('post', '/tables/Orders/records', {}, orderData);
    console.log('Order created successfully');
    res.status(201).json({ message: 'Order created successfully', order: result });
  } catch (error) {
    console.error('Error creating order:', error.message);
    res.status(500).json({ error: 'Failed to create order', details: error.message });
  }
});

// PUT /api/orders/:id
router.put('/orders/:id', express.json(), async (req, res) => {
  const orderId = req.params.id;
  console.log(`PUT /api/orders/${orderId} requested with body:`, req.body);

  try {
    const updates = {};
    const allowedFields = [
      'TotalAmount', 'OrderStatus', 'ImprintType', 'PaymentMethod', 
      'PaymentStatus', 'ShippingMethod', 'TrackingNumber', 
      'EstimatedDelivery', 'Notes', 'InternalNotes'
    ];
    
    for (const field of allowedFields) {
      if (req.body[field] !== undefined) {
        updates[field] = req.body[field];
      }
    }

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ error: 'No valid fields to update' });
    }

    const result = await makeCaspioRequest('put', '/tables/Orders/records', 
      { 'q.where': `OrderID=${orderId}` }, 
      updates
    );
    
    console.log('Order updated successfully');
    res.json({ message: 'Order updated successfully', order: result });
  } catch (error) {
    console.error('Error updating order:', error.message);
    res.status(500).json({ error: 'Failed to update order', details: error.message });
  }
});

// DELETE /api/orders/:id
router.delete('/orders/:id', async (req, res) => {
  const orderId = req.params.id;
  console.log(`DELETE /api/orders/${orderId} requested`);

  try {
    const result = await makeCaspioRequest('delete', '/tables/Orders/records', 
      { 'q.where': `OrderID=${orderId}` }
    );
    
    console.log('Order deleted successfully');
    res.json({ message: 'Order deleted successfully', recordsAffected: result.RecordsAffected || 0 });
  } catch (error) {
    console.error('Error deleting order:', error.message);
    res.status(500).json({ error: 'Failed to delete order', details: error.message });
  }
});

// GET /api/customers
router.get('/customers', async (req, res) => {
  console.log('GET /api/customers requested with query:', req.query);

  try {
    let whereConditions = [];
    
    if (req.query.name) {
      whereConditions.push(`Name LIKE '%${req.query.name}%'`);
    }
    if (req.query.email) {
      whereConditions.push(`Email='${req.query.email}'`);
    }
    if (req.query.company) {
      whereConditions.push(`Company LIKE '%${req.query.company}%'`);
    }
    if (req.query.customerID) {
      whereConditions.push(`CustomerID=${req.query.customerID}`);
    }

    const params = {};
    if (whereConditions.length > 0) {
      params['q.where'] = whereConditions.join(' AND ');
    }

    const records = await fetchAllCaspioPages('/tables/Customer_Info/records', params);
    console.log(`Customers: ${records.length} record(s) found`);
    res.json(records);
  } catch (error) {
    console.error('Error fetching customers:', error.message);
    res.status(500).json({ error: 'Failed to fetch customers', details: error.message });
  }
});

// POST /api/customers
router.post('/customers', express.json(), async (req, res) => {
  console.log('POST /api/customers requested with body:', req.body);

  try {
    const customerData = { ...req.body };

    if (!customerData.Name) {
      if (customerData.FirstName && customerData.LastName) {
        customerData.Name = `${customerData.FirstName} ${customerData.LastName}`;
      } else {
        return res.status(400).json({ error: 'Name is required (or FirstName and LastName)' });
      }
    }

    if (!customerData.Email) {
      return res.status(400).json({ error: 'Email is required' });
    }

    const result = await makeCaspioRequest('post', '/tables/Customer_Info/records', {}, customerData);
    console.log('Customer created successfully');
    res.status(201).json({ message: 'Customer created successfully', customer: result });
  } catch (error) {
    console.error('Error creating customer:', error.message);
    res.status(500).json({ error: 'Failed to create customer', details: error.message });
  }
});

// PUT /api/customers/:id
router.put('/customers/:id', express.json(), async (req, res) => {
  const customerId = req.params.id;
  console.log(`PUT /api/customers/${customerId} requested with body:`, req.body);

  try {
    const updates = { ...req.body };
    delete updates.CustomerID;
    delete updates.PK_ID;

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ error: 'No valid fields to update' });
    }

    const result = await makeCaspioRequest('put', '/tables/Customer_Info/records', 
      { 'q.where': `CustomerID=${customerId}` }, 
      updates
    );
    
    console.log('Customer updated successfully');
    res.json({ message: 'Customer updated successfully', customer: result });
  } catch (error) {
    console.error('Error updating customer:', error.message);
    res.status(500).json({ error: 'Failed to update customer', details: error.message });
  }
});

// DELETE /api/customers/:id
router.delete('/customers/:id', async (req, res) => {
  const customerId = req.params.id;
  console.log(`DELETE /api/customers/${customerId} requested`);

  try {
    const result = await makeCaspioRequest('delete', '/tables/Customer_Info/records', 
      { 'q.where': `CustomerID=${customerId}` }
    );
    
    console.log('Customer deleted successfully');
    res.json({ message: 'Customer deleted successfully' });
  } catch (error) {
    console.error('Error deleting customer:', error.message);
    res.status(500).json({ error: 'Failed to delete customer', details: error.message });
  }
});

// GET /api/order-odbc
router.get('/order-odbc', async (req, res) => {
    console.log(`GET /api/order-odbc requested with params:`, req.query);
    
    try {
        const resource = '/tables/ORDER_ODBC/records';
        const params = {};
        
        // Handle query parameters
        if (req.query['q.where']) {
            params['q.where'] = req.query['q.where'];
        }
        
        if (req.query['q.orderBy']) {
            params['q.orderby'] = req.query['q.orderBy']; // Note: Caspio uses lowercase 'orderby'
        }
        
        if (req.query['q.limit']) {
            // Validate limit is within allowed range
            const limit = parseInt(req.query['q.limit']);
            if (isNaN(limit) || limit < 1) {
                return res.status(400).json({ error: 'Invalid limit parameter. Must be a positive integer.' });
            }
            if (limit > 1000) {
                return res.status(400).json({ error: 'Limit parameter cannot exceed 1000.' });
            }
            params['q.limit'] = limit;
        } else {
            // Default limit
            params['q.limit'] = 100;
        }
        
        // Use fetchAllCaspioPages to handle pagination
        const result = await fetchAllCaspioPages(resource, params);
        console.log(`Found ${result.length} order records`);
        
        res.json(result);
    } catch (error) {
        console.error("Error fetching order records:", error.message);
        res.status(500).json({ error: 'Failed to fetch order records.' });
    }
});

// GET /api/order-dashboard
router.get('/order-dashboard', async (req, res) => {
    console.log(`GET /api/order-dashboard requested with params:`, req.query);
    
    try {
        // Parse parameters first
        const days = parseInt(req.query.days) || 7;
        const includeDetails = req.query.includeDetails === 'true';
        const compareYoY = req.query.compareYoY === 'true';
        
        // Create cache key based on parameters
        const cacheKey = `days:${days}-details:${includeDetails}-yoy:${compareYoY}`;
        
        // Check cache (60 seconds)
        const now = Date.now();
        const cachedEntry = dashboardCache.get(cacheKey);
        if (cachedEntry && now - cachedEntry.timestamp < 60000) {
            console.log(`Returning cached dashboard data for ${cacheKey}`);
            return res.json(cachedEntry.data);
        }
        
        // Calculate date range
        const endDate = new Date();
        const startDate = new Date();
        startDate.setDate(startDate.getDate() - days);
        
        // Format dates for Caspio (YYYY-MM-DD)
        const formatDate = (date) => date.toISOString().split('T')[0];
        
        // Fetch orders in date range
        const whereClause = `date_OrderInvoiced>='${formatDate(startDate)}' AND date_OrderInvoiced<='${formatDate(endDate)}'`;
        console.log(`Fetching orders with whereClause: ${whereClause}`);
        
        const orders = await fetchAllCaspioPages('/tables/ORDER_ODBC/records', {
            'q.where': whereClause,
            'q.limit': 1000,
            'q.orderby': 'date_OrderInvoiced DESC'
        });
        
        console.log(`Found ${orders.length} orders in the last ${days} days`);
        
        // Calculate summary metrics
        const summary = {
            totalOrders: orders.length,
            totalSales: orders.reduce((sum, order) => sum + (parseFloat(order.cur_Subtotal) || 0), 0),
            notInvoiced: orders.filter(order => order.sts_Invoiced === 0).length,
            notShipped: orders.filter(order => order.sts_Shipped === 0).length,
            avgOrderValue: 0
        };
        
        // Calculate average order value
        if (summary.totalOrders > 0) {
            summary.avgOrderValue = summary.totalSales / summary.totalOrders;
        }
        
        // Calculate date range info
        const dateRange = {
            start: formatDate(startDate) + 'T00:00:00Z',
            end: formatDate(endDate) + 'T23:59:59Z',
            mostRecentOrder: null
        };
        
        if (orders.length > 0) {
            dateRange.mostRecentOrder = orders[0].date_OrderInvoiced;
        }
        
        // CSR name normalization mapping
        const csrNameMap = {
            'Ruth  Nhoung': 'Ruthie Nhoung',  // Ruth with 2 spaces
            'Ruth Nhoung': 'Ruthie Nhoung',   // Ruth with 1 space
            'ruth': 'Ruthie Nhoung',           // Lowercase ruth
            'House ': 'House Account',         // House with trailing space
            'House': 'House Account',          // House without space
            'Unknown': 'Unassigned',           // Make it clearer
            // Add more mappings as needed
        };
        
        // Function to normalize CSR names
        const normalizeCSRName = (name) => {
            return csrNameMap[name] || name;
        };
        
        // Group by CSR with name normalization
        const csrMap = {};
        orders.forEach(order => {
            const originalCsr = order.CustomerServiceRep || 'Unknown';
            const csr = normalizeCSRName(originalCsr);
            if (!csrMap[csr]) {
                csrMap[csr] = { name: csr, orders: 0, sales: 0 };
            }
            csrMap[csr].orders++;
            csrMap[csr].sales += parseFloat(order.cur_Subtotal) || 0;
        });
        
        const byCsr = Object.values(csrMap)
            .sort((a, b) => b.sales - a.sales)
            .map(csr => ({
                name: csr.name,
                orders: csr.orders,
                sales: parseFloat(csr.sales.toFixed(2))
            }));
        
        // Order Type normalization mapping
        const orderTypeMap = {
            'Wow Embroidery': 'WOW',
            'Sample Return to Vendor': 'Sample Returns',
            'Inksoft': 'Webstores',
            '77 Account': 'Samples',
            'Digital Printing': 'DTG',
            'Transfers': 'DTF',
            'Shopify': '253GEAR',
            // Add more mappings as needed
        };
        
        // Function to normalize Order Types
        const normalizeOrderType = (type) => {
            return orderTypeMap[type] || type;
        };
        
        // Group by Order Type with normalization
        const typeMap = {};
        orders.forEach(order => {
            const originalType = order.ORDER_TYPE || 'Unknown';
            const type = normalizeOrderType(originalType);
            if (!typeMap[type]) {
                typeMap[type] = { type: type, orders: 0, sales: 0 };
            }
            typeMap[type].orders++;
            typeMap[type].sales += parseFloat(order.cur_Subtotal) || 0;
        });
        
        const byOrderType = Object.values(typeMap)
            .sort((a, b) => b.sales - a.sales)
            .map(type => ({
                type: type.type,
                orders: type.orders,
                sales: parseFloat(type.sales.toFixed(2))
            }));
        
        // Calculate today's stats
        const today = new Date();
        const todayStr = formatDate(today);
        const todayOrders = orders.filter(order => 
            order.date_OrderInvoiced && order.date_OrderInvoiced.startsWith(todayStr)
        );
        
        const todayStats = {
            ordersToday: todayOrders.length,
            salesToday: todayOrders.reduce((sum, order) => sum + (parseFloat(order.cur_Subtotal) || 0), 0),
            shippedToday: todayOrders.filter(order => order.sts_Shipped === 1).length
        };
        
        // Round sales values to 2 decimal places
        summary.totalSales = parseFloat(summary.totalSales.toFixed(2));
        summary.avgOrderValue = parseFloat(summary.avgOrderValue.toFixed(2));
        todayStats.salesToday = parseFloat(todayStats.salesToday.toFixed(2));
        
        // Build response
        const response = {
            summary,
            dateRange,
            breakdown: {
                byCsr,
                byOrderType
            },
            todayStats
        };
        
        // Add recent orders if requested
        if (includeDetails) {
            response.recentOrders = orders.slice(0, 10).map(order => ({
                ID_Order: order.ID_Order,
                date_OrderInvoiced: order.date_OrderInvoiced,
                CompanyName: order.CompanyName,
                CustomerServiceRep: order.CustomerServiceRep,
                ORDER_TYPE: order.ORDER_TYPE,
                cur_Subtotal: parseFloat(order.cur_Subtotal) || 0,
                sts_Invoiced: order.sts_Invoiced,
                sts_Shipped: order.sts_Shipped
            }));
        }
        
        // Add year-over-year comparison if requested (month-by-month chunking)
        if (compareYoY) {
            console.log('Calculating year-over-year comparison...');
            
            // Calculate year-to-date ranges
            const currentYear = new Date();
            const currentYearStart = new Date(currentYear.getFullYear(), 0, 1);
            
            const lastYear = new Date();
            lastYear.setFullYear(lastYear.getFullYear() - 1);
            const lastYearStart = new Date(lastYear.getFullYear(), 0, 1);
            const lastYearEnd = new Date(lastYear.getFullYear(), lastYear.getMonth(), lastYear.getDate());
            
            try {
                // Helper function to get last day of month
                // Two aggregate reads (2026-09-06) instead of up to 72 paged reads of full rows
                // that were only ever summed and counted here. COUNT(DISTINCT ID_Order) keeps the
                // old per-order dedupe; if a range holds duplicate ID_Order rows the total is
                // recomputed one subtotal per order, so nothing double-counts. The old path also
                // stopped at 3,000 rows per month without saying so; this one has no cap.
                const lastYearAgg = await ytdAggregate(formatDate(lastYearStart), formatDate(lastYearEnd));
                const currentYearAgg = await ytdAggregate(formatDate(currentYearStart), formatDate(currentYear));
                const currentYearTotal = currentYearAgg.total;
                const lastYearTotal = lastYearAgg.total;
                console.log(`YTD: ${currentYearAgg.orders} orders / $${currentYearTotal.toFixed(2)} this year vs ${lastYearAgg.orders} orders / $${lastYearTotal.toFixed(2)} last year`);

                response.yoyComparison = {
                    currentYearTotal: parseFloat(currentYearTotal.toFixed(2)),
                    lastYearTotal: parseFloat(lastYearTotal.toFixed(2)),
                    currentYearOrders: currentYearAgg.orders,
                    lastYearOrders: lastYearAgg.orders,
                    salesGrowthPercent: lastYearTotal > 0 ? parseFloat(((currentYearTotal - lastYearTotal) / lastYearTotal * 100).toFixed(2)) : 0,
                    orderGrowthPercent: lastYearAgg.orders > 0 ? parseFloat(((currentYearAgg.orders - lastYearAgg.orders) / lastYearAgg.orders * 100).toFixed(2)) : 0,
                    dateRanges: {
                        currentYear: `${formatDate(currentYearStart)} to ${formatDate(currentYear)}`,
                        lastYear: `${formatDate(lastYearStart)} to ${formatDate(lastYearEnd)}`
                    }
                };

            } catch (yoyError) {
                console.error('Error calculating YoY comparison:', yoyError.message);
                response.yoyComparison = { error: 'Failed to calculate year-over-year comparison' };
            }
        }
        
        // Cache the result
        dashboardCache.set(cacheKey, {
            data: response,
            timestamp: now
        });
        
        // Clean up old cache entries (keep only last 20)
        if (dashboardCache.size > 20) {
            const keys = Array.from(dashboardCache.keys());
            const oldestKey = keys[0];
            dashboardCache.delete(oldestKey);
        }
        
        console.log(`Dashboard data calculated and cached for ${cacheKey}`);
        res.json(response);
    } catch (error) {
        console.error("Error generating dashboard data:", error.message);
        res.status(500).json({ error: 'Failed to generate dashboard data.' });
    }
});

// Invoiced-order totals for a date range in ONE aggregate read (2026-09-06). Exposed for
// tests. Falls back to a per-order GROUP BY only when the range holds duplicate ID_Order
// rows, so a plain SUM can never double-count.
async function ytdAggregate(start, end) {
    const where = `date_OrderInvoiced>='${start}' AND date_OrderInvoiced<='${end}'`;
    const agg = await fetchAllCaspioPages('/tables/ORDER_ODBC/records', {
        'q.where': where,
        'q.select': 'COUNT(*) AS Rows, COUNT(DISTINCT ID_Order) AS Orders, SUM(cur_Subtotal) AS Total'
    });
    const a = (agg && agg[0]) || {};
    const rows = parseInt(a.Rows, 10) || 0;
    const orders = parseInt(a.Orders, 10) || 0;
    let total = parseFloat(a.Total) || 0;
    if (rows !== orders) {
        const perOrder = await fetchAllCaspioPages('/tables/ORDER_ODBC/records', {
            'q.where': where,
            'q.select': 'ID_Order, MAX(cur_Subtotal) AS Sub',
            'q.groupBy': 'ID_Order',
            'q.orderBy': 'ID_Order',
            'q.limit': 1000
        });
        total = (perOrder || []).reduce((sum, r) => sum + (parseFloat(r.Sub) || 0), 0);
        console.warn(`YoY: ${rows - orders} duplicate ID_Order row(s) in ${start}..${end}; total recomputed per order`);
    }
    return { orders, total, rows };
}

module.exports = router;
module.exports.ytdAggregate = ytdAggregate;