/**
 * Designs by Method Route — generalized customer-aware design lookup
 *
 * Generalized version of dtg-designs.js. Accepts a `method` query param
 * to filter Designs2026 by the right DesignType code:
 *
 *   method=dtg   → DesignType=45 (DTG)
 *   method=dtf   → DesignType=8  (DTF Transfer)
 *   method=emb   → DesignType=2  (Embroidery)
 *   method=scp   → DesignType=1  (Screen Print)
 *   method=sticker → DesignType=4
 *   method=emblem  → DesignType=5
 *
 * Same data shape, same thumbnail enrichment, same 5-min cache as
 * dtg-designs.js. Allows ONE shared frontend widget to serve all 4
 * production methods without forking the backend.
 *
 * Endpoints:
 *   GET /api/designs/by-customer/:customerId?method=dtf|dtg|emb|scp
 *
 * Created 2026-05-24 — Phase 11.1 (customer-aware design lookup for
 * EMB/DTF/SCP). dtg-designs.js stays in place for backward compat.
 */

const express = require('express');
const router = express.Router();
const { makeCaspioRequest } = require('../utils/caspio');

const DESIGNS_TABLE = 'Designs2026';
const DESIGNS_RESOURCE = `/tables/${DESIGNS_TABLE}/records`;
const THUMBNAILS_TABLE = 'Shopworks_Thumbnail_Report';
const THUMBNAILS_RESOURCE = `/tables/${THUMBNAILS_TABLE}/records`;
const PROXY_BASE = process.env.PUBLIC_BASE_URL || 'https://caspio-pricing-proxy-ab30a049961a.herokuapp.com';
const THUMBNAIL_BATCH_SIZE = 50;

// DesignType code per method (matches server.js DESIGN_TYPE_ID at line 2798)
const METHOD_TO_DESIGN_TYPE = {
    dtg:         45,
    dtf:         8,
    emb:         2,
    embroidery:  2,
    scp:         1,
    screenprint: 1,
    sticker:     4,
    emblem:      5,
};

// In-memory cache (5-minute TTL)
const customerDesignsCache = new Map();
const CACHE_TTL = 5 * 60 * 1000;
const MAX_CACHE_ENTRIES = 200;

function sanitizeCustomerId(raw) {
    if (raw == null) return null;
    const s = String(raw).trim();
    if (!/^\d{1,10}$/.test(s)) return null;
    const n = parseInt(s, 10);
    return (Number.isFinite(n) && n > 0) ? n : null;
}

function sanitizeMethod(raw) {
    if (!raw) return null;
    const m = String(raw).trim().toLowerCase();
    return METHOD_TO_DESIGN_TYPE[m] != null ? m : null;
}

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
        thumbnailUrl: null,
        thumbnailFileName: null,
        thumbnailName: null,
    };
}

async function fetchThumbnailsForDesigns(designIds) {
    if (!Array.isArray(designIds) || designIds.length === 0) return new Map();
    const byId = new Map();
    for (let i = 0; i < designIds.length; i += THUMBNAIL_BATCH_SIZE) {
        const batch = designIds.slice(i, i + THUMBNAIL_BATCH_SIZE);
        const whereClause = batch
            .map((id) => `Thumb_DesLocid_Design='${String(id).replace(/'/g, "''")}'`)
            .join(' OR ');
        const params = {
            'q.where': whereClause,
            'q.limit': batch.length * 5,
        };
        try {
            const response = await makeCaspioRequest('get', THUMBNAILS_RESOURCE, params);
            const records = Array.isArray(response) ? response : (response?.Result || []);
            for (const rec of records) {
                const key = String(rec.Thumb_DesLocid_Design);
                if (byId.has(key)) continue;
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
            console.warn(`[designs-by-method] thumbnail batch fetch failed (${batch.length} ids):`, err.message);
        }
    }
    return byId;
}

/**
 * GET /api/designs/by-customer/:customerId?method=<method>
 *
 * Returns designs registered for the given customer filtered by method's
 * DesignType code. Sorted most-recent-first by DateCreated.
 *
 * Query params:
 *   - method (REQUIRED): 'dtg'|'dtf'|'emb'|'scp' (also 'embroidery', 'screenprint', 'sticker', 'emblem')
 *   - includeVariations (boolean, default false)
 *   - limit (integer, default 100, max 500)
 *   - refresh (boolean, default false): bypass 5-min cache
 */
router.get('/designs/by-customer/:customerId', async (req, res) => {
    try {
        const customerId = sanitizeCustomerId(req.params.customerId);
        if (!customerId) {
            return res.status(400).json({
                success: false,
                error: 'Invalid customer ID — must be a positive integer up to 10 digits',
            });
        }

        const method = sanitizeMethod(req.query.method);
        if (!method) {
            return res.status(400).json({
                success: false,
                error: 'Invalid or missing method query param. Valid: ' + Object.keys(METHOD_TO_DESIGN_TYPE).join(', '),
            });
        }

        const designType = METHOD_TO_DESIGN_TYPE[method];
        const includeVariations = req.query.includeVariations === 'true';
        const limitRaw = parseInt(req.query.limit, 10);
        const limit = (Number.isFinite(limitRaw) && limitRaw > 0) ? Math.min(limitRaw, 500) : 100;
        const refresh = req.query.refresh === 'true';

        const cacheKey = `${method}:${customerId}:v${includeVariations ? 1 : 0}:l${limit}`;
        if (!refresh) {
            const cached = customerDesignsCache.get(cacheKey);
            if (cached && (Date.now() - cached.timestamp) < CACHE_TTL) {
                console.log(`[designs-by-method] Cache hit for ${method} / customer ${customerId}`);
                return res.json(cached.data);
            }
        }

        const whereParts = [
            `ID_Customer=${customerId}`,
            `Active=1`,
            `DesignType=${designType}`,
        ];
        if (!includeVariations) {
            whereParts.push(`IsVariation=0`);
        }
        const params = {
            'q.where': whereParts.join(' AND '),
            'q.orderBy': 'DateCreated DESC, ID_Design DESC',
            'q.limit': limit,
        };

        console.log(`[designs-by-method] Query: ${params['q.where']}`);
        const response = await makeCaspioRequest('get', DESIGNS_RESOURCE, params);
        const records = Array.isArray(response) ? response : (response?.Result || []);
        const designs = records.map(shape);

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
        console.log(`[designs-by-method] ${method} / customer ${customerId}: ${designs.length} designs, ${withThumbs} with thumbnails`);

        const result = {
            success: true,
            method,
            count: designs.length,
            withThumbnails: withThumbs,
            customerId,
            designType,
            designs,
        };

        customerDesignsCache.set(cacheKey, { data: result, timestamp: Date.now() });
        if (customerDesignsCache.size > MAX_CACHE_ENTRIES) {
            const firstKey = customerDesignsCache.keys().next().value;
            customerDesignsCache.delete(firstKey);
        }

        res.set('Cache-Control', 'private, max-age=300');
        res.json(result);
    } catch (err) {
        console.error('[designs-by-method] error:', err.message);
        res.status(500).json({
            success: false,
            error: 'Failed to fetch designs',
            details: err.message,
        });
    }
});

module.exports = router;
