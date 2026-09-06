// Batched Caspio reads + diff-before-write for the SanMar sync family
// (2026-09-06 Caspio quota reduction).
//
// Before this, every order the daily sync touched cost a GET ("does the row
// exist?") followed by a PUT or POST, and every LINE ITEM cost the same pair —
// two billed calls per row, changed or not. The daily backfill re-walks every
// open order (allOpen) each morning: 148 open orders and 736 items measured
// 2026-09-06, ~900 SanMar-table calls in the 6 AM Pacific hour.
//
// Now a run loads what Caspio already holds in a few chunked reads (100 POs per
// query, one query per table), then:
//   • ORDERS are always written (PUT if present, POST if not). Two consumers
//     read Last_Sync_Date as "the sync last confirmed this order at T":
//     /status-summary's lastSync (sync-sanmar.js waits on it after an H12) and
//     sync-recent-completed's stale-order discovery (an open order the sync
//     stops touching for 2 days is re-pulled from SanMar). Skipping the PUT
//     would break both, so the order write is kept and only its GET is saved.
//   • ITEMS are written only when Qty_Ordered / Qty_Shipped / Item_Status differ
//     from the stored row. Most items are unchanged day to day.
//   • CARTONS (SanMar_Shipments) are POSTed only when (PO, Tracking_Number) is
//     not already held — the same seen-set idea sweepRecentShipments uses.
//
// Semantics preserved from the per-row code: the PUT where-clauses are the same
// keys (SanMar_PO for orders; SanMar_PO + Style + Part_ID for items), so a
// duplicated item row is updated the same way it always was; a POST carries the
// same fields; a Caspio failure on one row is caught by the caller per row.

const { makeCaspioRequest, fetchAllCaspioPages } = require('./caspio');

const TABLES = {
  orders: 'SanMar_Orders',
  items: 'SanMar_Order_Items',
  shipments: 'SanMar_Shipments'
};
const CHUNK = 100; // POs per IN (...) read — the file's established chunk size

// SQL string literal for a Caspio q.where. The single quote is the only
// character that matters inside a T-SQL literal; doubling it is the escape.
function sqlQuote(v) {
  return `'${String(v == null ? '' : v).replace(/'/g, "''")}'`;
}

function inClause(field, values) {
  return `${field} IN (${values.map(sqlQuote).join(',')})`;
}

function norm(v) {
  if (v === null || v === undefined) return '';
  return String(v).trim();
}

function itemKey(po, style, partId) {
  return `${norm(po)}|${norm(style)}|${norm(partId)}`;
}

// Dedupe identity for a carton — a tracking number is only unique WITHIN a PO.
// Mirrors cartonKey() in sanmar-orders.js.
function cartonKey(po, trackingNumber) {
  return `${po}|${norm(trackingNumber).toUpperCase()}`;
}

// Has anything the sync writes on an item row changed? Qty columns are INTEGER
// in Caspio and arrive as strings from SanMar, so compare as numbers.
function itemChanged(existing, incoming) {
  const q = (v) => parseInt(v, 10) || 0;
  return q(existing.Qty_Ordered) !== q(incoming.Qty_Ordered)
    || q(existing.Qty_Shipped) !== q(incoming.Qty_Shipped)
    || norm(existing.Item_Status) !== norm(incoming.Item_Status);
}

// The full SanMar_Shipments row for one carton. One builder for every writer —
// the backfill used to store a subset (no Ship_To_*, no Package_*), which left
// the inbound board unable to tell a drop-ship from a Milton delivery for rows
// it ingested (Ship_To_Zip is what the board matches on).
function buildShipmentRow(po, pkg, shipFrom = {}, shipTo = {}) {
  return {
    SanMar_PO: po,
    Tracking_Number: pkg.trackingNumber,
    Carrier: pkg.carrier || '',
    Ship_Method: pkg.shipmentMethod || '',
    Ship_Date: pkg.shipmentDate ? String(pkg.shipmentDate).split('T')[0] : '',
    Ship_From_Warehouse: shipFrom.city || '',
    Ship_From_City: shipFrom.city || '',
    Ship_From_State: shipFrom.region || '',
    Ship_From_Zip: shipFrom.postalCode || '',
    Ship_From_Address: shipFrom.address1 || '',
    Ship_To_Address: shipTo.address1 || '',
    Ship_To_City: shipTo.city || '',
    Ship_To_State: shipTo.region || '',
    Ship_To_Zip: shipTo.postalCode || '',
    Package_Weight: pkg.weight || '',
    Package_Dimensions: pkg.dimensions || '',
    Package_Class: pkg.packageClass || ''
  };
}

class SanmarBatch {
  constructor() {
    this.orders = new Map();      // SanMar_PO -> stored row (PK_ID, SanMar_PO)
    this.items = new Map();       // itemKey -> stored row (first row wins on duplicates)
    this.shipments = new Set();   // cartonKey
    this._orderPosLoaded = new Set();
    this._shipmentPosLoaded = new Set();
    this.stats = {
      reads: 0,
      ordersPut: 0, ordersPosted: 0,
      itemsPut: 0, itemsPosted: 0, itemsUnchanged: 0,
      shipmentsPosted: 0, shipmentsSkipped: 0
    };
  }

  async _readChunked(table, pos, select) {
    const rows = [];
    for (let i = 0; i < pos.length; i += CHUNK) {
      const chunk = pos.slice(i, i + CHUNK);
      this.stats.reads++;
      const page = await fetchAllCaspioPages(`/tables/${table}/records`, {
        'q.where': inClause('SanMar_PO', chunk),
        'q.select': select,
        // Stable orderBy REQUIRED on any query that can span pages (memory 2026-07-12).
        'q.orderBy': 'PK_ID',
        'q.limit': 1000
      });
      for (const r of (page || [])) rows.push(r);
    }
    return rows;
  }

  // Load the order rows + item rows Caspio holds for these POs (only POs not
  // already loaded into this batch).
  async loadOrders(pos) {
    const fresh = [...new Set(pos.filter(Boolean).map(String))].filter(p => !this._orderPosLoaded.has(p));
    if (!fresh.length) return;
    for (const p of fresh) this._orderPosLoaded.add(p);
    const orderRows = await this._readChunked(TABLES.orders, fresh, 'PK_ID,SanMar_PO');
    for (const r of orderRows) {
      if (r.SanMar_PO && !this.orders.has(r.SanMar_PO)) this.orders.set(r.SanMar_PO, r);
    }
    const itemRows = await this._readChunked(TABLES.items, fresh,
      'PK_ID,SanMar_PO,Style,Part_ID,Qty_Ordered,Qty_Shipped,Item_Status');
    for (const r of itemRows) {
      const k = itemKey(r.SanMar_PO, r.Style, r.Part_ID);
      if (!this.items.has(k)) this.items.set(k, r);
    }
  }

  // Load the (PO, Tracking_Number) pairs Caspio holds for these POs.
  async loadShipments(pos) {
    const fresh = [...new Set(pos.filter(Boolean).map(String))].filter(p => !this._shipmentPosLoaded.has(p));
    if (!fresh.length) return;
    for (const p of fresh) this._shipmentPosLoaded.add(p);
    const rows = await this._readChunked(TABLES.shipments, fresh, 'SanMar_PO,Tracking_Number');
    for (const r of rows) this.shipments.add(cartonKey(r.SanMar_PO, r.Tracking_Number));
  }

  hasOrder(po) { return this.orders.has(String(po)); }

  // PUT when the order row exists, POST when it does not. `insertFields` are
  // merged into a POST only (e.g. Matched_By: 'sync' — a PUT must not overwrite
  // a manual match). Always writes: see the Last_Sync_Date note at the top.
  async upsertOrder(orderData, { insertFields = {} } = {}) {
    const po = String(orderData.SanMar_PO);
    if (!this._orderPosLoaded.has(po)) await this.loadOrders([po]);
    if (this.orders.has(po)) {
      await makeCaspioRequest('PUT', `/tables/${TABLES.orders}/records`,
        { 'q.where': `SanMar_PO=${sqlQuote(po)}` }, orderData);
      this.stats.ordersPut++;
      return 'put';
    }
    await makeCaspioRequest('POST', `/tables/${TABLES.orders}/records`, {}, { ...orderData, ...insertFields });
    this.orders.set(po, { SanMar_PO: po });
    this.stats.ordersPosted++;
    return 'post';
  }

  // PUT only when a tracked field differs, POST when the row does not exist,
  // nothing when it is unchanged.
  async upsertItem(itemData) {
    const po = String(itemData.SanMar_PO);
    if (!this._orderPosLoaded.has(po)) await this.loadOrders([po]);
    const k = itemKey(po, itemData.Style, itemData.Part_ID);
    const existing = this.items.get(k);
    if (existing) {
      if (!itemChanged(existing, itemData)) {
        this.stats.itemsUnchanged++;
        return 'unchanged';
      }
      const where = `SanMar_PO=${sqlQuote(po)} AND Style=${sqlQuote(itemData.Style)} AND Part_ID=${sqlQuote(itemData.Part_ID == null ? '' : itemData.Part_ID)}`;
      await makeCaspioRequest('PUT', `/tables/${TABLES.items}/records`, { 'q.where': where }, itemData);
      this.items.set(k, { ...existing, ...itemData });
      this.stats.itemsPut++;
      return 'put';
    }
    await makeCaspioRequest('POST', `/tables/${TABLES.items}/records`, {}, itemData);
    this.items.set(k, { ...itemData });
    this.stats.itemsPosted++;
    return 'post';
  }

  // POST a carton unless (PO, Tracking_Number) is already held. Returns true
  // when a row was written. Loads the PO's shipments first if not yet loaded.
  async storeCarton(row) {
    const po = String(row.SanMar_PO);
    if (!this._shipmentPosLoaded.has(po)) await this.loadShipments([po]);
    const k = cartonKey(po, row.Tracking_Number);
    if (this.shipments.has(k)) {
      this.stats.shipmentsSkipped++;
      return false;
    }
    await makeCaspioRequest('POST', `/tables/${TABLES.shipments}/records`, {}, row);
    this.shipments.add(k); // guards duplicate cartons within one response too
    this.stats.shipmentsPosted++;
    return true;
  }
}

// Convenience: a batch with orders + items (and, by default, shipments)
// preloaded for these POs.
async function loadSanmarBatch(pos, { shipments = true } = {}) {
  const batch = new SanmarBatch();
  const list = [...new Set((pos || []).filter(Boolean).map(String))];
  if (list.length) {
    await batch.loadOrders(list);
    if (shipments) await batch.loadShipments(list);
  }
  return batch;
}

module.exports = {
  SanmarBatch,
  loadSanmarBatch,
  buildShipmentRow,
  itemChanged,
  itemKey,
  cartonKey,
  sqlQuote,
  inClause,
  TABLES,
  CHUNK
};
