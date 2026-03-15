// Digitizing Mockup Routes — CRUD for Ruth's Digitizing_Mockups + Digitizing_Mockup_Notes tables
// Mirrors pattern from art.js (Steve's Art Hub)
//
// Endpoints:
//   GET    /api/mockups          — List mockups (with filters)
//   GET    /api/mockups/:id      — Get single mockup
//   POST   /api/mockups          — Create new mockup
//   PUT    /api/mockups/:id      — Update mockup
//   PUT    /api/mockups/:id/status — Quick status update (with revision tracking)
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

        // Filter by company name (partial match)
        if (req.query.companyName) {
            whereConditions.push(`Company_Name LIKE '%${req.query.companyName}%'`);
        }

        // Filter by design number
        if (req.query.designNumber) {
            whereConditions.push(`Design_Number='${req.query.designNumber}'`);
        }

        // Filter by customer ID
        if (req.query.idCustomer) {
            whereConditions.push(`Id_Customer=${req.query.idCustomer}`);
        }

        // Date range filters
        if (req.query.dateFrom) {
            whereConditions.push(`Submitted_Date>='${req.query.dateFrom}'`);
        }
        if (req.query.dateTo) {
            whereConditions.push(`Submitted_Date<='${req.query.dateTo}'`);
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

        // Set defaults for new records
        const data = {
            ...req.body,
            Status: req.body.Status || 'Submitted',
            Submitted_Date: req.body.Submitted_Date || new Date().toISOString(),
            Revision_Count: 0
        };

        const resp = await axios.post(url, data, {
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json'
            },
            timeout: 15000
        });

        console.log(`Mockup created: Design ${data.Design_Number} for ${data.Company_Name}`);

        res.status(201).json({
            success: true,
            record: resp.data
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
                colors = colors.filter(c => c.Instock === true);
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
            colors = colors.filter(c => c.Instock === true);
        }

        res.json({ success: true, count: colors.length, colors });

    } catch (error) {
        console.error('Error fetching thread colors:', error.response ? JSON.stringify(error.response.data) : error.message);
        res.status(500).json({ success: false, error: 'Failed to fetch thread colors: ' + error.message });
    }
});

/**
 * GET /api/locations
 *
 * Fetches all records from the Caspio location table.
 * Query params:
 *   type — filter by Type (comma-separated, e.g. type=EMB,CAP)
 * Results cached in-memory for 1 hour.
 */
router.get('/locations', async (req, res) => {
    try {
        const now = Date.now();

        // Check cache
        if (locationsCache.data && (now - locationsCache.timestamp) < CACHE_TTL_MS) {
            console.log('Locations served from cache');
            let locations = locationsCache.data;
            if (req.query.type) {
                const types = req.query.type.split(',').map(t => t.trim());
                locations = locations.filter(l => types.includes(l.Type));
            }
            return res.json({ success: true, count: locations.length, locations });
        }

        // Fetch from Caspio
        console.log('Fetching locations from Caspio');
        const resource = `/tables/location/records`;
        const params = { 'q.orderBy': 'location_name ASC' };

        const records = await fetchAllCaspioPages(resource, params);

        // Update cache with ALL records
        locationsCache = { data: records, timestamp: Date.now() };

        let locations = records;
        if (req.query.type) {
            const types = req.query.type.split(',').map(t => t.trim());
            locations = locations.filter(l => types.includes(l.Type));
        }

        res.json({ success: true, count: locations.length, locations });

    } catch (error) {
        console.error('Error fetching locations:', error.response ? JSON.stringify(error.response.data) : error.message);
        res.status(500).json({ success: false, error: 'Failed to fetch locations: ' + error.message });
    }
});

module.exports = router;
