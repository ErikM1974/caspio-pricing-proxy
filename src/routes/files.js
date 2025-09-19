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

// Configuration
const MAX_FILE_SIZE = 20 * 1024 * 1024; // 20MB
const ALLOWED_TYPES = [
    'image/png',
    'image/jpeg',
    'image/jpg',
    'image/gif',
    'image/svg+xml',
    'application/pdf'
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

/**
 * Validates file type and size from base64 data
 */
function validateFile(base64Data, fileName) {
    // Extract MIME type from data URL
    const mimeMatch = base64Data.match(/^data:([^;]+);base64,/);
    if (!mimeMatch) {
        throw new Error('Invalid base64 format. Must be a data URL');
    }

    const mimeType = mimeMatch[1];
    if (!ALLOWED_TYPES.includes(mimeType)) {
        throw new Error(`File type ${mimeType} not allowed. Allowed types: ${ALLOWED_TYPES.join(', ')}`);
    }

    // Estimate file size from base64 length
    const base64Length = base64Data.length - mimeMatch[0].length;
    const sizeApprox = base64Length * 0.75;

    if (sizeApprox > MAX_FILE_SIZE) {
        const sizeMB = (sizeApprox / (1024 * 1024)).toFixed(2);
        throw new Error(`File too large (${sizeMB}MB). Maximum size is 20MB`);
    }

    return { mimeType, sizeApprox };
}

/**
 * Extracts MIME type from base64 data URL
 */
function extractMimeType(base64Data) {
    const match = base64Data.match(/^data:([^;]+);base64,/);
    return match ? match[1] : 'application/octet-stream';
}

/**
 * Creates FormData from base64 data using temp file approach
 * Returns formData and temp file path for cleanup
 */
function createFormDataFromBase64(base64Data, fileName) {
    // Remove data URL prefix
    const base64String = base64Data.replace(/^data:[^;]+;base64,/, '');

    // Convert to Buffer
    const buffer = Buffer.from(base64String, 'base64');

    // Create temp file
    const tempDir = os.tmpdir();
    const tempFilePath = path.join(tempDir, `upload_${Date.now()}_${fileName}`);

    // Write buffer to temp file
    fs.writeFileSync(tempFilePath, buffer);

    // Create FormData with file stream
    const formData = new FormData();
    formData.append('Files', fs.createReadStream(tempFilePath), fileName);

    return { formData, tempFilePath };
}

/**
 * Makes a request to Caspio v3 API
 */
async function makeCaspioV3Request(method, resourcePath, data = null, isFormData = false) {
    const token = await getCaspioAccessToken();
    const url = `${caspioV3BaseUrl}${resourcePath}`;

    console.log(`Making Caspio v3 Request: ${method.toUpperCase()} ${url}`);

    const axiosConfig = {
        method,
        url,
        headers: {
            'Authorization': `Bearer ${token}`
        },
        maxBodyLength: Infinity,
        maxContentLength: Infinity,
        timeout: 30000 // 30 seconds for file operations
    };

    if (isFormData && data) {
        // For FormData, let axios handle the Content-Type header with boundary
        axiosConfig.data = data;
        // Important: merge FormData headers which include the boundary
        Object.assign(axiosConfig.headers, data.getHeaders());
    } else if (data) {
        axiosConfig.headers['Content-Type'] = 'application/json';
        axiosConfig.data = data;
    }

    try {
        const response = await axios(axiosConfig);
        return response.data;
    } catch (error) {
        console.error(`Caspio v3 API Error:`, error.response?.data || error.message);
        if (error.response?.status === 415) {
            console.error('415 Error - Headers sent:', JSON.stringify(axiosConfig.headers, null, 2));
            console.error('415 Error - Data type:', typeof axiosConfig.data);
            console.error('415 Error - Is FormData?:', axiosConfig.data instanceof FormData);
        }
        throw error;
    }
}

// --- API Endpoints ---

/**
 * POST /api/files/upload
 * Upload a file from base64 data to Caspio Files API
 */
router.post('/files/upload', async (req, res) => {
    try {
        const { fileName, fileData, description } = req.body;

        // Validate required fields
        if (!fileName || !fileData) {
            return res.status(400).json({
                success: false,
                error: 'Missing required fields: fileName and fileData',
                code: 'MISSING_FIELDS'
            });
        }

        // Validate file
        let fileInfo;
        try {
            fileInfo = validateFile(fileData, fileName);
        } catch (validationError) {
            return res.status(400).json({
                success: false,
                error: validationError.message,
                code: validationError.message.includes('too large') ? 'FILE_TOO_LARGE' : 'INVALID_FILE_TYPE'
            });
        }

        // Create FormData with temp file
        const { formData, tempFilePath } = createFormDataFromBase64(fileData, fileName);

        try {
            // Upload to Caspio with Artwork folder
            const uploadPath = `/files${artworkFolderKey ? `?externalKey=${artworkFolderKey}` : ''}`;
            const response = await makeCaspioV3Request('post', uploadPath, formData, true);

            if (response.Result && response.Result[0]) {
                const uploadedFile = response.Result[0];
                console.log(`File uploaded successfully: ${uploadedFile.Name} (${uploadedFile.ExternalKey})`);

                // Clean up temp file
                fs.unlinkSync(tempFilePath);

                res.json({
                    success: true,
                    externalKey: uploadedFile.ExternalKey,
                    fileName: uploadedFile.Name,
                    location: 'Artwork folder',
                    size: fileInfo.sizeApprox,
                    mimeType: fileInfo.mimeType,
                    description: description || null
                });
            } else {
                // Clean up temp file on error
                fs.unlinkSync(tempFilePath);
                throw new Error('Unexpected response from Caspio Files API');
            }
        } catch (uploadError) {
            // Always clean up temp file on error
            try {
                fs.unlinkSync(tempFilePath);
            } catch (cleanupError) {
                console.error('Failed to clean up temp file:', cleanupError.message);
            }
            throw uploadError;
        }
    } catch (error) {
        console.error('Error uploading file:', error.message);

        // Handle specific Caspio errors
        if (error.response?.status === 409) {
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
        } else if (error.response?.status === 413) {
            res.status(413).json({
                success: false,
                error: 'File too large for Caspio',
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
                // Validate file
                const fileInfo = validateFile(quoteData.ImageUpload, fileName);

                // Create FormData with temp file
                const { formData, tempFilePath } = createFormDataFromBase64(quoteData.ImageUpload, fileName);

                try {
                    // Upload to Caspio
                    const uploadPath = `/files${artworkFolderKey ? `?externalKey=${artworkFolderKey}` : ''}`;
                    const uploadResponse = await makeCaspioV3Request('post', uploadPath, formData, true);

                    if (uploadResponse.Result && uploadResponse.Result[0]) {
                        const uploadedFile = uploadResponse.Result[0];
                        console.log(`File uploaded: ${uploadedFile.ExternalKey}`);

                        // Clean up temp file
                        fs.unlinkSync(tempFilePath);

                        // Replace ImageUpload with ExternalKey
                        quoteData.Image_Upload = uploadedFile.ExternalKey;
                        delete quoteData.ImageUpload;

                        // Add file info to response
                        quoteData._uploadedFile = {
                            externalKey: uploadedFile.ExternalKey,
                            fileName: uploadedFile.Name,
                            size: fileInfo.sizeApprox
                        };
                    } else {
                        // Clean up temp file on error
                        fs.unlinkSync(tempFilePath);
                        throw new Error('Failed to upload file');
                    }
                } catch (uploadInnerError) {
                    // Always clean up temp file on error
                    try {
                        fs.unlinkSync(tempFilePath);
                    } catch (cleanupError) {
                        console.error('Failed to clean up temp file:', cleanupError.message);
                    }
                    throw uploadInnerError;
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