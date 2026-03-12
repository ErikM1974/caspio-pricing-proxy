// Box API File Upload Route — uploads mockup files to Steve's Box folder
// and saves the shared link URL back to the Caspio ArtRequests table.
//
// Auth: Box Client Credentials Grant (SanMar Inventory Import app)
// Flow: Frontend file → this route → Box API upload → shared link → Caspio update

const express = require('express');
const router = express.Router();
const axios = require('axios');
const multer = require('multer');
const FormData = require('form-data');
const { Readable } = require('stream');
const { getCaspioAccessToken } = require('../utils/caspio');
const config = require('../../config');

// ── Config ────────────────────────────────────────────────────────────
const BOX_API_BASE = 'https://api.box.com/2.0';
const BOX_UPLOAD_BASE = 'https://upload.box.com/api/2.0';
const BOX_CLIENT_ID = process.env.BOX_CLIENT_ID;
const BOX_CLIENT_SECRET = process.env.BOX_CLIENT_SECRET;
const BOX_ENTERPRISE_ID = process.env.BOX_ENTERPRISE_ID;
const BOX_ART_FOLDER_ID = process.env.BOX_ART_FOLDER_ID; // AAA...Steve Art Box 2020

// Allowed file types for mockup uploads
const ALLOWED_MIME_TYPES = [
    'image/jpeg', 'image/png', 'image/gif', 'image/webp',
    'application/pdf'
];

// Mockup URL fields in Caspio ArtRequests (order of preference)
// Note: No "Mockup_Link" field exists. Box_File_Mockup is the dedicated mockup field.
const MOCKUP_FIELDS = ['Box_File_Mockup', 'CDN_Link', 'CDN_Link_Two', 'CDN_Link_Three', 'CDN_Link_Four'];

// ── Multer ─────────────────────────────────────────────────────────────
const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 20 * 1024 * 1024 }, // 20MB
    fileFilter: function (req, file, cb) {
        if (ALLOWED_MIME_TYPES.includes(file.mimetype)) {
            cb(null, true);
        } else {
            cb(new Error('File type not allowed. Use JPG, PNG, GIF, WebP, or PDF.'));
        }
    }
});

// ── Box Token Cache ────────────────────────────────────────────────────
let boxAccessToken = null;
let boxTokenExpiry = 0;

async function getBoxAccessToken() {
    const now = Math.floor(Date.now() / 1000);
    if (boxAccessToken && now < (boxTokenExpiry - 60)) {
        return boxAccessToken;
    }

    console.log('Box: Requesting new access token (Client Credentials Grant)...');
    const resp = await axios.post('https://api.box.com/oauth2/token', new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: BOX_CLIENT_ID,
        client_secret: BOX_CLIENT_SECRET,
        box_subject_type: 'enterprise',
        box_subject_id: BOX_ENTERPRISE_ID
    }), {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        timeout: 15000
    });

    boxAccessToken = resp.data.access_token;
    boxTokenExpiry = now + resp.data.expires_in;
    console.log('Box: Token obtained, expires in', resp.data.expires_in, 'seconds');
    return boxAccessToken;
}

// ── Box API Helpers ────────────────────────────────────────────────────

async function boxRequest(method, url, data, extraHeaders) {
    const token = await getBoxAccessToken();
    const headers = {
        'Authorization': `Bearer ${token}`,
        ...extraHeaders
    };
    return axios({ method, url, data, headers, timeout: 30000 });
}

// In-memory cache: customerId → { id, name } (survives until dyno restart)
const folderCache = new Map();

/**
 * Search for a customer sub-folder inside Steve's art folder.
 * Folders are named: "{customerId} {companyName}"
 * Uses Box Search API instead of paginating all items (much faster).
 */
async function findCustomerFolder(customerId) {
    const custIdStr = String(customerId);

    // Check cache first
    if (folderCache.has(custIdStr)) {
        return folderCache.get(custIdStr);
    }

    const token = await getBoxAccessToken();

    try {
        // Box Search API: search for folder by customer ID within Steve's art folder
        const resp = await axios.get(`${BOX_API_BASE}/search`, {
            params: {
                query: custIdStr,
                type: 'folder',
                ancestor_folder_ids: BOX_ART_FOLDER_ID,
                fields: 'id,name,type',
                limit: 10
            },
            headers: { 'Authorization': `Bearer ${token}` },
            timeout: 15000
        });

        const entries = resp.data.entries || [];
        for (const entry of entries) {
            if (entry.type === 'folder' && entry.name.startsWith(custIdStr)) {
                folderCache.set(custIdStr, entry);
                return entry;
            }
        }
    } catch (searchErr) {
        // Search API can be eventually consistent for new folders.
        // Fall back to listing first page if search fails.
        console.log('Box: Search API failed, falling back to folder listing:', searchErr.message);
        const resp = await axios.get(`${BOX_API_BASE}/folders/${BOX_ART_FOLDER_ID}/items`, {
            params: { fields: 'id,name,type', limit: 200, offset: 0 },
            headers: { 'Authorization': `Bearer ${token}` },
            timeout: 15000
        });
        const entries = resp.data.entries || [];
        for (const entry of entries) {
            if (entry.type === 'folder' && entry.name.startsWith(custIdStr)) {
                folderCache.set(custIdStr, entry);
                return entry;
            }
        }
    }

    return null; // Not found
}

/**
 * Create a customer sub-folder inside Steve's art folder.
 */
async function createCustomerFolder(customerId, companyName) {
    // Match Steve's naming: "{customerId} {companyName}"
    const folderName = `${customerId} ${companyName}`.substring(0, 255);
    try {
        const resp = await boxRequest('POST', `${BOX_API_BASE}/folders`, {
            name: folderName,
            parent: { id: BOX_ART_FOLDER_ID }
        }, { 'Content-Type': 'application/json' });
        console.log(`Box: Created folder "${folderName}" (ID: ${resp.data.id})`);
        folderCache.set(String(customerId), resp.data);
        return resp.data;
    } catch (err) {
        // 409 = folder already exists (search API is eventually consistent)
        if (err.response && err.response.status === 409) {
            const conflicts = err.response.data?.context_info?.conflicts;
            if (conflicts && conflicts.length > 0) {
                const existing = conflicts[0];
                console.log(`Box: Folder already exists "${existing.name}" (ID: ${existing.id})`);
                folderCache.set(String(customerId), existing);
                return existing;
            }
        }
        throw err;
    }
}

/**
 * Upload a file buffer to a Box folder.
 */
async function uploadFileToBox(folderId, fileName, fileBuffer, fileMimeType) {
    const token = await getBoxAccessToken();
    const form = new FormData();

    // Box upload API expects "attributes" JSON + file stream
    form.append('attributes', JSON.stringify({
        name: fileName,
        parent: { id: folderId }
    }));
    form.append('file', Readable.from(fileBuffer), {
        filename: fileName,
        contentType: fileMimeType
    });

    const resp = await axios.post(`${BOX_UPLOAD_BASE}/files/content`, form, {
        headers: {
            'Authorization': `Bearer ${token}`,
            ...form.getHeaders()
        },
        maxBodyLength: Infinity,
        maxContentLength: Infinity,
        timeout: 60000 // 60s for large files
    });

    return resp.data.entries[0]; // Box returns array of uploaded files
}

/**
 * Create an open shared link for a Box file.
 * Returns the download URL that works without Box login.
 */
async function createSharedLink(fileId) {
    const resp = await boxRequest('PUT', `${BOX_API_BASE}/files/${fileId}`, {
        shared_link: { access: 'open' }
    }, { 'Content-Type': 'application/json' });

    return resp.data.shared_link;
}

/**
 * Find the first empty mockup slot in the Caspio art request.
 * Returns the field name, or null if all slots are full.
 */
async function findEmptyMockupSlot(pkId) {
    const token = await getCaspioAccessToken();
    const fieldsToSelect = MOCKUP_FIELDS.join(',');
    const url = `${config.caspio.apiBaseUrl}/tables/ArtRequests/records?q.where=PK_ID=${pkId}&q.select=${fieldsToSelect}`;

    const resp = await axios.get(url, {
        headers: { 'Authorization': `Bearer ${token}` },
        timeout: 15000
    });

    const records = resp.data.Result || [];
    if (records.length === 0) return null;

    const record = records[0];
    const bareCdnRegex = /^https?:\/\/cdn\.caspio\.com\/[A-Z0-9]+\/?$/i;

    for (const field of MOCKUP_FIELDS) {
        const val = record[field];
        // Empty, null, or bare CDN base URL = available slot
        if (!val || val.trim() === '' || bareCdnRegex.test(val.trim())) {
            return field;
        }
    }

    return null; // All slots full
}

/**
 * Save the shared link URL to the Caspio art request.
 */
async function saveMockupUrlToCaspio(pkId, fieldName, url) {
    const token = await getCaspioAccessToken();
    const endpoint = `${config.caspio.apiBaseUrl}/tables/ArtRequests/records?q.where=PK_ID=${pkId}`;

    await axios.put(endpoint, { [fieldName]: url }, {
        headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json'
        },
        timeout: 15000
    });

    console.log(`Caspio: Saved mockup URL to ${fieldName} for PK_ID=${pkId}`);
}

// ── Endpoint ───────────────────────────────────────────────────────────

/**
 * POST /api/art-requests/:designId/upload-mockup
 *
 * Upload a mockup file for an art request.
 * Body (multipart/form-data):
 *   - file: the image/PDF file
 *   - pkId: Caspio PK_ID of the art request
 *   - customerId: ShopWorks customer ID (for folder lookup/creation)
 *   - companyName: company name (for folder naming)
 */
router.post('/art-requests/:designId/upload-mockup', upload.single('file'), async (req, res) => {
    const { designId } = req.params;
    const { pkId, customerId, companyName } = req.body;

    // Validate required fields
    if (!req.file) {
        return res.status(400).json({ success: false, error: 'No file provided', code: 'NO_FILE' });
    }
    if (!pkId) {
        return res.status(400).json({ success: false, error: 'Missing pkId', code: 'MISSING_PK_ID' });
    }
    if (!customerId) {
        return res.status(400).json({ success: false, error: 'Missing customerId', code: 'MISSING_CUSTOMER_ID' });
    }

    const file = req.file;
    console.log(`Box upload: Design #${designId}, file "${file.originalname}" (${(file.size / 1024).toFixed(1)} KB)`);

    try {
        // 1. Find empty mockup slot in Caspio BEFORE uploading
        const slotField = await findEmptyMockupSlot(pkId);
        if (!slotField) {
            return res.status(409).json({
                success: false,
                error: 'All mockup slots are full (5/5)',
                code: 'SLOTS_FULL'
            });
        }

        // 2. Find or create customer folder in Box
        let folder = await findCustomerFolder(customerId);
        if (!folder) {
            const name = companyName || `Customer ${customerId}`;
            folder = await createCustomerFolder(customerId, name);
        }
        console.log(`Box upload: Using folder "${folder.name}" (ID: ${folder.id})`);

        // 3. Build file name: "{customerId} {company} Mockup {designId}.{ext}"
        const ext = file.originalname.split('.').pop() || 'jpg';
        const shortCompany = (companyName || '').substring(0, 30).trim();
        const fileName = `${customerId} ${shortCompany} Mockup ${designId}.${ext}`.replace(/[<>:"/\\|?*]/g, '');

        // 4. Upload file to Box
        let boxFile;
        try {
            boxFile = await uploadFileToBox(folder.id, fileName, file.buffer, file.mimetype);
        } catch (uploadErr) {
            // Handle duplicate file name — Box returns 409
            if (uploadErr.response && uploadErr.response.status === 409) {
                // File exists, try with timestamp suffix
                const ts = Date.now().toString(36);
                const altName = `${customerId} ${shortCompany} Mockup ${designId}_${ts}.${ext}`.replace(/[<>:"/\\|?*]/g, '');
                boxFile = await uploadFileToBox(folder.id, altName, file.buffer, file.mimetype);
            } else {
                throw uploadErr;
            }
        }
        console.log(`Box upload: File uploaded as "${boxFile.name}" (ID: ${boxFile.id})`);

        // 5. Create shared link (open access, no Box login needed)
        const sharedLink = await createSharedLink(boxFile.id);
        const sharedUrl = sharedLink.download_url || sharedLink.url;
        console.log(`Box upload: Shared link created: ${sharedUrl}`);

        // 6. Save shared link URL to Caspio
        await saveMockupUrlToCaspio(pkId, slotField, sharedUrl);

        // 7. Return success
        res.json({
            success: true,
            field: slotField,
            url: sharedUrl,
            boxFileId: boxFile.id,
            boxFileName: boxFile.name,
            folderId: folder.id,
            folderName: folder.name
        });

    } catch (err) {
        console.error('Box upload error:', err.response ? JSON.stringify(err.response.data) : err.message);

        // Specific error handling
        if (err.response) {
            const status = err.response.status;
            if (status === 401) {
                // Token expired — clear cache and suggest retry
                boxAccessToken = null;
                boxTokenExpiry = 0;
                return res.status(502).json({
                    success: false,
                    error: 'Box authentication failed. Please retry.',
                    code: 'BOX_AUTH_FAILED'
                });
            }
            if (status === 403) {
                return res.status(403).json({
                    success: false,
                    error: 'Box permission denied. Service account may not have access to the folder.',
                    code: 'BOX_PERMISSION_DENIED'
                });
            }
            if (status === 429) {
                return res.status(429).json({
                    success: false,
                    error: 'Box rate limited. Please wait and retry.',
                    code: 'BOX_RATE_LIMITED'
                });
            }
        }

        res.status(500).json({
            success: false,
            error: 'Failed to upload mockup: ' + (err.message || 'Unknown error'),
            code: 'UPLOAD_FAILED'
        });
    }
});

// Multer error handler
router.use((err, req, res, next) => {
    if (err instanceof multer.MulterError) {
        if (err.code === 'LIMIT_FILE_SIZE') {
            return res.status(413).json({ success: false, error: 'File too large (max 20MB)', code: 'FILE_TOO_LARGE' });
        }
        return res.status(400).json({ success: false, error: err.message, code: 'UPLOAD_ERROR' });
    }
    if (err.message && err.message.includes('File type not allowed')) {
        return res.status(415).json({ success: false, error: err.message, code: 'INVALID_FILE_TYPE' });
    }
    next(err);
});

module.exports = router;
