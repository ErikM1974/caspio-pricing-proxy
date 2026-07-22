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
const Anthropic = require('@anthropic-ai/sdk');
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

// ── AI capture — paste text and/or a screenshot; Claude extracts the fields ──
// Lazy Anthropic client (same pattern as src/routes/vision.js). Haiku is plenty
// for a directory-listing extraction and keeps the per-use cost tiny; bump the
// model if extraction quality on messy pages isn't good enough.
let anthropicClient = null;
function getAnthropic() {
  if (!anthropicClient) {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) throw new Error('ANTHROPIC_API_KEY not configured');
    anthropicClient = new Anthropic({ apiKey });
  }
  return anthropicClient;
}
const EXTRACT_MODEL = 'claude-haiku-4-5-20251001';
const EXTRACT_FIELDS = ['company', 'contact_name', 'address', 'city', 'state', 'zip', 'phone', 'email', 'website', 'category', 'notes'];
const EXTRACT_PROMPT = `You are helping an office assistant add a business PROSPECT to a mailing list. You are given text copied from a web page / directory listing and/or a screenshot of one. Extract the company's contact details.

Return ONLY valid JSON (no markdown fencing, no commentary) with this EXACT shape:
{
  "company": "",       // the business / company name
  "contact_name": "",  // a person's name if shown (owner, manager, rep). Add their title in parentheses if given, e.g. "Justin Kasarda (General Manager)"
  "address": "",       // street address only, e.g. "2106 Tacoma Ave S"
  "city": "",
  "state": "",         // 2-letter state code when possible, e.g. "WA"
  "zip": "",
  "phone": "",         // main phone number
  "email": "",         // email address if shown
  "website": "",       // website URL if shown
  "category": "",      // type of business / industry if shown, e.g. "Printing Services"
  "notes": ""          // anything else useful and short: a fax or cell number, a second contact, hours, a tagline
}

Rules:
- Use an empty string "" for anything you cannot find. NEVER guess or invent a phone, email, or address.
- The company name matters most. If you genuinely cannot find one, return "company": "".
- If the input is clearly not about a business, return every field as "".`;

// POST /api/jim-mailing-list/extract — { text?, image? (data URI) } → { fields }
// Does NOT write anything: it only returns extracted fields for the page to
// pre-fill so Jim can review and then Save through the normal POST.
router.post('/extract', async (req, res) => {
  const b = req.body || {};
  const text = typeof b.text === 'string' ? b.text.trim().slice(0, 12000) : '';
  const image = typeof b.image === 'string' ? b.image.trim() : '';
  if (!text && !image) return res.status(400).json({ error: 'Paste some text or a screenshot first.' });

  const content = [];
  if (image) {
    let mediaType = 'image/jpeg', data = image;
    if (image.startsWith('data:')) {
      const m = image.match(/^data:(image\/\w+);base64,(.+)$/);
      if (!m) return res.status(400).json({ error: 'That image could not be read — try copying it again.' });
      mediaType = m[1]; data = m[2];
    }
    content.push({ type: 'image', source: { type: 'base64', media_type: mediaType, data } });
  }
  if (text) content.push({ type: 'text', text: 'Copied text:\n\n' + text });
  content.push({ type: 'text', text: EXTRACT_PROMPT });

  let client;
  try { client = getAnthropic(); }
  catch (e) { return res.status(503).json({ error: 'The Claude helper is not set up on the server yet.' }); }

  try {
    const resp = await client.messages.create({ model: EXTRACT_MODEL, max_tokens: 1024, messages: [{ role: 'user', content }] });
    const rawText = (resp.content[0] && resp.content[0].text || '').trim();
    let parsed;
    try {
      parsed = JSON.parse(rawText.replace(/^```json?\s*\n?/i, '').replace(/\n?```\s*$/i, ''));
    } catch (e) {
      console.error('[jim-mailing-list] extract parse failed:', rawText.slice(0, 200));
      return res.status(502).json({ error: 'Claude could not read that. Try pasting the company info again.' });
    }
    const fields = {};
    EXTRACT_FIELDS.forEach((k) => { fields[k] = typeof parsed[k] === 'string' ? parsed[k].trim() : ''; });
    console.log(`[jim-mailing-list] extracted "${fields.company || '(no company found)'}"`);
    res.json({ fields });
  } catch (e) {
    console.error('[jim-mailing-list] extract failed:', e.message);
    res.status(502).json({ error: 'The Claude helper had a problem — please try again.' });
  }
});

module.exports = router;
