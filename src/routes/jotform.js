// jotform.js — inbound JotForm lead ingest (Leads CRM).
//
//   POST /api/jotform/webhook?secret=…  — JotForm posts multipart/form-data on
//        every submission (fields: formID, submissionID, rawRequest = JSON of
//        the answers). Public by design: JotForm can't send custom headers or
//        sign requests, so the gate is a long random ?secret= token checked
//        constant-time. Fast-200 ack, then async normalize→assign→insert
//        (box-webhooks.js precedent — the sender must never wait on Caspio).
//   POST /api/jotform/sync              — CRM-secret; pulls the last N days from
//        the JotForm REST API and ingests anything the webhook missed. Also
//        run daily by scripts/jotform-reconcile.js (Heroku Scheduler).
//   GET  /api/jotform/health            — config flags + in-memory ingest state.
//
// Rows land in Form_Submissions as Form_ID='jotform-lead' (prefix JFL) with
// AE auto-assignment (Taneisha default) — see src/utils/jotform.js.

'use strict';

const express = require('express');
const multer = require('multer');
const rateLimit = require('express-rate-limit');
const router = express.Router();

const { requireCrmApiSecret, requireCrmSecretOrBrowserOrigin } = require('../middleware');
const {
  JOTFORM_FORMS,
  insertLead,
  normalizeFromRawRequest,
  normalizeFromApiAnswers,
  fetchJotformSubmission,
  isJotformUploadUrl,
  timingSafeSecretCompare,
  reconcileRecent,
} = require('../utils/jotform');

// In-memory ingest state (per dyno — plenty for a staff health read).
const state = {
  webhooksReceived: 0,
  lastWebhookAt: '',
  lastWebhookForm: '',
  lastInsertedId: '',
  lastSkip: '',
  lastSyncAt: '',
  lastSyncSummary: null,
  lastErrorAt: '',
  lastError: '',
};

// Real traffic is a handful of leads a day — 30/5min absorbs JotForm retry
// bursts while keeping secret-guessing noisy and slow.
const webhookLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many webhook posts — slow down.' },
});

// Checked BEFORE any body parsing so unauthorized posts cost nothing.
const requireWebhookSecret = (req, res, next) => {
  const expected = process.env.JOTFORM_WEBHOOK_SECRET || '';
  if (!expected || !timingSafeSecretCompare(String(req.query.secret || ''), expected)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
};

router.post(
  '/jotform/webhook',
  webhookLimiter,
  requireWebhookSecret,
  express.urlencoded({ extended: true }), // safety net if JotForm ever posts urlencoded
  multer().none(), // normal path: multipart fields only (uploads arrive as URLs inside rawRequest)
  (req, res) => {
    // Fast-ack, then process async — JotForm times out slow receivers and retries.
    res.status(200).json({ ok: true });
    const body = req.body || {};
    setImmediate(async () => {
      try {
        const formID = String(body.formID || '');
        const submissionID = String(body.submissionID || '');
        if (!JOTFORM_FORMS[formID]) {
          console.warn(`[jotform] webhook for unregistered form ${formID || '(none)'} — ignored`);
          return;
        }
        // REST-first: the API's `answers` are complete — upload URLs are missing
        // from the multipart rawRequest (proven by Erik's 7/18 test lead).
        // rawRequest stays as the fallback so a JotForm API hiccup never drops a lead.
        let normalized = null;
        if (process.env.JOTFORM_API_KEY) {
          try {
            const sub = await fetchJotformSubmission(submissionID);
            if (sub && sub.answers) normalized = normalizeFromApiAnswers(formID, sub.answers, submissionID);
          } catch (e) {
            console.warn('[jotform] REST fetch for webhook failed — falling back to rawRequest:', e.message);
          }
        }
        if (!normalized) {
          let raw = {};
          try { raw = JSON.parse(body.rawRequest || '{}'); } catch (_) { raw = {}; }
          normalized = normalizeFromRawRequest(formID, raw, submissionID);
        }
        const result = await insertLead({ formID, submissionId: submissionID, normalized, via: 'jotform-webhook' });
        state.webhooksReceived += 1;
        state.lastWebhookAt = new Date().toISOString();
        state.lastWebhookForm = formID;
        if (result.inserted) {
          state.lastInsertedId = result.record.Submission_ID;
          state.lastSkip = '';
        } else {
          state.lastSkip = `${result.skipped} (${submissionID})`;
          console.log(`[jotform] webhook submission ${submissionID} skipped: ${result.skipped}`);
        }
      } catch (e) {
        state.lastErrorAt = new Date().toISOString();
        state.lastError = e.message;
        console.error('[jotform] webhook processing failed:', e.message);
      }
    });
  }
);

// Parse failures (odd content-type, stray file part) still get a 200 — a 4xx/5xx
// would make JotForm retry-storm a request that will never parse. The daily
// reconcile is the correctness net for anything dropped here.
router.use('/jotform/webhook', (err, req, res, next) => { // eslint-disable-line no-unused-vars
  console.warn('[jotform] webhook parse error (acked anyway):', err.message);
  if (!res.headersSent) res.status(200).json({ ok: true, note: 'unparseable-post' });
});

// POST /api/jotform/sync { days? } — manual/scheduled reconcile (CRM-secret).
router.post('/jotform/sync', requireCrmApiSecret, async (req, res) => {
  const days = Math.min(30, Math.max(1, parseInt(req.body && req.body.days, 10) || 2));
  try {
    const report = await reconcileRecent(days);
    state.lastSyncAt = new Date().toISOString();
    state.lastSyncSummary = { inserted: report.inserted, skipped: report.skipped, fetched: report.fetched, days };
    console.log(`[jotform] sync: ${report.inserted} inserted / ${report.skipped} already present (last ${days}d)`);
    res.json(report);
  } catch (e) {
    state.lastErrorAt = new Date().toISOString();
    state.lastError = e.message;
    console.error('[jotform] sync failed:', e.message);
    res.status(502).json({ error: 'JotForm sync failed: ' + e.message });
  }
});

// GET /api/jotform/file?u=… — stream a JotForm upload to staff browsers.
// JotForm upload links require a JotForm login to view; this fetches the file
// server-side with the API key and streams it back, so attachments open right
// in the Leads drawer. Gate = requireCrmSecretOrBrowserOrigin (the softer
// staff-dashboard read gate); the URL is allow-listed to JotForm upload hosts
// only, so this can never act as an open proxy.
router.get('/jotform/file', requireCrmSecretOrBrowserOrigin, async (req, res) => {
  const u = String(req.query.u || '').trim();
  if (!isJotformUploadUrl(u)) return res.status(400).json({ error: 'Not a JotForm upload URL' });
  const key = process.env.JOTFORM_API_KEY || '';
  if (!key) return res.status(503).json({ error: 'JOTFORM_API_KEY not configured' });
  try {
    const axios = require('axios');
    const upstream = await axios.get(u, {
      headers: { APIKEY: key },
      responseType: 'stream',
      timeout: 30000,
      maxRedirects: 3,
    });
    // JotForm serves uploads as octet-stream — infer the real MIME from the
    // extension so images/PDFs display in-browser instead of downloading
    // (same trick as files-simple.js for Caspio's text/plain).
    const EXT_MIME = {
      jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif',
      webp: 'image/webp', bmp: 'image/bmp', svg: 'image/svg+xml', pdf: 'application/pdf',
    };
    let ctype = upstream.headers['content-type'] || '';
    if (!ctype || /octet-stream|text\/plain/i.test(ctype)) {
      const ext = (u.split('?')[0].split('.').pop() || '').toLowerCase();
      ctype = EXT_MIME[ext] || ctype || 'application/octet-stream';
    }
    res.set('Content-Type', ctype);
    if (upstream.headers['content-length']) res.set('Content-Length', upstream.headers['content-length']);
    res.set('Content-Disposition', 'inline');
    res.set('Cache-Control', 'private, max-age=3600');
    upstream.data.pipe(res);
  } catch (e) {
    const status = e.response ? e.response.status : 502;
    console.warn('[jotform] file passthrough failed:', status, u.slice(0, 120));
    res.status(status === 404 ? 404 : 502).json({ error: `File unavailable from JotForm (${status})` });
  }
});

// GET /api/jotform/health — config presence + last ingest activity.
router.get('/jotform/health', (req, res) => {
  res.json({
    configured: {
      apiKey: !!process.env.JOTFORM_API_KEY,
      webhookSecret: !!process.env.JOTFORM_WEBHOOK_SECRET,
      slackLeads: !!process.env.SLACK_FORM_LEADS_WEBHOOK_URL,
    },
    forms: Object.fromEntries(Object.entries(JOTFORM_FORMS).map(([id, f]) => [id, f.title])),
    state,
  });
});

module.exports = router;
