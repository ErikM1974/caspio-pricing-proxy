/**
 * Thumbnail Lookup Routes
 * Provides endpoints for looking up design thumbnails from Shopworks_Thumbnail_Report
 */

const express = require('express');
const router = express.Router();
const axios = require('axios');
const multer = require('multer');
const FormData = require('form-data');
const { makeCaspioRequest, fetchAllCaspioPages, getCaspioAccessToken } = require('../utils/caspio');
const config = require('../../config');

// Configure multer for memory storage (multipart/form-data uploads)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 } // 20MB
});

// Simple cache (5-minute TTL)
const thumbnailCache = new Map();
const topSellersCache = new Map();
const syncStatusCache = new Map();
const CACHE_TTL = 5 * 60 * 1000;

/**
 * Sanitize design ID input
 * @param {string} designId - Raw design ID
 * @returns {string|null} - Sanitized ID or null if invalid
 */
function sanitizeDesignId(designId) {
  if (!designId || typeof designId !== 'string') return null;
  const sanitized = designId.replace(/[^a-zA-Z0-9._-]/g, '');
  return (sanitized.length > 0 && sanitized.length <= 50) ? sanitized : null;
}

/**
 * GET /api/thumbnails/by-design/:designId
 * Look up a design thumbnail by Design ID
 *
 * @param {string} designId - The design ID to look up (Thumb_DesLocid_Design)
 * @query {boolean} refresh - Set to 'true' to bypass cache
 *
 * @returns {object} Response with thumbnail details or not-found message
 */
router.get('/thumbnails/by-design/:designId', async (req, res) => {
  try {
    const { designId } = req.params;
    const refresh = req.query.refresh === 'true';

    // Validate input
    const sanitizedId = sanitizeDesignId(designId);
    if (!sanitizedId) {
      return res.status(400).json({
        error: 'Invalid design ID format'
      });
    }

    // Check cache
    const cacheKey = `thumbnail:${sanitizedId}`;
    if (!refresh) {
      const cached = thumbnailCache.get(cacheKey);
      if (cached && (Date.now() - cached.timestamp) < CACHE_TTL) {
        console.log(`[Thumbnails] Cache hit for design ${sanitizedId}`);
        return res.json(cached.data);
      }
    }

    console.log(`[Thumbnails] Looking up design ${sanitizedId}`);

    // Query Caspio
    const params = {
      'q.where': `Thumb_DesLocid_Design='${sanitizedId}'`,
      'q.limit': 1
    };

    const response = await makeCaspioRequest(
      'get',
      '/tables/Shopworks_Thumbnail_Report/records',
      params
    );

    const records = Array.isArray(response) ? response : (response?.Result || []);

    // Not found
    if (records.length === 0) {
      console.log(`[Thumbnails] No thumbnail found for design ${sanitizedId}`);
      const result = {
        found: false,
        message: `No thumbnail found for design ${sanitizedId}`
      };
      return res.json(result);
    }

    // Found - transform response
    const record = records[0];
    const result = {
      found: true,
      thumbnailId: record.ID_Serial,
      designNumber: record.Thumb_DesLocid_Design,
      fileName: record.FileName,
      externalKey: record.ExternalKey,
      designName: record.Thumb_DesLoc_DesDesignName
    };

    console.log(`[Thumbnails] Found thumbnail ${record.ID_Serial} for design ${sanitizedId}`);

    // Cache result
    thumbnailCache.set(cacheKey, { data: result, timestamp: Date.now() });

    res.json(result);

  } catch (error) {
    console.error('[Thumbnails] Error fetching thumbnail:', error.message);
    res.status(500).json({
      error: 'Failed to fetch thumbnail',
      details: error.message
    });
  }
});

/**
 * PUT /api/thumbnails/:thumbnailId/external-key
 * Update the ExternalKey for a thumbnail record
 *
 * @param {number} thumbnailId - The thumbnail ID (ID_Serial) to update
 * @body {string} externalKey - The Caspio Files key to save
 *
 * @returns {object} Success or error response
 */
router.put('/thumbnails/:thumbnailId/external-key', async (req, res) => {
  try {
    const { thumbnailId } = req.params;
    const { externalKey } = req.body;

    // Validate thumbnailId - must be a positive integer
    const id = parseInt(thumbnailId, 10);
    if (isNaN(id) || id <= 0) {
      return res.status(400).json({
        success: false,
        error: 'thumbnailId must be a positive integer'
      });
    }

    // Validate externalKey
    if (!externalKey || typeof externalKey !== 'string') {
      return res.status(400).json({
        success: false,
        error: 'externalKey is required'
      });
    }

    // Validate externalKey length
    if (externalKey.length > 255) {
      return res.status(400).json({
        success: false,
        error: 'externalKey must be 255 characters or less'
      });
    }

    console.log(`[Thumbnails] Updating ExternalKey for thumbnail ${id}`);

    // First verify the record exists
    const checkParams = {
      'q.where': `ID_Serial=${id}`,
      'q.select': 'ID_Serial'
    };

    const checkResponse = await makeCaspioRequest(
      'get',
      '/tables/Shopworks_Thumbnail_Report/records',
      checkParams
    );

    const existingRecords = Array.isArray(checkResponse) ? checkResponse : (checkResponse?.Result || []);

    if (existingRecords.length === 0) {
      console.log(`[Thumbnails] Thumbnail ${id} not found`);
      return res.status(404).json({
        success: false,
        error: `Thumbnail ${id} not found`
      });
    }

    // Auto-generate the public FileUrl
    const fileUrl = `https://caspio-pricing-proxy-ab30a049961a.herokuapp.com/api/files/${externalKey}`;

    // Update record in Caspio
    const updateParams = {
      'q.where': `ID_Serial=${id}`
    };

    await makeCaspioRequest(
      'put',
      '/tables/Shopworks_Thumbnail_Report/records',
      updateParams,
      { ExternalKey: externalKey, FileUrl: fileUrl }
    );

    console.log(`[Thumbnails] Updated ExternalKey and FileUrl for thumbnail ${id}`);

    // Clear any cached entries that might reference this thumbnail
    // (we don't know the designId, so we can't clear specifically)

    res.json({
      success: true,
      thumbnailId: id,
      fileUrl: fileUrl,
      message: 'ExternalKey and FileUrl updated successfully'
    });

  } catch (error) {
    console.error('[Thumbnails] Error updating ExternalKey:', error.message);
    res.status(500).json({
      success: false,
      error: 'Failed to update thumbnail',
      details: error.message
    });
  }
});

/**
 * GET /api/thumbnails/top-sellers
 * Get thumbnails for top-selling designs
 *
 * @query {boolean} needsUpload - Set to 'true' to only return records with empty ExternalKey
 * @query {number} limit - Limit number of results
 * @query {boolean} refresh - Set to 'true' to bypass cache
 *
 * @returns {object} Response with count and thumbnails array
 */
router.get('/thumbnails/top-sellers', async (req, res) => {
  try {
    const { needsUpload, limit, refresh } = req.query;

    // Check cache (unless refresh=true)
    const cacheKey = `top-sellers:${needsUpload || 'all'}:${limit || 'all'}`;
    if (refresh !== 'true') {
      const cached = topSellersCache.get(cacheKey);
      if (cached && (Date.now() - cached.timestamp < CACHE_TTL)) {
        console.log(`[Thumbnails] Cache hit for top-sellers`);
        return res.json(cached.data);
      }
    }

    console.log(`[Thumbnails] Fetching top-sellers (needsUpload=${needsUpload}, limit=${limit})`);

    // Build WHERE clause (Caspio bit fields use 1/0)
    let whereClause = "IsTopSeller=1";
    if (needsUpload === 'true') {
      whereClause += " AND (ExternalKey IS NULL OR ExternalKey='')";
    }

    const params = {
      'q.where': whereClause,
      'q.orderBy': 'Thumb_DesLoc_DesDesignName'
    };
    if (limit) {
      const parsedLimit = parseInt(limit, 10);
      if (!isNaN(parsedLimit) && parsedLimit > 0) {
        params['q.limit'] = parsedLimit;
      }
    }

    // Use fetchAllCaspioPages for potentially large result sets
    const records = await fetchAllCaspioPages(
      '/tables/Shopworks_Thumbnail_Report/records',
      params
    );

    // Transform response
    const thumbnails = records.map(record => ({
      thumbnailId: record.ID_Serial,
      designId: record.Thumb_DesLocid_Design,
      designName: record.Thumb_DesLoc_DesDesignName,
      fileName: record.FileName,
      externalKey: record.ExternalKey || '',
      hasImage: !!(record.ExternalKey && record.ExternalKey.trim() !== '')
    }));

    const result = {
      count: thumbnails.length,
      thumbnails
    };

    console.log(`[Thumbnails] Found ${thumbnails.length} top-selling thumbnails`);

    // Cache result
    topSellersCache.set(cacheKey, { data: result, timestamp: Date.now() });

    res.json(result);

  } catch (error) {
    console.error('[Thumbnails] Error fetching top-sellers:', error.message);
    res.status(500).json({
      error: 'Failed to fetch top-selling thumbnails',
      details: error.message
    });
  }
});

/**
 * GET /api/thumbnails/sync-status
 * Get sync status and statistics for the thumbnail table
 *
 * @query {boolean} refresh - Set to 'true' to bypass cache
 *
 * @returns {object} Sync status with last sync time and record counts
 */
router.get('/thumbnails/sync-status', async (req, res) => {
  try {
    const refresh = req.query.refresh === 'true';

    // Check cache (5 minute TTL)
    const cacheKey = 'sync-status';
    if (!refresh) {
      const cached = syncStatusCache.get(cacheKey);
      if (cached && (Date.now() - cached.timestamp < CACHE_TTL)) {
        console.log('[Thumbnails] Cache hit for sync-status');
        return res.json(cached.data);
      }
    }

    console.log('[Thumbnails] Fetching sync status');

    // Query 1: Get most recent timestamp_Added (order by desc, limit 1)
    const latestRecord = await makeCaspioRequest(
      'get',
      '/tables/Shopworks_Thumbnail_Report/records',
      {
        'q.select': 'timestamp_Added',
        'q.orderBy': 'timestamp_Added desc',
        'q.limit': 1
      }
    );

    const records = Array.isArray(latestRecord) ? latestRecord : (latestRecord?.Result || []);
    const lastSync = records.length > 0 ? records[0].timestamp_Added : null;

    // Query 2: Get all records to count (using fetchAllCaspioPages with select for efficiency)
    const allRecords = await fetchAllCaspioPages(
      '/tables/Shopworks_Thumbnail_Report/records',
      {
        'q.select': 'ID_Serial,ExternalKey'
      }
    );

    const totalRecords = allRecords.length;
    const recordsWithImages = allRecords.filter(r => r.ExternalKey && r.ExternalKey.trim() !== '').length;
    const recordsNeedingImages = totalRecords - recordsWithImages;

    const result = {
      success: true,
      lastSync: lastSync,
      totalRecords: totalRecords,
      recordsWithImages: recordsWithImages,
      recordsNeedingImages: recordsNeedingImages
    };

    console.log(`[Thumbnails] Sync status: lastSync=${lastSync}, total=${totalRecords}, withImages=${recordsWithImages}`);

    // Cache result
    syncStatusCache.set(cacheKey, { data: result, timestamp: Date.now() });

    res.json(result);

  } catch (error) {
    console.error('[Thumbnails] Error fetching sync status:', error.message);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch sync status',
      details: error.message
    });
  }
});

/**
 * POST /api/thumbnails/reconcile-files
 * Reconcile files in Caspio Files "Artwork" folder with database records
 * Matches files by parsing ThumbnailID from filename and updates ExternalKey/FileUrl
 *
 * @returns {object} Summary of reconciliation results
 */
router.post('/thumbnails/reconcile-files', async (req, res) => {
  try {
    console.log('[Thumbnails] Starting file reconciliation');

    // Step 1: List ALL files in Artwork folder using Caspio Files API v3 with pagination
    const token = await getCaspioAccessToken();
    const artworkFolderKey = config.caspio.artworkFolderKey;

    // Fetch ALL files with pagination (Caspio max pageSize is 1000)
    let allFiles = [];
    let pageNumber = 1;
    const pageSize = 1000; // Max allowed by Caspio API
    let hasMorePages = true;

    console.log('[Thumbnails] Fetching all files from Artwork folder...');

    while (hasMorePages) {
      const filesUrl = `${config.caspio.apiV3BaseUrl}/files?externalKey=${artworkFolderKey}&q.pageNumber=${pageNumber}&q.pageSize=${pageSize}`;

      const filesResponse = await axios.get(filesUrl, {
        headers: {
          'Authorization': `Bearer ${token}`,
          'Accept': 'application/json'
        }
      });

      const pageFiles = filesResponse.data?.Result || [];
      console.log(`[Thumbnails] Page ${pageNumber}: fetched ${pageFiles.length} files`);

      if (pageFiles.length === 0) {
        hasMorePages = false;
      } else {
        allFiles = allFiles.concat(pageFiles);
        if (pageFiles.length < pageSize) {
          hasMorePages = false; // Last page
        }
        pageNumber++;
      }
    }

    const files = allFiles;
    console.log(`[Thumbnails] Found ${files.length} total files in Artwork folder`);

    // Step 2: Process each file
    const details = [];
    let matched = 0;
    let notFoundInTable = 0;
    let alreadyLinked = 0;
    let errors = 0;

    for (const file of files) {
      const fileName = file.Name || file.FileName;
      const fileExternalKey = file.ExternalKey;

      // Parse ThumbnailID from filename: {ThumbnailID}_{description}.ext
      const match = fileName.match(/^(\d+)_/);
      if (!match) {
        details.push({ fileName, status: 'invalid_filename_format' });
        errors++;
        continue;
      }

      const thumbnailId = parseInt(match[1], 10);

      try {
        // Look up record in database
        const checkResponse = await makeCaspioRequest(
          'get',
          '/tables/Shopworks_Thumbnail_Report/records',
          {
            'q.where': `ID_Serial=${thumbnailId}`,
            'q.select': 'ID_Serial,ExternalKey'
          }
        );

        const records = Array.isArray(checkResponse) ? checkResponse : (checkResponse?.Result || []);

        if (records.length === 0) {
          details.push({ thumbnailId: thumbnailId.toString(), fileName, status: 'not_found_in_table' });
          notFoundInTable++;
          continue;
        }

        const record = records[0];

        // Check if already linked with same key
        if (record.ExternalKey === fileExternalKey) {
          details.push({ thumbnailId: thumbnailId.toString(), status: 'already_linked', externalKey: fileExternalKey });
          alreadyLinked++;
          continue;
        }

        // Update the record with correct ExternalKey and FileUrl
        const fileUrl = `https://caspio-pricing-proxy-ab30a049961a.herokuapp.com/api/files/${fileExternalKey}`;

        await makeCaspioRequest(
          'put',
          '/tables/Shopworks_Thumbnail_Report/records',
          { 'q.where': `ID_Serial=${thumbnailId}` },
          { ExternalKey: fileExternalKey, FileUrl: fileUrl }
        );

        details.push({ thumbnailId: thumbnailId.toString(), status: 'matched', externalKey: fileExternalKey });
        matched++;
      } catch (fileError) {
        console.error(`[Thumbnails] Error processing file ${fileName}:`, fileError.message);
        details.push({ thumbnailId: thumbnailId.toString(), fileName, status: 'error', error: fileError.message });
        errors++;
      }
    }

    const result = {
      success: true,
      summary: {
        filesProcessed: files.length,
        matched,
        notFoundInTable,
        alreadyLinked,
        errors
      },
      details
    };

    console.log(`[Thumbnails] Reconciliation complete: ${matched} matched, ${notFoundInTable} not found, ${alreadyLinked} already linked, ${errors} errors`);

    res.json(result);

  } catch (error) {
    console.error('[Thumbnails] Error during reconciliation:', error.message);
    res.status(500).json({
      success: false,
      error: 'Failed to reconcile files',
      details: error.message
    });
  }
});

/**
 * POST /api/thumbnails/backfill-fileurls
 * One-time backfill: Populate FileUrl for records with ExternalKey but empty FileUrl
 *
 * @returns {object} Summary of backfill results
 */
router.post('/thumbnails/backfill-fileurls', async (req, res) => {
  try {
    console.log('[Thumbnails] Starting FileUrl backfill');

    // Fetch records with ExternalKey but no FileUrl
    const records = await fetchAllCaspioPages(
      '/tables/Shopworks_Thumbnail_Report/records',
      {
        'q.where': "ExternalKey IS NOT NULL AND ExternalKey != '' AND (FileUrl IS NULL OR FileUrl = '')",
        'q.select': 'ID_Serial,ExternalKey'
      }
    );

    console.log(`[Thumbnails] Found ${records.length} records needing FileUrl backfill`);

    let updated = 0;
    let errors = 0;
    const details = [];

    for (const record of records) {
      try {
        const fileUrl = `https://caspio-pricing-proxy-ab30a049961a.herokuapp.com/api/files/${record.ExternalKey}`;

        await makeCaspioRequest(
          'put',
          '/tables/Shopworks_Thumbnail_Report/records',
          { 'q.where': `ID_Serial=${record.ID_Serial}` },
          { FileUrl: fileUrl }
        );

        updated++;
        details.push({ id: record.ID_Serial, status: 'updated' });
      } catch (err) {
        errors++;
        details.push({ id: record.ID_Serial, status: 'error', error: err.message });
      }
    }

    console.log(`[Thumbnails] FileUrl backfill complete: ${updated} updated, ${errors} errors`);

    res.json({
      success: true,
      summary: { found: records.length, updated, errors },
      details
    });

  } catch (error) {
    console.error('[Thumbnails] Error during FileUrl backfill:', error.message);
    res.status(500).json({
      success: false,
      error: 'Failed to backfill FileUrls',
      details: error.message
    });
  }
});

/**
 * GET /api/thumbnails/uploaded-ids
 * Get all ID_Serial values that already have images uploaded (ExternalKey populated)
 * Returns ID, file size, and upload timestamp for change detection
 *
 * @returns {object} List of uploaded thumbnails with metadata
 */
router.get('/thumbnails/uploaded-ids', async (req, res) => {
  try {
    console.log('[Thumbnails] Fetching uploaded IDs with metadata');

    const records = await fetchAllCaspioPages(
      '/tables/Shopworks_Thumbnail_Report/records',
      {
        'q.where': "ExternalKey IS NOT NULL AND ExternalKey != ''",
        'q.select': 'ID_Serial,FileSizeNumber,timestamp_Uploaded'
      }
    );

    const uploaded = records.map(r => ({
      id: r.ID_Serial,
      size: r.FileSizeNumber || null,
      uploadedAt: r.timestamp_Uploaded || null
    }));

    console.log(`[Thumbnails] Found ${uploaded.length} records with images`);

    res.json({
      success: true,
      count: uploaded.length,
      uploaded: uploaded
    });

  } catch (error) {
    console.error('[Thumbnails] Error fetching uploaded IDs:', error.message);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch uploaded IDs',
      details: error.message
    });
  }
});

/**
 * POST /api/thumbnails/upload-with-stub
 * Upload a thumbnail file and create/update a stub record
 * Saves file size and upload timestamp for change detection
 *
 * Expects multipart/form-data with:
 * - file: The image file (filename format: {ID_Serial}_{description}.ext)
 *
 * @returns {object} Upload result with action (created, updated)
 */
router.post('/thumbnails/upload-with-stub', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({
        success: false,
        error: 'No file uploaded'
      });
    }

    const fileName = req.file.originalname;
    const fileSize = req.file.size;

    // Parse ID_Serial from filename: {ID}_{description}.ext
    const match = fileName.match(/^(\d+)_/);
    if (!match) {
      return res.status(400).json({
        success: false,
        error: 'Invalid filename format. Expected: {ID}_{description}.ext'
      });
    }

    const idSerial = parseInt(match[1], 10);
    console.log(`[Thumbnails] Processing upload for ID_Serial ${idSerial}: ${fileName} (${fileSize} bytes)`);

    // Check if record exists (don't check ExternalKey - allow re-uploads)
    const existing = await makeCaspioRequest(
      'get',
      '/tables/Shopworks_Thumbnail_Report/records',
      { 'q.where': `ID_Serial=${idSerial}`, 'q.select': 'ID_Serial' }
    );
    const existingRecords = Array.isArray(existing) ? existing : (existing?.Result || []);
    console.log(`[Thumbnails] Check existing: ID_Serial=${idSerial}, found=${existingRecords.length} records`);

    // Upload to Caspio Files
    const token = await getCaspioAccessToken();
    const artworkFolderKey = config.caspio.artworkFolderKey;

    const formData = new FormData();
    formData.append('Files', req.file.buffer, {
      filename: fileName,
      contentType: req.file.mimetype
    });

    const uploadUrl = `${config.caspio.apiV3BaseUrl}/files?externalKey=${artworkFolderKey}`;
    console.log(`[Thumbnails] Uploading to Caspio Files: ${fileName}`);

    let externalKey;
    let fileAlreadyExisted = false;

    try {
      const uploadResponse = await axios.post(uploadUrl, formData, {
        headers: {
          'Authorization': `Bearer ${token}`,
          ...formData.getHeaders()
        },
        maxBodyLength: Infinity,
        maxContentLength: Infinity,
        timeout: 30000
      });

      externalKey = uploadResponse.data?.Result?.[0]?.ExternalKey;
      if (!externalKey) {
        console.error('[Thumbnails] Caspio upload response:', JSON.stringify(uploadResponse.data));
        throw new Error('Upload succeeded but no ExternalKey returned');
      }
    } catch (uploadError) {
      // Handle 409 - file already exists in Caspio Files
      if (uploadError.response?.status === 409) {
        console.log(`[Thumbnails] File ${fileName} already exists, looking up ExternalKey...`);
        fileAlreadyExisted = true;

        // List files in Artwork folder to find the existing file
        const listUrl = `${config.caspio.apiV3BaseUrl}/files?externalKey=${artworkFolderKey}&q.pageSize=1000`;
        const listResponse = await axios.get(listUrl, {
          headers: { 'Authorization': `Bearer ${token}`, 'Accept': 'application/json' }
        });

        const files = listResponse.data?.Result || [];
        const existingFile = files.find(f => f.Name === fileName);

        if (!existingFile) {
          throw new Error(`File ${fileName} reported as existing but not found in folder listing`);
        }

        externalKey = existingFile.ExternalKey;
        console.log(`[Thumbnails] Found existing file: ${fileName} -> ${externalKey}`);
      } else {
        throw uploadError;
      }
    }

    const fileUrl = `https://caspio-pricing-proxy-ab30a049961a.herokuapp.com/api/files/${externalKey}`;

    // Data to save (size for change detection)
    // NOTE: timestamp_Uploaded is a Timestamp field in Caspio (auto-populated, read-only)
    const recordData = {
      ExternalKey: externalKey,
      FileUrl: fileUrl,
      FileName: fileName,
      FileSizeNumber: fileSize
    };

    // Create or update record
    let action;
    if (existingRecords.length > 0) {
      // Update existing record
      await makeCaspioRequest(
        'put',
        '/tables/Shopworks_Thumbnail_Report/records',
        { 'q.where': `ID_Serial=${idSerial}` },
        recordData
      );
      action = fileAlreadyExisted ? 'linked_existing' : 'updated';
    } else {
      // Record doesn't exist - cannot create stub (ShopWorks sync creates records)
      // Table has constraints (Thumb_DesLocid_Design is UNIQUE + NOT NULL) that prevent stub creation
      console.log(`[Thumbnails] Record ${idSerial} not found - cannot create stub`);
      return res.status(404).json({
        success: false,
        error: `Thumbnail record ${idSerial} not found in database`,
        code: 'RECORD_NOT_FOUND',
        message: 'Records must exist from ShopWorks sync. File was uploaded to Caspio Files but no database record to link it to.'
      });
    }
    console.log(`[Thumbnails] ${action} record ${idSerial}`);

    res.json({
      success: true,
      thumbnailId: idSerial,
      externalKey: externalKey,
      fileUrl: fileUrl,
      action: action
    });

  } catch (error) {
    console.error('[Thumbnails] Error in upload-with-stub:', error.message);

    res.status(500).json({
      success: false,
      error: 'Failed to upload and create stub',
      details: error.message
    });
  }
});

/**
 * GET /api/thumbnails/all-ids
 * Get all ID_Serial values from the thumbnail database
 * Used by sync scripts to pre-filter files before uploading
 *
 * @returns {object} List of all thumbnail IDs in database
 */
router.get('/thumbnails/all-ids', async (req, res) => {
  try {
    console.log('[Thumbnails] Fetching all IDs from database');

    const records = await fetchAllCaspioPages(
      '/tables/Shopworks_Thumbnail_Report/records',
      { 'q.select': 'ID_Serial' },
      { maxPages: 100 }  // 100 pages × 1000 = 100,000 records max
    );

    const ids = records.map(r => r.ID_Serial);

    console.log(`[Thumbnails] Found ${ids.length} total records`);

    res.json({
      success: true,
      count: ids.length,
      ids: ids
    });

  } catch (error) {
    console.error('[Thumbnails] Error fetching all IDs:', error.message);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch all IDs',
      details: error.message
    });
  }
});

module.exports = router;
