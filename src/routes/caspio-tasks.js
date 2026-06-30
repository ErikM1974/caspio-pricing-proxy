// caspio-tasks.js — On-demand triggers for Caspio scheduled Data Import/Export Tasks (#5).
//
// Caspio runs 6 import/export tasks on a daily/weekly schedule. This lets staff
// FORCE a fresh run on demand (e.g. right after a known ShopWorks/SanMar change)
// instead of waiting for the nightly window — via the Caspio platform REST v3
// management API: POST /v3/dataImportExportTasks/{externalKey}/run + GET status.
//
// Design:
//   - PAIRS WITH, does not replace, the bespoke Node syncs (sync-design-lookup.js
//     etc.). This is a manual "run it now" button, not an automated cron.
//   - Name allowlist (the 6 real tasks) — the externalKey is resolved from the live
//     task list at call time, so keys aren't hardcoded (they can rotate in Caspio).
//   - Fire-then-poll: /run returns as soon as Caspio accepts the request; callers
//     poll GET /:name for completion (Heroku's 30s router timeout makes blocking
//     on a long import unsafe).
//   - Whole mount is gated by requireCrmApiSecret in server.js (privileged staff
//     action — triggering an import is not public).
//   - Visible failures only (Erik's #1 rule): a Caspio error surfaces as an error
//     response, never a faked success.

const express = require('express');
const axios = require('axios');
const router = express.Router();

// NOTE: use src/config (v3 base `/integrations/rest/v3`), NOT proxy-root config.js
// (which is `/rest/v2`). The dataImportExportTasks management API only exists on v3.
const config = require('../config');
const { getCaspioAccessToken } = require('../utils/caspio');

const TASKS_BASE = `${config.caspio.apiBaseUrl}/dataImportExportTasks`;
const REQ_TIMEOUT = 20000;

// Allowlist — only these named tasks may be listed/triggered (defense-in-depth;
// blocks running an arbitrary/unknown task key even with the secret). Verified live
// 2026-06-29 (entitlement probe). Match is case-insensitive on Name.
const KNOWN_TASKS = [
  'CustomerContactsMerge',
  'Designs2026',
  'Orders_ODBC',
  'PurchaseOrders',
  'Sales Reps 2026-Daily',
  'Thumbnail_Import',
];
const isAllowed = (name) =>
  KNOWN_TASKS.some((t) => t.toLowerCase() === String(name || '').trim().toLowerCase());

async function authHeaders() {
  const token = await getCaspioAccessToken();
  return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
}

// Fetch the live task list from Caspio (Result[] of ScheduledTaskInfo).
async function fetchTasks() {
  const resp = await axios.get(TASKS_BASE, { headers: await authHeaders(), timeout: REQ_TIMEOUT });
  const list = (resp.data && (resp.data.Result || resp.data.result)) || [];
  return list.map((t) => ({
    name: t.Name,
    externalKey: t.ExternalKey,
    status: t.Status,
    frequency: t.Frequency,
    timeZone: t.TaskTimeZone,
    note: t.Note,
  }));
}

// Resolve an allowlisted name → its live task object (incl. externalKey).
async function resolveTask(name) {
  if (!isAllowed(name)) {
    const err = new Error(`Unknown or non-allowlisted task: ${name}`);
    err.statusCode = 404;
    throw err;
  }
  const tasks = await fetchTasks();
  const found = tasks.find((t) => (t.name || '').toLowerCase() === String(name).trim().toLowerCase());
  if (!found) {
    const err = new Error(`Task "${name}" not found in Caspio`);
    err.statusCode = 404;
    throw err;
  }
  return found;
}

// GET /api/caspio-tasks — list the known tasks + current status.
router.get('/', async (req, res) => {
  try {
    const tasks = (await fetchTasks()).filter((t) => isAllowed(t.name));
    res.json({ success: true, count: tasks.length, tasks });
  } catch (e) {
    console.error('[caspio-tasks] list failed:', e.response ? JSON.stringify(e.response.data) : e.message);
    res.status(502).json({ success: false, error: 'Failed to list Caspio tasks', detail: e.message });
  }
});

// GET /api/caspio-tasks/:name — current status of one task.
router.get('/:name', async (req, res) => {
  try {
    const task = await resolveTask(req.params.name);
    res.json({ success: true, task });
  } catch (e) {
    const code = e.statusCode || 502;
    console.error('[caspio-tasks] status failed:', e.message);
    res.status(code).json({ success: false, error: e.message });
  }
});

// POST /api/caspio-tasks/:name/run — trigger a fresh run NOW (fire-then-poll).
router.post('/:name/run', async (req, res) => {
  let task;
  try {
    task = await resolveTask(req.params.name);
  } catch (e) {
    const code = e.statusCode || 502;
    return res.status(code).json({ success: false, error: e.message });
  }
  try {
    await axios.post(`${TASKS_BASE}/${encodeURIComponent(task.externalKey)}/run`, null, {
      headers: await authHeaders(),
      timeout: REQ_TIMEOUT,
    });
    // Re-read status so the caller sees it moved to Running/Queued (best-effort).
    let after = task;
    try { after = await resolveTask(req.params.name); } catch (_) { /* keep pre-run status */ }
    res.json({ success: true, message: `Triggered "${task.name}" — poll GET /api/caspio-tasks/${encodeURIComponent(task.name)} for completion`, task: after });
  } catch (e) {
    console.error('[caspio-tasks] run failed:', e.response ? JSON.stringify(e.response.data) : e.message);
    const upstream = e.response && e.response.status;
    res.status(upstream && upstream >= 400 && upstream < 500 ? upstream : 502)
      .json({ success: false, error: `Failed to trigger "${task.name}"`, detail: e.response ? e.response.data : e.message });
  }
});

module.exports = router;
