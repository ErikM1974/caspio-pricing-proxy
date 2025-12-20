/**
 * Thumbnail Lookup Routes
 * Provides endpoints for looking up design thumbnails from Shopworks_Thumbnail_Report
 */

const express = require('express');
const router = express.Router();
const { makeCaspioRequest, fetchAllCaspioPages } = require('../utils/caspio');

// Simple cache (5-minute TTL)
const thumbnailCache = new Map();
const topSellersCache = new Map();
const CACHE_TTL = 5 * 60 * 1000;

/**
 * Sanitize design ID input
 * @param {string} designId - Raw design ID
 * @returns {string|null} - Sanitized ID or null if invalid
 */
function sanitizeDesignId(designId) {
  if (!designId || typeof designId !== 'string') return null;
  const sanitized = designId.replace(/[^a-zA-Z0-9-_]/g, '');
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

    // Update record in Caspio
    const updateParams = {
      'q.where': `ID_Serial=${id}`
    };

    await makeCaspioRequest(
      'put',
      '/tables/Shopworks_Thumbnail_Report/records',
      updateParams,
      { ExternalKey: externalKey }
    );

    console.log(`[Thumbnails] Updated ExternalKey for thumbnail ${id}`);

    // Clear any cached entries that might reference this thumbnail
    // (we don't know the designId, so we can't clear specifically)

    res.json({
      success: true,
      thumbnailId: id,
      message: 'ExternalKey updated successfully'
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

module.exports = router;
