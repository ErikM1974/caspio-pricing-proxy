// product-upgrades.js — the Erik-editable "good -> better -> best" upgrade ladder for the customer
// portal product page (Phase C). Keyed by CATEGORY (matches product-details CATEGORY_NAME). Mounted
// requireCrmApiSecret-gated (server-to-server + the admin console via /api/crm-proxy) — no public caller.
//
//   GET  /api/product-upgrades?category=T-Shirts[&excludeStyle=PC61]  -> customer-safe upgrades for a category
//   GET  /api/product-upgrades?all=1                                   -> full rows incl. margin (admin editor)
//   POST /api/product-upgrades                                         -> create a ladder row
//   PUT  /api/product-upgrades/:pk                                     -> update a row
//   DELETE /api/product-upgrades/:pk                                   -> delete a row
'use strict';
const express = require('express');
const router = express.Router();
const { fetchAllCaspioPages, getCaspioAccessToken } = require('../utils/caspio');
const config = require('../config');
const axios = require('axios');

const BASE = config.caspio.apiBaseUrl;
const TABLE = 'Product_Upgrades';
const FIELDS = ['Category', 'From_Style', 'Tier', 'Upgrade_Style', 'Upgrade_Title', 'Default_Stitch', 'Default_Location', 'Sell_Anchor', 'GP_Pct', 'Blurb', 'Active', 'Sort'];

function sanitizePk(v) { const s = String(v == null ? '' : v).trim(); return /^\d+$/.test(s) ? s : null; }
async function authHeaders() { const t = await getCaspioAccessToken(); return { Authorization: `Bearer ${t}`, 'Content-Type': 'application/json' }; }
function isYes(v) { return String(v || '').trim().toLowerCase() === 'yes'; }
// Internal margin rank: Sell_Anchor $ × GP% (GP% may be 0-100 or 0-1). NEVER shipped to the browser.
function score(r) { const a = Number(r.Sell_Anchor) || 0; let g = Number(r.GP_Pct) || 0; if (g > 1) g = g / 100; return a * g; }
// Customer-safe projection — strips Sell_Anchor / GP_Pct.
function project(r) {
  return {
    pk: r.PK_ID, category: r.Category, fromStyle: r.From_Style || '', tier: r.Tier || '',
    style: r.Upgrade_Style, title: r.Upgrade_Title || '', stitch: Number(r.Default_Stitch) || 8000,
    location: r.Default_Location || 'Left Chest', blurb: r.Blurb || '', sort: Number(r.Sort) || 0,
    active: isYes(r.Active),
  };
}

// GET — list. ?category= (customer-safe, active-only, margin-ranked); ?all=1 (admin, full rows).
router.get('/', async (req, res) => {
  try {
    const rows = await fetchAllCaspioPages(`/tables/${TABLE}/records`, { 'q.pageSize': 500 }) || [];
    const all = String(req.query.all || '') === '1';
    let list = all ? rows : rows.filter((r) => isYes(r.Active));
    const cat = String(req.query.category || '').trim();
    if (cat) list = list.filter((r) => String(r.Category || '').trim().toLowerCase() === cat.toLowerCase());
    const excl = String(req.query.excludeStyle || '').trim().toUpperCase();
    if (excl) list = list.filter((r) => String(r.Upgrade_Style || '').trim().toUpperCase() !== excl);
    list.sort((a, b) => (Number(a.Sort) || 0) - (Number(b.Sort) || 0) || (score(b) - score(a)));
    // admin view keeps the margin fields (for editing); customer view is projected clean
    const out = all ? list.map((r) => Object.assign(project(r), { sellAnchor: r.Sell_Anchor, gpPct: r.GP_Pct })) : list.map(project);
    res.json({ upgrades: out });
  } catch (e) {
    console.error('[product-upgrades] list failed:', e.message);
    res.status(502).json({ error: 'product-upgrades list failed', detail: e.message });
  }
});

// POST — create a ladder row.
router.post('/', express.json(), async (req, res) => {
  const b = req.body || {};
  if (!b.Category || !b.Upgrade_Style) return res.status(400).json({ error: 'Category and Upgrade_Style required' });
  const row = {};
  FIELDS.forEach((k) => { row[k] = String(b[k] == null ? '' : b[k]).slice(0, 255); });
  if (!row.Default_Stitch) row.Default_Stitch = '8000';
  if (!row.Default_Location) row.Default_Location = 'Left Chest';
  row.Active = isYes(b.Active === undefined ? 'Yes' : b.Active) ? 'Yes' : 'No';
  try {
    await axios.post(`${BASE}/tables/${TABLE}/records`, row, { headers: await authHeaders() });
    res.json({ success: true, row: project(row) });
  } catch (e) {
    console.error('[product-upgrades] create failed:', e.response ? JSON.stringify(e.response.data) : e.message);
    res.status(502).json({ error: 'create failed', detail: e.response ? e.response.data : e.message });
  }
});

// PUT — update a row by PK_ID (only provided fields change).
router.put('/:pk', express.json(), async (req, res) => {
  const pk = sanitizePk(req.params.pk);
  if (!pk) return res.status(400).json({ error: 'valid PK_ID required' });
  const b = req.body || {};
  const row = {};
  FIELDS.forEach((k) => { if (b[k] !== undefined) row[k] = String(b[k]).slice(0, 255); });
  if (row.Active !== undefined) row.Active = isYes(row.Active) ? 'Yes' : 'No';
  if (!Object.keys(row).length) return res.status(400).json({ error: 'nothing to update' });
  try {
    await axios.put(`${BASE}/tables/${TABLE}/records?q.where=${encodeURIComponent('PK_ID=' + pk)}`, row, { headers: await authHeaders() });
    res.json({ success: true, pk, updated: row });
  } catch (e) {
    console.error('[product-upgrades] update failed:', e.response ? JSON.stringify(e.response.data) : e.message);
    res.status(502).json({ error: 'update failed', detail: e.response ? e.response.data : e.message });
  }
});

// DELETE — remove a row by PK_ID.
router.delete('/:pk', async (req, res) => {
  const pk = sanitizePk(req.params.pk);
  if (!pk) return res.status(400).json({ error: 'valid PK_ID required' });
  try {
    await axios.delete(`${BASE}/tables/${TABLE}/records?q.where=${encodeURIComponent('PK_ID=' + pk)}`, { headers: await authHeaders() });
    res.json({ success: true, pk });
  } catch (e) {
    console.error('[product-upgrades] delete failed:', e.response ? JSON.stringify(e.response.data) : e.message);
    res.status(502).json({ error: 'delete failed', detail: e.response ? e.response.data : e.message });
  }
});

module.exports = router;
