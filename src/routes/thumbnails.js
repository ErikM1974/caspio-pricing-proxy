/**
 * Thumbnail Lookup Routes
 * Provides endpoints for looking up design thumbnails from Shopworks_Thumbnail_Report
 */

const express = require('express');
const router = express.Router();
const { makeCaspioRequest } = require('../utils/caspio');

// Simple cache (5-minute TTL)
const thumbnailCache = new Map();
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
      '/tables/Shopworks_Thumbnail_Report/records',
      'GET',
      null,
      params
    );

    const records = response?.Result || [];

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

module.exports = router;
