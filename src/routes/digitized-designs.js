// Digitized Designs API
// Queries Caspio Digitized_Designs_Master_2026 table for design lookups
// Primary use: auto-detect stitch counts during ShopWorks import in embroidery quote builder
//
// Key endpoint: GET /api/digitized-designs/lookup?designs=29988,39112
// Returns stitch counts, tiers, surcharges grouped by design number

const express = require('express');
const router = express.Router();
const { fetchAllCaspioPages, makeCaspioRequest } = require('../utils/caspio');

const TABLE = 'Digitized_Designs_Master_2026';
const RESOURCE_PATH = `/tables/${TABLE}/records`;

// Cache (15 min TTL - designs rarely change)
const designsCache = new Map();
const CACHE_TTL = 15 * 60 * 1000;

// Fields to return in lookup responses (skip large/unnecessary fields)
const LOOKUP_FIELDS = [
    'ID_Unique', 'Design_Number', 'Design_Description', 'Company', 'Customer_ID',
    'Stitch_Count', 'Stitch_Tier', 'AS_Surcharge', 'DST_Filename',
    'Color_Changes', 'Extra_Colors', 'Extra_Color_Surcharge',
    'FB_Price_1_7', 'FB_Price_8_23', 'FB_Price_24_47', 'FB_Price_48_71', 'FB_Price_72plus',
    'DST_Preview_URL', 'Thumbnail_URL'
].join(',');

/**
 * Sanitize a design number — digits only
 * @param {string} input
 * @returns {string|null}
 */
function sanitizeDesignNumber(input) {
    if (!input || typeof input !== 'string') return null;
    const sanitized = input.replace(/[^\d]/g, '').trim();
    return (sanitized.length > 0 && sanitized.length <= 10) ? sanitized : null;
}

/**
 * Group raw Caspio records by Design_Number and compute max stitch info
 * @param {Array} records - Raw Caspio records
 * @param {string[]} requestedNumbers - Original requested design numbers
 * @returns {{ designs: Object, notFound: string[] }}
 */
function groupByDesignNumber(records, requestedNumbers) {
    const grouped = {};

    for (const rec of records) {
        const dn = String(rec.Design_Number);
        if (!grouped[dn]) {
            grouped[dn] = {
                designNumber: dn,
                company: rec.Company || '',
                customerId: rec.Customer_ID || '',
                variants: [],
                maxStitchCount: 0,
                maxStitchTier: 'Standard',
                maxAsSurcharge: 0,
                hasFBPricing: false
            };
        }

        const stitchCount = parseInt(rec.Stitch_Count, 10) || 0;
        const asSurcharge = parseFloat(rec.AS_Surcharge) || 0;

        grouped[dn].variants.push({
            idUnique: rec.ID_Unique,
            dstFilename: rec.DST_Filename || '',
            designDescription: rec.Design_Description || '',
            stitchCount,
            stitchTier: rec.Stitch_Tier || 'Standard',
            asSurcharge,
            colorChanges: parseInt(rec.Color_Changes, 10) || 0,
            extraColors: parseInt(rec.Extra_Colors, 10) || 0,
            extraColorSurcharge: parseFloat(rec.Extra_Color_Surcharge) || 0,
            fbPrice1_7: parseFloat(rec.FB_Price_1_7) || 0,
            fbPrice8_23: parseFloat(rec.FB_Price_8_23) || 0,
            fbPrice24_47: parseFloat(rec.FB_Price_24_47) || 0,
            fbPrice48_71: parseFloat(rec.FB_Price_48_71) || 0,
            fbPrice72plus: parseFloat(rec.FB_Price_72plus) || 0,
            dstPreviewUrl: rec.DST_Preview_URL || '',
            thumbnailUrl: rec.Thumbnail_URL || ''
        });

        // Track maximums
        if (stitchCount > grouped[dn].maxStitchCount) {
            grouped[dn].maxStitchCount = stitchCount;
            grouped[dn].maxStitchTier = rec.Stitch_Tier || 'Standard';
            grouped[dn].maxAsSurcharge = asSurcharge;
        }

        // Check if any variant has FB pricing
        const fbPrice = parseFloat(rec.FB_Price_1_7) || 0;
        if (fbPrice > 0) {
            grouped[dn].hasFBPricing = true;
        }
    }

    // Find design numbers that weren't in the database
    const foundNumbers = new Set(Object.keys(grouped));
    const notFound = requestedNumbers.filter(n => !foundNumbers.has(n));

    return { designs: grouped, notFound };
}


// ============================================
// LOOKUP ENDPOINT (primary - used by import)
// ============================================

/**
 * GET /api/digitized-designs/lookup?designs=29988,39112,39113
 * Returns design records grouped by design number with max stitch info
 */
router.get('/digitized-designs/lookup', async (req, res) => {
    const { designs } = req.query;

    if (!designs || typeof designs !== 'string') {
        return res.status(400).json({
            success: false,
            error: 'Missing required query parameter: designs (comma-separated design numbers)'
        });
    }

    // Parse and sanitize design numbers
    const rawNumbers = designs.split(',').map(s => s.trim());
    const designNumbers = rawNumbers.map(sanitizeDesignNumber).filter(Boolean);

    if (designNumbers.length === 0) {
        return res.status(400).json({
            success: false,
            error: 'No valid design numbers provided. Use digits only.'
        });
    }

    if (designNumbers.length > 20) {
        return res.status(400).json({
            success: false,
            error: 'Maximum 20 design numbers per lookup request'
        });
    }

    try {
        // Check cache first
        const cacheKey = `lookup:${designNumbers.sort().join(',')}`;
        const cached = designsCache.get(cacheKey);
        if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
            console.log(`[CACHE HIT] digitized-designs lookup: ${designNumbers.join(',')}`);
            return res.json(cached.data);
        }

        console.log(`[Digitized Designs] Looking up designs: ${designNumbers.join(', ')}`);

        // Build WHERE clause: Design_Number IN ('29988','39112','39113')
        const inList = designNumbers.map(n => `'${n}'`).join(',');
        const whereClause = `Design_Number IN (${inList})`;

        const records = await fetchAllCaspioPages(RESOURCE_PATH, {
            'q.where': whereClause,
            'q.select': LOOKUP_FIELDS
        });

        console.log(`[Digitized Designs] Found ${records.length} records for ${designNumbers.length} design numbers`);

        const result = groupByDesignNumber(records, designNumbers);
        const response = {
            success: true,
            ...result,
            count: Object.keys(result.designs).length,
            totalVariants: records.length
        };

        // Cache the result
        designsCache.set(cacheKey, {
            data: response,
            timestamp: Date.now()
        });

        res.json(response);
    } catch (error) {
        console.error('[Digitized Designs] Lookup failed:', error.message);
        res.status(500).json({
            success: false,
            error: 'Failed to look up designs',
            details: error.message
        });
    }
});


// ============================================
// SINGLE DESIGN LOOKUP
// ============================================

/**
 * GET /api/digitized-designs/design/:designNumber
 * Returns all variants for a single design number
 */
router.get('/digitized-designs/design/:designNumber', async (req, res) => {
    const designNumber = sanitizeDesignNumber(req.params.designNumber);

    if (!designNumber) {
        return res.status(400).json({
            success: false,
            error: 'Valid numeric design number required'
        });
    }

    try {
        const records = await fetchAllCaspioPages(RESOURCE_PATH, {
            'q.where': `Design_Number='${designNumber}'`,
            'q.select': LOOKUP_FIELDS
        });

        if (records.length === 0) {
            return res.status(404).json({
                success: false,
                error: `Design #${designNumber} not found`
            });
        }

        const result = groupByDesignNumber(records, [designNumber]);
        res.json({
            success: true,
            data: result.designs[designNumber]
        });
    } catch (error) {
        console.error(`[Digitized Designs] Get design ${designNumber} failed:`, error.message);
        res.status(500).json({
            success: false,
            error: 'Failed to fetch design',
            details: error.message
        });
    }
});


// ============================================
// LIST ALL (admin/reference)
// ============================================

/**
 * GET /api/digitized-designs
 * Fetch all designs with optional filters
 * Query params: company, tier, refresh
 */
router.get('/digitized-designs', async (req, res) => {
    const { company, tier, refresh } = req.query;
    const forceRefresh = refresh === 'true';

    try {
        const cacheKey = 'all-digitized-designs';
        const cached = designsCache.get(cacheKey);

        let records;
        if (!forceRefresh && cached && Date.now() - cached.timestamp < CACHE_TTL) {
            console.log('[CACHE HIT] digitized-designs all');
            records = cached.data;
        } else {
            console.log('[CACHE MISS] digitized-designs - fetching from Caspio');
            records = await fetchAllCaspioPages(RESOURCE_PATH, {});

            designsCache.set(cacheKey, {
                data: records,
                timestamp: Date.now()
            });

            console.log(`[Digitized Designs] Fetched ${records.length} records from Caspio`);
        }

        // Apply filters
        let results = records;
        if (company) {
            const companyLower = company.toLowerCase();
            results = results.filter(d =>
                d.Company && d.Company.toLowerCase().includes(companyLower)
            );
        }
        if (tier) {
            const tierLower = tier.toLowerCase();
            results = results.filter(d =>
                d.Stitch_Tier && d.Stitch_Tier.toLowerCase() === tierLower
            );
        }

        res.json({
            success: true,
            data: results,
            count: results.length,
            source: 'caspio'
        });
    } catch (error) {
        console.error('[Digitized Designs] List failed:', error.message);
        res.status(500).json({
            success: false,
            error: 'Failed to fetch digitized designs',
            details: error.message
        });
    }
});


// ============================================
// GET BY ID
// ============================================

/**
 * GET /api/digitized-designs/:id
 * Get single record by ID_Unique
 */
router.get('/digitized-designs/:id', async (req, res) => {
    const { id } = req.params;

    // Skip route collisions
    if (['cache', 'lookup', 'design', 'seed'].includes(id)) return;

    if (!id || typeof id !== 'string' || id.length > 20) {
        return res.status(400).json({
            success: false,
            error: 'Valid ID_Unique is required'
        });
    }

    try {
        const records = await fetchAllCaspioPages(RESOURCE_PATH, {
            'q.where': `ID_Unique='${id.replace(/[^a-zA-Z0-9]/g, '')}'`
        });

        if (records.length === 0) {
            return res.status(404).json({
                success: false,
                error: `Design with ID_Unique='${id}' not found`
            });
        }

        res.json({
            success: true,
            data: records[0]
        });
    } catch (error) {
        console.error(`[Digitized Designs] Get by ID failed for ${id}:`, error.message);
        res.status(500).json({
            success: false,
            error: 'Failed to fetch design',
            details: error.message
        });
    }
});


// ============================================
// CREATE
// ============================================

/**
 * POST /api/digitized-designs
 * Create a new design record
 */
router.post('/digitized-designs', async (req, res) => {
    const record = req.body;

    if (!record.Design_Number) {
        return res.status(400).json({
            success: false,
            error: 'Design_Number is required'
        });
    }

    try {
        console.log(`[Digitized Designs] Creating design: ${record.Design_Number}`);
        const result = await makeCaspioRequest('post', RESOURCE_PATH, {}, record);

        designsCache.clear();

        res.status(201).json({
            success: true,
            message: `Design #${record.Design_Number} created successfully`,
            data: result
        });
    } catch (error) {
        console.error('[Digitized Designs] Create failed:', error.message);
        res.status(500).json({
            success: false,
            error: 'Failed to create design',
            details: error.message
        });
    }
});


// ============================================
// UPDATE
// ============================================

/**
 * PUT /api/digitized-designs/:id
 * Update design by ID_Unique
 */
router.put('/digitized-designs/:id', async (req, res) => {
    const { id } = req.params;
    const updates = req.body;

    if (!id) {
        return res.status(400).json({
            success: false,
            error: 'ID_Unique is required'
        });
    }

    // Remove primary key from updates
    delete updates.ID_Unique;

    if (Object.keys(updates).length === 0) {
        return res.status(400).json({
            success: false,
            error: 'No fields to update'
        });
    }

    try {
        const safeId = id.replace(/[^a-zA-Z0-9]/g, '');
        console.log(`[Digitized Designs] Updating ID_Unique=${safeId}:`, Object.keys(updates));
        await makeCaspioRequest('put', RESOURCE_PATH,
            { 'q.where': `ID_Unique='${safeId}'` }, updates);

        designsCache.clear();

        res.json({
            success: true,
            message: `Design ${safeId} updated successfully`,
            updatedFields: Object.keys(updates)
        });
    } catch (error) {
        console.error(`[Digitized Designs] Update failed for ${id}:`, error.message);
        res.status(500).json({
            success: false,
            error: 'Failed to update design',
            details: error.message
        });
    }
});


// ============================================
// DELETE
// ============================================

/**
 * DELETE /api/digitized-designs/:id
 * Delete design by ID_Unique
 */
router.delete('/digitized-designs/:id', async (req, res) => {
    const { id } = req.params;

    if (!id) {
        return res.status(400).json({
            success: false,
            error: 'ID_Unique is required'
        });
    }

    try {
        const safeId = id.replace(/[^a-zA-Z0-9]/g, '');
        console.log(`[Digitized Designs] Deleting ID_Unique=${safeId}`);
        await makeCaspioRequest('delete', RESOURCE_PATH,
            { 'q.where': `ID_Unique='${safeId}'` });

        designsCache.clear();

        res.json({
            success: true,
            message: `Design ${safeId} deleted successfully`
        });
    } catch (error) {
        console.error(`[Digitized Designs] Delete failed for ${id}:`, error.message);
        res.status(500).json({
            success: false,
            error: 'Failed to delete design',
            details: error.message
        });
    }
});


// ============================================
// CACHE MANAGEMENT
// ============================================

router.get('/digitized-designs/cache/clear', (req, res) => {
    designsCache.clear();
    console.log('[Digitized Designs] Cache cleared');
    res.json({
        success: true,
        message: 'Digitized designs cache cleared'
    });
});


module.exports = router;
