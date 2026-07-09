// Read-only Caspio SCHEMA introspection.
//
// Lets tooling (and Claude) enumerate the account's tables / views / apps / webhooks and
// any table's field definitions WITHOUT a per-session bearer token — it uses the proxy's
// own standing OAuth credential (getCaspioAccessToken). OPEN by design (Erik, 2026-07-09):
// returns schema STRUCTURE only (object + field names/types), never row data, so open
// exposure stays low. Backed by Caspio REST v4 (/v4/schemas/* + /v4/tables/*); the v3
// OAuth token works on v4 (same account OAuth) — verified 2026-07-09.
//
// Mounted OPEN (no gate) at /api in server.js:
//   const caspioSchemaRoutes = require('./src/routes/caspio-schema');
//   app.use('/api', caspioSchemaRoutes);
//
// Routes (all GET):
//   /api/caspio-schema/tables               → [{name, tableId, fieldCount, description}]
//   /api/caspio-schema/tables/:name/fields  → [{name, dataType, editable, unique, isFormula}]
//   /api/caspio-schema/views                → [name]
//   /api/caspio-schema/webhooks             → [{name, status, events:[{object,type,sources}]}]
//   /api/caspio-schema/apps                 → {bridge:[name], flex:[name]}
//   /api/caspio-schema/full                 → whole data dictionary (one call: fields per table)

const express = require('express');
const axios = require('axios');
const router = express.Router();
const { getCaspioAccessToken } = require('../utils/caspio');
const config = require('../config');

// v4 base derived from the configured account domain (v3 base → v4).
const V4_BASE = config.caspio.apiBaseUrl.replace(/\/v3$/, '/v4');

// Authenticated GET against a v4 path → response body. Errors bubble up (never a silent
// fallback — a wrong/empty schema is worse than an error); wrap() surfaces them.
async function v4Get(path) {
  const token = await getCaspioAccessToken();
  const resp = await axios.get(`${V4_BASE}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
    timeout: config.timeouts.perRequest,
  });
  return resp.data;
}

// 15-min in-memory cache — schema rarely changes; keeps this well under the rate limit.
const cache = new Map();
const TTL_MS = 15 * 60 * 1000;
async function cached(key, loader) {
  const hit = cache.get(key);
  if (hit && (Date.now() - hit.at) < TTL_MS) return hit.val;
  const val = await loader();
  cache.set(key, { at: Date.now(), val });
  return val;
}

// Consistent JSON + error surfacing (pass Caspio's HTTP status through when we can).
function wrap(handler) {
  return async (req, res) => {
    try {
      res.json(await handler(req));
    } catch (e) {
      const status = e.response?.status || e.status || 502;
      const detail = e.response?.data ? JSON.stringify(e.response.data).slice(0, 400) : e.message;
      res.status(status >= 400 && status < 600 ? status : 502)
        .json({ success: false, error: `Caspio schema lookup failed: ${detail}` });
    }
  };
}

// All tables (name, id, fieldCount, description).
router.get('/caspio-schema/tables', wrap(async () => {
  const j = await cached('tables', () => v4Get('/tables?pageSize=1000'));
  const rows = j.data || [];
  return {
    success: true,
    count: j.pagination?.totalCount ?? rows.length,
    tables: rows.map(t => ({ name: t.name, tableId: t.tableId, fieldCount: t.fieldCount, description: t.description })),
  };
}));

// A single table's field definitions (resolves name → tableId via the cached list).
router.get('/caspio-schema/tables/:name/fields', wrap(async (req) => {
  const list = await cached('tables', () => v4Get('/tables?pageSize=1000'));
  const t = (list.data || []).find(x => String(x.name).toLowerCase() === String(req.params.name).toLowerCase());
  if (!t) { const e = new Error(`Table not found: ${req.params.name}`); e.status = 404; throw e; }
  const j = await cached(`fields:${t.tableId}`, () => v4Get(`/tables/${t.tableId}/fields`));
  const fields = j.data || j || [];
  return {
    success: true,
    table: t.name,
    tableId: t.tableId,
    fields: fields.map(f => ({ name: f.name, dataType: f.dataType, editable: f.editable, unique: f.unique, isFormula: f.isFormula })),
  };
}));

// All views (names).
router.get('/caspio-schema/views', wrap(async () => {
  const j = await cached('views', () => v4Get('/views?pageSize=1000'));
  const rows = j.data || [];
  return { success: true, count: j.pagination?.totalCount ?? rows.length, views: rows.map(v => v.name) };
}));

// Outgoing webhook configs (the list response carries no secret).
router.get('/caspio-schema/webhooks', wrap(async () => {
  const j = await cached('webhooks', () => v4Get('/schemas/outgoingWebhooks?pageSize=1000'));
  const rows = j.data || [];
  return {
    success: true,
    count: j.pagination?.totalCount ?? rows.length,
    webhooks: rows.map(w => ({
      name: w.name,
      status: w.status,
      events: (w.events || []).map(e => ({ object: e.objectName, type: e.type, sources: e.eventSources })),
    })),
  };
}));

// Bridge + Flex applications (names).
router.get('/caspio-schema/apps', wrap(async () => {
  const [b, f] = await Promise.all([
    cached('bridge', () => v4Get('/bridgeApplications')),
    cached('flex', () => v4Get('/flexApplications')),
  ]);
  return { success: true, bridge: (b.data || []).map(a => a.name), flex: (f.data || []).map(a => a.name) };
}));

// Whole data dictionary in one call (every table + its fields).
router.get('/caspio-schema/full', wrap(async () => {
  const j = await cached('full', () => v4Get('/schemas/tables?pageSize=1000'));
  const rows = j.data || [];
  return {
    success: true,
    count: rows.length,
    tables: rows.map(t => ({
      name: t.name,
      tableId: t.tableId,
      fields: (t.fields || []).map(f => ({ name: f.name, dataType: f.dataType, editable: f.editable })),
    })),
  };
}));

// Live per-table USAGE map (Caspio-internal wiring + current field count) — powers the
// table-audit page's Refresh: catches new/deleted tables, field changes, and view/
// relationship/webhook wiring live. Does NOT include the code-grep signal (repo-side only).
router.get('/caspio-schema/usage', wrap(async () => {
  const [schemas, views, webhooks] = await Promise.all([
    cached('full', () => v4Get('/schemas/tables?pageSize=1000')),
    cached('views-schemas', () => v4Get('/schemas/views?pageSize=1000')),
    cached('webhooks', () => v4Get('/schemas/outgoingWebhooks?pageSize=1000')),
  ]);
  const viewT = new Set();
  (views.data || []).forEach(function (v) { (v.fields || []).forEach(function (f) {
    var tfn = f.tableFieldName || ''; var d = tfn.indexOf('.'); if (d > 0) viewT.add(tfn.slice(0, d));
  }); });
  const relT = new Set();
  (schemas.data || []).forEach(function (t) { (t.relationships || []).forEach(function (r) {
    if (r.parentTable) relT.add(r.parentTable); if (r.childTable) relT.add(r.childTable);
  }); });
  const whT = new Set();
  (webhooks.data || []).forEach(function (w) { (w.events || []).forEach(function (e) { if (e.objectName) whT.add(e.objectName); }); });
  return {
    success: true,
    generatedAt: new Date().toISOString(),
    count: (schemas.data || []).length,
    tables: (schemas.data || []).map(function (t) {
      return { name: t.name, fieldCount: t.fieldCount, view: viewT.has(t.name), rel: relT.has(t.name), webhook: whT.has(t.name) };
    }),
  };
}));

module.exports = router;
