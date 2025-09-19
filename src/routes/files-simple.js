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

        // Create FormData with a stream from the buffer
        const formData = new FormData();
        const stream = Readable.from(file.buffer);
        formData.append('Files', stream, {
            filename: file.originalname,
            contentType: file.mimetype
        });

        // Upload to Caspio Artwork folder
        const url = `${caspioV3BaseUrl}/files?externalKey=${artworkFolderKey}`;
        console.log(`Uploading to Caspio: ${url}`);

        const response = await axios.post(url, formData, {
            headers: {
                'Authorization': `Bearer ${token}`,
                ...formData.getHeaders()
            },
            maxBodyLength: Infinity,
            maxContentLength: Infinity
        });

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