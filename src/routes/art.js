// Art-related endpoints (artrequests, art-invoices, and design-notes)
const express = require('express');
const router = express.Router();
const axios = require('axios');
const { getCaspioAccessToken, makeCaspioRequest, fetchAllCaspioPages } = require('../utils/caspio');
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
        res.status(201).json({
            message: 'Art request created successfully',
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
        if (isRevision || isAwaitingApproval || isInProgress || isCompleted) {
            const fetchUrl = `${caspioApiBaseUrl}/tables/ArtRequests/records?q.where=ID_Design=${designId}&q.select=Revision_Count,Art_Minutes`;
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
        res.json({ message: 'Status updated', designId, status, revisionCount: updateData.Revision_Count, data: response.data });
    } catch (error) {
        console.error(`Quick-action status update failed for design ${designId}:`,
            'updateData:', JSON.stringify(updateData),
            error.response?.data || error.message);
        res.status(500).json({ error: 'Failed to update status' });
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
                'q.sort': 'Analysis_Date DESC'
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

        for (const record of analyses) {
            const pkId = record.PK_ID;

            // Delete child print location rows first
            try {
                const locations = await fetchAllCaspioPages('/tables/Mockup_Print_Locations/records', {
                    'q.where': `Analysis_ID='${pkId}'`,
                    'q.select': 'PK_ID'
                }, { maxPages: 1 });

                for (const loc of locations) {
                    await caspioRequest(`/tables/Mockup_Print_Locations/records?q.where=PK_ID=${loc.PK_ID}`, 'DELETE');
                    deletedLocations++;
                }
            } catch (e) {
                console.warn('Could not delete print locations for analysis', pkId, e.message);
            }

            // Delete the analysis record
            await caspioRequest(`/tables/Mockup_AI_Analysis/records?q.where=PK_ID=${pkId}`, 'DELETE');
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