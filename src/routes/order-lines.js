// Order Lines — ShopWorks line items from the Caspio archive table ManageOrders_LineItems.
//
// WHY (Erik 2026-09-02): the customer-portal reward engine needs every line of every invoiced
// order for a customer. ManageOrders offers that only as ONE call per order behind a shared
// 30-requests/minute limiter, which made a 25-order account a multi-minute crawl and a 600-order
// web-store account impossible inside Heroku's 30 s. The archive tables already exist and are
// kept current by scripts/sync-manageorders.js (Heroku Scheduler, daily 12:00 UTC: last 60 days
// of orders, line items for new/changed orders, history preserved) — so read THAT, in one query.
//
// ManageOrders_LineItems columns: id_Order, PartNumber, PartDescription, PartColor, LineQuantity,
// LineUnitPrice, SortOrder, Size01..Size06. There is NO id_Customer on the lines — callers pass the
// order numbers they already hold (the engine gets them from ManageOrders /orders, which also
// carries LIVE paid status; the archive's sts_Paid is at most a day old).
//
// Mounted at /api and gated by requireCrmApiSecret in server.js (customer financials).
//
//   GET /api/order-lines?orders=140567,140568,…      (≤200 ids per call)
//       → { table, count, rows: [...] }              rows ordered by id_Order, SortOrder
//   GET /api/order-lines/coverage?id_Customer=1276[&from=YYYY-MM-DD][&to=YYYY-MM-DD]
//       → { table, ordersInArchive, ordersWithLines, lines, minInvoiced, maxInvoiced, missingOrders: [...] }
//       (ManageOrders_Orders rows for the customer in the window vs. which of them have lines)

const express = require('express');
const router = express.Router();
const { fetchAllCaspioPages } = require('../utils/caspio');

const LINES_TABLE = process.env.ORDER_LINES_TABLE || 'ManageOrders_LineItems';
const ORDERS_TABLE = process.env.ORDER_HEADERS_TABLE || 'ManageOrders_Orders';
// The six extended columns exist since Erik's 2026-09-02 re-import (a q.select naming a missing column 400s).
const LINE_SELECT = 'id_Order,PartNumber,PartDescription,PartColor,LineQuantity,LineUnitPrice,SortOrder,Size01,Size02,Size03,Size04,Size05,Size06,Line_Key,id_Customer,id_OrderType,Style,Is_Garment,SanMar_PieceCost';
const MAX_IDS = 200;
const CHUNK = 50;   // ids per Caspio IN (...) clause — keeps the q.where short and the pages small

function idList(v) {
  return [...new Set(String(v || '').split(',').map((s) => s.trim()).filter((s) => /^\d{1,12}$/.test(s)))];
}
function isoDay(v) { const s = String(v == null ? '' : v).trim(); return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null; }
function caspioStatus(e) { return e && e.response && e.response.status; }

router.get('/order-lines', async (req, res) => {
  const ids = idList(req.query.orders);
  if (!ids.length) return res.status(400).json({ error: 'orders=<comma-separated numeric order ids> required' });
  if (ids.length > MAX_IDS) return res.status(400).json({ error: `at most ${MAX_IDS} order ids per call` });
  try {
    const rows = [];
    for (let i = 0; i < ids.length; i += CHUNK) {
      const part = await fetchAllCaspioPages(`/tables/${LINES_TABLE}/records`, {
        'q.where': `id_Order IN (${ids.slice(i, i + CHUNK).join(',')})`,
        'q.select': LINE_SELECT,
        'q.pageSize': 1000,
      }, { maxPages: 10 });
      rows.push(...part);
    }
    rows.sort((a, b) => (Number(a.id_Order) - Number(b.id_Order)) || (Number(a.SortOrder) - Number(b.SortOrder)));
    res.json({ table: LINES_TABLE, count: rows.length, rows });
  } catch (e) {
    const status = caspioStatus(e);
    console.error('[order-lines] read failed:', status || '', e.message);
    res.status(status === 404 ? 404 : 502).json({ error: status === 404 ? `table ${LINES_TABLE} not found` : 'order-lines read failed' });
  }
});

router.get('/order-lines/coverage', async (req, res) => {
  const cid = String(req.query.id_Customer || '').trim();
  if (!/^\d{1,12}$/.test(cid)) return res.status(400).json({ error: 'numeric id_Customer required' });
  const from = req.query.from ? isoDay(req.query.from) : null;
  const to = req.query.to ? isoDay(req.query.to) : null;
  if ((req.query.from && !from) || (req.query.to && !to)) return res.status(400).json({ error: 'from/to must be YYYY-MM-DD' });
  try {
    const where = [`id_Customer=${cid}`];
    if (from) where.push(`date_Invoiced>='${from}'`);
    if (to) where.push(`date_Invoiced<='${to}T23:59:59'`);
    const orders = await fetchAllCaspioPages(`/tables/${ORDERS_TABLE}/records`, {
      'q.where': where.join(' AND '), 'q.select': 'id_Order,date_Invoiced', 'q.pageSize': 1000,
    }, { maxPages: 10 });
    const ids = [...new Set(orders.map((o) => String(o.id_Order)).filter((s) => /^\d+$/.test(s)))];
    const withLines = new Set(); let lines = 0;
    for (let i = 0; i < ids.length; i += CHUNK) {
      const part = await fetchAllCaspioPages(`/tables/${LINES_TABLE}/records`, {
        'q.where': `id_Order IN (${ids.slice(i, i + CHUNK).join(',')})`, 'q.select': 'id_Order', 'q.pageSize': 1000,
      }, { maxPages: 10 });
      part.forEach((r) => withLines.add(String(r.id_Order))); lines += part.length;
    }
    const days = orders.map((o) => String(o.date_Invoiced || '').slice(0, 10)).filter(Boolean).sort();
    res.json({
      table: LINES_TABLE, ordersInArchive: ids.length, ordersWithLines: withLines.size, lines,
      minInvoiced: days[0] || null, maxInvoiced: days[days.length - 1] || null,
      missingOrders: ids.filter((id) => !withLines.has(id)),
    });
  } catch (e) {
    const status = caspioStatus(e);
    res.status(status === 404 ? 404 : 502).json({ error: status === 404 ? 'archive table not found' : 'order-lines coverage failed' });
  }
});

module.exports = router;
