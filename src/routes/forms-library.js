// forms-library.js — Erik-editable registry of printable/fillable company forms
// (Caspio `Forms_Library` table) surfaced on /dashboards/forms-library.html.
// Reads are public (staff page fetches client-side, same model as service-codes);
// writes are blocked at the mount by gateWritesOnly. Add a row in Caspio → form
// appears in the library with no deploy.
'use strict';
const express = require('express');
const router = express.Router();
const { fetchAllCaspioPages, makeCaspioRequest, putWithRecordsAffected } = require('../utils/caspio');

const TABLE_PATH = '/tables/Forms_Library/records';
const FIELDS = 'PK_ID,Form_ID,Form_Name,Description,Category,PDF_URL,Fill_Online_URL,Sort_Order,Is_Active';

// 60s cache — forms list is near-static; on Caspio failure we ERROR (no stale
// fallback) so the page shows its error banner instead of a silently wrong list.
let cache = null;
let cacheAt = 0;
const CACHE_TTL = 60 * 1000;
const clearCache = () => { cache = null; cacheAt = 0; };

// Form_ID is a strict slug — also makes it safe to embed in q.where.
const sanitizeFormId = (v) => (typeof v === 'string' && /^[A-Za-z0-9-]{1,80}$/.test(v) ? v : null);

async function fetchForms() {
  if (cache && Date.now() - cacheAt < CACHE_TTL) return cache;
  const rows = await fetchAllCaspioPages(TABLE_PATH, { 'q.select': FIELDS, 'q.pageSize': 200 });
  cache = rows || [];
  cacheAt = Date.now();
  return cache;
}

// GET /api/forms-library → { forms: [...] } active only, sorted Category → Sort_Order.
// ?all=true includes inactive rows (admin/maintenance view).
router.get('/', async (req, res) => {
  try {
    let forms = await fetchForms();
    if (req.query.all !== 'true') {
      forms = forms.filter(f => String(f.Is_Active).trim().toLowerCase() === 'yes');
    }
    forms = [...forms].sort((a, b) =>
      String(a.Category).localeCompare(String(b.Category)) ||
      (parseInt(a.Sort_Order, 10) || 0) - (parseInt(b.Sort_Order, 10) || 0) ||
      String(a.Form_Name).localeCompare(String(b.Form_Name)));
    res.json({ forms });
  } catch (e) {
    console.error('[forms-library] list failed:', e.message);
    res.status(502).json({ error: 'Forms library lookup failed' });
  }
});

// POST /api/forms-library → create (gateWritesOnly at mount)
router.post('/', async (req, res) => {
  const b = req.body || {};
  const formId = sanitizeFormId(b.Form_ID);
  if (!formId || !b.Form_Name || !b.PDF_URL) {
    return res.status(400).json({ error: 'Form_ID (slug: letters/digits/dashes), Form_Name and PDF_URL are required' });
  }
  const record = {
    Form_ID: formId,
    Form_Name: String(b.Form_Name),
    Description: String(b.Description || ''),
    Category: String(b.Category || 'General'),
    PDF_URL: String(b.PDF_URL),
    Fill_Online_URL: String(b.Fill_Online_URL || ''),
    Sort_Order: String(parseInt(b.Sort_Order, 10) || 0),
    Is_Active: String(b.Is_Active || 'Yes'),
  };
  try {
    await makeCaspioRequest('post', TABLE_PATH, {}, record);
    clearCache();
    res.status(201).json({ created: record });
  } catch (e) {
    console.error('[forms-library] create failed:', e.message);
    res.status(502).json({ error: 'Forms library create failed' });
  }
});

// PUT /api/forms-library/:formId → partial update by slug (gateWritesOnly at mount)
router.put('/:formId', async (req, res) => {
  const formId = sanitizeFormId(req.params.formId);
  if (!formId) return res.status(400).json({ error: 'Invalid form id' });
  const ALLOWED = ['Form_Name', 'Description', 'Category', 'PDF_URL', 'Fill_Online_URL', 'Sort_Order', 'Is_Active'];
  const updates = {};
  for (const k of ALLOWED) if (req.body && req.body[k] !== undefined) updates[k] = String(req.body[k]);
  if (!Object.keys(updates).length) return res.status(400).json({ error: 'No updatable fields supplied' });
  try {
    // putWithRecordsAffected: makeCaspioRequest can return Result:[] and lose RecordsAffected (2026-07-11)
    const result = await putWithRecordsAffected(TABLE_PATH, `Form_ID='${formId}'`, updates);
    if (!result.RecordsAffected) return res.status(404).json({ error: `Form '${formId}' not found` });
    clearCache();
    res.json({ updated: formId, fields: updates });
  } catch (e) {
    console.error('[forms-library] update failed:', e.message);
    res.status(502).json({ error: 'Forms library update failed' });
  }
});

// DELETE /api/forms-library/:formId (gateWritesOnly at mount).
// Caspio returns 200 RecordsAffected:0 on no-match — map that to 404, never fake success.
router.delete('/:formId', async (req, res) => {
  const formId = sanitizeFormId(req.params.formId);
  if (!formId) return res.status(400).json({ error: 'Invalid form id' });
  try {
    const result = await makeCaspioRequest('delete', TABLE_PATH, { 'q.where': `Form_ID='${formId}'` });
    if (!result || !result.RecordsAffected) return res.status(404).json({ error: `Form '${formId}' not found` });
    clearCache();
    res.json({ deleted: formId });
  } catch (e) {
    console.error('[forms-library] delete failed:', e.message);
    res.status(502).json({ error: 'Forms library delete failed' });
  }
});

module.exports = router;
