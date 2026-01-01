// Daily Sales Archive routes - For YTD tracking beyond ManageOrders 60-day limit

const express = require('express');
const router = express.Router();
const { fetchAllCaspioPages, makeCaspioRequest } = require('../utils/caspio');

/**
 * GET /api/caspio/daily-sales
 * Fetch archived daily sales records from Caspio
 *
 * Query params:
 *   - start: Start date (YYYY-MM-DD) - required
 *   - end: End date (YYYY-MM-DD) - required
 *
 * Returns: Array of { Date, Revenue, OrderCount, CapturedAt }
 */
router.get('/caspio/daily-sales', async (req, res) => {
  const { start, end } = req.query;
  console.log(`GET /api/caspio/daily-sales requested with start=${start}, end=${end}`);

  // Validate required parameters
  if (!start || !end) {
    return res.status(400).json({
      error: 'Both start and end date parameters are required',
      example: '/api/caspio/daily-sales?start=2026-01-01&end=2026-01-31'
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
    // Query Caspio DailySalesArchive table for date range
    const records = await fetchAllCaspioPages('/tables/DailySalesArchive/records', {
      'q.where': `Date>='${start}' AND Date<='${end}'`,
      'q.orderBy': 'Date ASC',
      'q.limit': 400 // Max ~1 year of daily records
    });

    // Calculate summary stats
    const totalRevenue = records.reduce((sum, r) => sum + (parseFloat(r.Revenue) || 0), 0);
    const totalOrders = records.reduce((sum, r) => sum + (parseInt(r.OrderCount) || 0), 0);

    console.log(`Daily sales archive: ${records.length} day(s) found, total revenue: $${totalRevenue.toFixed(2)}`);

    res.json({
      success: true,
      dateRange: { start, end },
      summary: {
        daysWithData: records.length,
        totalRevenue: totalRevenue,
        totalOrders: totalOrders
      },
      records: records
    });
  } catch (error) {
    console.error('Error fetching daily sales archive:', error.message);

    // Check if table doesn't exist yet
    if (error.message.includes('404') || error.message.includes('not found')) {
      return res.status(404).json({
        error: 'DailySalesArchive table not found in Caspio',
        message: 'Please create the DailySalesArchive table in Caspio with fields: Date (PK), Revenue, OrderCount, CapturedAt'
      });
    }

    res.status(500).json({
      error: 'Failed to fetch daily sales archive',
      details: error.message
    });
  }
});

/**
 * POST /api/caspio/daily-sales
 * Archive a single day's sales data to Caspio
 *
 * Body:
 *   - date: The sales date (YYYY-MM-DD) - required
 *   - revenue: Total invoiced revenue for that day - required
 *   - orderCount: Number of orders invoiced - required
 *
 * Returns: { success: true, record: {...} }
 */
router.post('/caspio/daily-sales', async (req, res) => {
  const { date, revenue, orderCount } = req.body;
  console.log(`POST /api/caspio/daily-sales requested with date=${date}, revenue=${revenue}, orderCount=${orderCount}`);

  // Validate required fields
  if (!date) {
    return res.status(400).json({ error: 'date is required (YYYY-MM-DD format)' });
  }
  if (revenue === undefined || revenue === null) {
    return res.status(400).json({ error: 'revenue is required' });
  }
  if (orderCount === undefined || orderCount === null) {
    return res.status(400).json({ error: 'orderCount is required' });
  }

  // Validate date format
  const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
  if (!dateRegex.test(date)) {
    return res.status(400).json({
      error: 'Date must be in YYYY-MM-DD format',
      received: date
    });
  }

  try {
    // Check if record already exists for this date
    const existing = await fetchAllCaspioPages('/tables/DailySalesArchive/records', {
      'q.where': `Date='${date}'`,
      'q.limit': 1
    });

    if (existing.length > 0) {
      console.log(`Daily sales for ${date} already exists, updating...`);

      // Update existing record
      const updateResult = await makeCaspioRequest(
        'put',
        `/tables/DailySalesArchive/records`,
        { 'q.where': `Date='${date}'` },
        {
          Revenue: parseFloat(revenue),
          OrderCount: parseInt(orderCount),
          CapturedAt: new Date().toISOString()
        }
      );

      return res.json({
        success: true,
        action: 'updated',
        record: {
          Date: date,
          Revenue: parseFloat(revenue),
          OrderCount: parseInt(orderCount),
          CapturedAt: new Date().toISOString()
        }
      });
    }

    // Insert new record
    const insertResult = await makeCaspioRequest(
      'post',
      '/tables/DailySalesArchive/records',
      {},
      {
        Date: date,
        Revenue: parseFloat(revenue),
        OrderCount: parseInt(orderCount),
        CapturedAt: new Date().toISOString()
      }
    );

    console.log(`Daily sales archived for ${date}: $${revenue} (${orderCount} orders)`);

    res.status(201).json({
      success: true,
      action: 'created',
      record: {
        Date: date,
        Revenue: parseFloat(revenue),
        OrderCount: parseInt(orderCount),
        CapturedAt: new Date().toISOString()
      }
    });
  } catch (error) {
    console.error('Error archiving daily sales:', error.message);

    // Check if table doesn't exist yet
    if (error.message.includes('404') || error.message.includes('not found')) {
      return res.status(404).json({
        error: 'DailySalesArchive table not found in Caspio',
        message: 'Please create the DailySalesArchive table in Caspio with fields: Date (PK), Revenue, OrderCount, CapturedAt'
      });
    }

    res.status(500).json({
      error: 'Failed to archive daily sales',
      details: error.message
    });
  }
});

/**
 * GET /api/caspio/daily-sales/ytd
 * Get Year-to-Date summary from archived data
 *
 * Query params:
 *   - year: Year to calculate YTD for (default: current year)
 *
 * Returns: { ytdRevenue, ytdOrders, daysWithData, lastArchivedDate }
 */
router.get('/caspio/daily-sales/ytd', async (req, res) => {
  const year = req.query.year || new Date().getFullYear();
  const yearStart = `${year}-01-01`;
  const today = new Date().toISOString().split('T')[0];

  console.log(`GET /api/caspio/daily-sales/ytd requested for year=${year}`);

  try {
    const records = await fetchAllCaspioPages('/tables/DailySalesArchive/records', {
      'q.where': `Date>='${yearStart}' AND Date<='${today}'`,
      'q.orderBy': 'Date DESC',
      'q.limit': 400
    });

    const ytdRevenue = records.reduce((sum, r) => sum + (parseFloat(r.Revenue) || 0), 0);
    const ytdOrders = records.reduce((sum, r) => sum + (parseInt(r.OrderCount) || 0), 0);
    const lastArchivedDate = records.length > 0 ? records[0].Date : null;

    console.log(`YTD ${year}: $${ytdRevenue.toFixed(2)} from ${records.length} archived days`);

    res.json({
      success: true,
      year: parseInt(year),
      ytdRevenue: ytdRevenue,
      ytdOrders: ytdOrders,
      daysWithData: records.length,
      lastArchivedDate: lastArchivedDate,
      dateRange: { start: yearStart, end: today }
    });
  } catch (error) {
    console.error('Error fetching YTD sales:', error.message);

    if (error.message.includes('404') || error.message.includes('not found')) {
      return res.status(404).json({
        error: 'DailySalesArchive table not found in Caspio',
        message: 'Please create the DailySalesArchive table in Caspio'
      });
    }

    res.status(500).json({
      error: 'Failed to fetch YTD sales',
      details: error.message
    });
  }
});

/**
 * POST /api/caspio/daily-sales/bulk
 * Archive multiple days of sales data at once (for backfilling)
 *
 * Body: Array of { date, revenue, orderCount }
 *
 * Returns: { success: true, created: N, updated: M, errors: [] }
 */
router.post('/caspio/daily-sales/bulk', async (req, res) => {
  const records = req.body;
  console.log(`POST /api/caspio/daily-sales/bulk requested with ${records?.length || 0} records`);

  if (!Array.isArray(records) || records.length === 0) {
    return res.status(400).json({
      error: 'Request body must be an array of daily sales records',
      example: '[{ "date": "2026-01-01", "revenue": 12450.00, "orderCount": 18 }]'
    });
  }

  const results = { created: 0, updated: 0, errors: [] };

  for (const record of records) {
    const { date, revenue, orderCount } = record;

    if (!date || revenue === undefined || orderCount === undefined) {
      results.errors.push({ date: date || 'missing', error: 'Missing required fields' });
      continue;
    }

    try {
      // Check if exists
      const existing = await fetchAllCaspioPages('/tables/DailySalesArchive/records', {
        'q.where': `Date='${date}'`,
        'q.limit': 1
      });

      if (existing.length > 0) {
        // Update
        await makeCaspioRequest(
          'put',
          '/tables/DailySalesArchive/records',
          { 'q.where': `Date='${date}'` },
          {
            Revenue: parseFloat(revenue),
            OrderCount: parseInt(orderCount),
            CapturedAt: new Date().toISOString()
          }
        );
        results.updated++;
      } else {
        // Insert
        await makeCaspioRequest(
          'post',
          '/tables/DailySalesArchive/records',
          {},
          {
            Date: date,
            Revenue: parseFloat(revenue),
            OrderCount: parseInt(orderCount),
            CapturedAt: new Date().toISOString()
          }
        );
        results.created++;
      }
    } catch (error) {
      results.errors.push({ date, error: error.message });
    }
  }

  console.log(`Bulk archive complete: ${results.created} created, ${results.updated} updated, ${results.errors.length} errors`);

  res.json({
    success: results.errors.length === 0,
    ...results
  });
});

module.exports = router;
