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
router.get('/lead-digest/scan', async (req, res) => {
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

module.exports = router;
