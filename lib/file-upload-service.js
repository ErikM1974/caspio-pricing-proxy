/**
 * File Upload Service
 * Shared service for uploading files to Caspio Files API
 * Can be used by both HTTP routes and internal modules
 *
 * This module extracts the core upload logic to avoid HTTP self-calls
 * that fail when going through Heroku's router.
 */

const FormData = require('form-data');
const fs = require('fs');
const path = require('path');
const os = require('os');
const axios = require('axios');
const config = require('../config');

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

    console.log("[File Upload Service] Requesting new Caspio access token...");
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
            console.log("[File Upload Service] Token obtained successfully");
            return caspioAccessToken;
        } else {
            throw new Error("Invalid response from token endpoint");
        }
    } catch (error) {
        console.error("[File Upload Service] Error getting Caspio token:", error.message);
        caspioAccessToken = null;
        tokenExpiryTime = 0;
        throw new Error("Could not obtain Caspio access token");
    }
}

/**
 * Extract MIME type from base64 data URL
 */
function extractMimeType(base64Data) {
    const match = base64Data.match(/^data:([^;]+);base64,/);
    return match ? match[1] : 'application/octet-stream';
}

/**
 * Validate file size and type
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
 * Create FormData from base64 encoded file
 */
function createFormDataFromBase64(base64Data, fileName) {
    // Remove data URL prefix
    const base64String = base64Data.replace(/^data:[^;]+;base64,/, '');

    // Extract MIME type
    const mimeType = extractMimeType(base64Data);

    // Convert to Buffer
    const buffer = Buffer.from(base64String, 'base64');

    // Create temp file
    const tempDir = os.tmpdir();
    const tempFilePath = path.join(tempDir, `upload_${Date.now()}_${fileName}`);

    // Write buffer to temp file
    fs.writeFileSync(tempFilePath, buffer);

    // Create FormData with file stream and explicit content type
    const formData = new FormData();
    formData.append('Files', fs.createReadStream(tempFilePath), {
        filename: fileName,
        contentType: mimeType
    });

    return { formData, tempFilePath, mimeType };
}

/**
 * Upload file to Caspio Files API
 * @param {string} fileName - Name of the file
 * @param {string} fileData - Base64 encoded file data (with data URL prefix)
 * @param {string} description - Optional file description
 * @returns {Promise<Object>} Upload result
 */
async function uploadFileToCaspio(fileName, fileData, description = '') {
    let tempFilePath = null;

    try {
        // Validate required fields
        if (!fileName || !fileData) {
            throw new Error('Missing required fields: fileName and fileData');
        }

        // Validate file
        const fileInfo = validateFile(fileData, fileName);

        // Create FormData with temp file
        const formDataResult = createFormDataFromBase64(fileData, fileName);
        const formData = formDataResult.formData;
        tempFilePath = formDataResult.tempFilePath;
        const mimeType = formDataResult.mimeType;

        // Get Caspio access token
        const token = await getCaspioAccessToken();

        // Build upload URL with artwork folder
        const uploadPath = `/files${artworkFolderKey ? `?externalKey=${artworkFolderKey}` : ''}`;
        const url = `${caspioV3BaseUrl}${uploadPath}`;

        // Log upload attempt
        console.log('[File Upload Service] Uploading to Caspio:', {
            url: uploadPath,
            fileName: fileName,
            mimeType: mimeType,
            sizeApprox: `${(fileInfo.sizeApprox / 1024).toFixed(2)} KB`
        });

        // Log FormData headers
        console.log('[File Upload Service] FormData headers:', formData.getHeaders());

        // Make upload request
        const response = await axios({
            method: 'post',
            url: url,
            data: formData,
            headers: {
                'Authorization': `Bearer ${token}`,
                ...formData.getHeaders()
            },
            maxBodyLength: Infinity,
            maxContentLength: Infinity,
            timeout: 30000
        });

        // Log success
        console.log('[File Upload Service] Caspio response received:', {
            status: 'success',
            resultCount: response.data.Result?.length || 0
        });

        if (response.data.Result && response.data.Result[0]) {
            const uploadedFile = response.data.Result[0];
            console.log(`[File Upload Service] File uploaded successfully: ${uploadedFile.Name} (${uploadedFile.ExternalKey})`);

            // Clean up temp file
            if (tempFilePath) {
                fs.unlinkSync(tempFilePath);
            }

            return {
                success: true,
                externalKey: uploadedFile.ExternalKey,
                fileName: uploadedFile.Name,
                location: 'Artwork folder',
                size: fileInfo.sizeApprox,
                mimeType: mimeType,
                description: description || null
            };
        } else {
            throw new Error('Unexpected response from Caspio Files API');
        }

    } catch (error) {
        // Enhanced error logging
        console.error('[File Upload Service] Caspio upload error:', {
            message: error.message,
            responseStatus: error.response?.status,
            responseData: error.response?.data,
            fileName: fileName
        });

        // Clean up temp file on error
        if (tempFilePath) {
            try {
                fs.unlinkSync(tempFilePath);
            } catch (cleanupError) {
                console.error('[File Upload Service] Failed to clean up temp file:', cleanupError.message);
            }
        }

        throw error;
    }
}

module.exports = {
    uploadFileToCaspio,
    validateFile,
    extractMimeType
};
