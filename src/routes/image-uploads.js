// Image Uploads API — general image library backed by Caspio Image_Uploads_Data_Base.
// One POST stores the image bytes in Caspio Files AND creates the library record,
// so callers (Claude sessions, staff tools, scripts) get a servable URL back in a
// single call. Erik's manual path — the Caspio upload DataPage — writes the same
// table; this is the automation path.
//
//   POST /api/image-uploads           multipart: file + description/aiText/style/vendor
//   GET  /api/image-uploads           list records (vendor/style/q filters, newest first)
//   GET  /api/image-uploads/:imageId  single record by Image_ID
//
// Verified against live Caspio 2026-07-10 (probe before build):
//   - v3 record INSERT accepts a File field as a files-storage path string
//     ("/Artwork/name.png") — no attachments API round-trip needed.
//   - Vendor (LIST-STRING) accepts a JSON array ["Sanmar"] and matches values
//     case-insensitively; v2 reads return it as an object {"4":"Sanmar"}.
//   - Date (TIMESTAMP) auto-stamps on insert — never written here.
//   - cdn.caspio.com does NOT serve the Artwork folder (403), so URL uses this
//     proxy's own GET /api/files/:externalKey streamer (same pattern the
//     ManageOrders push client uses for ShopWorks image URLs).
const express = require('express');
const router = express.Router();
const axios = require('axios');
const FormData = require('form-data');
const multer = require('multer');
const config = require('../../config');
const { getCaspioAccessToken, fetchAllCaspioPages } = require('../utils/caspio');

const TABLE = 'Image_Uploads_Data_Base';
const caspioV3BaseUrl = config.caspio.apiV3BaseUrl || `https://${config.caspio.domain}/integrations/rest/v3`;
// Dedicated library folder can be supplied later without a code change;
// until then images live beside the art uploads in the Artwork folder.
// KEY and PATH describe the same folder and must be changed together — the
// File field stores the "/FolderName/file.png" path, uploads target the key.
const uploadsFolderKey = process.env.CASPIO_IMAGE_UPLOADS_FOLDER_KEY || config.caspio.artworkFolderKey;
const uploadsFolderPath = process.env.CASPIO_IMAGE_UPLOADS_FOLDER_PATH || '/Artwork';
const PROXY_BASE_URL = process.env.PROXY_BASE_URL || 'https://caspio-pricing-proxy-ab30a049961a.herokuapp.com';

// Live list-field options as of 2026-07-10 — used only to CANONICALIZE case
// ("sanmar" → "Sanmar"). Unknown values still pass through to Caspio so a
// grown list keeps working without a proxy deploy; Caspio stays the authority.
const KNOWN_VENDORS = ['Marketing', 'NWCA', 'Richardson', 'Sanmar', 'JDS'];

// Images only — this table is an image library, not general file storage
// (use POST /api/files/upload for art formats like PDF/EPS/PSD).
const ALLOWED_IMAGE_MIME = [
    'image/png', 'image/jpeg', 'image/jpg', 'image/gif',
    'image/webp', 'image/svg+xml', 'image/bmp', 'image/avif'
];

const FIELD_LIMITS = { Description: 255, Style: 255, URL: 255, AI_Text: 64000 };

const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 20 * 1024 * 1024 }, // matches /api/files/upload
    fileFilter: (req, file, cb) => {
        cb(null, ALLOWED_IMAGE_MIME.includes((file.mimetype || '').toLowerCase()));
    }
});

// Multer errors (size cap) otherwise fall through to the generic express
// handler as opaque 500s — translate them at the route boundary.
function uploadSingleImage(req, res, next) {
    upload.single('file')(req, res, (err) => {
        if (!err) return next();
        if (err.code === 'LIMIT_FILE_SIZE') {
            return res.status(413).json({ success: false, error: 'Image too large (20MB max)', code: 'FILE_TOO_LARGE' });
        }
        return res.status(400).json({ success: false, error: err.message || 'Upload failed', code: 'BAD_UPLOAD' });
    });
}

function sanitizeImageFilename(name) {
    const base = String(name || '').trim() || 'image.png';
    return base.replace(/[\\/]+/g, '_').replace(/[^\w.\- ]+/g, '_');
}

// Case-normalize against the known list; unknown values pass through trimmed.
function normalizeVendor(value) {
    const v = String(value || '').trim();
    if (!v) return null;
    return KNOWN_VENDORS.find(k => k.toLowerCase() === v.toLowerCase()) || v;
}

// v2 reads return LIST-STRING as {"4":"Sanmar"}; inserts echo arrays; tolerate both.
function vendorValues(raw) {
    if (!raw) return [];
    if (Array.isArray(raw)) return raw;
    if (typeof raw === 'object') return Object.values(raw);
    return [raw];
}

function buildImageUrl(externalKey) {
    return `${PROXY_BASE_URL}/api/files/${externalKey}`;
}

// Uniform response shape for library records.
function toApiShape(row, fileExtras = {}) {
    return {
        imageId: row.Image_ID,
        pkId: row.PK_ID,
        description: row.Description || '',
        style: row.Style || '',
        vendor: vendorValues(row.Vendor),
        aiText: row.AI_Text || '',
        url: row.URL || '',
        imagePath: row.Image_Database || '',
        date: row.Date || null,
        ...fileExtras
    };
}

function appendUniquenessSuffix(filename) {
    const ts = new Date().toISOString().replace(/[:.]/g, '-').replace('Z', '');
    const dot = filename.lastIndexOf('.');
    if (dot <= 0) return `${filename}_${ts}`;
    return `${filename.substring(0, dot)}_${ts}${filename.substring(dot)}`;
}

// Upload a Buffer into the library folder with one 409-rename retry
// (same proven pattern as files-simple.js uploadBufferToArtwork).
async function uploadImageBuffer(buffer, filename, mimeType) {
    const token = await getCaspioAccessToken();
    const url = `${caspioV3BaseUrl}/files?externalKey=${uploadsFolderKey}`;

    async function attempt(name) {
        const fd = new FormData();
        fd.append('Files', buffer, { filename: name, contentType: mimeType, knownLength: buffer.length });
        return axios.post(url, fd, {
            headers: { 'Authorization': `Bearer ${token}`, ...fd.getHeaders() },
            maxBodyLength: Infinity,
            maxContentLength: Infinity,
            timeout: 60000
        });
    }

    let response;
    try {
        response = await attempt(filename);
    } catch (err) {
        if (err.response && err.response.status === 409) {
            const renamed = appendUniquenessSuffix(filename);
            console.log(`[image-uploads] 409 collision on "${filename}", retrying as "${renamed}"`);
            response = await attempt(renamed);
        } else {
            throw err;
        }
    }
    if (response.data && response.data.Result && response.data.Result[0]) {
        return response.data.Result[0]; // { Name, ExternalKey }
    }
    throw new Error('Unexpected response from Caspio Files API');
}

// Best-effort rollback so a failed record insert never strands an orphan file.
async function deleteUploadedFile(externalKey) {
    try {
        const token = await getCaspioAccessToken();
        await axios.delete(`${caspioV3BaseUrl}/files/${encodeURIComponent(externalKey)}`, {
            headers: { 'Authorization': `Bearer ${token}` },
            timeout: 30000
        });
        console.log(`[image-uploads] rolled back orphan file ${externalKey}`);
    } catch (err) {
        console.error(`[image-uploads] ROLLBACK FAILED for file ${externalKey}:`, err.message);
    }
}

/**
 * POST /api/image-uploads
 * multipart/form-data: file (required, image) + optional text fields:
 *   description, aiText, style, vendor (Marketing|NWCA|Richardson|Sanmar|JDS), url
 * Stores the file in Caspio Files, then inserts the Image_Uploads_Data_Base
 * record referencing it. URL defaults to this proxy's /api/files/:key link.
 */
router.post('/image-uploads', uploadSingleImage, async (req, res) => {
    if (!req.file) {
        return res.status(400).json({
            success: false,
            error: 'No image provided — send multipart/form-data with a "file" field (PNG/JPG/GIF/WebP/SVG/BMP/AVIF)',
            code: 'NO_FILE'
        });
    }

    const body = req.body || {};
    const fields = {
        Description: String(body.description || '').trim(),
        Style: String(body.style || '').trim(),
        AI_Text: String(body.aiText || body.ai_text || '').trim(),
        URL: String(body.url || '').trim() // optional caller override; default set after upload
    };
    for (const [name, max] of Object.entries(FIELD_LIMITS)) {
        if (fields[name] && fields[name].length > max) {
            return res.status(400).json({
                success: false,
                error: `${name} exceeds ${max} characters (got ${fields[name].length})`,
                code: 'FIELD_TOO_LONG'
            });
        }
    }
    const vendor = normalizeVendor(body.vendor);

    let uploadedFile = null;
    try {
        const cleanName = sanitizeImageFilename(req.file.originalname);
        uploadedFile = await uploadImageBuffer(req.file.buffer, cleanName, req.file.mimetype);

        const record = {
            Image_Database: `${uploadsFolderPath}/${uploadedFile.Name}`,
            URL: fields.URL || buildImageUrl(uploadedFile.ExternalKey),
            Description: fields.Description,
            AI_Text: fields.AI_Text,
            Style: fields.Style
        };
        if (vendor) record.Vendor = [vendor];

        const token = await getCaspioAccessToken();
        const ins = await axios.post(
            `${caspioV3BaseUrl}/tables/${TABLE}/records?response=rows`,
            record,
            { headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' }, timeout: 30000 }
        );
        const row = ins.data && ins.data.Result && ins.data.Result[0];
        if (!row) throw new Error('Caspio insert returned no row');

        console.log(`[image-uploads] stored ${row.Image_ID} ("${uploadedFile.Name}", ${req.file.size} bytes)`);
        return res.status(201).json({
            success: true,
            image: toApiShape(row, {
                fileExternalKey: uploadedFile.ExternalKey,
                fileName: uploadedFile.Name,
                size: req.file.size,
                mimeType: req.file.mimetype
            })
        });
    } catch (error) {
        // Never leave a file without its record (silent half-success) — roll back.
        if (uploadedFile && uploadedFile.ExternalKey) {
            await deleteUploadedFile(uploadedFile.ExternalKey);
        }
        const status = error.response && error.response.status;
        const caspioBody = error.response && error.response.data;
        console.error('[image-uploads] upload failed:', status || '', error.message, caspioBody ? JSON.stringify(caspioBody) : '');
        if (error.code === 'ECONNABORTED' || error.code === 'ECONNRESET' || /socket hang up|timeout/i.test(error.message || '')) {
            return res.status(504).json({ success: false, error: 'The image upload timed out reaching Caspio. Please try again.', code: 'UPLOAD_TIMEOUT' });
        }
        return res.status(status && status >= 400 && status < 500 ? 400 : 500).json({
            success: false,
            error: 'Failed to store image' + (caspioBody && caspioBody.Message ? `: ${caspioBody.Message}` : ''),
            code: 'IMAGE_UPLOAD_FAILED',
            details: caspioBody || error.message
        });
    }
});

/**
 * GET /api/image-uploads
 * List library records, newest first. Optional filters (applied in JS — the
 * library is small and LIST-STRING where-clauses are a known 500 trap):
 *   ?vendor=Sanmar   ?style=PC54   ?q=cap   ?limit=100 (max 500)
 */
router.get('/image-uploads', async (req, res) => {
    try {
        const rows = await fetchAllCaspioPages(`/tables/${TABLE}/records`, {
            'q.orderBy': 'Date DESC'
        });

        const vendor = String(req.query.vendor || '').trim().toLowerCase();
        const style = String(req.query.style || '').trim().toLowerCase();
        const q = String(req.query.q || '').trim().toLowerCase();
        const limit = Math.min(parseInt(req.query.limit, 10) || 100, 500);

        let images = rows.map(r => toApiShape(r));
        if (vendor) images = images.filter(i => i.vendor.some(v => String(v).toLowerCase() === vendor));
        if (style) images = images.filter(i => i.style.toLowerCase() === style);
        if (q) {
            images = images.filter(i =>
                i.description.toLowerCase().includes(q) ||
                i.aiText.toLowerCase().includes(q) ||
                i.style.toLowerCase().includes(q));
        }

        return res.json({ success: true, count: Math.min(images.length, limit), total: images.length, images: images.slice(0, limit) });
    } catch (error) {
        console.error('[image-uploads] list failed:', error.message);
        return res.status(500).json({ success: false, error: 'Failed to fetch image library', code: 'LIST_FAILED' });
    }
});

/**
 * GET /api/image-uploads/:imageId — single record by Image_ID (Random ID).
 * Strict alphanumeric guard doubles as q.where injection protection.
 */
router.get('/image-uploads/:imageId', async (req, res) => {
    const imageId = String(req.params.imageId || '').trim();
    if (!/^[A-Za-z0-9]{4,20}$/.test(imageId)) {
        return res.status(400).json({ success: false, error: 'Invalid image id', code: 'BAD_ID' });
    }
    try {
        const rows = await fetchAllCaspioPages(`/tables/${TABLE}/records`, {
            'q.where': `Image_ID='${imageId}'`
        });
        if (!rows || rows.length === 0) {
            return res.status(404).json({ success: false, error: 'Image not found', code: 'NOT_FOUND' });
        }
        return res.json({ success: true, image: toApiShape(rows[0]) });
    } catch (error) {
        console.error('[image-uploads] get failed:', error.message);
        return res.status(500).json({ success: false, error: 'Failed to fetch image record', code: 'GET_FAILED' });
    }
});

module.exports = router;
// Helpers exported for jest (tests/jest/image-uploads-route.test.js)
module.exports.normalizeVendor = normalizeVendor;
module.exports.vendorValues = vendorValues;
module.exports.sanitizeImageFilename = sanitizeImageFilename;
module.exports.buildImageUrl = buildImageUrl;
module.exports.toApiShape = toApiShape;
