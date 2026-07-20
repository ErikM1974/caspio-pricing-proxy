// vendor-portal-access.js — the invite registry for the authenticated SUBCONTRACTOR
// vendor portal (magic-link login), starting with Ed Lacey at L&P Screen Printing.
// Reads + CRUD on the Vendor_Portal_Access Caspio table (Email → Vendor_Name + Enabled).
// Vendor_Name is matched against Transfer_Orders.SP_Vendor to scope which jobs a
// logged-in vendor may see. All callers are server-to-server with the CRM secret
// (gated by requireCrmApiSecret at the mount — never browser-reachable):
//   1. The FE vendor login flow: GET /by-email/:email during magic-link request + verify.
//   2. Future staff admin console: GET / (list) + POST/PUT/DELETE (manage).
// Erik can also manage rows directly in the Caspio UI (Enabled 'Yes'/'No').
'use strict';
const express = require('express');
const router = express.Router();
const { fetchAllCaspioPages, getCaspioAccessToken } = require('../utils/caspio');
const config = require('../config');
const axios = require('axios');

const BASE = config.caspio.apiBaseUrl;
const TABLE = 'Vendor_Portal_Access';

// Strict email validation — also excludes quotes/backslash so it's safe to inline in a
// Caspio q.where clause (defense-in-depth; the value is also a server-controlled lookup).
function sanitizeEmail(email) {
  if (!email || typeof email !== 'string') return null;
  const ok = /^[^\s@'"\\]+@[^\s@'"\\]+\.[^\s@'"\\]+$/.test(email);
  return ok ? email.toLowerCase().trim() : null;
}
function sanitizePk(v) {
  const s = String(v == null ? '' : v).trim();
  return /^\d+$/.test(s) ? s : null;
}
// Enabled is 'Yes' / 'No' (Erik-friendly in the Caspio UI; read case-insensitively).
function normEnabled(v) {
  return String(v == null ? '' : v).trim().toLowerCase() === 'no' ? 'No' : 'Yes';
}
function isEnabled(v) {
  return String(v || '').trim().toLowerCase() === 'yes';
}
async function authHeaders() {
  const token = await getCaspioAccessToken();
  return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
}
function projectRow(r) {
  return {
    PK_ID: r.PK_ID,
    email: r.Email,
    vendor_name: r.Vendor_Name,
    contact_name: r.Contact_Name || null,
    enabled: isEnabled(r.Enabled),
    last_login: r.LastLogin || null,
  };
}

// GET /api/vendor-portal-access/by-email/:email → { found, access? }
//   access = { email, vendor_name, contact_name, enabled (bool) }
router.get('/by-email/:email', async (req, res) => {
  const email = sanitizeEmail(req.params.email);
  if (!email) return res.status(400).json({ error: 'valid email required' });
  try {
    const rows = await fetchAllCaspioPages(`/tables/${TABLE}/records`, {
      'q.where': `Email='${email}'`,
      'q.select': 'Email,Vendor_Name,Contact_Name,Enabled',
    });
    const row = rows && rows[0];
    if (!row) return res.json({ found: false });
    res.json({
      found: true,
      access: {
        email: row.Email,
        vendor_name: row.Vendor_Name,
        contact_name: row.Contact_Name || null,
        enabled: isEnabled(row.Enabled),
      },
    });
  } catch (e) {
    console.error('[vendor-portal-access] lookup failed:', e.message);
    res.status(502).json({ error: 'vendor-access lookup failed' });
  }
});

// POST /api/vendor-portal-access/touch-login — best-effort LastLogin stamp on a
// successful magic-link verify. Never fails the login (fire-and-forget caller).
router.post('/touch-login', express.json(), async (req, res) => {
  const email = sanitizeEmail(req.body && req.body.email);
  if (!email) return res.status(400).json({ error: 'valid email required' });
  try {
    await axios.put(
      `${BASE}/tables/${TABLE}/records?q.where=${encodeURIComponent(`Email='${email}'`)}`,
      { LastLogin: new Date().toISOString() },
      { headers: await authHeaders() }
    );
    res.json({ success: true });
  } catch (e) {
    console.error('[vendor-portal-access] touch-login failed:', e.message);
    res.status(502).json({ error: 'touch-login failed' });
  }
});

// GET /api/vendor-portal-access → { rows: [...] } — every invite, for a future admin console.
router.get('/', async (req, res) => {
  try {
    const rows = await fetchAllCaspioPages(`/tables/${TABLE}/records`, {
      'q.select': 'PK_ID,Email,Vendor_Name,Contact_Name,Enabled,LastLogin',
      'q.pageSize': 1000,
    });
    res.json({ rows: (rows || []).map(projectRow) });
  } catch (e) {
    console.error('[vendor-portal-access] list failed:', e.message);
    res.status(502).json({ error: 'vendor-access list failed', detail: e.message });
  }
});

// POST /api/vendor-portal-access — invite a vendor contact. Email is unique, so a
// duplicate is a 409. Body: { email, vendor_name, contact_name?, enabled? }.
// Enabled defaults to 'Yes' (the point of inviting).
router.post('/', express.json(), async (req, res) => {
  const email = sanitizeEmail(req.body && req.body.email);
  const vendorName = String((req.body && req.body.vendor_name) || '').trim();
  if (!email) return res.status(400).json({ error: 'valid email required' });
  if (!vendorName) return res.status(400).json({ error: 'vendor_name required' });
  const body = {
    Email: email,
    Vendor_Name: vendorName.slice(0, 255),
    Contact_Name: String((req.body && req.body.contact_name) || '').slice(0, 255),
    Enabled: normEnabled(req.body && req.body.enabled),
  };
  try {
    const existing = await fetchAllCaspioPages(`/tables/${TABLE}/records`, {
      'q.where': `Email='${email}'`, 'q.select': 'Email',
    });
    if (existing && existing.length) return res.status(409).json({ error: 'That email is already invited.' });
    await axios.post(`${BASE}/tables/${TABLE}/records`, body, { headers: await authHeaders() });
    res.json({ success: true, access: projectRow(body) });
  } catch (e) {
    console.error('[vendor-portal-access] create failed:', e.response ? JSON.stringify(e.response.data) : e.message);
    res.status(502).json({ error: 'invite create failed', detail: e.response ? e.response.data : e.message });
  }
});

// PUT /api/vendor-portal-access/:pk — update an invite by PK_ID. Only provided fields change.
router.put('/:pk', express.json(), async (req, res) => {
  const pk = sanitizePk(req.params.pk);
  if (!pk) return res.status(400).json({ error: 'valid PK_ID required' });
  const body = {};
  if (req.body && req.body.vendor_name !== undefined) body.Vendor_Name = String(req.body.vendor_name || '').slice(0, 255);
  if (req.body && req.body.contact_name !== undefined) body.Contact_Name = String(req.body.contact_name || '').slice(0, 255);
  if (req.body && req.body.enabled !== undefined) body.Enabled = normEnabled(req.body.enabled);
  if (!Object.keys(body).length) return res.status(400).json({ error: 'nothing to update' });
  try {
    await axios.put(`${BASE}/tables/${TABLE}/records?q.where=${encodeURIComponent(`PK_ID=${pk}`)}`, body, { headers: await authHeaders() });
    res.json({ success: true, pk, updated: body });
  } catch (e) {
    console.error('[vendor-portal-access] update failed:', e.response ? JSON.stringify(e.response.data) : e.message);
    res.status(502).json({ error: 'invite update failed', detail: e.response ? e.response.data : e.message });
  }
});

// DELETE /api/vendor-portal-access/:pk — remove an invite by PK_ID (revokes access).
router.delete('/:pk', async (req, res) => {
  const pk = sanitizePk(req.params.pk);
  if (!pk) return res.status(400).json({ error: 'valid PK_ID required' });
  try {
    await axios.delete(`${BASE}/tables/${TABLE}/records?q.where=${encodeURIComponent(`PK_ID=${pk}`)}`, { headers: await authHeaders() });
    res.json({ success: true, pk });
  } catch (e) {
    console.error('[vendor-portal-access] delete failed:', e.response ? JSON.stringify(e.response.data) : e.message);
    res.status(502).json({ error: 'invite delete failed', detail: e.response ? e.response.data : e.message });
  }
});

module.exports = router;
