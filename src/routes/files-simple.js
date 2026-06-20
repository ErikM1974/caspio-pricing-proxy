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

        // Get token
        const token = await getCaspioAccessToken();
        const url = `${caspioV3BaseUrl}/files?externalKey=${artworkFolderKey}`;

        // Inner helper — does one upload attempt with a given filename.
        // We may call this twice: once with the original name, and (on a 409
        // FILE_EXISTS collision) once more with a timestamp suffix.
        async function attemptUpload(filename) {
            const fd = new FormData();
            // Append the Buffer DIRECTLY (not Readable.from(buffer)): form-data then sends a real
            // Content-Length so Caspio doesn't receive chunked transfer-encoding (which it resets →
            // "socket hang up"). A Buffer is also reusable, so the 409-rename retry below no longer
            // sends an already-consumed (empty) stream. + timeout so a hung connection fails fast.
            // Mirrors the working sibling thumbnails.js. (audit fix 2026-06-05)
            fd.append('Files', file.buffer, {
                filename: filename,
                contentType: file.mimetype,
                knownLength: file.buffer.length
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
            response = await attemptUpload(file.originalname);
        } catch (err) {
            // On 409 FILE_EXISTS the Caspio Artwork folder already has a file
            // with this exact name (possibly from a different customer's
            // earlier submission — the folder is global). Retry once with a
            // timestamp suffix so generic names like
            // "40091 Braun NW Mock1 WF copy.jpg" don't break the AE workflow.
            // Only retry on 409 — re-throw everything else.
            if (err.response && err.response.status === 409) {
                const renamed = appendUniquenessSuffix(file.originalname);
                console.log(`[files/upload] 409 collision on "${file.originalname}", retrying as "${renamed}"`);
                response = await attemptUpload(renamed);
            } else {
                throw err;
            }
        }

        if (response.data && response.data.Result && response.data.Result[0]) {
            const uploadedFile = response.data.Result[0];
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
        } else {
            throw new Error('Unexpected response from Caspio Files API');
        }
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

        // Forward headers from Caspio
        if (response.headers['content-type']) {
            res.setHeader('Content-Type', response.headers['content-type']);
        }
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