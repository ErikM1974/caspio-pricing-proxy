// jim-mailing-list.js — the owner's ("Jim's") manual prospect / mailing list.
// Simple CRUD against the standalone Caspio `Prospect_Mailing_List` table:
//
//   GET    /api/jim-mailing-list        — every entry (A→Z by Company)
//   GET    /api/jim-mailing-list/:id     — one entry by PK_ID
//   POST   /api/jim-mailing-list        — add a company (Company required)
//   PUT    /api/jim-mailing-list/:id     — edit an entry (partial)
//   DELETE /api/jim-mailing-list/:id     — remove an entry
//
// Deliberately NOT the Leads CRM (Form_Submissions) — a passive list Jim keeps,
// with zero AE routing / Slack / digest side effects. Holds contact info, so the
// whole mount is CRM-secret-only (server.js); staff reach it through the main
// app's session-gated /api/crm-proxy/jim-mailing-list* forwarder, which stamps
// Added_By / Updated_By from the verified session (never trusted from the body).
'use strict';
const express = require('express');
const router = express.Router();
const { fetchAllCaspioPages, makeCaspioRequest, putWithRecordsAffected } = require('../utils/caspio');
const { S, nowIso } = require('../utils/form-submission-helpers');

const TABLE_PATH = '/tables/Prospect_Mailing_List/records';
const FIELDS = 'PK_ID,Company,Contact_Name,Address,City,State,Zip,Phone,Email,Source,Website,Category,Notes,Bigin_Id,Added_By,Created_At,Updated_At,Updated_By';

// Field length caps — Notes is TEXT (64K) so it gets a generous cap; the rest are
// Caspio STRING (255). Company is the only required field.
const CAPS = {
  Company: 150, Contact_Name: 120, Address: 200, City: 100, State: 40,
  Zip: 20, Phone: 40, Email: 150, Source: 120, Website: 200, Category: 120,
  Notes: 8000, Added_By: 120, Updated_By: 120,
};
// Bigin_Id is intentionally NOT editable — it's read-only import provenance.
const EDITABLE = ['Company', 'Contact_Name', 'Address', 'City', 'State', 'Zip', 'Phone', 'Email', 'Source', 'Website', 'Category', 'Notes'];

// PK_ID is a positive integer autonumber. Guard before embedding in q.where.
function parseId(raw) {
  const n = parseInt(raw, 10);
  return Number.isInteger(n) && n > 0 && String(n) === String(raw) ? n : null;
}

// GET / — the whole list, alphabetical by Company (PK_ID as the stable tiebreaker
// so multi-page ordering can't silently drop rows). The list is small; the page
// searches client-side, so no q.where here (nothing user-supplied is interpolated).
router.get('/', async (req, res) => {
  try {
    const rows = await fetchAllCaspioPages(
      TABLE_PATH,
      { 'q.select': FIELDS, 'q.orderBy': 'Company, PK_ID', 'q.pageSize': 500 },
      { maxPages: 20 }
    );
    res.json({ entries: rows || [] });
  } catch (e) {
    console.error('[jim-mailing-list] list failed:', e.message);
    res.status(502).json({ error: 'Mailing list lookup failed' });
  }
});

// GET /:id — one entry (unused by the page today, but completes the CRUD surface).
router.get('/:id', async (req, res) => {
  const id = parseId(req.params.id);
  if (!id) return res.status(400).json({ error: 'Invalid id' });
  try {
    const rows = await fetchAllCaspioPages(TABLE_PATH, { 'q.select': FIELDS, 'q.where': `PK_ID=${id}` }, { maxPages: 1 });
    const row = Array.isArray(rows) ? rows[0] : null;
    if (!row) return res.status(404).json({ error: `Entry ${id} not found` });
    res.json({ entry: row });
  } catch (e) {
    console.error('[jim-mailing-list] get failed:', e.message);
    res.status(502).json({ error: 'Mailing list lookup failed' });
  }
});

// POST / — add a company. Company is required; everything else optional.
router.post('/', async (req, res) => {
  const b = req.body || {};
  const company = S(b.Company, CAPS.Company);
  if (!company) return res.status(400).json({ error: 'Company name is required' });

  const record = { Company: company };
  for (const k of EDITABLE) if (k !== 'Company') record[k] = S(b[k], CAPS[k]);
  const stamp = nowIso();
  record.Added_By = S(b.Added_By, CAPS.Added_By);
  record.Updated_By = S(b.Updated_By, CAPS.Updated_By) || record.Added_By;
  record.Created_At = stamp;
  record.Updated_At = stamp;

  try {
    const result = await makeCaspioRequest('post', TABLE_PATH, {}, record);
    console.log(`[jim-mailing-list] added "${company}" (PK ${result.PK_ID || '?'})`);
    res.status(201).json({ created: { ...record, PK_ID: result.PK_ID } });
  } catch (e) {
    console.error('[jim-mailing-list] create failed:', e.message);
    res.status(502).json({ error: 'Could not save the company' });
  }
});

// PUT /:id — partial edit. putWithRecordsAffected (plain PUT can return Result:[]
// and hide RecordsAffected) → RecordsAffected 0 means no such row → 404.
router.put('/:id', async (req, res) => {
  const id = parseId(req.params.id);
  if (!id) return res.status(400).json({ error: 'Invalid id' });
  const b = req.body || {};
  const updates = {};
  for (const k of EDITABLE) if (b[k] !== undefined) updates[k] = S(b[k], CAPS[k]);
  if ('Company' in updates && !updates.Company) return res.status(400).json({ error: 'Company name cannot be blank' });
  if (!Object.keys(updates).length) return res.status(400).json({ error: 'No fields to update' });
  updates.Updated_At = nowIso();
  if (b.Updated_By !== undefined) updates.Updated_By = S(b.Updated_By, CAPS.Updated_By);

  try {
    const result = await putWithRecordsAffected(TABLE_PATH, `PK_ID=${id}`, updates);
    if (!result.RecordsAffected) return res.status(404).json({ error: `Entry ${id} not found` });
    res.json({ updated: id, fields: updates });
  } catch (e) {
    console.error('[jim-mailing-list] update failed:', e.message);
    res.status(502).json({ error: 'Mailing list update failed' });
  }
});

// DELETE /:id — Caspio answers 200 RecordsAffected:0 on a no-match (never 404,
// never throws) — check the count so a no-op delete can't fake success.
router.delete('/:id', async (req, res) => {
  const id = parseId(req.params.id);
  if (!id) return res.status(400).json({ error: 'Invalid id' });
  try {
    const result = await makeCaspioRequest('delete', TABLE_PATH, { 'q.where': `PK_ID=${id}` });
    if (!result || !result.RecordsAffected) return res.status(404).json({ error: `Entry ${id} not found` });
    console.log(`[jim-mailing-list] deleted PK ${id}`);
    res.json({ deleted: id });
  } catch (e) {
    console.error('[jim-mailing-list] delete failed:', e.message);
    res.status(502).json({ error: 'Mailing list delete failed' });
  }
});

module.exports = router;
