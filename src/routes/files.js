// File Upload API Routes for Caspio Files API v3
// Handles document uploads for Christmas Bundle and other applications
const express = require('express');
const router = express.Router();
const axios = require('axios');
const FormData = require('form-data');
const fs = require('fs');
const path = require('path');
const os = require('os');
const config = require('../../config');

// Import shared upload service
const { uploadFileToCaspio, validateFile, extractMimeType } = require('../../lib/file-upload-service');

// Configuration
const MAX_FILE_SIZE = 20 * 1024 * 1024; // 20MB
const ALLOWED_TYPES = [
    // Images
    'image/png',
    'image/jpeg',
    'image/jpg',
    'image/gif',
    'image/svg+xml',
    'image/webp',

    // Documents
    'application/pdf',

    // Design Files
    'application/postscript',        // AI (Adobe Illustrator)
    'application/illustrator',       // AI alternate
    'image/vnd.adobe.photoshop',    // PSD (Photoshop)
    'application/x-photoshop',       // PSD alternate
    'image/x-eps',                   // EPS files
    'application/eps',               // EPS alternate
    'application/x-indesign',        // INDD (InDesign)

    // Vector Files
    'application/vnd.corel-draw',   // CDR (CorelDRAW)

    // Office Documents
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document', // DOCX
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',      // XLSX
    'application/msword',            // DOC
    'application/vnd.ms-excel',      // XLS

    // Compressed Files
    'application/zip',
    'application/x-rar-compressed',
    'application/x-zip-compressed'
];

// Get Caspio v3 API URL
const caspioV3BaseUrl = config.caspio.apiV3BaseUrl;
const artworkFolderKey = config.caspio.artworkFolderKey;

// Simple token cache to avoid circular dependency
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

// --- Helper Functions ---
// Note: validateFile, extractMimeType, and createFormDataFromBase64 are now imported from file-upload-service
// Token management kept local to avoid circular dependencies

// --- API Endpoints ---

/**
 * POST /api/files/upload
 * Upload a file from base64 data to Caspio Files API
 * Now uses shared upload service for consistency
 */
router.post('/files/upload', async (req, res) => {
    try {
        const { fileName, fileData, description } = req.body;

        // Use shared service for upload
        const result = await uploadFileToCaspio(fileName, fileData, description);

        res.json(result);

    } catch (error) {
        console.error('[File Upload Route] Error in upload endpoint:', {
            message: error.message,
            stack: error.stack,
            code: error.code
        });

        // Handle specific errors
        if (error.message.includes('too large')) {
            res.status(413).json({
                success: false,
                error: error.message,
                code: 'FILE_TOO_LARGE'
            });
        } else if (error.message.includes('Invalid file type') || error.message.includes('not allowed')) {
            res.status(400).json({
                success: false,
                error: error.message,
                code: 'INVALID_FILE_TYPE'
            });
        } else if (error.message.includes('Missing required fields')) {
            res.status(400).json({
                success: false,
                error: error.message,
                code: 'MISSING_FIELDS'
            });
        } else if (error.response?.status === 409) {
            res.status(409).json({
                success: false,
                error: 'A file with this name already exists in the Artwork folder',
                code: 'FILE_EXISTS'
            });
        } else if (error.response?.status === 404) {
            res.status(500).json({
                success: false,
                error: 'Artwork folder not found. Please check configuration',
                code: 'FOLDER_NOT_FOUND'
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

        // Get file from Caspio
        const token = await getCaspioAccessToken();
        const url = `${caspioV3BaseUrl}/files/${externalKey}`;

        const response = await axios({
            method: 'get',
            url,
            headers: {
                'Authorization': `Bearer ${token}`,
                'Accept': '*/*'
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
        if (response.headers['filename']) {
            res.setHeader('Filename', response.headers['filename']);
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

        // Get file info from Caspio
        const response = await makeCaspioV3Request('get', `/files/${externalKey}/fileInfo`);

        if (response.Result) {
            res.json({
                success: true,
                ...response.Result,
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

        // Delete file from Caspio
        await makeCaspioV3Request('delete', `/files/${externalKey}`);

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

/**
 * POST /api/quote-items-with-file
 * Create a quote item with optional file upload
 * If ImageUpload field contains base64 data, uploads file first
 */
router.post('/quote-items-with-file', async (req, res) => {
    try {
        const quoteData = { ...req.body };

        // Check if ImageUpload contains base64 data
        if (quoteData.ImageUpload && quoteData.ImageUpload.startsWith('data:')) {
            console.log('Detected base64 image in ImageUpload field, uploading to Caspio...');

            // Generate filename from QuoteID or use default
            const fileName = `${quoteData.QuoteID || 'quote'}_${Date.now()}.${
                quoteData.ImageUpload.includes('png') ? 'png' : 'jpg'
            }`;

            try {
                // Use shared upload service
                const uploadResult = await uploadFileToCaspio(fileName, quoteData.ImageUpload, 'Quote item image');

                if (uploadResult.success) {
                    console.log(`File uploaded: ${uploadResult.externalKey}`);

                    // Replace ImageUpload with ExternalKey
                    quoteData.Image_Upload = uploadResult.externalKey;
                    delete quoteData.ImageUpload;

                    // Add file info to response
                    quoteData._uploadedFile = {
                        externalKey: uploadResult.externalKey,
                        fileName: uploadResult.fileName,
                        size: uploadResult.size
                    };
                } else {
                    throw new Error('Failed to upload file');
                }
            } catch (uploadError) {
                console.error('Failed to upload file:', uploadError.message);
                return res.status(400).json({
                    success: false,
                    error: `Failed to upload image: ${uploadError.message}`,
                    code: 'FILE_UPLOAD_FAILED'
                });
            }
        }

        // Now create the quote item with the ExternalKey reference
        // This would call your existing quote_items endpoint
        // For now, we'll just return the prepared data
        res.json({
            success: true,
            message: 'Quote item prepared with file upload',
            data: quoteData,
            note: 'TODO: Implement actual quote_items table insertion'
        });

    } catch (error) {
        console.error('Error creating quote item with file:', error.message);
        res.status(500).json({
            success: false,
            error: error.message || 'Failed to create quote item',
            code: 'QUOTE_ITEM_FAILED'
        });
    }
});

module.exports = router;