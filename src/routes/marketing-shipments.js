// marketing-shipments.js — Leads CRM "Send a marketing kit" fulfillment.
//
//   GET  /api/marketing-shipments/items                 — active kit catalog (Erik-editable)
//   GET  /api/marketing-shipments?status=&submissionId= — shipment queue (Mikalah)
//   POST /api/marketing-shipments                        — an AE requests a kit for a lead
//   PUT  /api/marketing-shipments/:shipmentId            — Mikalah marks packed / shipped + tracking
//
// Tables: Marketing_Shipments (one row per kit) + Marketing_Kit_Items (catalog).
// Recipient rows hold PII → the whole router is CRM-secret-only at the server.js
// mount; staff reach it through the main app's session-gated
// /api/crm-proxy/marketing-shipments* forwarder. On the Shipped transition the
// route logs a Lead_Activity row server-side so the lead timeline can't be skipped.
'use strict';
const express = require('express');
const router = express.Router();
const { fetchAllCaspioPages, makeCaspioRequest, putWithRecordsAffected: caspioPut } = require('../utils/caspio');
const { sanitizeId, sanitizeLike, S, nowIso } = require('../utils/form-submission-helpers');

const SHIPMENTS_PATH = '/tables/Marketing_Shipments/records';
const ITEMS_PATH = '/tables/Marketing_Kit_Items/records';
const ACTIVITY_PATH = '/tables/Lead_Activity/records';
const STATUSES = new Set(['Requested', 'Packed', 'Shipped', 'Cancelled']);

function buildShipmentId() {
  const d = new Date();
  const mmdd = String(d.getMonth() + 1).padStart(2, '0') + String(d.getDate()).padStart(2, '0');
  const rand = String(Math.floor(1000 + Math.random() * 9000));
  return `KIT${mmdd}-${rand}`;
}

// GET /items — the active kit catalog (Erik edits Marketing_Kit_Items in Caspio; no deploy).
router.get('/items', async (req, res) => {
  try {
    const rows = await fetchAllCaspioPages(
      ITEMS_PATH,
      { 'q.where': 'Active=1', 'q.orderBy': 'Sort, PK_ID', 'q.pageSize': 200 },
      { maxPages: 1 }
    );
    res.json({ items: rows || [] });
  } catch (e) {
    console.error('[marketing-shipments] items failed:', e.message);
    res.status(502).json({ error: 'Kit items lookup failed' });
  }
});

// GET / — shipment queue. ?status= (Requested/Packed/Shipped), ?submissionId= (a lead's kits).
router.get('/', async (req, res) => {
  try {
    const where = [];
    const status = sanitizeLike(req.query.status);
    if (status) where.push(`Status='${status}'`);
    const sid = sanitizeId(req.query.submissionId);
    if (sid) where.push(`Submission_ID='${sid}'`);
    // PK_ID is the unique stable column — required for correct multi-page ordering.
    const params = { 'q.orderBy': 'PK_ID DESC', 'q.pageSize': 500 };
    if (where.length) params['q.where'] = where.join(' AND ');
    const rows = await fetchAllCaspioPages(SHIPMENTS_PATH, params, { maxPages: 4 });
    res.json({ shipments: rows || [] });
  } catch (e) {
    console.error('[marketing-shipments] list failed:', e.message);
    res.status(502).json({ error: 'Shipments lookup failed' });
  }
});

// POST / — an AE requests a kit for a lead.
router.post('/', async (req, res) => {
  const b = req.body || {};
  const items = Array.isArray(b.items) ? b.items.slice(0, 20) : [];
  if (!items.length) return res.status(400).json({ error: 'Select at least one item to send' });
  const addr1 = S(b.address1), city = S(b.city), state = S(b.state, 20), zip = S(b.zip, 20);
  if (!addr1 || !city || !state || !zip) return res.status(400).json({ error: 'Ship-to street, city, state, and ZIP are required' });
  const recipient = S(b.recipientName), company = S(b.company);
  if (!recipient && !company) return res.status(400).json({ error: 'Recipient name or company is required' });

  const record = {
    Shipment_ID: buildShipmentId(),
    Submission_ID: sanitizeId(b.submissionId) || '',
    Requested_By: S(b.requestedBy, 120),
    Sales_Rep: S(b.salesRep, 80),
    Recipient_Name: recipient,
    Company: company,
    Address1: addr1, Address2: S(b.address2), City: city, State: state, Zip: zip,
    Phone: S(b.phone, 60), Email: S(b.email),
    Items_JSON: JSON.stringify(items.map((it) => ({ code: S(it.code, 60), label: S(it.label, 120), qty: Number(it.qty) > 0 ? Number(it.qty) : 1 }))),
    Notes: S(b.notes, 1000),
    Status: 'Requested',
    ShipStation_Order_ID: '', Tracking_Number: '', Carrier: '',
    Shipped_At: null, // Date/Time: null, never '' (Caspio 400s on empty-string dates)
    Created_At: nowIso(), Updated_At: nowIso(), Updated_By: S(b.requestedBy, 120),
  };
  try {
    await makeCaspioRequest('post', SHIPMENTS_PATH, {}, record);
    console.log(`[marketing-shipments] created ${record.Shipment_ID} for "${company || recipient}" (${items.length} items)`);
    res.status(201).json({ shipmentId: record.Shipment_ID });
  } catch (e) {
    console.error('[marketing-shipments] create failed:', e.message);
    res.status(502).json({ error: 'Could not save the kit request' });
  }
});

// PUT /:shipmentId — Mikalah marks packed / shipped (+ tracking). On the Shipped
// transition, stamp Shipped_At (if absent) and log the lead's timeline server-side.
router.put('/:shipmentId', async (req, res) => {
  const id = sanitizeId(req.params.shipmentId);
  if (!id) return res.status(400).json({ error: 'Invalid shipment id' });
  const b = req.body || {};
  const ALLOWED = ['Status', 'Tracking_Number', 'Carrier', 'Shipped_At', 'Notes', 'ShipStation_Order_ID', 'Updated_By'];
  const CAPS = { Carrier: 60, Tracking_Number: 120, Notes: 1000, Updated_By: 120 };
  const updates = {};
  for (const k of ALLOWED) if (b[k] !== undefined) updates[k] = S(b[k], CAPS[k]);
  if (updates.Status && !STATUSES.has(updates.Status)) return res.status(400).json({ error: 'Invalid status' });
  if (!Object.keys(updates).length) return res.status(400).json({ error: 'No updatable fields supplied' });

  const shipping = updates.Status === 'Shipped';
  if (shipping && !updates.Shipped_At) updates.Shipped_At = nowIso();
  updates.Updated_At = nowIso();

  try {
    // Fetch the row first (need Submission_ID + fields for the timeline entry).
    const rows = await fetchAllCaspioPages(SHIPMENTS_PATH, { 'q.where': `Shipment_ID='${id}'`, 'q.pageSize': 1 }, { maxPages: 1 });
    const row = Array.isArray(rows) ? rows[0] : null;
    if (!row) return res.status(404).json({ error: `Shipment '${id}' not found` });

    const result = await caspioPut(SHIPMENTS_PATH, `Shipment_ID='${id}'`, updates);
    if (!result.RecordsAffected) return res.status(404).json({ error: `Shipment '${id}' not found` });

    // Server-side timeline breadcrumb on ship (so it can never be skipped).
    if (shipping && row.Submission_ID) {
      const track = updates.Tracking_Number || row.Tracking_Number || '';
      const carrier = updates.Carrier || row.Carrier || '';
      makeCaspioRequest('post', ACTIVITY_PATH, {}, {
        Submission_ID: row.Submission_ID,
        Activity_Type: 'system',
        Activity_Text: `Marketing kit ${id} shipped${carrier ? ' via ' + carrier : ''}${track ? ' — ' + track : ''}`,
        Attachment_URL: '',
        Created_By: updates.Updated_By || 'shipping',
        Created_At: nowIso(),
        Parent_PK: null,
      }).catch((e) => console.warn('[marketing-shipments] ship activity log failed:', e.message));
    }
    res.json({ updated: id, fields: updates });
  } catch (e) {
    console.error('[marketing-shipments] update failed:', e.message);
    res.status(502).json({ error: 'Shipment update failed' });
  }
});

module.exports = router;
