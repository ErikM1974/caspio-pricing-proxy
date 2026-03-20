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
const BOX_MOCKUP_FOLDER_ID = process.env.BOX_MOCKUP_FOLDER_ID; // Ruth Digitizing Mockups parent folder

// Allowed file types for mockup uploads
const ALLOWED_MIME_TYPES = [
    'image/jpeg', 'image/png', 'image/gif', 'image/webp',
    'application/pdf',
    'image/svg+xml',                    // .SVG
    'application/postscript',           // .AI, .EPS
    'application/octet-stream',         // .DST, .EMB (binary embroidery files)
    'application/x-dst'                 // .DST alternate MIME
];

// Writable mockup URL fields in Caspio ArtRequests (order of preference)
// CDN_Link* are Caspio FILE fields (read-only via API) — cannot write to them.
// Only text URL fields are writable: Box_File_Mockup, BoxFileLink, Company_Mockup.
const MOCKUP_FIELDS = ['Box_File_Mockup', 'BoxFileLink', 'Company_Mockup'];

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
 * Find art folder by design number first, then company name fallback.
 * Steve names folders as "{designNumber} {companyName}" (e.g., "39789 Wyoming University Tumbler").
 */
async function findArtFolder(designId, companyName) {
    const designStr = String(designId);

    // Check cache by design ID
    const cacheKey = 'art_' + designStr;
    if (folderCache.has(cacheKey)) {
        return folderCache.get(cacheKey);
    }

    const token = await getBoxAccessToken();

    // Step 1: Search by design number (most reliable)
    try {
        const resp = await axios.get(`${BOX_API_BASE}/search`, {
            params: {
                query: designStr,
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
            if (entry.type === 'folder' && entry.name.startsWith(designStr)) {
                console.log(`Box: Found art folder by design #${designStr}: "${entry.name}"`);
                folderCache.set(cacheKey, entry);
                return entry;
            }
        }
    } catch (err) {
        console.log('Box: Design # search failed:', err.message);
    }

    // Step 2: Search by company name (fallback for folders Steve named differently)
    if (companyName && companyName.trim()) {
        try {
            const resp = await axios.get(`${BOX_API_BASE}/search`, {
                params: {
                    query: companyName.trim(),
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
                if (entry.type === 'folder' && entry.name.toLowerCase().includes(companyName.trim().toLowerCase())) {
                    console.log(`Box: Found art folder by company name "${companyName}": "${entry.name}"`);
                    folderCache.set(cacheKey, entry);
                    return entry;
                }
            }
        } catch (err) {
            console.log('Box: Company name search failed:', err.message);
        }
    }

    return null; // Not found — caller will create
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
    // customerId is optional — fall back to designId for folder/file naming
    const folderIdentifier = customerId || designId;

    const file = req.file;
    console.log(`Box upload: Design #${designId}, file "${file.originalname}" (${(file.size / 1024).toFixed(1)} KB), customerId: ${customerId || '(none, using designId)'}`);

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

        // 2. Find or create art folder in Box (search by design #, then company name)
        let folder = await findArtFolder(designId, companyName);
        if (!folder) {
            // Auto-create folder: "{designId} {companyName}" (Steve's naming convention)
            const folderLabel = companyName || `Design ${designId}`;
            folder = await createCustomerFolder(designId, folderLabel);
        }
        console.log(`Box upload: Using folder "${folder.name}" (ID: ${folder.id})`);

        // 3. Build file name: "{customerId} {company} Mockup {designId}.{ext}"
        const ext = file.originalname.split('.').pop() || 'jpg';
        const shortCompany = (companyName || '').substring(0, 30).trim();
        const fileName = `${folderIdentifier} ${shortCompany} Mockup ${designId}.${ext}`.replace(/[<>:"/\\|?*]/g, '');

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

        // 6b. Fire-and-forget: AI vision analysis of the mockup image
        try {
            const { analyzeMockupImage } = require('../utils/mockup-vision');
            analyzeMockupImage(file.buffer, file.mimetype, {
                designId,
                slotField,
                imageUrl: sharedUrl
            }).catch(err => console.warn('[Vision] Analysis failed (non-blocking):', err.message));
        } catch (visionErr) {
            console.warn('[Vision] Module load failed (non-blocking):', visionErr.message);
        }

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

// ── Box File Picker Endpoints ─────────────────────────────────────────

/**
 * GET /api/box/art-folders?limit=100&offset=0
 *
 * List all folders inside BOX_ART_FOLDER_ID (Steve's art folder).
 * Used by Art Request Detail "Browse Box" tab to show a browsable folder list.
 */
router.get('/box/art-folders', async (req, res) => {
    const limit = Math.min(parseInt(req.query.limit) || 100, 500);
    const offset = parseInt(req.query.offset) || 0;

    try {
        const token = await getBoxAccessToken();

        const resp = await axios.get(`${BOX_API_BASE}/folders/${BOX_ART_FOLDER_ID}/items`, {
            params: {
                fields: 'id,name,type',
                limit,
                offset,
                sort: 'date',
                direction: 'DESC'
            },
            headers: { 'Authorization': `Bearer ${token}` },
            timeout: 15000
        });

        const folders = (resp.data.entries || []).filter(e => e.type === 'folder');
        const totalCount = resp.data.total_count || 0;

        res.json({
            success: true,
            folders: folders.map(f => ({ id: f.id, name: f.name })),
            total_count: totalCount,
            hasMore: (offset + limit) < totalCount
        });

    } catch (err) {
        console.error('Box art-folders error:', err.response ? JSON.stringify(err.response.data) : err.message);
        if (err.response?.status === 401) {
            boxAccessToken = null;
            boxTokenExpiry = 0;
        }
        res.status(500).json({ success: false, error: 'Failed to list Box folders: ' + (err.message || 'Unknown error') });
    }
});

/**
 * GET /api/box/folder-files?designNumber=40246
 * GET /api/box/folder-files?folderId=123456789
 *
 * Search Box for a folder matching the design number (or use folderId directly),
 * then list its files with thumbnail URLs. Used by Steve's Send Mockup modal
 * and Art Request Detail Browse Box tab.
 */
router.get('/box/folder-files', async (req, res) => {
    const { designNumber, folderId } = req.query;

    if (!designNumber && !folderId) {
        return res.status(400).json({ success: false, error: 'Missing designNumber or folderId parameter' });
    }

    try {
        const token = await getBoxAccessToken();
        let folder = null;

        if (folderId) {
            // Direct folder access — skip search
            try {
                const folderResp = await axios.get(`${BOX_API_BASE}/folders/${folderId}`, {
                    params: { fields: 'id,name,type' },
                    headers: { 'Authorization': `Bearer ${token}` },
                    timeout: 10000
                });
                folder = { id: folderResp.data.id, name: folderResp.data.name };
            } catch (folderErr) {
                return res.json({ success: true, found: false, folderId: null, folderName: null, files: [] });
            }
        } else {
            // Search by design number (original behavior)
            const designNum = String(designNumber).trim();

            const searchResp = await axios.get(`${BOX_API_BASE}/search`, {
                params: {
                    query: designNum,
                    type: 'folder',
                    ancestor_folder_ids: BOX_ART_FOLDER_ID,
                    fields: 'id,name,type',
                    limit: 10
                },
                headers: { 'Authorization': `Bearer ${token}` },
                timeout: 15000
            });

            const folders = (searchResp.data.entries || []).filter(
                e => e.type === 'folder' && e.name.startsWith(designNum)
            );

            if (folders.length === 0) {
                return res.json({ success: true, found: false, folderId: null, folderName: null, files: [] });
            }

            folder = folders[0];
        }

        // 2. List folder items
        const itemsResp = await axios.get(`${BOX_API_BASE}/folders/${folder.id}/items`, {
            params: {
                fields: 'id,name,type,size,modified_at,extension',
                limit: 100,
                sort: 'date',
                direction: 'DESC'
            },
            headers: { 'Authorization': `Bearer ${token}` },
            timeout: 15000
        });

        const items = (itemsResp.data.entries || []).filter(e => e.type === 'file');

        // 3. Build file list with proxy thumbnail URLs
        // Thumbnails are served via GET /api/box/thumbnail/:fileId (handles auth server-side)
        const THUMB_SUPPORTED_EXTS = ['jpg','jpeg','png','gif','bmp','tiff','tif','svg','psd','ai','eps','pdf','indd','indt','idml'];
        const files = items.map(item => {
            const ext = (item.extension || item.name.split('.').pop() || '').toLowerCase();
            return {
                id: item.id,
                name: item.name,
                size: item.size,
                modified_at: item.modified_at,
                extension: ext,
                thumbnailUrl: THUMB_SUPPORTED_EXTS.includes(ext)
                    ? `/api/box/thumbnail/${item.id}`
                    : null
            };
        });

        res.json({
            success: true,
            found: true,
            folderId: folder.id,
            folderName: folder.name,
            files
        });

    } catch (err) {
        console.error('Box folder-files error:', err.response ? JSON.stringify(err.response.data) : err.message);
        if (err.response?.status === 401) {
            boxAccessToken = null;
            boxTokenExpiry = 0;
        }
        res.status(500).json({ success: false, error: 'Failed to search Box: ' + (err.message || 'Unknown error') });
    }
});

/**
 * GET /api/box/thumbnail/:fileId
 *
 * Proxy a Box file thumbnail. Returns the image binary directly so the
 * browser can use it as an <img src> without needing Box auth.
 * Supports: jpg, png, psd, ai, eps, pdf, indd (NOT cdr).
 */
router.get('/box/thumbnail/:fileId', async (req, res) => {
    const { fileId } = req.params;
    try {
        const token = await getBoxAccessToken();
        // Use Box's simple thumbnail endpoint — returns image bytes directly
        const thumbResp = await axios.get(`${BOX_API_BASE}/files/${fileId}/thumbnail.png`, {
            params: { min_height: 256, min_width: 256 },
            headers: { 'Authorization': `Bearer ${token}` },
            responseType: 'arraybuffer',
            timeout: 10000,
            // Box returns 202 if thumbnail is generating, 302 for placeholder
            validateStatus: (s) => s === 200 || s === 202 || s === 302
        });

        if (thumbResp.status === 200 && thumbResp.data && thumbResp.data.length > 0) {
            const contentType = thumbResp.headers['content-type'] || 'image/png';
            res.set('Content-Type', contentType);
            res.set('Cache-Control', 'public, max-age=3600'); // cache 1hr
            return res.send(Buffer.from(thumbResp.data));
        }

        // 202 = generating, 302 = placeholder — try Representations API as fallback
        const repResp = await axios.get(`${BOX_API_BASE}/files/${fileId}`, {
            params: { fields: 'representations' },
            headers: {
                'Authorization': `Bearer ${token}`,
                'X-Rep-Hints': '[jpg?dimensions=320x320]'
            },
            timeout: 5000
        });
        const reps = repResp.data.representations?.entries || [];
        const jpgRep = reps.find(r => r.representation === 'jpg' && r.status?.state === 'success');
        if (jpgRep?.content?.url_template) {
            const repUrl = jpgRep.content.url_template.replace('{+asset_path}', '');
            const imgResp = await axios.get(repUrl, {
                headers: { 'Authorization': `Bearer ${token}` },
                responseType: 'arraybuffer',
                timeout: 8000
            });
            res.set('Content-Type', 'image/jpeg');
            res.set('Cache-Control', 'public, max-age=3600');
            return res.send(Buffer.from(imgResp.data));
        }

        // No thumbnail available
        res.status(404).json({ error: 'No thumbnail available' });
    } catch (err) {
        if (err.response?.status === 401) {
            boxAccessToken = null;
            boxTokenExpiry = 0;
        }
        res.status(err.response?.status || 500).json({ error: 'Thumbnail fetch failed' });
    }
});

/**
 * POST /api/box/shared-link
 *
 * Create an open shared link for a Box file.
 * Body: { fileId }
 * Returns: { sharedLink, downloadUrl }
 */
router.post('/box/shared-link', async (req, res) => {
    const { fileId } = req.body;

    if (!fileId) {
        return res.status(400).json({ success: false, error: 'Missing fileId' });
    }

    try {
        const sharedLink = await createSharedLink(fileId);
        res.json({
            success: true,
            sharedLink: sharedLink.url,
            downloadUrl: sharedLink.download_url || sharedLink.url
        });
    } catch (err) {
        console.error('Box shared-link error:', err.response ? JSON.stringify(err.response.data) : err.message);
        if (err.response?.status === 401) {
            boxAccessToken = null;
            boxTokenExpiry = 0;
        }
        res.status(500).json({ success: false, error: 'Failed to create shared link: ' + (err.message || 'Unknown error') });
    }
});

/**
 * DELETE /api/box/file/:fileId
 *
 * Delete a file from Box permanently.
 * Returns { success: true } on success. 404 treated as success (idempotent).
 */
router.delete('/box/file/:fileId', async (req, res) => {
    const { fileId } = req.params;

    if (!fileId) {
        return res.status(400).json({ success: false, error: 'Missing fileId' });
    }

    try {
        const token = await getBoxAccessToken();

        await axios.delete(`${BOX_API_BASE}/files/${fileId}`, {
            headers: { 'Authorization': `Bearer ${token}` },
            timeout: 15000
        });

        console.log(`Box: Deleted file ID ${fileId}`);
        res.json({ success: true });

    } catch (err) {
        console.error('Box delete error:', err.response ? JSON.stringify(err.response.data) : err.message);

        if (err.response?.status === 401) {
            boxAccessToken = null;
            boxTokenExpiry = 0;
            return res.status(502).json({ success: false, error: 'Box authentication failed.' });
        }
        if (err.response?.status === 404) {
            return res.json({ success: true, note: 'File not found (may already be deleted)' });
        }
        if (err.response?.status === 429) {
            return res.status(429).json({ success: false, error: 'Box rate limited. Please wait a moment.' });
        }

        res.status(500).json({ success: false, error: 'Failed to delete file: ' + (err.message || 'Unknown error') });
    }
});

/**
 * POST /api/art-requests/:designId/upload-mockup-url
 *
 * Save a mockup URL (e.g., Box shared link) to the first empty Caspio slot.
 * Body: { pkId, url }
 */
router.post('/art-requests/:designId/upload-mockup-url', async (req, res) => {
    const { pkId, url } = req.body;
    if (!pkId || !url) {
        return res.status(400).json({ success: false, error: 'Missing pkId or url' });
    }

    try {
        const slotField = await findEmptyMockupSlot(pkId);
        if (!slotField) {
            return res.status(409).json({ success: false, error: 'All mockup slots full', code: 'SLOTS_FULL' });
        }
        await saveMockupUrlToCaspio(pkId, slotField, url);

        // Fire-and-forget: AI vision analysis from URL
        try {
            const { analyzeMockupFromUrl } = require('../utils/mockup-vision');
            const { designId } = req.params;
            analyzeMockupFromUrl(url, {
                designId,
                slotField,
            }).catch(err => console.warn('[Vision] URL analysis failed (non-blocking):', err.message));
        } catch (visionErr) {
            console.warn('[Vision] Module load failed (non-blocking):', visionErr.message);
        }

        res.json({ success: true, field: slotField, url });
    } catch (err) {
        console.error('Save mockup URL error:', err.message);
        res.status(500).json({ success: false, error: 'Failed to save URL: ' + err.message });
    }
});

// ── Ruth Digitizing Mockup Box Endpoints ─────────────────────────────

// In-memory cache for mockup customer folders (separate from Steve's art folders)
const mockupFolderCache = new Map();

/**
 * Find a customer folder inside Ruth's mockup parent folder.
 * Folders named by company name (e.g., "Starbucks", "Boeing").
 */
async function findMockupCustomerFolder(companyName) {
    const nameKey = companyName.trim().toLowerCase();

    if (mockupFolderCache.has(nameKey)) {
        return mockupFolderCache.get(nameKey);
    }

    const token = await getBoxAccessToken();

    try {
        const resp = await axios.get(`${BOX_API_BASE}/search`, {
            params: {
                query: companyName.trim(),
                type: 'folder',
                ancestor_folder_ids: BOX_MOCKUP_FOLDER_ID,
                fields: 'id,name,type',
                limit: 10
            },
            headers: { 'Authorization': `Bearer ${token}` },
            timeout: 15000
        });

        const entries = resp.data.entries || [];
        for (const entry of entries) {
            if (entry.type === 'folder' && entry.name.toLowerCase() === nameKey) {
                mockupFolderCache.set(nameKey, entry);
                return entry;
            }
        }
    } catch (searchErr) {
        console.log('Box: Mockup folder search failed, falling back to listing:', searchErr.message);
        const resp = await axios.get(`${BOX_API_BASE}/folders/${BOX_MOCKUP_FOLDER_ID}/items`, {
            params: { fields: 'id,name,type', limit: 200, offset: 0 },
            headers: { 'Authorization': `Bearer ${token}` },
            timeout: 15000
        });
        const entries = resp.data.entries || [];
        for (const entry of entries) {
            if (entry.type === 'folder' && entry.name.toLowerCase() === nameKey) {
                mockupFolderCache.set(nameKey, entry);
                return entry;
            }
        }
    }

    return null;
}

/**
 * Create a customer folder inside Ruth's mockup parent folder.
 */
async function createMockupCustomerFolder(companyName) {
    const folderName = companyName.trim().substring(0, 255);
    try {
        const resp = await boxRequest('POST', `${BOX_API_BASE}/folders`, {
            name: folderName,
            parent: { id: BOX_MOCKUP_FOLDER_ID }
        }, { 'Content-Type': 'application/json' });
        console.log(`Box: Created mockup folder "${folderName}" (ID: ${resp.data.id})`);
        mockupFolderCache.set(folderName.toLowerCase(), resp.data);
        return resp.data;
    } catch (err) {
        if (err.response && err.response.status === 409) {
            const conflicts = err.response.data?.context_info?.conflicts;
            if (conflicts && conflicts.length > 0) {
                const existing = conflicts[0];
                console.log(`Box: Mockup folder already exists "${existing.name}" (ID: ${existing.id})`);
                mockupFolderCache.set(folderName.toLowerCase(), existing);
                return existing;
            }
        }
        throw err;
    }
}

/**
 * GET /api/box/mockup-folders?limit=100&offset=0
 *
 * List all customer folders inside Ruth's mockup parent folder.
 */
router.get('/box/mockup-folders', async (req, res) => {
    if (!BOX_MOCKUP_FOLDER_ID) {
        return res.status(500).json({ success: false, error: 'BOX_MOCKUP_FOLDER_ID not configured' });
    }

    const limit = Math.min(parseInt(req.query.limit) || 100, 500);
    const offset = parseInt(req.query.offset) || 0;

    try {
        const token = await getBoxAccessToken();

        const resp = await axios.get(`${BOX_API_BASE}/folders/${BOX_MOCKUP_FOLDER_ID}/items`, {
            params: {
                fields: 'id,name,type',
                limit,
                offset,
                sort: 'name',
                direction: 'ASC'
            },
            headers: { 'Authorization': `Bearer ${token}` },
            timeout: 15000
        });

        const folders = (resp.data.entries || []).filter(e => e.type === 'folder');
        const totalCount = resp.data.total_count || 0;

        res.json({
            success: true,
            folders: folders.map(f => ({ id: f.id, name: f.name })),
            total_count: totalCount,
            hasMore: (offset + limit) < totalCount
        });

    } catch (err) {
        console.error('Box mockup-folders error:', err.response ? JSON.stringify(err.response.data) : err.message);
        if (err.response?.status === 401) {
            boxAccessToken = null;
            boxTokenExpiry = 0;
        }
        res.status(500).json({ success: false, error: 'Failed to list mockup folders: ' + (err.message || 'Unknown error') });
    }
});

/**
 * POST /api/box/create-mockup-folder
 *
 * Auto-create a customer folder inside Ruth's mockup parent folder.
 * Body: { companyName }
 * Returns: { success, folderId, folderName }
 */
router.post('/box/create-mockup-folder', async (req, res) => {
    if (!BOX_MOCKUP_FOLDER_ID) {
        return res.status(500).json({ success: false, error: 'BOX_MOCKUP_FOLDER_ID not configured' });
    }

    const { companyName } = req.body;
    if (!companyName) {
        return res.status(400).json({ success: false, error: 'Missing companyName' });
    }

    try {
        // Check if folder already exists
        let folder = await findMockupCustomerFolder(companyName);
        if (!folder) {
            folder = await createMockupCustomerFolder(companyName);
        }

        res.json({
            success: true,
            folderId: folder.id,
            folderName: folder.name,
            created: !mockupFolderCache.has(companyName.trim().toLowerCase())
        });

    } catch (err) {
        console.error('Box create-mockup-folder error:', err.response ? JSON.stringify(err.response.data) : err.message);
        if (err.response?.status === 401) {
            boxAccessToken = null;
            boxTokenExpiry = 0;
        }
        res.status(500).json({ success: false, error: 'Failed to create folder: ' + (err.message || 'Unknown error') });
    }
});

/**
 * POST /api/box/upload-to-folder
 *
 * Lightweight file upload directly to an existing Box folder.
 * No slot tracking, no versioning — just upload and return.
 * Body (multipart/form-data):
 *   - file: the image/PDF file
 *   - folderId: Box folder ID to upload into
 *   - fileName: (optional) custom file name; defaults to original filename
 */
router.post('/box/upload-to-folder', upload.single('file'), async (req, res) => {
    const { folderId } = req.body;
    const customName = req.body.fileName;

    if (!req.file) {
        return res.status(400).json({ success: false, error: 'No file provided' });
    }
    if (!folderId) {
        return res.status(400).json({ success: false, error: 'Missing folderId' });
    }

    const fileName = customName || req.file.originalname;

    try {
        let boxFile;
        try {
            boxFile = await uploadFileToBox(folderId, fileName, req.file.buffer, req.file.mimetype);
        } catch (uploadErr) {
            // Handle 409 duplicate name — append timestamp suffix
            if (uploadErr.response && uploadErr.response.status === 409) {
                const ts = Date.now().toString(36);
                const ext = fileName.split('.').pop();
                const base = fileName.replace(/\.[^.]+$/, '');
                const altName = `${base}_${ts}.${ext}`;
                boxFile = await uploadFileToBox(folderId, altName, req.file.buffer, req.file.mimetype);
            } else {
                throw uploadErr;
            }
        }

        res.json({
            success: true,
            fileId: boxFile.id,
            fileName: boxFile.name
        });
    } catch (err) {
        console.error('Box upload-to-folder error:', err.message);
        res.status(500).json({ success: false, error: err.message });
    }
});

/**
 * POST /api/mockups/:id/upload-file
 *
 * Upload a mockup file for Ruth's digitizing work.
 * Body (multipart/form-data):
 *   - file: the image/PDF file
 *   - companyName: customer company name (for folder lookup/creation)
 *   - slot: which field to save to ("Box_Mockup_1", "Box_Mockup_2", "Box_Mockup_3", or "Box_Reference_File")
 *   - designNumber: design number (for file naming)
 */
router.post('/mockups/:id/upload-file', upload.single('file'), async (req, res) => {
    const { id } = req.params;
    const { companyName, slot, designNumber } = req.body;

    if (!req.file) {
        return res.status(400).json({ success: false, error: 'No file provided', code: 'NO_FILE' });
    }
    if (!companyName) {
        return res.status(400).json({ success: false, error: 'Missing companyName', code: 'MISSING_COMPANY' });
    }

    const VALID_SLOTS = ['Box_Mockup_1', 'Box_Mockup_2', 'Box_Mockup_3', 'Box_Reference_File'];
    const targetSlot = slot || 'Box_Mockup_1';
    if (!VALID_SLOTS.includes(targetSlot)) {
        return res.status(400).json({ success: false, error: `Invalid slot. Must be one of: ${VALID_SLOTS.join(', ')}`, code: 'INVALID_SLOT' });
    }

    const file = req.file;
    console.log(`Mockup upload: ID ${id}, slot ${targetSlot}, file "${file.originalname}" (${(file.size / 1024).toFixed(1)} KB)`);

    try {
        // 1. Find or create customer folder in Ruth's mockup folder
        let folder = await findMockupCustomerFolder(companyName);
        if (!folder) {
            folder = await createMockupCustomerFolder(companyName);
        }
        console.log(`Mockup upload: Using folder "${folder.name}" (ID: ${folder.id})`);

        // 2. Query next version number BEFORE building filename (need it for versioned naming)
        const ext = file.originalname.split('.').pop() || 'jpg';
        const shortCompany = companyName.substring(0, 30).trim();
        const slotLabel = targetSlot === 'Box_Reference_File' ? 'Reference' : targetSlot.replace('Box_Mockup_', 'Mockup');

        let nextVer = 1;
        let vRecords = [];
        try {
            const earlyToken = await getCaspioAccessToken();
            const versionResp = await axios.get(
                `${config.caspio.apiBaseUrl}/tables/Digitizing_Mockup_Versions/records`,
                {
                    params: {
                        'q.where': `Mockup_ID=${id} AND Slot_Key='${targetSlot}'`,
                        'q.orderBy': 'Version_Number DESC',
                        'q.pageSize': 1
                    },
                    headers: { 'Authorization': `Bearer ${earlyToken}` }
                }
            );
            vRecords = versionResp.data.Result || [];
            nextVer = vRecords.length > 0 ? vRecords[0].Version_Number + 1 : 1;
        } catch (verLookupErr) {
            console.error('Version lookup failed (using v1):', verLookupErr.message);
        }

        const fileName = `${shortCompany} ${slotLabel} ${designNumber || id} v${nextVer}.${ext}`.replace(/[<>:"/\\|?*]/g, '');

        // 3. Upload to Box
        let boxFile;
        try {
            boxFile = await uploadFileToBox(folder.id, fileName, file.buffer, file.mimetype);
        } catch (uploadErr) {
            if (uploadErr.response && uploadErr.response.status === 409) {
                const ts = Date.now().toString(36);
                const altName = `${shortCompany} ${slotLabel} ${designNumber || id} v${nextVer}_${ts}.${ext}`.replace(/[<>:"/\\|?*]/g, '');
                boxFile = await uploadFileToBox(folder.id, altName, file.buffer, file.mimetype);
            } else {
                throw uploadErr;
            }
        }
        console.log(`Mockup upload: File uploaded as "${boxFile.name}" (ID: ${boxFile.id})`);

        // 4. Create shared link
        const sharedLink = await createSharedLink(boxFile.id);
        const sharedUrl = sharedLink.download_url || sharedLink.url;
        console.log(`Mockup upload: Shared link: ${sharedUrl}`);

        // 5. Save URL to Caspio Digitizing_Mockups table
        const caspioToken = await getCaspioAccessToken();
        const updateData = {
            [targetSlot]: sharedUrl,
            Box_Folder_ID: folder.id
        };

        await axios.put(
            `${config.caspio.apiBaseUrl}/tables/Digitizing_Mockups/records?q.where=ID=${id}`,
            updateData,
            {
                headers: {
                    'Authorization': `Bearer ${caspioToken}`,
                    'Content-Type': 'application/json'
                },
                timeout: 15000
            }
        );

        console.log(`Mockup upload: Saved ${targetSlot} URL for mockup ${id}`);

        // 6. Insert version record (fire-and-forget — reuses nextVer/vRecords from step 2)
        try {
            // Mark previous versions not current
            if (vRecords.length > 0) {
                await axios.put(
                    `${config.caspio.apiBaseUrl}/tables/Digitizing_Mockup_Versions/records`,
                    { Is_Current: 'No' },
                    {
                        params: { 'q.where': `Mockup_ID=${id} AND Slot_Key='${targetSlot}'` },
                        headers: { 'Authorization': `Bearer ${caspioToken}`, 'Content-Type': 'application/json' }
                    }
                );
            }

            // Insert new version
            await axios.post(
                `${config.caspio.apiBaseUrl}/tables/Digitizing_Mockup_Versions/records`,
                {
                    Mockup_ID: parseInt(id),
                    Slot_Key: targetSlot,
                    Version_Number: nextVer,
                    File_URL: sharedUrl,
                    File_Name: boxFile.name || file.originalname,
                    Box_File_ID: String(boxFile.id),
                    Uploaded_By: 'Ruth',
                    Uploaded_Date: new Date().toISOString(),
                    Is_Current: 'Yes',
                    Notes: ''
                },
                { headers: { 'Authorization': `Bearer ${caspioToken}`, 'Content-Type': 'application/json' } }
            );
            console.log(`Mockup upload: Version ${nextVer} recorded for mockup ${id}, slot ${targetSlot}`);
        } catch (versionErr) {
            console.error('Version tracking failed (non-blocking):', versionErr.message);
        }

        // 7. Return success
        res.json({
            success: true,
            slot: targetSlot,
            url: sharedUrl,
            boxFileId: boxFile.id,
            boxFileName: boxFile.name,
            folderId: folder.id,
            folderName: folder.name
        });

    } catch (err) {
        console.error('Mockup upload error:', err.response ? JSON.stringify(err.response.data) : err.message);

        if (err.response) {
            const status = err.response.status;
            if (status === 401) {
                boxAccessToken = null;
                boxTokenExpiry = 0;
                return res.status(502).json({ success: false, error: 'Box authentication failed. Please retry.', code: 'BOX_AUTH_FAILED' });
            }
            if (status === 403) {
                return res.status(403).json({ success: false, error: 'Box permission denied.', code: 'BOX_PERMISSION_DENIED' });
            }
            if (status === 429) {
                return res.status(429).json({ success: false, error: 'Box rate limited. Please wait and retry.', code: 'BOX_RATE_LIMITED' });
            }
        }

        res.status(500).json({
            success: false,
            error: 'Failed to upload mockup file: ' + (err.message || 'Unknown error'),
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

// ── Download Box File Content ─────────────────────────────────────────
// GET /api/box/download/:fileId
// Proxies the raw file content from Box → client (for DST/EMB reprocessing)
router.get('/box/download/:fileId', async (req, res) => {
    try {
        const { fileId } = req.params;
        if (!fileId) {
            return res.status(400).json({ success: false, error: 'fileId required' });
        }

        const token = await getBoxAccessToken();

        // Get file info first (for filename + size)
        const infoResp = await axios.get(`${BOX_API_BASE}/files/${fileId}`, {
            headers: { 'Authorization': `Bearer ${token}` },
            timeout: 15000
        });
        const fileName = infoResp.data.name || 'download';
        const fileSize = infoResp.data.size || 0;

        // Download file content
        const contentResp = await axios.get(`${BOX_API_BASE}/files/${fileId}/content`, {
            headers: { 'Authorization': `Bearer ${token}` },
            responseType: 'arraybuffer',
            timeout: 60000,
            maxRedirects: 5
        });

        // Determine content type from extension
        const ext = fileName.split('.').pop().toLowerCase();
        const mimeTypes = {
            'dst': 'application/octet-stream',
            'emb': 'application/octet-stream',
            'pdf': 'application/pdf',
            'png': 'image/png',
            'jpg': 'image/jpeg',
            'jpeg': 'image/jpeg',
            'svg': 'image/svg+xml'
        };
        const contentType = mimeTypes[ext] || 'application/octet-stream';

        res.set({
            'Content-Type': contentType,
            'Content-Disposition': `attachment; filename="${fileName}"`,
            'Content-Length': contentResp.data.length,
            'Cache-Control': 'no-cache'
        });
        res.send(Buffer.from(contentResp.data));
    } catch (err) {
        console.error('Box download error:', err.response?.status, err.message);
        const status = err.response?.status || 500;
        res.status(status).json({ success: false, error: 'Box download failed: ' + err.message });
    }
});

module.exports = router;
