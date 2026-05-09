// Simplified File Upload API Routes for Caspio Files API v3
// Forwards file uploads directly to Caspio without conversion
const express = require('express');
const router = express.Router();
const axios = require('axios');
const FormData = require('form-data');
const multer = require('multer');
const { Readable } = require('stream');
const config = require('../../config');

// Configure multer to store files in memory
const upload = multer({
    storage: multer.memoryStorage(),
    limits: {
        fileSize: 20 * 1024 * 1024 // 20MB max
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
            const stream = Readable.from(file.buffer);
            fd.append('Files', stream, {
                filename: filename,
                contentType: file.mimetype
            });
            return axios.post(url, fd, {
                headers: {
                    'Authorization': `Bearer ${token}`,
                    ...fd.getHeaders()
                },
                maxBodyLength: Infinity,
                maxContentLength: Infinity
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

        // Get token
        const token = await getCaspioAccessToken();
        const url = `${caspioV3BaseUrl}/files/${externalKey}`;

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

        const token = await getCaspioAccessToken();
        const url = `${caspioV3BaseUrl}/files/${externalKey}/fileInfo`;

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
 * Delete a file from Caspio
 */
router.delete('/files/:externalKey', async (req, res) => {
    try {
        const { externalKey } = req.params;

        const token = await getCaspioAccessToken();
        const url = `${caspioV3BaseUrl}/files/${externalKey}`;

        await axios.delete(url, {
            headers: {
                'Authorization': `Bearer ${token}`
            }
        });

        console.log(`File deleted successfully: ${externalKey}`);
        res.json({
            success: true,
            message: 'File deleted successfully',
            externalKey
        });
    } catch (error) {
        console.error('Error deleting file:', error.message);

        if (error.response?.status === 404) {
            res.status(404).json({
                success: false,
                error: 'File not found',
                code: 'FILE_NOT_FOUND'
            });
        } else {
            res.status(500).json({
                success: false,
                error: 'Failed to delete file',
                code: 'DELETE_FAILED'
            });
        }
    }
});

module.exports = router;