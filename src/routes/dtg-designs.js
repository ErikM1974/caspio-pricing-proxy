/**
 * DTG Designs Routes
 *
 * Queries the Caspio `Designs2026` table for DTG designs (DesignType = 45)
 * scoped to a single customer. Used by the DTG quote builder's "Design #"
 * picker — rep picks a customer, the picker loads the customer's DTG
 * designs so the rep can pick one instead of typing the ID from memory.
 *
 * Endpoints:
 *   GET /api/dtg-designs/by-customer/:customerId  → DTG designs for a customer
 *
 * The DesignType filter is HARD-CODED to 45 (DTG). This endpoint is
 * intentionally scoped to DTG-only use cases. Other production methods
 * (embroidery=2, screen print=1/6, etc.) should get their own *-designs
 * endpoint when needed — keeps the API surface obvious from the URL.
 *
 * Related endpoints (existing — DO call these too on the frontend):
 *   GET /api/thumbnails/by-design/:designId   → single thumbnail
 *   GET /api/thumbnails/by-designs?ids=X,Y,Z  → batch (max 20)
 *   GET /api/files/:externalKey               → serve the actual JPG/PNG
 */

const express = require('express');
const router = express.Router();
const { makeCaspioRequest, fetchAllCaspioPages } = require('../utils/caspio');

const DESIGNS_TABLE = 'Designs2026';
const DESIGNS_RESOURCE = `/tables/${DESIGNS_TABLE}/records`;
const THUMBNAILS_TABLE = 'Shopworks_Thumbnail_Report';
const THUMBNAILS_RESOURCE = `/tables/${THUMBNAILS_TABLE}/records`;
const PROXY_BASE = process.env.PUBLIC_BASE_URL || 'https://caspio-pricing-proxy-ab30a049961a.herokuapp.com';
const DTG_DESIGN_TYPE = 45; // The DesignType code for DTG. Locked, not a query param.
const THUMBNAIL_BATCH_SIZE = 50; // Max design IDs per Caspio OR clause (safe under the ~4000 char q.where limit).

// In-memory cache (5-minute TTL). Matches the pattern in thumbnails.js.
const customerDesignsCache = new Map();
const CACHE_TTL = 5 * 60 * 1000;
const MAX_CACHE_ENTRIES = 200;

/**
 * Sanitize a customer ID. Must be a positive integer up to 10 digits.
 * Returns the integer or null if invalid.
 */
function sanitizeCustomerId(raw) {
    if (raw == null) return null;
    const s = String(raw).trim();
    if (!/^\d{1,10}$/.test(s)) return null;
    const n = parseInt(s, 10);
    return (Number.isFinite(n) && n > 0) ? n : null;
}

/**
 * Shape a Caspio record into the outward-facing API response.
 */
function shape(record) {
    return {
        idDesign: record.ID_Design != null ? String(record.ID_Design) : '',
        designName: record.DesignName || '',
        designType: Number(record.DesignType) || 0,
        active: Number(record.Active) === 1,
        designComplete: Number(record.DesignComplete) === 1,
        isVariation: Number(record.IsVariation) === 1,
        parentDesign: record.ParentDesign ? String(record.ParentDesign) : null,
        locationCount: Number(record.LocationCount) || 0,
        hasThumbnails: Number(record.HasThumbnails) || 0,
        artist: record.Artist || '',
        dateDesigned: record.DateDesigned || '',
        dateCreated: record.DateCreated || '',
        notesToProduction: record.NotesToProduction || '',
        // Filled in below by enrichWithThumbnails(). null when no thumbnail found.
        thumbnailUrl: null,
        thumbnailFileName: null,
        thumbnailName: null, // human-readable, e.g. "T2085 L/C Murrey's Disposal"
    };
}

/**
 * Fetch thumbnails for an array of design IDs in batched Caspio queries.
 * Returns a Map<idDesign, { thumbnailUrl, thumbnailFileName, thumbnailName }>.
 *
 * A design can have multiple thumbnail rows (one per print location). We
 * keep the FIRST one we find per ID — the picker just needs a single
 * preview image. Reps can drill into all locations via the ShopWorks UI
 * if they need to.
 */
async function fetchThumbnailsForDesigns(designIds) {
    if (!Array.isArray(designIds) || designIds.length === 0) return new Map();

    const byId = new Map();

    // Batch the IDs to keep each q.where under Caspio's ~4000-char limit.
    for (let i = 0; i < designIds.length; i += THUMBNAIL_BATCH_SIZE) {
        const batch = designIds.slice(i, i + THUMBNAIL_BATCH_SIZE);
        const whereClause = batch
            .map((id) => `Thumb_DesLocid_Design='${String(id).replace(/'/g, "''")}'`)
            .join(' OR ');
        const params = {
            'q.where': whereClause,
            'q.limit': batch.length * 5, // up to 5 thumbs per design (locations); we'll dedupe to first
        };

        try {
            const response = await makeCaspioRequest('get', THUMBNAILS_RESOURCE, params);
            const records = Array.isArray(response) ? response : (response?.Result || []);
            for (const rec of records) {
                const key = String(rec.Thumb_DesLocid_Design);
                if (byId.has(key)) continue; // already have a thumbnail for this design, skip duplicates
                const externalKey = rec.ExternalKey || '';
                const url = externalKey
                    ? `${PROXY_BASE}/api/files/${externalKey}`
                    : (rec.FileUrl || null);
                byId.set(key, {
                    thumbnailUrl: url,
                    thumbnailFileName: rec.FileName || '',
                    thumbnailName: rec.Thumb_DesLoc_DesDesignName || '',
                });
            }
        } catch (err) {
            console.warn(`[dtg-designs] thumbnail batch fetch failed (${batch.length} ids):`, err.message);
            // Non-fatal: designs without thumbnails still ship in the response.
        }
    }

    return byId;
}

/**
 * GET /api/dtg-designs/by-customer/:customerId
 *
 * Returns the list of DTG designs (DesignType=45, Active=1) registered
 * for the given customer, sorted most-recent-first by DateCreated.
 *
 * Query params:
 *   - includeVariations (boolean, default false): include variation rows
 *     (IsVariation=1). Variations are typically version-suffix tweaks of a
 *     parent design (e.g. ID_Design "35389.01" is a variation of "35389").
 *     Hidden by default to keep the picker clean.
 *   - limit (integer, default 100, max 500): cap rows returned.
 *   - refresh (boolean, default false): bypass the 5-min cache.
 */
router.get('/dtg-designs/by-customer/:customerId', async (req, res) => {
    try {
        const customerId = sanitizeCustomerId(req.params.customerId);
        if (!customerId) {
            return res.status(400).json({
                success: false,
                error: 'Invalid customer ID — must be a positive integer up to 10 digits',
            });
        }

        const includeVariations = req.query.includeVariations === 'true';
        const limitRaw = parseInt(req.query.limit, 10);
        const limit = (Number.isFinite(limitRaw) && limitRaw > 0)
            ? Math.min(limitRaw, 500)
            : 100;
        const refresh = req.query.refresh === 'true';

        const cacheKey = `dtg:${customerId}:v${includeVariations ? 1 : 0}:l${limit}`;
        if (!refresh) {
            const cached = customerDesignsCache.get(cacheKey);
            if (cached && (Date.now() - cached.timestamp) < CACHE_TTL) {
                console.log(`[dtg-designs] Cache hit for customer ${customerId}`);
                return res.json(cached.data);
            }
        }

        // Build the Caspio WHERE clause. DesignType is locked to DTG (45).
        const whereParts = [
            `ID_Customer=${customerId}`,
            `Active=1`,
            `DesignType=${DTG_DESIGN_TYPE}`,
        ];
        if (!includeVariations) {
            whereParts.push(`IsVariation=0`);
        }
        const params = {
            'q.where': whereParts.join(' AND '),
            'q.orderBy': 'DateCreated DESC, ID_Design DESC',
            'q.limit': limit,
        };

        console.log(`[dtg-designs] Querying ${DESIGNS_TABLE} for customer ${customerId}, where: ${params['q.where']}`);
        const response = await makeCaspioRequest('get', DESIGNS_RESOURCE, params);
        const records = Array.isArray(response) ? response : (response?.Result || []);
        const designs = records.map(shape);

        // Enrich with thumbnails — single batched call against
        // Shopworks_Thumbnail_Report so the frontend only does ONE round-trip
        // to get everything it needs to render the picker.
        if (designs.length > 0) {
            const ids = designs.map((d) => d.idDesign).filter(Boolean);
            const thumbMap = await fetchThumbnailsForDesigns(ids);
            for (const d of designs) {
                const t = thumbMap.get(d.idDesign);
                if (t) {
                    d.thumbnailUrl = t.thumbnailUrl;
                    d.thumbnailFileName = t.thumbnailFileName;
                    d.thumbnailName = t.thumbnailName;
                }
            }
        }

        const withThumbs = designs.filter((d) => d.thumbnailUrl).length;
        console.log(`[dtg-designs] Customer ${customerId}: ${designs.length} designs, ${withThumbs} with thumbnails`);

        const result = {
            success: true,
            count: designs.length,
            withThumbnails: withThumbs,
            customerId,
            designType: DTG_DESIGN_TYPE,
            designs,
        };

        // Cache + trim
        customerDesignsCache.set(cacheKey, { data: result, timestamp: Date.now() });
        if (customerDesignsCache.size > MAX_CACHE_ENTRIES) {
            const firstKey = customerDesignsCache.keys().next().value;
            customerDesignsCache.delete(firstKey);
        }

        res.set('Cache-Control', 'private, max-age=300'); // 5min client-side cache too
        res.json(result);
    } catch (err) {
        console.error('[dtg-designs] error:', err.message);
        res.status(500).json({
            success: false,
            error: 'Failed to fetch DTG designs',
            details: err.message,
        });
    }
});

module.exports = router;
