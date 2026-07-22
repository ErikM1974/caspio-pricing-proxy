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
const mailchimp = require('../utils/mailchimp-client');
const { fetchAllCaspioPages, makeCaspioRequest, putWithRecordsAffected } = require('../utils/caspio');
const { S, nowIso } = require('../utils/form-submission-helpers');

// Which Mailchimp audience Jim's prospects sync into (resolved by NAME → List ID).
const MAILCHIMP_AUDIENCE = process.env.MAILCHIMP_AUDIENCE || "Jim's Prospects";

const TABLE_PATH = '/tables/Prospect_Mailing_List/records';
const FIELDS = 'PK_ID,Company,Contact_Name,First_Name,Last_Name,Address,City,State,Zip,Phone,Email,Source,Website,Category,Notes,Bigin_Id,Status,Last_Mailed_At,Mailchimp_Status,Mailchimp_Last_Sent,Mailchimp_Sent_Count,Added_By,Created_At,Updated_At,Updated_By';

// Field length caps — Notes is TEXT (64K) so it gets a generous cap; the rest are
// Caspio STRING (255). Company is the only required field.
const CAPS = {
  Company: 150, Contact_Name: 120, First_Name: 80, Last_Name: 80, Address: 200, City: 100, State: 40,
  Zip: 20, Phone: 40, Email: 150, Source: 120, Website: 200, Category: 120,
  Notes: 8000, Status: 40, Last_Mailed_At: 40, Added_By: 120, Updated_By: 120,
};
// Bigin_Id + Mailchimp_* are NOT editable from the page — provenance / set by the Mailchimp sync.
const EDITABLE = ['Company', 'Contact_Name', 'First_Name', 'Last_Name', 'Address', 'City', 'State', 'Zip', 'Phone', 'Email', 'Source', 'Website', 'Category', 'Notes', 'Status', 'Last_Mailed_At'];

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
const EXTRACT_FIELDS = ['company', 'first_name', 'last_name', 'address', 'city', 'state', 'zip', 'phone', 'email', 'website', 'category', 'notes'];
const EXTRACT_PROMPT = `You are helping an office assistant add a business PROSPECT to a mailing list. You are given text copied from a web page / directory listing and/or a screenshot of one. Extract the company's contact details.

Return ONLY valid JSON (no markdown fencing, no commentary) with this EXACT shape:
{
  "company": "",       // the business / company name
  "first_name": "",    // a contact person's first name if shown (owner, manager, rep)
  "last_name": "",     // that person's last name
  "address": "",       // street address only, e.g. "2106 Tacoma Ave S"
  "city": "",
  "state": "",         // 2-letter state code when possible, e.g. "WA"
  "zip": "",
  "phone": "",         // main phone number
  "email": "",         // email address if shown
  "website": "",       // website URL if shown
  "category": "",      // type of business / industry if shown, e.g. "Printing Services"
  "notes": ""          // anything else useful and short: a job title, a fax or cell number, a second contact, hours, a tagline
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

// ── Mailchimp (Phase 2) ───────────────────────────────────────────────────
// All three are reached (staff-gated) through the app's /api/crm-proxy forwarder.
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
function nameParts(r) {
  var first = (r.First_Name || '').trim(), last = (r.Last_Name || '').trim();
  if (!first && !last && r.Contact_Name) {
    var nm = r.Contact_Name.replace(/\s*\(.*\)\s*$/, '').trim().split(/\s+/);
    first = nm.shift() || '';
    last = nm.join(' ');
  }
  return { first: first, last: last };
}
function mcErr(e) {
  return e.response ? (e.response.status + ' ' + ((e.response.data && (e.response.data.detail || e.response.data.title)) || '')) : e.message;
}

// GET /mailchimp/status — connection test + audience summary (the "Test connection" button)
router.get('/mailchimp/status', async (req, res) => {
  if (!process.env.MAILCHIMP_API_KEY) return res.json({ ok: false, configured: false, error: 'No Mailchimp API key is set on the server yet.' });
  try {
    await mailchimp.ping();
    const aud = await mailchimp.findAudience(MAILCHIMP_AUDIENCE);
    res.json({ ok: true, configured: true, dc: mailchimp.cfg().dc, audience: { name: aud.displayName || MAILCHIMP_AUDIENCE, members: aud.members } });
  } catch (e) {
    console.warn('[jim-mailing-list] mailchimp status:', mcErr(e));
    res.json({ ok: false, configured: true, error: mcErr(e), audiences: e.audiences || undefined });
  }
});

// POST /mailchimp/sync — add ONLY the contacts the page sends (the group Erik is
// filtered to), so he controls how many land in Mailchimp (it's billed per contact).
// Each must have a valid email; staged as 'transactional' (not emailable until
// subscribed); tagged by segment. Body: { members: [{email,first,last,company,...,tag}] }.
router.post('/mailchimp/sync', async (req, res) => {
  if (!process.env.MAILCHIMP_API_KEY) return res.status(503).json({ error: 'No Mailchimp API key is set on the server yet.' });
  const incoming = Array.isArray(req.body && req.body.members) ? req.body.members : null;
  if (!incoming || !incoming.length) return res.status(400).json({ error: 'No contacts to sync — pick a group first.' });
  if (incoming.length > 2000) return res.status(400).json({ error: 'That is a lot at once (max 2,000) — filter to a smaller group so you do not blow past your Mailchimp plan.' });
  try {
    const members = [];
    let noEmail = 0;
    incoming.forEach((m) => {
      const email = S(m && m.email, 150);
      if (!EMAIL_RE.test(email)) { noEmail++; return; }
      members.push({
        email: email, first: S(m.first, 80), last: S(m.last, 80), company: S(m.company, 150),
        address: S(m.address, 200), city: S(m.city, 100), state: S(m.state, 40), zip: S(m.zip, 20),
        phone: S(m.phone, 40), tag: S(m.tag, 120),
      });
    });
    if (!members.length) return res.status(400).json({ error: 'None of those had a valid email address.' });
    const aud = await mailchimp.findAudience(MAILCHIMP_AUDIENCE);
    await mailchimp.ensureMergeFields(aud.id);
    const result = await mailchimp.upsertMembers(aud.id, members);
    console.log(`[jim-mailing-list] mailchimp sync → ${members.length} sent (${result.created} new, ${result.updated} updated, ${result.errors} err)`);
    res.json({ ok: (result.created + result.updated) > 0 || result.errors === 0, audience: aud.displayName || MAILCHIMP_AUDIENCE, attempted: members.length, created: result.created, updated: result.updated, errors: result.errors, errorSamples: result.errorSamples, skippedNoEmail: noEmail });
  } catch (e) {
    console.error('[jim-mailing-list] mailchimp sync failed:', mcErr(e));
    res.status(502).json({ error: 'Mailchimp sync failed: ' + mcErr(e) });
  }
});

// POST /mailchimp/engagement — for the given emails, report which are already in
// Mailchimp and which have opened an email (avg open rate > 0). Body: { emails: [] }.
router.post('/mailchimp/engagement', async (req, res) => {
  if (!process.env.MAILCHIMP_API_KEY) return res.status(503).json({ error: 'No Mailchimp API key is set on the server yet.' });
  const emails = Array.isArray(req.body && req.body.emails) ? req.body.emails : null;
  if (!emails || !emails.length) return res.status(400).json({ error: 'No emails to check — pick a group first.' });
  if (emails.length > 3000) return res.status(400).json({ error: 'Too many at once (max 3,000) — filter to a smaller group.' });
  try {
    const map = await mailchimp.engagementMap();
    const byEmail = {};
    let inMailchimp = 0, opened = 0;
    emails.forEach((e) => {
      const em = String(e || '').toLowerCase().trim();
      if (!em) return;
      const hit = map[em];
      if (hit) { inMailchimp++; if (hit.opened) opened++; byEmail[em] = { inMailchimp: true, opened: !!hit.opened, rating: hit.rating || 0 }; }
      else byEmail[em] = { inMailchimp: false, opened: false, rating: 0 };
    });
    console.log(`[jim-mailing-list] engagement: ${emails.length} checked → ${inMailchimp} in Mailchimp, ${opened} opened`);
    res.json({ ok: true, checked: emails.length, inMailchimp: inMailchimp, opened: opened, byEmail: byEmail });
  } catch (e) {
    console.error('[jim-mailing-list] engagement check failed:', mcErr(e));
    res.status(502).json({ error: 'Could not read Mailchimp engagement: ' + mcErr(e) });
  }
});

// POST /mailchimp/record-sends — read who recent SENT campaigns went to and stamp
// each matching prospect (last-mailed date, count, Status='Mailed'). Idempotent:
// the count is SET to how many campaigns Mailchimp shows them in, never incremented.
router.post('/mailchimp/record-sends', async (req, res) => {
  if (!process.env.MAILCHIMP_API_KEY) return res.status(503).json({ error: 'No Mailchimp API key is set on the server yet.' });
  try {
    const aud = await mailchimp.findAudience(MAILCHIMP_AUDIENCE);
    const campaigns = await mailchimp.recentSentCampaigns(aud.id, 50);
    const sent = {}; // email -> { day, count }
    for (const c of campaigns) {
      const emails = await mailchimp.campaignSentTo(c.id);
      const day = (c.send_time || '').slice(0, 10);
      emails.forEach((em) => {
        if (!sent[em]) sent[em] = { day: day, count: 0 };
        sent[em].count += 1;
        if (day > sent[em].day) sent[em].day = day;
      });
    }
    if (!Object.keys(sent).length) return res.json({ ok: true, campaigns: campaigns.length, recipients: 0, updated: 0, message: 'No sent campaigns for this audience yet.' });
    const rows = await fetchAllCaspioPages(TABLE_PATH, { 'q.select': 'PK_ID,Email,Status', 'q.where': "Email IS NOT NULL AND Email<>''", 'q.orderBy': 'PK_ID', 'q.pageSize': 500 }, { maxPages: 30 });
    let updated = 0;
    for (const r of (rows || [])) {
      const em = String(r.Email || '').trim().toLowerCase();
      const info = sent[em];
      if (!info) continue;
      const upd = { Mailchimp_Last_Sent: info.day, Last_Mailed_At: info.day, Mailchimp_Sent_Count: String(info.count), Updated_At: nowIso() };
      if ((r.Status || '') !== 'Customer' && (r.Status || '') !== 'Responded') upd.Status = 'Mailed';
      try { const rr = await putWithRecordsAffected(TABLE_PATH, `PK_ID=${r.PK_ID}`, upd); if (rr.RecordsAffected) updated++; }
      catch (e) { /* skip individual failures */ }
    }
    console.log(`[jim-mailing-list] mailchimp record-sends → ${campaigns.length} campaigns, ${Object.keys(sent).length} recipients, ${updated} prospects stamped`);
    res.json({ ok: true, campaigns: campaigns.length, recipients: Object.keys(sent).length, updated: updated });
  } catch (e) {
    console.error('[jim-mailing-list] record-sends failed:', mcErr(e));
    res.status(502).json({ error: 'Could not read Mailchimp activity: ' + mcErr(e) });
  }
});

module.exports = router;
