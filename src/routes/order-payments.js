// order-payments.js — Order_Payments LEDGER (append-only) for online quote
// payments (Storefront Checkout Phase 1, 2026-07-05). This is the reporting
// MIRROR of the primary record (quote_sessions Notes JSON `payments[]`, written
// by the main app's Stripe webhook) — the main app writes both and fail-softs
// here, so a ledger outage never black-holes a payment. Every row is a signed
// event: deposit/balance positive, refund negative. No mutable balance is ever
// stored (same pattern as Customer_Reward_Ledger / customer-rewards.js).
// Writes are SERVER-initiated only (main app webhook) — mounted behind
// requireCrmApiSecret in server.js.
//
// Caspio table (Erik creates — route 502s harmlessly until it exists):
//   Order_Payments
//     QuoteID            Text(255)   — quote_sessions.QuoteID
//     Type               Text(64)    — deposit | balance | refund
//     Amount             Number      — signed dollars (refund negative)
//     Stripe_Session_ID  Text(255)
//     Payment_Intent     Text(255)
//     Payer_Email        Text(255)
//     Customer_Name      Text(255)
//     Company_Name       Text(255)
//     Created            Text(255)   — ISO timestamp written by the app
'use strict';
const express = require('express');
const router = express.Router();
const { fetchAllCaspioPages, getCaspioAccessToken } = require('../utils/caspio');
const config = require('../config');
const axios = require('axios');

const BASE = config.caspio.apiBaseUrl;
const TABLE = 'Order_Payments';
const TYPES = ['deposit', 'balance', 'refund'];

function num(v) { const n = Number(v); return isFinite(n) ? n : null; }
function clean(v, n) { return String(v == null ? '' : v).slice(0, n || 255); }
function round2(n) { return Math.round((Number(n) || 0) * 100) / 100; }
async function authHeaders() { const t = await getCaspioAccessToken(); return { Authorization: `Bearer ${t}`, 'Content-Type': 'application/json' }; }

function projectEntry(r) {
  return {
    quoteID: r.QuoteID || '', type: r.Type || '', amount: round2(r.Amount),
    stripeSessionId: r.Stripe_Session_ID || '', paymentIntent: r.Payment_Intent || '',
    payerEmail: r.Payer_Email || '', customerName: r.Customer_Name || '',
    companyName: r.Company_Name || '', created: r.Created || '',
  };
}

// POST /api/order-payments/entry — append one signed ledger row.
// Idempotent on Stripe_Session_ID for non-refund rows: a webhook redelivery
// that re-posts the same session is acknowledged, not duplicated.
router.post('/entry', express.json(), async (req, res) => {
  const b = req.body || {};
  const quoteID = clean(b.quoteID, 100).trim();
  const type = String(b.type || '').toLowerCase().trim();
  const amount = num(b.amount);
  if (!quoteID) return res.status(400).json({ error: 'quoteID required' });
  if (!TYPES.includes(type)) return res.status(400).json({ error: `type must be one of: ${TYPES.join(', ')}` });
  if (amount === null || round2(amount) === 0) return res.status(400).json({ error: 'non-zero numeric amount required' });
  let amt = round2(amount);
  if (type === 'refund') amt = -Math.abs(amt);
  try {
    const sessionId = clean(b.stripeSessionId);
    if (sessionId && type !== 'refund') {
      const existing = await fetchAllCaspioPages(`/tables/${TABLE}/records`, {
        'q.where': `Stripe_Session_ID='${sessionId.replace(/'/g, '')}' AND Type='${type}'`,
        'q.pageSize': 5,
      }) || [];
      if (existing.length) {
        return res.json({ success: true, duplicate: true, entry: projectEntry(existing[0]) });
      }
    }
    const row = {
      QuoteID: quoteID,
      Type: type,
      Amount: String(amt),
      Stripe_Session_ID: sessionId,
      Payment_Intent: clean(b.paymentIntent),
      Payer_Email: clean(b.payerEmail),
      Customer_Name: clean(b.customerName),
      Company_Name: clean(b.companyName),
      Created: new Date().toISOString(),
    };
    await axios.post(`${BASE}/tables/${TABLE}/records`, row, { headers: await authHeaders() });
    res.json({ success: true, entry: projectEntry(row) });
  } catch (e) {
    console.error('[order-payments] entry failed:', e.response ? JSON.stringify(e.response.data) : e.message);
    res.status(502).json({ error: 'order-payment entry failed', detail: e.response ? e.response.data : e.message });
  }
});

// GET /api/order-payments/by-quote/:quoteId → { netPaid, entries } for one quote.
router.get('/by-quote/:quoteId', async (req, res) => {
  const quoteID = clean(req.params.quoteId, 100).replace(/'/g, '').trim();
  if (!quoteID) return res.status(400).json({ error: 'quoteId required' });
  try {
    const rows = await fetchAllCaspioPages(`/tables/${TABLE}/records`, {
      'q.where': `QuoteID='${quoteID}'`, 'q.orderBy': 'Created DESC', 'q.pageSize': 200,
    }) || [];
    const netPaid = round2(rows.reduce((s, r) => s + (Number(r.Amount) || 0), 0));
    res.json({ netPaid, entries: rows.map(projectEntry) });
  } catch (e) {
    console.error('[order-payments] by-quote failed:', e.message);
    res.status(502).json({ error: 'lookup failed', detail: e.message });
  }
});

// GET /api/order-payments/recent?limit=50 → newest entries (staff dashboards).
router.get('/recent', async (req, res) => {
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 200);
  try {
    const rows = await fetchAllCaspioPages(`/tables/${TABLE}/records`, {
      'q.orderBy': 'Created DESC', 'q.pageSize': limit,
    }) || [];
    res.json({ entries: rows.slice(0, limit).map(projectEntry) });
  } catch (e) {
    console.error('[order-payments] recent failed:', e.message);
    res.status(502).json({ error: 'lookup failed', detail: e.message });
  }
});

module.exports = router;
