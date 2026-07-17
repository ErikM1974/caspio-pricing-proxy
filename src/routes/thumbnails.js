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
const { uploadFileToBox } = require('../utils/box-client');
const config = require('../../config');

// Configure multer for memory storage (multipart/form-data uploads)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 } // 20MB
});

// Simple cache (5-minute TTL)
const thumbnailCache = new Map();
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
      designName: record.Thumb_DesLoc_DesDesignName,
      imageUrl: record.ExternalKey
        ? `https://caspio-pricing-proxy-ab30a049961a.herokuapp.com/api/files/${record.ExternalKey}`
        : (record.FileUrl || null)
    };

    console.log(`[Thumbnails] Found thumbnail ${record.ID_Serial} for design ${sanitizedId}`);

    // Cache result
    thumbnailCache.set(cacheKey, { data: result, timestamp: Date.now() });

    // Limit cache size (keep last 200 entries)
    if (thumbnailCache.size > 200) {
      const firstKey = thumbnailCache.keys().next().value;
      thumbnailCache.delete(firstKey);
    }

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
 * GET /api/thumbnails/by-designs?ids=29988,39112
 * Batch lookup of design thumbnails by multiple Design IDs
 *
 * @query {string} ids - Comma-separated design IDs (max 20)
 * @query {boolean} refresh - Set to 'true' to bypass cache
 *
 * @returns {object} Map of design ID → thumbnail info
 */
router.get('/thumbnails/by-designs', async (req, res) => {
  try {
    const { ids, refresh } = req.query;
    const bypassCache = refresh === 'true';

    if (!ids || typeof ids !== 'string') {
      return res.status(400).json({ error: 'Missing required query parameter: ids' });
    }

    // Parse and sanitize IDs
    const rawIds = ids.split(',').map(s => s.trim()).filter(Boolean);
    const sanitizedIds = rawIds.map(sanitizeDesignId).filter(Boolean);

    if (sanitizedIds.length === 0) {
      return res.status(400).json({ error: 'No valid design IDs provided' });
    }
    if (sanitizedIds.length > 20) {
      return res.status(400).json({ error: 'Maximum 20 design IDs per request' });
    }

    // Check cache for each ID, collect uncached ones
    const result = {};
    const uncachedIds = [];

    for (const id of sanitizedIds) {
      const cacheKey = `thumbnail:${id}`;
      if (!bypassCache) {
        const cached = thumbnailCache.get(cacheKey);
        if (cached && (Date.now() - cached.timestamp) < CACHE_TTL) {
          result[id] = cached.data;
          continue;
        }
      }
      uncachedIds.push(id);
    }

    // Fetch uncached IDs from Caspio in one query
    if (uncachedIds.length > 0) {
      const whereClause = uncachedIds.map(id => `Thumb_DesLocid_Design='${id}'`).join(' OR ');
      const params = {
        'q.where': whereClause,
        'q.limit': uncachedIds.length
      };

      const response = await makeCaspioRequest(
        'get',
        '/tables/Shopworks_Thumbnail_Report/records',
        params
      );

      const records = Array.isArray(response) ? response : (response?.Result || []);

      // Index found records by design ID
      const foundMap = {};
      for (const rec of records) {
        const dn = String(rec.Thumb_DesLocid_Design);
        foundMap[dn] = {
          found: true,
          thumbnailId: rec.ID_Serial,
          designNumber: dn,
          fileName: rec.FileName,
          externalKey: rec.ExternalKey,
          designName: rec.Thumb_DesLoc_DesDesignName,
          imageUrl: rec.ExternalKey
            ? `https://caspio-pricing-proxy-ab30a049961a.herokuapp.com/api/files/${rec.ExternalKey}`
            : (rec.FileUrl || null)
        };
      }

      // Populate results and cache
      for (const id of uncachedIds) {
        const data = foundMap[id] || { found: false, designNumber: id };
        result[id] = data;

        // Cache each result
        const cacheKey = `thumbnail:${id}`;
        thumbnailCache.set(cacheKey, { data, timestamp: Date.now() });
      }

      // Limit cache size
      while (thumbnailCache.size > 200) {
        const firstKey = thumbnailCache.keys().next().value;
        thumbnailCache.delete(firstKey);
      }
    }

    console.log(`[Thumbnails] Batch lookup: ${sanitizedIds.length} requested, ${Object.values(result).filter(r => r.found).length} found`);

    res.json({ thumbnails: result });

  } catch (error) {
    console.error('[Thumbnails] Batch lookup error:', error.message);
    res.status(500).json({
      error: 'Failed to batch fetch thumbnails',
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

    // Limit cache size (keep last 20 entries)
    if (syncStatusCache.size > 20) {
      const firstKey = syncStatusCache.keys().next().value;
      syncStatusCache.delete(firstKey);
    }

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
        'q.select': 'ID_Serial,ExternalKey',
        'q.orderBy': 'PK_ID' // stable pagination — unordered multi-page reads drop rows
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

    // "Uploaded" = has an image on ANY backend. Caspio rows carry a Caspio ExternalKey;
    // Box rows carry ExternalKey='' but a Box FileUrl. Keying on FileUrl catches both, so
    // the Box push sync (?target=box) doesn't re-upload every image, and the legacy Caspio
    // sync is unaffected (Caspio rows still have a FileUrl).
    const records = await fetchAllCaspioPages(
      '/tables/Shopworks_Thumbnail_Report/records',
      {
        'q.where': "FileUrl IS NOT NULL AND FileUrl != ''",
        'q.select': 'ID_Serial,FileSizeNumber,timestamp_Uploaded',
        'q.orderBy': 'PK_ID' // stable pagination — sync scripts diff against this list; dropped rows = re-uploads
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

    // No row to attach an image to — bail BEFORE uploading so we never orphan a Caspio/Box file.
    // Rows are created by the ShopWorks metadata sync; Thumb_DesLocid_Design is UNIQUE + NOT NULL so
    // we can't stub one here.
    if (existingRecords.length === 0) {
      console.log(`[Thumbnails] Record ${idSerial} not found - skipping upload (no row to link)`);
      return res.status(404).json({
        success: false,
        error: `Thumbnail record ${idSerial} not found in database`,
        code: 'RECORD_NOT_FOUND',
        message: 'Records must exist from ShopWorks sync; nothing was uploaded.'
      });
    }

    // Where the image bytes go. ?target=box stores it in BOX (frees Caspio storage AND makes serving
    // free of the Caspio API budget — the all-Box pipeline); default stores it in Caspio Files (legacy).
    // Either way the row-upsert below is identical; only ExternalKey (Caspio) vs FileUrl (Box) differs.
    const useBox = req.query.target === 'box' || req.query.store === 'box';
    let externalKey = '';        // '' for Box-stored rows (no Caspio file) → consumers fall back to FileUrl
    let fileUrl;
    let fileAlreadyExisted = false;

    if (useBox) {
      const folderId = process.env.BOX_THUMBNAIL_ARCHIVE_FOLDER_ID;
      if (!folderId) return res.status(500).json({ success: false, error: 'BOX_THUMBNAIL_ARCHIVE_FOLDER_ID not set' });
      let boxFile;
      try {
        boxFile = await uploadFileToBox(folderId, fileName, req.file.buffer, req.file.mimetype);
      } catch (uploadError) {
        // 409 = a file with that name already in the Box folder — retry with a timestamp suffix
        // (the ID_Serial keys the DB row, so the Box filename doesn't need to be unique).
        if (uploadError.response && uploadError.response.status === 409) {
          const ts = new Date().toISOString().replace(/[:.]/g, '-').replace('Z', '');
          const dot = fileName.lastIndexOf('.');
          const uniq = dot <= 0 ? `${fileName}_${ts}` : `${fileName.slice(0, dot)}_${ts}${fileName.slice(dot)}`;
          boxFile = await uploadFileToBox(folderId, uniq, req.file.buffer, req.file.mimetype);
        } else { throw uploadError; }
      }
      fileUrl = `${THUMB_ARCHIVE_PROXY_BASE}/api/box/thumbnail/${boxFile.id}`;
      console.log(`[Thumbnails] Uploaded to BOX: ${fileName} -> file ${boxFile.id}`);
    } else {
      // Upload to Caspio Files (legacy path)
      const token = await getCaspioAccessToken();
      const artworkFolderKey = config.caspio.artworkFolderKey;

      const formData = new FormData();
      formData.append('Files', req.file.buffer, {
        filename: fileName,
        contentType: req.file.mimetype
      });

      const uploadUrl = `${config.caspio.apiV3BaseUrl}/files?externalKey=${artworkFolderKey}`;
      console.log(`[Thumbnails] Uploading to Caspio Files: ${fileName}`);

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

      fileUrl = `https://caspio-pricing-proxy-ab30a049961a.herokuapp.com/api/files/${externalKey}`;
    }

    // Data to save (size for change detection). Box rows carry ExternalKey='' so the FileUrl (Box) wins.
    // NOTE: timestamp_Uploaded is a Timestamp field in Caspio (auto-populated, read-only)
    const recordData = {
      ExternalKey: externalKey,
      FileUrl: fileUrl,
      FileName: fileName,
      FileSizeNumber: fileSize
    };

    // Update the (guaranteed-to-exist) record with the new image reference.
    await makeCaspioRequest(
      'put',
      '/tables/Shopworks_Thumbnail_Report/records',
      { 'q.where': `ID_Serial=${idSerial}` },
      recordData
    );
    const action = fileAlreadyExisted ? 'linked_existing' : (useBox ? 'updated_box' : 'updated');
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
 * GET /api/thumbnails/stats-by-year
 * Get thumbnail statistics broken down by year
 * Shows total records and uploaded records per year based on timestamp_Added
 *
 * @query {boolean} refresh - Set to 'true' to bypass cache
 *
 * @returns {object} Stats with total count and breakdown by year
 */
router.get('/thumbnails/stats-by-year', async (req, res) => {
  try {
    const refresh = req.query.refresh === 'true';

    // Check cache (5 minute TTL)
    const cacheKey = 'stats-by-year';
    if (!refresh) {
      const cached = syncStatusCache.get(cacheKey);
      if (cached && (Date.now() - cached.timestamp < CACHE_TTL)) {
        console.log('[Thumbnails] Cache hit for stats-by-year');
        return res.json(cached.data);
      }
    }

    console.log('[Thumbnails] Fetching stats by year');

    // Fetch all records with timestamp_Added and ExternalKey
    const records = await fetchAllCaspioPages(
      '/tables/Shopworks_Thumbnail_Report/records',
      {
        'q.select': 'timestamp_Added,ExternalKey',
        'q.orderBy': 'PK_ID' // stable pagination — 12k+ rows = 13 pages; unordered reads drop rows
      },
      { maxPages: 100 }  // 100 pages × 1000 = 100,000 records max
    );

    console.log(`[Thumbnails] Processing ${records.length} records for year stats`);

    // Group by year
    const byYear = {};
    const withUploads = {};

    for (const record of records) {
      // Extract year from timestamp_Added
      const timestamp = record.timestamp_Added;
      if (!timestamp) continue;

      const year = new Date(timestamp).getFullYear().toString();

      // Count total per year
      byYear[year] = (byYear[year] || 0) + 1;

      // Count records with ExternalKey populated (image uploaded)
      if (record.ExternalKey && record.ExternalKey.trim() !== '') {
        withUploads[year] = (withUploads[year] || 0) + 1;
      }
    }

    // Sort years for consistent output
    const sortedByYear = {};
    const sortedWithUploads = {};
    Object.keys(byYear).sort().forEach(year => {
      sortedByYear[year] = byYear[year];
      sortedWithUploads[year] = withUploads[year] || 0;
    });

    const result = {
      success: true,
      total: records.length,
      byYear: sortedByYear,
      withUploads: sortedWithUploads
    };

    console.log(`[Thumbnails] Stats by year complete: ${Object.keys(sortedByYear).length} years found`);

    // Cache result
    syncStatusCache.set(cacheKey, { data: result, timestamp: Date.now() });

    // Limit cache size (keep last 20 entries)
    if (syncStatusCache.size > 20) {
      const firstKey = syncStatusCache.keys().next().value;
      syncStatusCache.delete(firstKey);
    }

    res.json(result);

  } catch (error) {
    console.error('[Thumbnails] Error fetching stats by year:', error.message);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch stats by year',
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
      { 'q.select': 'ID_Serial', 'q.orderBy': 'PK_ID' }, // orderBy: stable pagination — 12k+ rows; unordered reads drop rows
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

/**
 * DELETE /api/thumbnails/delete-by-year/:year
 * Bulk delete thumbnail files from Caspio storage for a specific year
 * Frees up storage space by removing old uploads
 *
 * Supports pagination to avoid Heroku 30-second timeout:
 * - Use ?limit=100&offset=0 to process in chunks
 * - Loop until remaining is 0
 *
 * @param {string} year - The year to delete (e.g., 2016)
 * @query {number} limit - Max files to delete per request (default 100)
 * @query {number} offset - Starting offset for pagination (default 0)
 *
 * @returns {object} Summary with deleted count and remaining
 */
router.delete('/thumbnails/delete-by-year/:year', async (req, res) => {
  try {
    const year = parseInt(req.params.year, 10);
    const limit = Math.min(parseInt(req.query.limit, 10) || 100, 500); // Max 500 per request
    const offset = parseInt(req.query.offset, 10) || 0;

    // Validate year
    if (isNaN(year) || year < 2000 || year > 2100) {
      return res.status(400).json({
        success: false,
        error: 'Invalid year parameter. Must be between 2000-2100.'
      });
    }

    console.log(`[Thumbnails] Delete by year ${year}, limit=${limit}, offset=${offset}`);

    // Get access token for file deletion
    const token = await getCaspioAccessToken();

    // Query records for this year with ExternalKey populated
    const whereClause = `YEAR(timestamp_Added)=${year} AND ExternalKey IS NOT NULL AND ExternalKey != ''`;

    // Fetch the chunk to process
    const chunkResponse = await makeCaspioRequest('get', '/tables/Shopworks_Thumbnail_Report/records', {
      'q.where': whereClause,
      'q.select': 'ID_Serial,ExternalKey,FileSizeNumber',
      'q.limit': limit
    });

    const records = Array.isArray(chunkResponse) ? chunkResponse : (chunkResponse?.Result || []);

    console.log(`[Thumbnails] Found ${records.length} records to process in this chunk`);

    if (records.length === 0) {
      return res.json({
        success: true,
        year: year,
        deleted: 0,
        remaining: 0,
        nextOffset: null,
        storageFreed: '0 bytes',
        message: 'No more files to delete for this year'
      });
    }

    let filesDeleted = 0;
    let totalBytes = 0;
    let errors = 0;
    const errorDetails = [];

    // Process all records in this chunk
    for (const record of records) {
      try {
        // Step 1: Delete file from Caspio storage
        try {
          await axios.delete(`${config.caspio.apiV3BaseUrl}/files/${record.ExternalKey}`, {
            headers: { 'Authorization': `Bearer ${token}` }
          });
        } catch (fileError) {
          // 404 is OK - file already deleted
          if (fileError.response?.status !== 404) {
            throw fileError;
          }
        }

        // Step 2: Clear database fields (timestamp_Uploaded is read-only, skip it)
        await makeCaspioRequest('put', '/tables/Shopworks_Thumbnail_Report/records',
          { 'q.where': `ID_Serial=${record.ID_Serial}` },
          {
            ExternalKey: '',
            FileUrl: '',
            FileSizeNumber: null
          }
        );

        filesDeleted++;
        totalBytes += record.FileSizeNumber || 0;

      } catch (recordError) {
        errors++;
        errorDetails.push({
          id: record.ID_Serial,
          externalKey: record.ExternalKey,
          error: recordError.message
        });
        console.error(`[Thumbnails] Error deleting record ${record.ID_Serial}:`, recordError.message);
      }
    }

    // Format storage freed
    let storageFreed;
    if (totalBytes >= 1024 * 1024 * 1024) {
      storageFreed = `~${(totalBytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
    } else if (totalBytes >= 1024 * 1024) {
      storageFreed = `~${(totalBytes / (1024 * 1024)).toFixed(1)} MB`;
    } else {
      storageFreed = `${totalBytes} bytes`;
    }

    // Calculate remaining (we deleted filesDeleted, so check if more exist)
    // We need to query again to see how many are left
    const remainingResponse = await makeCaspioRequest('get', '/tables/Shopworks_Thumbnail_Report/records', {
      'q.where': whereClause,
      'q.select': 'ID_Serial',
      'q.limit': 1
    });
    const remainingRecords = Array.isArray(remainingResponse) ? remainingResponse : (remainingResponse?.Result || []);
    const hasMore = remainingRecords.length > 0;

    console.log(`[Thumbnails] Chunk complete. Deleted: ${filesDeleted}, Errors: ${errors}, More remaining: ${hasMore}`);

    const response = {
      success: true,
      year: year,
      deleted: filesDeleted,
      remaining: hasMore ? '(more exist)' : 0,
      nextOffset: hasMore ? offset + limit : null,
      storageFreed: storageFreed,
      errors: errors
    };

    if (errorDetails.length > 0) {
      response.errorDetails = errorDetails.slice(0, 5); // First 5 errors only
    }

    res.json(response);

  } catch (error) {
    console.error('[Thumbnails] Error in bulk delete:', error.message);
    res.status(500).json({
      success: false,
      error: 'Failed to complete bulk delete',
      details: error.message
    });
  }
});

/**
 * POST /api/thumbnails/metadata-sync
 * Upsert Shopworks_Thumbnail_Report metadata by ID_Serial from the ShopWorks
 * "Thumbnails Report" export. The bandit agent reads the .xlsx and POSTs batches.
 *
 * Replaces the old dist\build_caspio_import_csv.py 3-way join + Caspio file-import.
 * Writes ONLY metadata columns (design/part/dims/timestamp). The image-side
 * columns (ExternalKey/FileUrl/FileSizeNumber/timestamp_Uploaded) are owned by
 * upload-with-stub and never touched here. This endpoint is the RECORD-CREATOR
 * (upload-with-stub refuses to create stubs — see ~L794).
 *
 * Upsert: PUT by ID_Serial (metadata only, never FileName on update so the
 * image-side staged filename is preserved) → 0 RecordsAffected → INSERT with a
 * serial-prefixed FileName ({ID_Serial}_{original}) to satisfy the UNIQUE FileName.
 *
 * Body: { rows: [ { ID_Serial, FileName, FileWidth, FileHeight, FileSizeDisplay,
 *   timestamp_Added, Thumb_DesLocid_Design, Thumb_DesLoc_DesDesignName,
 *   Thumb_ProdPartNumber, Thumb_ProdDescription } ] }   (rows:[] is a valid heartbeat)
 * Auth: x-crm-api-secret (mounted in server.js).
 */
const THUMB_TABLE = 'Shopworks_Thumbnail_Report';
const THUMB_TEXT_LIMIT = 255;
const THUMB_META_COLS = ['Thumb_DesLocid_Design', 'Thumb_DesLoc_DesDesignName', 'Thumb_ProdPartNumber', 'Thumb_ProdDescription', 'FileWidth', 'FileHeight', 'FileSizeDisplay', 'timestamp_Added'];
const THUMB_TEXT_COLS = new Set(['Thumb_DesLocid_Design', 'Thumb_DesLoc_DesDesignName', 'Thumb_ProdPartNumber', 'Thumb_ProdDescription', 'FileSizeDisplay', 'FileName']);
const THUMB_NUM_COLS = new Set(['FileWidth', 'FileHeight']); // Caspio Number fields — coerce or null

function thumbClean(col, v) {
  if (v === undefined || v === null || v === '') return null; // '' → null (Caspio Date/Time 400s on '')
  if (THUMB_NUM_COLS.has(col)) { const n = Number(v); return Number.isFinite(n) ? n : null; } // bad width/height → null (not a 400)
  if (THUMB_TEXT_COLS.has(col) && typeof v === 'string' && v.length > THUMB_TEXT_LIMIT) return v.slice(0, THUMB_TEXT_LIMIT);
  return v;
}

router.post('/thumbnails/metadata-sync', async (req, res) => {
  try {
    const rows = req.body && req.body.rows;
    if (!Array.isArray(rows)) return res.status(400).json({ success: false, error: 'Body must be { rows: [...] }' });
    if (rows.length > 500) return res.status(400).json({ success: false, error: 'Max 500 rows per call — chunk on the agent side' });

    const token = await getCaspioAccessToken();
    const base = config.caspio.apiBaseUrl;
    const H = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

    let inserted = 0, updated = 0, errored = 0;
    const errors = [];
    const CONC = 5; // parallel waves — balance Heroku 30s router timeout vs Caspio API rate limit (429 at ~10+ calls/s burst, 2026-07-17)

    for (let i = 0; i < rows.length; i += CONC) {
      const wave = rows.slice(i, i + CONC);
      const settled = await Promise.allSettled(wave.map(async (raw) => {
        const id = parseInt(raw.ID_Serial, 10);
        if (!Number.isInteger(id)) throw new Error('bad ID_Serial: ' + raw.ID_Serial);
        const meta = {};
        for (const c of THUMB_META_COLS) meta[c] = thumbClean(c, raw[c]);

        // UPDATE by ID_Serial — metadata only (preserve image-side FileName/URL)
        const put = await axios.put(`${base}/tables/${THUMB_TABLE}/records`, meta,
          { headers: H, params: { 'q.where': `ID_Serial=${id}` }, timeout: 15000 });
        if (((put.data && put.data.RecordsAffected) || 0) > 0) return { action: 'updated' };

        // INSERT new record (Caspio PUT no-match = 200 RecordsAffected:0)
        const orig = (raw.FileName == null ? '' : String(raw.FileName)).trim();
        const insertBody = Object.assign({ ID_Serial: id }, meta);
        if (orig) insertBody.FileName = thumbClean('FileName', `${id}_${orig}`);
        await axios.post(`${base}/tables/${THUMB_TABLE}/records`, insertBody, { headers: H, timeout: 15000 });
        return { action: 'inserted' };
      }));
      settled.forEach((s, j) => {
        if (s.status === 'fulfilled') { s.value.action === 'inserted' ? inserted++ : updated++; }
        else {
          errored++;
          const e = s.reason;
          const d = e.response ? JSON.stringify(e.response.data) : e.message;
          errors.push({ ID_Serial: wave[j] && wave[j].ID_Serial, error: String(d).slice(0, 300) });
          console.error(`[thumb-meta] row ${wave[j] && wave[j].ID_Serial} failed:`, d);
        }
      });
      // Inter-wave throttle: keep Caspio call rate ~7-8/s (429 at ~30/s burst, 2026-07-17).
      // 50-row chunks × 10 waves × ~1s ≈ 10-15s, safely under Heroku's 30s router limit.
      if (i + CONC < rows.length) await new Promise(r => setTimeout(r, 500));
    }

    // Heartbeat (shared Sync_Heartbeats table; own Sync_Name)
    if (errored === 0 || errored < rows.length) {
      try {
        const stamp = new Date().toISOString().slice(0, 19);
        const hb = { Last_Success: stamp, Last_Rows: rows.length, Last_Summary: `${inserted} ins, ${updated} upd, ${errored} err of ${rows.length}`.slice(0, 250) };
        const put = await axios.put(`${base}/tables/Sync_Heartbeats/records`, hb,
          { headers: H, params: { 'q.where': `Sync_Name='shopworks-thumbnail-metadata'` }, timeout: 15000 });
        if (((put.data && put.data.RecordsAffected) || 0) === 0) {
          await axios.post(`${base}/tables/Sync_Heartbeats/records`, Object.assign({ Sync_Name: 'shopworks-thumbnail-metadata' }, hb), { headers: H, timeout: 15000 });
        }
      } catch (hbErr) { console.warn('[thumb-meta] heartbeat failed:', hbErr.message); }
    }

    console.log(`[thumb-meta] ${inserted} inserted, ${updated} updated, ${errored} errored of ${rows.length}`);
    res.json({ success: errored === 0, summary: { inserted, updated, errored, total: rows.length }, errors: errors.slice(0, 20) });
  } catch (error) {
    console.error('[thumb-meta] batch failed:', error.response ? JSON.stringify(error.response.data) : error.message);
    res.status(500).json({ success: false, error: 'metadata sync failed: ' + error.message });
  }
});

/**
 * POST /api/thumbnails/archive-to-box
 * Move OLD thumbnail images from Caspio Files to Box.com to free Caspio storage,
 * keeping the Shopworks_Thumbnail_Report row + metadata intact. Transparent to all
 * consumers: they build the image URL as `ExternalKey ? /api/files/{key} : FileUrl`,
 * so clearing ExternalKey + pointing FileUrl at Box makes them serve from Box (the
 * `/api/box/thumbnail/:fileId` route) with zero consumer changes.
 *
 * Query: ?year=YYYY  (archive one year) OR ?before=YYYY (all years < YYYY),
 *        ?limit (default 20, cap 50 — small so a chunk stays under Heroku 30s),
 *        ?dryRun=true (report a sample, mutate nothing).
 * Auth: x-crm-api-secret (gateWritesOnly on /api/thumbnails).
 *
 * Per record, IN ORDER (never leave an image unservable): download bytes from
 * Caspio → upload to Box → repoint FileUrl + clear ExternalKey/FileSizeNumber →
 * delete the Caspio file. If the delete fails, FileUrl already points to Box.
 *
 * ⚠ Caspio API budget: ~3 Caspio calls/record. Run the full sweep after the
 * monthly reset or paced; the driver loops small chunks (scripts/archive-thumbnails-to-box.js).
 */
const THUMB_ARCHIVE_PROXY_BASE = 'https://caspio-pricing-proxy-ab30a049961a.herokuapp.com';
function thumbMimeFromName(name) {
  const ext = String(name || '').toLowerCase().split('.').pop();
  return ({ jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', bmp: 'image/bmp', tif: 'image/tiff', tiff: 'image/tiff', webp: 'image/webp' })[ext] || 'application/octet-stream';
}

router.post('/thumbnails/archive-to-box', async (req, res) => {
  try {
    const folderId = process.env.BOX_THUMBNAIL_ARCHIVE_FOLDER_ID;
    if (!folderId) return res.status(500).json({ success: false, error: 'BOX_THUMBNAIL_ARCHIVE_FOLDER_ID not set' });

    const year = req.query.year ? parseInt(req.query.year, 10) : null;
    const before = req.query.before ? parseInt(req.query.before, 10) : null;
    const undated = req.query.undated === '1' || req.query.undated === 'true';
    const limit = Math.min(parseInt(req.query.limit, 10) || 20, 50);
    const dryRun = req.query.dryRun === 'true';
    if (!year && !before && !undated) return res.status(400).json({ success: false, error: 'pass ?year=YYYY, ?before=YYYY, or ?undated=1' });

    // undated = rows with no timestamp_Added — YEAR(NULL) can't satisfy a year/before filter, so these
    // would never be swept otherwise. year/before behave as before.
    const selClause = undated ? 'timestamp_Added IS NULL'
      : (year ? `YEAR(timestamp_Added)=${year}` : `YEAR(timestamp_Added)<${before}`);
    const where = `${selClause} AND ExternalKey IS NOT NULL AND ExternalKey != ''`;

    const chunkResp = await makeCaspioRequest('get', '/tables/Shopworks_Thumbnail_Report/records',
      { 'q.where': where, 'q.select': 'ID_Serial,ExternalKey,FileName,FileSizeNumber', 'q.limit': limit });
    const records = Array.isArray(chunkResp) ? chunkResp : (chunkResp?.Result || []);

    if (dryRun || records.length === 0) {
      return res.json({
        success: true, dryRun,
        matchedThisChunk: records.length,
        moreLikely: records.length === limit,
        sample: records.slice(0, 5).map(r => ({ ID_Serial: r.ID_Serial, FileName: r.FileName })),
        note: dryRun ? 'nothing mutated — use GET /api/thumbnails/stats-by-year for full counts' : 'no more records to archive for this selection'
      });
    }

    const token = await getCaspioAccessToken();
    const v3 = config.caspio.apiV3BaseUrl;
    const H = { Authorization: `Bearer ${token}` };
    let archived = 0, errored = 0, bytes = 0;
    const errors = [];
    const CONC = 3; // gentle on both Caspio (budget/429) and Box

    for (let i = 0; i < records.length; i += CONC) {
      const wave = records.slice(i, i + CONC);
      const settled = await Promise.allSettled(wave.map(async (rec) => {
        const id = rec.ID_Serial, key = rec.ExternalKey;
        const fname = rec.FileName || `${id}.jpg`;
        // 1. download bytes from Caspio Files (Box can't fetch Caspio's authed URL)
        const dl = await axios.get(`${v3}/files/${key}`, { headers: H, responseType: 'arraybuffer', timeout: 30000 });
        const buf = Buffer.from(dl.data);
        // 2. upload to Box (409 duplicate filename → timestamp-suffix retry)
        let boxFile;
        try { boxFile = await uploadFileToBox(folderId, fname, buf, thumbMimeFromName(fname)); }
        catch (e) {
          if (e.response && e.response.status === 409) {
            const dot = fname.lastIndexOf('.');
            const alt = dot > 0 ? `${fname.slice(0, dot)}_${Date.now().toString(36)}${fname.slice(dot)}` : `${fname}_${Date.now().toString(36)}`;
            boxFile = await uploadFileToBox(folderId, alt, buf, thumbMimeFromName(fname));
          } else throw e;
        }
        // 3. repoint FileUrl → Box + clear Caspio linkage (BEFORE the delete)
        const boxUrl = `${THUMB_ARCHIVE_PROXY_BASE}/api/box/thumbnail/${boxFile.id}`;
        await makeCaspioRequest('put', '/tables/Shopworks_Thumbnail_Report/records',
          { 'q.where': `ID_Serial=${id}` }, { FileUrl: boxUrl, ExternalKey: '', FileSizeNumber: null });
        // 4. delete the Caspio file (frees the storage); 404 = already gone
        try { await axios.delete(`${v3}/files/${key}`, { headers: H, timeout: 20000 }); }
        catch (e) { if (!(e.response && e.response.status === 404)) throw e; }
        return { bytes: rec.FileSizeNumber || 0 };
      }));
      settled.forEach((s, j) => {
        if (s.status === 'fulfilled') { archived++; bytes += s.value.bytes; }
        else {
          errored++;
          const e = s.reason;
          const d = e.response ? JSON.stringify(e.response.data) : e.message;
          errors.push({ ID_Serial: wave[j] && wave[j].ID_Serial, error: String(d).slice(0, 300) });
          console.error(`[thumb-archive] ${wave[j] && wave[j].ID_Serial}:`, d);
        }
      });
      if (i + CONC < records.length) await new Promise(r => setTimeout(r, 400));
    }

    const mbFreed = Number((bytes / 1048576).toFixed(1));
    console.log(`[thumb-archive] archived ${archived}, errored ${errored}, ~${mbFreed}MB freed`);
    res.json({ success: errored === 0, summary: { archived, errored, mbFreed }, moreLikely: records.length === limit, errors: errors.slice(0, 10) });
  } catch (error) {
    console.error('[thumb-archive] failed:', error.response ? JSON.stringify(error.response.data) : error.message);
    res.status(500).json({ success: false, error: 'archive failed: ' + error.message });
  }
});

module.exports = router;
