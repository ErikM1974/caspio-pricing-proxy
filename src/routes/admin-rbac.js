// admin-rbac.js — CRUD for the two RBAC tables, powering the Erik-only Access-Admin UI.
//   Staff_App_Roles   (Email → Role)
//   Staff_Page_Access (Page → Allowed_Roles / Allowed_Emails / Description)
// Mounted requireCrmApiSecret-gated; the front-end exposes it ONLY through an
// admin-role-gated crm-proxy route, so reaching it needs the secret AND an admin session.
'use strict';
const express = require('express');
const router = express.Router();
const { fetchAllCaspioPages, getCaspioAccessToken } = require('../utils/caspio');
const config = require('../config');
const axios = require('axios');

const BASE = config.caspio.apiBaseUrl;
const KNOWN_ROLES = ['admin', 'accountant', 'sales', 'art', 'shipping', 'production', 'staff'];

function validEmail(e) { return typeof e === 'string' && /^[^\s@'"\\]+@[^\s@'"\\]+\.[^\s@'"\\]+$/.test(e); }
function safePage(p) { return typeof p === 'string' && /^[a-zA-Z0-9._-]+\.html$/.test(p); }
function csvRoles(s) { // sanitize a comma list of role tokens (letters/numbers/-/_)
  return String(s || '').split(',').map(x => x.trim().toLowerCase()).filter(x => /^[a-z0-9_-]+$/.test(x)).join(',');
}
function csvEmails(s) {
  return String(s || '').split(',').map(x => x.trim().toLowerCase()).filter(validEmail).join(',');
}
async function authHeaders() {
  const token = await getCaspioAccessToken();
  return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
}
async function upsert(table, whereField, whereVal, body) {
  const H = await authHeaders();
  const where = `${whereField}='${whereVal}'`;
  try { await axios.post(`${BASE}/tables/${table}/records`, body, { headers: H }); }
  catch (_) { await axios.put(`${BASE}/tables/${table}/records?q.where=${encodeURIComponent(where)}`, body, { headers: H }); }
}
async function removeRow(table, whereField, whereVal) {
  const H = await authHeaders();
  await axios.delete(`${BASE}/tables/${table}/records?q.where=${encodeURIComponent(`${whereField}='${whereVal}'`)}`, { headers: H });
}

// ---- Roles ----
router.get('/roles', async (req, res) => {
  try { res.json({ rows: await fetchAllCaspioPages('/tables/Staff_App_Roles/records', { 'q.select': 'Email,Role', 'q.pageSize': 200 }) }); }
  catch (e) { res.status(502).json({ error: 'roles read failed', detail: e.message }); }
});
router.put('/roles', async (req, res) => {
  const email = String(req.body?.email || '').toLowerCase().trim();
  const role = String(req.body?.role || '').toLowerCase().trim();
  if (!validEmail(email)) return res.status(400).json({ error: 'valid email required' });
  if (!KNOWN_ROLES.includes(role)) return res.status(400).json({ error: `role must be one of: ${KNOWN_ROLES.join(', ')}` });
  try { await upsert('Staff_App_Roles', 'Email', email, { Email: email, Role: role }); res.json({ success: true, email, role }); }
  catch (e) { res.status(502).json({ error: 'role write failed', detail: e.response ? e.response.data : e.message }); }
});
router.delete('/roles', async (req, res) => {
  const email = String(req.query.email || '').toLowerCase().trim();
  if (!validEmail(email)) return res.status(400).json({ error: 'valid email required' });
  try { await removeRow('Staff_App_Roles', 'Email', email); res.json({ success: true, email }); }
  catch (e) { res.status(502).json({ error: 'role delete failed', detail: e.message }); }
});

// ---- Page access ----
router.get('/pages', async (req, res) => {
  try { res.json({ rows: await fetchAllCaspioPages('/tables/Staff_Page_Access/records', { 'q.select': 'Page,Allowed_Roles,Allowed_Emails,Description', 'q.pageSize': 300 }) }); }
  catch (e) { res.status(502).json({ error: 'pages read failed', detail: e.message }); }
});
router.put('/pages', async (req, res) => {
  const page = String(req.body?.page || '').trim();
  if (!safePage(page)) return res.status(400).json({ error: 'page must be a *.html filename' });
  const body = {
    Page: page,
    Allowed_Roles: csvRoles(req.body?.allowedRoles),
    Allowed_Emails: csvEmails(req.body?.allowedEmails),
    Description: String(req.body?.description || '').slice(0, 255),
  };
  if (!body.Allowed_Roles && !body.Allowed_Emails) return res.status(400).json({ error: 'set at least one role or email (else remove the rule)' });
  try { await upsert('Staff_Page_Access', 'Page', page, body); res.json({ success: true, ...body }); }
  catch (e) { res.status(502).json({ error: 'page write failed', detail: e.response ? e.response.data : e.message }); }
});
router.delete('/pages', async (req, res) => {
  const page = String(req.query.page || '').trim();
  if (!safePage(page)) return res.status(400).json({ error: 'valid page required' });
  try { await removeRow('Staff_Page_Access', 'Page', page); res.json({ success: true, page }); }
  catch (e) { res.status(502).json({ error: 'page delete failed', detail: e.message }); }
});

module.exports = router;
