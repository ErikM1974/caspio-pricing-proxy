// Quote_Change_Log routes — append-only audit trail of ShopWorks-side edits
// detected by the sync-from-shopworks diff pass. Pricing-index writes changes
// here when a snapshot delta is detected; quote-view + dashboard read for
// "show what changed" banners and activity feeds.
//
// Schema (matches Caspio table Quote_Change_Log):
//   PK_ID (auto), QuoteID, ShopWorksOrderNumber, SalesRepEmail, ChangedAt,
//   ChangeType, FieldName, OldValue, NewValue, Severity, DetectedBy,
//   Acknowledged_By, Acknowledged_At, Notes
//
// Endpoints:
//   GET    /api/quote_change_log              — list (filters: quoteID, shopWorksOrderNumber, hoursAgo, severity, unacknowledged, limit)
//   GET    /api/quote_change_log/:id          — single by PK
//   POST   /api/quote_change_log              — create one row OR bulk array
//   PUT    /api/quote_change_log/:id          — update (mainly for Acknowledged_*)
//   DELETE /api/quote_change_log/:id          — delete a row (rare — for cleanup)

'use strict';

const express = require('express');
const router = express.Router();
const { makeCaspioRequest, fetchAllCaspioPages } = require('../utils/caspio');

const TABLE = '/tables/Quote_Change_Log/records';

// ----------------------------------------------------------------------------
// GET /api/quote_change_log
// ----------------------------------------------------------------------------
router.get('/quote_change_log', async (req, res) => {
  try {
    const where = [];

    // Filter: by quote ID
    if (req.query.quoteID) {
      const safe = String(req.query.quoteID).replace(/[^a-zA-Z0-9_-]/g, '');
      if (safe) where.push(`QuoteID='${safe}'`);
    }

    // Filter: by ShopWorks WO#
    if (req.query.shopWorksOrderNumber) {
      const n = parseInt(req.query.shopWorksOrderNumber, 10);
      if (Number.isInteger(n) && n > 0) where.push(`ShopWorksOrderNumber=${n}`);
    }

    // Filter: by sales rep email
    if (req.query.salesRepEmail) {
      const safe = String(req.query.salesRepEmail).replace(/[^a-zA-Z0-9._@+-]/g, '');
      if (safe) where.push(`SalesRepEmail='${safe}'`);
    }

    // Filter: changes within last N hours
    if (req.query.hoursAgo) {
      const hours = Math.min(Math.max(Number(req.query.hoursAgo) || 24, 1), 720);
      // Caspio's DateAdd in WHERE clause — subtract hours from now()
      where.push(`ChangedAt > DateAdd(hour, -${hours}, GetUTCDate())`);
    }

    // Filter: by severity
    if (req.query.severity) {
      const safe = String(req.query.severity).replace(/[^a-zA-Z]/g, '');
      if (safe) where.push(`Severity='${safe}'`);
    }

    // Filter: unacknowledged only
    if (req.query.unacknowledged === 'true') {
      where.push(`Acknowledged_At IS NULL`);
    }

    const params = {};
    if (where.length > 0) params['q.where'] = where.join(' AND ');
    // Sort newest first by default
    params['q.orderBy'] = req.query.orderBy || 'ChangedAt DESC';
    // Cap result size — default 100, max 500
    params['q.limit'] = Math.min(Math.max(Number(req.query.limit) || 100, 1), 500);

    const records = await fetchAllCaspioPages(TABLE, params);
    res.json({ success: true, count: records.length, records });
  } catch (err) {
    console.error('[quote_change_log GET] error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ----------------------------------------------------------------------------
// GET /api/quote_change_log/:id
// ----------------------------------------------------------------------------
router.get('/quote_change_log/:id', async (req, res) => {
  try {
    const pkId = parseInt(req.params.id, 10);
    if (!Number.isInteger(pkId) || pkId <= 0) {
      return res.status(400).json({ error: 'Invalid PK_ID' });
    }
    const records = await fetchAllCaspioPages(TABLE, { 'q.where': `PK_ID=${pkId}` });
    if (records.length === 0) return res.status(404).json({ error: 'Not found' });
    res.json({ success: true, record: records[0] });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ----------------------------------------------------------------------------
// POST /api/quote_change_log — create one OR bulk
// Body: { ...singleChange } OR [{ ...change }, ...]
// ----------------------------------------------------------------------------
router.post('/quote_change_log', express.json({ limit: '1mb' }), async (req, res) => {
  try {
    const body = req.body;
    const items = Array.isArray(body) ? body : [body];

    const results = [];
    const errors = [];
    for (const item of items) {
      // Minimal validation — QuoteID + FieldName + ChangedAt required
      if (!item.QuoteID || !item.FieldName || !item.ChangedAt) {
        errors.push({ item, error: 'QuoteID + FieldName + ChangedAt are required' });
        continue;
      }
      // Strip any client-sent PK_ID (Caspio auto-generates)
      const data = { ...item };
      delete data.PK_ID;
      try {
        const result = await makeCaspioRequest('post', TABLE, {}, data);
        results.push(result);
      } catch (e) {
        errors.push({ item, error: e.message });
      }
    }
    res.status(errors.length === 0 ? 201 : 207).json({
      success: errors.length === 0,
      created: results.length,
      errorCount: errors.length,
      errors: errors.length ? errors : undefined,
    });
  } catch (err) {
    console.error('[quote_change_log POST] error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ----------------------------------------------------------------------------
// PUT /api/quote_change_log/:id — update (mainly Acknowledged_By/At)
// ----------------------------------------------------------------------------
router.put('/quote_change_log/:id', express.json(), async (req, res) => {
  try {
    const pkId = parseInt(req.params.id, 10);
    if (!Number.isInteger(pkId) || pkId <= 0) {
      return res.status(400).json({ error: 'Invalid PK_ID' });
    }
    const updates = { ...req.body };
    delete updates.PK_ID;
    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ error: 'No fields to update' });
    }
    const result = await makeCaspioRequest('put', TABLE, { 'q.where': `PK_ID=${pkId}` }, updates);
    res.json({ success: true, ...result });
  } catch (err) {
    console.error(`[quote_change_log PUT ${req.params.id}] error:`, err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ----------------------------------------------------------------------------
// DELETE /api/quote_change_log/:id
// ----------------------------------------------------------------------------
router.delete('/quote_change_log/:id', async (req, res) => {
  try {
    const pkId = parseInt(req.params.id, 10);
    if (!Number.isInteger(pkId) || pkId <= 0) {
      return res.status(400).json({ error: 'Invalid PK_ID' });
    }
    await makeCaspioRequest('delete', TABLE, { 'q.where': `PK_ID=${pkId}` });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
