// Order Lines — ShopWorks line items mirrored in Caspio (table ORDER_LINES).
//
// WHY (Erik 2026-09-02): the customer-portal reward engine needs every line of every invoiced
// order for a customer. ManageOrders only offers that as ONE call per order behind a shared
// 30-requests/minute limiter, which made a 25-order account a multi-minute crawl and a 600-order
// web-store account impossible inside Heroku's 30 s. A Caspio table answers the same question in
// one query. Rows are loaded by CSV import (Erik) from the export in the app repo
// (scratchpad/export-order-lines-2026.js) and, later, kept current by a bandit ODBC delta agent.
//
// Columns (CSV header = Caspio field names): Line_Key (upsert key = ID_Order-SortOrder), ID_Order,
// id_Customer, CustomerName, date_Ordered, date_Invoiced, date_Shipped, ORDER_TYPE, id_OrderType,
// sts_Paid, cur_Balance, cur_TotalInvoice, SortOrder, PartNumber, PartColor, PartDescription,
// LineQuantity, LineUnitPrice, LineTotal, Size01..Size06, Style, Is_Garment, SanMar_PieceCost,
// Line_BlankCost, Line_Gross, id_Design, DesignName, CustomerPurchaseOrder, CustomerServiceRep.
// ⚠️ sts_Paid / cur_Balance are a snapshot at export time — the engine reads PAID status live
// from ManageOrders and only takes the LINE facts from here.
//
// Mounted at /api and gated by requireCrmApiSecret in server.js (customer PII + financials).
//
//   GET /api/order-lines?id_Customer=1276&from=2026-01-01&to=2026-08-31[&limit=5000]
//       → { rows: [...], count, table }   (rows ordered by ID_Order, SortOrder)
//   GET /api/order-lines/coverage?id_Customer=1276
//       → { table, orders, lines, minInvoiced, maxInvoiced }   (what the mirror holds for them)

const express = require('express');
const router = express.Router();
const { fetchAllCaspioPages } = require('../utils/caspio');

const TABLE = process.env.ORDER_LINES_TABLE || 'ORDER_LINES';
const RESOURCE = `/tables/${TABLE}/records`;
const SELECT = 'Line_Key,ID_Order,id_Customer,date_Ordered,date_Invoiced,date_Shipped,ORDER_TYPE,id_OrderType,SortOrder,PartNumber,PartColor,PartDescription,LineQuantity,LineUnitPrice,LineTotal,Size01,Size02,Size03,Size04,Size05,Size06,Style,Is_Garment,SanMar_PieceCost,Line_BlankCost,Line_Gross,id_Design,DesignName';

function digits(v) { const s = String(v == null ? '' : v).trim(); return /^\d{1,12}$/.test(s) ? s : null; }
function isoDay(v) { const s = String(v == null ? '' : v).trim(); return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null; }

router.get('/order-lines', async (req, res) => {
  const cid = digits(req.query.id_Customer);
  if (!cid) return res.status(400).json({ error: 'numeric id_Customer required' });
  const from = req.query.from ? isoDay(req.query.from) : null;
  const to = req.query.to ? isoDay(req.query.to) : null;
  if ((req.query.from && !from) || (req.query.to && !to)) return res.status(400).json({ error: 'from/to must be YYYY-MM-DD' });
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 5000, 1), 20000);
  const where = [`id_Customer=${cid}`];
  if (from) where.push(`date_Invoiced>='${from}'`);
  if (to) where.push(`date_Invoiced<='${to}'`);
  try {
    const rows = await fetchAllCaspioPages(RESOURCE, {
      'q.where': where.join(' AND '),
      'q.select': SELECT,
      'q.orderBy': 'ID_Order,SortOrder',
      'q.pageSize': 1000,
    }, { maxPages: Math.ceil(limit / 1000) });
    res.json({ table: TABLE, count: rows.length, rows: rows.slice(0, limit) });
  } catch (e) {
    // A missing table (Erik has not imported yet) must read as "no mirror", not as a crash —
    // the app falls back to ManageOrders when this route is unavailable.
    const status = e.response && e.response.status;
    console.error('[order-lines] read failed:', status || '', e.message);
    res.status(status === 404 ? 404 : 502).json({ error: status === 404 ? `table ${TABLE} not found` : 'order-lines read failed' });
  }
});

router.get('/order-lines/coverage', async (req, res) => {
  const cid = digits(req.query.id_Customer);
  if (!cid) return res.status(400).json({ error: 'numeric id_Customer required' });
  try {
    const rows = await fetchAllCaspioPages(RESOURCE, {
      'q.where': `id_Customer=${cid}`,
      'q.select': 'ID_Order,date_Invoiced',
      'q.pageSize': 1000,
    }, { maxPages: 20 });
    const orders = new Set(rows.map((r) => String(r.ID_Order)));
    const days = rows.map((r) => String(r.date_Invoiced || '').slice(0, 10)).filter(Boolean).sort();
    res.json({ table: TABLE, orders: orders.size, lines: rows.length, minInvoiced: days[0] || null, maxInvoiced: days[days.length - 1] || null });
  } catch (e) {
    const status = e.response && e.response.status;
    res.status(status === 404 ? 404 : 502).json({ error: status === 404 ? `table ${TABLE} not found` : 'order-lines coverage failed' });
  }
});

module.exports = router;
