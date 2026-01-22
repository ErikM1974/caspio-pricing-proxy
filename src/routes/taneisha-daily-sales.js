// Taneisha Daily Sales By Account Archive routes - For YTD tracking beyond ManageOrders 60-day limit
// Table: Taneisha_Daily_Sales_By_Account (SalesDate, CustomerID, CustomerName, Revenue, OrderCount, ArchivedAt)

const express = require('express');
const router = express.Router();
const { fetchAllCaspioPages, makeCaspioRequest } = require('../utils/caspio');

const TABLE_NAME = 'Taneisha_Daily_Sales_By_Account';

/**
 * GET /api/taneisha/daily-sales-by-account
 * Fetch archived daily sales by customer for a date range
 *
 * Query params:
 *   - start: Start date (YYYY-MM-DD) - required
 *   - end: End date (YYYY-MM-DD) - required
 *
 * Returns: { days: [{ date, customers: [...] }], summary: { customers: [...], totalRevenue, totalOrders } }
 */
router.get('/daily-sales-by-account', async (req, res) => {
  const { start, end } = req.query;
  console.log(`GET /api/taneisha/daily-sales-by-account requested with start=${start}, end=${end}`);

  // Validate required parameters
  if (!start || !end) {
    return res.status(400).json({
      error: 'Both start and end date parameters are required',
      example: '/api/taneisha/daily-sales-by-account?start=2026-01-01&end=2026-01-31'
    });
  }

  // Validate date format
  const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
  if (!dateRegex.test(start) || !dateRegex.test(end)) {
    return res.status(400).json({
      error: 'Dates must be in YYYY-MM-DD format',
      received: { start, end }
    });
  }

  try {
    // Query Caspio table for date range
    const records = await fetchAllCaspioPages(`/tables/${TABLE_NAME}/records`, {
      'q.where': `SalesDate>='${start}' AND SalesDate<='${end}'`,
      'q.orderBy': 'SalesDate ASC',
      'q.limit': 1000
    });

    // Group records by date
    const dayMap = new Map();
    const customerTotals = new Map();

    for (const record of records) {
      // Extract date portion (handle both Date object and string)
      const dateStr = typeof record.SalesDate === 'string'
        ? record.SalesDate.split('T')[0]
        : new Date(record.SalesDate).toISOString().split('T')[0];

      const revenue = parseFloat(record.Revenue) || 0;
      const orderCount = parseInt(record.OrderCount) || 0;

      // Group by date
      if (!dayMap.has(dateStr)) {
        dayMap.set(dateStr, []);
      }
      dayMap.get(dateStr).push({
        customerId: record.CustomerID,
        customerName: record.CustomerName,
        revenue: revenue,
        orderCount: orderCount
      });

      // Aggregate by customer for summary
      if (!customerTotals.has(record.CustomerID)) {
        customerTotals.set(record.CustomerID, {
          customerName: record.CustomerName,
          totalRevenue: 0,
          totalOrders: 0
        });
      }
      const customerTotal = customerTotals.get(record.CustomerID);
      customerTotal.totalRevenue += revenue;
      customerTotal.totalOrders += orderCount;
    }

    // Convert dayMap to sorted array
    const days = Array.from(dayMap.entries())
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([date, customers]) => ({
        date,
        customers: customers.sort((a, b) => b.revenue - a.revenue)
      }));

    // Convert customerTotals to sorted array
    const summaryCustomers = Array.from(customerTotals.entries())
      .map(([customerId, totals]) => ({
        customerId,
        customerName: totals.customerName,
        totalRevenue: totals.totalRevenue,
        totalOrders: totals.totalOrders
      }))
      .sort((a, b) => b.totalRevenue - a.totalRevenue);

    const totalRevenue = summaryCustomers.reduce((sum, c) => sum + c.totalRevenue, 0);
    const totalOrders = summaryCustomers.reduce((sum, c) => sum + c.totalOrders, 0);

    console.log(`Taneisha daily sales by account: ${records.length} records across ${days.length} days, ${summaryCustomers.length} customers`);

    res.json({
      success: true,
      start,
      end,
      days,
      summary: {
        customers: summaryCustomers,
        totalRevenue,
        totalOrders
      }
    });
  } catch (error) {
    console.error('Error fetching Taneisha daily sales by account:', error.message);

    if (error.message.includes('404') || error.message.includes('not found')) {
      return res.status(404).json({
        error: `${TABLE_NAME} table not found in Caspio`,
        message: `Please create the ${TABLE_NAME} table in Caspio with fields: SalesDate, CustomerID, CustomerName, Revenue, OrderCount, ArchivedAt`
      });
    }

    res.status(500).json({
      error: 'Failed to fetch Taneisha daily sales by account',
      details: error.message
    });
  }
});

/**
 * GET /api/taneisha/daily-sales-by-account/ytd
 * Get Year-to-Date summary aggregated by customer
 *
 * Query params:
 *   - year: Year to calculate YTD for (default: current year)
 *
 * Returns: { year, customers: [...], lastArchivedDate, totalRevenue, totalOrders }
 */
router.get('/daily-sales-by-account/ytd', async (req, res) => {
  const year = req.query.year || new Date().getFullYear();
  const yearStart = `${year}-01-01`;
  const yearEnd = `${year}-12-31`;

  console.log(`GET /api/taneisha/daily-sales-by-account/ytd requested for year=${year}`);

  try {
    const records = await fetchAllCaspioPages(`/tables/${TABLE_NAME}/records`, {
      'q.where': `SalesDate>='${yearStart}' AND SalesDate<='${yearEnd}'`,
      'q.orderBy': 'SalesDate DESC',
      'q.limit': 5000 // ~800 customers x ~365 days / archiving frequency
    });

    // Aggregate by customer
    const customerTotals = new Map();
    let lastArchivedDate = null;

    for (const record of records) {
      const revenue = parseFloat(record.Revenue) || 0;
      const orderCount = parseInt(record.OrderCount) || 0;

      if (!customerTotals.has(record.CustomerID)) {
        customerTotals.set(record.CustomerID, {
          customerName: record.CustomerName,
          totalRevenue: 0,
          totalOrders: 0
        });
      }
      const customerTotal = customerTotals.get(record.CustomerID);
      customerTotal.totalRevenue += revenue;
      customerTotal.totalOrders += orderCount;

      // Track last archived date (records are DESC sorted)
      if (!lastArchivedDate && record.SalesDate) {
        const dateStr = typeof record.SalesDate === 'string'
          ? record.SalesDate.split('T')[0]
          : new Date(record.SalesDate).toISOString().split('T')[0];
        lastArchivedDate = dateStr;
      }
    }

    // Convert to array with customer IDs
    const customers = Array.from(customerTotals.entries())
      .map(([customerId, totals]) => ({
        customerId: parseInt(customerId),
        customerName: totals.customerName,
        totalRevenue: totals.totalRevenue,
        totalOrders: totals.totalOrders
      }))
      .sort((a, b) => b.totalRevenue - a.totalRevenue);

    const totalRevenue = customers.reduce((sum, c) => sum + c.totalRevenue, 0);
    const totalOrders = customers.reduce((sum, c) => sum + c.totalOrders, 0);

    console.log(`Taneisha YTD by account ${year}: $${totalRevenue.toFixed(2)} from ${records.length} records, ${customers.length} customers`);

    res.json({
      success: true,
      year: parseInt(year),
      customers,
      lastArchivedDate,
      totalRevenue,
      totalOrders
    });
  } catch (error) {
    console.error('Error fetching Taneisha YTD sales by account:', error.message);

    if (error.message.includes('404') || error.message.includes('not found')) {
      return res.status(404).json({
        error: `${TABLE_NAME} table not found in Caspio`,
        message: `Please create the ${TABLE_NAME} table in Caspio`
      });
    }

    res.status(500).json({
      error: 'Failed to fetch Taneisha YTD sales by account',
      details: error.message
    });
  }
});

/**
 * POST /api/taneisha/daily-sales-by-account
 * Archive a single day's per-customer sales data to Caspio
 *
 * Body:
 *   - date: The sales date (YYYY-MM-DD) - required
 *   - customers: Array of { customerId, customerName, revenue, orderCount } - required
 *
 * Returns: { success: true, date, customersArchived, message }
 */
router.post('/daily-sales-by-account', async (req, res) => {
  const { date, customers } = req.body;
  console.log(`POST /api/taneisha/daily-sales-by-account requested with date=${date}, customers=${customers?.length || 0}`);

  // Validate required fields
  if (!date) {
    return res.status(400).json({
      error: 'date is required (YYYY-MM-DD format)',
      example: { date: '2026-01-15', customers: [{ customerId: 12345, customerName: 'ACME Corp', revenue: 5234.50, orderCount: 2 }] }
    });
  }

  // Validate date format
  const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
  if (!dateRegex.test(date)) {
    return res.status(400).json({
      error: 'Date must be in YYYY-MM-DD format',
      received: date
    });
  }

  if (!Array.isArray(customers) || customers.length === 0) {
    return res.status(400).json({
      error: 'customers array is required and must not be empty',
      example: { date: '2026-01-15', customers: [{ customerId: 12345, customerName: 'ACME Corp', revenue: 5234.50, orderCount: 2 }] }
    });
  }

  // Validate each customer entry
  for (let i = 0; i < customers.length; i++) {
    const customer = customers[i];
    if (!customer.customerId) {
      return res.status(400).json({ error: `customers[${i}].customerId is required` });
    }
    if (customer.revenue === undefined || customer.revenue === null) {
      return res.status(400).json({ error: `customers[${i}].revenue is required` });
    }
    if (customer.orderCount === undefined || customer.orderCount === null) {
      return res.status(400).json({ error: `customers[${i}].orderCount is required` });
    }
  }

  const results = { created: 0, updated: 0, errors: [] };

  try {
    for (const customer of customers) {
      try {
        // Check if record exists for this date+customer combo
        const existing = await fetchAllCaspioPages(`/tables/${TABLE_NAME}/records`, {
          'q.where': `SalesDate='${date}' AND CustomerID='${customer.customerId}'`,
          'q.limit': 1
        });

        if (existing.length > 0) {
          // Update existing record
          await makeCaspioRequest(
            'put',
            `/tables/${TABLE_NAME}/records`,
            { 'q.where': `SalesDate='${date}' AND CustomerID='${customer.customerId}'` },
            {
              Revenue: parseFloat(customer.revenue),
              OrderCount: parseInt(customer.orderCount),
              CustomerName: customer.customerName || existing[0].CustomerName
            }
          );
          results.updated++;
        } else {
          // Insert new record (ArchivedAt auto-set by Caspio timestamp field)
          await makeCaspioRequest(
            'post',
            `/tables/${TABLE_NAME}/records`,
            {},
            {
              SalesDate: date,
              CustomerID: String(customer.customerId),
              CustomerName: customer.customerName || '',
              Revenue: parseFloat(customer.revenue),
              OrderCount: parseInt(customer.orderCount)
            }
          );
          results.created++;
        }
      } catch (customerError) {
        results.errors.push({ customerId: customer.customerId, error: customerError.message });
        console.error(`Error processing customer ${customer.customerId} for ${date}:`, customerError.message);
      }
    }

    const customersArchived = results.created + results.updated;
    console.log(`Taneisha daily sales by account archived for ${date}: ${customersArchived} customers (${results.created} created, ${results.updated} updated)`);

    res.status(results.errors.length === 0 ? 201 : 207).json({
      success: results.errors.length === 0,
      date,
      customersArchived,
      created: results.created,
      updated: results.updated,
      errors: results.errors.length > 0 ? results.errors : undefined,
      message: `Archived ${customersArchived} customers for ${date}`
    });
  } catch (error) {
    console.error('Error archiving Taneisha daily sales by account:', error.message);

    if (error.message.includes('404') || error.message.includes('not found')) {
      return res.status(404).json({
        error: `${TABLE_NAME} table not found in Caspio`,
        message: `Please create the ${TABLE_NAME} table in Caspio with fields: SalesDate, CustomerID, CustomerName, Revenue, OrderCount, ArchivedAt`
      });
    }

    res.status(500).json({
      error: 'Failed to archive Taneisha daily sales by account',
      details: error.message
    });
  }
});

/**
 * POST /api/taneisha/daily-sales-by-account/bulk
 * Archive multiple days of per-customer sales data at once (for backfilling)
 *
 * Body: Array of { date, customers: [...] }
 *
 * Returns: { success, totalCustomersArchived, dayResults: [...] }
 */
router.post('/daily-sales-by-account/bulk', async (req, res) => {
  const days = req.body;
  console.log(`POST /api/taneisha/daily-sales-by-account/bulk requested with ${days?.length || 0} days`);

  if (!Array.isArray(days) || days.length === 0) {
    return res.status(400).json({
      error: 'Request body must be an array of daily records',
      example: '[{ "date": "2026-01-01", "customers": [{ "customerId": 12345, "customerName": "ACME Corp", "revenue": 500, "orderCount": 1 }] }]'
    });
  }

  const dayResults = [];
  let totalCreated = 0;
  let totalUpdated = 0;
  let totalErrors = 0;

  for (const day of days) {
    const { date, customers } = day;

    if (!date || !Array.isArray(customers)) {
      dayResults.push({ date: date || 'missing', error: 'Missing date or customers array' });
      totalErrors++;
      continue;
    }

    const results = { created: 0, updated: 0, errors: [] };

    for (const customer of customers) {
      if (!customer.customerId || customer.revenue === undefined) {
        results.errors.push({ customerId: customer.customerId || 'missing', error: 'Missing required fields' });
        continue;
      }

      try {
        const existing = await fetchAllCaspioPages(`/tables/${TABLE_NAME}/records`, {
          'q.where': `SalesDate='${date}' AND CustomerID='${customer.customerId}'`,
          'q.limit': 1
        });

        if (existing.length > 0) {
          await makeCaspioRequest(
            'put',
            `/tables/${TABLE_NAME}/records`,
            { 'q.where': `SalesDate='${date}' AND CustomerID='${customer.customerId}'` },
            {
              Revenue: parseFloat(customer.revenue),
              OrderCount: parseInt(customer.orderCount) || 0,
              CustomerName: customer.customerName || existing[0].CustomerName
            }
          );
          results.updated++;
        } else {
          await makeCaspioRequest(
            'post',
            `/tables/${TABLE_NAME}/records`,
            {},
            {
              SalesDate: date,
              CustomerID: String(customer.customerId),
              CustomerName: customer.customerName || '',
              Revenue: parseFloat(customer.revenue),
              OrderCount: parseInt(customer.orderCount) || 0
            }
          );
          results.created++;
        }
      } catch (error) {
        results.errors.push({ customerId: customer.customerId, error: error.message });
      }
    }

    dayResults.push({
      date,
      customersArchived: results.created + results.updated,
      created: results.created,
      updated: results.updated,
      errors: results.errors.length > 0 ? results.errors : undefined
    });

    totalCreated += results.created;
    totalUpdated += results.updated;
    totalErrors += results.errors.length;
  }

  console.log(`Bulk archive complete: ${totalCreated} created, ${totalUpdated} updated, ${totalErrors} errors across ${days.length} days`);

  res.json({
    success: totalErrors === 0,
    totalCustomersArchived: totalCreated + totalUpdated,
    totalCreated,
    totalUpdated,
    totalErrors,
    dayResults
  });
});

module.exports = router;
