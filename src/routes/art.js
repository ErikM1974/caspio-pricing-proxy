// Art-related endpoints (artrequests, art-invoices, and design-notes)
const express = require('express');
const router = express.Router();
const axios = require('axios');
const { getCaspioAccessToken, makeCaspioRequest, fetchAllCaspioPages } = require('../utils/caspio');
const { notifyArtRequestSubmission } = require('../utils/slack-art-request-submission-notify');
const { notifyArtRequestRevision } = require('../utils/slack-art-revision-notify');
const { notifyArtRequestReopen } = require('../utils/slack-art-reopen-notify');
const { notifyRushArtRequest } = require('../utils/slack-rush-art-notify');
const { notifyArtStatusTransition } = require('../utils/slack-art-status-notify');
const { notifyArtReminder } = require('../utils/slack-art-reminder-notify');
const { notifyArtNote } = require('../utils/slack-art-note-notify');
const { sendArtNoteEmail } = require('../utils/send-art-note-email');
const { resolveAEEmail, resolveAEName, resolveAEEmailLoose } = require('../utils/rep-email-map');
const config = require('../../config');

const caspioApiBaseUrl = config.caspio.apiBaseUrl;

// ── In-Memory Art Notification Queue (dashboard toasts) ──────────────
// Ephemeral notifications for real-time dashboard updates.
// Used by: Steve's dashboard (art-hub-steve.js) AND AE dashboard (ae-dashboard.js).
// Single Heroku dyno = shared memory. Dyno restart clears queue (email backup exists).
const ART_NOTIFICATIONS = [];
const NOTIFICATION_TTL_MS = 10 * 60 * 1000; // 10 minutes
const VALID_NOTIFICATION_TYPES = ['approved', 'revision', 'new_submission', 'mockup_sent', 'status_changed', 'completed'];

function pruneNotifications() {
    const cutoff = Date.now() - NOTIFICATION_TTL_MS;
    while (ART_NOTIFICATIONS.length > 0 && ART_NOTIFICATIONS[0].timestamp < cutoff) {
        ART_NOTIFICATIONS.shift();
    }
}

// --- Art Requests Endpoints ---

// Get all art requests or filter by query parameters
router.get('/artrequests', async (req, res) => {
    try {
        console.log("Fetching art requests information");
        const resource = '/tables/ArtRequests/records';
        
        // Build query parameters based on request query
        const params = {};
        
        // Handle filter parameters from the request
        if (Object.keys(req.query).length > 0) {
            const whereConditions = [];
            
            // Handle common filter fields based on the ArtRequests table structure
            if (req.query.pk_id) {
                whereConditions.push(`PK_ID=${req.query.pk_id}`);
            }
            if (req.query.status) {
                whereConditions.push(`Status='${req.query.status}'`);
            }
            if (req.query.id_design) {
                whereConditions.push(`ID_Design=${req.query.id_design}`);
            }
            if (req.query.companyName) {
                whereConditions.push(`CompanyName LIKE '%${req.query.companyName}%'`);
            }
            if (req.query.customerServiceRep) {
                whereConditions.push(`CustomerServiceRep='${req.query.customerServiceRep}'`);
            }
            if (req.query.priority) {
                whereConditions.push(`Priority='${req.query.priority}'`);
            }
            if (req.query.mockup) {
                whereConditions.push(`Mockup=${req.query.mockup}`);
            }
            if (req.query.orderType) {
                whereConditions.push(`Order_Type='${req.query.orderType}'`);
            }
            if (req.query.customerType) {
                whereConditions.push(`CustomerType='${req.query.customerType}'`);
            }
            if (req.query.happyStatus) {
                whereConditions.push(`Happy_Status='${req.query.happyStatus}'`);
            }
            if (req.query.salesRep) {
                whereConditions.push(`Sales_Rep='${req.query.salesRep}'`);
            }
            if (req.query.id_customer) {
                whereConditions.push(`id_customer=${req.query.id_customer}`);
            }
            // Filter by ShopWorks customer number (for customer portal)
            if (req.query.shopworksCustomerId) {
                whereConditions.push(`Shopwork_customer_number='${req.query.shopworksCustomerId}'`);
            }
            // Filter by company name (for customer portal)
            if (req.query.companyName) {
                whereConditions.push(`CompanyName='${req.query.companyName.replace(/'/g, "''")}'`);
            }
            if (req.query.id_contact) {
                whereConditions.push(`id_contact=${req.query.id_contact}`);
            }
            
            // Date range filters
            if (req.query.dateCreatedFrom) {
                whereConditions.push(`Date_Created>='${req.query.dateCreatedFrom}'`);
            }
            if (req.query.dateCreatedTo) {
                whereConditions.push(`Date_Created<='${req.query.dateCreatedTo}'`);
            }
            if (req.query.dueDateFrom) {
                whereConditions.push(`Due_Date>='${req.query.dueDateFrom}'`);
            }
            if (req.query.dueDateTo) {
                whereConditions.push(`Due_Date<='${req.query.dueDateTo}'`);
            }

            // On-hold flag filter:
            //   ?onHold=true   → only on-hold designs (Is_On_Hold=1)
            //   ?onHold=false  → only NOT on-hold (Is_On_Hold=0 OR NULL)
            //   ?onHold=all or omitted → no filter (current behavior — both)
            // Mirrors the Is_Deleted soft-state filter pattern in mockup-routes.js.
            if (req.query.onHold === 'true') {
                whereConditions.push(`Is_On_Hold=1`);
            } else if (req.query.onHold === 'false') {
                whereConditions.push(`(Is_On_Hold=0 OR Is_On_Hold IS NULL)`);
            }

            // Saved-mockup library: only requests that have a rep reference mockup
            // attached by the Shirt Designer (Rep_Mockup populated).
            if (req.query.repMockup === 'true') {
                whereConditions.push(`(Rep_Mockup IS NOT NULL AND Rep_Mockup<>'')`);
            }

            // Add the WHERE clause if we have conditions
            if (whereConditions.length > 0) {
                params['q.where'] = whereConditions.join(' AND ');
            }
        }
        
        // Handle select parameter for specific fields
        if (req.query.select) {
            params['q.select'] = req.query.select;
        }
        
        // Handle orderBy parameter
        if (req.query.orderBy) {
            params['q.orderBy'] = req.query.orderBy;
        } else {
            // Default ordering by most recent first
            params['q.orderBy'] = 'Date_Created DESC';
        }
        
        // Handle groupBy parameter
        if (req.query.groupBy) {
            params['q.groupBy'] = req.query.groupBy;
        }
        
        // Handle pagination parameters
        if (req.query.pageNumber && req.query.pageSize) {
            params['q.pageNumber'] = req.query.pageNumber;
            params['q.pageSize'] = req.query.pageSize;
        } else if (req.query.limit) {
            params['q.limit'] = Math.min(parseInt(req.query.limit) || 100, 1000);
        } else {
            params['q.limit'] = 100; // Default limit
        }
        
        console.log(`Fetching art requests with params: ${JSON.stringify(params)}`);
        const artRequests = await fetchAllCaspioPages(resource, params);
        
        console.log(`Found ${artRequests.length} art request records`);
        res.json(artRequests);
    } catch (error) {
        console.error("Error in /api/artrequests:", error);
        res.status(500).json({ error: 'Failed to fetch art requests' });
    }
});

// Get a specific art request by ID
router.get('/artrequests/:id', async (req, res) => {
    const { id } = req.params;
    if (!id) {
        return res.status(400).json({ error: 'Missing required parameter: id' });
    }
    
    try {
        console.log(`Fetching art request with ID: ${id}`);
        const resource = `/tables/ArtRequests/records?q.where=PK_ID=${id}`;
        
        const result = await makeCaspioRequest('get', resource);
        
        if (result && result.length > 0) {
            res.json(result[0]);
        } else {
            res.status(404).json({ error: 'Art request not found.' });
        }
    } catch (error) {
        console.error("Error fetching art request:", error.message);
        res.status(500).json({ error: 'Failed to fetch art request.' });
    }
});

// Create a new art request
router.post('/artrequests', express.json(), async (req, res) => {
    try {
        const requestData = req.body;

        console.log(`Creating new art request`);
        const resource = '/tables/ArtRequests/records';

        // Get token for the request
        const token = await getCaspioAccessToken();
        const url = `${caspioApiBaseUrl}${resource}`;

        // Prepare the request
        const requestConfig = {
            method: 'post',
            url: url,
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json'
            },
            data: requestData,
            timeout: 15000
        };

        // Make the request directly using axios
        const response = await axios(requestConfig);

        console.log(`Art request created successfully: ${response.status}`);

        // Caspio POST returns 201 with no body, so we have to do a follow-up
        // SELECT to surface the auto-generated PK_ID + ID_Design. The fetched
        // record drives two things:
        //   - The response shape returned to the AE form (so the success
        //     page can show "Design #52895" + a clickable "View Request" link)
        //   - The Slack notification (fire-and-forget below)
        //
        // Lookup chain — try the most specific filter first and fall back as
        // identifying fields drop off:
        //   1. Design_Num_SW + CompanyName     (legacy Garment DataPage flow)
        //   2. CompanyName + User_Email        (new Sticker/Banner/JDS forms —
        //                                       narrows to one AE's submission)
        //   3. CompanyName alone               (last-resort fallback)
        // All ordered by PK_ID DESC LIMIT 1 so we get the just-inserted row.
        const safe = (v) => String(v).replace(/'/g, "''");
        let fetchWhere = null;
        if (requestData.Design_Num_SW && requestData.CompanyName) {
            fetchWhere = `Design_Num_SW='${safe(requestData.Design_Num_SW)}' AND CompanyName='${safe(requestData.CompanyName)}'`;
        } else if (requestData.CompanyName && requestData.User_Email) {
            fetchWhere = `CompanyName='${safe(requestData.CompanyName)}' AND User_Email='${safe(requestData.User_Email)}'`;
        } else if (requestData.CompanyName) {
            fetchWhere = `CompanyName='${safe(requestData.CompanyName)}'`;
        }

        let createdRecord = null;
        if (fetchWhere) {
            try {
                const fetchUrl = `${caspioApiBaseUrl}/tables/ArtRequests/records?q.where=${encodeURIComponent(fetchWhere)}&q.orderBy=PK_ID DESC&q.limit=1`;
                const fetchResp = await axios({
                    method: 'get',
                    url: fetchUrl,
                    headers: { 'Authorization': `Bearer ${token}` },
                    timeout: 8000
                });
                createdRecord = (fetchResp.data && fetchResp.data.Result && fetchResp.data.Result[0]) || null;
            } catch (fetchErr) {
                // Don't fail the response — the record IS created in Caspio,
                // we just can't return its ID. The AE will see a generic
                // success message without the design number / link.
                console.warn('[POST_ARTREQUEST] post-create fetch failed:', fetchErr.message);
            }
        }

        // Slack notifications — fire-and-forget so the response doesn't wait.
        //   - notifyArtRequestSubmission  — every new art request
        //   - notifyRushArtRequest        — gated internally on Is_Rush=true
        //                                   (replaces RUSH STEVE Zap which couldn't
        //                                   catch REST API event_source in current
        //                                   Caspio integration setup).
        if (createdRecord) {
            notifyArtRequestSubmission(createdRecord);
            notifyRushArtRequest(createdRecord);
        } else {
            console.warn('[SLACK_ART_SUBMISSION_SKIP] no createdRecord — fetchWhere=' + (fetchWhere || 'none'));
        }

        res.status(201).json({
            message: 'Art request created successfully',
            record: createdRecord,
            // legacy field — Caspio POST returns empty body so this is null/undefined.
            // Kept for backward compat with any caller still reading `.request`.
            request: response.data
        });
    } catch (error) {
        console.error("Error creating art request:", error.response ? JSON.stringify(error.response.data) : error.message);
        res.status(500).json({ error: 'Failed to create art request.' });
    }
});

// Update an art request by ID
router.put('/artrequests/:id', express.json(), async (req, res) => {
    const { id } = req.params;
    if (!id) {
        return res.status(400).json({ error: 'Missing required parameter: id' });
    }
    
    try {
        console.log(`Updating art request with ID: ${id}`);
        const resource = `/tables/ArtRequests/records?q.where=PK_ID=${id}`;
        
        // Get token for the request
        const token = await getCaspioAccessToken();
        const url = `${caspioApiBaseUrl}${resource}`;
        
        // Prepare the request
        const requestConfig = {
            method: 'put',
            url: url,
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json'
            },
            data: req.body,
            timeout: 15000
        };
        
        // Make the request directly using axios
        const response = await axios(requestConfig);
        
        console.log(`Art request updated successfully: ${response.status}`);
        res.json({
            message: 'Art request updated successfully',
            request: response.data
        });
    } catch (error) {
        console.error("Error updating art request:", error.response ? JSON.stringify(error.response.data) : error.message);
        res.status(500).json({ error: 'Failed to update art request.' });
    }
});

// Delete an art request by ID
router.delete('/artrequests/:id', async (req, res) => {
    const { id } = req.params;
    if (!id) {
        return res.status(400).json({ error: 'Missing required parameter: id' });
    }
    
    try {
        console.log(`Deleting art request with ID: ${id}`);
        const resource = `/tables/ArtRequests/records?q.where=PK_ID=${id}`;
        
        // Get token for the request
        const token = await getCaspioAccessToken();
        const url = `${caspioApiBaseUrl}${resource}`;
        
        // Prepare the request
        const requestConfig = {
            method: 'delete',
            url: url,
            headers: {
                'Authorization': `Bearer ${token}`
            },
            timeout: 15000
        };
        
        // Make the request directly using axios
        const response = await axios(requestConfig);
        
        console.log(`Art request deleted successfully: ${response.status}`);
        res.json({
            message: 'Art request deleted successfully'
        });
    } catch (error) {
        console.error("Error deleting art request:", error.response ? JSON.stringify(error.response.data) : error.message);
        res.status(500).json({ error: 'Failed to delete art request.' });
    }
});

// --- Art Invoices Endpoints ---

// Get all art invoices or filter by query parameters
router.get('/art-invoices', async (req, res) => {
    try {
        console.log("Fetching art invoices information");
        const resource = '/tables/Art_Invoices/records';
        
        // Build query parameters based on request query
        const params = {};
        
        // Add any filter parameters from the request
        if (Object.keys(req.query).length > 0) {
            const whereConditions = [];
            
            // Handle common filter fields
            if (req.query.invoiceID) {
                whereConditions.push(`InvoiceID='${req.query.invoiceID}'`);
            }
            if (req.query.artRequestID) {
                whereConditions.push(`ArtRequestID='${req.query.artRequestID}'`);
            }
            if (req.query.sessionID) {
                whereConditions.push(`SessionID='${req.query.sessionID}'`);
            }
            if (req.query.status) {
                whereConditions.push(`Status='${req.query.status}'`);
            }
            if (req.query.artistName) {
                whereConditions.push(`ArtistName LIKE '%${req.query.artistName}%'`);
            }
            if (req.query.customerName) {
                whereConditions.push(`CustomerName LIKE '%${req.query.customerName}%'`);
            }
            if (req.query.customerCompany) {
                whereConditions.push(`CustomerCompany LIKE '%${req.query.customerCompany}%'`);
            }
            if (req.query.projectName) {
                whereConditions.push(`ProjectName LIKE '%${req.query.projectName}%'`);
            }
            if (req.query.isDeleted) {
                whereConditions.push(`IsDeleted=${req.query.isDeleted}`);
            }
            
            // Add the WHERE clause if we have conditions
            if (whereConditions.length > 0) {
                params['q.where'] = whereConditions.join(' AND ');
            }
        }
        
        // Set ordering and limit
        params['q.orderby'] = 'PK_ID DESC';
        params['q.limit'] = 1000;
        
        // Use fetchAllCaspioPages to handle pagination
        const result = await fetchAllCaspioPages(resource, params);
        console.log(`Found ${result.length} art invoice records`);
        
        res.json(result);
    } catch (error) {
        console.error("Error fetching art invoices:", error.message);
        res.status(500).json({ error: 'Failed to fetch art invoices.' });
    }
});

// Get a specific art invoice by ID
router.get('/art-invoices/:id', async (req, res) => {
    const { id } = req.params;
    if (!id) {
        return res.status(400).json({ error: 'Missing required parameter: id' });
    }
    
    try {
        console.log(`Fetching art invoice with ID: ${id}`);
        const resource = `/tables/Art_Invoices/records?q.where=PK_ID=${id}`;
        
        const result = await makeCaspioRequest('get', resource);
        
        if (result && result.length > 0) {
            res.json(result[0]);
        } else {
            res.status(404).json({ error: 'Art invoice not found.' });
        }
    } catch (error) {
        console.error("Error fetching art invoice:", error.message);
        res.status(500).json({ error: 'Failed to fetch art invoice.' });
    }
});

// Create a new art invoice
router.post('/art-invoices', express.json(), async (req, res) => {
    try {
        const invoiceData = req.body;
        
        // Validate required fields
        const requiredFields = ['InvoiceID', 'ArtRequestID'];
        for (const field of requiredFields) {
            if (!invoiceData[field]) {
                return res.status(400).json({ error: `Missing required field: ${field}` });
            }
        }
        
        console.log(`Creating new art invoice: ${invoiceData.InvoiceID}`);
        const resource = '/tables/Art_Invoices/records';
        
        // Get token for the request
        const token = await getCaspioAccessToken();
        const url = `${caspioApiBaseUrl}${resource}`;
        
        // Prepare the request
        const requestConfig = {
            method: 'post',
            url: url,
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json'
            },
            data: invoiceData,
            timeout: 15000
        };
        
        // Make the request directly using axios
        const response = await axios(requestConfig);
        
        console.log(`Art invoice created successfully: ${response.status}`);
        res.status(201).json({
            message: 'Art invoice created successfully',
            invoice: response.data
        });
    } catch (error) {
        console.error("Error creating art invoice:", error.response ? JSON.stringify(error.response.data) : error.message);
        res.status(500).json({ error: 'Failed to create art invoice.' });
    }
});

// Update an art invoice by ID
router.put('/art-invoices/:id', express.json(), async (req, res) => {
    const { id } = req.params;
    if (!id) {
        return res.status(400).json({ error: 'Missing required parameter: id' });
    }
    
    try {
        console.log(`Updating art invoice with ID: ${id}`);
        const resource = `/tables/Art_Invoices/records?q.where=PK_ID=${id}`;
        
        // Get token for the request
        const token = await getCaspioAccessToken();
        const url = `${caspioApiBaseUrl}${resource}`;
        
        // Prepare the request
        const requestConfig = {
            method: 'put',
            url: url,
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json'
            },
            data: req.body,
            timeout: 15000
        };
        
        // Make the request directly using axios
        const response = await axios(requestConfig);
        
        console.log(`Art invoice updated successfully: ${response.status}`);
        res.json({
            message: 'Art invoice updated successfully',
            invoice: response.data
        });
    } catch (error) {
        console.error("Error updating art invoice:", error.response ? JSON.stringify(error.response.data) : error.message);
        res.status(500).json({ error: 'Failed to update art invoice.' });
    }
});

// Delete an art invoice by ID
router.delete('/art-invoices/:id', async (req, res) => {
    const { id } = req.params;
    if (!id) {
        return res.status(400).json({ error: 'Missing required parameter: id' });
    }
    
    try {
        console.log(`Deleting art invoice with ID: ${id}`);
        const resource = `/tables/Art_Invoices/records?q.where=PK_ID=${id}`;
        
        // Get token for the request
        const token = await getCaspioAccessToken();
        const url = `${caspioApiBaseUrl}${resource}`;
        
        // Prepare the request
        const requestConfig = {
            method: 'delete',
            url: url,
            headers: {
                'Authorization': `Bearer ${token}`
            },
            timeout: 15000
        };
        
        // Make the request directly using axios
        const response = await axios(requestConfig);
        
        console.log(`Art invoice deleted successfully: ${response.status}`);
        res.json({
            message: 'Art invoice deleted successfully'
        });
    } catch (error) {
        console.error("Error deleting art invoice:", error.response ? JSON.stringify(error.response.data) : error.message);
        res.status(500).json({ error: 'Failed to delete art invoice.' });
    }
});

// --- Design Notes Endpoints ---

// GET /api/design-notes - List all design notes with filtering
router.get('/design-notes', async (req, res) => {
    try {
        const params = {};
        const whereConditions = [];
        
        // Build dynamic filters
        if (req.query.id_design) {
            whereConditions.push(`ID_Design=${req.query.id_design}`);
        }
        
        if (req.query.note_type) {
            whereConditions.push(`Note_Type='${req.query.note_type}'`);
        }
        
        if (req.query.note_by) {
            whereConditions.push(`Note_By LIKE '%${req.query.note_by}%'`);
        }
        
        if (req.query.parent_note_id) {
            whereConditions.push(`Parent_Note_ID=${req.query.parent_note_id}`);
        }
        
        // Date range filtering
        if (req.query.date_from) {
            whereConditions.push(`Note_Date >= '${req.query.date_from}'`);
        }
        
        if (req.query.date_to) {
            whereConditions.push(`Note_Date <= '${req.query.date_to}'`);
        }
        
        // Apply where clause if conditions exist
        if (whereConditions.length > 0) {
            params['q.where'] = whereConditions.join(' AND ');
        }
        
        // Sorting and pagination
        params['q.orderBy'] = req.query.orderBy || 'Note_Date DESC';
        params['q.limit'] = req.query.limit || 100;
        
        console.log('Fetching design notes with params:', params);
        
        const records = await fetchAllCaspioPages('/tables/DesignNotes/records', params);
        
        console.log(`Found ${records.length} design notes`);
        res.json(records);
        
    } catch (error) {
        console.error('Error fetching design notes:', error.message);
        res.status(500).json({ error: 'Failed to fetch design notes' });
    }
});

// GET /api/design-notes/:id - Get single design note by Note_ID
router.get('/design-notes/:id', async (req, res) => {
    const { id } = req.params;
    
    if (!id) {
        return res.status(400).json({ error: 'Note ID is required' });
    }
    
    try {
        const params = {
            'q.where': `Note_ID=${id}`,
            'q.limit': 1
        };
        
        console.log(`Fetching design note with ID: ${id}`);
        
        const records = await fetchAllCaspioPages('/tables/DesignNotes/records', params);
        
        if (records.length === 0) {
            return res.status(404).json({ error: 'Design note not found' });
        }
        
        res.json(records[0]);
        
    } catch (error) {
        console.error('Error fetching design note:', error.message);
        res.status(500).json({ error: 'Failed to fetch design note' });
    }
});

// POST /api/design-notes - Create new design note
router.post('/design-notes', express.json(), async (req, res) => {
    try {
        // Validate required fields
        const { ID_Design, Note_Type, Note_Text } = req.body;

        if (!ID_Design || !Note_Type || !Note_Text) {
            return res.status(400).json({
                error: 'Missing required fields: ID_Design, Note_Type, and Note_Text are required'
            });
        }

        // Validate field lengths
        if (Note_Type.length > 255) {
            return res.status(400).json({ error: 'Note_Type must be 255 characters or less' });
        }

        if (Note_Text.length > 64000) {
            return res.status(400).json({ error: 'Note_Text must be 64000 characters or less' });
        }

        // Notification controls (optional — do NOT persist to Caspio):
        //   Posted_By_Role  'ae' | 'artist'  — explicit direction (overrides heuristic)
        //   Posted_By_Email                  — the poster's own email (excluded from watchers)
        //   notify          default true     — only `notify === false` skips fan-out
        const Posted_By_Role = req.body.Posted_By_Role;
        const Posted_By_Email = req.body.Posted_By_Email;
        const notify = req.body.notify;

        // Build request body (Note_ID and Note_Date are auto-generated)
        const noteData = {
            ID_Design: parseInt(ID_Design),
            Note_Type,
            Note_Text
        };

        // Add optional fields if provided
        if (req.body.Note_By) {
            noteData.Note_By = req.body.Note_By;
        }

        if (req.body.Parent_Note_ID) {
            noteData.Parent_Note_ID = parseInt(req.body.Parent_Note_ID);
        }

        console.log('Creating new design note:', noteData);

        const token = await getCaspioAccessToken();
        const url = `${caspioApiBaseUrl}/tables/DesignNotes/records`;

        const response = await axios({
            method: 'post',
            url: url,
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json'
            },
            data: noteData,
            timeout: 15000
        });

        console.log('Design note created successfully');

        // Caspio POST to DesignNotes returns an empty body, so we usually don't
        // have the new Note_ID. Best-effort: read it if Caspio echoed a row.
        // Falsy → null, which just disables Slack dedup (acceptable per spec).
        let createdNoteId = null;
        const created = response.data && (response.data.Result ? response.data.Result[0] : response.data);
        if (created && created.Note_ID != null) {
            createdNoteId = created.Note_ID;
        }

        // ── Direction-aware fan-out (Slack + email + watchers) ────────────
        // Fire-and-forget, exactly like notifyArtRequestSubmission on the
        // create-artrequest route. Wrapped so it can NEVER reject the response
        // — a note must always save even if every notifier fails.
        const fireNoteNotifications = async () => {
            try {
                // (a) Opt-out — only an explicit `notify === false` skips.
                if (notify === false) {
                    console.log('[ART_NOTE_NOTIFY_SKIP] notify=false design=' + ID_Design);
                    return;
                }

                // (b) Look up the request for routing context. NEVER select a
                // Watchers column — a bad q.select 500s. Tolerate empty result.
                let reqRow = null;
                try {
                    const lookupWhere = `ID_Design=${parseInt(ID_Design)}`;
                    const lookupUrl = `${caspioApiBaseUrl}/tables/ArtRequests/records`
                        + `?q.where=${encodeURIComponent(lookupWhere)}`
                        + `&q.select=${encodeURIComponent('Sales_Rep,User_Email,CompanyName,Design_Num_SW,Item_Type')}`
                        + `&q.limit=1`;
                    const lookupResp = await axios({
                        method: 'get',
                        url: lookupUrl,
                        headers: { 'Authorization': `Bearer ${token}` },
                        timeout: 8000
                    });
                    reqRow = (lookupResp.data && lookupResp.data.Result && lookupResp.data.Result[0]) || null;
                } catch (lookupErr) {
                    console.warn('[ART_NOTE_NOTIFY_LOOKUP_FAIL]', ID_Design, lookupErr.message);
                }

                const salesRepRaw = (reqRow && (reqRow.Sales_Rep || reqRow.User_Email)) || '';
                const company = (reqRow && reqRow.CompanyName) || '';
                const designNum = (reqRow && reqRow.Design_Num_SW) || '';
                const noteBy = noteData.Note_By || '';

                // (c) Direction — explicit role wins; else heuristic on Note_By.
                let direction;
                if (Posted_By_Role === 'ae' || Posted_By_Role === 'artist') {
                    direction = Posted_By_Role;
                } else {
                    const noteByLower = String(noteBy).toLowerCase();
                    const artistMarkers = ['steve', 'ruth', 'art804', 'art dept', 'art department'];
                    direction = artistMarkers.some(function (m) { return noteByLower.indexOf(m) !== -1; })
                        ? 'artist'
                        : 'ae';
                }

                // (d) Primary recipient.
                //   ae     → Steve (art dept).
                //   artist → the rep of record (may be null → skip primary email,
                //            still Slack + watchers).
                let primary;
                if (direction === 'ae') {
                    primary = { email: 'art@nwcustomapparel.com', name: 'Steve', isRep: false };
                } else {
                    primary = {
                        email: resolveAEEmail(salesRepRaw),
                        name: resolveAEName(salesRepRaw),
                        isRep: true
                    };
                }
                const primaryEmailLower = primary.email ? String(primary.email).toLowerCase() : '';

                // (e) Watchers — everyone who has posted a note on this design,
                // resolved to an internal email, minus the primary recipient and
                // minus the current poster. This is what lets a stand-in (e.g.
                // "Erik Mickelson" covering Taneisha) receive the reply with NO
                // Caspio schema change. NEVER select a Watchers column.
                const posterEmails = new Set();
                if (Posted_By_Email) posterEmails.add(String(Posted_By_Email).toLowerCase());
                const selfResolved = resolveAEEmailLoose(noteBy);
                if (selfResolved) posterEmails.add(String(selfResolved).toLowerCase());

                let watcherEmails = [];
                try {
                    const watcherWhere = `ID_Design=${parseInt(ID_Design)}`;
                    const watcherUrl = `${caspioApiBaseUrl}/tables/DesignNotes/records`
                        + `?q.where=${encodeURIComponent(watcherWhere)}`
                        + `&q.select=${encodeURIComponent('Note_By')}`;
                    const watcherResp = await axios({
                        method: 'get',
                        url: watcherUrl,
                        headers: { 'Authorization': `Bearer ${token}` },
                        timeout: 8000
                    });
                    const watcherRows = (watcherResp.data && watcherResp.data.Result) || [];
                    const seen = new Set();
                    watcherRows.forEach(function (row) {
                        const resolved = resolveAEEmailLoose(row && row.Note_By);
                        if (!resolved) return;
                        const lower = String(resolved).toLowerCase();
                        if (lower === primaryEmailLower) return;     // primary already covered
                        if (posterEmails.has(lower)) return;          // don't notify the poster
                        if (seen.has(lower)) return;                  // dedupe
                        seen.add(lower);
                        watcherEmails.push(resolved);
                    });
                } catch (watcherErr) {
                    console.warn('[ART_NOTE_NOTIFY_WATCHER_FAIL]', ID_Design, watcherErr.message);
                }

                // (f) Fan out — every call resolves-never-throws.
                // Caspio doesn't echo the new Note_ID, so dedup on a stable
                // content key instead of leaving dedup off: this collapses a
                // genuine double-submit (same design + type + text within the
                // 5-min window) WITHOUT merging distinct back-and-forth notes.
                const slackDedupId = createdNoteId != null
                    ? createdNoteId
                    : (String(ID_Design) + '|' + String(Note_Type || '') + '|' + String(Note_Text || '').slice(0, 80));
                notifyArtNote({
                    idDesign: ID_Design,
                    noteId: slackDedupId,
                    noteType: Note_Type,
                    noteText: Note_Text,
                    noteBy: noteBy,
                    direction: direction,
                    company: company,
                    designNum: designNum
                });

                // Primary email — for an artist note the recipient is the rep
                // (?view=ae link); from_name shows who actually wrote it.
                if (primary.email) {
                    sendArtNoteEmail({
                        toEmail: primary.email,
                        toName: primary.name,
                        fromName: direction === 'ae' ? (noteBy || 'NWCA Art Hub') : 'Steve (Art Dept)',
                        idDesign: ID_Design,
                        company: company,
                        noteType: Note_Type,
                        noteText: Note_Text,
                        recipientIsRep: direction === 'artist'
                    });
                } else {
                    console.log('[ART_NOTE_NOTIFY] no primary email (direction=' + direction
                        + ', rep=' + JSON.stringify(salesRepRaw) + ') — Slack + watchers only');
                }

                // Watcher emails — always reps viewing the AE page.
                watcherEmails.forEach(function (watcherEmail) {
                    sendArtNoteEmail({
                        toEmail: watcherEmail,
                        toName: resolveAEName(watcherEmail),
                        fromName: noteBy || 'NWCA Art Hub',
                        idDesign: ID_Design,
                        company: company,
                        noteType: Note_Type,
                        noteText: Note_Text,
                        recipientIsRep: true
                    });
                });

                // (g) In-app toast: the in-memory art notification queue is
                // SERVER-SIDE ONLY and cannot be called programmatically in-process
                // (POST /api/art-notifications pushes to a module-scoped array, with
                // no export for in-process access). We intentionally do NOT HTTP-call
                // our own server here — skip silently.

                console.log('[ART_NOTE_NOTIFY_OK] design=' + ID_Design
                    + ' direction=' + direction
                    + ' primary=' + (primary.email || 'none')
                    + ' watchers=' + watcherEmails.length);
            } catch (notifyErr) {
                // (h) Last-resort guard — never throw out of fire-and-forget.
                console.error('[ART_NOTE_NOTIFY_ERR]', ID_Design,
                    (notifyErr && notifyErr.message) || notifyErr);
            }
        };

        // Fire without awaiting; swallow any rejection so it can't bubble.
        Promise.resolve().then(fireNoteNotifications).catch(function (e) {
            console.error('[ART_NOTE_NOTIFY_ERR]', ID_Design, (e && e.message) || e);
        });

        res.status(201).json({
            message: 'Design note created successfully',
            data: response.data
        });

    } catch (error) {
        console.error('Error creating design note:', error.response?.data || error.message);
        res.status(500).json({
            error: 'Failed to create design note',
            details: error.response?.data || error.message
        });
    }
});

// PUT /api/design-notes/:id - Update existing design note
router.put('/design-notes/:id', express.json(), async (req, res) => {
    const { id } = req.params;
    
    if (!id) {
        return res.status(400).json({ error: 'Note ID is required' });
    }
    
    try {
        // Build update data - only allow certain fields to be updated
        const updateData = {};
        
        if (req.body.Note_Type !== undefined) {
            if (req.body.Note_Type.length > 255) {
                return res.status(400).json({ error: 'Note_Type must be 255 characters or less' });
            }
            updateData.Note_Type = req.body.Note_Type;
        }
        
        if (req.body.Note_Text !== undefined) {
            if (req.body.Note_Text.length > 64000) {
                return res.status(400).json({ error: 'Note_Text must be 64000 characters or less' });
            }
            updateData.Note_Text = req.body.Note_Text;
        }
        
        if (Object.keys(updateData).length === 0) {
            return res.status(400).json({ error: 'No valid fields to update' });
        }
        
        console.log(`Updating design note ${id} with:`, updateData);
        
        const token = await getCaspioAccessToken();
        const url = `${caspioApiBaseUrl}/tables/DesignNotes/records?q.where=Note_ID=${id}`;
        
        const response = await axios({
            method: 'put',
            url: url,
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json'
            },
            data: updateData,
            timeout: 15000
        });
        
        console.log('Design note updated successfully');
        res.json({
            message: 'Design note updated successfully',
            data: response.data
        });
        
    } catch (error) {
        console.error('Error updating design note:', error.response?.data || error.message);
        res.status(500).json({ 
            error: 'Failed to update design note',
            details: error.response?.data || error.message
        });
    }
});

// DELETE /api/design-notes/:id - Delete design note
router.delete('/design-notes/:id', async (req, res) => {
    const { id } = req.params;
    
    if (!id) {
        return res.status(400).json({ error: 'Note ID is required' });
    }
    
    try {
        console.log(`Deleting design note with ID: ${id}`);
        
        const token = await getCaspioAccessToken();
        const url = `${caspioApiBaseUrl}/tables/DesignNotes/records?q.where=Note_ID=${id}`;
        
        const response = await axios({
            method: 'delete',
            url: url,
            headers: {
                'Authorization': `Bearer ${token}`
            },
            timeout: 15000
        });
        
        console.log('Design note deleted successfully');
        res.json({
            message: 'Design note deleted successfully'
        });
        
    } catch (error) {
        console.error('Error deleting design note:', error.response?.data || error.message);
        res.status(500).json({ 
            error: 'Failed to delete design note',
            details: error.response?.data || error.message
        });
    }
});

// --- Quick-Action Endpoints (Steve's Art Hub) ---
// These use ID_Design (design number shown on gallery cards) not PK_ID

// PUT /api/art-requests/:designId/status — Quick status update + optional art time
router.put('/art-requests/:designId/status', express.json(), async (req, res) => {
    const { designId } = req.params;
    const { status, artMinutes } = req.body;

    if (!designId || !status) {
        return res.status(400).json({ error: 'designId and status are required' });
    }

    try {
        // Strip emoji/non-ASCII from status (Caspio REST API rejects 4-byte UTF-8)
        const cleanStatus = status.replace(/[^\x20-\x7E\xA0-\xFF]/g, '').trim();
        console.log(`Quick-action: updating design ${designId} → ${cleanStatus}`);
        const token = await getCaspioAccessToken();

        const updateData = { Status: cleanStatus };
        const isRevision = status.includes('Revision Requested');
        const isAwaitingApproval = status.includes('Awaiting Approval');
        const isInProgress = status.includes('In Progress');
        const isCompleted = status.includes('Completed');

        // All status updates use additive art time (fetch current record, add new minutes)
        // Also captures Status (prev), CompanyName, Design_Num_SW for Slack notifications below.
        // Pull current state for any transition that might fire Slack — that
        // covers Customer Approved too (it's neither revision/reopen/awaiting/completed
        // but we still want CompanyName + Item_Type for the notify message).
        const isCustomerApproved = cleanStatus === 'Customer Approved';
        const willNotifyStatus = isAwaitingApproval || isCompleted || isCustomerApproved;
        if (isRevision || isAwaitingApproval || isInProgress || isCompleted || isCustomerApproved) {
            const fetchUrl = `${caspioApiBaseUrl}/tables/ArtRequests/records?q.where=ID_Design=${designId}&q.select=Status,Revision_Count,Art_Minutes,Approval_Sent_Date,CompanyName,Design_Num_SW,Item_Type`;
            const fetchResp = await axios({
                method: 'get',
                url: fetchUrl,
                headers: { 'Authorization': `Bearer ${token}` },
                timeout: 15000
            });

            const current = fetchResp.data?.Result?.[0] || {};
            const currentRevCount = current.Revision_Count || 0;
            const currentArtMins = current.Art_Minutes || 0;

            // Only increment revision count for actual revisions, NOT awaiting approval
            if (isRevision) {
                updateData.Revision_Count = currentRevCount + 1;
            }

            // Track when sent to AE for approval (drives elapsed time badges)
            if (isAwaitingApproval) {
                updateData.Approval_Sent_Date = new Date().toISOString();
            }

            // Clear approval tracking on reopen (so elapsed badges start fresh on next approval cycle)
            // Caspio v2 Date/Time fields reject '' — use null (mirrors On_Hold_Since clear below)
            if (isInProgress && current.Approval_Sent_Date) {
                updateData.Approval_Sent_Date = null;
            }

            // Additive art time for all status updates (add session minutes to existing total)
            // Amount_Art_Billed is a Caspio formula field — auto-calculates from Art_Minutes
            if (artMinutes !== undefined && artMinutes !== null) {
                const addMins = parseInt(artMinutes) || 0;
                updateData.Art_Minutes = currentArtMins + addMins;
            }
        } else if (artMinutes !== undefined && artMinutes !== null) {
            // Non-revision (e.g. Completed): set absolute art time
            updateData.Art_Minutes = parseInt(artMinutes) || 0;
        }

        const resource = `/tables/ArtRequests/records?q.where=ID_Design=${designId}`;
        const url = `${caspioApiBaseUrl}${resource}`;

        const response = await axios({
            method: 'put',
            url,
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json'
            },
            data: updateData,
            timeout: 15000
        });

        console.log(`Design ${designId} status updated to "${status}"${isRevision ? ` (revision #${updateData.Revision_Count})` : ''}${isAwaitingApproval ? ' (awaiting approval)' : ''}`);

        // Slack: fire targeted notifications based on the status transition.
        // Replaces two broken Zaps (event_sources:["Datasheet"] missed all
        // dashboard-driven status changes):
        //   - "Mockup Revision → Slack Steve" (misnamed; actually ArtRequests)
        //   - "Steve Art - Reopen Art"
        // Don't await — utilities resolve rather than throw, fire-and-forget.
        try {
            const notifyRecord = {
                ID_Design: parseInt(designId, 10),
                CompanyName: (current && current.CompanyName) || '',
                Design_Num_SW: (current && current.Design_Num_SW) || '',
                Item_Type: (current && current.Item_Type) || null,
                Revision_Count: updateData.Revision_Count != null ? updateData.Revision_Count : (current && current.Revision_Count) || 0,
                Status: cleanStatus,
                Actor: (req.body && req.body.actor) || ''
            };
            if (isRevision) {
                notifyArtRequestRevision(notifyRecord);
            }
            if (isInProgress) {
                // Reopen detection: only fire if previous status was a closed-like state.
                // Utility's CLOSED_LIKE_STATUSES gates this — initial assignments to
                // "In Progress" from "Submitted" won't fire (correct semantic).
                notifyArtRequestReopen(notifyRecord, (current && current.Status) || null);
            }
            // Status-transition notifies (Awaiting Approval / Customer Approved /
            // Completed). The utility silently skips any status not in its TRANSITIONS
            // table, so it's safe to invoke unconditionally — but we gate to keep
            // the call site self-documenting.
            if (willNotifyStatus) {
                notifyArtStatusTransition(notifyRecord, cleanStatus);
            }
        } catch (notifyErr) {
            console.warn('[SLACK_ART_NOTIFY_SKIP] notify-block error:', notifyErr.message);
        }

        res.json({ message: 'Status updated', designId, status, revisionCount: updateData.Revision_Count, data: response.data });
    } catch (error) {
        console.error(`Quick-action status update failed for design ${designId}:`,
            'updateData:', JSON.stringify(updateData),
            error.response?.data || error.message);
        res.status(500).json({ error: 'Failed to update status' });
    }
});

// PUT /api/art-requests/:designId/fields — Update editable fields on an art request
router.put('/art-requests/:designId/fields', express.json(), async (req, res) => {
    const { designId } = req.params;
    const updates = req.body;

    if (!designId || !updates || Object.keys(updates).length === 0) {
        return res.status(400).json({ error: 'designId and at least one field are required' });
    }

    // Whitelist of editable Caspio column names
    // Column names must match actual Caspio ArtRequests table schema exactly
    // Note: On_Hold_Since is INTENTIONALLY NOT in this list — it's server-managed
    // (auto-stamped/cleared when Is_On_Hold flips, see logic below).
    // Rush_Requested_At is also INTENTIONALLY NOT here — it's a Caspio Timestamp
    // field auto-populated when Is_Rush flips. Read-only via REST (returns
    // AlterReadOnlyData 500). Mirrors the READ_ONLY_FIELDS pattern in
    // mockup-routes.js.
    const EDITABLE_FIELDS = [
        'Order_Type', 'Due_Date', 'Garment_Placement',
        'GarmentStyle', 'GarmentColor', 'Garm_Style_2', 'Garm_Color_2',
        'Garm_Style_3', 'Garm_Color_3',
        'NOTES',
        'Prelim_Charges', 'Additional_Services',
        'First_name', 'Last_name', 'Email_Contact', 'Phone',
        'Mockup_1_Note', 'Mockup_2_Note', 'Mockup_3_Note',
        'Is_Rush',
        'Is_On_Hold', 'On_Hold_Note',
        // Item-type intake (sticker/banner extension, 2026-05-06).
        // NULL Item_Type is treated as 'Garment' at render time everywhere.
        'Item_Type', 'Item_Specs_Notes',
        // Structured garment-form fields (2026-06-17 — garment-submit-form.js).
        // Let the detail-page edit modal + status flows persist them.
        'Artwork_Status', 'Approval_Status', 'Color_Mode', 'PMS_Colors',
        'Thread_Colors', 'Underbase_Required', 'Exact_Text',
        'Prev_Order_Num', 'Prev_Design_Num', 'Repeat_Keep_Same', 'Repeat_Change',
        'Uploaded_File_Type', 'AE_Checklist_Confirmed', 'AE_Checklist_Confirmed_By',
        'Artwork_Locations',
        // Rep reference mockup from the Easy Shirt Designer (2026-06-18).
        // Rep_Mockup = displayable image URL; Rep_Mockup_Meta = JSON
        // (garment/placement/threads/date). Reference-only — Steve still proofs;
        // these NEVER touch the Box mockup slots or Approval_Status.
        'Rep_Mockup', 'Rep_Mockup_Meta'
    ];

    // Defense-in-depth: even if a future caller forgets the rule and includes
    // a read-only field via the whitelist, strip it here before forwarding to
    // Caspio. Sending these returns AlterReadOnlyData 500.
    const READ_ONLY_FIELDS = ['PK_ID', 'ID_Design', 'ID', 'Rush_Requested_At', 'On_Hold_Since'];

    const updateData = {};
    const changedFields = [];
    for (const [key, value] of Object.entries(updates)) {
        if (EDITABLE_FIELDS.includes(key) && !READ_ONLY_FIELDS.includes(key)) {
            updateData[key] = value;
            changedFields.push(key);
        }
    }

    if (Object.keys(updateData).length === 0) {
        return res.status(400).json({ error: 'No valid editable fields provided' });
    }

    try {
        console.log(`AE field update: design ${designId} — fields: ${changedFields.join(', ')}`);
        const token = await getCaspioAccessToken();

        // ========================================================================
        // Server-managed On_Hold_Since timestamp
        // Auto-stamp when Is_On_Hold flips false→true; clear when true→false.
        // Fetch current row first so duplicate PUTs (same Is_On_Hold value) don't
        // clobber the original timestamp.
        // ========================================================================
        // Will hold the post-fetch state outside the if block so the Slack
        // notify after the PUT can use CompanyName/Design_Num_SW/Item_Type
        // without a second round-trip.
        let onHoldFlipContext = null;
        if ('Is_On_Hold' in updateData) {
            const newOnHold = updateData.Is_On_Hold === true
                || updateData.Is_On_Hold === 1
                || updateData.Is_On_Hold === 'true';

            // Extended select: pull the same fields slack-art-status-notify
            // expects so we can fire the Slack ping below without a second GET.
            const fetchUrl = `${caspioApiBaseUrl}/tables/ArtRequests/records`
                + `?q.where=ID_Design=${designId}&q.select=Is_On_Hold,On_Hold_Since,CompanyName,Design_Num_SW,Item_Type&q.limit=1`;
            const fetchResp = await axios({
                method: 'get',
                url: fetchUrl,
                headers: { 'Authorization': `Bearer ${token}` },
                timeout: 15000
            });
            const current = fetchResp.data?.Result?.[0] || {};
            const oldOnHold = current.Is_On_Hold === true || current.Is_On_Hold === 1;

            if (newOnHold && !oldOnHold) {
                updateData.On_Hold_Since = new Date().toISOString();
                changedFields.push('On_Hold_Since');
                console.log(`  → Design ${designId} entering hold; stamped On_Hold_Since`);
                // Capture context so the Slack ping below has the fields it needs
                // without a second Caspio fetch.
                onHoldFlipContext = {
                    CompanyName: current.CompanyName || '',
                    Design_Num_SW: current.Design_Num_SW || '',
                    Item_Type: current.Item_Type || null,
                    On_Hold_Note: updateData.On_Hold_Note || ''
                };
            } else if (!newOnHold && oldOnHold) {
                // Caspio v2 rejects empty string for Date/Time fields ("doesn't match data type").
                // null is the only JSON value that clears a Date/Time field cleanly.
                updateData.On_Hold_Since = null;
                changedFields.push('On_Hold_Since');
                console.log(`  → Design ${designId} resuming from hold; cleared On_Hold_Since`);
            }
            // else: no actual flip — leave On_Hold_Since untouched (idempotent PUT)
        }

        const url = `${caspioApiBaseUrl}/tables/ArtRequests/records?q.where=ID_Design=${designId}`;
        await axios({
            method: 'put',
            url,
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json'
            },
            data: updateData,
            timeout: 15000
        });

        console.log(`Design ${designId} fields updated: ${changedFields.join(', ')}`);

        // Slack: fire On Hold notification only on a true false→true flip.
        // Fire-and-forget; util resolves rather than throws.
        if (onHoldFlipContext) {
            try {
                notifyArtStatusTransition({
                    ID_Design: parseInt(designId, 10),
                    CompanyName: onHoldFlipContext.CompanyName,
                    Design_Num_SW: onHoldFlipContext.Design_Num_SW,
                    Item_Type: onHoldFlipContext.Item_Type,
                    On_Hold_Note: onHoldFlipContext.On_Hold_Note,
                    Actor: (req.body && req.body.actor) || ''
                }, '__on_hold__');
            } catch (notifyErr) {
                console.warn('[SLACK_ART_NOTIFY_SKIP] on-hold notify error:', notifyErr.message);
            }
        }

        res.json({ message: 'Fields updated', designId, updatedFields: changedFields });
    } catch (error) {
        console.error(`Field update failed for design ${designId}:`, error.response?.data || error.message);
        res.status(500).json({ error: 'Failed to update fields' });
    }
});

// POST /api/art-requests/:designId/note — Create a design note (triggers Caspio email)
router.post('/art-requests/:designId/note', express.json(), async (req, res) => {
    const { designId } = req.params;
    const { noteType, noteText, noteBy } = req.body;

    if (!designId || !noteType || !noteText) {
        return res.status(400).json({
            error: 'designId, noteType, and noteText are required'
        });
    }

    try {
        console.log(`Quick-action: creating note for design ${designId}`);

        const noteData = {
            ID_Design: parseInt(designId),
            Note_Type: noteType,
            Note_Text: noteText
        };

        if (noteBy) {
            noteData.Note_By = noteBy;
        }

        const token = await getCaspioAccessToken();
        const url = `${caspioApiBaseUrl}/tables/DesignNotes/records`;

        const response = await axios({
            method: 'post',
            url,
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json'
            },
            data: noteData,
            timeout: 15000
        });

        console.log(`Note created for design ${designId}`);
        res.status(201).json({ message: 'Note created', designId, data: response.data });
    } catch (error) {
        console.error(`Quick-action note creation failed for design ${designId}:`,
            error.response?.data || error.message);
        res.status(500).json({ error: 'Failed to create note' });
    }
});

/**
 * POST /api/art-requests/:designId/reminder-sent
 *
 * Frontend "Send Reminder" button calls this BEFORE firing the EmailJS
 * customer-reminder email. We log a Slack ping in #art-notifications so the
 * team has shared visibility that the customer was nudged. No Caspio writes —
 * pure notification. The frontend already creates a Reminder note + sends the
 * customer email separately.
 *
 * Body: { aeName?, recipientEmail? }
 */
router.post('/art-requests/:designId/reminder-sent', express.json(), async (req, res) => {
    const { designId } = req.params;
    if (!designId) {
        return res.status(400).json({ error: 'designId is required' });
    }
    try {
        const token = await getCaspioAccessToken();
        const fetchUrl = `${caspioApiBaseUrl}/tables/ArtRequests/records`
            + `?q.where=ID_Design=${designId}&q.select=CompanyName,Design_Num_SW&q.limit=1`;
        const fetchResp = await axios({
            method: 'get',
            url: fetchUrl,
            headers: { 'Authorization': `Bearer ${token}` },
            timeout: 15000
        });
        const current = fetchResp.data?.Result?.[0] || {};

        // Fire-and-forget Slack — util resolves rather than throws.
        notifyArtReminder({
            ID_Design: parseInt(designId, 10),
            CompanyName: current.CompanyName || '',
            Design_Num_SW: current.Design_Num_SW || '',
            AE_Name: (req.body && req.body.aeName) || '',
            Recipient_Email: (req.body && req.body.recipientEmail) || ''
        });

        res.json({ success: true, designId });
    } catch (error) {
        console.error(`Reminder-sent notify failed for design ${designId}:`,
            error.response?.data || error.message);
        // Don't block the AE's email flow if Caspio fetch fails — return 200
        // with a soft warning. The customer email still gets sent client-side.
        res.json({ success: false, designId, warning: 'Slack notification skipped' });
    }
});

// --- AE Awaiting-Approval Digest Admin Routes ---

/**
 * GET /api/art-requests/ae-approval-digest/scan
 *
 * Pure scan — returns the per-AE grouping that the daily digest WOULD send,
 * without sending email. Useful for verifying grouping before flipping the
 * cron on, or debugging "why didn't AE X get an email today".
 */
router.get('/art-requests/ae-approval-digest/scan', async (req, res) => {
    try {
        const { runAEApprovalDigest } = require('../utils/send-ae-approval-digest');
        const result = await runAEApprovalDigest({ dryRun: true });
        res.json({ success: true, ...result });
    } catch (err) {
        console.error('[AE Digest] Scan failed:', err.message);
        res.status(500).json({ success: false, error: err.message });
    }
});

/**
 * POST /api/art-requests/ae-approval-digest/send
 *
 * Manual trigger for the AE digest. Protected by x-admin-key header so
 * random callers can't spam every AE inbox. Mirrors the Steve digest
 * trigger pattern.
 */
router.post('/art-requests/ae-approval-digest/send', async (req, res) => {
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
        const { runAEApprovalDigest } = require('../utils/send-ae-approval-digest');
        const result = await runAEApprovalDigest();
        res.json({ success: true, ...result });
    } catch (err) {
        console.error('[AE Digest] Manual trigger failed:', err.message);
        res.status(500).json({ success: false, error: err.message });
    }
});

// --- Art Charges Endpoints ---

// GET /api/art-charges?id_design=XXXXX — List charges for a design
router.get('/art-charges', async (req, res) => {
    try {
        const { id_design } = req.query;
        if (!id_design) {
            return res.status(400).json({ error: 'id_design query parameter is required' });
        }

        const params = {
            'q.where': `ID_Design=${parseInt(id_design)}`,
            'q.orderBy': 'Charge_Date DESC',
            'q.limit': 200
        };

        const records = await fetchAllCaspioPages('/tables/ArtCharges/records', params);
        res.json(records);
    } catch (error) {
        console.error('Error fetching art charges:', error.response?.data || error.message);
        res.status(500).json({ error: 'Failed to fetch art charges' });
    }
});

// POST /api/art-charges — Create new charge entry
router.post('/art-charges', async (req, res) => {
    try {
        const { ID_Design, Minutes, Cost, Description, Charge_Type, Logged_By,
                Running_Total_Minutes, Running_Total_Cost } = req.body;

        if (!ID_Design || Minutes === undefined || !Charge_Type) {
            return res.status(400).json({
                error: 'Missing required fields: ID_Design, Minutes, Charge_Type'
            });
        }

        const chargeData = {
            ID_Design: parseInt(ID_Design),
            Minutes: parseInt(Minutes) || 0,
            Cost: parseFloat(Cost) || 0,
            Description: (Description || '').substring(0, 255),
            Charge_Type: (Charge_Type || '').substring(0, 50),
            Logged_By: (Logged_By || 'art@nwcustomapparel.com').substring(0, 100),
            Running_Total_Minutes: parseInt(Running_Total_Minutes) || 0,
            Running_Total_Cost: parseFloat(Running_Total_Cost) || 0
        };

        const token = await getCaspioAccessToken();
        const url = `${caspioApiBaseUrl}/tables/ArtCharges/records`;

        const response = await axios({
            method: 'post',
            url,
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json'
            },
            data: chargeData,
            timeout: 15000
        });

        console.log(`Art charge created for design ${ID_Design}: ${Minutes}min, $${Cost}`);
        res.status(201).json({ message: 'Art charge created', data: response.data });
    } catch (error) {
        console.error('Error creating art charge:', error.response?.data || error.message);
        res.status(500).json({ error: 'Failed to create art charge' });
    }
});

// ── Art Notification Endpoints (real-time dashboard toasts) ──────────
// Used by: Steve's dashboard, AE dashboard, detail page, submit form

// POST /api/art-notifications — Push notification after actions (approve, submit, mockup, etc.)
router.post('/art-notifications', express.json(), (req, res) => {
    const { type, designId, companyName, actorName, targetRep } = req.body;

    if (!type || !designId || !actorName) {
        return res.status(400).json({ error: 'type, designId, and actorName are required' });
    }

    if (!VALID_NOTIFICATION_TYPES.includes(type)) {
        return res.status(400).json({
            error: `type must be one of: ${VALID_NOTIFICATION_TYPES.join(', ')}`
        });
    }

    const notification = {
        id: `${Date.now()}-${Math.random().toString(36).substr(2, 5)}`,
        type,
        designId: String(designId),
        companyName: companyName || 'Unknown',
        actorName,
        targetRep: targetRep || null, // Optional: email of rep to target (for AE dashboard filtering)
        timestamp: Date.now()
    };

    ART_NOTIFICATIONS.push(notification);
    pruneNotifications();

    console.log(`Art notification queued: ${type} for design ${designId} by ${actorName}${targetRep ? ' (target: ' + targetRep + ')' : ''}`);
    res.status(201).json({ message: 'Notification queued', id: notification.id });
});

// GET /api/art-notifications — Dashboards poll for new notifications
// Query params:
//   since=<timestamp>  — only return notifications newer than this
//   rep=<email>        — only return notifications targeted at this rep (for AE dashboard)
router.get('/art-notifications', (req, res) => {
    pruneNotifications();
    const since = parseInt(req.query.since) || 0;
    const repFilter = req.query.rep || null;

    let notifications = ART_NOTIFICATIONS.filter(n => n.timestamp > since);

    // If rep filter provided, only return notifications targeted at that rep
    // (or notifications with no targetRep, which are broadcast to everyone)
    if (repFilter) {
        notifications = notifications.filter(n => !n.targetRep || n.targetRep === repFilter);
    }

    res.json({ notifications, serverTime: Date.now() });
});

/**
 * GET /api/art-requests/:designId/analysis
 * Get AI vision analysis results + screen print location data for a design's mockup images
 */
router.get('/art-requests/:designId/analysis', async (req, res) => {
    const { designId } = req.params;
    console.log(`GET /api/art-requests/${designId}/analysis`);

    try {
        // Fetch both tables in parallel
        const [analyses, printLocations] = await Promise.all([
            fetchAllCaspioPages('/tables/Mockup_AI_Analysis/records', {
                'q.where': `Design_ID='${designId}'`,
                'q.orderBy': 'Analysis_Date DESC'
            }, { maxPages: 1 }),
            fetchAllCaspioPages('/tables/Mockup_Print_Locations/records', {
                'q.where': `Design_ID='${designId}'`
            }, { maxPages: 1 }).catch(() => [])  // Don't fail if no print data
        ]);

        console.log(`Analysis: ${analyses.length} result(s), ${printLocations.length} print location(s) for Design #${designId}`);
        res.json({ analyses, printLocations });

    } catch (error) {
        console.error('Error fetching analysis:', error.message);
        res.status(500).json({ error: 'Failed to fetch analysis', details: error.message });
    }
});

/**
 * DELETE /api/art-requests/:designId/analysis/:mockupSlot
 * Delete AI analysis + print location data when a mockup is removed
 */
router.delete('/art-requests/:designId/analysis/:mockupSlot', async (req, res) => {
    const { designId, mockupSlot } = req.params;
    console.log(`DELETE /api/art-requests/${designId}/analysis/${mockupSlot}`);

    try {
        // Find matching analysis records
        const analyses = await fetchAllCaspioPages('/tables/Mockup_AI_Analysis/records', {
            'q.where': `Design_ID='${designId}' AND Mockup_Slot='${mockupSlot}'`,
            'q.select': 'PK_ID'
        }, { maxPages: 1 });

        if (analyses.length === 0) {
            return res.json({ deleted: 0, message: 'No analysis found for this slot' });
        }

        let deletedAnalysis = 0;
        let deletedLocations = 0;

        // Delete ALL child print locations for this Design_ID + slot (catches both PK_ID and fallback format)
        try {
            const allLocations = await fetchAllCaspioPages('/tables/Mockup_Print_Locations/records', {
                'q.where': `Design_ID='${designId}' AND Mockup_Slot='${mockupSlot}'`,
                'q.select': 'PK_ID'
            }, { maxPages: 1 });

            for (const loc of allLocations) {
                await makeCaspioRequest('delete', `/tables/Mockup_Print_Locations/records`, { 'q.where': `PK_ID=${loc.PK_ID}` });
                deletedLocations++;
            }
        } catch (e) {
            console.warn('Could not delete print locations for slot', mockupSlot, e.message);
        }

        // Delete all analysis records for this slot
        for (const record of analyses) {
            await makeCaspioRequest('delete', `/tables/Mockup_AI_Analysis/records`, { 'q.where': `PK_ID=${record.PK_ID}` });
            deletedAnalysis++;
        }

        console.log(`Deleted ${deletedAnalysis} analysis record(s) and ${deletedLocations} print location(s)`);
        res.json({ deleted: deletedAnalysis, deletedLocations });

    } catch (error) {
        console.error('Error deleting analysis:', error.message);
        res.status(500).json({ error: 'Failed to delete analysis', details: error.message });
    }
});

module.exports = router;