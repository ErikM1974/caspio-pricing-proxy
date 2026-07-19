// lead-activity.js — Leads CRM activity timeline + follow-up-digest admin.
//
//   GET  /api/lead-activity?submissionId=JFL0718-1234  — timeline, newest first
//   POST /api/lead-activity                            — append one activity row
//        {submissionId, activityType, activityText?, attachmentUrl?, createdBy}
//   GET  /api/lead-digest/scan                          — dry-run grouping (debug)
//   POST /api/lead-digest/send                          — manual digest trigger (x-admin-key)
//
// Gating: the activity routes are CRM-secret-only at the server.js mount —
// staff browsers reach them through the main app's session-gated
// /api/crm-proxy/lead-activity* forwarder (form-submissions precedent; rows
// hold customer-facing notes). Rows are immutable v1 (no PUT/DELETE).

'use strict';

const express = require('express');
const router = express.Router();

const { requireCrmApiSecret } = require('../middleware');
const { fetchAllCaspioPages, makeCaspioRequest } = require('../utils/caspio');
const { sanitizeId, nowIso } = require('../utils/form-submission-helpers');
const { validateActivity } = require('../utils/lead-activity-helpers');

const ACTIVITY_PATH = '/tables/Lead_Activity/records';
const SUBMISSIONS_PATH = '/tables/Form_Submissions/records';
// Attachment_URL allow-list base = this proxy's own origin (image-uploads.js precedent).
const FILES_BASE = process.env.PROXY_BASE_URL || 'https://caspio-pricing-proxy-ab30a049961a.herokuapp.com';

// GET /lead-activity?submissionId= → { activities } (newest first; cap 200)
router.get('/lead-activity', requireCrmApiSecret, async (req, res) => {
  const id = sanitizeId(req.query.submissionId);
  if (!id) return res.status(400).json({ error: 'submissionId is required' });
  try {
    const rows = await fetchAllCaspioPages(ACTIVITY_PATH, {
      'q.where': `Submission_ID='${id}'`,
      'q.orderBy': 'PK_ID DESC',
      'q.pageSize': 200,
    }, { maxPages: 1 });
    res.json({ activities: rows || [] });
  } catch (e) {
    console.error('[lead-activity] list failed:', e.message);
    res.status(502).json({ error: 'Activity lookup failed' });
  }
});

// POST /lead-activity → 201 { activity }
router.post('/lead-activity', requireCrmApiSecret, async (req, res) => {
  const { errors, record } = validateActivity(req.body, FILES_BASE);
  if (errors.length) return res.status(400).json({ error: errors.join('; ') });

  record.Created_At = nowIso(); // server clock only
  try {
    await makeCaspioRequest('post', ACTIVITY_PATH, {}, record);
    console.log(`[lead-activity] ${record.Activity_Type} on ${record.Submission_ID} by ${record.Created_By}`);
    res.status(201).json({ activity: record });
  } catch (e) {
    console.error('[lead-activity] save failed:', e.message);
    res.status(502).json({ error: 'Activity save failed — the note was NOT stored.' });
  }
});

// POST /lead-outreach — one-click AE outreach email to a lead, staff-only via
// the main app's /api/crm-proxy/lead-outreach* forwarder.
//   { submissionId, template, lead:{contactName,email,company}, aeName, aeEmail, preview? }
// preview:true → { label, subject, bodyHtml } without sending.
// send → EmailJS template_lead_outreach (To = the LEAD, Reply-To = the AE)
//        + an 'email' Lead_Activity row. Lead fields ride in from the staff
//        page (same trust model as Updated_By) so preview/send costs zero
//        Caspio reads; the activity log is the only write.
router.post('/lead-outreach', requireCrmApiSecret, async (req, res) => {
  const body = req.body || {};
  const { buildOutreach } = require('../utils/lead-outreach-templates');
  const submissionId = sanitizeId(body.submissionId);
  const lead = body.lead || {};
  const toEmail = String(lead.email || '').trim();
  const aeName = String(body.aeName || '').trim() || 'Northwest Custom Apparel';
  const aeEmail = String(body.aeEmail || '').trim();

  const built = buildOutreach(String(body.template || ''), {
    contactName: lead.contactName,
    company: lead.company,
    aeName: aeName,
  });
  if (!built) return res.status(400).json({ error: 'Unknown outreach template' });
  if (!submissionId) return res.status(400).json({ error: 'submissionId is required' });

  if (body.preview) return res.json({ preview: true, ...built });

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(toEmail)) {
    return res.status(400).json({ error: 'Lead has no valid email address' });
  }
  const serviceId = process.env.EMAILJS_SERVICE_ID;
  const templateId = process.env.EMAILJS_TEMPLATE_LEAD_OUTREACH;
  const publicKey = process.env.EMAILJS_PUBLIC_KEY;
  const privateKey = process.env.EMAILJS_PRIVATE_KEY;
  if (!serviceId || !templateId || !publicKey || !privateKey) {
    return res.status(503).json({ error: 'Outreach email not configured — set EMAILJS_TEMPLATE_LEAD_OUTREACH.' });
  }

  try {
    const emailjs = require('@emailjs/nodejs');
    const resp = await emailjs.send(serviceId, templateId, {
      to_email: toEmail,
      reply_to: /@nwcustomapparel\.com$/i.test(aeEmail) ? aeEmail : 'sales@nwcustomapparel.com',
      from_name: aeName + ' — Northwest Custom Apparel',
      subject: built.subject,
      body_html: built.bodyHtml,
    }, { publicKey, privateKey });

    // Timeline entry (fire-and-forget — the email already went)
    makeCaspioRequest('post', ACTIVITY_PATH, {}, {
      Submission_ID: submissionId,
      Activity_Type: 'email',
      Activity_Text: `Emailed “${built.label}” → ${toEmail}`,
      Attachment_URL: '',
      Created_By: aeEmail || 'leads-page',
      Created_At: nowIso(),
      Parent_PK: null,
    }).catch((e) => console.warn('[lead-outreach] activity log failed (email already sent):', e.message));

    console.log(`[lead-outreach] ${built.label} → ${toEmail} for ${submissionId} by ${aeEmail} (status ${resp.status})`);
    res.json({ sent: true, label: built.label, to: toEmail });
  } catch (err) {
    const errText = (err && (err.text || err.message)) || JSON.stringify(err);
    console.error('[lead-outreach] send failed:', errText);
    res.status(502).json({ error: 'Email NOT sent: ' + errText });
  }
});

// --- Follow-up digest admin (clone of the AE approval-digest admin pattern) ---

// GET /lead-digest/scan — dry-run: what WOULD be sent, per AE. No email.
// CRM-secret gated (2026-07-18): the dry-run report lists lead companies,
// contacts, and AE emails — same posture as /lead-activity, and the same
// "every route a router registers" lesson as the orders-router side doors.
router.get('/lead-digest/scan', requireCrmApiSecret, async (req, res) => {
  try {
    const { runLeadFollowupDigest } = require('../utils/lead-followup-digest');
    const result = await runLeadFollowupDigest({ dryRun: true });
    res.json({ success: true, ...result });
  } catch (err) {
    console.error('[Lead Digest] Scan failed:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /lead-digest/send — manual trigger, x-admin-key gated (ADMIN_KEY_DIGEST).
router.post('/lead-digest/send', async (req, res) => {
  const expected = process.env.ADMIN_KEY_DIGEST;
  const provided = req.headers['x-admin-key'];
  if (!expected) return res.status(500).json({ success: false, error: 'ADMIN_KEY_DIGEST env var not configured on server.' });
  if (provided !== expected) return res.status(401).json({ success: false, error: 'Unauthorized' });
  try {
    const { runLeadFollowupDigest } = require('../utils/lead-followup-digest');
    const result = await runLeadFollowupDigest();
    res.json({ success: true, ...result });
  } catch (err) {
    console.error('[Lead Digest] Manual trigger failed:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// --- Conversion tracking + rep scorecard ---

// GET /lead-conversion/scan — dry-run: which leads WOULD auto-Won + lifetime
// refresh count. No writes. CRM-secret (lists lead + customer identities).
router.get('/lead-conversion/scan', requireCrmApiSecret, async (req, res) => {
  try {
    const { runConversionSync } = require('../utils/lead-conversion');
    const result = await runConversionSync({ dryRun: true, includeArchived: req.query.includeArchived === '1', fuzzyCompany: req.query.fuzzy === '1' });
    res.json({ success: true, ...result });
  } catch (err) {
    console.error('[Conversion] Scan failed:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /lead-conversion/run — auto-Won + lifetime refresh. x-admin-key gated.
// {includeArchived:true, fuzzy:true} = the one-time historical backfill.
router.post('/lead-conversion/run', async (req, res) => {
  const expected = process.env.ADMIN_KEY_DIGEST;
  if (!expected) return res.status(500).json({ success: false, error: 'ADMIN_KEY_DIGEST env var not configured on server.' });
  if (req.headers['x-admin-key'] !== expected) return res.status(401).json({ success: false, error: 'Unauthorized' });
  try {
    const body = req.body || {};
    const { runConversionSync } = require('../utils/lead-conversion');
    const result = await runConversionSync({ includeArchived: !!body.includeArchived, fuzzyCompany: !!body.fuzzy });
    res.json({ success: true, ...result });
  } catch (err) {
    console.error('[Conversion] Run failed:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /lead-categorize/apply — bulk-apply a Claude categorization. x-admin-key.
// Body: { toLost:[ids], spam:[ids], unqualified:[ids] }
//   toLost      → Status='Lost'                              (qualified non-converters)
//   spam        → Lead_Category='spam', keep Status=Archived (off the board)
//   unqualified → Lead_Category='unqualified', keep Archived
// Chunked Submission_ID IN() PUTs (server-side — no 30s browser-request limit).
router.post('/lead-categorize/apply', async (req, res) => {
  const expected = process.env.ADMIN_KEY_DIGEST;
  if (!expected) return res.status(500).json({ success: false, error: 'ADMIN_KEY_DIGEST not configured.' });
  if (req.headers['x-admin-key'] !== expected) return res.status(401).json({ success: false, error: 'Unauthorized' });
  const { putWithRecordsAffected } = require('../utils/caspio');
  const body = req.body || {};
  const clean = (a) => [...new Set((Array.isArray(a) ? a : []).map(sanitizeId).filter(Boolean))];
  const groups = [
    { ids: clean(body.toLost), data: { Status: 'Lost', Updated_By: 'lead-categorize' } },
    { ids: clean(body.spam), data: { Lead_Category: 'spam', Updated_By: 'lead-categorize' } },
    { ids: clean(body.unqualified), data: { Lead_Category: 'unqualified', Updated_By: 'lead-categorize' } },
  ];
  const chunk = (a, n) => { const o = []; for (let i = 0; i < a.length; i += n) o.push(a.slice(i, i + n)); return o; };
  const result = {};
  try {
    for (const g of groups) {
      let affected = 0;
      for (const grp of chunk(g.ids, 40)) {
        const where = "Submission_ID IN ('" + grp.join("','") + "')";
        const r = await putWithRecordsAffected(SUBMISSIONS_PATH, where, { ...g.data, Updated_At: nowIso() });
        affected += (r && r.RecordsAffected) || 0;
      }
      result[g.data.Status || g.data.Lead_Category] = { requested: g.ids.length, updated: affected };
    }
    console.log('[lead-categorize] applied:', JSON.stringify(result));
    res.json({ success: true, result });
  } catch (err) {
    console.error('[lead-categorize] apply failed:', err.message);
    res.status(500).json({ success: false, error: err.message, partial: result });
  }
});

// GET /lead-classify/scan — dry-run: how many New leads are uncategorized and
// what Claude WOULD label them, no writes. CRM-secret (staff-triggerable).
router.get('/lead-classify/scan', requireCrmApiSecret, async (req, res) => {
  try {
    const { runLeadClassification } = require('../utils/lead-classify-ai');
    const result = await runLeadClassification({ dryRun: true, limit: req.query.limit ? parseInt(req.query.limit, 10) : undefined });
    res.json({ success: true, ...result });
  } catch (err) {
    console.error('[Lead Classify] Scan failed:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /lead-classify/run — classify the uncategorized New leads with Claude and
// apply (spam/unqualified → Archived+tag, qualified → tag). CRM-secret so the
// "Rescan with Claude" button can call it through the crm-proxy forwarder. Only
// touches leads with a blank Lead_Category, so it's bounded + idempotent.
router.post('/lead-classify/run', requireCrmApiSecret, async (req, res) => {
  try {
    const { runLeadClassification } = require('../utils/lead-classify-ai');
    const result = await runLeadClassification({});
    if (result.skipped) return res.status(503).json({ success: false, error: 'Lead classifier not configured — set ANTHROPIC_API_KEY on the proxy.' });
    res.json({ success: true, ...result });
  } catch (err) {
    console.error('[Lead Classify] Run failed:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /lead-scorecard?since=YYYY-MM-DD&until=YYYY-MM-DD — per-rep close report.
// CRM-secret; staff reach it via /api/crm-proxy/lead-scorecard*.
router.get('/lead-scorecard', requireCrmApiSecret, async (req, res) => {
  try {
    const iso = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) ? v : undefined);
    const { buildScorecard } = require('../utils/lead-conversion');
    const result = await buildScorecard({ since: iso(req.query.since), until: iso(req.query.until) });
    res.json({ success: true, ...result });
  } catch (err) {
    console.error('[Scorecard] Build failed:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
