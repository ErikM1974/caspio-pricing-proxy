// Supacolor Jobs Routes — local mirror of Supacolor's job dashboard
//
// Three tables:
//   Supacolor_Jobs          — one row per Supacolor job (top-level metadata)
//   Supacolor_Joblines      — child: line items per job (transfers, shipping, fees)
//   Supacolor_Job_History   — child: history events per job (created/paid/dispatched)
//
// Mirrors pattern from transfer-orders.js. PK is autonumber ID_Job;
// business key is Supacolor_Job_Number (unique). Joblines + History link via ID_Job (Integer FK).
//
// Endpoints:
//   GET    /api/supacolor-jobs                    — List with filters + pagination
//   GET    /api/supacolor-jobs/stats              — Count per status (dashboard chips)
//   GET    /api/supacolor-jobs/:id                — Get one job + joblines + history
//   POST   /api/supacolor-jobs                    — Create new
//   POST   /api/supacolor-jobs/upsert             — Upsert by Supacolor_Job_Number (idempotent)
//   GET    /api/supacolor-jobs/by-number/:jobNumber — Lookup by business key (no joblines/history)
//   POST   /api/supacolor-jobs/bulk-upsert        — Batch upsert (jobs-list backfill)
//   PUT    /api/supacolor-jobs/:id                — Update fields
//   DELETE /api/supacolor-jobs/:id                — Delete job + cascade joblines + history
//   GET    /api/supacolor-jobs/:id/joblines       — List joblines for a job
//   POST   /api/supacolor-jobs/:id/joblines       — Replace all joblines (delete + insert)
//   GET    /api/supacolor-jobs/:id/history        — List history events
//   POST   /api/supacolor-jobs/:id/history        — Append a single history event
//   POST   /api/supacolor-jobs/:id/history/replace — Replace all history events
//   POST   /api/supacolor-jobs/sync/all           — Pull all jobs from Supacolor API + upsert into Caspio
//   POST   /api/supacolor-jobs/sync/:jobNumber    — Refresh one job (detail + history) from API
//   GET    /api/supacolor-jobs/proxy-image        — Proxy a Supacolor CDN image with Content-Disposition: attachment
//                                                   so browsers trigger a true 1-click download. Whitelisted to
//                                                   *.supacolor.com to prevent SSRF.

const express = require('express');
const router = express.Router();
const axios = require('axios');
const { getCaspioAccessToken, fetchAllCaspioPages } = require('../utils/caspio');
const supacolorApi = require('../utils/supacolor-api');
const { mirrorShippedToTransfer } = require('../utils/transfer-status-mirror');
const config = require('../../config');

const caspioApiBaseUrl = config.caspio.apiBaseUrl;
const TABLE_JOBS = 'Supacolor_Jobs';
const TABLE_LINES = 'Supacolor_Joblines';
const TABLE_HISTORY = 'Supacolor_Job_History';

const VALID_STATUSES = ['Open', 'Closed', 'Cancelled'];

// Read-only fields — Caspio rejects writes (Autonumber + auto-Timestamp)
const READ_ONLY_JOB_FIELDS = ['PK_ID', 'ID_Job', 'Last_Updated_At'];
const READ_ONLY_LINE_FIELDS = ['PK_ID', 'ID_Jobline'];
const READ_ONLY_HISTORY_FIELDS = ['PK_ID', 'ID_History'];

// ── Helpers ──────────────────────────────────────────────────────────

function escapeSQL(val) {
    return String(val).replace(/'/g, "''");
}

function stripFields(obj, fields) {
    const out = { ...obj };
    fields.forEach(f => delete out[f]);
    return out;
}

/**
 * Business rule: a job with a tracking number or ship date is shipped → Closed.
 * Applied to inserts and upserts so paste-backfills of shipped jobs land as Closed,
 * not Open. Preserves explicit "Cancelled" so manually-cancelled jobs don't flip.
 */
function hasShippedSignal(data) {
    const t = data && data.Tracking_Number;
    const d = data && data.Date_Shipped;
    const hasTracking = t != null && String(t).trim() !== '';
    const hasDateShipped = d != null && String(d).trim() !== '';
    return hasTracking || hasDateShipped;
}

/**
 * Fetch a single Supacolor_Jobs record by ID_Job (numeric PK).
 */
async function fetchJobById(token, idJob) {
    const url = `${caspioApiBaseUrl}/tables/${TABLE_JOBS}/records?q.where=ID_Job=${parseInt(idJob, 10)}`;
    const resp = await axios.get(url, {
        headers: { 'Authorization': `Bearer ${token}` },
        timeout: 15000
    });
    return (resp.data.Result || [])[0] || null;
}

/**
 * Fetch a single Supacolor_Jobs record by Supacolor_Job_Number (business key).
 */
async function fetchJobByNumber(token, jobNumber) {
    const url = `${caspioApiBaseUrl}/tables/${TABLE_JOBS}/records?q.where=Supacolor_Job_Number='${escapeSQL(jobNumber)}'`;
    const resp = await axios.get(url, {
        headers: { 'Authorization': `Bearer ${token}` },
        timeout: 15000
    });
    return (resp.data.Result || [])[0] || null;
}

async function fetchJoblines(token, idJob) {
    const url = `${caspioApiBaseUrl}/tables/${TABLE_LINES}/records?q.where=ID_Job=${parseInt(idJob, 10)}&q.orderBy=Line_Order ASC`;
    const resp = await axios.get(url, {
        headers: { 'Authorization': `Bearer ${token}` },
        timeout: 15000
    });
    return resp.data.Result || [];
}

async function fetchHistory(token, idJob) {
    const url = `${caspioApiBaseUrl}/tables/${TABLE_HISTORY}/records?q.where=ID_Job=${parseInt(idJob, 10)}&q.orderBy=Event_At ASC`;
    const resp = await axios.get(url, {
        headers: { 'Authorization': `Bearer ${token}` },
        timeout: 15000
    });
    return resp.data.Result || [];
}

async function deleteJoblines(token, idJob) {
    const url = `${caspioApiBaseUrl}/tables/${TABLE_LINES}/records?q.where=ID_Job=${parseInt(idJob, 10)}`;
    await axios.delete(url, {
        headers: { 'Authorization': `Bearer ${token}` },
        timeout: 15000
    });
}

async function deleteHistory(token, idJob) {
    const url = `${caspioApiBaseUrl}/tables/${TABLE_HISTORY}/records?q.where=ID_Job=${parseInt(idJob, 10)}`;
    await axios.delete(url, {
        headers: { 'Authorization': `Bearer ${token}` },
        timeout: 15000
    });
}

/**
 * Small helper: sleep for N milliseconds.
 */
function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Detect Caspio's rate-limit error payload.
 * Caspio returns 400 status + body like: [{message: "You have exceeded your API call rate limits.", name: "api-calls-rate"}]
 */
function isCaspioRateLimitError(err) {
    if (!err || !err.response) return false;
    const data = err.response.data;
    if (!data) return false;
    const asString = typeof data === 'string' ? data : JSON.stringify(data);
    return asString.indexOf('api-calls-rate') !== -1 || asString.indexOf('rate limit') !== -1;
}

/**
 * Run a Caspio write with automatic retry on rate-limit errors.
 * Exponential backoff: 1s, 2s, 4s. Max 3 retries.
 */
async function writeWithRateLimitRetry(writeFn, { maxRetries = 3, label = 'write' } = {}) {
    let attempt = 0;
    while (true) {
        try {
            return await writeFn();
        } catch (err) {
            if (!isCaspioRateLimitError(err) || attempt >= maxRetries) throw err;
            const waitMs = 1000 * Math.pow(2, attempt);
            console.warn(`[Caspio rate-limit] ${label} hit rate limit — sleeping ${waitMs}ms and retrying (attempt ${attempt + 1}/${maxRetries})`);
            await sleep(waitMs);
            attempt++;
        }
    }
}

/**
 * Insert a job record. Returns the freshly-created record (with assigned ID_Job).
 */
async function insertJob(token, data) {
    const clean = stripFields(data, READ_ONLY_JOB_FIELDS);
    // Status is a free-form string — Supacolor uses Open, Closed, Cancelled,
    // Ganged, and possibly others (In Production, Ready to Ship, etc.)
    // Caspio's column is Text so any string is fine.
    // Shipped jobs auto-close: tracking number or ship date means Closed.
    if (hasShippedSignal(clean) && clean.Status !== 'Cancelled') {
        clean.Status = 'Closed';
    }
    const url = `${caspioApiBaseUrl}/tables/${TABLE_JOBS}/records?response=rows`;
    const resp = await axios.post(url, clean, {
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
        timeout: 15000
    });
    // Caspio with ?response=rows returns inserted record(s) in resp.data.Result
    const created = (resp.data && resp.data.Result && resp.data.Result[0]) || null;
    if (created) return created;
    // Fallback: re-fetch by Supacolor_Job_Number
    if (clean.Supacolor_Job_Number) {
        return await fetchJobByNumber(token, clean.Supacolor_Job_Number);
    }
    return null;
}

/**
 * Update a job record by ID_Job.
 */
async function updateJob(token, idJob, data) {
    const clean = stripFields(data, READ_ONLY_JOB_FIELDS);
    // Status is a free-form string (see insertJob comment).
    if (Object.keys(clean).length === 0) return null;
    const url = `${caspioApiBaseUrl}/tables/${TABLE_JOBS}/records?q.where=ID_Job=${parseInt(idJob, 10)}`;
    await axios.put(url, clean, {
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
        timeout: 15000
    });
    return await fetchJobById(token, idJob);
}

// ── Job CRUD ──────────────────────────────────────────────────────────

/**
 * GET /api/supacolor-jobs
 *
 * Query params:
 *   status (CSV)   — Open, Closed, Cancelled
 *   search         — fuzzy match on Supacolor_Job_Number / PO_Number / Description
 *   dateFrom/To    — Date_Shipped range (ISO date)
 *   activeOnly=true — exclude Closed/Cancelled
 *   pageNumber, pageSize, orderBy
 */
router.get('/supacolor-jobs', async (req, res) => {
    try {
        const resource = `/tables/${TABLE_JOBS}/records`;
        const params = {};
        const where = [];

        if (req.query.status) {
            const statuses = req.query.status.split(',').map(s => `Status='${escapeSQL(s.trim())}'`);
            where.push(statuses.length === 1 ? statuses[0] : `(${statuses.join(' OR ')})`);
        }

        if (req.query.activeOnly === 'true') {
            where.push(`Status='Open'`);
        }

        if (req.query.search) {
            const s = escapeSQL(req.query.search);
            where.push(`(Supacolor_Job_Number LIKE '%${s}%' OR PO_Number LIKE '%${s}%' OR Description LIKE '%${s}%')`);
        }

        if (req.query.dateFrom) where.push(`Date_Shipped>='${escapeSQL(req.query.dateFrom)}'`);
        if (req.query.dateTo)   where.push(`Date_Shipped<='${escapeSQL(req.query.dateTo)}'`);

        if (where.length) params['q.where'] = where.join(' AND ');
        params['q.orderBy'] = req.query.orderBy || 'Date_Shipped DESC';
        if (req.query.pageNumber) params['q.pageNumber'] = parseInt(req.query.pageNumber, 10);
        params['q.pageSize'] = parseInt(req.query.pageSize, 10) || parseInt(req.query.limit, 10) || 200;

        const records = await fetchAllCaspioPages(resource, params);

        res.json({ success: true, count: records.length, records });
    } catch (error) {
        console.error('Error fetching supacolor jobs:', error.response ? JSON.stringify(error.response.data) : error.message);
        res.status(500).json({ success: false, error: 'Failed to fetch jobs: ' + error.message });
    }
});

/**
 * GET /api/supacolor-jobs/stats
 * Count per status. Used by dashboard chips.
 */
router.get('/supacolor-jobs/stats', async (req, res) => {
    try {
        const resource = `/tables/${TABLE_JOBS}/records`;
        const records = await fetchAllCaspioPages(resource, {
            'q.select': 'Status',
            'q.pageSize': 1000
        });
        // Active = anything that isn't Closed or Cancelled (covers Open, Ganged,
        // In Production, Ready to Ship, and any other status Supacolor uses).
        const stats = { Active: 0, Closed: 0, Cancelled: 0 };
        records.forEach(r => {
            if (r.Status === 'Closed') stats.Closed++;
            else if (r.Status === 'Cancelled') stats.Cancelled++;
            else stats.Active++;
        });
        res.json({ success: true, stats, total: records.length });
    } catch (error) {
        console.error('Error fetching supacolor stats:', error.response ? JSON.stringify(error.response.data) : error.message);
        res.status(500).json({ success: false, error: 'Failed to fetch stats: ' + error.message });
    }
});

/**
 * GET /api/supacolor-jobs/by-number/:jobNumber
 * Returns the Supacolor_Jobs row matching Supacolor_Job_Number (business key).
 * Used by transfer-detail.html to resolve a job# → full record for the
 * "Live Supacolor Status" card without running a deep API sync.
 *
 * NOTE: the :jobNumber wildcard MUST be registered before /:id to avoid
 * being swallowed by Express (/:id matches anything).
 */
router.get('/supacolor-jobs/by-number/:jobNumber', async (req, res) => {
    try {
        const { jobNumber } = req.params;
        if (!jobNumber) return res.status(400).json({ success: false, error: 'Missing jobNumber' });

        const token = await getCaspioAccessToken();
        const job = await fetchJobByNumber(token, jobNumber);
        if (!job) return res.status(404).json({ success: false, error: 'Job not found for number: ' + jobNumber });

        // For the live-status card on transfer-detail we only need the job row itself
        // (status + shipping fields). Joblines/history are skipped — the supacolor detail
        // page is the place to show those.
        res.json({ success: true, job });
    } catch (error) {
        console.error('Error fetching supacolor job by number:', error.response ? JSON.stringify(error.response.data) : error.message);
        res.status(500).json({ success: false, error: 'Failed to fetch job: ' + error.message });
    }
});

/**
 * GET /api/supacolor-jobs/:id
 * Returns the job + all joblines + all history events.
 * :id is numeric ID_Job.
 */
router.get('/supacolor-jobs/:id', async (req, res) => {
    try {
        const idJob = parseInt(req.params.id, 10);
        if (isNaN(idJob)) return res.status(400).json({ success: false, error: 'ID must be numeric ID_Job' });

        const token = await getCaspioAccessToken();
        const job = await fetchJobById(token, idJob);
        if (!job) return res.status(404).json({ success: false, error: 'Job not found' });

        const [joblines, history] = await Promise.all([
            fetchJoblines(token, idJob),
            fetchHistory(token, idJob)
        ]);

        res.json({ success: true, job, joblines, history });
    } catch (error) {
        console.error('Error fetching supacolor job:', error.response ? JSON.stringify(error.response.data) : error.message);
        res.status(500).json({ success: false, error: 'Failed to fetch job: ' + error.message });
    }
});

/**
 * POST /api/supacolor-jobs
 * Create a new job. Returns the inserted record (incl. auto-assigned ID_Job).
 */
router.post('/supacolor-jobs', async (req, res) => {
    try {
        const token = await getCaspioAccessToken();
        const created = await insertJob(token, req.body || {});
        console.log(`Supacolor job created: #${created && created.Supacolor_Job_Number} (ID_Job=${created && created.ID_Job})`);
        res.status(201).json({ success: true, job: created });
    } catch (error) {
        console.error('Error creating supacolor job:', error.response ? JSON.stringify(error.response.data) : error.message);
        res.status(500).json({ success: false, error: 'Failed to create job: ' + error.message });
    }
});

/**
 * POST /api/supacolor-jobs/upsert
 *
 * Idempotent upsert by Supacolor_Job_Number.
 *  - If a row exists with that job number: PATCH only fields not already filled
 *    (so we never overwrite manually-corrected data with a re-paste).
 *  - If no row exists: INSERT.
 *
 * Body: any Supacolor_Jobs fields. Required: Supacolor_Job_Number.
 * Optional `force=true` query param overwrites existing fields.
 */
router.post('/supacolor-jobs/upsert', async (req, res) => {
    try {
        const data = req.body || {};
        if (!data.Supacolor_Job_Number) {
            return res.status(400).json({ success: false, error: 'Missing Supacolor_Job_Number' });
        }
        const force = req.query.force === 'true';

        const token = await getCaspioAccessToken();
        const existing = await fetchJobByNumber(token, data.Supacolor_Job_Number);

        if (!existing) {
            const created = await insertJob(token, data);
            // D.2 — mirror shipped signal onto any linked Transfer_Orders
            try { await mirrorShippedToTransfer(token, created || data); } catch (e) { console.warn('[upsert] mirror:', e.message); }
            return res.status(201).json({ success: true, job: created, action: 'inserted' });
        }

        // Patch: by default, only fill fields that are currently null/empty
        const patch = {};
        Object.keys(data).forEach(k => {
            if (READ_ONLY_JOB_FIELDS.includes(k)) return;
            if (k === 'Supacolor_Job_Number') return; // never overwrite the key
            const newVal = data[k];
            const oldVal = existing[k];
            if (force) {
                patch[k] = newVal;
            } else if (newVal != null && newVal !== '' && (oldVal == null || oldVal === '')) {
                patch[k] = newVal;
            }
        });

        // Auto-close override: if incoming has tracking/ship-date, force Status='Closed'
        // even when a stale Status already exists. Never flips a Cancelled job.
        if (hasShippedSignal(data) && existing.Status !== 'Cancelled' && existing.Status !== 'Closed') {
            patch.Status = 'Closed';
        }

        if (Object.keys(patch).length === 0) {
            // Even on noop, run the mirror — existing state may already be shipped
            // but a prior mirror attempt could have failed silently.
            try { await mirrorShippedToTransfer(token, existing); } catch (e) { console.warn('[upsert noop] mirror:', e.message); }
            return res.json({ success: true, job: existing, action: 'noop' });
        }

        const updated = await updateJob(token, existing.ID_Job, patch);
        // D.2 — merge existing + patch so the mirror sees the final shape
        try {
            const merged = Object.assign({}, existing, patch);
            await mirrorShippedToTransfer(token, merged);
        } catch (e) {
            console.warn('[upsert patched] mirror:', e.message);
        }
        res.json({ success: true, job: updated, action: 'patched', updatedFields: Object.keys(patch) });
    } catch (error) {
        console.error('Error upserting supacolor job:', error.response ? JSON.stringify(error.response.data) : error.message);
        res.status(500).json({ success: false, error: 'Failed to upsert job: ' + error.message });
    }
});

/**
 * POST /api/supacolor-jobs/bulk-upsert
 *
 * Batch idempotent upsert. Used by jobs-list screenshot backfill.
 * Body: { jobs: [ { Supacolor_Job_Number, PO_Number, Description, Status, Date_Shipped, ... }, ... ] }
 *
 * Returns per-job result so the UI can show "X created, Y skipped, Z patched".
 */
router.post('/supacolor-jobs/bulk-upsert', async (req, res) => {
    try {
        const jobs = (req.body && req.body.jobs) || [];
        if (!Array.isArray(jobs) || jobs.length === 0) {
            return res.status(400).json({ success: false, error: 'Body must be { jobs: [...] }' });
        }
        const force = req.query.force === 'true';
        const token = await getCaspioAccessToken();

        const results = [];
        let inserted = 0, patched = 0, noop = 0, errored = 0;

        for (const data of jobs) {
            if (!data.Supacolor_Job_Number) {
                results.push({ error: 'missing Supacolor_Job_Number', input: data });
                errored++;
                continue;
            }
            try {
                const existing = await fetchJobByNumber(token, data.Supacolor_Job_Number);
                if (!existing) {
                    const created = await insertJob(token, data);
                    results.push({ jobNumber: data.Supacolor_Job_Number, action: 'inserted', ID_Job: created && created.ID_Job });
                    inserted++;
                } else {
                    const patch = {};
                    Object.keys(data).forEach(k => {
                        if (READ_ONLY_JOB_FIELDS.includes(k)) return;
                        if (k === 'Supacolor_Job_Number') return;
                        const newVal = data[k];
                        const oldVal = existing[k];
                        if (force) patch[k] = newVal;
                        else if (newVal != null && newVal !== '' && (oldVal == null || oldVal === '')) patch[k] = newVal;
                    });
                    // Auto-close override: shipped-signal (tracking or ship date) forces Closed,
                    // even when the pasted Status is stale/Open. Never flips a Cancelled job.
                    if (hasShippedSignal(data) && existing.Status !== 'Cancelled' && existing.Status !== 'Closed') {
                        patch.Status = 'Closed';
                    }
                    if (Object.keys(patch).length === 0) {
                        results.push({ jobNumber: data.Supacolor_Job_Number, action: 'noop', ID_Job: existing.ID_Job });
                        noop++;
                    } else {
                        await updateJob(token, existing.ID_Job, patch);
                        results.push({ jobNumber: data.Supacolor_Job_Number, action: 'patched', ID_Job: existing.ID_Job, updatedFields: Object.keys(patch) });
                        patched++;
                    }
                }
            } catch (jobErr) {
                results.push({ jobNumber: data.Supacolor_Job_Number, error: jobErr.message });
                errored++;
            }
        }

        console.log(`Supacolor bulk-upsert: ${inserted} inserted, ${patched} patched, ${noop} noop, ${errored} errored`);
        res.json({ success: true, summary: { inserted, patched, noop, errored, total: jobs.length }, results });
    } catch (error) {
        console.error('Error bulk-upserting supacolor jobs:', error.response ? JSON.stringify(error.response.data) : error.message);
        res.status(500).json({ success: false, error: 'Failed to bulk upsert: ' + error.message });
    }
});

/**
 * PUT /api/supacolor-jobs/:id
 * Update fields on an existing job by ID_Job.
 */
router.put('/supacolor-jobs/:id', async (req, res) => {
    try {
        const idJob = parseInt(req.params.id, 10);
        if (isNaN(idJob)) return res.status(400).json({ success: false, error: 'ID must be numeric ID_Job' });

        const token = await getCaspioAccessToken();
        const existing = await fetchJobById(token, idJob);
        if (!existing) return res.status(404).json({ success: false, error: 'Job not found' });

        const updated = await updateJob(token, idJob, req.body || {});
        if (updated === null) return res.status(400).json({ success: false, error: 'No updatable fields provided' });

        res.json({ success: true, job: updated });
    } catch (error) {
        console.error('Error updating supacolor job:', error.response ? JSON.stringify(error.response.data) : error.message);
        res.status(500).json({ success: false, error: 'Failed to update job: ' + error.message });
    }
});

/**
 * DELETE /api/supacolor-jobs/:id
 * Hard delete the job + cascade joblines + history.
 */
router.delete('/supacolor-jobs/:id', async (req, res) => {
    try {
        const idJob = parseInt(req.params.id, 10);
        if (isNaN(idJob)) return res.status(400).json({ success: false, error: 'ID must be numeric ID_Job' });

        const token = await getCaspioAccessToken();
        const existing = await fetchJobById(token, idJob);
        if (!existing) return res.status(404).json({ success: false, error: 'Job not found' });

        // Cascade delete children first (Caspio doesn't enforce FK, we do it ourselves)
        try { await deleteJoblines(token, idJob); } catch (e) { console.warn(`Joblines delete warning (job ${idJob}):`, e.message); }
        try { await deleteHistory(token, idJob); }  catch (e) { console.warn(`History delete warning (job ${idJob}):`, e.message); }

        await axios.delete(`${caspioApiBaseUrl}/tables/${TABLE_JOBS}/records?q.where=ID_Job=${idJob}`, {
            headers: { 'Authorization': `Bearer ${token}` },
            timeout: 15000
        });

        console.log(`Supacolor job ${idJob} (#${existing.Supacolor_Job_Number}) deleted with cascade`);
        res.json({ success: true, message: 'Job deleted' });
    } catch (error) {
        console.error('Error deleting supacolor job:', error.response ? JSON.stringify(error.response.data) : error.message);
        res.status(500).json({ success: false, error: 'Failed to delete job: ' + error.message });
    }
});

// ── Joblines ─────────────────────────────────────────────────────────

/**
 * GET /api/supacolor-jobs/:id/joblines
 */
router.get('/supacolor-jobs/:id/joblines', async (req, res) => {
    try {
        const idJob = parseInt(req.params.id, 10);
        if (isNaN(idJob)) return res.status(400).json({ success: false, error: 'ID must be numeric ID_Job' });
        const token = await getCaspioAccessToken();
        const joblines = await fetchJoblines(token, idJob);
        res.json({ success: true, count: joblines.length, joblines });
    } catch (error) {
        console.error('Error fetching joblines:', error.response ? JSON.stringify(error.response.data) : error.message);
        res.status(500).json({ success: false, error: 'Failed to fetch joblines: ' + error.message });
    }
});

/**
 * POST /api/supacolor-jobs/:id/joblines
 *
 * Replaces all joblines for a job (delete-then-insert). Used by detail-screenshot import.
 * Body: { joblines: [ { Line_Order, Line_Type, Item_Code, Description, Detail_Line, Color, Quantity, Unit_Price, Line_Total, Thumbnail_URL }, ... ] }
 */
router.post('/supacolor-jobs/:id/joblines', async (req, res) => {
    try {
        const idJob = parseInt(req.params.id, 10);
        if (isNaN(idJob)) return res.status(400).json({ success: false, error: 'ID must be numeric ID_Job' });
        const lines = (req.body && req.body.joblines) || [];
        if (!Array.isArray(lines)) return res.status(400).json({ success: false, error: 'Body must be { joblines: [...] }' });

        const token = await getCaspioAccessToken();
        const existing = await fetchJobById(token, idJob);
        if (!existing) return res.status(404).json({ success: false, error: 'Job not found' });

        // Delete existing joblines
        try { await deleteJoblines(token, idJob); } catch (e) { console.warn(`Joblines delete (job ${idJob}):`, e.message); }

        // Insert new ones
        let inserted = 0;
        for (let i = 0; i < lines.length; i++) {
            const line = stripFields(lines[i], READ_ONLY_LINE_FIELDS);
            line.ID_Job = idJob;
            if (line.Line_Order == null) line.Line_Order = i + 1;
            const url = `${caspioApiBaseUrl}/tables/${TABLE_LINES}/records`;
            await axios.post(url, line, {
                headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
                timeout: 15000
            });
            inserted++;
        }

        console.log(`Supacolor job ${idJob} joblines replaced: ${inserted} lines`);
        res.json({ success: true, inserted });
    } catch (error) {
        console.error('Error replacing joblines:', error.response ? JSON.stringify(error.response.data) : error.message);
        res.status(500).json({ success: false, error: 'Failed to replace joblines: ' + error.message });
    }
});

// ── History ──────────────────────────────────────────────────────────

/**
 * GET /api/supacolor-jobs/:id/history
 */
router.get('/supacolor-jobs/:id/history', async (req, res) => {
    try {
        const idJob = parseInt(req.params.id, 10);
        if (isNaN(idJob)) return res.status(400).json({ success: false, error: 'ID must be numeric ID_Job' });
        const token = await getCaspioAccessToken();
        const history = await fetchHistory(token, idJob);
        res.json({ success: true, count: history.length, history });
    } catch (error) {
        console.error('Error fetching history:', error.response ? JSON.stringify(error.response.data) : error.message);
        res.status(500).json({ success: false, error: 'Failed to fetch history: ' + error.message });
    }
});

/**
 * POST /api/supacolor-jobs/:id/history
 * Append a single history event.
 * Body: { Event_Type, Event_Detail, Event_At }
 */
router.post('/supacolor-jobs/:id/history', async (req, res) => {
    try {
        const idJob = parseInt(req.params.id, 10);
        if (isNaN(idJob)) return res.status(400).json({ success: false, error: 'ID must be numeric ID_Job' });

        const event = stripFields(req.body || {}, READ_ONLY_HISTORY_FIELDS);
        event.ID_Job = idJob;
        if (!event.Event_Type) return res.status(400).json({ success: false, error: 'Missing Event_Type' });

        const token = await getCaspioAccessToken();
        const url = `${caspioApiBaseUrl}/tables/${TABLE_HISTORY}/records`;
        await axios.post(url, event, {
            headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
            timeout: 15000
        });

        res.status(201).json({ success: true });
    } catch (error) {
        console.error('Error appending history:', error.response ? JSON.stringify(error.response.data) : error.message);
        res.status(500).json({ success: false, error: 'Failed to append history: ' + error.message });
    }
});

/**
 * POST /api/supacolor-jobs/:id/history/replace
 * Replaces all history events for a job (delete + insert). Used by detail-screenshot import.
 * Body: { history: [ { Event_Type, Event_Detail, Event_At }, ... ] }
 */
router.post('/supacolor-jobs/:id/history/replace', async (req, res) => {
    try {
        const idJob = parseInt(req.params.id, 10);
        if (isNaN(idJob)) return res.status(400).json({ success: false, error: 'ID must be numeric ID_Job' });
        const events = (req.body && req.body.history) || [];
        if (!Array.isArray(events)) return res.status(400).json({ success: false, error: 'Body must be { history: [...] }' });

        const token = await getCaspioAccessToken();
        const existing = await fetchJobById(token, idJob);
        if (!existing) return res.status(404).json({ success: false, error: 'Job not found' });

        try { await deleteHistory(token, idJob); } catch (e) { console.warn(`History delete (job ${idJob}):`, e.message); }

        let inserted = 0;
        for (const ev of events) {
            const event = stripFields(ev, READ_ONLY_HISTORY_FIELDS);
            event.ID_Job = idJob;
            if (!event.Event_Type) continue;
            const url = `${caspioApiBaseUrl}/tables/${TABLE_HISTORY}/records`;
            await axios.post(url, event, {
                headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
                timeout: 15000
            });
            inserted++;
        }

        console.log(`Supacolor job ${idJob} history replaced: ${inserted} events`);
        res.json({ success: true, inserted });
    } catch (error) {
        console.error('Error replacing history:', error.response ? JSON.stringify(error.response.data) : error.message);
        res.status(500).json({ success: false, error: 'Failed to replace history: ' + error.message });
    }
});

// ── API Sync (Supacolor Codewolf Control API → Caspio) ──────────────
//
// Hybrid model: we pull from api.supacolor.com and upsert into our 3 Caspio
// tables. The dashboard keeps reading from Caspio (no live passthrough), which
// preserves cross-referencing with Transfer_Orders + paste-OCR fallback.
//
// Two endpoints:
//   POST /sync/all                  — walk /Jobs/active?includeClosedJobs=true,
//                                     upsert each + replace joblines + replace history
//   POST /sync/:jobNumber           — refresh a single job end-to-end
//
// Marks upserts with Backfill_Source='api' to distinguish from screenshot/live/manual.

/**
 * Supacolor statuses collapse into our 3-bucket Caspio schema.
 * Anything that isn't Dispatched/Closed/Cancelled → Open (covers New, Waiting,
 * In Progress, Ready, Delayed, Issue, Return, plus any future statuses).
 */
function mapApiStatusToBucket(apiStatus) {
    if (!apiStatus) return 'Open';
    const s = String(apiStatus).toLowerCase();
    if (s === 'cancelled') return 'Cancelled';
    if (s === 'dispatched' || s === 'closed') return 'Closed';
    return 'Open';
}

/**
 * Infer Carrier from the tracking URL's host.
 * Falls back to the raw hostname if we don't recognize it.
 */
function inferCarrierFromTrackingLink(trackingLink) {
    if (!trackingLink) return null;
    try {
        const host = new URL(trackingLink).hostname.toLowerCase();
        if (host.indexOf('fedex') !== -1) return 'FedEx';
        if (host.indexOf('ups.com') !== -1) return 'UPS';
        if (host.indexOf('usps') !== -1) return 'USPS';
        if (host.indexOf('dhl') !== -1) return 'DHL';
        if (host.indexOf('ontrac') !== -1) return 'OnTrac';
        return host;
    } catch (e) {
        return null;
    }
}

/**
 * Concat shippingAddresses[0] object into a single newline-separated string.
 * API shape per 09-managing-jobs.md: {name, company, address1, address2, city, state, postalCode, country, phone, email}
 */
function concatShippingAddress(addr) {
    if (!addr) return null;
    const parts = [];
    if (addr.address1) parts.push(addr.address1);
    if (addr.address2) parts.push(addr.address2);
    const cityStateZip = [
        addr.city,
        [addr.state, addr.postalCode].filter(Boolean).join(' ')
    ].filter(Boolean).join(', ');
    if (cityStateZip) parts.push(cityStateZip);
    if (addr.country) parts.push(addr.country);
    return parts.length ? parts.join('\n') : null;
}

/**
 * Map API ActiveJobDto (from /Jobs/active list) → Supacolor_Jobs stub payload.
 * Used by sync/all — lightweight sync that skips detail+history fetches to stay
 * under Caspio's API rate limit when syncing 900+ jobs at once.
 *
 * ActiveJobDto fields: jobNumber, masterJobStatus, originCode, description,
 *   mustDate, dateDue, dateOut, shippedDaysToProcess, orderNumber, permissions
 *
 * Deep fields (location, shipping, tracking, lines, history) require
 * sync/:jobNumber which fetches /Jobs/{n} + /Jobs/{n}/history.
 */
function mapApiStubToCaspio(apiStub) {
    if (!apiStub) return null;
    const payload = {
        Supacolor_Job_Number: apiStub.jobNumber != null ? String(apiStub.jobNumber) : null,
        PO_Number: apiStub.orderNumber || null,
        Description: apiStub.description || null,
        Status: mapApiStatusToBucket(apiStub.masterJobStatus),
        Requested_Ship_Date: apiStub.dateDue || null,
        Date_Shipped: apiStub.dateOut || null,
        Backfill_Source: 'api'
    };
    Object.keys(payload).forEach(k => {
        if (payload[k] === null || payload[k] === undefined || payload[k] === '') delete payload[k];
    });
    return payload;
}

/**
 * Map API JobDetail → Supacolor_Jobs payload.
 * Returns a plain object ready for insertJob/updateJob (strips nothing — caller handles that).
 */
function mapApiJobToCaspio(apiJob) {
    if (!apiJob) return null;
    const lines = Array.isArray(apiJob.lines) ? apiJob.lines : [];
    const subtotal = lines.reduce((acc, l) => {
        const qty = Number(l.quantity) || 0;
        const price = Number(l.unitPrice) || 0;
        return acc + qty * price;
    }, 0);
    const taxTotal = Number(apiJob.taxTotal) || 0;
    const total = subtotal + taxTotal;
    const shipAddr = Array.isArray(apiJob.shippingAddresses) && apiJob.shippingAddresses[0];

    const payload = {
        Supacolor_Job_Number: apiJob.jobNumber != null ? String(apiJob.jobNumber) : null,
        PO_Number: apiJob.orderNumber || null,
        Description: apiJob.description || null,
        Status: mapApiStatusToBucket(apiJob.jobStatus),
        Date_Entered: apiJob.dateIn || null,
        Requested_Ship_Date: apiJob.dateDue || null,
        Date_Shipped: apiJob.dateOut || null,
        Created_By_Name: apiJob.creator || null,
        Location: (apiJob.location && apiJob.location.name) || null,
        Shipping_Method: apiJob.deliveryMethod || null,
        Tracking_Number: apiJob.trackingNumber || null,
        Carrier: inferCarrierFromTrackingLink(apiJob.trackingLink),
        Ship_To_Name: apiJob.contactName || null,
        Ship_To_Company: apiJob.organisation || null,
        Ship_To_Phone: apiJob.phone || null,
        Ship_To_Email: apiJob.emailAddress || null,
        Ship_To_Address: concatShippingAddress(shipAddr),
        Subtotal: subtotal || null,
        Tax_Total: taxTotal || null,
        Total: total || null,
        Currency: apiJob.currency || null,
        Backfill_Source: 'api'
    };

    // Strip nulls so the patch-only upsert logic doesn't overwrite existing values with null.
    Object.keys(payload).forEach(k => {
        if (payload[k] === null || payload[k] === undefined || payload[k] === '') delete payload[k];
    });
    return payload;
}

/**
 * Map API lines[] → Supacolor_Joblines payload array (ID_Job assigned by caller).
 */
function mapApiLinesToCaspio(apiLines) {
    if (!Array.isArray(apiLines)) return [];
    return apiLines.map((l, i) => {
        const qty = Number(l.quantity);
        const price = Number(l.unitPrice);
        const lineTotal = (!isNaN(qty) && !isNaN(price)) ? qty * price : null;
        const pc = (l.processCode || '').toUpperCase();
        const lineType = pc === 'NU' ? 'NUMBERS'
                        : pc === 'STOCK' ? 'STOCK'
                        : 'TRANSFER';
        const detailPieces = [l.garment, l.comments].filter(x => x && String(x).trim());
        return {
            Line_Order: i + 1,
            Line_Type: lineType,
            Item_Code: l.assetSku || '',
            Description: l.description || null,
            Detail_Line: detailPieces.length ? detailPieces.join('\n') : null,
            Color: null,
            Quantity: !isNaN(qty) ? qty : null,
            Unit_Price: !isNaN(price) ? price : null,
            Line_Total: lineTotal,
            Thumbnail_URL: l.imageUrl || null
        };
    });
}

/**
 * Map API history[] → Supacolor_Job_History payload array (ID_Job assigned by caller).
 */
function mapApiHistoryToCaspio(apiHistory) {
    if (!Array.isArray(apiHistory)) return [];
    return apiHistory
        .map(h => ({
            Event_Type: h.recordLogType || 'Event',
            Event_Detail: h.eventDetail || null,
            Event_At: h.dateTimeOccurred || null
        }))
        .filter(e => e.Event_Type);
}

/**
 * Internal helper: fully sync one job from the API into Caspio.
 * Fetches detail + history in parallel, upserts the job, then full-replaces
 * its joblines + history.
 *
 * Returns { action: 'inserted'|'patched'|'noop', jobNumber, idJob, joblinesReplaced, historyReplaced }
 * Throws on hard failure — caller handles error bookkeeping.
 */
async function syncOneJobFromApi(token, jobNumber, { force = false } = {}) {
    const [apiJob, apiHistory] = await Promise.all([
        supacolorApi.getJobDetail(jobNumber),
        supacolorApi.getJobHistory(jobNumber).catch(e => {
            // History endpoint is less critical — log and continue with empty.
            console.warn(`[Supacolor sync] History fetch failed for job #${jobNumber}:`, e.message);
            return [];
        })
    ]);

    const jobPayload = mapApiJobToCaspio(apiJob);
    if (!jobPayload || !jobPayload.Supacolor_Job_Number) {
        throw new Error(`API returned unusable job detail for #${jobNumber}`);
    }

    // Upsert job (reuses existing helpers)
    const existing = await fetchJobByNumber(token, jobPayload.Supacolor_Job_Number);
    let action;
    let idJob;
    if (!existing) {
        const created = await insertJob(token, jobPayload);
        idJob = created && created.ID_Job;
        action = 'inserted';
    } else {
        idJob = existing.ID_Job;
        const patch = {};
        Object.keys(jobPayload).forEach(k => {
            if (READ_ONLY_JOB_FIELDS.includes(k)) return;
            if (k === 'Supacolor_Job_Number') return;
            const newVal = jobPayload[k];
            const oldVal = existing[k];
            if (force) {
                patch[k] = newVal;
            } else if (newVal != null && newVal !== '' && (oldVal == null || oldVal === '')) {
                patch[k] = newVal;
            }
        });
        // Auto-close override matches existing upsert route semantics.
        if (hasShippedSignal(jobPayload) && existing.Status !== 'Cancelled' && existing.Status !== 'Closed') {
            patch.Status = 'Closed';
        }
        if (Object.keys(patch).length === 0) {
            action = 'noop';
        } else {
            await updateJob(token, idJob, patch);
            action = 'patched';
        }
    }

    // Full-replace joblines + history (same semantics as paste-OCR flow)
    const lines = mapApiLinesToCaspio(apiJob.lines);
    let joblinesReplaced = 0;
    if (idJob) {
        try { await deleteJoblines(token, idJob); } catch (e) { console.warn(`Joblines delete (job ${idJob}):`, e.message); }
        for (let i = 0; i < lines.length; i++) {
            const line = stripFields(lines[i], READ_ONLY_LINE_FIELDS);
            line.ID_Job = idJob;
            const url = `${caspioApiBaseUrl}/tables/${TABLE_LINES}/records`;
            await axios.post(url, line, {
                headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
                timeout: 15000
            });
            joblinesReplaced++;
        }
    }

    const historyEvents = mapApiHistoryToCaspio(apiHistory);
    let historyReplaced = 0;
    if (idJob) {
        try { await deleteHistory(token, idJob); } catch (e) { console.warn(`History delete (job ${idJob}):`, e.message); }
        for (const ev of historyEvents) {
            const event = stripFields(ev, READ_ONLY_HISTORY_FIELDS);
            event.ID_Job = idJob;
            const url = `${caspioApiBaseUrl}/tables/${TABLE_HISTORY}/records`;
            await axios.post(url, event, {
                headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
                timeout: 15000
            });
            historyReplaced++;
        }
    }

    // D.2 — If this Supacolor job has shipped, flip matching Transfer_Orders to Shipped.
    // Non-blocking: the sync itself should succeed even if the mirror fails.
    let transferMirror = null;
    try {
        transferMirror = await mirrorShippedToTransfer(token, jobPayload);
    } catch (err) {
        console.warn(`[Supacolor syncOneJob #${jobNumber}] transfer-mirror raised:`, err.message);
    }

    return {
        action,
        jobNumber: jobPayload.Supacolor_Job_Number,
        idJob,
        joblinesReplaced,
        historyReplaced,
        transferMirror
    };
}

/**
 * POST /api/supacolor-jobs/sync/all
 *
 * LIGHTWEIGHT list sync. Pulls `/Jobs/active?includeClosedJobs=true` (stub data
 * only: jobNumber, status, dates, orderNumber, description) and upserts each
 * into Caspio. Does NOT fetch per-job detail/history — that's what
 * `sync/:jobNumber` is for (used when a user opens a detail page).
 *
 * Strategy:
 *  1. Fetch all API stubs (single paginated Supacolor call, ~5-10 pages)
 *  2. Fetch all existing Caspio Supacolor_Jobs once (paginated)
 *  3. Build an in-memory map of existing rows → diff against API stubs
 *  4. Batch inserts for new jobs + patches for status/date changes
 *  5. Most jobs = noop (no write). Only ~5-50 writes per sync typically.
 *
 * This keeps Caspio write pressure low enough to stay under rate limits even
 * with 900+ total jobs, and completes in under 30s (Heroku's HTTP timeout).
 *
 * Optional query: ?force=true — overwrite existing Caspio fields with API values.
 *
 * Returns: { success, fetched, inserted, patched, noop, errored, durationMs, errors: [...], errorsTruncated }
 */
router.post('/supacolor-jobs/sync/all', async (req, res) => {
    const started = Date.now();
    const force = req.query.force === 'true';
    // Default to active-only (non-closed) for fast dashboard refreshes.
    // Closed jobs rarely change, so skipping them keeps Caspio write pressure low.
    // Pass ?includeClosed=true for a full historical resync (slower, ~900+ jobs).
    const includeClosed = req.query.includeClosed === 'true';
    const MAX_ERRORS_RETURNED = 20;
    const SLEEP_BETWEEN_WRITES_MS = 100; // Cap Caspio writes at ~10/sec to stay under rate limit
    // Soft time cap: Heroku kills HTTP requests after 30s. Leave a 5s buffer.
    // If we blow past this, stop processing new jobs and return what we have.
    const TIME_CAP_MS = 25000;

    try {
        // 1. Pull stubs from Supacolor
        const stubs = await supacolorApi.fetchAllActiveJobs({ includeClosedJobs: includeClosed });
        console.log(`[Supacolor sync/all] Fetched ${stubs.length} job stubs from API (includeClosed=${includeClosed})`);

        // 2. Pull all existing Supacolor_Jobs from Caspio in one paginated scan
        const existingRows = await fetchAllCaspioPages(`/tables/${TABLE_JOBS}/records`, {
            'q.pageSize': 1000
        });
        const existingByJobNumber = new Map();
        existingRows.forEach(row => {
            if (row.Supacolor_Job_Number) {
                existingByJobNumber.set(String(row.Supacolor_Job_Number), row);
            }
        });
        console.log(`[Supacolor sync/all] Loaded ${existingRows.length} existing Caspio rows`);

        const token = await getCaspioAccessToken();

        // 3. Diff + batch upserts (sequential to keep Caspio write pressure low)
        let inserted = 0, patched = 0, noop = 0, errored = 0;
        const errors = [];

        let timedOut = false;
        for (const stub of stubs) {
            if (Date.now() - started > TIME_CAP_MS) {
                timedOut = true;
                console.warn(`[Supacolor sync/all] Hit ${TIME_CAP_MS}ms soft cap — stopping early. ${inserted + patched + noop}/${stubs.length} processed.`);
                break;
            }
            const jobPayload = mapApiStubToCaspio(stub);
            if (!jobPayload || !jobPayload.Supacolor_Job_Number) {
                errored++;
                if (errors.length < MAX_ERRORS_RETURNED) {
                    errors.push({ jobNumber: stub && stub.jobNumber, error: 'API stub missing jobNumber' });
                }
                continue;
            }

            const existing = existingByJobNumber.get(jobPayload.Supacolor_Job_Number);
            let jobUpsertedOrChanged = false;
            try {
                if (!existing) {
                    await writeWithRateLimitRetry(
                        () => insertJob(token, jobPayload),
                        { label: `insert #${jobPayload.Supacolor_Job_Number}` }
                    );
                    inserted++;
                    jobUpsertedOrChanged = true;
                    await sleep(SLEEP_BETWEEN_WRITES_MS);
                } else {
                    // Patch: only write if a field is actually different (or empty in Caspio)
                    const patch = {};
                    Object.keys(jobPayload).forEach(k => {
                        if (READ_ONLY_JOB_FIELDS.includes(k)) return;
                        if (k === 'Supacolor_Job_Number') return;
                        if (k === 'Backfill_Source') return; // don't overwrite existing provenance
                        const newVal = jobPayload[k];
                        const oldVal = existing[k];
                        if (force) {
                            if (String(oldVal || '') !== String(newVal || '')) patch[k] = newVal;
                        } else if (newVal != null && newVal !== '' && (oldVal == null || oldVal === '')) {
                            patch[k] = newVal;
                        } else if (k === 'Status' && newVal && newVal !== oldVal) {
                            // Status transitions (Open → Closed, Open → Cancelled) always flow through
                            patch[k] = newVal;
                        } else if ((k === 'Date_Shipped' || k === 'Requested_Ship_Date') && newVal && newVal !== oldVal) {
                            // Date changes always flow through even if existing had a stale value
                            patch[k] = newVal;
                        }
                    });
                    // Auto-close override: shipped-signal forces Closed (unless Cancelled)
                    if (hasShippedSignal(jobPayload) && existing.Status !== 'Cancelled' && existing.Status !== 'Closed') {
                        patch.Status = 'Closed';
                    }
                    if (Object.keys(patch).length === 0) {
                        noop++;
                    } else {
                        await writeWithRateLimitRetry(
                            () => updateJob(token, existing.ID_Job, patch),
                            { label: `patch #${jobPayload.Supacolor_Job_Number}` }
                        );
                        patched++;
                        jobUpsertedOrChanged = true;
                        await sleep(SLEEP_BETWEEN_WRITES_MS);
                    }
                }
            } catch (err) {
                errored++;
                const msg = err.response ? JSON.stringify(err.response.data) : err.message;
                if (errors.length < MAX_ERRORS_RETURNED) {
                    errors.push({ jobNumber: jobPayload.Supacolor_Job_Number, error: msg });
                }
                console.error(`[Supacolor sync/all] Job #${jobPayload.Supacolor_Job_Number} failed:`, msg);
            }

            // D.2 — After a successful upsert/patch, mirror the shipped signal to any
            // linked Transfer_Orders. Non-blocking — cron tolerance matters more than
            // immediate consistency here.
            if (jobUpsertedOrChanged) {
                try {
                    // Merge the stub payload with the existing Caspio row so fields only
                    // present on existing (e.g., Tracking_Number populated by a prior
                    // deep sync) still flow to the mirror. Stub is source-of-truth for
                    // Status + Date_Shipped — those shape isShippedSignal().
                    const merged = Object.assign({}, existing || {}, jobPayload);
                    await mirrorShippedToTransfer(token, merged);
                } catch (mirrorErr) {
                    console.warn(`[Supacolor sync/all] transfer-mirror for #${jobPayload.Supacolor_Job_Number}:`, mirrorErr.message);
                }
            }
        }

        const durationMs = Date.now() - started;
        console.log(`[Supacolor sync/all] Done in ${durationMs}ms — ${inserted} inserted, ${patched} patched, ${noop} noop, ${errored} errored`);
        res.json({
            success: true,
            fetched: stubs.length,
            processed: inserted + patched + noop + errored,
            inserted,
            patched,
            noop,
            errored,
            durationMs,
            timedOut,
            errors,
            errorsTruncated: errored > MAX_ERRORS_RETURNED
        });
    } catch (error) {
        console.error('[Supacolor sync/all] Fatal error:', error.response ? JSON.stringify(error.response.data) : error.message);
        res.status(500).json({
            success: false,
            error: 'Sync failed: ' + (error.message || 'unknown error'),
            durationMs: Date.now() - started
        });
    }
});

/**
 * POST /api/supacolor-jobs/sync/:jobNumber
 *
 * Refresh a single job (detail + history) from the Supacolor API.
 * :jobNumber is the Supacolor job number (NOT the Caspio ID_Job).
 *
 * Optional query: ?force=true — overwrite existing Caspio fields.
 */
router.post('/supacolor-jobs/sync/:jobNumber', async (req, res) => {
    const jobNumber = req.params.jobNumber;
    const force = req.query.force === 'true';
    if (!jobNumber) {
        return res.status(400).json({ success: false, error: 'Missing jobNumber in path' });
    }

    try {
        const token = await getCaspioAccessToken();
        const result = await syncOneJobFromApi(token, jobNumber, { force });
        console.log(`[Supacolor sync/:jobNumber] #${jobNumber} → ${result.action} (ID_Job=${result.idJob}, ${result.joblinesReplaced} lines, ${result.historyReplaced} events)`);
        res.json({ success: true, ...result });
    } catch (error) {
        // 404 → the API doesn't know this job number
        const status = error.response && error.response.status;
        if (status === 404) {
            return res.status(404).json({ success: false, error: `Supacolor API does not have job #${jobNumber}` });
        }
        console.error(`[Supacolor sync/:jobNumber] #${jobNumber} failed:`, error.response ? JSON.stringify(error.response.data) : error.message);
        res.status(500).json({ success: false, error: 'Sync failed: ' + (error.message || 'unknown error') });
    }
});

// ── Image Proxy (1-click download for the detail-page lightbox) ────────
//
// Supacolor's CDN returns images with Content-Disposition: inline and no CORS
// headers, which defeats both fetch→blob downloads AND the HTML5 `download`
// attribute (which is same-origin-only). We proxy through this endpoint so:
//   - Response lands same-origin → `download` attribute is honored
//   - Content-Disposition: attachment → browser downloads instead of navigating
//
// SSRF mitigation: only fetch URLs whose hostname ends in .supacolor.com.
// This is a known pattern for sanitizing external fetches.
router.get('/supacolor-jobs/proxy-image', async (req, res) => {
    const { url, name } = req.query;
    if (!url) {
        return res.status(400).json({ success: false, error: 'Missing url query param' });
    }

    // Parse + validate URL (SSRF guard)
    let parsed;
    try {
        parsed = new URL(url);
    } catch (e) {
        return res.status(400).json({ success: false, error: 'Invalid url' });
    }
    if (parsed.protocol !== 'https:') {
        return res.status(400).json({ success: false, error: 'Only https URLs allowed' });
    }
    const hostname = parsed.hostname.toLowerCase();
    // Allow supacolor.com + any subdomain (intranet.supacolor.com, cdn.supacolor.com, etc.)
    const isSupacolor = hostname === 'supacolor.com' || hostname.endsWith('.supacolor.com');
    if (!isSupacolor) {
        return res.status(403).json({ success: false, error: 'Only *.supacolor.com URLs are allowed' });
    }

    try {
        const upstream = await axios.get(url, {
            responseType: 'arraybuffer',
            timeout: 20000,
            validateStatus: () => true, // handle non-2xx ourselves instead of throwing
            maxContentLength: 50 * 1024 * 1024 // 50MB cap (transfer art is typically < 2MB)
        });

        if (upstream.status >= 400) {
            console.warn(`[proxy-image] Upstream ${upstream.status} for ${url}`);
            return res.status(upstream.status).json({
                success: false,
                error: `Upstream returned ${upstream.status}`
            });
        }

        // Sanitize filename — strip path traversal, control chars, and anything
        // that could break Content-Disposition header parsing.
        const safeName = String(name || 'supacolor-image.jpg')
            .replace(/[\r\n"]/g, '')       // header-injection chars
            .replace(/[\/\\]/g, '-')        // path separators
            .replace(/[^\w.\-\s()]/g, '-')  // keep alphanumerics + common filename chars
            .slice(0, 120) || 'supacolor-image.jpg';

        const contentType = upstream.headers['content-type'] || 'application/octet-stream';

        res.set('Content-Type', contentType);
        res.set('Content-Disposition', `attachment; filename="${safeName}"`);
        res.set('Cache-Control', 'private, max-age=300'); // 5-min browser cache is fine
        res.set('X-Content-Type-Options', 'nosniff');
        res.send(Buffer.from(upstream.data));
    } catch (err) {
        console.error('[proxy-image] Error:', err.message);
        res.status(500).json({ success: false, error: 'Proxy fetch failed: ' + err.message });
    }
});

module.exports = router;
