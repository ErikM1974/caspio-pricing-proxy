// Daily Sales By Rep Archive routes - For YTD team performance tracking
// Table: NW_Daily_Sales_By_Rep (SalesDate, RepName, Revenue, OrderCount, ArchivedAt)

const express = require('express');
const router = express.Router();
const { fetchAllCaspioPages, makeCaspioRequest } = require('../utils/caspio');

const TABLE_NAME = 'NW_Daily_Sales_By_Rep';

/**
 * GET /api/caspio/daily-sales-by-rep
 * Fetch archived daily sales by rep for a date range
 *
 * Query params:
 *   - start: Start date (YYYY-MM-DD) - required
 *   - end: End date (YYYY-MM-DD) - required
 *
 * Returns: { days: [{ date, reps: [...] }], summary: { reps: [...], totalRevenue, totalOrders } }
 */
router.get('/caspio/daily-sales-by-rep', async (req, res) => {
  const { start, end } = req.query;
  console.log(`GET /api/caspio/daily-sales-by-rep requested with start=${start}, end=${end}`);

  // Validate required parameters
  if (!start || !end) {
    return res.status(400).json({
      error: 'Both start and end date parameters are required',
      example: '/api/caspio/daily-sales-by-rep?start=2026-01-01&end=2026-01-31'
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
    const repTotals = new Map();

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
        name: record.RepName,
        revenue: revenue,
        orderCount: orderCount
      });

      // Aggregate by rep for summary
      if (!repTotals.has(record.RepName)) {
        repTotals.set(record.RepName, { totalRevenue: 0, totalOrders: 0 });
      }
      const repTotal = repTotals.get(record.RepName);
      repTotal.totalRevenue += revenue;
      repTotal.totalOrders += orderCount;
    }

    // Convert dayMap to sorted array
    const days = Array.from(dayMap.entries())
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([date, reps]) => ({
        date,
        reps: reps.sort((a, b) => b.revenue - a.revenue) // Sort by revenue DESC within each day
      }));

    // Convert repTotals to sorted array
    const summaryReps = Array.from(repTotals.entries())
      .map(([name, totals]) => ({
        name,
        totalRevenue: totals.totalRevenue,
        totalOrders: totals.totalOrders
      }))
      .sort((a, b) => b.totalRevenue - a.totalRevenue);

    const totalRevenue = summaryReps.reduce((sum, r) => sum + r.totalRevenue, 0);
    const totalOrders = summaryReps.reduce((sum, r) => sum + r.totalOrders, 0);

    console.log(`Daily sales by rep: ${records.length} records across ${days.length} days, ${summaryReps.length} reps`);

    res.json({
      success: true,
      start,
      end,
      days,
      summary: {
        reps: summaryReps,
        totalRevenue,
        totalOrders
      }
    });
  } catch (error) {
    console.error('Error fetching daily sales by rep:', error.message);

    if (error.message.includes('404') || error.message.includes('not found')) {
      return res.status(404).json({
        error: `${TABLE_NAME} table not found in Caspio`,
        message: `Please create the ${TABLE_NAME} table in Caspio with fields: SalesDate, RepName, Revenue, OrderCount, ArchivedAt`
      });
    }

    res.status(500).json({
      error: 'Failed to fetch daily sales by rep',
      details: error.message
    });
  }
});

/**
 * GET /api/caspio/daily-sales-by-rep/ytd
 * Get Year-to-Date summary aggregated by rep
 *
 * Query params:
 *   - year: Year to calculate YTD for (default: current year)
 *
 * Returns: { year, reps: [...], lastArchivedDate, totalRevenue, totalOrders }
 */
router.get('/caspio/daily-sales-by-rep/ytd', async (req, res) => {
  const year = req.query.year || new Date().getFullYear();
  const yearStart = `${year}-01-01`;
  const yearEnd = `${year}-12-31`;

  console.log(`GET /api/caspio/daily-sales-by-rep/ytd requested for year=${year}`);

  try {
    const records = await fetchAllCaspioPages(`/tables/${TABLE_NAME}/records`, {
      'q.where': `SalesDate>='${yearStart}' AND SalesDate<='${yearEnd}'`,
      'q.orderBy': 'SalesDate DESC',
      'q.limit': 1000
    });

    // Aggregate by rep
    const repTotals = new Map();
    let lastArchivedDate = null;

    for (const record of records) {
      const revenue = parseFloat(record.Revenue) || 0;
      const orderCount = parseInt(record.OrderCount) || 0;

      if (!repTotals.has(record.RepName)) {
        repTotals.set(record.RepName, { totalRevenue: 0, totalOrders: 0 });
      }
      const repTotal = repTotals.get(record.RepName);
      repTotal.totalRevenue += revenue;
      repTotal.totalOrders += orderCount;

      // Track last archived date (records are DESC sorted)
      if (!lastArchivedDate && record.SalesDate) {
        const dateStr = typeof record.SalesDate === 'string'
          ? record.SalesDate.split('T')[0]
          : new Date(record.SalesDate).toISOString().split('T')[0];
        lastArchivedDate = dateStr;
      }
    }

    // Convert to sorted array
    const reps = Array.from(repTotals.entries())
      .map(([name, totals]) => ({
        name,
        totalRevenue: totals.totalRevenue,
        totalOrders: totals.totalOrders
      }))
      .sort((a, b) => b.totalRevenue - a.totalRevenue);

    const totalRevenue = reps.reduce((sum, r) => sum + r.totalRevenue, 0);
    const totalOrders = reps.reduce((sum, r) => sum + r.totalOrders, 0);

    console.log(`YTD by rep ${year}: $${totalRevenue.toFixed(2)} from ${records.length} records, ${reps.length} reps`);

    res.json({
      success: true,
      year: parseInt(year),
      reps,
      lastArchivedDate,
      totalRevenue,
      totalOrders
    });
  } catch (error) {
    console.error('Error fetching YTD sales by rep:', error.message);

    if (error.message.includes('404') || error.message.includes('not found')) {
      return res.status(404).json({
        error: `${TABLE_NAME} table not found in Caspio`,
        message: `Please create the ${TABLE_NAME} table in Caspio`
      });
    }

    res.status(500).json({
      error: 'Failed to fetch YTD sales by rep',
      details: error.message
    });
  }
});

/**
 * POST /api/caspio/daily-sales-by-rep
 * Archive a single day's per-rep sales data to Caspio
 *
 * Body:
 *   - date: The sales date (YYYY-MM-DD) - required
 *   - reps: Array of { name, revenue, orderCount } - required
 *
 * Returns: { success: true, date, repsArchived, message }
 */
router.post('/caspio/daily-sales-by-rep', async (req, res) => {
  const { date, reps } = req.body;
  console.log(`POST /api/caspio/daily-sales-by-rep requested with date=${date}, reps=${reps?.length || 0}`);

  // Validate required fields
  if (!date) {
    return res.status(400).json({
      error: 'date is required (YYYY-MM-DD format)',
      example: { date: '2026-01-15', reps: [{ name: 'Nika Lao', revenue: 5234.50, orderCount: 12 }] }
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

  if (!Array.isArray(reps) || reps.length === 0) {
    return res.status(400).json({
      error: 'reps array is required and must not be empty',
      example: { date: '2026-01-15', reps: [{ name: 'Nika Lao', revenue: 5234.50, orderCount: 12 }] }
    });
  }

  // Validate each rep entry
  for (let i = 0; i < reps.length; i++) {
    const rep = reps[i];
    if (!rep.name) {
      return res.status(400).json({ error: `reps[${i}].name is required` });
    }
    if (rep.revenue === undefined || rep.revenue === null) {
      return res.status(400).json({ error: `reps[${i}].revenue is required` });
    }
    if (rep.orderCount === undefined || rep.orderCount === null) {
      return res.status(400).json({ error: `reps[${i}].orderCount is required` });
    }
  }

  const results = { created: 0, updated: 0, errors: [] };

  try {
    for (const rep of reps) {
      try {
        // Check if record exists for this date+rep combo
        const existing = await fetchAllCaspioPages(`/tables/${TABLE_NAME}/records`, {
          'q.where': `SalesDate='${date}' AND RepName='${rep.name}'`,
          'q.limit': 1
        });

        if (existing.length > 0) {
          // Update existing record
          await makeCaspioRequest(
            'put',
            `/tables/${TABLE_NAME}/records`,
            { 'q.where': `SalesDate='${date}' AND RepName='${rep.name}'` },
            {
              Revenue: parseFloat(rep.revenue),
              OrderCount: parseInt(rep.orderCount)
            }
          );
          results.updated++;
          console.log(`Updated ${rep.name} for ${date}: $${rep.revenue}`);
        } else {
          // Insert new record (ArchivedAt auto-set by Caspio timestamp field)
          await makeCaspioRequest(
            'post',
            `/tables/${TABLE_NAME}/records`,
            {},
            {
              SalesDate: date,
              RepName: rep.name,
              Revenue: parseFloat(rep.revenue),
              OrderCount: parseInt(rep.orderCount)
            }
          );
          results.created++;
          console.log(`Created ${rep.name} for ${date}: $${rep.revenue}`);
        }
      } catch (repError) {
        results.errors.push({ rep: rep.name, error: repError.message });
        console.error(`Error processing ${rep.name} for ${date}:`, repError.message);
      }
    }

    const repsArchived = results.created + results.updated;
    console.log(`Daily sales by rep archived for ${date}: ${repsArchived} reps (${results.created} created, ${results.updated} updated)`);

    res.status(results.errors.length === 0 ? 201 : 207).json({
      success: results.errors.length === 0,
      date,
      repsArchived,
      created: results.created,
      updated: results.updated,
      errors: results.errors.length > 0 ? results.errors : undefined,
      message: `Archived ${repsArchived} reps for ${date}`
    });
  } catch (error) {
    console.error('Error archiving daily sales by rep:', error.message);

    if (error.message.includes('404') || error.message.includes('not found')) {
      return res.status(404).json({
        error: `${TABLE_NAME} table not found in Caspio`,
        message: `Please create the ${TABLE_NAME} table in Caspio with fields: SalesDate, RepName, Revenue, OrderCount, ArchivedAt`
      });
    }

    res.status(500).json({
      error: 'Failed to archive daily sales by rep',
      details: error.message
    });
  }
});

module.exports = router;
