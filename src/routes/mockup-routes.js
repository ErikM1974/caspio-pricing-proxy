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
//   GET    /api/mockup-notes/:mockupId — Get notes for a mockup
//   POST   /api/mockup-notes     — Add a note to a mockup
//   GET    /api/thread-colors    — List thread colors (cached 1hr, ?instock=true)
//   GET    /api/locations        — List locations (cached 1hr, ?type=EMB,CAP)

const express = require('express');
const router = express.Router();
const axios = require('axios');
const { getCaspioAccessToken, fetchAllCaspioPages } = require('../utils/caspio');
const config = require('../../config');

const caspioApiBaseUrl = config.caspio.apiBaseUrl;
const MOCKUPS_TABLE = 'Digitizing_Mockups';
const NOTES_TABLE = 'Digitizing_Mockup_Notes';

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

        // Soft-delete filter — hide Is_Deleted=true rows unless ?includeDeleted=true
        if (req.query.includeDeleted !== 'true') {
            whereConditions.push(`(Is_Deleted=false OR Is_Deleted IS NULL)`);
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
        // - Submitted_Date: Caspio Timestamp type auto-populates on insert
        // - Rush_Requested_At: same — Timestamp field, read-only via REST API
        //   (front-end stops sending this in mockup-submit-form.js but strip defensively too)
        const READ_ONLY_FIELDS = ['PK_ID', 'ID', 'Submitted_Date', 'Rush_Requested_At'];
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
                    'q.where': `Design_Number='${safeDesign}' AND Company_Name='${safeCompany}' AND (Is_Deleted=false OR Is_Deleted IS NULL)`,
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
        // Submitted_Date intentionally NOT set — Caspio auto-populates Timestamp fields
        // on insert. Leaving this to Caspio avoids the AlterReadOnlyData error.

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
        const url = `${caspioApiBaseUrl}/tables/${MOCKUPS_TABLE}/records?q.where=ID=${id}`;

        const resp = await axios.put(url, req.body, {
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json'
            },
            timeout: 15000
        });

        console.log(`Mockup ${id} updated:`, Object.keys(req.body).join(', '));

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

        // 1. Fetch current record to get Revision_Count
        const getUrl = `${caspioApiBaseUrl}/tables/${MOCKUPS_TABLE}/records?q.where=ID=${id}&q.select=ID,Status,Revision_Count`;
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

        const token = await getCaspioAccessToken();
        const url = `${caspioApiBaseUrl}/tables/${NOTES_TABLE}/records`;

        const data = {
            Mockup_ID: parseInt(Mockup_ID),
            Author: Author || 'unknown',
            Author_Name: Author_Name || 'Unknown',
            Note_Text,
            Created_Date: new Date().toISOString(),
            Note_Type: Note_Type || 'artist_note'
        };

        const resp = await axios.post(url, data, {
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json'
            },
            timeout: 15000
        });

        console.log(`Mockup note added: Mockup ${Mockup_ID} by ${Author_Name} (${Note_Type})`);

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

// ── Orphan Box-folder detection ──────────────────────────────────────

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
