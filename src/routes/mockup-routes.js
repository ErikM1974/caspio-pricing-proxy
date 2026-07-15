// Digitizing Mockup Routes — CRUD for Ruth's Digitizing_Mockups + Digitizing_Mockup_Notes tables
// Mirrors pattern from art.js (Steve's Art Hub)
//
// Endpoints:
//   GET    /api/mockup-versions/:mockupId — Get version history for a mockup
//   POST   /api/mockup-versions  — Insert a new version record (auto-increments)
//   GET    /api/mockups          — List mockups (with filters; soft-deleted hidden unless ?includeDeleted=true)
//   GET    /api/mockups/:id      — Get single mockup (returns soft-deleted rows too, so detail page can show "Restore?")
//   POST   /api/mockups          — Create new mockup
//   PUT    /api/mockups/:id      — Update mockup
//   PUT    /api/mockups/:id/status — Quick status update (with revision tracking)
//   DELETE /api/mockups/:id      — Soft-delete mockup (sets Is_Deleted=true; keeps row + children for restore)
//   POST   /api/mockups/:id/restore — Undo soft-delete
//   GET    /api/mockups/orphan-scan — Detect Box folders not indexed in Caspio (admin)
//   POST   /api/mockups/orphan-digest/send — Manually trigger orphan digest email (admin)
//   GET    /api/mockups/broken-mockups — Detect Caspio rows whose Box fileIds 404 (10-min cache)
//   POST   /api/mockups/broken-mockups/send-digest — Manually trigger Ruth daily digest (admin)
//   POST   /api/mockups/:id/auto-recover-mockup — Single-slot Box folder relink
//   POST   /api/mockups/auto-recover-mockups-bulk — Bulk auto-recover (max 50 entries)
//   GET    /api/mockup-notes/:mockupId — Get notes for a mockup
//   POST   /api/mockup-notes     — Add a note to a mockup (direction-aware Slack + email + watcher fan-out; notify:false to skip)
//   GET    /api/thread-colors    — List thread colors (cached 1hr, ?instock=true)
//   GET    /api/locations        — List locations (cached 1hr, ?type=EMB,CAP)

const express = require('express');
const router = express.Router();
const axios = require('axios');
const { getCaspioAccessToken, fetchAllCaspioPages } = require('../utils/caspio');
const { getBoxAccessToken, BOX_API_BASE, resolveToProxyUrl } = require('../utils/box-client');
const { notifyMockupSubmission } = require('../utils/slack-mockup-submission-notify');
const { notifyMockupRevision } = require('../utils/slack-mockup-revision-notify');
const { notifyRushMockup } = require('../utils/slack-rush-mockup-notify');
const { notifyMockupStatusTransition } = require('../utils/slack-mockup-status-notify');
const { notifyMockupNote } = require('../utils/slack-mockup-note-notify');
const { sendArtNoteEmail } = require('../utils/send-art-note-email');
const { resolveAEEmail, resolveAEName, resolveAEEmailLoose } = require('../utils/rep-email-map');
const config = require('../../config');

const caspioApiBaseUrl = config.caspio.apiBaseUrl;
const MOCKUPS_TABLE = 'Digitizing_Mockups';
const NOTES_TABLE = 'Digitizing_Mockup_Notes';

// Mockup slot fields scanned by /api/mockups/broken-mockups. Mirrors VALID_SLOTS
// in box-upload.js + the MOCKUP_SLOT_FIELDS export from recover-broken-ruth-mockup.js.
const RUTH_MOCKUP_SLOT_FIELDS = [
    'Box_Mockup_1', 'Box_Mockup_2', 'Box_Mockup_3',
    'Box_Mockup_4', 'Box_Mockup_5', 'Box_Mockup_6',
    'Box_Reference_File'
];

// Broken-mockups scan cache (10-min TTL). Separate from Steve's cache in
// box-upload.js — different table, different scan params.
let ruthBrokenMockupsCache = { data: null, expiresAt: 0, inFlight: null };
const RUTH_BROKEN_CACHE_TTL_MS = 10 * 60 * 1000;
function invalidateRuthBrokenMockupsCache() {
    ruthBrokenMockupsCache = { data: null, expiresAt: 0, inFlight: null };
}

// URL-shape helpers — kept in sync with the matching pair in box-upload.js
// (intentional duplicate to avoid a circular require during route registration).
function isLikelyMockupUrl(u) {
    return /(?:\/api\/box\/thumbnail\/|box\.com\/(?:shared\/static\/|s\/|file\/))/i.test(u);
}
function extractFileId(u) {
    let m = u.match(/\/api\/box\/thumbnail\/(\d+)/);
    if (m) return m[1];
    m = u.match(/\/file\/(\d+)/);
    if (m) return m[1];
    return null;
}

// Box CDN HEAD-lies workaround — see box-upload.js for the full rationale.
// Box returns HTTP 404 to HEAD on `/shared/static/{token}` URLs even when
// GET returns 200 with the real file. Modern proxy URLs are HEAD-honest.
function isLegacyBoxCdnUrl(url) {
    return /\bbox\.com\/(?:shared\/static\/|s\/|file\/)/i.test(url);
}
async function checkUrlReachable(url) {
    let head;
    try {
        head = await axios.head(url, {
            timeout: 10000,
            maxRedirects: 5,
            validateStatus: () => true
        });
    } catch (err) {
        return { status: 0, method: 'head', error: err.message };
    }
    if (head.status !== 404) {
        return { status: head.status, method: 'head' };
    }
    if (!isLegacyBoxCdnUrl(url)) {
        return { status: 404, method: 'head' };
    }
    // Legacy Box CDN URL with HEAD=404 → retry GET (Range-capped to 1 KB).
    try {
        const get = await axios.get(url, {
            timeout: 15000,
            maxRedirects: 5,
            validateStatus: () => true,
            responseType: 'arraybuffer',
            headers: { 'Range': 'bytes=0-1023' }
        });
        const reachable = (get.status === 200 || get.status === 206);
        return { status: reachable ? 200 : get.status, method: 'head+get' };
    } catch (err) {
        return { status: 404, method: 'head+get', error: err.message };
    }
}

// ── In-Memory Caches (1-hour TTL) ───────────────────────────────────
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour
let threadColorsCache = { data: null, timestamp: 0 };
let locationsCache = { data: null, timestamp: 0 };

// ── In-Memory Mockup Notification Queue ──────────────────────────────
// Same pattern as art notifications (art.js)
const MOCKUP_NOTIFICATIONS = [];
const NOTIFICATION_TTL_MS = 10 * 60 * 1000; // 10 minutes
const VALID_NOTIFICATION_TYPES = ['new_submission', 'in_progress', 'awaiting_approval', 'approved', 'revision_requested', 'completed'];

function pruneNotifications() {
    const cutoff = Date.now() - NOTIFICATION_TTL_MS;
    while (MOCKUP_NOTIFICATIONS.length > 0 && MOCKUP_NOTIFICATIONS[0].timestamp < cutoff) {
        MOCKUP_NOTIFICATIONS.shift();
    }
}

const VERSIONS_TABLE = 'Digitizing_Mockup_Versions';

// ── Mockup Version History Endpoints ─────────────────────────────────

/**
 * GET /api/mockup-versions/:mockupId
 *
 * Fetch all version records for a mockup, ordered by slot + version desc.
 */
router.get('/mockup-versions/:mockupId', async (req, res) => {
    try {
        const token = await getCaspioAccessToken();
        const mockupId = req.params.mockupId;
        const response = await axios.get(
            `${caspioApiBaseUrl}/tables/${VERSIONS_TABLE}/records`,
            {
                params: {
                    'q.where': `Mockup_ID=${mockupId}`,
                    'q.orderBy': 'Slot_Key ASC, Version_Number DESC'
                },
                headers: { Authorization: `Bearer ${token}` }
            }
        );
        res.json({ success: true, versions: response.data.Result || [] });
    } catch (error) {
        console.error('Error fetching mockup versions:', error.message);
        res.status(500).json({ success: false, error: 'Failed to fetch versions' });
    }
});

/**
 * POST /api/mockup-versions
 *
 * Insert a new version record. Auto-calculates Version_Number and
 * marks previous versions for the same slot as not current.
 * Body: { Mockup_ID, Slot_Key, File_URL, File_Name, Box_File_ID, Uploaded_By }
 */
router.post('/mockup-versions', async (req, res) => {
    try {
        const token = await getCaspioAccessToken();
        const { Mockup_ID, Slot_Key, File_URL, File_Name, Box_File_ID, Uploaded_By } = req.body;

        if (!Mockup_ID || !Slot_Key || !File_URL) {
            return res.status(400).json({ success: false, error: 'Missing required fields (Mockup_ID, Slot_Key, File_URL)' });
        }

        // 1. Get current max version for this mockup+slot
        const existing = await axios.get(
            `${caspioApiBaseUrl}/tables/${VERSIONS_TABLE}/records`,
            {
                params: {
                    'q.where': `Mockup_ID=${Mockup_ID} AND Slot_Key='${Slot_Key}'`,
                    'q.orderBy': 'Version_Number DESC',
                    'q.pageSize': 1
                },
                headers: { Authorization: `Bearer ${token}` }
            }
        );
        const records = existing.data.Result || [];
        const nextVersion = records.length > 0 ? records[0].Version_Number + 1 : 1;

        // 2. Mark all existing versions for this slot as not current
        if (records.length > 0) {
            await axios.put(
                `${caspioApiBaseUrl}/tables/${VERSIONS_TABLE}/records`,
                { Is_Current: 'No' },
                {
                    params: { 'q.where': `Mockup_ID=${Mockup_ID} AND Slot_Key='${Slot_Key}'` },
                    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
                }
            );
        }

        // 3. Insert new version as current
        const newRecord = {
            Mockup_ID: parseInt(Mockup_ID),
            Slot_Key: Slot_Key,
            Version_Number: nextVersion,
            File_URL: File_URL,
            File_Name: File_Name || '',
            Box_File_ID: Box_File_ID || '',
            Uploaded_By: Uploaded_By || '',
            Uploaded_Date: new Date().toISOString(),
            Is_Current: 'Yes',
            Notes: ''
        };

        await axios.post(
            `${caspioApiBaseUrl}/tables/${VERSIONS_TABLE}/records`,
            newRecord,
            { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } }
        );

        console.log(`Mockup version ${nextVersion} created for mockup ${Mockup_ID}, slot ${Slot_Key}`);
        res.json({ success: true, version: nextVersion });
    } catch (error) {
        console.error('Error creating mockup version:', error.message);
        res.status(500).json({ success: false, error: 'Failed to create version' });
    }
});

// ── Mockup CRUD Endpoints ────────────────────────────────────────────

/**
 * GET /api/mockups
 *
 * List mockups with optional filters.
 * Query params: status, submittedBy, companyName, designNumber, idCustomer,
 *               dateFrom, dateTo, pageNumber, pageSize, orderBy
 */
router.get('/mockups', async (req, res) => {
    try {
        console.log('Fetching digitizing mockups');
        const resource = `/tables/${MOCKUPS_TABLE}/records`;
        const params = {};
        const whereConditions = [];

        // Filter by status (comma-separated for multiple: "Submitted,In Progress")
        if (req.query.status) {
            const statuses = req.query.status.split(',').map(s => `Status='${s.trim()}'`);
            if (statuses.length === 1) {
                whereConditions.push(statuses[0]);
            } else {
                whereConditions.push(`(${statuses.join(' OR ')})`);
            }
        }

        // Filter by submitter email
        if (req.query.submittedBy) {
            whereConditions.push(`Submitted_By='${req.query.submittedBy}'`);
        }

        // Filter by company name (partial match, escape apostrophes for Caspio)
        if (req.query.companyName) {
            const safeName = req.query.companyName.replace(/'/g, "''");
            whereConditions.push(`Company_Name LIKE '%${safeName}%'`);
        }

        // Filter by design number
        if (req.query.designNumber) {
            whereConditions.push(`Design_Number='${req.query.designNumber}'`);
        }

        // Filter by customer ID
        if (req.query.idCustomer) {
            whereConditions.push(`Id_Customer=${req.query.idCustomer}`);
        }

        // Filter by ShopWorks customer number
        if (req.query.shopworksCustomerId) {
            whereConditions.push(`Id_Customer=${req.query.shopworksCustomerId}`);
        }

        // Date range filters
        if (req.query.dateFrom) {
            whereConditions.push(`Submitted_Date>='${req.query.dateFrom}'`);
        }
        if (req.query.dateTo) {
            whereConditions.push(`Submitted_Date<='${req.query.dateTo}'`);
        }

        // Soft-delete filter — hide Is_Deleted=true rows unless ?includeDeleted=true.
        // Caspio Yes/No fields use 1/0 literals in q.where (NOT true/false — that
        // throws "Invalid column name 'false'" at the SQL layer).
        if (req.query.includeDeleted !== 'true') {
            whereConditions.push(`(Is_Deleted=0 OR Is_Deleted IS NULL)`);
        }

        // On-hold filter — mirrors the same pattern as the ArtRequests endpoint.
        //   ?onHold=true   → only on-hold mockups
        //   ?onHold=false  → only NOT on-hold (active)
        //   ?onHold=all or omitted → no filter (backwards-compatible default)
        if (req.query.onHold === 'true') {
            whereConditions.push(`Is_On_Hold=1`);
        } else if (req.query.onHold === 'false') {
            whereConditions.push(`(Is_On_Hold=0 OR Is_On_Hold IS NULL)`);
        }

        if (whereConditions.length > 0) {
            params['q.where'] = whereConditions.join(' AND ');
        }

        // Sorting (default: newest first)
        params['q.orderBy'] = req.query.orderBy || 'Submitted_Date DESC';

        // Pagination
        if (req.query.pageNumber) {
            params['q.pageNumber'] = parseInt(req.query.pageNumber);
        }
        if (req.query.pageSize) {
            params['q.pageSize'] = parseInt(req.query.pageSize);
        } else if (req.query.limit) {
            params['q.pageSize'] = parseInt(req.query.limit);
        } else {
            params['q.pageSize'] = 100;
        }

        const records = await fetchAllCaspioPages(resource, params);

        res.json({
            success: true,
            count: records.length,
            records
        });

    } catch (error) {
        console.error('Error fetching mockups:', error.response ? JSON.stringify(error.response.data) : error.message);
        res.status(500).json({ success: false, error: 'Failed to fetch mockups: ' + error.message });
    }
});

// ── Orphan Box-folder detection ──────────────────────────────────────
// IMPORTANT: these static-path routes MUST be declared BEFORE `/mockups/:id`.
// Express matches in order, so without this ordering `/mockups/orphan-scan`
// falls into `/mockups/:id` with id='orphan-scan' and Caspio rejects the query.

/**
 * GET /api/mockups/orphan-scan
 *
 * Run the orphan detection without sending email. Returns the same structured
 * report the cron uses. Admin-only (guarded by ORPHAN_SCAN_KEY env).
 *
 * Optional query params:
 *   includeAll=true         — disable test-data + empty-folder quality filters
 *   inspectContents=false   — skip Box file listing (faster, no mockup1Url)
 */
router.get('/mockups/orphan-scan', async (req, res) => {
    const adminKey = process.env.ORPHAN_SCAN_KEY;
    if (adminKey && req.headers['x-admin-key'] !== adminKey) {
        return res.status(401).json({ success: false, error: 'Unauthorized' });
    }
    try {
        const { detectOrphans } = require('../utils/detect-orphan-mockups');
        const report = await detectOrphans({
            applyQualityFilters: req.query.includeAll !== 'true',
            inspectFolderContents: req.query.inspectContents !== 'false'
        });
        res.json({ success: true, ...report });
    } catch (err) {
        console.error('[OrphanScan] Error:', err.message);
        res.status(500).json({ success: false, error: err.message });
    }
});

/**
 * POST /api/mockups/orphan-digest/send
 *
 * Manual trigger for the monthly orphan digest email to Erik. Useful for
 * testing or on-demand runs between cron cycles. Admin-only.
 */
router.post('/mockups/orphan-digest/send', async (req, res) => {
    const adminKey = process.env.ORPHAN_SCAN_KEY;
    if (adminKey && req.headers['x-admin-key'] !== adminKey) {
        return res.status(401).json({ success: false, error: 'Unauthorized' });
    }
    try {
        const { runOrphanDigest } = require('../utils/send-orphan-digest');
        const result = await runOrphanDigest();
        res.json({ success: true, ...result });
    } catch (err) {
        console.error('[OrphanDigest] Manual trigger error:', err.message);
        res.status(500).json({ success: false, error: err.message });
    }
});

// ── Broken-mockups detection + auto-recovery ─────────────────────────
// IMPORTANT: these static-path routes MUST be declared BEFORE `/mockups/:id`
// (see the orphan-scan comment above re: Express ordering).
//
// Sister of `/api/art-requests/broken-mockups` in box-upload.js but for
// Ruth's `Digitizing_Mockups` table, which has 7 mockup slot fields per
// row instead of 1. Same algorithm: pull recent rows, HEAD every Box
// fileId referenced, group 404s by row + slot. Powers the Broken Links
// Recovery Modal on Ruth's Digitizing Mockup Dashboard.

/**
 * GET /api/mockups/broken-mockups
 *
 * Scan active Digitizing_Mockups (default: last 90 days, non-Completed
 * statuses) and HEAD every Box fileId across all 7 mockup slot fields.
 * Returns the records whose Box files return 404. Used by Ruth's dashboard
 * widget + the daily digest cron.
 *
 * Query params:
 *   - status: CSV of statuses to scan (default: non-Completed active)
 *   - since:  ISO date, oldest Submitted_Date to include (default: 90 days)
 *   - limit:  max records to scan (default: 500, max: 1000)
 *   - refresh: 'true' to bypass the 10-min cache
 *
 * Response: { checked, uniqueFileIds, broken, cachedAt, results: [...] }
 *   results[i] = {
 *     id, designNumber, companyName, salesRep, status, submittedDate,
 *     brokenSlots: [{ field, fileId }, ...]
 *   }
 */
router.get('/mockups/broken-mockups', async (req, res) => {
    const force = req.query.refresh === 'true';
    const now = Date.now();

    if (!force && ruthBrokenMockupsCache.data && now < ruthBrokenMockupsCache.expiresAt) {
        return res.json({ ...ruthBrokenMockupsCache.data, cached: true });
    }
    if (ruthBrokenMockupsCache.inFlight) {
        try {
            const shared = await ruthBrokenMockupsCache.inFlight;
            return res.json({ ...shared, cached: true, coalesced: true });
        } catch (err) { /* fall through */ }
    }

    const scanPromise = (async () => {
        const defaultSince = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000)
            .toISOString().split('T')[0];
        const sinceDate = req.query.since || defaultSince;
        // Pass `?status=all` to scan everything — needed by Ruth's chip count
        // so it matches what's visible in the UI (which renders all statuses).
        const includeAll = String(req.query.status || '').toLowerCase() === 'all';
        const statusFilter = includeAll
            ? null
            : (req.query.status || 'Submitted,In Progress,Awaiting Approval,Revision Requested')
                .split(',').map(s => s.trim()).filter(Boolean);
        const limit = Math.min(parseInt(req.query.limit, 10) || 500, 1000);

        // 1. Pull candidates from Caspio
        const caspioToken = await getCaspioAccessToken();
        // Submitted_Date can be null on older / pre-form records (Caspio
        // imports, manual rows). Null-tolerant date filter so those rows
        // still get checked — otherwise they're invisible to the scan
        // forever (real case 2026-04-27: Nika's mockup #63 had null
        // Submitted_Date and broken Box_Reference_File but never appeared).
        let where = `(Submitted_Date>='${sinceDate}' OR Submitted_Date IS NULL)`
            + ` AND (Is_Deleted=0 OR Is_Deleted IS NULL)`;
        if (statusFilter) {
            const statusesSQL = statusFilter.map(s => `'${s.replace(/'/g, "''")}'`).join(',');
            where = `Status IN (${statusesSQL}) AND ${where}`;
        }
        // Note: Digitizing_Mockups uses `Submitted_By` (not `User_Email` like
        // ArtRequests). Steve's broken-mockups query falls back to User_Email
        // when Sales_Rep is empty; here we fall back to Submitted_By.
        const select = ['ID', 'Design_Number', 'Company_Name', 'Sales_Rep',
            'Submitted_By', 'Status', 'Submitted_Date',
            ...RUTH_MOCKUP_SLOT_FIELDS].join(',');
        const resp = await axios.get(`${caspioApiBaseUrl}/tables/${MOCKUPS_TABLE}/records`, {
            params: {
                'q.where': where,
                'q.select': select,
                'q.orderBy': 'Submitted_Date DESC',
                'q.pageSize': limit
            },
            headers: { 'Authorization': `Bearer ${caspioToken}` },
            timeout: 30000
        });
        const records = resp.data.Result || [];

        // 2. Collect every URL we should HEAD-check, regardless of format.
        // (See box-upload.js for the matching Steve-side fix and rationale —
        // legacy /shared/static/ URLs were silently skipped before, and the
        // /files/{id} HEAD method gave false-clean readings for files whose
        // metadata is accessible but whose thumbnail is not.)
        const checkList = [];           // [{record, field, url, fileId|null}]
        const seenUrls = new Set();
        for (const rec of records) {
            for (const field of RUTH_MOCKUP_SLOT_FIELDS) {
                const url = rec[field];
                if (!url || typeof url !== 'string') continue;
                if (!isLikelyMockupUrl(url)) continue;
                checkList.push({ record: rec, field, url, fileId: extractFileId(url) });
                seenUrls.add(url);
            }
        }

        // 3. Reachability-check each URL. checkUrlReachable does HEAD then
        //    retries GET on 404 for legacy Box CDN URLs (Box's CDN lies on
        //    HEAD — see box-upload.js comment). 404 here is authoritative
        //    for both modern proxy URLs AND legacy Box CDN URLs.
        const concurrency = 10;
        const brokenIdx = new Set();
        for (let i = 0; i < checkList.length; i += concurrency) {
            const batch = checkList.slice(i, i + concurrency);
            const batchResults = await Promise.allSettled(
                batch.map(item => checkUrlReachable(item.url))
            );
            batchResults.forEach((r, j) => {
                if (r.status === 'fulfilled' && r.value.status === 404) {
                    brokenIdx.add(i + j);
                }
            });
        }

        // 4. Group broken hits by record (one row may have multiple broken slots)
        const brokenById = new Map();
        for (const idx of brokenIdx) {
            const item = checkList[idx];
            const id = item.record.ID;
            if (!brokenById.has(id)) {
                brokenById.set(id, {
                    id,
                    designNumber: item.record.Design_Number || '',
                    companyName: item.record.Company_Name || '',
                    salesRep: item.record.Sales_Rep || item.record.Submitted_By || '',
                    status: item.record.Status || '',
                    submittedDate: item.record.Submitted_Date,
                    brokenSlots: []
                });
            }
            brokenById.get(id).brokenSlots.push({
                field: item.field,
                fileId: item.fileId,
                url: item.url
            });
        }

        const results = Array.from(brokenById.values())
            .sort((a, b) => new Date(b.submittedDate) - new Date(a.submittedDate));

        return {
            checked: records.length,
            uniqueFileIds: seenUrls.size,
            broken: results.length,
            cachedAt: new Date().toISOString(),
            params: { status: statusFilter || 'all', since: sinceDate, limit },
            results
        };
    })();

    ruthBrokenMockupsCache.inFlight = scanPromise;

    try {
        const data = await scanPromise;
        ruthBrokenMockupsCache = {
            data, expiresAt: Date.now() + RUTH_BROKEN_CACHE_TTL_MS, inFlight: null
        };
        console.log(`[Ruth broken-mockups] ${data.checked} records, ${data.uniqueFileIds} files, ${data.broken} broken`);
        res.json({ ...data, cached: false });
    } catch (err) {
        ruthBrokenMockupsCache.inFlight = null;
        console.error('[Ruth broken-mockups] scan failed:', err.message);
        res.status(500).json({ success: false, error: 'Scan failed: ' + err.message });
    }
});

/**
 * POST /api/mockups/broken-mockups/send-digest
 *
 * Manual trigger for the daily Ruth digest. Admin-key gated.
 */
router.post('/mockups/broken-mockups/send-digest', async (req, res) => {
    const expected = process.env.ADMIN_KEY_DIGEST;
    const provided = req.headers['x-admin-key'];
    if (!expected) {
        return res.status(500).json({
            success: false,
            error: 'ADMIN_KEY_DIGEST env var not configured on server.'
        });
    }
    if (provided !== expected) {
        return res.status(401).json({ success: false, error: 'Unauthorized' });
    }
    try {
        const { runDailyDigest } = require('../utils/send-ruth-digest');
        const result = await runDailyDigest();
        res.json({ success: true, ...result });
    } catch (err) {
        console.error('[Ruth Digest] Manual trigger failed:', err.message);
        res.status(500).json({ success: false, error: err.message });
    }
});

/**
 * POST /api/mockups/:id/auto-recover-mockup
 *
 * Single-slot auto-recovery for a broken Box mockup URL on a
 * Digitizing_Mockups row. Mirrors the Steve route at
 * /api/art-requests/:pkId/auto-recover-mockup.
 *
 * Body: { slotField, designNumber, companyName? }
 *   slotField: one of Box_Mockup_1..6 or Box_Reference_File
 *
 * Response 200: { success: true, status: 'recovered', slotField, newUrl, ... }
 * Response 404: { success: false, status: 'no-folder'|'empty-folder'|'no-match' }
 * Response 400: { success: false, error: '...' }
 */
router.post('/mockups/:id/auto-recover-mockup', async (req, res) => {
    const id = req.params.id;
    const slotField = (req.body && req.body.slotField) || '';
    const designNumber = (req.body && req.body.designNumber) || '';
    const companyName = (req.body && req.body.companyName) || '';

    if (!slotField || !RUTH_MOCKUP_SLOT_FIELDS.includes(slotField)) {
        return res.status(400).json({
            success: false,
            error: `slotField required, must be one of: ${RUTH_MOCKUP_SLOT_FIELDS.join(', ')}`
        });
    }
    if (!designNumber) {
        return res.status(400).json({ success: false, error: 'Missing designNumber in request body' });
    }

    try {
        const { recoverBrokenRuthMockup } = require('../utils/recover-broken-ruth-mockup');
        const publicUrl = (config.app && config.app.publicUrl)
            || `${req.protocol}://${req.get('host')}`;

        const result = await recoverBrokenRuthMockup({
            id,
            slotField,
            designNumber,
            companyName,
            getBoxToken: getBoxAccessToken,
            publicUrl
        });

        if (result.status === 'recovered') {
            invalidateRuthBrokenMockupsCache();
            console.log(`[Ruth auto-recover] ID=${id} ${slotField} #${designNumber} → file ${result.newFileId} (${result.confidence})`);
            return res.json({ success: true, ...result });
        }
        if (result.status === 'error') {
            console.error(`[Ruth auto-recover] ID=${id} ${slotField} error: ${result.error}`);
            return res.status(500).json({ success: false, ...result });
        }
        return res.status(404).json({ success: false, ...result });
    } catch (err) {
        console.error('[Ruth auto-recover-mockup] uncaught:', err);
        return res.status(500).json({ success: false, error: err.message || String(err) });
    }
});

/**
 * POST /api/mockups/auto-recover-mockups-bulk
 *
 * Bulk auto-recovery — used by Ruth's "Auto-recover all" button. Each entry
 * is one (id, slotField) pair (a single row may appear multiple times if
 * it has multiple broken slots).
 *
 * Body: { entries: [{ id, slotField, designNumber, companyName? }, ...] }
 *   max 50 entries per call (Box Search API rate limits favor sequential).
 *
 * Response 200: {
 *   success: true,
 *   recovered: <count>,
 *   total: <count>,
 *   results: [{ id, slotField, status, newUrl?, newFileId?, ... }, ...]
 * }
 */
router.post('/mockups/auto-recover-mockups-bulk', async (req, res) => {
    const entries = req.body && req.body.entries;
    if (!Array.isArray(entries) || entries.length === 0) {
        return res.status(400).json({ success: false, error: 'Missing or empty entries array' });
    }
    if (entries.length > 50) {
        return res.status(400).json({ success: false, error: 'Max 50 entries per call' });
    }

    try {
        const { recoverBrokenRuthMockup } = require('../utils/recover-broken-ruth-mockup');
        const publicUrl = (config.app && config.app.publicUrl)
            || `${req.protocol}://${req.get('host')}`;

        const results = [];
        let recovered = 0;
        for (const entry of entries) {
            const r = await recoverBrokenRuthMockup({
                id: entry.id,
                slotField: entry.slotField,
                designNumber: entry.designNumber || '',
                companyName: entry.companyName || '',
                getBoxToken: getBoxAccessToken,
                publicUrl
            });
            results.push({ id: entry.id, ...r });
            if (r.status === 'recovered') recovered++;
        }

        if (recovered > 0) invalidateRuthBrokenMockupsCache();
        console.log(`[Ruth auto-recover-bulk] ${recovered}/${entries.length} recovered`);

        return res.json({ success: true, recovered, total: entries.length, results });
    } catch (err) {
        console.error('[Ruth auto-recover-mockups-bulk] uncaught:', err);
        return res.status(500).json({ success: false, error: err.message || String(err) });
    }
});

/**
 * GET /api/mockups/:id
 *
 * Get a single mockup by ID.
 */
router.get('/mockups/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const token = await getCaspioAccessToken();
        const url = `${caspioApiBaseUrl}/tables/${MOCKUPS_TABLE}/records?q.where=ID=${id}`;

        const resp = await axios.get(url, {
            headers: { 'Authorization': `Bearer ${token}` },
            timeout: 15000
        });

        const records = resp.data.Result || [];
        if (records.length === 0) {
            return res.status(404).json({ success: false, error: 'Mockup not found' });
        }

        res.json({ success: true, record: records[0] });

    } catch (error) {
        console.error('Error fetching mockup:', error.response ? JSON.stringify(error.response.data) : error.message);
        res.status(500).json({ success: false, error: 'Failed to fetch mockup: ' + error.message });
    }
});

/**
 * POST /api/mockups
 *
 * Create a new mockup record.
 * Body: { Design_Number, Design_Name, Company_Name, Id_Customer, Mockup_Type,
 *         Submitted_By, AE_Notes, Garment_Info, Print_Location, Size_Specs,
 *         Due_Date, Work_Order_Number }
 */
router.post('/mockups', async (req, res) => {
    try {
        const token = await getCaspioAccessToken();
        const url = `${caspioApiBaseUrl}/tables/${MOCKUPS_TABLE}/records`;

        // Strip Caspio-managed / read-only fields before insert.
        // AlterReadOnlyData (500) from Caspio if we send these.
        // - PK_ID, ID: auto-number primary keys
        // - Rush_Requested_At: Timestamp field, auto-populated by Caspio (verified
        //   working — recent records have Rush_Requested_At populated on insert)
        // Submitted_Date is NO LONGER auto-populated (the Caspio field type was
        // changed from Timestamp → DateTime at some point), so we set it
        // explicitly below as a regular writable field. Records 55-69 inserted
        // before this fix had Submitted_Date=NULL; backfilled v2026.04.29.3.
        const READ_ONLY_FIELDS = ['PK_ID', 'ID', 'Rush_Requested_At'];
        const data = { ...req.body };
        READ_ONLY_FIELDS.forEach(f => delete data[f]);

        // Dedup guard: prevent creating a second row for the same (Design_Number, Company_Name)
        // when an active (non-deleted) row already exists. This is the primary defense against
        // the "submit twice → two Box folders" drift that produced 34 orphans before. Bypass
        // with ?allowDuplicate=true only for the backfill script or explicit admin re-imports.
        if (data.Design_Number && data.Company_Name && req.query.allowDuplicate !== 'true') {
            const safeDesign = String(data.Design_Number).replace(/'/g, "''");
            const safeCompany = String(data.Company_Name).replace(/'/g, "''");
            const dedupResp = await axios.get(`${caspioApiBaseUrl}/tables/${MOCKUPS_TABLE}/records`, {
                params: {
                    'q.where': `Design_Number='${safeDesign}' AND Company_Name='${safeCompany}' AND (Is_Deleted=0 OR Is_Deleted IS NULL)`,
                    'q.select': 'ID,Box_Folder_ID,Status'
                },
                headers: { 'Authorization': `Bearer ${token}` },
                timeout: 15000
            });
            const existing = (dedupResp.data.Result || [])[0];
            if (existing) {
                console.log(`[Dedup] Blocked duplicate mockup: Design=${data.Design_Number} Company=${data.Company_Name} → existing ID=${existing.ID}`);
                return res.status(409).json({
                    success: false,
                    error: `A mockup request for "${data.Company_Name}" with design #${data.Design_Number} already exists. Open that request instead of creating a new one.`,
                    code: 'DUPLICATE_MOCKUP',
                    existingId: existing.ID,
                    existingBoxFolderId: existing.Box_Folder_ID,
                    existingStatus: existing.Status
                });
            }
        }

        // Set defaults for new records
        data.Status = data.Status || 'Submitted';
        data.Revision_Count = 0;
        // Submitted_Date: explicitly set to current timestamp. The Caspio field
        // is a regular Date/Time field (no longer the auto-populating Timestamp
        // it once was — see READ_ONLY_FIELDS comment above). Without this,
        // records save with Submitted_Date=NULL and gallery sort buries them.
        // Format: 'YYYY-MM-DDTHH:MM:SS' (no ms, no Z) — matches what older
        // records already in the DB look like, e.g. '2026-04-15T22:40:27'.
        // Caspio strips the Z anyway (per project memory), but stripping ms
        // up front avoids any parser surprises.
        data.Submitted_Date = data.Submitted_Date
            || new Date().toISOString().replace(/\.\d{3}Z$/, '');

        // Insert record — Caspio POST returns 201 with Location header containing the new record URL
        const insertResp = await axios.post(url, data, {
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json'
            },
            timeout: 15000
        });

        // Extract the new record ID from the Location header
        // Caspio returns Location like: .../tables/Digitizing_Mockups/records?q.where=ID=123
        const locationHeader = insertResp.headers.location || '';
        console.log('Caspio POST Location header:', locationHeader);

        let createdRecord = { ID: null };

        // Try to extract ID from Location header (most reliable)
        const idMatch = locationHeader.match(/ID[=](\d+)/i);
        if (idMatch) {
            const newId = parseInt(idMatch[1]);
            console.log(`Extracted ID ${newId} from Location header`);

            // Fetch the full record by ID
            try {
                const fetchResp = await axios.get(`${caspioApiBaseUrl}/tables/${MOCKUPS_TABLE}/records?q.where=ID=${newId}`, {
                    headers: { 'Authorization': `Bearer ${token}` },
                    timeout: 15000
                });
                const records = fetchResp.data.Result || [];
                if (records.length > 0) {
                    createdRecord = records[0];
                } else {
                    createdRecord = { ID: newId };
                }
            } catch (fetchErr) {
                console.warn('Could not fetch created record, using ID from header:', fetchErr.message);
                createdRecord = { ID: newId };
            }
        } else {
            // Fallback: query by Design_Number + Company_Name, newest first
            console.warn('No ID in Location header, falling back to query. Header was:', locationHeader);
            try {
                const escapedCompany = (data.Company_Name || '').replace(/'/g, "''");
                const escapedDesign = (data.Design_Number || '').replace(/'/g, "''");
                const whereClause = `Design_Number='${escapedDesign}' AND Company_Name='${escapedCompany}'`;
                const queryUrl = `${caspioApiBaseUrl}/tables/${MOCKUPS_TABLE}/records?q.where=${encodeURIComponent(whereClause)}&q.orderBy=${encodeURIComponent('ID DESC')}&q.limit=1`;

                const queryResp = await axios.get(queryUrl, {
                    headers: { 'Authorization': `Bearer ${token}` },
                    timeout: 15000
                });
                const records = queryResp.data.Result || [];
                if (records.length > 0) {
                    createdRecord = records[0];
                }
            } catch (queryErr) {
                console.warn('Fallback query also failed:', queryErr.response ? JSON.stringify(queryErr.response.data) : queryErr.message);
            }
        }

        console.log(`Mockup created: ID ${createdRecord.ID}, Design ${data.Design_Number} for ${data.Company_Name}`);

        // Slack: notify Ruth + Erik + AEs in #mockup-notifications channel.
        // Replaces "New Mockup Submission → Slack Ruth + AE" Zap, which had
        // event_sources:["Datasheet"] and missed dashboard form submissions.
        //
        // Two notifications fire here:
        //   - notifyMockupSubmission — every new mockup
        //   - notifyRushMockup       — gated internally on Is_Rush=true
        //                              (replaces RUSH RUTH Zap which couldn't
        //                              catch REST API event_source in current
        //                              Caspio integration setup).
        //
        // Both resolve rather than throw. createdRecord has the full record
        // from the post-insert fetch above.
        try {
            notifyMockupSubmission(createdRecord);
            notifyRushMockup(createdRecord);
        } catch (notifyErr) {
            console.warn('[SLACK_MOCKUP_SUBMISSION_SKIP] notify-block error:', notifyErr.message);
        }

        res.status(201).json({
            success: true,
            record: createdRecord
        });

    } catch (error) {
        console.error('Error creating mockup:', error.response ? JSON.stringify(error.response.data) : error.message);
        res.status(500).json({ success: false, error: 'Failed to create mockup: ' + error.message });
    }
});

/**
 * PUT /api/mockups/:id
 *
 * Update a mockup record (general purpose).
 * Body: any writable fields
 */
router.put('/mockups/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const token = await getCaspioAccessToken();

        // Strip server-managed fields the client shouldn't be allowed to set.
        // Mirrors the READ_ONLY_FIELDS pattern from POST /mockups (line 688).
        // On_Hold_Since is auto-stamped server-side based on the Is_On_Hold flip
        // (see block below) — never trust a client-supplied timestamp.
        const READ_ONLY_FIELDS = ['PK_ID', 'ID', 'Rush_Requested_At', 'On_Hold_Since'];
        const data = { ...req.body };
        READ_ONLY_FIELDS.forEach(f => delete data[f]);

        // Convert any incoming Box mockup-slot URLs from legacy Box formats
        // (`box.com/shared/static/`, `box.com/s/`, `box.com/file/`) into our
        // stable proxy URL format (`/api/box/thumbnail/{fileId}`). Mirrors the
        // matching guard in box-upload.js's /upload-mockup-url. Without this,
        // Ruth's Box file picker writes legacy URLs into Box_Mockup_N fields
        // that go fragile over time. Soft-fails per field — bad URL stays as
        // submitted, good ones get upgraded.
        const origin = config.app?.publicUrl || `${req.protocol}://${req.get('host')}`;
        for (const slotField of RUTH_MOCKUP_SLOT_FIELDS) {
            if (typeof data[slotField] === 'string' && data[slotField]) {
                const upgraded = await resolveToProxyUrl(data[slotField], origin);
                if (upgraded !== data[slotField]) {
                    console.log(`[PUT /mockups/${id}] Upgraded ${slotField} legacy URL → proxy URL`);
                    data[slotField] = upgraded;
                }
            }
        }

        // ========================================================================
        // Server-managed On_Hold_Since timestamp
        // Auto-stamp when Is_On_Hold flips false→true; clear when true→false.
        // Fetches current row first so duplicate PUTs (same Is_On_Hold value)
        // don't clobber the original timestamp. Mirrors the art.js pattern.
        // ========================================================================
        if ('Is_On_Hold' in data) {
            const newOnHold = data.Is_On_Hold === true
                || data.Is_On_Hold === 1
                || data.Is_On_Hold === 'true';

            const fetchUrl = `${caspioApiBaseUrl}/tables/${MOCKUPS_TABLE}/records`
                + `?q.where=ID=${id}&q.select=Is_On_Hold,On_Hold_Since&q.limit=1`;
            const fetchResp = await axios.get(fetchUrl, {
                headers: { 'Authorization': `Bearer ${token}` },
                timeout: 15000
            });
            const current = (fetchResp.data?.Result || [])[0] || {};
            const oldOnHold = current.Is_On_Hold === true || current.Is_On_Hold === 1;

            if (newOnHold && !oldOnHold) {
                data.On_Hold_Since = new Date().toISOString();
                console.log(`  → Mockup ${id} entering hold; stamped On_Hold_Since`);
            } else if (!newOnHold && oldOnHold) {
                // Caspio v2 rejects '' for Date/Time clears — null is the only safe value.
                data.On_Hold_Since = null;
                console.log(`  → Mockup ${id} resuming from hold; cleared On_Hold_Since`);
            }
            // else: no actual flip, leave On_Hold_Since untouched
        }

        const url = `${caspioApiBaseUrl}/tables/${MOCKUPS_TABLE}/records?q.where=ID=${id}`;
        const resp = await axios.put(url, data, {
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json'
            },
            timeout: 15000
        });

        console.log(`Mockup ${id} updated:`, Object.keys(data).join(', '));

        res.json({ success: true, message: 'Mockup updated' });

    } catch (error) {
        console.error('Error updating mockup:', error.response ? JSON.stringify(error.response.data) : error.message);
        res.status(500).json({ success: false, error: 'Failed to update mockup: ' + error.message });
    }
});

/**
 * PUT /api/mockups/:id/status
 *
 * Quick status update with revision tracking.
 * Body: { status, notes? }
 *
 * Special behavior:
 *   - "Revision Requested" → increments Revision_Count
 *   - "Approved" / completed statuses → sets Completion_Date
 *   - Auto-creates a status_change note in Digitizing_Mockup_Notes
 */
router.put('/mockups/:id/status', async (req, res) => {
    try {
        const { id } = req.params;
        const { status, notes, author, authorName } = req.body;

        if (!status) {
            return res.status(400).json({ success: false, error: 'Missing status' });
        }

        const token = await getCaspioAccessToken();

        // 1. Fetch current record to get Revision_Count + fields needed for
        //    Slack notify AND the submitting-AE email fan-out (Sales_Rep /
        //    Submitted_By — see the AE-email block below).
        const getUrl = `${caspioApiBaseUrl}/tables/${MOCKUPS_TABLE}/records?q.where=ID=${id}&q.select=ID,Status,Revision_Count,Company_Name,Design_Number,Design_Name,Box_Mockup_1,Submitted_By,Sales_Rep`;
        const getResp = await axios.get(getUrl, {
            headers: { 'Authorization': `Bearer ${token}` },
            timeout: 15000
        });

        const records = getResp.data.Result || [];
        if (records.length === 0) {
            return res.status(404).json({ success: false, error: 'Mockup not found' });
        }

        const current = records[0];
        const updateData = { Status: status };

        // Transitions on which we email the submitting AE (per Erik 2026-07-15).
        // Defined here so both the flag-stamp (below) and the email fan-out
        // (after the PUT) share one source of truth. NOT 'Approved' — the AE is
        // the actor there; Ruth is notified separately.
        const AE_EMAIL_STATUS = {
            'In Progress':        { noteType: 'In Progress',        noteText: 'Ruth has started your digitizing mockup.' },
            'Awaiting Approval':  { noteType: 'Ready for Review',    noteText: 'Your mockup is ready to review and approve.' },
            'Completed':          { noteType: 'Completed',          noteText: 'Mockup completed — ready for production.' },
            'Revision Requested': { noteType: 'Revision Requested', noteText: 'A revision was requested on this mockup.' }
        };

        // Increment revision count for revision requests (AE action only)
        if (status === 'Revision Requested') {
            updateData.Revision_Count = (current.Revision_Count || 0) + 1;
        }

        // Set completion date for approved/completed
        if (status === 'Approved') {
            updateData.Completion_Date = new Date().toISOString();
        }

        // Track when approval was sent to AE
        if (status === 'Awaiting Approval') {
            updateData.Approval_Sent_Date = new Date().toISOString();
        }

        // Mark this transition as backend-notified (written atomically with the
        // status). The Caspio scheduled-Task backstop emails only rows where
        // Last_Notified_Status <> Status, so stamping here means the Task fires
        // ONLY for changes that bypassed this chokepoint (e.g. a raw Caspio
        // datasheet edit, or a proxy/Heroku outage) — no double-emailing.
        if (AE_EMAIL_STATUS[status]) {
            updateData.Last_Notified_Status = status;
            updateData.Notified_At = new Date().toISOString();
        }

        // 2. Update the mockup status
        const putUrl = `${caspioApiBaseUrl}/tables/${MOCKUPS_TABLE}/records?q.where=ID=${id}`;
        await axios.put(putUrl, updateData, {
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json'
            },
            timeout: 15000
        });

        console.log(`Mockup ${id} status: ${current.Status} → ${status}${updateData.Revision_Count ? ` (rev ${updateData.Revision_Count})` : ''}`);

        // 3. Auto-create a status_change note
        const noteData = {
            Mockup_ID: parseInt(id),
            Author: author || 'system',
            Author_Name: authorName || 'System',
            Note_Text: notes || `Status changed to ${status}`,
            Created_Date: new Date().toISOString(),
            Note_Type: status === 'Revision Requested' ? 'revision_request' : 'status_change'
        };

        const noteUrl = `${caspioApiBaseUrl}/tables/${NOTES_TABLE}/records`;
        await axios.post(noteUrl, noteData, {
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json'
            },
            timeout: 15000
        });

        // Slack: notify Ruth + Erik + AEs in #mockup-notifications when an AE
        // requests a revision. Replaces "Mockup Revision → Slack Ruth" Zap,
        // which had event_sources:["Datasheet"] and missed dashboard-driven
        // revision requests. Fire-and-forget (resolves rather than throws).
        if (status === 'Revision Requested') {
            try {
                notifyMockupRevision({
                    ID: parseInt(id, 10),
                    Company_Name: current.Company_Name || '',
                    Design_Number: current.Design_Number || '',
                    Revision_Count: updateData.Revision_Count ?? current.Revision_Count,
                    Box_Mockup_1: current.Box_Mockup_1 || ''
                });
            } catch (notifyErr) {
                console.warn('[SLACK_MOCKUP_REVISION_SKIP] notify-block error:', notifyErr.message);
            }
        }

        // Status-transition notifies (Awaiting Approval / Approved / Completed).
        // The notify util silently skips any other status, so the call site is
        // self-documenting via the explicit status check.
        if (status === 'Awaiting Approval' || status === 'Approved' || status === 'Completed') {
            try {
                notifyMockupStatusTransition({
                    ID: parseInt(id, 10),
                    Company_Name: current.Company_Name || '',
                    Design_Number: current.Design_Number || '',
                    Design_Name: current.Design_Name || '',
                    Actor: authorName || ''
                }, status);
            } catch (notifyErr) {
                console.warn('[SLACK_MOCKUP_STATUS_SKIP] notify-block error:', notifyErr.message);
            }
        }

        // Email the submitting AE on every Ruth-driven status change, so they
        // NEVER miss it regardless of which screen Ruth used (dashboard quick
        // action or the mockup detail page). This backend chokepoint is the
        // single reliable AE-notification path: the front-end EmailJS sends
        // are screen-dependent (the dashboard "Send for Approval" sent nothing;
        // "Start Working" was broken by a Mockup_ID-vs-ID lookup) and can route
        // to a placeholder inbox.
        //
        // Recipient resolves Sales_Rep FIRST, then Submitted_By — and via
        // resolveAEEmailLoose for BOTH, because real data shows Sales_Rep holds
        // FULL names ("Taneisha Clark") that the bare-first-name REP_EMAIL_MAP
        // misses, and recent rows carry the "ae@" placeholder in Submitted_By
        // while Sales_Rep still names the real AE. Loose maps "Taneisha Clark"
        // -> taneisha@. resolveAEEmailLoose enforces the @nwcustomapparel.com
        // guard (no customer leak); an unresolvable row logs a VISIBLE warning
        // instead of a silent black-hole send. sendArtNoteEmail RESOLVES-NEVER-
        // THROWS + logs [ART_NOTE_EMAIL_*], so a mail failure never blocks the
        // status write.
        if (AE_EMAIL_STATUS[status]) {
            const aeEmail = resolveAEEmailLoose(current.Sales_Rep) || resolveAEEmailLoose(current.Submitted_By);
            if (aeEmail) {
                const meta = AE_EMAIL_STATUS[status];
                // noteText is just the clean status message — the email header
                // already shows "Design #<design_id> — <company_name>", so we
                // don't repeat the company/design in the body callout.
                sendArtNoteEmail({
                    toEmail: aeEmail,
                    toName: resolveAEName(current.Sales_Rep || current.Submitted_By),
                    fromName: 'Ruth (Digitizing)',
                    idDesign: current.Design_Number || id,
                    company: current.Company_Name || '',
                    noteType: meta.noteType,
                    noteText: meta.noteText,
                    recipientIsRep: true,
                    detailPath: '/mockup/',
                    linkId: id
                }).then(function (r) {
                    if (!r || !r.sent) {
                        console.warn('[MOCKUP_AE_EMAIL_SKIP] mockup=' + id + ' status=' + status,
                            (r && (r.skipped || r.error)) || 'unknown');
                    }
                });
            } else {
                // Visible failure (Erik's #1 rule) — nobody was emailed because
                // neither Sales_Rep nor Submitted_By resolved to an internal
                // address. Surfaces in proxy logs for cleanup of the row.
                console.warn('[MOCKUP_AE_EMAIL_NO_RECIPIENT] mockup=' + id + ' status=' + status
                    + ' Sales_Rep=' + (current.Sales_Rep || '') + ' Submitted_By=' + (current.Submitted_By || ''));
            }
        }

        res.json({
            success: true,
            previousStatus: current.Status,
            newStatus: status,
            revisionCount: updateData.Revision_Count ?? current.Revision_Count
        });

    } catch (error) {
        console.error('Error updating mockup status:', error.response ? JSON.stringify(error.response.data) : error.message);
        res.status(500).json({ success: false, error: 'Failed to update status: ' + error.message });
    }
});

// ── Soft-Delete Mockup ───────────────────────────────────────────────

/**
 * DELETE /api/mockups/:id
 *
 * Soft-delete a mockup. Sets Is_Deleted=true, Deleted_At=now, Deleted_By=<body.deletedBy>.
 * Row + child notes/versions/EMB design files are all preserved so restore is lossless.
 *
 * Guard: only Submitted / In Progress / Revision Requested statuses unless ?force=true.
 * Idempotent: if already deleted, returns success without rewriting timestamps.
 */
router.delete('/mockups/:id', async (req, res) => {
    const { id } = req.params;
    const force = req.query.force === 'true';
    const deletedBy = (req.body && req.body.deletedBy) || 'unknown';

    if (!id) {
        return res.status(400).json({ success: false, error: 'Missing required parameter: id' });
    }

    try {
        const token = await getCaspioAccessToken();

        // 1. Fetch the mockup to check status (uses ID — consistent with every other verb in this file)
        const getUrl = `${caspioApiBaseUrl}/tables/${MOCKUPS_TABLE}/records?q.where=ID=${id}`;
        const mockupResp = await axios.get(getUrl, {
            headers: { 'Authorization': `Bearer ${token}` },
            timeout: 15000
        });
        const records = mockupResp.data.Result || [];
        if (records.length === 0) {
            return res.status(404).json({ success: false, error: 'Mockup not found' });
        }

        const mockup = records[0];

        // Idempotency: already soft-deleted → just confirm
        if (mockup.Is_Deleted === true) {
            return res.json({
                success: true,
                message: 'Mockup was already deleted',
                deletedAt: mockup.Deleted_At,
                deletedBy: mockup.Deleted_By
            });
        }

        const status = (mockup.Status || '').toLowerCase().replace(/\s+/g, '');
        const allowedStatuses = ['submitted', 'inprogress', 'revisionrequested'];

        if (!force && !allowedStatuses.includes(status)) {
            return res.status(400).json({
                success: false,
                error: `Cannot delete mockup in "${mockup.Status}" status. Only Submitted, In Progress, or Revision Requested mockups can be deleted.`
            });
        }

        // 2. Soft-delete via PUT (children untouched — preserved for restore)
        const deletedAt = new Date().toISOString();
        const putUrl = `${caspioApiBaseUrl}/tables/${MOCKUPS_TABLE}/records?q.where=ID=${id}`;
        await axios.put(putUrl, {
            Is_Deleted: true,
            Deleted_At: deletedAt,
            Deleted_By: String(deletedBy).substring(0, 255)
        }, {
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json'
            },
            timeout: 15000
        });

        console.log(`Mockup ${id} soft-deleted by ${deletedBy} (${mockup.Company_Name} #${mockup.Design_Number}, was ${mockup.Status})`);
        res.json({
            success: true,
            message: 'Mockup soft-deleted successfully',
            deletedAt,
            deletedBy
        });

    } catch (error) {
        console.error('Error soft-deleting mockup:', error.response ? JSON.stringify(error.response.data) : error.message);
        res.status(500).json({ success: false, error: 'Failed to delete mockup: ' + error.message });
    }
});

/**
 * POST /api/mockups/:id/restore
 *
 * Undo a soft-delete. Flips Is_Deleted=false and clears Deleted_At / Deleted_By.
 * No-op if the mockup is not currently soft-deleted.
 */
router.post('/mockups/:id/restore', async (req, res) => {
    const { id } = req.params;

    if (!id) {
        return res.status(400).json({ success: false, error: 'Missing required parameter: id' });
    }

    try {
        const token = await getCaspioAccessToken();

        const getUrl = `${caspioApiBaseUrl}/tables/${MOCKUPS_TABLE}/records?q.where=ID=${id}`;
        const mockupResp = await axios.get(getUrl, {
            headers: { 'Authorization': `Bearer ${token}` },
            timeout: 15000
        });
        const records = mockupResp.data.Result || [];
        if (records.length === 0) {
            return res.status(404).json({ success: false, error: 'Mockup not found' });
        }

        const mockup = records[0];
        if (mockup.Is_Deleted !== true) {
            return res.json({
                success: true,
                message: 'Mockup was not deleted; nothing to restore',
                alreadyLive: true
            });
        }

        const putUrl = `${caspioApiBaseUrl}/tables/${MOCKUPS_TABLE}/records?q.where=ID=${id}`;
        await axios.put(putUrl, {
            Is_Deleted: false,
            Deleted_At: null,
            Deleted_By: null
        }, {
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json'
            },
            timeout: 15000
        });

        console.log(`Mockup ${id} restored (was deleted by ${mockup.Deleted_By} on ${mockup.Deleted_At})`);
        res.json({ success: true, message: 'Mockup restored successfully' });

    } catch (error) {
        console.error('Error restoring mockup:', error.response ? JSON.stringify(error.response.data) : error.message);
        res.status(500).json({ success: false, error: 'Failed to restore mockup: ' + error.message });
    }
});

// ── Mockup Notes Endpoints ───────────────────────────────────────────

/**
 * GET /api/mockup-notes/:mockupId
 *
 * Get all notes for a mockup, ordered by creation date.
 */
router.get('/mockup-notes/:mockupId', async (req, res) => {
    try {
        const { mockupId } = req.params;
        const token = await getCaspioAccessToken();
        const url = `${caspioApiBaseUrl}/tables/${NOTES_TABLE}/records?q.where=Mockup_ID=${mockupId}&q.orderBy=Created_Date ASC`;

        const resp = await axios.get(url, {
            headers: { 'Authorization': `Bearer ${token}` },
            timeout: 15000
        });

        const records = resp.data.Result || [];

        res.json({
            success: true,
            count: records.length,
            notes: records
        });

    } catch (error) {
        console.error('Error fetching mockup notes:', error.response ? JSON.stringify(error.response.data) : error.message);
        res.status(500).json({ success: false, error: 'Failed to fetch notes: ' + error.message });
    }
});

/**
 * POST /api/mockup-notes
 *
 * Add a note to a mockup.
 * Body: { Mockup_ID, Author, Author_Name, Note_Text, Note_Type }
 * Note_Type: "ae_instruction" | "artist_note" | "status_change" | "revision_request"
 */
router.post('/mockup-notes', async (req, res) => {
    try {
        const { Mockup_ID, Author, Author_Name, Note_Text, Note_Type } = req.body;

        if (!Mockup_ID || !Note_Text) {
            return res.status(400).json({ success: false, error: 'Missing Mockup_ID or Note_Text' });
        }

        // Notification controls (optional — do NOT persist to Caspio):
        //   Posted_By_Role  'ae' | 'artist'  — explicit direction (overrides heuristic)
        //   Posted_By_Email                  — the poster's own email (excluded from watchers)
        //   notify          default true     — only `notify === false` skips fan-out
        // Audit/system note POSTs (status changes, reminders, file-adds) pass
        // notify:false so only the human note composer fans out.
        const Posted_By_Role = req.body.Posted_By_Role;
        const Posted_By_Email = req.body.Posted_By_Email;
        const notify = req.body.notify;

        const token = await getCaspioAccessToken();
        const url = `${caspioApiBaseUrl}/tables/${NOTES_TABLE}/records`;

        const resolvedNoteType = Note_Type || 'artist_note';
        const data = {
            Mockup_ID: parseInt(Mockup_ID),
            Author: Author || 'unknown',
            Author_Name: Author_Name || 'Unknown',
            Note_Text,
            Created_Date: new Date().toISOString(),
            Note_Type: resolvedNoteType
        };

        const resp = await axios.post(url, data, {
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json'
            },
            timeout: 15000
        });

        console.log(`Mockup note added: Mockup ${Mockup_ID} by ${Author_Name} (${resolvedNoteType})`);

        // ── Direction-aware fan-out (Slack + email + watchers) ────────────
        // Twin of fireNoteNotifications() on POST /api/design-notes. Fire-and-
        // forget, wrapped so it can NEVER reject the response — a note must
        // always save even if every notifier fails.
        const NOTE_TYPE_LABELS = {
            ae_instruction: 'AE Instruction',
            artist_note: 'Digitizing Note',
            status_change: 'Status Change',
            revision_request: 'Revision Request',
            customer_approval_sent: 'Customer Approval Sent'
        };
        const humanNoteType = NOTE_TYPE_LABELS[resolvedNoteType]
            || String(resolvedNoteType).replace(/_/g, ' ');
        const noteBy = data.Author_Name && data.Author_Name !== 'Unknown'
            ? data.Author_Name
            : (data.Author && data.Author !== 'unknown' ? data.Author : '');

        const fireNoteNotifications = async () => {
            try {
                // (a) Opt-out — only an explicit `notify === false` skips.
                if (notify === false) {
                    console.log('[MOCKUP_NOTE_NOTIFY_SKIP] notify=false mockup=' + Mockup_ID);
                    return;
                }

                // (b) Look up the mockup for routing context. NEVER select a
                // non-existent column — a bad q.select 500s. Tolerate empty.
                let mockupRow = null;
                try {
                    const lookupWhere = `ID=${parseInt(Mockup_ID)}`;
                    const lookupUrl = `${caspioApiBaseUrl}/tables/${MOCKUPS_TABLE}/records`
                        + `?q.where=${encodeURIComponent(lookupWhere)}`
                        + `&q.select=${encodeURIComponent('Sales_Rep,Submitted_By,Company_Name,Design_Number')}`
                        + `&q.limit=1`;
                    const lookupResp = await axios({
                        method: 'get',
                        url: lookupUrl,
                        headers: { 'Authorization': `Bearer ${token}` },
                        timeout: 8000
                    });
                    mockupRow = (lookupResp.data && lookupResp.data.Result && lookupResp.data.Result[0]) || null;
                } catch (lookupErr) {
                    console.warn('[MOCKUP_NOTE_NOTIFY_LOOKUP_FAIL]', Mockup_ID, lookupErr.message);
                }

                // Mockups use Submitted_By where ArtRequests uses User_Email.
                const repRaw = (mockupRow && (mockupRow.Sales_Rep || mockupRow.Submitted_By)) || '';
                const company = (mockupRow && mockupRow.Company_Name) || '';
                const designNum = (mockupRow && mockupRow.Design_Number) || '';

                // (c) Direction — explicit role wins; else Note_Type; else a
                // heuristic on the author (Ruth is the only artist here).
                let direction;
                if (Posted_By_Role === 'ae' || Posted_By_Role === 'artist') {
                    direction = Posted_By_Role;
                } else if (resolvedNoteType === 'ae_instruction') {
                    direction = 'ae';
                } else if (resolvedNoteType === 'artist_note') {
                    direction = 'artist';
                } else {
                    const byLower = String(noteBy).toLowerCase();
                    const artistMarkers = ['ruth', 'digitiz', 'art dept', 'art department'];
                    direction = artistMarkers.some(function (m) { return byLower.indexOf(m) !== -1; })
                        ? 'artist'
                        : 'ae';
                }

                // (d) Primary recipient.
                //   ae     → Ruth (digitizing).
                //   artist → the rep of record (may be null → skip primary email,
                //            still Slack + watchers).
                let primary;
                if (direction === 'ae') {
                    primary = { email: 'ruth@nwcustomapparel.com', name: 'Ruth', isRep: false };
                } else {
                    primary = {
                        email: resolveAEEmail(repRaw),
                        name: resolveAEName(repRaw),
                        isRep: true
                    };
                }
                const primaryEmailLower = primary.email ? String(primary.email).toLowerCase() : '';

                // (e) Watchers — everyone who has posted a note on this mockup,
                // resolved to an internal email, minus the primary recipient and
                // minus the current poster. Lets a stand-in covering an absent
                // rep receive the reply with NO Caspio schema change. Author can
                // be a full name OR an email; Author_Name is a first name — try
                // both. NEVER select a non-existent column.
                const posterEmails = new Set();
                if (Posted_By_Email) posterEmails.add(String(Posted_By_Email).toLowerCase());
                const selfResolved = resolveAEEmailLoose(data.Author_Name) || resolveAEEmailLoose(data.Author);
                if (selfResolved) posterEmails.add(String(selfResolved).toLowerCase());

                let watcherEmails = [];
                try {
                    const watcherWhere = `Mockup_ID=${parseInt(Mockup_ID)}`;
                    const watcherUrl = `${caspioApiBaseUrl}/tables/${NOTES_TABLE}/records`
                        + `?q.where=${encodeURIComponent(watcherWhere)}`
                        + `&q.select=${encodeURIComponent('Author,Author_Name')}`;
                    const watcherResp = await axios({
                        method: 'get',
                        url: watcherUrl,
                        headers: { 'Authorization': `Bearer ${token}` },
                        timeout: 8000
                    });
                    const watcherRows = (watcherResp.data && watcherResp.data.Result) || [];
                    const seen = new Set();
                    watcherRows.forEach(function (row) {
                        const resolved = resolveAEEmailLoose(row && row.Author)
                            || resolveAEEmailLoose(row && row.Author_Name);
                        if (!resolved) return;
                        const lower = String(resolved).toLowerCase();
                        if (lower === primaryEmailLower) return;     // primary already covered
                        if (posterEmails.has(lower)) return;          // don't notify the poster
                        if (seen.has(lower)) return;                  // dedupe
                        seen.add(lower);
                        watcherEmails.push(resolved);
                    });
                } catch (watcherErr) {
                    console.warn('[MOCKUP_NOTE_NOTIFY_WATCHER_FAIL]', Mockup_ID, watcherErr.message);
                }

                // (f) Fan out — every call resolves-never-throws. Caspio doesn't
                // echo a new note id, so dedup on a stable content key: collapses
                // a genuine double-submit (same mockup + type + text within the
                // 5-min window) WITHOUT merging distinct back-and-forth notes.
                const slackDedupId = String(Mockup_ID) + '|' + String(resolvedNoteType)
                    + '|' + String(Note_Text || '').slice(0, 80);
                notifyMockupNote({
                    mockupId: Mockup_ID,
                    noteId: slackDedupId,
                    noteType: humanNoteType,
                    noteText: Note_Text,
                    noteBy: noteBy || 'someone',
                    direction: direction,
                    company: company,
                    designNum: designNum
                });

                // Primary email — for an artist note the recipient is the rep
                // (?view=ae link); from_name shows who actually wrote it. The
                // shared template_art_note_added is reused via detailPath; the
                // link uses the mockup ID, the displayed design_id uses the
                // human-facing Design_Number.
                if (primary.email) {
                    sendArtNoteEmail({
                        toEmail: primary.email,
                        toName: primary.name,
                        fromName: noteBy || (direction === 'ae' ? 'NWCA Digitizing' : 'Ruth (Digitizing)'),
                        idDesign: designNum || Mockup_ID,
                        linkId: Mockup_ID,
                        detailPath: '/mockup/',
                        company: company,
                        noteType: humanNoteType,
                        noteText: Note_Text,
                        recipientIsRep: direction === 'artist'
                    });
                } else {
                    console.log('[MOCKUP_NOTE_NOTIFY] no primary email (direction=' + direction
                        + ', rep=' + JSON.stringify(repRaw) + ') — Slack + watchers only');
                }

                // Watcher emails — always reps viewing the AE page.
                watcherEmails.forEach(function (watcherEmail) {
                    sendArtNoteEmail({
                        toEmail: watcherEmail,
                        toName: resolveAEName(watcherEmail),
                        fromName: noteBy || 'NWCA Digitizing',
                        idDesign: designNum || Mockup_ID,
                        linkId: Mockup_ID,
                        detailPath: '/mockup/',
                        company: company,
                        noteType: humanNoteType,
                        noteText: Note_Text,
                        recipientIsRep: true
                    });
                });

                console.log('[MOCKUP_NOTE_NOTIFY_OK] mockup=' + Mockup_ID
                    + ' direction=' + direction
                    + ' primary=' + (primary.email || 'none')
                    + ' watchers=' + watcherEmails.length);
            } catch (notifyErr) {
                // (g) Last-resort guard — never throw out of fire-and-forget.
                console.error('[MOCKUP_NOTE_NOTIFY_ERR]', Mockup_ID,
                    (notifyErr && notifyErr.message) || notifyErr);
            }
        };

        // Fire without awaiting; swallow any rejection so it can't bubble.
        Promise.resolve().then(fireNoteNotifications).catch(function (e) {
            console.error('[MOCKUP_NOTE_NOTIFY_ERR]', Mockup_ID, (e && e.message) || e);
        });

        res.status(201).json({
            success: true,
            note: resp.data
        });

    } catch (error) {
        console.error('Error creating mockup note:', error.response ? JSON.stringify(error.response.data) : error.message);
        res.status(500).json({ success: false, error: 'Failed to create note: ' + error.message });
    }
});

// ── Mockup Notifications (Dashboard Toasts) ──────────────────────────

/**
 * POST /api/mockup-notifications
 *
 * Queue a toast notification for Ruth's dashboard.
 * Body: { type, mockupId, designNumber, companyName, message, forUser }
 */
router.post('/mockup-notifications', async (req, res) => {
    const { type, mockupId, designNumber, companyName, message, forUser } = req.body;

    if (!type || !VALID_NOTIFICATION_TYPES.includes(type)) {
        return res.status(400).json({
            success: false,
            error: `Invalid type. Must be one of: ${VALID_NOTIFICATION_TYPES.join(', ')}`
        });
    }

    pruneNotifications();
    MOCKUP_NOTIFICATIONS.push({
        type,
        mockupId,
        designNumber,
        companyName,
        message: message || `Mockup ${type.replace('_', ' ')}`,
        forUser: forUser || null,
        timestamp: Date.now()
    });

    res.json({ success: true });
});

/**
 * GET /api/mockup-notifications?since={timestamp}&user={email}
 *
 * Poll for recent notifications.
 */
router.get('/mockup-notifications', (req, res) => {
    pruneNotifications();
    const since = parseInt(req.query.since) || 0;
    const user = req.query.user;

    const notifications = MOCKUP_NOTIFICATIONS.filter(n => {
        if (n.timestamp <= since) return false;
        if (user && n.forUser && n.forUser !== user) return false;
        return true;
    });

    res.json({ success: true, notifications });
});

// ── Thread Colors & Locations Endpoints ──────────────────────────────

/**
 * GET /api/thread-colors
 *
 * Fetches all records from the Caspio ThreadColors table.
 * Query params:
 *   instock=true — filter to only Instock=Yes records (default: show all)
 * Results cached in-memory for 1 hour.
 */
router.get('/thread-colors', async (req, res) => {
    try {
        const now = Date.now();
        const useInstock = req.query.instock === 'true';

        // Check cache
        if (threadColorsCache.data && (now - threadColorsCache.timestamp) < CACHE_TTL_MS) {
            console.log('Thread colors served from cache');
            let colors = threadColorsCache.data;
            if (useInstock) {
                colors = colors.filter(c => c.Instock === true || c.Instock === 'Yes' || c.Instock === 'True' || c.Instock === 1);
            }
            return res.json({ success: true, count: colors.length, colors });
        }

        // Fetch from Caspio
        console.log('Fetching thread colors from Caspio');
        const resource = `/tables/ThreadColors/records`;
        const params = { 'q.orderBy': 'Thread_Color ASC' };

        const records = await fetchAllCaspioPages(resource, params);

        // Update cache with ALL records
        threadColorsCache = { data: records, timestamp: Date.now() };

        let colors = records;
        if (useInstock) {
            colors = colors.filter(c => c.Instock === true || c.Instock === 'Yes' || c.Instock === 'True' || c.Instock === 1);
        }

        res.json({ success: true, count: colors.length, colors });

    } catch (error) {
        console.error('Error fetching thread colors:', error.response ? JSON.stringify(error.response.data) : error.message);
        res.status(500).json({ success: false, error: 'Failed to fetch thread colors: ' + error.message });
    }
});

// NOTE: /api/locations endpoint is handled by misc.js (supports comma-separated ?type=EMB,CAP)

module.exports = router;
// Exposed so box-webhooks.js can bust Ruth's broken-mockups cache after recovering a file.
module.exports.invalidateRuthBrokenMockupsCache = invalidateRuthBrokenMockupsCache;
