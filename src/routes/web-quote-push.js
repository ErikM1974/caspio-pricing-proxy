'use strict';
const express = require('express');
const axios = require('axios');
const crypto = require('crypto');
const { fetchAllCaspioPages, putWithRecordsAffected } = require('../utils/caspio');
const quoteSessionsCache = require('../utils/quote-sessions-cache');
const { requireCrmApiSecret } = require('../middleware');
const { getTokenForEndpoint } = require('../../lib/manageorders-push-auth');
const { EMB_BASE_URL } = require('../../config/manageorders-emb-config');
const { buildPreview } = require('../../lib/web-quote-push');
const router = express.Router();
const TABLE = '/tables/Quote_Sessions/records';

// Server-to-server only, including preview. No browser-origin bypass.
router.use(requireCrmApiSecret);
async function load(body) {
  const { quoteId, customerNumber } = body;
  if (!/^WQ[\d-]+$/.test(quoteId || '') || !/^[1-9]\d{0,8}$/.test(String(customerNumber || ''))) {
    throw Object.assign(new Error('A WQ quote ID and positive ShopWorks customer number are required.'), { status: 400 });
  }
  const sessions = await fetchAllCaspioPages(TABLE, { 'q.where': `QuoteID='${quoteId}'`, 'q.orderBy': 'PK_ID DESC' });
  if (!sessions.length) throw Object.assign(new Error('Quote not found.'), { status: 404 });
  const pushed = sessions.find(s => s.PushedToShopWorks || Number(s.ShopWorks_Order_Number) > 0 ||
    s.ShopWorks_Status === 'Imported' || String(s.ShopWorks_Snapshot || '').trim());
  if (pushed) throw Object.assign(new Error('This quote was submitted or has a pending submission. Check ShopWorks before taking further action.'), { status: 409, code: 'ALREADY_SUBMITTED' });
  const customers = await fetchAllCaspioPages('/tables/CompanyContactsMerge2026/records', { 'q.where': `id_Customer=${Number(customerNumber)} AND Is_Active=1` });
  if (!customers.length) throw Object.assign(new Error('No active ShopWorks customer matches that number.'), { status: 422 });
  const items = await fetchAllCaspioPages('/tables/Quote_Items/records', { 'q.where': `QuoteID='${quoteId}'`, 'q.orderBy': 'LineNumber ASC' });
  return { session: sessions[0], preview: buildPreview(sessions[0], items, customers[0]) };
}
function errorResponse(res, error) {
  return res.status(error.status || 502).json({ error: error.status ? error.message : 'Unable to load the quote or customer. Try again.', code: error.code });
}
router.post('/preview', async (req, res) => {
  try {
    const { preview } = await load(req.body || {});
    const { order, ...publicPreview } = preview;
    res.set('Cache-Control', 'no-store').json(publicPreview);
  } catch (error) { errorResponse(res, error); }
});
router.post('/push-quote', async (req, res) => {
  let reserved = false;
  let extOrderId;
  try {
    if (req.body?.force || req.body?.isTest) return res.status(400).json({ error: 'Force and test pushes are not supported here.' });
    const { session, preview } = await load(req.body || {});
    extOrderId = preview.extOrderId;
    if (!req.body.previewToken || req.body.previewToken !== preview.previewToken) return res.status(409).json({ error: 'The quote or customer changed. Preview it again before pushing.', code: 'PREVIEW_CHANGED' });
    const token = await getTokenForEndpoint(EMB_BASE_URL);
    const reservation = `WQ-REVIEW:${crypto.randomUUID()}`;
    // Atomic compare-and-set survives multiple processes, restarts and timeout.
    // Never clear this automatically: an uncertain POST may have been accepted.
    const claimed = await putWithRecordsAffected(TABLE,
      `PK_ID=${Number(session.PK_ID)} AND (PushedToShopWorks IS NULL OR PushedToShopWorks='')`,
      { PushedToShopWorks: reservation });
    quoteSessionsCache.invalidate('WQ push reservation');
    if (claimed.RecordsAffected !== 1) return res.status(409).json({ error: 'Another submission may be in progress. Check ShopWorks before trying again.', code: 'ALREADY_SUBMITTED' });
    reserved = true;
    const response = await axios.post(`${EMB_BASE_URL}/order-push`, preview.order, {
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json' }, timeout: 30000
    });
    if (response.data?.success === false || response.data?.error || response.data?.errors?.length) throw new Error('ManageOrders did not confirm acceptance.');
    const timestamp = new Date().toISOString();
    const saved = await putWithRecordsAffected(TABLE, `PK_ID=${Number(session.PK_ID)} AND PushedToShopWorks='${reservation}'`,
      { PushedToShopWorks: timestamp, CustomerNumber: String(preview.customerNumber), ShopWorks_Status: 'Pending' });
    if (saved.RecordsAffected !== 1) throw new Error('Submission status could not be saved.');
    quoteSessionsCache.invalidate('WQ push completed');
    res.json({ success: true, timestamp, extOrderId, message: 'Submitted for import on hold.' });
  } catch (error) {
    if (reserved) return res.status(502).json({ error: `Submission needs verification. Check ShopWorks for ${extOrderId}. Do not submit it again.`, code: 'SUBMISSION_UNCERTAIN', extOrderId });
    errorResponse(res, error);
  }
});
module.exports = router;
