// ==========================================
// UPS Tracking Routes
// ==========================================
// Live delivery dates by tracking number, via UPS's REST Track API (OAuth client-credentials).
// We already have SanMar's UPS tracking numbers; UPS gives the REAL scheduled/estimated delivery
// date (the same data as the UPS My Choice dashboard) — exact arrival for UPS shipments, replacing
// our ship-date + business-day estimate when available.
//
// Endpoints:
//   GET /api/ups-tracking/health             — config + OAuth credential check (no secrets exposed)
//   GET /api/ups-tracking/:trackingNumber    — { deliveryDate, deliveryType, status, ... }
//
// Credentials (Heroku config vars, never in code): UPS_CLIENT_ID, UPS_CLIENT_SECRET.
// Optional: UPS_ACCOUNT (x-merchant-id), UPS_API_BASE (default production onlinetools).

const express = require('express');
const router = express.Router();
const axios = require('axios');
const NodeCache = require('node-cache');

const tokenCache = new NodeCache({ checkperiod: 120 });
const resultCache = new NodeCache({ stdTTL: 1800, checkperiod: 300 }); // track results 30 min
const UPS_BASE = process.env.UPS_API_BASE || 'https://onlinetools.ups.com';

// OAuth2 client-credentials → bearer token (cached until ~5 min before expiry).
async function getToken() {
  const cached = tokenCache.get('tok');
  if (cached) return cached;
  const id = process.env.UPS_CLIENT_ID, secret = process.env.UPS_CLIENT_SECRET;
  if (!id || !secret) { const e = new Error('UPS credentials not configured'); e.code = 'NO_CREDS'; throw e; }
  const auth = Buffer.from(`${id}:${secret}`).toString('base64');
  const headers = { Authorization: `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' };
  if (process.env.UPS_ACCOUNT) headers['x-merchant-id'] = process.env.UPS_ACCOUNT;
  const resp = await axios.post(`${UPS_BASE}/security/v1/oauth/token`, 'grant_type=client_credentials', { headers, timeout: 15000 });
  const token = resp.data.access_token;
  const ttl = Math.max(60, (parseInt(resp.data.expires_in, 10) || 14400) - 300);
  tokenCache.set('tok', token, ttl);
  return token;
}

// UPS dates are YYYYMMDD → ISO YYYY-MM-DD.
function ymd(d) { const s = String(d || ''); return /^\d{8}$/.test(s) ? `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}` : ''; }

// Track one number → normalized delivery info. type priority: delivered > rescheduled > scheduled.
async function trackOne(trackingNumber, refresh) {
  if (!refresh) { const c = resultCache.get(trackingNumber); if (c) return c; }
  const token = await getToken();
  const resp = await axios.get(`${UPS_BASE}/api/track/v1/details/${encodeURIComponent(trackingNumber)}`, {
    headers: { Authorization: `Bearer ${token}`, transId: `nwca-inbound-${Date.now()}`, transactionSrc: 'NWCA-Inbound' },
    timeout: 20000,
  });
  const shipments = (((resp.data || {}).trackResponse || {}).shipment) || [];
  const p = ((shipments[0] || {}).package || [])[0] || {};
  const byType = {};
  (p.deliveryDate || []).forEach(d => { if (d && d.type) byType[d.type] = ymd(d.date); });
  const deliveryDate = byType.DEL || byType.RDD || byType.SDD || ((p.deliveryDate || [])[0] && ymd(p.deliveryDate[0].date)) || '';
  const deliveryType = byType.DEL ? 'delivered' : byType.RDD ? 'rescheduled' : byType.SDD ? 'scheduled' : '';
  const result = {
    trackingNumber,
    deliveryDate,                                   // YYYY-MM-DD — UPS's real scheduled/actual date
    deliveryType,                                   // delivered | rescheduled | scheduled | ''
    status: (p.currentStatus || {}).description || '',
    statusCode: (p.currentStatus || {}).code || '',
    deliveryTime: (p.deliveryTime || {}).endTime || '',
    fetchedAt: new Date().toISOString(),
    source: 'ups',
  };
  resultCache.set(trackingNumber, result);
  return result;
}

// Validates the OAuth credentials by fetching a token — never returns the secret/token itself.
router.get('/health', async (req, res) => {
  const configured = !!(process.env.UPS_CLIENT_ID && process.env.UPS_CLIENT_SECRET);
  if (!configured) return res.json({ configured: false, tokenOk: false, note: 'Set UPS_CLIENT_ID / UPS_CLIENT_SECRET as config vars.' });
  try {
    await getToken();
    res.json({ configured: true, tokenOk: true, base: UPS_BASE });
  } catch (e) {
    res.status((e.response && e.response.status) || 500).json({ configured: true, tokenOk: false, status: e.response && e.response.status, details: (e.response && e.response.data) || e.message });
  }
});

router.get('/:trackingNumber', async (req, res) => {
  try {
    res.json(await trackOne(req.params.trackingNumber, !!req.query.refresh));
  } catch (e) {
    if (e.code === 'NO_CREDS') return res.status(503).json({ error: 'UPS credentials not configured' });
    const status = e.response && e.response.status;
    res.status(status === 401 ? 401 : 502).json({ error: 'UPS tracking failed', status, details: (e.response && e.response.data) || e.message });
  }
});

module.exports = router;
module.exports.trackOne = trackOne;
module.exports.getToken = getToken;
