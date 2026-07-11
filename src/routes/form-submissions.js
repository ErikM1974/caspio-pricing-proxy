// form-submissions.js — saved fillable-form submissions (Form_Submissions +
// Sample_Checkout_Items Caspio tables) powering the staff Forms Inbox
// (/dashboards/form-submissions.html in the Pricing Index repo).
//
// Gating (at the server.js mount): POST is public (same trust model as quote
// saves — the fillable twins are used at the front counter without a login);
// GET/PUT are requireCrmApiSecret-only because submissions hold customer
// contact info — staff reach them through the session-gated /api/crm-proxy.
//
// ⚠️ sample-checkout payloads NEVER store card data. The twin strips card
// fields client-side and stripCardFields() re-strips here — jest-locked in
// tests/jest/form-submissions-cardstrip.test.js.
'use strict';
const express = require('express');
const rateLimit = require('express-rate-limit');
const router = express.Router();
// putWithRecordsAffected (NOT makeCaspioRequest) for PUTs — preserves RecordsAffected
// so a real update is distinguishable from a no-match (utils/caspio.js, 2026-07-11).
const { fetchAllCaspioPages, makeCaspioRequest, putWithRecordsAffected: caspioPut } = require('../utils/caspio');

// Pure helpers live in utils/form-submission-helpers.js (no caspio-utils import)
// so the jest suite can test them without inheriting api-tracker's open timer.
const {
  FORM_PREFIX, DEFAULT_STATUS, stripCardFields, sanitizeId, sanitizeLike,
  isoDay, nowIso, S, buildSubmissionId, validateSubmission,
} = require('../utils/form-submission-helpers');

const SUBMISSIONS_PATH = '/tables/Form_Submissions/records';
const ITEMS_PATH = '/tables/Sample_Checkout_Items/records';

// POST is public — keep a lid on abuse (the twins are quiet pages; 20/5min/IP is generous).
const submitLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many form submissions — wait a few minutes and try again.' },
});

// POST /api/form-submissions → { submissionId }
router.post('/', submitLimiter, async (req, res) => {
  const body = req.body || {};
  const errors = validateSubmission(body);
  if (errors.length) return res.status(400).json({ error: errors.join('; ') });

  const formId = body.formId;
  let payload = body.payload;
  if (formId === 'sample-checkout') payload = stripCardFields(payload);

  const record = {
    Submission_ID: buildSubmissionId(formId),
    Form_ID: formId,
    Company: S(body.company),
    Contact_Name: S(body.contactName),
    Phone: S(body.phone, 60),
    Email: S(body.email),
    Customer_Number: S(body.customerNumber, 40),
    Sales_Rep: S(body.salesRep, 80),
    Due_Date: isoDay(body.dueDateIso),
    Status: DEFAULT_STATUS[formId],
    Summary: S(body.summary, 250),
    Payload_JSON: JSON.stringify(payload),
    Submitted_At: nowIso(),
    Updated_At: nowIso(),
    Updated_By: '',
    Art_Request_ID: '',
  };

  try {
    try {
      await makeCaspioRequest('post', SUBMISSIONS_PATH, {}, record);
    } catch (e) {
      // one retry on the (rare) Submission_ID collision
      record.Submission_ID = buildSubmissionId(formId);
      await makeCaspioRequest('post', SUBMISSIONS_PATH, {}, record);
    }

    if (formId === 'sample-checkout' && Array.isArray(body.items)) {
      let line = 0;
      for (const item of body.items) {
        line += 1;
        await makeCaspioRequest('post', ITEMS_PATH, {}, {
          Submission_ID: record.Submission_ID,
          Line_Number: String(line),
          Source: S(item.source, 60),
          Brand: S(item.brand, 80),
          Style: S(item.style, 60),
          Description: S(item.description),
          Color: S(item.color, 60),
          Size: S(item.size, 30),
          Qty: S(item.qty, 20),
          Retail_Value: S(item.retailValue, 20),
          Charge_Value: S(item.chargeValue, 20),
          Item_Status: 'Out',
          Date_Returned: '',
          Condition: '',
          Checked_In_By: '',
        });
      }
    }

    console.log(`[form-submissions] saved ${record.Submission_ID} (${formId}) for "${record.Company}"`);
    res.status(201).json({ submissionId: record.Submission_ID });
  } catch (e) {
    console.error('[form-submissions] save failed:', e.message);
    res.status(502).json({ error: 'Save failed — the form was NOT stored. Print a paper copy and try again later.' });
  }
});

// GET /api/form-submissions?form=&status=&q=&limit= → { submissions } (secret-gated at mount)
router.get('/', async (req, res) => {
  try {
    const where = [];
    if (req.query.form && FORM_PREFIX[req.query.form]) where.push(`Form_ID='${req.query.form}'`);
    const status = sanitizeLike(req.query.status);
    if (status) where.push(`Status='${status}'`);
    const q = sanitizeLike(req.query.q);
    if (q) where.push(`(Company LIKE '%${q}%' OR Contact_Name LIKE '%${q}%' OR Submission_ID LIKE '%${q}%')`);

    const params = { 'q.pageSize': 200, 'q.orderBy': 'Submitted_At DESC' };
    if (where.length) params['q.where'] = where.join(' AND ');

    const rows = await fetchAllCaspioPages(SUBMISSIONS_PATH, params, { maxPages: 3 });
    res.json({ submissions: rows || [] });
  } catch (e) {
    console.error('[form-submissions] list failed:', e.message);
    res.status(502).json({ error: 'Submissions lookup failed' });
  }
});

// GET /api/form-submissions/items/open → all not-yet-returned sample items (tracker view)
router.get('/items/open', async (req, res) => {
  try {
    const items = await fetchAllCaspioPages(ITEMS_PATH, {
      'q.where': "Item_Status='Out'",
      'q.pageSize': 500,
    });
    res.json({ items: items || [] });
  } catch (e) {
    console.error('[form-submissions] open-items failed:', e.message);
    res.status(502).json({ error: 'Open-items lookup failed' });
  }
});

// GET /api/form-submissions/:submissionId → { submission, items }
router.get('/:submissionId', async (req, res) => {
  const id = sanitizeId(req.params.submissionId);
  if (!id) return res.status(400).json({ error: 'Invalid submission id' });
  try {
    const rows = await fetchAllCaspioPages(SUBMISSIONS_PATH, { 'q.where': `Submission_ID='${id}'`, 'q.pageSize': 25 }, { maxPages: 1 });
    if (!rows || !rows.length) return res.status(404).json({ error: `Submission '${id}' not found` });
    const submission = rows[0];
    let items = [];
    if (submission.Form_ID === 'sample-checkout') {
      items = await fetchAllCaspioPages(ITEMS_PATH, { 'q.where': `Submission_ID='${id}'`, 'q.pageSize': 100 }, { maxPages: 1 });
    }
    res.json({ submission, items: items || [] });
  } catch (e) {
    console.error('[form-submissions] detail failed:', e.message);
    res.status(502).json({ error: 'Submission lookup failed' });
  }
});

// PUT /api/form-submissions/items/:pkId → check an item in/out (then roll up parent status)
router.put('/items/:pkId', async (req, res) => {
  const pk = String(req.params.pkId);
  if (!/^\d{1,12}$/.test(pk)) return res.status(400).json({ error: 'Invalid item id' });
  const ALLOWED = ['Item_Status', 'Date_Returned', 'Condition', 'Checked_In_By'];
  const updates = {};
  for (const k of ALLOWED) if (req.body && req.body[k] !== undefined) updates[k] = S(req.body[k]);
  if (updates.Item_Status && !['Out', 'Returned', 'Charged'].includes(updates.Item_Status)) {
    return res.status(400).json({ error: 'Item_Status must be Out, Returned or Charged' });
  }
  if (!Object.keys(updates).length) return res.status(400).json({ error: 'No updatable fields supplied' });

  try {
    // read the row first so we know which submission to roll up
    const rows = await fetchAllCaspioPages(ITEMS_PATH, { 'q.where': `PK_ID=${pk}`, 'q.pageSize': 25 }, { maxPages: 1 });
    if (!rows || !rows.length) return res.status(404).json({ error: `Item ${pk} not found` });
    const submissionId = rows[0].Submission_ID;

    const result = await caspioPut(ITEMS_PATH, `PK_ID=${pk}`, updates);
    if (!result.RecordsAffected) return res.status(404).json({ error: `Item ${pk} not found` });

    // roll the parent status up from its items
    const siblings = await fetchAllCaspioPages(ITEMS_PATH, { 'q.where': `Submission_ID='${submissionId}'`, 'q.pageSize': 100 }, { maxPages: 1 });
    const total = siblings.length;
    const out = siblings.filter(i => i.Item_Status === 'Out').length;
    const parentStatus = out === total ? 'Checked Out' : (out === 0 ? 'Returned' : 'Partially Returned');
    await caspioPut(SUBMISSIONS_PATH, `Submission_ID='${submissionId}'`,
      { Status: parentStatus, Updated_At: nowIso(), Updated_By: S(req.body && req.body.Checked_In_By) });

    res.json({ updated: Number(pk), submissionId, parentStatus });
  } catch (e) {
    console.error('[form-submissions] item update failed:', e.message);
    res.status(502).json({ error: 'Item update failed' });
  }
});

// PUT /api/form-submissions/:submissionId → status / art-link updates
router.put('/:submissionId', async (req, res) => {
  const id = sanitizeId(req.params.submissionId);
  if (!id) return res.status(400).json({ error: 'Invalid submission id' });
  const ALLOWED = ['Status', 'Updated_By', 'Art_Request_ID', 'Due_Date'];
  const updates = {};
  for (const k of ALLOWED) if (req.body && req.body[k] !== undefined) updates[k] = S(req.body[k]);
  if (!Object.keys(updates).length) return res.status(400).json({ error: 'No updatable fields supplied' });
  updates.Updated_At = nowIso();

  try {
    const result = await caspioPut(SUBMISSIONS_PATH, `Submission_ID='${id}'`, updates);
    if (!result.RecordsAffected) return res.status(404).json({ error: `Submission '${id}' not found` });
    res.json({ updated: id, fields: updates });
  } catch (e) {
    console.error('[form-submissions] update failed:', e.message);
    res.status(502).json({ error: 'Submission update failed' });
  }
});

// POST /api/form-submissions/:submissionId/push-to-shopworks — secret-gated at the
// mount (only the bare save POST is public). AE Order Intake only. Verified rows
// (SanMar catalog color captured) become ShopWorks line items via the generic
// manageorders-push-client; everything else rides in Notes On Order. Dup-guarded.
router.post('/:submissionId/push-to-shopworks', async (req, res) => {
  const id = sanitizeId(req.params.submissionId);
  if (!id) return res.status(400).json({ error: 'Invalid submission id' });
  const force = !!(req.body && req.body.force);
  const isTest = !!(req.body && req.body.isTest);
  const staff = S(req.body && req.body.staffEmail, 120);

  try {
    const rows = await fetchAllCaspioPages(SUBMISSIONS_PATH, { 'q.where': `Submission_ID='${id}'`, 'q.pageSize': 25 }, { maxPages: 1 });
    if (!rows || !rows.length) return res.status(404).json({ error: `Submission '${id}' not found` });
    const submission = rows[0];

    if (submission.Form_ID !== 'ae-order-intake') {
      return res.status(400).json({ error: 'Only AE Order Intake submissions can push to ShopWorks' });
    }
    if (submission.Pushed_To_ShopWorks === 'Yes' && !force) {
      return res.status(409).json({
        error: `Already pushed (${submission.ShopWorks_Order_ID || 'order id unknown'}) — refusing duplicate`,
        shopworksOrderId: submission.ShopWorks_Order_ID || '',
      });
    }

    let payload = {};
    try { payload = JSON.parse(submission.Payload_JSON || '{}'); } catch (_) { /* handled below */ }

    const { buildAeoOrderData } = require('../utils/aeo-push-transformer');
    const built = buildAeoOrderData(submission, payload, { isTest });

    if (!built.orderData.lineItems.length) {
      return res.status(400).json({
        error: 'No pushable line items — every row is missing a SanMar-verified color, sizes or a price. Fix the rows or enter the order by hand.',
        skippedRows: built.skippedRows,
        warnings: built.warnings,
      });
    }

    const { pushOrder } = require('../../lib/manageorders-push-client');
    const result = await pushOrder(built.orderData);
    const extOrderId = (result && (result.extOrderID || result.ExtOrderID)) || ('NWCA-' + built.orderData.orderNumber);

    await caspioPut(SUBMISSIONS_PATH, `Submission_ID='${id}'`, {
      Pushed_To_ShopWorks: 'Yes',
      ShopWorks_Order_ID: extOrderId,
      Status: 'Entered in ShopWorks',
      Updated_At: nowIso(),
      Updated_By: staff,
    });

    console.log(`[form-submissions] pushed ${id} → ShopWorks as ${extOrderId} (${built.orderData.lineItems.length} lines, ${built.skippedRows.length} skipped)`);
    res.json({
      pushed: true,
      extOrderId,
      lineCount: built.orderData.lineItems.length,
      verifiedLines: built.verifiedLines,
      skippedRows: built.skippedRows,
      warnings: built.warnings,
    });
  } catch (e) {
    console.error('[form-submissions] shopworks push failed:', e.message);
    res.status(502).json({ error: 'ShopWorks push FAILED — nothing was marked pushed. ' + e.message });
  }
});

module.exports = router;
