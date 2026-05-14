// Policies Hub — Comments & questions per policy.
//
// Two routers exported, mounted at different paths in server.js:
//
//   publicRouter (no auth)  — mounted at /api/policy-comments-public
//     GET    /by-policy/:policyId  → list visible comments (Status != Hidden)
//     POST   /                      → create a comment (author info from client)
//                                    Rate-limited via global apiLimiter.
//
//   adminRouter (X-CRM-API-Secret)  — mounted at /api/policy-comments
//     PUT    /:commentId            → update body / status (resolve, etc)
//     DELETE /:commentId            → soft-delete (Status='Hidden')
//     POST   /:commentId/resolve    → mark Open question as Resolved
//
// The author of a comment is whoever sessionStorage says they are on the
// client — internal tool, internal trust. Server stamps Created_At /
// Updated_At and validates field shapes. Caspio's Unique constraint on
// Comment_ID prevents duplicate slugs at the DB level.

const express = require('express');
const axios = require('axios');
const config = require('../../config');
const { getCaspioAccessToken, fetchAllCaspioPages } = require('../utils/caspio');

const caspioApiBaseUrl = config.caspio.apiBaseUrl;
const TABLE = 'Policy_Comments';
const PRIMARY = 'Comment_ID';

const VALID_STATUSES = ['Open', 'Resolved', 'Hidden'];
const BODY_MAX = 64000;  // Caspio Text(64000) hard cap

// -------------------- helpers --------------------

function nwcaTimestamp() {
    return new Date().toISOString().replace(/\.\d{3}Z$/, '');
}

// Single-quote SQL escape for Caspio q.where strings
function sqlEscape(value) {
    return String(value).replace(/'/g, "''");
}

// Generate a comment slug: cmt-YYYYMMDD-HHmmss-rand
function newCommentId() {
    const d = new Date();
    const pad = n => String(n).padStart(2, '0');
    const stamp = `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}-${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}`;
    const rand = Math.random().toString(36).slice(2, 6);
    return `cmt-${stamp}-${rand}`;
}

function validatePolicyId(s) {
    return typeof s === 'string' && /^[a-z0-9-]{2,100}$/i.test(s);
}

function validateEmail(s) {
    return typeof s === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s) && s.length <= 100;
}

// Trim and bound author name
function cleanName(s) {
    return String(s || '').trim().slice(0, 100);
}

// =====================================================================
// PUBLIC ROUTER  (no CRM auth — mounted unprotected)
// =====================================================================
const publicRouter = express.Router();

// GET /by-policy/:policyId
// Returns visible comments (anything except Hidden) for one policy, ordered
// oldest-first so threaded reads line up chronologically.
publicRouter.get('/by-policy/:policyId', async (req, res) => {
    const policyId = req.params.policyId;
    if (!validatePolicyId(policyId)) {
        return res.status(400).json({ success: false, error: 'Invalid Policy_ID' });
    }

    try {
        const params = {
            'q.where': `Policy_ID='${sqlEscape(policyId)}' AND Status<>'Hidden'`,
            'q.orderBy': 'Created_At ASC',
            'q.limit': 500
        };
        const records = await fetchAllCaspioPages(`/tables/${TABLE}/records`, params);
        res.json({
            success: true,
            policy_id: policyId,
            count: records.length,
            comments: records
        });
    } catch (e) {
        console.error('[policy-comments] list error:', e.message);
        res.status(500).json({ success: false, error: 'Failed to load comments' });
    }
});

// POST /
// Body: { Policy_ID, Author_Name, Author_Email, Body, Parent_Comment_ID?, Is_Question? }
// Creates a new comment with Status='Open' and server-stamped timestamps.
publicRouter.post('/', express.json({ limit: '256kb' }), async (req, res) => {
    const body = req.body || {};

    if (!validatePolicyId(body.Policy_ID)) {
        return res.status(400).json({ success: false, error: 'Invalid or missing Policy_ID' });
    }
    if (!body.Body || typeof body.Body !== 'string' || !body.Body.trim()) {
        return res.status(400).json({ success: false, error: 'Comment Body is required' });
    }
    if (body.Body.length > BODY_MAX) {
        return res.status(413).json({
            success: false,
            error: `Comment too long (${body.Body.length} chars; max ${BODY_MAX}).`
        });
    }
    const name = cleanName(body.Author_Name);
    if (!name) {
        return res.status(400).json({ success: false, error: 'Author_Name is required' });
    }
    const email = String(body.Author_Email || '').trim();
    if (email && !validateEmail(email)) {
        return res.status(400).json({ success: false, error: 'Invalid Author_Email' });
    }
    if (body.Parent_Comment_ID && typeof body.Parent_Comment_ID !== 'string') {
        return res.status(400).json({ success: false, error: 'Invalid Parent_Comment_ID' });
    }

    // Verify Policy_ID exists in Policies table — prevents orphan comments
    try {
        const policy = await fetchAllCaspioPages(`/tables/Policies/records`, {
            'q.where': `Policy_ID='${sqlEscape(body.Policy_ID)}' AND Is_Active=1`,
            'q.select': 'Policy_ID',
            'q.limit': 1
        });
        if (policy.length === 0) {
            return res.status(404).json({ success: false, error: 'Policy not found or inactive' });
        }
    } catch (e) {
        // Fail open — log but continue; don't block on a transient lookup error
        console.warn('[policy-comments] policy existence check failed:', e.message);
    }

    // Generate a unique Comment_ID with one retry in case of collision
    let commentId = newCommentId();
    try {
        const existing = await fetchAllCaspioPages(`/tables/${TABLE}/records`, {
            'q.where': `${PRIMARY}='${sqlEscape(commentId)}'`,
            'q.select': PRIMARY,
            'q.limit': 1
        });
        if (existing.length > 0) commentId = newCommentId();  // millisecond-level collision
    } catch (e) { /* if check fails, just try the insert and let Caspio Unique constraint reject */ }

    const now = nwcaTimestamp();
    const record = {
        Comment_ID: commentId,
        Policy_ID: body.Policy_ID,
        Parent_Comment_ID: body.Parent_Comment_ID || '',
        Author_Name: name,
        Author_Email: email,
        Body: body.Body.trim(),
        Status: 'Open',
        Created_At: now,
        Updated_At: now,
        Is_Question: body.Is_Question ? 1 : 0
    };

    try {
        const token = await getCaspioAccessToken();
        await axios({
            method: 'post',
            url: `${caspioApiBaseUrl}/tables/${TABLE}/records`,
            headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
            data: record,
            timeout: 15000
        });
        console.log(`[policy-comments] created ${commentId} on ${body.Policy_ID} by ${name}`);
        res.status(201).json({ success: true, comment: record });
    } catch (e) {
        const detail = e.response ? JSON.stringify(e.response.data) : e.message;
        console.error('[policy-comments] create error:', detail);
        if (e.response?.status === 409) {
            return res.status(409).json({ success: false, error: 'Duplicate Comment_ID — try again' });
        }
        res.status(500).json({ success: false, error: 'Failed to post comment' });
    }
});

// Reject any other methods on the public router cleanly
publicRouter.put('*', (req, res) => res.status(403).json({ success: false, error: 'Use the admin endpoint to update comments' }));
publicRouter.delete('*', (req, res) => res.status(403).json({ success: false, error: 'Use the admin endpoint to delete comments' }));

// =====================================================================
// ADMIN ROUTER  (requireCrmApiSecret — applied at mount in server.js)
// =====================================================================
const adminRouter = express.Router();

// GET /inbox  → all open questions across all policies, joined with the
// policy's Title + Category so the frontend doesn't need a follow-up fetch.
// Sorted oldest-first so what's been waiting longest surfaces at the top.
//
// Strategy: 2 Caspio queries (open-questions + active-policies), in-memory
// join. Both are small at NWCA scale (single-digit open questions, ~10
// policies). Way cheaper than N+1 per-question lookups.
adminRouter.get('/inbox', async (req, res) => {
    try {
        const [questions, policies] = await Promise.all([
            fetchAllCaspioPages(`/tables/${TABLE}/records`, {
                'q.where': `Is_Question=1 AND Status='Open'`,
                'q.orderBy': 'Created_At ASC',  // oldest waiting first
                'q.limit': 500
            }),
            fetchAllCaspioPages(`/tables/Policies/records`, {
                'q.where': `Is_Active=1`,
                'q.select': 'Policy_ID,Title,Category',
                'q.limit': 1000
            })
        ]);

        const policyMap = new Map();
        policies.forEach(p => policyMap.set(p.Policy_ID, { Title: p.Title, Category: p.Category }));

        const enriched = questions.map(q => {
            const meta = policyMap.get(q.Policy_ID) || {};
            return {
                ...q,
                Policy_Title: meta.Title || '(policy deleted)',
                Policy_Category: meta.Category || ''
            };
        });

        // Filter out questions whose policy was deleted/archived — they're
        // orphans and there's no useful "Reply on policy →" target.
        const visible = enriched.filter(q => policyMap.has(q.Policy_ID));

        res.json({
            success: true,
            count: visible.length,
            orphan_count: enriched.length - visible.length,
            questions: visible
        });
    } catch (e) {
        console.error('[policy-comments] inbox error:', e.message);
        res.status(500).json({ success: false, error: 'Failed to load inbox' });
    }
});

// GET /inbox/count  → tiny endpoint just for the hub's badge.
// Same query as /inbox but only returns the integer — keeps the hub page
// fast and avoids hauling comment bodies it doesn't need.
adminRouter.get('/inbox/count', async (req, res) => {
    try {
        const records = await fetchAllCaspioPages(`/tables/${TABLE}/records`, {
            'q.where': `Is_Question=1 AND Status='Open'`,
            'q.select': 'Comment_ID',
            'q.limit': 500
        });
        res.json({ success: true, count: records.length });
    } catch (e) {
        console.error('[policy-comments] inbox count error:', e.message);
        res.status(500).json({ success: false, error: 'Failed to fetch inbox count' });
    }
});

// PUT /:commentId  → update body / status / Is_Question
adminRouter.put('/:commentId', express.json({ limit: '256kb' }), async (req, res) => {
    const id = req.params.commentId;
    if (!id) return res.status(400).json({ success: false, error: 'Missing commentId' });

    try {
        const body = { ...req.body };
        delete body.Comment_ID;   // never re-key
        delete body.Created_At;
        delete body.Policy_ID;    // can't move a comment to a different policy

        if (body.Status !== undefined && !VALID_STATUSES.includes(body.Status)) {
            return res.status(400).json({
                success: false,
                error: `Invalid Status. Must be: ${VALID_STATUSES.join(', ')}`
            });
        }
        if (body.Body !== undefined) {
            if (typeof body.Body !== 'string' || !body.Body.trim()) {
                return res.status(400).json({ success: false, error: 'Body cannot be empty' });
            }
            if (body.Body.length > BODY_MAX) {
                return res.status(413).json({
                    success: false,
                    error: `Body too long (${body.Body.length}/${BODY_MAX})`
                });
            }
            body.Body = body.Body.trim();
        }

        body.Updated_At = nwcaTimestamp();

        const token = await getCaspioAccessToken();
        await axios({
            method: 'put',
            url: `${caspioApiBaseUrl}/tables/${TABLE}/records?q.where=${PRIMARY}='${encodeURIComponent(id)}'`,
            headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
            data: body,
            timeout: 15000
        });
        console.log(`[policy-comments] updated ${id}: ${Object.keys(body).join(', ')}`);
        res.json({ success: true, comment_id: id, updated_fields: Object.keys(body) });
    } catch (e) {
        console.error('[policy-comments] update error:', e.response ? JSON.stringify(e.response.data) : e.message);
        res.status(500).json({ success: false, error: 'Failed to update comment' });
    }
});

// DELETE /:commentId  → soft delete (Status='Hidden'). Children stay visible
// but lose their parent thread visually; that's acceptable (rare case).
adminRouter.delete('/:commentId', async (req, res) => {
    const id = req.params.commentId;
    if (!id) return res.status(400).json({ success: false, error: 'Missing commentId' });

    try {
        const token = await getCaspioAccessToken();
        await axios({
            method: 'put',
            url: `${caspioApiBaseUrl}/tables/${TABLE}/records?q.where=${PRIMARY}='${encodeURIComponent(id)}'`,
            headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
            data: { Status: 'Hidden', Updated_At: nwcaTimestamp() },
            timeout: 15000
        });
        console.log(`[policy-comments] hidden ${id}`);
        res.json({ success: true, comment_id: id, hidden: true });
    } catch (e) {
        console.error('[policy-comments] delete error:', e.message);
        res.status(500).json({ success: false, error: 'Failed to delete comment' });
    }
});

// POST /:commentId/resolve  → mark Open question as Resolved
adminRouter.post('/:commentId/resolve', async (req, res) => {
    const id = req.params.commentId;
    if (!id) return res.status(400).json({ success: false, error: 'Missing commentId' });

    try {
        const token = await getCaspioAccessToken();
        await axios({
            method: 'put',
            url: `${caspioApiBaseUrl}/tables/${TABLE}/records?q.where=${PRIMARY}='${encodeURIComponent(id)}'`,
            headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
            data: { Status: 'Resolved', Updated_At: nwcaTimestamp() },
            timeout: 15000
        });
        res.json({ success: true, comment_id: id, status: 'Resolved' });
    } catch (e) {
        console.error('[policy-comments] resolve error:', e.message);
        res.status(500).json({ success: false, error: 'Failed to resolve comment' });
    }
});

module.exports = { publicRouter, adminRouter };
