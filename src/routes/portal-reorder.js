// portal-reorder.js — Customer Portal Phase 4 backend (catalog request-to-rep + recs).
// Two tables: Portal_Reorder_Requests (the rep work-queue) + Portal_Recommendations
// (Erik-curated strip). Gated by requireCrmApiSecret at the mount (server-to-server only;
// the FE calls these with the CRM secret after its own requireCustomer session check).
'use strict';
const express = require('express');
const router = express.Router();
const { fetchAllCaspioPages, getCaspioAccessToken } = require('../utils/caspio');
const config = require('../config');
const axios = require('axios');
const { sendSlackDM } = require('../utils/slack-dm-notify');
const { REP_EMAIL_MAP } = require('../utils/rep-email-map');

const BASE = config.caspio.apiBaseUrl;

// Who hears about a portal request (Erik 2026-09-02: "how does it notify people at NWCA?").
// The saved Portal_Reorder_Requests row is the queue of record (admin console → Re-order Requests,
// "New" badge). On top of that, DM the customer's rep on Slack — the same bot-token path
// notify-art-completion uses — and fall back to Erik when the rep is unassigned or not on Slack.
// Optional: a channel webhook (SLACK_PORTAL_REQUESTS_WEBHOOK_URL / SLACK_SALES_WEBHOOK_URL).
// Fire-and-forget: the request is already saved; a Slack outage must never fail the customer.
const FALLBACK_NOTIFY_EMAIL = process.env.PORTAL_REQUEST_FALLBACK_EMAIL || 'erik@nwcustomapparel.com';
function repEmailFor(repName) {
  const n = String(repName || '').trim();
  if (!n) return '';
  if (REP_EMAIL_MAP[n]) return REP_EMAIL_MAP[n];
  const first = n.split(/\s+/)[0];
  return REP_EMAIL_MAP[first] || '';
}
// Email copy to the shared sales inbox (never depends on who the rep is). EmailJS template
// EMAILJS_TEMPLATE_PORTAL_REQUEST must exist with these params: to_email, subject, kind,
// company_name, customer_number, request_num, summary, note, rep, customer_email, queue_link.
const PORTAL_REQUEST_EMAIL = process.env.PORTAL_REQUEST_EMAIL || 'sales@nwcustomapparel.com';
async function emailPortalRequest(fields) {
  const serviceId = process.env.EMAILJS_SERVICE_ID, templateId = process.env.EMAILJS_TEMPLATE_PORTAL_REQUEST;
  const publicKey = process.env.EMAILJS_PUBLIC_KEY, privateKey = process.env.EMAILJS_PRIVATE_KEY;
  if (!serviceId || !templateId || !publicKey || !privateKey) { console.log('[portal-reorder] email skipped — EMAILJS_TEMPLATE_PORTAL_REQUEST not configured'); return; }
  try {
    const emailjs = require('@emailjs/nodejs');
    await emailjs.send(serviceId, templateId, Object.assign({ to_email: PORTAL_REQUEST_EMAIL }, fields), { publicKey, privateKey });
    console.log('[portal-reorder] emailed', PORTAL_REQUEST_EMAIL, fields.request_num);
  } catch (e) { console.warn('[portal-reorder] email failed:', e && e.text ? e.text : (e && e.message) || e); }
}
function notifyPortalRequest(repName, text, fields) {
  const hook = process.env.SLACK_PORTAL_REQUESTS_WEBHOOK_URL || process.env.SLACK_SALES_WEBHOOK_URL;
  if (hook) axios.post(hook, { text }).catch(() => {});
  if (fields) emailPortalRequest(Object.assign({ rep: repName || '(unassigned)' }, fields)).catch(() => {});
  const to = repEmailFor(repName) || FALLBACK_NOTIFY_EMAIL;
  sendSlackDM(to, text).then((r) => {
    if (r.sent || to === FALLBACK_NOTIFY_EMAIL) return;
    // Rep exists but could not be reached (no Slack id / API error) — make sure SOMEONE sees it.
    return sendSlackDM(FALLBACK_NOTIFY_EMAIL, `(rep ${repName || '?'} unreachable on Slack: ${r.skipped || r.error})\n` + text);
  }).catch(() => {});
}

function digits(v) { const s = String(v == null ? '' : v).trim(); return /^\d+$/.test(s) ? s : null; }
function clean(v, n) { return String(v == null ? '' : v).slice(0, n || 255); }
async function authHeaders() {
  const token = await getCaspioAccessToken();
  return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
}
// The authoritative owning rep for a customer = Sales_Reps_2026.CustomerServiceRep.
async function repForCustomer(idCustomer) {
  try {
    const rows = await fetchAllCaspioPages('/tables/Sales_Reps_2026/records', {
      'q.where': `ID_Customer=${idCustomer}`, 'q.select': 'CustomerServiceRep', 'q.pageSize': 1,
    });
    return (rows && rows[0] && rows[0].CustomerServiceRep) || '';
  } catch (e) { console.warn('[portal-reorder] rep lookup failed:', e.message); return ''; }
}
// Pacific-ish readable id + ISO stamp (proxy runtime has Date; not a workflow).
function nowStamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return {
    requestNum: `RR-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`,
    iso: d.toISOString(),
  };
}

// POST /api/portal-reorder/request — create a re-order request. The FE supplies the
// customer fields (id_Customer from the verified SESSION, never the client); we attach the
// authoritative rep, a Request_Num, Status=New, Created. Returns the created row.
router.post('/request', express.json(), async (req, res) => {
  const b = req.body || {};
  const idCustomer = digits(b.id_Customer);
  if (!idCustomer) return res.status(400).json({ error: 'numeric id_Customer required' });
  if (!String(b.style || '').trim()) return res.status(400).json({ error: 'style required' });
  const source = b.source === 'recommendation' ? 'recommendation' : 'reorder';
  const rep = await repForCustomer(idCustomer);
  const stamp = nowStamp();
  const row = {
    Request_Num: stamp.requestNum,
    id_Customer: idCustomer,
    Company_Name: clean(b.company_name),
    Email: clean(b.email),
    Style: clean(b.style, 50),
    Color: clean(b.color, 80),
    Product_Title: clean(b.product_title),
    Design_Number: clean(b.design_number, 50),
    Design_Name: clean(b.design_name),
    Qty: clean(b.qty, 30),
    Size_Breakdown: clean(b.size_breakdown),
    Method: clean(b.method, 30),   // decoration method (Embroidery/Screen Print/DTG/DTF), defaulted from ORDER_ODBC history
    Note: clean(b.note),
    Rep: clean(rep, 80),
    Source: source,
    Status: 'New',
    Created: stamp.iso,
  };
  try {
    await axios.post(`${BASE}/tables/Portal_Reorder_Requests/records`, row, { headers: await authHeaders() });
    // Portal "general" requests reuse this row with Style = QUOTE / NEWLOGO / LOGOCHG / ACCOUNT.
    const kind = /^(QUOTE|NEWLOGO|LOGOCHG|ACCOUNT)$/.test(row.Style)
      ? ({ QUOTE: '💬 *Portal quote request*', NEWLOGO: '🎨 *Portal new-logo request*', LOGOCHG: '✏️ *Portal logo-change request*', ACCOUNT: '👤 *Portal account update*' })[row.Style]
      : '🛒 *Portal re-order request*';
    const what = /^(QUOTE|NEWLOGO|LOGOCHG|ACCOUNT)$/.test(row.Style)
      ? `${row.Product_Title || ''}${row.Method ? ` · ${row.Method}` : ''}${row.Qty ? ` · qty ${row.Qty}` : ''}${row.Design_Number ? ` · Design #${row.Design_Number}` : ''}`
      : `*${row.Style}* ${row.Color}${row.Method ? ` · ${row.Method}` : ''}${row.Design_Number ? ` · Design #${row.Design_Number}` : ''} · qty ${row.Qty || '?'}`;
    const queueLink = 'https://www.teamnwca.com/dashboards/customer-portal-admin.html';
    const kindText = kind.replace(/[*_]/g, '').replace(/^\S+\s/, '');
    notifyPortalRequest(row.Rep, `${kind} — ${row.Company_Name} (#${idCustomer}) · ${row.Request_Num}\n`
      + `${what}\nRep: ${row.Rep || '(unassigned)'} · ${row.Email}${row.Note ? `\nNote: ${row.Note}` : ''}\n`
      + `Queue: ${queueLink} (Re-order Requests)`,
      { subject: `${kindText}: ${row.Company_Name} · ${row.Request_Num}`, kind: kindText, company_name: row.Company_Name, customer_number: idCustomer,
        request_num: row.Request_Num, summary: what.replace(/[*_]/g, ''), note: row.Note || '', customer_email: row.Email, queue_link: queueLink });
    res.json({ success: true, request: row });
  } catch (e) {
    console.error('[portal-reorder] create failed:', e.response ? JSON.stringify(e.response.data) : e.message);
    res.status(502).json({ error: 'request create failed', detail: e.response ? e.response.data : e.message });
  }
});

// POST /api/portal-reorder/batch — a multi-item "Re-order List". Each item becomes its own
// Portal_Reorder_Requests row sharing ONE Batch_Num (RB-YYYYMMDD-HHMMSS) so the rep sees them
// grouped. Same customer-safe fields as /request (NO price/payment). One Slack ping per batch.
router.post('/batch', express.json(), async (req, res) => {
  const b = req.body || {};
  const idCustomer = digits(b.id_Customer);
  if (!idCustomer) return res.status(400).json({ error: 'numeric id_Customer required' });
  const items = (Array.isArray(b.items) ? b.items : []).filter(it => it && String(it.style || '').trim());
  if (!items.length) return res.status(400).json({ error: 'at least one item with a style required' });
  if (items.length > 30) return res.status(400).json({ error: 'too many items (max 30)' });
  const rep = await repForCustomer(idCustomer);
  const stamp = nowStamp();
  const batchNum = stamp.requestNum.replace(/^RR-/, 'RB-');
  const note = clean(b.note);
  const rows = items.map((it, i) => ({
    Request_Num: `${batchNum}-${i + 1}`,
    Batch_Num: batchNum,
    id_Customer: idCustomer,
    Company_Name: clean(b.company_name),
    Email: clean(b.email),
    Style: clean(it.style, 50),
    Color: clean(it.color, 80),
    Product_Title: clean(it.product_title),
    Design_Number: clean(it.design_number, 50),
    Design_Name: clean(it.design_name),
    Qty: clean(it.qty, 30),
    Size_Breakdown: clean(it.size_breakdown),
    Method: clean(it.method, 30),
    Note: note,
    Rep: clean(rep, 80),
    Source: 'reorder-list',
    Status: 'New',
    Created: stamp.iso,
  }));
  try {
    const headers = await authHeaders();
    // Caspio inserts one record per POST — fan out in parallel; any failure fails the batch.
    await Promise.all(rows.map(row => axios.post(`${BASE}/tables/Portal_Reorder_Requests/records`, row, { headers })));
    const lines = rows.map(r => `• *${r.Style}* ${r.Color}${r.Method ? ` · ${r.Method}` : ''} · qty ${r.Qty || '?'}`).join('\n');
    const queueLink = 'https://www.teamnwca.com/dashboards/customer-portal-admin.html';
    notifyPortalRequest(rows[0].Rep, `🧾 *Portal re-order LIST* (${rows.length} item${rows.length === 1 ? '' : 's'}) — ${rows[0].Company_Name} (#${idCustomer}) · Batch ${batchNum}\n`
      + `${lines}\nRep: ${rows[0].Rep || '(unassigned)'} · ${rows[0].Email}${note ? `\nNote: ${note}` : ''}\n`
      + `Queue: ${queueLink} (Re-order Requests)`,
      { subject: `Portal re-order list (${rows.length}): ${rows[0].Company_Name} · ${batchNum}`, kind: 'Portal re-order list', company_name: rows[0].Company_Name, customer_number: idCustomer,
        request_num: batchNum, summary: lines.replace(/[*_•]/g, '').trim(), note: note || '', customer_email: rows[0].Email, queue_link: queueLink });
    res.json({ success: true, batchNum, count: rows.length, rep });
  } catch (e) {
    console.error('[portal-reorder] batch create failed:', e.response ? JSON.stringify(e.response.data) : e.message);
    res.status(502).json({ error: 'batch create failed', detail: e.response ? e.response.data : e.message });
  }
});

// GET /api/portal-reorder/requests?rep=&status=&id_Customer= — list (rep queue / customer's own).
router.get('/requests', async (req, res) => {
  const where = [];
  if (req.query.rep) where.push(`Rep='${String(req.query.rep).replace(/'/g, "''")}'`);
  if (req.query.status) where.push(`Status='${String(req.query.status).replace(/'/g, "''")}'`);
  const cid = digits(req.query.id_Customer);
  if (cid) where.push(`id_Customer='${cid}'`);
  try {
    const rows = await fetchAllCaspioPages('/tables/Portal_Reorder_Requests/records', {
      'q.where': where.join(' AND ') || '1=1',
      'q.orderBy': 'Created DESC',
      'q.pageSize': 500,
    });
    res.json({ rows: rows || [] });
  } catch (e) {
    console.error('[portal-reorder] list failed:', e.message);
    res.status(502).json({ error: 'request list failed', detail: e.message });
  }
});

// PUT /api/portal-reorder/requests/:pk — rep updates status (New→In Progress→Quoted→Closed).
router.put('/requests/:pk', express.json(), async (req, res) => {
  const pk = digits(req.params.pk);
  if (!pk) return res.status(400).json({ error: 'valid PK_ID required' });
  const allowed = ['New', 'In Progress', 'Quoted', 'Closed'];
  const status = String((req.body && req.body.status) || '').trim();
  if (!allowed.includes(status)) return res.status(400).json({ error: `status must be one of: ${allowed.join(', ')}` });
  try {
    await axios.put(`${BASE}/tables/Portal_Reorder_Requests/records?q.where=${encodeURIComponent(`PK_ID=${pk}`)}`, { Status: status }, { headers: await authHeaders() });
    res.json({ success: true, pk, status });
  } catch (e) {
    console.error('[portal-reorder] status update failed:', e.message);
    res.status(502).json({ error: 'status update failed', detail: e.response ? e.response.data : e.message });
  }
});

// DELETE /api/portal-reorder/requests/:pk — remove a request (rep closes/clears it).
router.delete('/requests/:pk', async (req, res) => {
  const pk = digits(req.params.pk);
  if (!pk) return res.status(400).json({ error: 'valid PK_ID required' });
  try {
    await axios.delete(`${BASE}/tables/Portal_Reorder_Requests/records?q.where=${encodeURIComponent(`PK_ID=${pk}`)}`, { headers: await authHeaders() });
    res.json({ success: true, pk });
  } catch (e) {
    console.error('[portal-reorder] delete failed:', e.message);
    res.status(502).json({ error: 'request delete failed', detail: e.message });
  }
});

// GET /api/portal-reorder/recommendations — the active candidate POOL (Erik-editable).
// Returns the full active pool + margin/premium/reward metadata; the FE
// (server.js buildRecommendations(cid)) filters out styles the customer already buys and
// ranks per customer (4 premium / 2 popular). Blank Reward_Text = no "earn $X" pill.
router.get('/recommendations', async (req, res) => {
  try {
    const rows = await fetchAllCaspioPages('/tables/Portal_Recommendations/records', {
      'q.where': "Active='Yes'",
      'q.select': 'Featured_Style,Color,Title,Blurb,Category,Sort,Brand,GP_Pct,Sell_Anchor,Is_Premium,Priority,Reward_Text',
      'q.pageSize': 100,
    });
    const recs = (rows || [])
      .sort((a, b) => (Number(a.Sort) || 999) - (Number(b.Sort) || 999))
      .map(r => ({
        style: r.Featured_Style, color: r.Color || '', title: r.Title || '', blurb: r.Blurb || '', category: r.Category || '',
        brand: r.Brand || '', gpPct: Number(r.GP_Pct) || 0, sellAnchor: Number(r.Sell_Anchor) || 0,
        isPremium: String(r.Is_Premium || '').toLowerCase() === 'yes', priority: Number(r.Priority) || 999,
        rewardText: r.Reward_Text || '',
      }));
    res.json({ recommendations: recs });
  } catch (e) {
    console.error('[portal-reorder] recommendations failed:', e.message);
    res.status(502).json({ error: 'recommendations failed', detail: e.message });
  }
});

module.exports = router;
