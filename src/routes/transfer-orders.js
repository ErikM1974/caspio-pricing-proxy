// Transfer Orders Routes — CRUD for Transfer_Orders + Transfer_Order_Notes tables
// Tracks heat-transfer orders sent to Supacolor (closes the Steve → Bradley handoff gap)
//
// Mirrors pattern from mockup-routes.js.
// Record identifier is ID_Transfer (unique Text, server-generated as ST-YYMMDD-####).
//
// Endpoints:
//   GET    /api/transfer-orders            — List (with filters + pagination)
//   GET    /api/transfer-orders/stats      — Count per status (for dashboard chips)
//   GET    /api/transfer-orders/:id        — Get one (by ID_Transfer) + child notes
//   POST   /api/transfer-orders            — Create (generates ID_Transfer, writes initial note)
//   PUT    /api/transfer-orders/:id        — Update general fields (rejects Status)
//   PUT    /api/transfer-orders/:id/status — Status transition (writes note + stamps)
//   PUT    /api/transfer-orders/:id/rush   — Toggle rush flag (writes note)
//   DELETE /api/transfer-orders/:id        — Soft delete (sets Status='Cancelled')
//   GET    /api/transfer-orders/:id/notes  — Get notes for a transfer
//   POST   /api/transfer-order-notes       — Add a comment/note

const express = require('express');
const router = express.Router();
const axios = require('axios');
const { getCaspioAccessToken, fetchAllCaspioPages } = require('../utils/caspio');
const config = require('../../config');

const caspioApiBaseUrl = config.caspio.apiBaseUrl;
const TABLE = 'Transfer_Orders';
const NOTES_TABLE = 'Transfer_Order_Notes';

// Valid Status values (state machine)
// Happy path: Requested → Ordered → PO_Created → Shipped → Received
// Side paths: any non-terminal → Cancelled (terminal) or On_Hold (returns to prior state)
const VALID_STATUSES = ['Requested', 'Ordered', 'PO_Created', 'Shipped', 'Received', 'Cancelled', 'On_Hold'];
const TERMINAL_STATUSES = ['Received', 'Cancelled'];

// Fields that must NEVER be written via REST:
//  - PK_ID: Caspio internal (not exposed in this table but strip defensively)
//  - ID_Transfer: server-generated on create, immutable thereafter
//  - Requested_At: Caspio Timestamp type — auto-populates on insert, rejects writes
const READ_ONLY_FIELDS = ['PK_ID', 'ID_Transfer', 'Requested_At'];

// ── Helpers ──────────────────────────────────────────────────────────

/**
 * Generate a new ID_Transfer in format ST-YYMMDD-####.
 * Queries existing IDs for today and increments the sequence.
 */
async function generateTransferId(token) {
    const now = new Date();
    const yy = String(now.getFullYear()).slice(-2);
    const mm = String(now.getMonth() + 1).padStart(2, '0');
    const dd = String(now.getDate()).padStart(2, '0');
    const prefix = `ST-${yy}${mm}${dd}-`;

    const url = `${caspioApiBaseUrl}/tables/${TABLE}/records`;
    const resp = await axios.get(url, {
        params: {
            'q.where': `ID_Transfer LIKE '${prefix}%'`,
            'q.orderBy': 'ID_Transfer DESC',
            'q.pageSize': 1
        },
        headers: { 'Authorization': `Bearer ${token}` },
        timeout: 15000
    });

    const records = resp.data.Result || [];
    let nextSeq = 1;
    if (records.length > 0) {
        const lastId = records[0].ID_Transfer || '';
        const match = lastId.match(/-(\d{4})$/);
        if (match) nextSeq = parseInt(match[1], 10) + 1;
    }
    return `${prefix}${String(nextSeq).padStart(4, '0')}`;
}

/**
 * Escape single quotes for Caspio q.where clauses.
 */
function escapeSQL(val) {
    return String(val).replace(/'/g, "''");
}

/**
 * Write a note to Transfer_Order_Notes.
 */
async function writeNote(token, { Transfer_ID, Note_Type, Note_Text, Author_Email, Author_Name }) {
    const url = `${caspioApiBaseUrl}/tables/${NOTES_TABLE}/records`;
    const data = {
        Transfer_ID,
        Note_Type: Note_Type || 'comment',
        Note_Text: Note_Text || '',
        Author_Email: Author_Email || 'system',
        Author_Name: Author_Name || 'System'
        // Created_At is a Caspio Timestamp — auto-populates on insert
    };
    await axios.post(url, data, {
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
        timeout: 15000
    });
}

/**
 * Fetch a single Transfer_Orders record by ID_Transfer.
 */
async function fetchTransfer(token, idTransfer) {
    const safeId = escapeSQL(idTransfer);
    const url = `${caspioApiBaseUrl}/tables/${TABLE}/records?q.where=ID_Transfer='${safeId}'`;
    const resp = await axios.get(url, {
        headers: { 'Authorization': `Bearer ${token}` },
        timeout: 15000
    });
    const records = resp.data.Result || [];
    return records[0] || null;
}

// ── CRUD Endpoints ────────────────────────────────────────────────────

/**
 * GET /api/transfer-orders
 *
 * List transfers with optional filters.
 * Query params: status (CSV), companyName, designNumber, salesRep, isRush,
 *               dateFrom, dateTo, pageNumber, pageSize, orderBy
 */
router.get('/transfer-orders', async (req, res) => {
    try {
        const resource = `/tables/${TABLE}/records`;
        const params = {};
        const whereConditions = [];

        // Filter by status (CSV for multiple: "Requested,Ordered")
        if (req.query.status) {
            const statuses = req.query.status.split(',').map(s => `Status='${escapeSQL(s.trim())}'`);
            whereConditions.push(statuses.length === 1 ? statuses[0] : `(${statuses.join(' OR ')})`);
        }

        if (req.query.companyName) {
            whereConditions.push(`Company_Name LIKE '%${escapeSQL(req.query.companyName)}%'`);
        }

        if (req.query.designNumber) {
            whereConditions.push(`Design_Number='${escapeSQL(req.query.designNumber)}'`);
        }

        if (req.query.salesRep) {
            whereConditions.push(`Sales_Rep_Email='${escapeSQL(req.query.salesRep)}'`);
        }

        if (req.query.isRush === 'true' || req.query.isRush === 'Yes') {
            whereConditions.push(`Is_Rush=true`);
        } else if (req.query.isRush === 'false' || req.query.isRush === 'No') {
            whereConditions.push(`Is_Rush=false`);
        }

        // Filter by mockup (for the sales-rep visibility badge on mockup-detail)
        if (req.query.mockupId) {
            whereConditions.push(`Mockup_ID=${parseInt(req.query.mockupId, 10)}`);
        }

        if (req.query.designId) {
            whereConditions.push(`Design_ID=${parseInt(req.query.designId, 10)}`);
        }

        if (req.query.dateFrom) {
            whereConditions.push(`Requested_At>='${escapeSQL(req.query.dateFrom)}'`);
        }
        if (req.query.dateTo) {
            whereConditions.push(`Requested_At<='${escapeSQL(req.query.dateTo)}'`);
        }

        if (whereConditions.length > 0) {
            params['q.where'] = whereConditions.join(' AND ');
        }

        params['q.orderBy'] = req.query.orderBy || 'Requested_At DESC';

        if (req.query.pageNumber) params['q.pageNumber'] = parseInt(req.query.pageNumber, 10);
        params['q.pageSize'] = parseInt(req.query.pageSize, 10) || parseInt(req.query.limit, 10) || 100;

        const records = await fetchAllCaspioPages(resource, params);

        res.json({ success: true, count: records.length, records });

    } catch (error) {
        console.error('Error fetching transfer orders:', error.response ? JSON.stringify(error.response.data) : error.message);
        res.status(500).json({ success: false, error: 'Failed to fetch transfer orders: ' + error.message });
    }
});

/**
 * GET /api/transfer-orders/stats
 *
 * Count per status for the Bradley dashboard header chips.
 * Fetches all non-terminal records and counts in memory (fast + simple).
 */
router.get('/transfer-orders/stats', async (req, res) => {
    try {
        const resource = `/tables/${TABLE}/records`;
        const params = {
            'q.select': 'Status',
            'q.pageSize': 1000
        };
        // Optional: exclude terminal statuses to keep the result set small
        if (req.query.activeOnly === 'true') {
            params['q.where'] = `Status NOT IN ('${TERMINAL_STATUSES.join("','")}')`;
        }

        const records = await fetchAllCaspioPages(resource, params);
        const stats = {};
        VALID_STATUSES.forEach(s => { stats[s] = 0; });
        records.forEach(r => {
            if (stats[r.Status] !== undefined) stats[r.Status]++;
        });

        res.json({ success: true, stats, total: records.length });

    } catch (error) {
        console.error('Error fetching transfer stats:', error.response ? JSON.stringify(error.response.data) : error.message);
        res.status(500).json({ success: false, error: 'Failed to fetch stats: ' + error.message });
    }
});

/**
 * GET /api/transfer-orders/:id
 *
 * Get a single transfer by ID_Transfer. Includes child notes.
 */
router.get('/transfer-orders/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const token = await getCaspioAccessToken();

        const record = await fetchTransfer(token, id);
        if (!record) {
            return res.status(404).json({ success: false, error: 'Transfer order not found' });
        }

        // Fetch child notes in parallel-friendly shape
        const notesUrl = `${caspioApiBaseUrl}/tables/${NOTES_TABLE}/records?q.where=Transfer_ID='${escapeSQL(id)}'&q.orderBy=Created_At ASC`;
        const notesResp = await axios.get(notesUrl, {
            headers: { 'Authorization': `Bearer ${token}` },
            timeout: 15000
        });

        res.json({
            success: true,
            record,
            notes: notesResp.data.Result || []
        });

    } catch (error) {
        console.error('Error fetching transfer order:', error.response ? JSON.stringify(error.response.data) : error.message);
        res.status(500).json({ success: false, error: 'Failed to fetch transfer: ' + error.message });
    }
});

/**
 * POST /api/transfer-orders
 *
 * Create a new transfer order.
 * Server generates ID_Transfer and writes an initial status_change note.
 *
 * Body: all writable Transfer_Orders fields.
 * Required: Requested_By (who clicked the button). Design_ID or Design_Number
 *   is strongly recommended for traceability but not enforced — Bradley can
 *   create transfers for art that bypassed the Art Hub.
 */
router.post('/transfer-orders', async (req, res) => {
    try {
        const token = await getCaspioAccessToken();

        // Strip read-only fields (PK_ID, ID_Transfer, Requested_At)
        const data = { ...req.body };
        READ_ONLY_FIELDS.forEach(f => delete data[f]);

        // Validate minimally
        if (!data.Requested_By) {
            return res.status(400).json({ success: false, error: 'Missing Requested_By' });
        }

        // Normalize Is_Rush to boolean (frontend might send "true"/"Yes"/1)
        if (data.Is_Rush !== undefined) {
            data.Is_Rush = (data.Is_Rush === true || data.Is_Rush === 'true' || data.Is_Rush === 'Yes' || data.Is_Rush === 1);
        } else {
            data.Is_Rush = false;
        }

        // Default status
        data.Status = data.Status || 'Requested';
        if (!VALID_STATUSES.includes(data.Status)) {
            return res.status(400).json({ success: false, error: `Invalid status. Must be one of: ${VALID_STATUSES.join(', ')}` });
        }

        // Generate unique business ID
        const idTransfer = await generateTransferId(token);
        data.ID_Transfer = idTransfer;

        // Insert
        const url = `${caspioApiBaseUrl}/tables/${TABLE}/records`;
        await axios.post(url, data, {
            headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
            timeout: 15000
        });

        // Fetch the created record back (so we have Requested_At populated)
        const created = await fetchTransfer(token, idTransfer);

        // Write initial status_change note
        await writeNote(token, {
            Transfer_ID: idTransfer,
            Note_Type: 'status_change',
            Note_Text: `Transfer request created. Status: ${data.Status}.${data.File_Notes ? ' Notes: ' + data.File_Notes : ''}`,
            Author_Email: data.Requested_By,
            Author_Name: data.Requested_By_Name || data.Requested_By
        });

        console.log(`Transfer created: ${idTransfer} (${data.Company_Name || 'n/a'}, design ${data.Design_Number || 'n/a'}, by ${data.Requested_By})`);

        res.status(201).json({ success: true, record: created || { ID_Transfer: idTransfer, ...data } });

    } catch (error) {
        console.error('Error creating transfer order:', error.response ? JSON.stringify(error.response.data) : error.message);
        res.status(500).json({ success: false, error: 'Failed to create transfer: ' + error.message });
    }
});

/**
 * PUT /api/transfer-orders/:id
 *
 * General update. Rejects Status (must use /status endpoint).
 * Body: partial Transfer_Orders fields.
 */
router.put('/transfer-orders/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const token = await getCaspioAccessToken();

        // Strip read-only + status (status must go through /status endpoint for state machine + stamps + note)
        const data = { ...req.body };
        READ_ONLY_FIELDS.forEach(f => delete data[f]);
        if (data.Status !== undefined) {
            return res.status(400).json({
                success: false,
                error: 'Use PUT /api/transfer-orders/:id/status to change status (handles stamps and auto-notes).'
            });
        }

        // Normalize Is_Rush if present
        if (data.Is_Rush !== undefined) {
            data.Is_Rush = (data.Is_Rush === true || data.Is_Rush === 'true' || data.Is_Rush === 'Yes' || data.Is_Rush === 1);
        }

        if (Object.keys(data).length === 0) {
            return res.status(400).json({ success: false, error: 'No updatable fields provided' });
        }

        const safeId = escapeSQL(id);
        const url = `${caspioApiBaseUrl}/tables/${TABLE}/records?q.where=ID_Transfer='${safeId}'`;
        await axios.put(url, data, {
            headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
            timeout: 15000
        });

        console.log(`Transfer ${id} updated: ${Object.keys(data).join(', ')}`);
        res.json({ success: true, message: 'Transfer updated' });

    } catch (error) {
        console.error('Error updating transfer:', error.response ? JSON.stringify(error.response.data) : error.message);
        res.status(500).json({ success: false, error: 'Failed to update transfer: ' + error.message });
    }
});

/**
 * PUT /api/transfer-orders/:id/status
 *
 * Status transition. Validates the target status, sets the matching "_By"/"_At"
 * stamps, writes a status_change note to Transfer_Order_Notes.
 *
 * Body: {
 *   status,                // required; must be in VALID_STATUSES
 *   author,                // required; email of person making the change
 *   authorName?,           // display name for the note
 *   notes?,                // free-text appended to the auto-note
 *   supacolorOrderNumber?, // only honored when status='Ordered'
 *   supacolorOrderUrl?,    // only honored when status='Ordered'
 *   estimatedShipDate?,    // only honored when status='Ordered' or 'Shipped'
 *   shopworksPO?,          // only honored when status='PO_Created'
 *   trackingNumber?,       // only honored when status='Shipped'
 *   cancelReason?          // only honored when status='Cancelled'
 * }
 */
router.put('/transfer-orders/:id/status', async (req, res) => {
    try {
        const { id } = req.params;
        const { status, author, authorName, notes,
                supacolorOrderNumber, supacolorOrderUrl, estimatedShipDate,
                shopworksPO, trackingNumber, cancelReason } = req.body;

        if (!status) return res.status(400).json({ success: false, error: 'Missing status' });
        if (!VALID_STATUSES.includes(status)) {
            return res.status(400).json({ success: false, error: `Invalid status. Must be one of: ${VALID_STATUSES.join(', ')}` });
        }
        if (!author) return res.status(400).json({ success: false, error: 'Missing author (email)' });

        const token = await getCaspioAccessToken();

        // Fetch current record
        const current = await fetchTransfer(token, id);
        if (!current) return res.status(404).json({ success: false, error: 'Transfer not found' });

        // Build update payload: status + matching stamps + any extra fields for this transition
        const now = new Date().toISOString();
        const update = { Status: status };

        if (status === 'Ordered') {
            update.Sent_To_Supacolor_By = author;
            update.Sent_To_Supacolor_At = now;
            if (supacolorOrderNumber) update.Supacolor_Order_Number = supacolorOrderNumber;
            if (supacolorOrderUrl) update.Supacolor_Order_URL = supacolorOrderUrl;
            if (estimatedShipDate) update.Estimated_Ship_Date = estimatedShipDate;
        } else if (status === 'PO_Created') {
            update.PO_Created_By = author;
            update.PO_Created_At = now;
            if (shopworksPO) update.ShopWorks_PO_Number = shopworksPO;
        } else if (status === 'Shipped') {
            if (trackingNumber) update.Tracking_Number = trackingNumber;
            if (estimatedShipDate) update.Estimated_Ship_Date = estimatedShipDate;
        } else if (status === 'Received') {
            update.Received_By = author;
            update.Received_At = now;
        } else if (status === 'Cancelled') {
            update.Cancelled_By = author;
            update.Cancelled_At = now;
            if (cancelReason) update.Cancel_Reason = cancelReason;
        }

        const safeId = escapeSQL(id);
        const url = `${caspioApiBaseUrl}/tables/${TABLE}/records?q.where=ID_Transfer='${safeId}'`;
        await axios.put(url, update, {
            headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
            timeout: 15000
        });

        // Write auto-note
        const noteParts = [`Status changed: ${current.Status} → ${status}`];
        if (supacolorOrderNumber) noteParts.push(`Supacolor #${supacolorOrderNumber}`);
        if (shopworksPO) noteParts.push(`ShopWorks PO #${shopworksPO}`);
        if (trackingNumber) noteParts.push(`Tracking: ${trackingNumber}`);
        if (cancelReason) noteParts.push(`Reason: ${cancelReason}`);
        if (notes) noteParts.push(notes);

        await writeNote(token, {
            Transfer_ID: id,
            Note_Type: status === 'Cancelled' ? 'cancellation' : 'status_change',
            Note_Text: noteParts.join(' | '),
            Author_Email: author,
            Author_Name: authorName || author
        });

        console.log(`Transfer ${id} status: ${current.Status} → ${status} (by ${author})`);

        res.json({
            success: true,
            previousStatus: current.Status,
            newStatus: status,
            updatedFields: Object.keys(update)
        });

    } catch (error) {
        console.error('Error updating transfer status:', error.response ? JSON.stringify(error.response.data) : error.message);
        res.status(500).json({ success: false, error: 'Failed to update status: ' + error.message });
    }
});

/**
 * PUT /api/transfer-orders/:id/rush
 *
 * Toggle the Is_Rush flag. Writes a rush_flag note.
 * Body: { isRush (boolean), reason?, author, authorName? }
 */
router.put('/transfer-orders/:id/rush', async (req, res) => {
    try {
        const { id } = req.params;
        const { isRush, reason, author, authorName } = req.body;

        if (typeof isRush === 'undefined') {
            return res.status(400).json({ success: false, error: 'Missing isRush (boolean)' });
        }
        if (!author) return res.status(400).json({ success: false, error: 'Missing author' });

        const rushBool = (isRush === true || isRush === 'true' || isRush === 'Yes' || isRush === 1);
        const token = await getCaspioAccessToken();

        // Verify the record exists first (so we 404 cleanly instead of silent no-op PUT)
        const current = await fetchTransfer(token, id);
        if (!current) return res.status(404).json({ success: false, error: 'Transfer not found' });

        const safeId = escapeSQL(id);
        const update = { Is_Rush: rushBool };
        if (rushBool && reason) update.Rush_Reason = reason;

        const url = `${caspioApiBaseUrl}/tables/${TABLE}/records?q.where=ID_Transfer='${safeId}'`;
        await axios.put(url, update, {
            headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
            timeout: 15000
        });

        await writeNote(token, {
            Transfer_ID: id,
            Note_Type: 'rush_flag',
            Note_Text: rushBool
                ? `Marked as RUSH${reason ? '. Reason: ' + reason : ''}`
                : 'Rush flag cleared',
            Author_Email: author,
            Author_Name: authorName || author
        });

        console.log(`Transfer ${id} rush: ${rushBool} (by ${author})`);
        res.json({ success: true, isRush: rushBool });

    } catch (error) {
        console.error('Error updating rush flag:', error.response ? JSON.stringify(error.response.data) : error.message);
        res.status(500).json({ success: false, error: 'Failed to update rush flag: ' + error.message });
    }
});

/**
 * DELETE /api/transfer-orders/:id
 *
 * Soft delete: sets Status='Cancelled' and stamps Cancelled_By/_At/Cancel_Reason.
 * Hard delete only allowed via ?hard=true AND current Status='Requested'.
 *
 * Body: { author, authorName?, reason? }
 */
router.delete('/transfer-orders/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const hard = req.query.hard === 'true';
        const { author, authorName, reason } = req.body || {};

        if (!author) return res.status(400).json({ success: false, error: 'Missing author' });

        const token = await getCaspioAccessToken();
        const current = await fetchTransfer(token, id);
        if (!current) return res.status(404).json({ success: false, error: 'Transfer not found' });

        const safeId = escapeSQL(id);

        if (hard) {
            // Hard delete only allowed from Requested state
            if (current.Status !== 'Requested') {
                return res.status(400).json({
                    success: false,
                    error: `Hard delete only allowed for 'Requested' status. Current: '${current.Status}'. Use soft delete (omit ?hard=true) to cancel.`
                });
            }
            // Delete child notes first
            try {
                const notesUrl = `${caspioApiBaseUrl}/tables/${NOTES_TABLE}/records?q.where=Transfer_ID='${safeId}'`;
                await axios.delete(notesUrl, {
                    headers: { 'Authorization': `Bearer ${token}` },
                    timeout: 15000
                });
            } catch (err) {
                console.warn(`Warning: failed to delete notes for transfer ${id}:`, err.message);
            }
            // Delete the transfer itself
            await axios.delete(`${caspioApiBaseUrl}/tables/${TABLE}/records?q.where=ID_Transfer='${safeId}'`, {
                headers: { 'Authorization': `Bearer ${token}` },
                timeout: 15000
            });
            console.log(`Transfer ${id} HARD deleted by ${author}`);
            return res.json({ success: true, message: 'Transfer hard-deleted', mode: 'hard' });
        }

        // Soft delete: transition to Cancelled (reuses the same stamps + note logic)
        if (current.Status === 'Cancelled') {
            return res.status(400).json({ success: false, error: 'Transfer already cancelled' });
        }

        const now = new Date().toISOString();
        const update = {
            Status: 'Cancelled',
            Cancelled_By: author,
            Cancelled_At: now
        };
        if (reason) update.Cancel_Reason = reason;

        await axios.put(`${caspioApiBaseUrl}/tables/${TABLE}/records?q.where=ID_Transfer='${safeId}'`, update, {
            headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
            timeout: 15000
        });

        await writeNote(token, {
            Transfer_ID: id,
            Note_Type: 'cancellation',
            Note_Text: `Cancelled (was ${current.Status})${reason ? '. Reason: ' + reason : ''}`,
            Author_Email: author,
            Author_Name: authorName || author
        });

        console.log(`Transfer ${id} SOFT deleted (cancelled) by ${author}`);
        res.json({ success: true, message: 'Transfer cancelled', mode: 'soft', previousStatus: current.Status });

    } catch (error) {
        console.error('Error deleting transfer:', error.response ? JSON.stringify(error.response.data) : error.message);
        res.status(500).json({ success: false, error: 'Failed to delete transfer: ' + error.message });
    }
});

// ── Notes Endpoints ───────────────────────────────────────────────────

/**
 * GET /api/transfer-orders/:id/notes
 *
 * Get all notes for a transfer, ordered by creation date.
 */
router.get('/transfer-orders/:id/notes', async (req, res) => {
    try {
        const { id } = req.params;
        const token = await getCaspioAccessToken();
        const safeId = escapeSQL(id);
        const url = `${caspioApiBaseUrl}/tables/${NOTES_TABLE}/records?q.where=Transfer_ID='${safeId}'&q.orderBy=Created_At ASC`;

        const resp = await axios.get(url, {
            headers: { 'Authorization': `Bearer ${token}` },
            timeout: 15000
        });

        res.json({ success: true, count: (resp.data.Result || []).length, notes: resp.data.Result || [] });

    } catch (error) {
        console.error('Error fetching transfer notes:', error.response ? JSON.stringify(error.response.data) : error.message);
        res.status(500).json({ success: false, error: 'Failed to fetch notes: ' + error.message });
    }
});

/**
 * POST /api/transfer-order-notes
 *
 * Add a free-text comment to a transfer.
 * Body: { Transfer_ID, Note_Text, Author_Email, Author_Name?, Note_Type? }
 */
router.post('/transfer-order-notes', async (req, res) => {
    try {
        const { Transfer_ID, Note_Text, Author_Email, Author_Name, Note_Type } = req.body;

        if (!Transfer_ID || !Note_Text || !Author_Email) {
            return res.status(400).json({ success: false, error: 'Missing Transfer_ID, Note_Text, or Author_Email' });
        }

        const token = await getCaspioAccessToken();
        await writeNote(token, {
            Transfer_ID,
            Note_Type: Note_Type || 'comment',
            Note_Text,
            Author_Email,
            Author_Name: Author_Name || Author_Email
        });

        console.log(`Transfer note added: ${Transfer_ID} by ${Author_Email} (${Note_Type || 'comment'})`);
        res.status(201).json({ success: true });

    } catch (error) {
        console.error('Error adding transfer note:', error.response ? JSON.stringify(error.response.data) : error.message);
        res.status(500).json({ success: false, error: 'Failed to add note: ' + error.message });
    }
});

module.exports = router;
