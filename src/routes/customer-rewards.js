// customer-rewards.js — Customer Portal Phase 5 reward-dollars LEDGER (append-only).
// Balance = SUM(Amount) over a customer's rows; we never store a mutable balance. Every
// change is a signed entry (+grant / -redeem). All writes are STAFF-initiated via the
// admin console (a customer can NEVER change their own balance — the FE only exposes a
// READ of the balance + a redeem REQUEST that a rep applies). Gated requireCrmApiSecret.
'use strict';
const express = require('express');
const router = express.Router();
const { fetchAllCaspioPages, getCaspioAccessToken } = require('../utils/caspio');
const config = require('../config');
const axios = require('axios');

const BASE = config.caspio.apiBaseUrl;
const TABLE = 'Customer_Reward_Ledger';
const TYPES = ['grant', 'redeem', 'adjust'];

function digits(v) { const s = String(v == null ? '' : v).trim(); return /^\d+$/.test(s) ? s : null; }
function num(v) { const n = Number(v); return isFinite(n) ? n : null; }
function clean(v, n) { return String(v == null ? '' : v).slice(0, n || 255); }
function round2(n) { return Math.round((Number(n) || 0) * 100) / 100; }
async function authHeaders() { const t = await getCaspioAccessToken(); return { Authorization: `Bearer ${t}`, 'Content-Type': 'application/json' }; }

async function ledgerFor(idCustomer) {
  return (await fetchAllCaspioPages(`/tables/${TABLE}/records`, {
    'q.where': `id_Customer='${idCustomer}'`, 'q.orderBy': 'Created DESC', 'q.pageSize': 1000,
  })) || [];
}
function balanceOf(rows) { return round2(rows.reduce((s, r) => s + (Number(r.Amount) || 0), 0)); }
function projectEntry(r) {
  return { amount: round2(r.Amount), type: r.Type || '', reason: r.Reason || '', orderRef: r.Order_Ref || '', created: r.Created || '', by: r.Created_By || '' };
}

// GET /api/customer-rewards/balance/:idCustomer → { balance, entries } (recent 20).
router.get('/balance/:idCustomer', async (req, res) => {
  const cid = digits(req.params.idCustomer);
  if (!cid) return res.status(400).json({ error: 'numeric id_Customer required' });
  try {
    const rows = await ledgerFor(cid);
    res.json({ balance: balanceOf(rows), entries: rows.slice(0, 20).map(projectEntry) });
  } catch (e) { console.error('[rewards] balance failed:', e.message); res.status(502).json({ error: 'balance failed', detail: e.message }); }
});

// GET /api/customer-rewards/ledger/:idCustomer → { balance, entries } (all, with pk — admin).
router.get('/ledger/:idCustomer', async (req, res) => {
  const cid = digits(req.params.idCustomer);
  if (!cid) return res.status(400).json({ error: 'numeric id_Customer required' });
  try {
    const rows = await ledgerFor(cid);
    res.json({ balance: balanceOf(rows), entries: rows.map(r => Object.assign({ pk: r.PK_ID }, projectEntry(r))) });
  } catch (e) { console.error('[rewards] ledger failed:', e.message); res.status(502).json({ error: 'ledger failed', detail: e.message }); }
});

// POST /api/customer-rewards/entry — add a signed ledger entry (STAFF-initiated).
// grant/adjust use the caller's sign; redeem is stored NEGATIVE. A redeem can never
// drive the balance below zero.
router.post('/entry', express.json(), async (req, res) => {
  const b = req.body || {};
  const cid = digits(b.id_Customer);
  const amount = num(b.amount);
  const type = String(b.type || '').toLowerCase().trim();
  if (!cid) return res.status(400).json({ error: 'numeric id_Customer required' });
  if (amount === null || round2(amount) === 0) return res.status(400).json({ error: 'non-zero numeric amount required' });
  if (!TYPES.includes(type)) return res.status(400).json({ error: `type must be one of: ${TYPES.join(', ')}` });
  let amt = round2(amount);
  if (type === 'redeem') amt = -Math.abs(amt);
  try {
    if (amt < 0) {
      const bal = balanceOf(await ledgerFor(cid));
      if (bal + amt < -0.001) return res.status(400).json({ error: `That exceeds the balance ($${bal.toFixed(2)} available).` });
    }
    const row = {
      id_Customer: cid,
      Company_Name: clean(b.company_name),
      Amount: String(amt),
      Type: type,
      Reason: clean(b.reason),
      Order_Ref: clean(b.order_ref, 50),
      Created: new Date().toISOString(),
      Created_By: clean(b.created_by, 120),
    };
    await axios.post(`${BASE}/tables/${TABLE}/records`, row, { headers: await authHeaders() });
    const rows = await ledgerFor(cid);
    res.json({ success: true, balance: balanceOf(rows), entry: projectEntry(row) });
  } catch (e) {
    console.error('[rewards] entry failed:', e.response ? JSON.stringify(e.response.data) : e.message);
    res.status(502).json({ error: 'reward entry failed', detail: e.response ? e.response.data : e.message });
  }
});

module.exports = router;
