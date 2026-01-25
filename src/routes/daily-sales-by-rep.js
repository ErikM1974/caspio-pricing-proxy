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

/**
 * POST /api/caspio/daily-sales-by-rep/archive-date
 * Fetch orders from ManageOrders for a specific date and archive to Caspio.
 * Use this to re-archive a date when rep assignments have changed.
 *
 * Body:
 *   - date: The sales date to archive (YYYY-MM-DD) - required
 *
 * Returns: { success, date, reps: [...], totalRevenue, totalOrders }
 */
router.post('/caspio/daily-sales-by-rep/archive-date', async (req, res) => {
  const { date } = req.body;
  console.log(`POST /api/caspio/daily-sales-by-rep/archive-date requested for date=${date}`);

  // Validate date
  if (!date) {
    return res.status(400).json({
      error: 'date is required (YYYY-MM-DD format)',
      example: { date: '2026-01-15' }
    });
  }

  const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
  if (!dateRegex.test(date)) {
    return res.status(400).json({
      error: 'Date must be in YYYY-MM-DD format',
      received: date
    });
  }

  // Check if date is within 60-day window
  const targetDate = new Date(date);
  const today = new Date();
  const daysDiff = Math.floor((today - targetDate) / (1000 * 60 * 60 * 24));

  if (daysDiff > 60) {
    return res.status(400).json({
      error: 'Date is outside ManageOrders 60-day window',
      message: 'Use POST /api/caspio/daily-sales-by-rep/import for dates older than 60 days',
      date: date,
      daysAgo: daysDiff
    });
  }

  if (daysDiff < 0) {
    return res.status(400).json({
      error: 'Cannot archive future dates',
      date: date
    });
  }

  try {
    const { fetchOrders } = require('../utils/manageorders');

    // Fetch all orders invoiced on this date
    console.log(`Fetching orders for ${date} from ManageOrders...`);
    const orders = await fetchOrders({
      date_Invoiced_start: date,
      date_Invoiced_end: date
    });

    console.log(`Fetched ${orders.length} orders for ${date}`);

    // Deduplicate by order ID (just in case)
    const seenOrderIds = new Set();
    const uniqueOrders = orders.filter(order => {
      if (seenOrderIds.has(order.id_Order)) return false;
      seenOrderIds.add(order.id_Order);
      return true;
    });

    // Aggregate by rep
    const repSales = new Map();

    uniqueOrders.forEach(order => {
      const rep = order.CustomerServiceRep || 'Unknown';
      const amount = parseFloat(order.cur_SubTotal) || 0;

      if (!repSales.has(rep)) {
        repSales.set(rep, { revenue: 0, orderCount: 0 });
      }

      const repData = repSales.get(rep);
      repData.revenue += amount;
      repData.orderCount += 1;
    });

    // Convert to array format for archiving
    const reps = Array.from(repSales.entries()).map(([name, data]) => ({
      name,
      revenue: Math.round(data.revenue * 100) / 100, // Round to 2 decimal places
      orderCount: data.orderCount
    }));

    console.log(`Aggregated ${date}: ${reps.length} reps, $${reps.reduce((sum, r) => sum + r.revenue, 0).toFixed(2)} total`);

    // Archive to Caspio (upsert each rep)
    const results = { created: 0, updated: 0, errors: [] };

    for (const rep of reps) {
      try {
        const existing = await fetchAllCaspioPages(`/tables/${TABLE_NAME}/records`, {
          'q.where': `SalesDate='${date}' AND RepName='${rep.name}'`,
          'q.limit': 1
        });

        if (existing.length > 0) {
          await makeCaspioRequest(
            'put',
            `/tables/${TABLE_NAME}/records`,
            { 'q.where': `SalesDate='${date}' AND RepName='${rep.name}'` },
            {
              Revenue: rep.revenue,
              OrderCount: rep.orderCount
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
              RepName: rep.name,
              Revenue: rep.revenue,
              OrderCount: rep.orderCount
            }
          );
          results.created++;
        }
      } catch (repError) {
        results.errors.push({ rep: rep.name, error: repError.message });
        console.error(`Error archiving ${rep.name} for ${date}:`, repError.message);
      }
    }

    const totalRevenue = reps.reduce((sum, r) => sum + r.revenue, 0);
    const totalOrders = reps.reduce((sum, r) => sum + r.orderCount, 0);

    console.log(`Archived ${date}: ${results.created} created, ${results.updated} updated, ${results.errors.length} errors`);

    res.status(results.errors.length === 0 ? 201 : 207).json({
      success: results.errors.length === 0,
      date,
      reps,
      totalRevenue,
      totalOrders,
      archived: {
        created: results.created,
        updated: results.updated,
        errors: results.errors.length > 0 ? results.errors : undefined
      }
    });

  } catch (error) {
    console.error('Error archiving date:', error.message);
    res.status(500).json({
      error: 'Failed to archive date',
      details: error.message
    });
  }
});

/**
 * POST /api/caspio/daily-sales-by-rep/archive-range
 * Archive multiple days from ManageOrders to Caspio (for backfill).
 * Processes one day at a time to avoid timeout.
 *
 * Body:
 *   - start: Start date (YYYY-MM-DD) - required
 *   - end: End date (YYYY-MM-DD) - required
 *
 * Returns: { success, start, end, daysProcessed, summary }
 */
router.post('/caspio/daily-sales-by-rep/archive-range', async (req, res) => {
  const { start, end } = req.body;
  console.log(`POST /api/caspio/daily-sales-by-rep/archive-range requested for ${start} to ${end}`);

  // Validate dates
  if (!start || !end) {
    return res.status(400).json({
      error: 'Both start and end dates are required',
      example: { start: '2026-01-01', end: '2026-01-25' }
    });
  }

  const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
  if (!dateRegex.test(start) || !dateRegex.test(end)) {
    return res.status(400).json({
      error: 'Dates must be in YYYY-MM-DD format',
      received: { start, end }
    });
  }

  const startDate = new Date(start);
  const endDate = new Date(end);
  const today = new Date();

  if (startDate > endDate) {
    return res.status(400).json({
      error: 'Start date must be before end date',
      received: { start, end }
    });
  }

  // Check if range is within 60-day window
  const daysAgoStart = Math.floor((today - startDate) / (1000 * 60 * 60 * 24));
  if (daysAgoStart > 60) {
    return res.status(400).json({
      error: 'Start date is outside ManageOrders 60-day window',
      message: 'Use POST /api/caspio/daily-sales-by-rep/import for dates older than 60 days',
      start: start,
      daysAgo: daysAgoStart
    });
  }

  try {
    const { fetchOrders } = require('../utils/manageorders');

    // Generate list of dates to process
    const dates = [];
    const current = new Date(startDate);
    while (current <= endDate && current <= today) {
      dates.push(current.toISOString().split('T')[0]);
      current.setDate(current.getDate() + 1);
    }

    console.log(`Processing ${dates.length} days from ${start} to ${end}`);

    // Fetch all orders for the range at once (more efficient than day-by-day)
    console.log(`Fetching orders from ManageOrders for range ${start} to ${end}...`);
    const orders = await fetchOrders({
      date_Invoiced_start: start,
      date_Invoiced_end: end
    });

    console.log(`Fetched ${orders.length} orders for range`);

    // Deduplicate by order ID
    const seenOrderIds = new Set();
    const uniqueOrders = orders.filter(order => {
      if (seenOrderIds.has(order.id_Order)) return false;
      seenOrderIds.add(order.id_Order);
      return true;
    });

    // Group by date and rep
    const dailyRepSales = new Map(); // date -> Map(rep -> {revenue, orderCount})

    uniqueOrders.forEach(order => {
      const invoiceDate = order.date_Invoiced ? order.date_Invoiced.split('T')[0] : null;
      if (!invoiceDate) return;

      const rep = order.CustomerServiceRep || 'Unknown';
      const amount = parseFloat(order.cur_SubTotal) || 0;

      if (!dailyRepSales.has(invoiceDate)) {
        dailyRepSales.set(invoiceDate, new Map());
      }

      const dayMap = dailyRepSales.get(invoiceDate);
      if (!dayMap.has(rep)) {
        dayMap.set(rep, { revenue: 0, orderCount: 0 });
      }

      const repData = dayMap.get(rep);
      repData.revenue += amount;
      repData.orderCount += 1;
    });

    // Archive each day
    const results = {
      daysProcessed: 0,
      daysSkipped: 0,
      totalCreated: 0,
      totalUpdated: 0,
      errors: []
    };

    for (const date of dates) {
      const dayMap = dailyRepSales.get(date);

      if (!dayMap || dayMap.size === 0) {
        results.daysSkipped++;
        continue;
      }

      // Archive each rep for this day
      for (const [repName, data] of dayMap) {
        try {
          const existing = await fetchAllCaspioPages(`/tables/${TABLE_NAME}/records`, {
            'q.where': `SalesDate='${date}' AND RepName='${repName}'`,
            'q.limit': 1
          });

          const revenue = Math.round(data.revenue * 100) / 100;

          if (existing.length > 0) {
            await makeCaspioRequest(
              'put',
              `/tables/${TABLE_NAME}/records`,
              { 'q.where': `SalesDate='${date}' AND RepName='${repName}'` },
              { Revenue: revenue, OrderCount: data.orderCount }
            );
            results.totalUpdated++;
          } else {
            await makeCaspioRequest(
              'post',
              `/tables/${TABLE_NAME}/records`,
              {},
              { SalesDate: date, RepName: repName, Revenue: revenue, OrderCount: data.orderCount }
            );
            results.totalCreated++;
          }
        } catch (err) {
          results.errors.push({ date, rep: repName, error: err.message });
        }
      }

      results.daysProcessed++;
    }

    console.log(`Archive range complete: ${results.daysProcessed} days, ${results.totalCreated} created, ${results.totalUpdated} updated`);

    res.status(results.errors.length === 0 ? 201 : 207).json({
      success: results.errors.length === 0,
      start,
      end,
      daysProcessed: results.daysProcessed,
      daysSkipped: results.daysSkipped,
      totalRecords: results.totalCreated + results.totalUpdated,
      created: results.totalCreated,
      updated: results.totalUpdated,
      errors: results.errors.length > 0 ? results.errors : undefined
    });

  } catch (error) {
    console.error('Error archiving range:', error.message);
    res.status(500).json({
      error: 'Failed to archive date range',
      details: error.message
    });
  }
});

/**
 * POST /api/caspio/daily-sales-by-rep/import
 * Manual import for dates outside 60-day ManageOrders window.
 * Use this when rep assignments change on orders older than 60 days.
 *
 * Body:
 *   - data: Array of { date, rep, revenue, orderCount }
 *
 * Returns: { success, imported, errors }
 */
router.post('/caspio/daily-sales-by-rep/import', async (req, res) => {
  const { data } = req.body;
  console.log(`POST /api/caspio/daily-sales-by-rep/import requested with ${data?.length || 0} records`);

  if (!Array.isArray(data) || data.length === 0) {
    return res.status(400).json({
      error: 'data array is required',
      example: {
        data: [
          { date: '2025-11-15', rep: 'Nika Lao', revenue: 1500.00, orderCount: 3 },
          { date: '2025-11-15', rep: 'Taneisha Clark', revenue: 2300.50, orderCount: 5 }
        ]
      }
    });
  }

  // Validate each record
  const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
  for (let i = 0; i < data.length; i++) {
    const record = data[i];
    if (!record.date || !dateRegex.test(record.date)) {
      return res.status(400).json({ error: `data[${i}].date must be YYYY-MM-DD format` });
    }
    if (!record.rep) {
      return res.status(400).json({ error: `data[${i}].rep is required` });
    }
    if (record.revenue === undefined || record.revenue === null) {
      return res.status(400).json({ error: `data[${i}].revenue is required` });
    }
    if (record.orderCount === undefined || record.orderCount === null) {
      return res.status(400).json({ error: `data[${i}].orderCount is required` });
    }
  }

  const results = { created: 0, updated: 0, errors: [] };

  try {
    for (const record of data) {
      try {
        const existing = await fetchAllCaspioPages(`/tables/${TABLE_NAME}/records`, {
          'q.where': `SalesDate='${record.date}' AND RepName='${record.rep}'`,
          'q.limit': 1
        });

        const revenue = Math.round(parseFloat(record.revenue) * 100) / 100;
        const orderCount = parseInt(record.orderCount);

        if (existing.length > 0) {
          await makeCaspioRequest(
            'put',
            `/tables/${TABLE_NAME}/records`,
            { 'q.where': `SalesDate='${record.date}' AND RepName='${record.rep}'` },
            { Revenue: revenue, OrderCount: orderCount }
          );
          results.updated++;
        } else {
          await makeCaspioRequest(
            'post',
            `/tables/${TABLE_NAME}/records`,
            {},
            { SalesDate: record.date, RepName: record.rep, Revenue: revenue, OrderCount: orderCount }
          );
          results.created++;
        }
      } catch (err) {
        results.errors.push({ date: record.date, rep: record.rep, error: err.message });
      }
    }

    console.log(`Import complete: ${results.created} created, ${results.updated} updated, ${results.errors.length} errors`);

    res.status(results.errors.length === 0 ? 201 : 207).json({
      success: results.errors.length === 0,
      imported: results.created + results.updated,
      created: results.created,
      updated: results.updated,
      errors: results.errors.length > 0 ? results.errors : undefined
    });

  } catch (error) {
    console.error('Error importing data:', error.message);
    res.status(500).json({
      error: 'Failed to import data',
      details: error.message
    });
  }
});

module.exports = router;
