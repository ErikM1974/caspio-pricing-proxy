// Art-related endpoints (artrequests, art-invoices, and design-notes)
const express = require('express');
const router = express.Router();
const axios = require('axios');
const { getCaspioAccessToken, makeCaspioRequest, fetchAllCaspioPages } = require('../utils/caspio');
const config = require('../../config');

const caspioApiBaseUrl = config.caspio.apiBaseUrl;

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

module.exports = router;