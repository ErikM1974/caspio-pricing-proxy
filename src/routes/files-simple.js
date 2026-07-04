// Simplified File Upload API Routes for Caspio Files API v3
// Forwards file uploads directly to Caspio without conversion
const express = require('express');
const router = express.Router();
const axios = require('axios');
const FormData = require('form-data');
const multer = require('multer');
const config = require('../../config');

// Allowed upload mimetypes — the art formats real callers send (designer PNG,
// tees/caps logos, vector art). EPS/AI/DST often arrive as octet-stream, so it's
// included. Anything else is rejected (multer drops the file → handler 400s).
const ALLOWED_UPLOAD_MIME = [
    'image/png', 'image/jpeg', 'image/jpg', 'image/gif', 'image/webp', 'image/svg+xml',
    'application/pdf', 'image/vnd.adobe.photoshop', 'application/postscript',
    'application/octet-stream'
];

// External file-key validation — see src/utils/where-guards.js.
const { isValidFileKey } = require('../utils/where-guards');

// Configure multer to store files in memory
const upload = multer({
    storage: multer.memoryStorage(),
    limits: {
        fileSize: 20 * 1024 * 1024 // 20MB max
    },
    fileFilter: (req, file, cb) => {
        cb(null, ALLOWED_UPLOAD_MIME.includes((file.mimetype || '').toLowerCase()));
    }
});

// Get Caspio v3 API URL and Artwork folder
const caspioV3BaseUrl = config.caspio.apiV3BaseUrl || `https://${config.caspio.domain}/rest/v3`;
const artworkFolderKey = config.caspio.artworkFolderKey;

// Simple token cache
let caspioAccessToken = null;
let tokenExpiryTime = 0;

// Get Caspio access token with caching
async function getCaspioAccessToken() {
    const now = Math.floor(Date.now() / 1000);
    const bufferSeconds = 60;

    if (caspioAccessToken && now < (tokenExpiryTime - bufferSeconds)) {
        return caspioAccessToken;
    }

    console.log("Files route: Requesting new Caspio access token...");
    try {
        const response = await axios.post(config.caspio.tokenUrl, new URLSearchParams({
            'grant_type': 'client_credentials',
            'client_id': config.caspio.clientId,
            'client_secret': config.caspio.clientSecret
        }), {
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            timeout: 15000
        });

        if (response.data && response.data.access_token) {
            caspioAccessToken = response.data.access_token;
            tokenExpiryTime = now + response.data.expires_in;
            console.log("Files route: Token obtained successfully");
            return caspioAccessToken;
        } else {
            throw new Error("Invalid response from token endpoint");
        }
    } catch (error) {
        console.error("Files route: Error getting Caspio token:", error.message);
        caspioAccessToken = null;
        tokenExpiryTime = 0;
        throw new Error("Could not obtain Caspio access token");
    }
}

/**
 * Append a sortable timestamp before the file extension so a new upload can't
 * collide with an existing file in the Caspio Artwork folder. Used as the
 * retry name when the original upload returns 409 FILE_EXISTS.
 *
 *   "40091 Braun NW Mock1 WF copy.jpg"
 *      → "40091 Braun NW Mock1 WF copy_2026-05-08T18-02-34-123.jpg"
 *
 * Includes milliseconds to make near-simultaneous retries from different
 * users still resolve to distinct names.
 */
function appendUniquenessSuffix(filename) {
    const ts = new Date().toISOString().replace(/[:.]/g, '-').replace('Z', '');
    const dot = filename.lastIndexOf('.');
    if (dot <= 0) return `${filename}_${ts}`;
    return `${filename.substring(0, dot)}_${ts}${filename.substring(dot)}`;
}

/**
 * Upload a raw Buffer to the Caspio Artwork folder, with one 409-rename retry.
 * Shared by POST /files/upload (multipart) and POST /files/import-from-url
 * (server-side fetch). Returns the Caspio Result[0] object ({ Name, ExternalKey, ... }).
 *
 * The Buffer is appended DIRECTLY (not Readable.from()) so form-data sends a real
 * Content-Length — Caspio resets chunked transfer-encoding (the old "socket hang up").
 * A Buffer is also reusable, so the 409-rename retry below resends real bytes.
 */
async function uploadBufferToArtwork(buffer, originalName, mimeType) {
    const token = await getCaspioAccessToken();
    const url = `${caspioV3BaseUrl}/files?externalKey=${artworkFolderKey}`;

    async function attemptUpload(filename) {
        const fd = new FormData();
        fd.append('Files', buffer, {
            filename: filename,
            contentType: mimeType,
            knownLength: buffer.length
        });
        return axios.post(url, fd, {
            headers: {
                'Authorization': `Bearer ${token}`,
                ...fd.getHeaders()
            },
            maxBodyLength: Infinity,
            maxContentLength: Infinity,
            timeout: 60000
        });
    }

    let response;
    try {
        response = await attemptUpload(originalName);
    } catch (err) {
        // On 409 FILE_EXISTS the global Artwork folder already has this exact
        // name (often a different customer's earlier submission). Retry once
        // with a timestamp suffix so generic names don't break the workflow.
        if (err.response && err.response.status === 409) {
            const renamed = appendUniquenessSuffix(originalName);
            console.log(`[files] 409 collision on "${originalName}", retrying as "${renamed}"`);
            response = await attemptUpload(renamed);
        } else {
            throw err;
        }
    }

    if (response.data && response.data.Result && response.data.Result[0]) {
        return response.data.Result[0];
    }
    throw new Error('Unexpected response from Caspio Files API');
}

// Map a content-type to a file extension so imported art keeps a usable name
// (Caspio's CDN_Link formula + downstream tooling key off the extension).
const MIME_TO_EXT = {
    'image/png': 'png', 'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/gif': 'gif',
    'image/webp': 'webp', 'image/svg+xml': 'svg', 'image/bmp': 'bmp', 'image/avif': 'avif',
    'application/pdf': 'pdf', 'image/vnd.adobe.photoshop': 'psd', 'application/postscript': 'eps'
};

/**
 * SSRF guard for POST /files/import-from-url. Only hosts where NWCA customer
 * art + mockups actually live may be fetched server-side. Everything else
 * (internal IPs, metadata endpoints, arbitrary hosts) is rejected. Note this
 * endpoint is staff-gated upstream and only ever receives URLs that already
 * live on a quote's own OrderSettingsJSON — the allowlist is defence in depth.
 */
function isAllowedArtworkHost(hostname) {
    const h = String(hostname || '').toLowerCase();
    if (!h) return false;
    const ALLOWED_SUFFIXES = [
        '.herokuapp.com',   // this proxy (/api/files/:key) + sibling NWCA apps
        '.caspio.com',      // Caspio files / CDN
        '.box.com',         // Box shared/static links
        '.boxcloud.com',    // Box CDN
        '.amazonaws.com',   // S3-hosted uploads
        '.teamnwca.com'     // NWCA front end
    ];
    const ALLOWED_EXACT = ['caspio.com', 'box.com', 'teamnwca.com'];
    if (ALLOWED_EXACT.includes(h)) return true;
    return ALLOWED_SUFFIXES.some(s => h.endsWith(s));
}

// --- API Endpoints ---

/**
 * POST /api/files/upload
 * Upload a file directly to Caspio Files API
 * Expects multipart/form-data with a 'file' field
 */
router.post('/files/upload', upload.single('file'), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({
                success: false,
                error: 'No file provided',
                code: 'NO_FILE'
            });
        }

        const file = req.file;
        console.log(`Uploading file: ${file.originalname} (${file.size} bytes, ${file.mimetype})`);

        const uploadedFile = await uploadBufferToArtwork(file.buffer, file.originalname, file.mimetype);
        console.log(`File uploaded successfully: ${uploadedFile.Name} (${uploadedFile.ExternalKey})`);

        res.json({
            success: true,
            externalKey: uploadedFile.ExternalKey,
            fileName: uploadedFile.Name,
            location: 'Artwork folder',
            originalName: file.originalname,
            size: file.size,
            mimeType: file.mimetype
        });
    } catch (error) {
        console.error('Error uploading file:', error.message);

        if (error.response?.status === 409) {
            // Should be rare — only fires if the rename retry ALSO collided
            // (millisecond-level race). Surface a clear error to the caller.
            res.status(409).json({
                success: false,
                error: 'A file with this name already exists in the Artwork folder',
                code: 'FILE_EXISTS'
            });
        } else if (error.response?.status === 415) {
            res.status(415).json({
                success: false,
                error: 'Unsupported file type',
                code: 'UNSUPPORTED_TYPE',
                details: error.response?.data
            });
        } else if (error.response?.status === 413) {
            res.status(413).json({
                success: false,
                error: 'File too large',
                code: 'FILE_TOO_LARGE'
            });
        } else if (error.code === 'ECONNABORTED' || error.code === 'ECONNRESET' || /socket hang up|timeout/i.test(error.message || '')) {
            // Network/timeout reaching Caspio (the old raw "socket hang up") — surface a clear,
            // retryable message instead of a generic 500. (audit fix 2026-06-05)
            res.status(504).json({
                success: false,
                error: 'The artwork upload timed out reaching Caspio. Please try again.',
                code: 'UPLOAD_TIMEOUT'
            });
        } else {
            res.status(500).json({
                success: false,
                error: error.message || 'Failed to upload file',
                code: 'UPLOAD_FAILED'
            });
        }
    }
});

/**
 * POST /api/files/import-from-url
 * Server-side "attach by URL": fetch an existing artwork URL (no browser CORS)
 * and upload its bytes into the Caspio Artwork folder, returning the same shape
 * as /files/upload. Powers "Send to Steve" — carrying a quote's customer art +
 * approved mockups into Steve's art request as real reference files.
 *
 * Body: { url (required), fileName (optional preferred name) }
 * Guards: host allowlist (SSRF), 20MB cap, art-type only (rejects HTML/error pages).
 * Never returns success without bytes actually stored (Erik's #1 rule).
 */
router.post('/files/import-from-url', express.json({ limit: '1mb' }), async (req, res) => {
    try {
        const { url, fileName } = req.body || {};
        if (!url || typeof url !== 'string') {
            return res.status(400).json({ success: false, error: 'No url provided', code: 'NO_URL' });
        }

        let parsed;
        try { parsed = new URL(url); } catch (_) {
            return res.status(400).json({ success: false, error: 'Invalid url', code: 'BAD_URL' });
        }
        if (!/^https?:$/.test(parsed.protocol) || !isAllowedArtworkHost(parsed.hostname)) {
            return res.status(400).json({
                success: false,
                error: `Refusing to fetch from an unapproved host: ${parsed.hostname}`,
                code: 'HOST_NOT_ALLOWED'
            });
        }

        // Fetch the bytes server-side.
        let dl;
        try {
            dl = await axios.get(url, {
                responseType: 'arraybuffer',
                timeout: 30000,
                maxContentLength: 20 * 1024 * 1024,
                maxBodyLength: 20 * 1024 * 1024,
                maxRedirects: 5,
                // SSRF: the allowlist check above only covers the INITIAL url. An
                // approved host could still 302 us onto an internal/metadata
                // address, so re-validate every redirect hop and abort if it
                // leaves the artwork allowlist. (Non-breaking for legit Box/Caspio
                // signed-URL redirects, which stay within approved hosts.)
                beforeRedirect: (options) => {
                    if (!/^https?:$/.test(options.protocol) || !isAllowedArtworkHost(options.hostname)) {
                        const e = new Error(`Refusing to follow redirect to unapproved host: ${options.hostname}`);
                        e.code = 'REDIRECT_BLOCKED';
                        throw e;
                    }
                }
            });
        } catch (err) {
            const status = err.response && err.response.status;
            console.warn('[files/import-from-url] fetch failed:', status, err.message);
            return res.status(502).json({
                success: false,
                error: 'Could not fetch the source artwork URL' + (status ? ` (HTTP ${status})` : ''),
                code: 'FETCH_FAILED'
            });
        }

        const buffer = Buffer.from(dl.data);
        if (!buffer.length) {
            return res.status(502).json({ success: false, error: 'Source URL returned no data', code: 'EMPTY_SOURCE' });
        }
        if (buffer.length > 20 * 1024 * 1024) {
            return res.status(413).json({ success: false, error: 'Source file too large (20MB max)', code: 'FILE_TOO_LARGE' });
        }

        // Resolve a usable mimetype. The proxy's own /api/files/:key derives the
        // real image type, but some sources return text/plain or octet-stream —
        // fall back to the extension of the preferred fileName. Reject obvious
        // non-art (an HTML error page) so we never store a broken "image".
        let mimeType = String((dl.headers['content-type'] || '')).split(';')[0].trim().toLowerCase();
        const nameExt = (String(fileName || '').split('.').pop() || '').toLowerCase();
        const EXT_TO_MIME = Object.fromEntries(Object.entries(MIME_TO_EXT).map(([m, e]) => [e, m]));
        if ((!mimeType || mimeType === 'application/octet-stream' || mimeType === 'text/plain' || mimeType === 'binary/octet-stream') && EXT_TO_MIME[nameExt]) {
            mimeType = EXT_TO_MIME[nameExt];
        }
        if (mimeType === 'text/html') {
            return res.status(422).json({ success: false, error: 'Source URL returned a web page, not an image', code: 'NOT_ARTWORK' });
        }
        if (!ALLOWED_UPLOAD_MIME.includes(mimeType)) {
            // Unknown but plausibly fine (e.g. octet-stream EPS/AI) — let Caspio
            // store it; default the mimetype so form-data still sends one.
            mimeType = mimeType || 'application/octet-stream';
        }

        // Build a filename: prefer the caller's, else the URL path tail, else a
        // generic name. Ensure it carries an extension matching the mimetype.
        let baseName = String(fileName || '').trim();
        if (!baseName) {
            const tail = decodeURIComponent((parsed.pathname.split('/').pop() || '')).trim();
            baseName = tail || 'quote-artwork';
        }
        if (!/\.[a-z0-9]{2,5}$/i.test(baseName)) {
            const ext = MIME_TO_EXT[mimeType] || 'png';
            baseName = `${baseName}.${ext}`;
        }
        // Strip path separators / odd chars that would break the Caspio path.
        baseName = baseName.replace(/[\\/]+/g, '_').replace(/[^\w.\- ]+/g, '_');

        const uploadedFile = await uploadBufferToArtwork(buffer, baseName, mimeType);
        console.log(`[files/import-from-url] stored "${uploadedFile.Name}" from ${parsed.hostname}`);

        return res.json({
            success: true,
            externalKey: uploadedFile.ExternalKey,
            fileName: uploadedFile.Name,
            location: 'Artwork folder',
            sourceUrl: url,
            size: buffer.length,
            mimeType
        });
    } catch (error) {
        console.error('[files/import-from-url] error:', error.message);
        if (error.response && error.response.status === 409) {
            return res.status(409).json({ success: false, error: 'A file with this name already exists in the Artwork folder', code: 'FILE_EXISTS' });
        }
        if (error.code === 'ECONNABORTED' || error.code === 'ECONNRESET' || /socket hang up|timeout/i.test(error.message || '')) {
            return res.status(504).json({ success: false, error: 'The artwork upload timed out reaching Caspio. Please try again.', code: 'UPLOAD_TIMEOUT' });
        }
        return res.status(500).json({ success: false, error: error.message || 'Failed to import artwork', code: 'IMPORT_FAILED' });
    }
});

/**
 * GET /api/files/:externalKey
 * Retrieve a file from Caspio by its ExternalKey
 */
router.get('/files/:externalKey', async (req, res) => {
    try {
        const { externalKey } = req.params;
        if (!isValidFileKey(externalKey)) {
            return res.status(400).json({ success: false, error: 'Invalid file key', code: 'BAD_KEY' });
        }

        // Get token
        const token = await getCaspioAccessToken();
        const url = `${caspioV3BaseUrl}/files/${encodeURIComponent(externalKey)}`;

        const response = await axios({
            method: 'get',
            url,
            headers: {
                'Authorization': `Bearer ${token}`
            },
            responseType: 'stream'
        });

        // Forward headers from Caspio. Caspio often returns Content-Type: text/plain for binary
        // files, which (with the global nosniff header) makes browsers REFUSE to render images in
        // an <img>. Derive the real MIME from the filename extension so images display inline.
        const cd = response.headers['content-disposition'] || '';
        const fn = /filename\*?=(?:UTF-8'')?["']?([^"';]+)/i.exec(cd);
        const ext = fn ? (fn[1].split('.').pop() || '').toLowerCase() : '';
        const EXT_MIME = {
            jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif',
            webp: 'image/webp', svg: 'image/svg+xml', bmp: 'image/bmp', pdf: 'application/pdf',
        };
        res.setHeader('Content-Type', EXT_MIME[ext] || response.headers['content-type'] || 'application/octet-stream');
        if (response.headers['content-disposition']) {
            res.setHeader('Content-Disposition', response.headers['content-disposition']);
        }

        // Stream the file to the client
        response.data.pipe(res);

    } catch (error) {
        console.error('Error retrieving file:', error.message);

        if (error.response?.status === 404) {
            res.status(404).json({
                success: false,
                error: 'File not found',
                code: 'FILE_NOT_FOUND'
            });
        } else {
            res.status(500).json({
                success: false,
                error: 'Failed to retrieve file',
                code: 'RETRIEVAL_FAILED'
            });
        }
    }
});

/**
 * GET /api/files/:externalKey/info
 * Get file metadata without downloading the file
 */
router.get('/files/:externalKey/info', async (req, res) => {
    try {
        const { externalKey } = req.params;
        if (!isValidFileKey(externalKey)) {
            return res.status(400).json({ success: false, error: 'Invalid file key', code: 'BAD_KEY' });
        }

        const token = await getCaspioAccessToken();
        const url = `${caspioV3BaseUrl}/files/${encodeURIComponent(externalKey)}/fileInfo`;

        const response = await axios.get(url, {
            headers: {
                'Authorization': `Bearer ${token}`
            }
        });

        if (response.data && response.data.Result) {
            res.json({
                success: true,
                ...response.data.Result,
                downloadUrl: `/api/files/${externalKey}`
            });
        } else {
            throw new Error('Unexpected response from Caspio');
        }
    } catch (error) {
        console.error('Error getting file info:', error.message);

        if (error.response?.status === 404) {
            res.status(404).json({
                success: false,
                error: 'File not found',
                code: 'FILE_NOT_FOUND'
            });
        } else {
            res.status(500).json({
                success: false,
                error: 'Failed to get file info',
                code: 'INFO_FAILED'
            });
        }
    }
});

/**
 * DELETE /api/files/:externalKey
 * Delete a file from Caspio.
 *
 * Caspio v3 semantics (verified against the live API 2026-06-18):
 *   - DELETE /files/{externalKey}  → 204 No Content on success. This path-style
 *     form is the ONLY supported one; DELETE on the /files collection
 *     (?externalKey=...) returns 405 Method Not Allowed.
 *   - A missing file returns 404 FileNotFound.
 *
 * This handler is intentionally idempotent: an already-absent file (404) is
 * the desired end state for orphan cleanup (e.g. re-saving a Shirt Designer
 * mockup deletes the prior Rep_Mockup file), so we report success rather than
 * forcing every caller to special-case 404. The catch block also logs the real
 * Caspio status + body — the old version logged only error.message ("Request
 * failed with status code NNN"), which made failures impossible to diagnose.
 */
router.delete('/files/:externalKey', async (req, res) => {
    const { externalKey } = req.params;
    if (!isValidFileKey(externalKey)) {
        return res.status(400).json({ success: false, error: 'Invalid file key', code: 'BAD_KEY' });
    }
    try {
        const token = await getCaspioAccessToken();
        const url = `${caspioV3BaseUrl}/files/${encodeURIComponent(externalKey)}`;

        const response = await axios.delete(url, {
            headers: {
                'Authorization': `Bearer ${token}`
            },
            timeout: 30000 // fail fast instead of hanging on a stalled Caspio connection
        });

        console.log(`File deleted successfully: ${externalKey} (Caspio ${response.status})`);
        res.json({
            success: true,
            message: 'File deleted successfully',
            externalKey
        });
    } catch (error) {
        const status = error.response?.status;
        console.error(
            `Error deleting file ${externalKey}: ${error.message}` +
            (status ? ` (Caspio ${status}: ${JSON.stringify(error.response?.data)})` : ` (${error.code || 'no response'})`)
        );

        if (status === 404) {
            // Already gone — treat delete as idempotent so orphan cleanup
            // doesn't fail when the prior file was already removed.
            return res.json({
                success: true,
                alreadyAbsent: true,
                message: 'File already absent',
                externalKey
            });
        }

        if (error.code === 'ECONNABORTED' || error.code === 'ECONNRESET' || /socket hang up|timeout/i.test(error.message || '')) {
            // Network/timeout reaching Caspio — surface a clear, retryable error
            // instead of a generic 500 (mirrors the upload route's handling).
            return res.status(504).json({
                success: false,
                error: 'The delete request timed out reaching Caspio. Please try again.',
                code: 'DELETE_TIMEOUT'
            });
        }

        res.status(500).json({
            success: false,
            error: 'Failed to delete file',
            code: 'DELETE_FAILED',
            status: status || null,
            details: error.response?.data || null
        });
    }
});

module.exports = router;