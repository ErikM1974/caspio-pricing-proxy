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
//   POST   /api/supacolor-jobs/bulk-upsert        — Batch upsert (jobs-list backfill)
//   PUT    /api/supacolor-jobs/:id                — Update fields
//   DELETE /api/supacolor-jobs/:id                — Delete job + cascade joblines + history
//   GET    /api/supacolor-jobs/:id/joblines       — List joblines for a job
//   POST   /api/supacolor-jobs/:id/joblines       — Replace all joblines (delete + insert)
//   GET    /api/supacolor-jobs/:id/history        — List history events
//   POST   /api/supacolor-jobs/:id/history        — Append a single history event
//   POST   /api/supacolor-jobs/:id/history/replace — Replace all history events

const express = require('express');
const router = express.Router();
const axios = require('axios');
const { getCaspioAccessToken, fetchAllCaspioPages } = require('../utils/caspio');
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
            return res.json({ success: true, job: existing, action: 'noop' });
        }

        const updated = await updateJob(token, existing.ID_Job, patch);
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

module.exports = router;
