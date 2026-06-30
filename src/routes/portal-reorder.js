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

const BASE = config.caspio.apiBaseUrl;

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
    Note: clean(b.note),
    Rep: clean(rep, 80),
    Source: source,
    Status: 'New',
    Created: stamp.iso,
  };
  try {
    await axios.post(`${BASE}/tables/Portal_Reorder_Requests/records`, row, { headers: await authHeaders() });
    // Best-effort Slack ping — the SAVED row (rep queue / DataPage) is the reliable channel;
    // this just makes it active. Skips silently if no webhook is configured.
    const hook = process.env.SLACK_PORTAL_REQUESTS_WEBHOOK_URL || process.env.SLACK_SALES_WEBHOOK_URL;
    if (hook) {
      const txt = `🛒 *Portal re-order request* — ${row.Company_Name} (#${idCustomer})\n`
        + `*${row.Style}* ${row.Color}${row.Design_Number ? ` · Design #${row.Design_Number}` : ''} · qty ${row.Qty || '?'}\n`
        + `Rep: ${row.Rep || '(unassigned)'} · ${row.Email}${row.Note ? `\nNote: ${row.Note}` : ''}`;
      axios.post(hook, { text: txt }).catch(() => {});
    }
    res.json({ success: true, request: row });
  } catch (e) {
    console.error('[portal-reorder] create failed:', e.response ? JSON.stringify(e.response.data) : e.message);
    res.status(502).json({ error: 'request create failed', detail: e.response ? e.response.data : e.message });
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

// GET /api/portal-reorder/recommendations — the active curated strip, sorted.
router.get('/recommendations', async (req, res) => {
  try {
    const rows = await fetchAllCaspioPages('/tables/Portal_Recommendations/records', {
      'q.where': "Active='Yes'",
      'q.select': 'Featured_Style,Color,Title,Blurb,Category,Sort',
      'q.pageSize': 100,
    });
    const recs = (rows || [])
      .sort((a, b) => (Number(a.Sort) || 999) - (Number(b.Sort) || 999))
      .map(r => ({ style: r.Featured_Style, color: r.Color || '', title: r.Title || '', blurb: r.Blurb || '', category: r.Category || '' }));
    res.json({ recommendations: recs });
  } catch (e) {
    console.error('[portal-reorder] recommendations failed:', e.message);
    res.status(502).json({ error: 'recommendations failed', detail: e.message });
  }
});

module.exports = router;
