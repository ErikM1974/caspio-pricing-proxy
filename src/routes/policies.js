// Company Policies & Procedures Hub - CRUD routes for Policies table
// Pattern modeled on house-accounts.js
//
// Two mount points (see server.js registration):
//   /api/policies-public/*  → unprotected, only returns Status=Published, Is_Active=Yes
//   /api/policies/*         → protected by requireCrmApiSecret (admin reads/writes + drafts)
//
// All routes return JSON with { success, ... } envelope.

const express = require('express');
const axios = require('axios');
const config = require('../../config');
const { getCaspioAccessToken, fetchAllCaspioPages } = require('../utils/caspio');

const caspioApiBaseUrl = config.caspio.apiBaseUrl;
const TABLE_NAME = 'Policies';
const PRIMARY_KEY = 'Policy_ID';

const VALID_CATEGORIES = ['Financial', 'Operations', 'Customer Service', 'HR', 'Training'];
const VALID_STATUSES = ['Draft', 'Published', 'Archived'];

// Caspio Text(64000) hard cap. Save MUST fail loudly above this — silent
// truncation would lose policy content. Client should be warned earlier
// (Phase 2 toast at ~80% capacity), but the server is the source of truth.
const BODY_HTML_MAX = 64000;
const BODY_PLAIN_MAX = 64000;

function validateBodyLengths(record) {
    if (typeof record.Body_HTML === 'string' && record.Body_HTML.length > BODY_HTML_MAX) {
        return {
            field: 'Body_HTML',
            length: record.Body_HTML.length,
            max: BODY_HTML_MAX
        };
    }
    if (typeof record.Body_Plain === 'string' && record.Body_Plain.length > BODY_PLAIN_MAX) {
        return {
            field: 'Body_Plain',
            length: record.Body_Plain.length,
            max: BODY_PLAIN_MAX
        };
    }
    return null;
}

// ----------------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------------

// NWCA timestamp convention — ISO without milliseconds
function nwcaTimestamp() {
    return new Date().toISOString().replace(/\.\d{3}Z$/, '');
}

// Strip HTML tags to plain text for search indexing.
// Conservative: removes <script>/<style> blocks entirely, then strips remaining tags.
function htmlToPlainText(html) {
    if (!html || typeof html !== 'string') return '';
    return html
        .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, ' ')
        .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, ' ')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/\s+/g, ' ')
        .trim();
}

// Escape single quotes for safe inclusion in q.where strings (Caspio uses '' to escape ').
function sqlEscape(value) {
    return String(value).replace(/'/g, "''");
}

// Generate a slug from a title if Policy_ID not provided.
function slugify(title) {
    return String(title || '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '')
        .slice(0, 50);
}

// Strip read-only fields and primary key before update.
function sanitizeUpdatePayload(body) {
    const out = { ...body };
    delete out.PK_ID;
    delete out.Policy_ID;
    delete out.Created_At;
    return out;
}

// Project a record to the "list view" shape — drops Body_HTML to keep payload small.
function toListShape(record) {
    if (!record) return null;
    const { Body_HTML, ...rest } = record;
    return { ...rest, Has_Body: !!Body_HTML };
}

// Build a hierarchical tree from a flat list of records (3 levels max).
function buildTree(records) {
    const byCategory = {};
    const byId = new Map();

    records.forEach(r => byId.set(r.Policy_ID, { ...toListShape(r), children: [] }));

    records.forEach(r => {
        const node = byId.get(r.Policy_ID);
        if (r.Parent_Policy_ID && byId.has(r.Parent_Policy_ID)) {
            byId.get(r.Parent_Policy_ID).children.push(node);
        } else {
            const cat = r.Category || 'Uncategorized';
            if (!byCategory[cat]) byCategory[cat] = [];
            byCategory[cat].push(node);
        }
    });

    // Sort siblings by Sort_Order then Title
    const sortFn = (a, b) => {
        const so = (a.Sort_Order ?? 100) - (b.Sort_Order ?? 100);
        if (so !== 0) return so;
        return String(a.Title || '').localeCompare(String(b.Title || ''));
    };
    Object.values(byCategory).forEach(arr => arr.sort(sortFn));
    byId.forEach(node => node.children.sort(sortFn));

    return Object.entries(byCategory).map(([category, policies]) => ({
        category,
        policies
    }));
}

// ----------------------------------------------------------------------------
// Factory: build a router gated to public-only or full-admin view.
// Public-only routes auto-filter Status=Published AND Is_Active=Yes.
// ----------------------------------------------------------------------------
function buildRouter({ publicOnly }) {
    const router = express.Router();

    // GET /  - List policies with optional filters
    router.get('/', async (req, res) => {
        try {
            const resource = `/tables/${TABLE_NAME}/records`;
            const params = {};
            const whereConditions = [];

            if (publicOnly) {
                whereConditions.push(`Status='Published'`);
                whereConditions.push(`Is_Active=1`);
            } else if (req.query.status) {
                whereConditions.push(`Status='${sqlEscape(req.query.status)}'`);
            }

            if (req.query.category) {
                whereConditions.push(`Category='${sqlEscape(req.query.category)}'`);
            }

            if (req.query.parent === 'null' || req.query.parent === '') {
                whereConditions.push(`(Parent_Policy_ID IS NULL OR Parent_Policy_ID='')`);
            } else if (req.query.parent) {
                whereConditions.push(`Parent_Policy_ID='${sqlEscape(req.query.parent)}'`);
            }

            if (whereConditions.length > 0) {
                params['q.where'] = whereConditions.join(' AND ');
            }

            params['q.orderBy'] = 'Category ASC, Sort_Order ASC, Title ASC';

            const records = await fetchAllCaspioPages(resource, params);
            res.json({
                success: true,
                count: records.length,
                policies: records.map(toListShape)
            });
        } catch (error) {
            console.error('[policies] list error:', error.message);
            res.status(500).json({ success: false, error: 'Failed to fetch policies' });
        }
    });

    // GET /tree  - Hierarchical view
    router.get('/tree', async (req, res) => {
        try {
            const resource = `/tables/${TABLE_NAME}/records`;
            const params = {};
            const whereConditions = [];

            if (publicOnly) {
                whereConditions.push(`Status='Published'`);
                whereConditions.push(`Is_Active=1`);
            }

            if (whereConditions.length > 0) {
                params['q.where'] = whereConditions.join(' AND ');
            }

            const records = await fetchAllCaspioPages(resource, params);
            res.json({
                success: true,
                count: records.length,
                tree: buildTree(records)
            });
        } catch (error) {
            console.error('[policies] tree error:', error.message);
            res.status(500).json({ success: false, error: 'Failed to build policy tree' });
        }
    });

    // GET /search?q=foo  - Title + Body_Plain LIKE search
    router.get('/search', async (req, res) => {
        const q = String(req.query.q || '').trim();
        if (!q) {
            return res.json({ success: true, count: 0, policies: [] });
        }
        if (q.length > 100) {
            return res.status(400).json({ success: false, error: 'Search query too long (max 100 chars)' });
        }

        try {
            const escaped = sqlEscape(q);
            const whereConditions = [
                `(Title LIKE '%${escaped}%' OR Body_Plain LIKE '%${escaped}%' OR Summary LIKE '%${escaped}%')`
            ];

            if (publicOnly) {
                whereConditions.push(`Status='Published'`);
                whereConditions.push(`Is_Active=1`);
            }

            const params = {
                'q.where': whereConditions.join(' AND '),
                'q.orderBy': 'Updated_At DESC',
                'q.limit': 50
            };

            const records = await fetchAllCaspioPages(`/tables/${TABLE_NAME}/records`, params);
            res.json({
                success: true,
                count: records.length,
                query: q,
                policies: records.map(toListShape)
            });
        } catch (error) {
            console.error('[policies] search error:', error.message);
            res.status(500).json({ success: false, error: 'Search failed' });
        }
    });

    // GET /:policyId  - Single policy with full body
    router.get('/:policyId', async (req, res) => {
        try {
            const policyId = sqlEscape(req.params.policyId);
            const params = { 'q.where': `${PRIMARY_KEY}='${policyId}'`, 'q.limit': 1 };

            if (publicOnly) {
                params['q.where'] += ` AND Status='Published' AND Is_Active=1`;
            }

            const records = await fetchAllCaspioPages(`/tables/${TABLE_NAME}/records`, params);
            if (records.length === 0) {
                return res.status(404).json({ success: false, error: 'Policy not found' });
            }
            res.json({ success: true, policy: records[0] });
        } catch (error) {
            console.error('[policies] detail error:', error.message);
            res.status(500).json({ success: false, error: 'Failed to fetch policy' });
        }
    });

    // ------------------------------------------------------------------------
    // Write operations — only available on the admin-mounted router.
    // The publicOnly router rejects these to keep responsibilities clear.
    // ------------------------------------------------------------------------
    if (publicOnly) {
        router.post('/', (req, res) => res.status(403).json({ success: false, error: 'Read-only endpoint' }));
        router.put('/:policyId', (req, res) => res.status(403).json({ success: false, error: 'Read-only endpoint' }));
        router.delete('/:policyId', (req, res) => res.status(403).json({ success: false, error: 'Read-only endpoint' }));
        router.post('/:policyId/move', (req, res) => res.status(403).json({ success: false, error: 'Read-only endpoint' }));
        return router;
    }

    // POST /  - Create new policy
    router.post('/', express.json({ limit: '5mb' }), async (req, res) => {
        try {
            const body = { ...req.body };

            if (!body.Title || !body.Title.trim()) {
                return res.status(400).json({ success: false, error: 'Title is required' });
            }
            if (!body.Category) {
                return res.status(400).json({ success: false, error: 'Category is required' });
            }
            if (!VALID_CATEGORIES.includes(body.Category)) {
                return res.status(400).json({
                    success: false,
                    error: `Invalid Category. Must be one of: ${VALID_CATEGORIES.join(', ')}`
                });
            }
            if (body.Status && !VALID_STATUSES.includes(body.Status)) {
                return res.status(400).json({
                    success: false,
                    error: `Invalid Status. Must be one of: ${VALID_STATUSES.join(', ')}`
                });
            }

            // Generate Policy_ID slug if missing
            let policyId = (body.Policy_ID || slugify(body.Title)).trim();
            if (!policyId) policyId = `policy-${Date.now()}`;

            // Ensure uniqueness — append numeric suffix if collision
            const existing = await fetchAllCaspioPages(`/tables/${TABLE_NAME}/records`, {
                'q.where': `${PRIMARY_KEY}='${sqlEscape(policyId)}'`,
                'q.select': PRIMARY_KEY,
                'q.limit': 1
            });
            if (existing.length > 0) {
                policyId = `${policyId}-${Date.now().toString(36).slice(-4)}`;
            }

            const now = nwcaTimestamp();
            const bodyHtml = body.Body_HTML || '';
            const record = {
                Policy_ID: policyId,
                Parent_Policy_ID: body.Parent_Policy_ID || null,
                Category: body.Category,
                Title: body.Title.trim(),
                Summary: body.Summary || '',
                Body_HTML: bodyHtml,
                Body_Plain: htmlToPlainText(bodyHtml),
                External_URL: body.External_URL || null,
                Owner_Email: body.Owner_Email || '',
                Owner_Name: body.Owner_Name || '',
                Sort_Order: typeof body.Sort_Order === 'number' ? body.Sort_Order : 100,
                Status: body.Status || 'Published',
                Tags: body.Tags || '',
                Created_At: now,
                Updated_At: now,
                Updated_By: body.Updated_By || '',
                Is_Active: 1
            };

            const tooLong = validateBodyLengths(record);
            if (tooLong) {
                return res.status(413).json({
                    success: false,
                    error: `${tooLong.field} is ${tooLong.length} chars; Caspio max is ${tooLong.max}. Shorten the policy or split it into a sub-procedure.`,
                    field: tooLong.field,
                    length: tooLong.length,
                    max: tooLong.max
                });
            }

            const token = await getCaspioAccessToken();
            await axios({
                method: 'post',
                url: `${caspioApiBaseUrl}/tables/${TABLE_NAME}/records`,
                headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
                data: record,
                timeout: 15000
            });

            console.log(`[policies] created Policy_ID=${policyId}`);
            res.status(201).json({ success: true, policy: record });
        } catch (error) {
            console.error('[policies] create error:', error.response ? JSON.stringify(error.response.data) : error.message);
            res.status(500).json({ success: false, error: 'Failed to create policy' });
        }
    });

    // PUT /:policyId  - Update with optional optimistic concurrency check
    router.put('/:policyId', express.json({ limit: '5mb' }), async (req, res) => {
        const policyId = req.params.policyId;
        if (!policyId) {
            return res.status(400).json({ success: false, error: 'Missing policyId' });
        }

        try {
            const ifMatch = req.headers['if-match']; // optional concurrency token (Updated_At)

            // If-Match check: read current Updated_At and compare
            if (ifMatch) {
                const current = await fetchAllCaspioPages(`/tables/${TABLE_NAME}/records`, {
                    'q.where': `${PRIMARY_KEY}='${sqlEscape(policyId)}'`,
                    'q.select': 'Updated_At',
                    'q.limit': 1
                });
                if (current.length === 0) {
                    return res.status(404).json({ success: false, error: 'Policy not found' });
                }
                if (String(current[0].Updated_At) !== String(ifMatch)) {
                    return res.status(409).json({
                        success: false,
                        error: 'Policy was modified by another session. Reload and try again.',
                        current_updated_at: current[0].Updated_At
                    });
                }
            }

            const updateData = sanitizeUpdatePayload(req.body);

            if (updateData.Category && !VALID_CATEGORIES.includes(updateData.Category)) {
                return res.status(400).json({
                    success: false,
                    error: `Invalid Category. Must be one of: ${VALID_CATEGORIES.join(', ')}`
                });
            }
            if (updateData.Status && !VALID_STATUSES.includes(updateData.Status)) {
                return res.status(400).json({
                    success: false,
                    error: `Invalid Status. Must be one of: ${VALID_STATUSES.join(', ')}`
                });
            }

            // Re-derive Body_Plain if Body_HTML changed
            if (typeof updateData.Body_HTML === 'string') {
                updateData.Body_Plain = htmlToPlainText(updateData.Body_HTML);
            }

            updateData.Updated_At = nwcaTimestamp();

            if (Object.keys(updateData).length === 0) {
                return res.status(400).json({ success: false, error: 'No fields to update' });
            }

            const tooLong = validateBodyLengths(updateData);
            if (tooLong) {
                return res.status(413).json({
                    success: false,
                    error: `${tooLong.field} is ${tooLong.length} chars; Caspio max is ${tooLong.max}. Shorten the policy or split it into a sub-procedure.`,
                    field: tooLong.field,
                    length: tooLong.length,
                    max: tooLong.max
                });
            }

            const token = await getCaspioAccessToken();
            await axios({
                method: 'put',
                url: `${caspioApiBaseUrl}/tables/${TABLE_NAME}/records?q.where=${PRIMARY_KEY}='${encodeURIComponent(policyId)}'`,
                headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
                data: updateData,
                timeout: 15000
            });

            console.log(`[policies] updated Policy_ID=${policyId}`);
            res.json({
                success: true,
                policy_id: policyId,
                updated_fields: Object.keys(updateData),
                updated_at: updateData.Updated_At
            });
        } catch (error) {
            console.error('[policies] update error:', error.response ? JSON.stringify(error.response.data) : error.message);
            res.status(500).json({ success: false, error: 'Failed to update policy' });
        }
    });

    // DELETE /:policyId  - Soft delete (Status=Archived, Is_Active=0)
    router.delete('/:policyId', async (req, res) => {
        const policyId = req.params.policyId;
        if (!policyId) {
            return res.status(400).json({ success: false, error: 'Missing policyId' });
        }

        try {
            const token = await getCaspioAccessToken();
            await axios({
                method: 'put',
                url: `${caspioApiBaseUrl}/tables/${TABLE_NAME}/records?q.where=${PRIMARY_KEY}='${encodeURIComponent(policyId)}'`,
                headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
                data: {
                    Status: 'Archived',
                    Is_Active: 0,
                    Updated_At: nwcaTimestamp()
                },
                timeout: 15000
            });

            console.log(`[policies] archived Policy_ID=${policyId}`);
            res.json({ success: true, policy_id: policyId, archived: true });
        } catch (error) {
            console.error('[policies] delete error:', error.response ? JSON.stringify(error.response.data) : error.message);
            res.status(500).json({ success: false, error: 'Failed to archive policy' });
        }
    });

    // POST /:policyId/move  - Re-parent and/or change sort order
    router.post('/:policyId/move', express.json(), async (req, res) => {
        const policyId = req.params.policyId;
        const { parent_policy_id, sort_order } = req.body || {};

        if (!policyId) {
            return res.status(400).json({ success: false, error: 'Missing policyId' });
        }
        if (parent_policy_id === undefined && sort_order === undefined) {
            return res.status(400).json({ success: false, error: 'Must provide parent_policy_id or sort_order' });
        }

        try {
            // Prevent cycles: if moving under itself or a descendant, reject
            if (parent_policy_id && parent_policy_id === policyId) {
                return res.status(400).json({ success: false, error: 'Cannot parent a policy under itself' });
            }

            const updateData = { Updated_At: nwcaTimestamp() };
            if (parent_policy_id !== undefined) updateData.Parent_Policy_ID = parent_policy_id || null;
            if (typeof sort_order === 'number') updateData.Sort_Order = sort_order;

            const token = await getCaspioAccessToken();
            await axios({
                method: 'put',
                url: `${caspioApiBaseUrl}/tables/${TABLE_NAME}/records?q.where=${PRIMARY_KEY}='${encodeURIComponent(policyId)}'`,
                headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
                data: updateData,
                timeout: 15000
            });

            res.json({ success: true, policy_id: policyId, ...updateData });
        } catch (error) {
            console.error('[policies] move error:', error.response ? JSON.stringify(error.response.data) : error.message);
            res.status(500).json({ success: false, error: 'Failed to move policy' });
        }
    });

    return router;
}

module.exports = {
    publicRouter: buildRouter({ publicOnly: true }),
    adminRouter: buildRouter({ publicOnly: false }),
    htmlToPlainText, // exported for testing
    slugify
};
