// customer-portal-access.js — the invite registry for the authenticated customer portal
// (magic-link login). Reads + CRUD on the Customer_Portal_Access Caspio table
// (Email → id_Customer + Enabled). Two classes of caller, BOTH server-to-server with
// the CRM secret (gated by requireCrmApiSecret at the mount — never browser-reachable):
//   1. The FE login flow: GET /by-email/:email during magic-link request + verify.
//   2. The staff "Customer Portals" admin console: GET / (list) + POST/PUT/DELETE (manage),
//      reached ONLY through the FE's role-gated /api/crm-proxy/customer-portal-access route.
'use strict';
const express = require('express');
const router = express.Router();
const { fetchAllCaspioPages, getCaspioAccessToken } = require('../utils/caspio');
const config = require('../config');
const axios = require('axios');

const BASE = config.caspio.apiBaseUrl;
const TABLE = 'Customer_Portal_Access';

// Strict email validation — also excludes quotes/backslash so it's safe to inline in a
// Caspio q.where clause (defense-in-depth; the value is also a server-controlled lookup).
function sanitizeEmail(email) {
  if (!email || typeof email !== 'string') return null;
  const ok = /^[^\s@'"\\]+@[^\s@'"\\]+\.[^\s@'"\\]+$/.test(email);
  return ok ? email.toLowerCase().trim() : null;
}
// id_Customer is a ShopWorks numeric id stored as text — digits only.
function sanitizeCustomerId(v) {
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
    id_Customer: r.id_Customer,
    company_name: r.Company_Name,
    enabled: isEnabled(r.Enabled),
    role: r.Role || null,
    last_login: r.LastLogin || null,
  };
}

// GET /api/customer-portal-access/by-email/:email → { found, access? }
//   access = { email, id_Customer, company_name, enabled (bool), role }
router.get('/by-email/:email', async (req, res) => {
  const email = sanitizeEmail(req.params.email);
  if (!email) return res.status(400).json({ error: 'valid email required' });
  try {
    const rows = await fetchAllCaspioPages(`/tables/${TABLE}/records`, {
      'q.where': `Email='${email}'`,
      'q.select': 'Email,id_Customer,Company_Name,Enabled,Role',
    });
    const row = rows && rows[0];
    if (!row) return res.json({ found: false });
    res.json({
      found: true,
      access: {
        email: row.Email,
        id_Customer: row.id_Customer,
        company_name: row.Company_Name,
        enabled: isEnabled(row.Enabled),
        role: row.Role || null,
      },
    });
  } catch (e) {
    console.error('[customer-portal-access] lookup failed:', e.message);
    res.status(502).json({ error: 'portal-access lookup failed' });
  }
});

// GET /api/customer-portal-access → { rows: [...] } — every invite, for the admin console.
// Each row is enriched with the AUTHORITATIVE owning rep + tier from Sales_Reps_2026
// (CRM source-of-truth, keyed by ID_Customer) so the console shows whose account it is and
// can offer a "my customers" filter. The join is best-effort (never fails the list).
router.get('/', async (req, res) => {
  try {
    const rows = await fetchAllCaspioPages(`/tables/${TABLE}/records`, {
      'q.select': 'PK_ID,Email,id_Customer,Company_Name,Enabled,Role,LastLogin',
      'q.pageSize': 1000,
    });
    const projected = (rows || []).map(projectRow);
    const ids = [...new Set(projected.map(r => String(r.id_Customer || '')).filter(s => /^\d+$/.test(s)))];
    if (ids.length) {
      try {
        const reps = await fetchAllCaspioPages('/tables/Sales_Reps_2026/records', {
          'q.where': `ID_Customer IN (${ids.join(',')})`,
          'q.select': 'ID_Customer,CustomerServiceRep,Account_Tier',
          'q.pageSize': 1000,
        });
        const repMap = {};
        (reps || []).forEach(r => { repMap[String(r.ID_Customer)] = r; });
        projected.forEach(r => {
          const m = repMap[String(r.id_Customer)];
          r.account_rep = m && m.CustomerServiceRep ? m.CustomerServiceRep : null;
          r.account_tier = m && m.Account_Tier ? m.Account_Tier : null;
        });
      } catch (e) {
        console.warn('[customer-portal-access] rep enrich failed (non-fatal):', e.message);
      }
    }
    res.json({ rows: projected });
  } catch (e) {
    console.error('[customer-portal-access] list failed:', e.message);
    res.status(502).json({ error: 'portal-access list failed', detail: e.message });
  }
});

// POST /api/customer-portal-access — invite a contact (create a row). Email is unique,
// so a duplicate is a 409 (the UI should PUT instead). Body: { email, id_Customer,
// company_name, enabled?, role? }. Enabled defaults to 'Yes' (the point of inviting).
router.post('/', express.json(), async (req, res) => {
  const email = sanitizeEmail(req.body && req.body.email);
  const idCustomer = sanitizeCustomerId(req.body && req.body.id_Customer);
  if (!email) return res.status(400).json({ error: 'valid email required' });
  if (!idCustomer) return res.status(400).json({ error: 'numeric id_Customer required' });
  const body = {
    Email: email,
    id_Customer: idCustomer,
    Company_Name: String((req.body && req.body.company_name) || '').slice(0, 255),
    Enabled: normEnabled(req.body && req.body.enabled),
    Role: String((req.body && req.body.role) || '').slice(0, 100),
  };
  try {
    const existing = await fetchAllCaspioPages(`/tables/${TABLE}/records`, {
      'q.where': `Email='${email}'`, 'q.select': 'Email',
    });
    if (existing && existing.length) return res.status(409).json({ error: 'That email is already invited.' });
    await axios.post(`${BASE}/tables/${TABLE}/records`, body, { headers: await authHeaders() });
    res.json({ success: true, access: projectRow(body) });
  } catch (e) {
    console.error('[customer-portal-access] create failed:', e.response ? JSON.stringify(e.response.data) : e.message);
    res.status(502).json({ error: 'invite create failed', detail: e.response ? e.response.data : e.message });
  }
});

// PUT /api/customer-portal-access/:pk — update an invite by PK_ID. Only the provided
// fields change (enable/disable, fix the company name or id_Customer, set a role).
router.put('/:pk', express.json(), async (req, res) => {
  const pk = sanitizeCustomerId(req.params.pk);
  if (!pk) return res.status(400).json({ error: 'valid PK_ID required' });
  const body = {};
  if (req.body && req.body.company_name !== undefined) body.Company_Name = String(req.body.company_name || '').slice(0, 255);
  if (req.body && req.body.role !== undefined) body.Role = String(req.body.role || '').slice(0, 100);
  if (req.body && req.body.enabled !== undefined) body.Enabled = normEnabled(req.body.enabled);
  if (req.body && req.body.id_Customer !== undefined) {
    const id = sanitizeCustomerId(req.body.id_Customer);
    if (!id) return res.status(400).json({ error: 'numeric id_Customer required' });
    body.id_Customer = id;
  }
  if (!Object.keys(body).length) return res.status(400).json({ error: 'nothing to update' });
  try {
    await axios.put(`${BASE}/tables/${TABLE}/records?q.where=${encodeURIComponent(`PK_ID=${pk}`)}`, body, { headers: await authHeaders() });
    res.json({ success: true, pk, updated: body });
  } catch (e) {
    console.error('[customer-portal-access] update failed:', e.response ? JSON.stringify(e.response.data) : e.message);
    res.status(502).json({ error: 'invite update failed', detail: e.response ? e.response.data : e.message });
  }
});

// DELETE /api/customer-portal-access/:pk — remove an invite by PK_ID (revokes access).
router.delete('/:pk', async (req, res) => {
  const pk = sanitizeCustomerId(req.params.pk);
  if (!pk) return res.status(400).json({ error: 'valid PK_ID required' });
  try {
    await axios.delete(`${BASE}/tables/${TABLE}/records?q.where=${encodeURIComponent(`PK_ID=${pk}`)}`, { headers: await authHeaders() });
    res.json({ success: true, pk });
  } catch (e) {
    console.error('[customer-portal-access] delete failed:', e.response ? JSON.stringify(e.response.data) : e.message);
    res.status(502).json({ error: 'invite delete failed', detail: e.response ? e.response.data : e.message });
  }
});

module.exports = router;
