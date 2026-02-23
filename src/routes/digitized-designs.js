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
// FALLBACK LOOKUP — ShopWorks_Designs table
// ============================================

const FALLBACK_TABLE = 'ShopWorks_Designs';
const FALLBACK_RESOURCE = `/tables/${FALLBACK_TABLE}/records`;
const FALLBACK_FIELDS = [
    'Design_Number', 'Design_Name', 'Company_Name', 'Design_Code',
    'Thread_Colors', 'Color_Count', 'Last_Order_Date', 'Order_Count',
    'Design_Type_ID', 'Stitch_Count', 'Stitch_Tier', 'AS_Surcharge', 'Has_Stitch_Data'
].join(',');

/**
 * GET /api/digitized-designs/fallback?designs=435,1363,5373
 * Fallback lookup for designs NOT found in master table.
 * Queries ShopWorks_Designs table — returns name, company, colors,
 * and stitch data if enriched from master.
 */
router.get('/digitized-designs/fallback', async (req, res) => {
    const { designs } = req.query;

    if (!designs || typeof designs !== 'string') {
        return res.status(400).json({
            success: false,
            error: 'Missing required query parameter: designs (comma-separated design numbers)'
        });
    }

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
            error: 'Maximum 20 design numbers per fallback request'
        });
    }

    try {
        const cacheKey = `fallback:${designNumbers.sort().join(',')}`;
        const cached = designsCache.get(cacheKey);
        if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
            console.log(`[CACHE HIT] digitized-designs fallback: ${designNumbers.join(',')}`);
            return res.json(cached.data);
        }

        console.log(`[Digitized Designs] Fallback lookup: ${designNumbers.join(', ')}`);

        const inList = designNumbers.map(n => `'${n}'`).join(',');
        const whereClause = `Design_Number IN (${inList})`;

        const records = await fetchAllCaspioPages(FALLBACK_RESOURCE, {
            'q.where': whereClause,
            'q.select': FALLBACK_FIELDS
        });

        console.log(`[Digitized Designs] Fallback found ${records.length} records for ${designNumbers.length} design numbers`);

        // Build response grouped by design number
        const foundDesigns = {};
        for (const rec of records) {
            const dn = String(rec.Design_Number);
            foundDesigns[dn] = {
                designNumber: dn,
                designName: rec.Design_Name || '',
                companyName: rec.Company_Name || '',
                designCode: rec.Design_Code || '',
                threadColors: rec.Thread_Colors || '',
                colorCount: parseInt(rec.Color_Count, 10) || 0,
                lastOrderDate: rec.Last_Order_Date || '',
                orderCount: parseInt(rec.Order_Count, 10) || 0,
                designTypeId: parseInt(rec.Design_Type_ID, 10) || 0,
                stitchCount: parseInt(rec.Stitch_Count, 10) || 0,
                stitchTier: rec.Stitch_Tier || '',
                asSurcharge: parseFloat(rec.AS_Surcharge) || 0,
                hasStitchData: rec.Has_Stitch_Data === true || rec.Has_Stitch_Data === 'Yes' || rec.Has_Stitch_Data === 1
            };
        }

        const foundNumbers = new Set(Object.keys(foundDesigns));
        const notFound = designNumbers.filter(n => !foundNumbers.has(n));

        const response = {
            success: true,
            designs: foundDesigns,
            notFound,
            count: Object.keys(foundDesigns).length
        };

        designsCache.set(cacheKey, { data: response, timestamp: Date.now() });
        res.json(response);
    } catch (error) {
        console.error('[Digitized Designs] Fallback lookup failed:', error.message);
        res.status(500).json({
            success: false,
            error: 'Failed to look up designs from ShopWorks table',
            details: error.message
        });
    }
});


// ============================================
// SEARCH ENDPOINT — by design number or company
// ============================================

/**
 * GET /api/digitized-designs/search?q=<term>&limit=20
 * Searches Digitized_Designs_Master_2026 by design number or company name.
 * If q is all digits → exact/starts-with match on Design_Number
 * If q has letters → contains match on Company
 * Returns results grouped by design number with stitch info.
 */
router.get('/digitized-designs/search', async (req, res) => {
    const { q, limit: limitParam } = req.query;

    if (!q || typeof q !== 'string' || q.trim().length < 2) {
        return res.status(400).json({
            success: false,
            error: 'Search query must be at least 2 characters'
        });
    }

    const searchTerm = q.trim();
    const resultLimit = Math.min(Math.max(parseInt(limitParam, 10) || 20, 1), 50);
    const isNumeric = /^\d+$/.test(searchTerm);

    try {
        const cacheKey = `search:${searchTerm.toLowerCase()}:${resultLimit}`;
        const cached = designsCache.get(cacheKey);
        if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
            console.log(`[CACHE HIT] digitized-designs search: "${searchTerm}"`);
            return res.json(cached.data);
        }

        console.log(`[Digitized Designs] Search: "${searchTerm}" (${isNumeric ? 'numeric' : 'text'})`);

        let whereClause;
        if (isNumeric) {
            // Exact match or starts-with for design numbers
            const sanitized = sanitizeDesignNumber(searchTerm);
            if (!sanitized) {
                return res.status(400).json({ success: false, error: 'Invalid design number' });
            }
            whereClause = `Design_Number='${sanitized}' OR Design_Number LIKE '${sanitized}%'`;
        } else {
            // Company name contains (escape single quotes)
            const escaped = searchTerm.replace(/'/g, "''");
            whereClause = `Company LIKE '%${escaped}%'`;
        }

        const records = await fetchAllCaspioPages(RESOURCE_PATH, {
            'q.where': whereClause,
            'q.select': LOOKUP_FIELDS,
            'q.limit': String(200) // Fetch enough to group, then limit
        });

        console.log(`[Digitized Designs] Search found ${records.length} raw records for "${searchTerm}"`);

        // Group by design number
        const grouped = {};
        for (const rec of records) {
            const dn = String(rec.Design_Number);
            if (!grouped[dn]) {
                grouped[dn] = {
                    designNumber: dn,
                    company: rec.Company || '',
                    customerId: rec.Customer_ID || '',
                    maxStitchCount: 0,
                    maxStitchTier: 'Standard',
                    maxAsSurcharge: 0,
                    variantCount: 0,
                    dstFilenames: []
                };
            }

            const stitchCount = parseInt(rec.Stitch_Count, 10) || 0;
            grouped[dn].variantCount++;
            grouped[dn].dstFilenames.push(rec.DST_Filename || '');

            if (stitchCount > grouped[dn].maxStitchCount) {
                grouped[dn].maxStitchCount = stitchCount;
                grouped[dn].maxStitchTier = rec.Stitch_Tier || 'Standard';
                grouped[dn].maxAsSurcharge = parseFloat(rec.AS_Surcharge) || 0;
            }
        }

        // Convert to array, sort by design number, limit results
        const results = Object.values(grouped)
            .sort((a, b) => parseInt(a.designNumber) - parseInt(b.designNumber))
            .slice(0, resultLimit);

        const response = {
            success: true,
            query: searchTerm,
            searchType: isNumeric ? 'design_number' : 'company',
            results,
            count: results.length,
            totalMatches: Object.keys(grouped).length
        };

        designsCache.set(cacheKey, { data: response, timestamp: Date.now() });
        res.json(response);
    } catch (error) {
        console.error(`[Digitized Designs] Search failed for "${searchTerm}":`, error.message);
        res.status(500).json({
            success: false,
            error: 'Search failed',
            details: error.message
        });
    }
});


// ============================================
// UNIFIED SEARCH — All 4 design tables
// ============================================

// Select fields for each table (avoid SELECT *)
const SEARCH_ALL_FIELDS = {
    shopworks: 'Design_Number,Design_Name,Company_Name,Stitch_Count,Stitch_Tier,Thread_Colors,Last_Order_Date,Order_Count',
    thumbnail: 'Thumb_DesLocid_Design,Thumb_DesLoc_DesDesignName,ExternalKey,FileUrl',
    artRequests: 'Design_Num_SW,ID_Design,CompanyName,CDN_Link,Garment_Placement,NOTES,Date_Created,Shopwork_customer_number'
};

/**
 * GET /api/digitized-designs/search-all?q=<term>&limit=20
 * Searches 4 design tables in parallel:
 *   1. Digitized_Designs_Master_2026 (stitch data)
 *   2. ShopWorks_Designs (design names, colors, order history)
 *   3. Shopworks_Thumbnail_Report (design images)
 *   4. ArtRequests (artwork mockups, placement notes)
 *
 * Results merged & deduplicated by design number. Master table wins for stitch data.
 */
router.get('/digitized-designs/search-all', async (req, res) => {
    const { q, limit: limitParam } = req.query;

    if (!q || typeof q !== 'string' || q.trim().length < 2) {
        return res.status(400).json({
            success: false,
            error: 'Search query must be at least 2 characters'
        });
    }

    const searchTerm = q.trim();
    const resultLimit = Math.min(Math.max(parseInt(limitParam, 10) || 20, 1), 50);
    const isNumeric = /^\d+$/.test(searchTerm);
    const escaped = searchTerm.replace(/'/g, "''");

    try {
        // Check cache
        const cacheKey = `search-all:${searchTerm.toLowerCase()}:${resultLimit}`;
        const cached = designsCache.get(cacheKey);
        if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
            console.log(`[CACHE HIT] search-all: "${searchTerm}"`);
            return res.json(cached.data);
        }

        console.log(`[Search-All] Searching 4 tables for "${searchTerm}" (${isNumeric ? 'numeric' : 'text'})`);

        // Build WHERE clauses for each table
        let where1, where2, where3, where4;
        if (isNumeric) {
            const sanitized = sanitizeDesignNumber(searchTerm);
            if (!sanitized) {
                return res.status(400).json({ success: false, error: 'Invalid design number' });
            }
            where1 = `Design_Number='${sanitized}' OR Design_Number LIKE '${sanitized}%'`;
            where2 = `Design_Number='${sanitized}' OR Design_Number LIKE '${sanitized}%'`;
            where3 = `Thumb_DesLocid_Design='${sanitized}'`;
            where4 = `Design_Num_SW='${sanitized}' OR ID_Design=${sanitized}`;
        } else {
            where1 = `Company LIKE '%${escaped}%'`;
            where2 = `Company_Name LIKE '%${escaped}%' OR Design_Name LIKE '%${escaped}%'`;
            where3 = `Thumb_DesLoc_DesDesignName LIKE '%${escaped}%'`;
            where4 = `CompanyName LIKE '%${escaped}%'`;
        }

        // Query all 4 tables in parallel with timeout
        const QUERY_TIMEOUT = 8000;
        const withTimeout = (promise, label) => Promise.race([
            promise,
            new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} timeout`)), QUERY_TIMEOUT))
        ]);

        const [r1, r2, r3, r4] = await Promise.allSettled([
            withTimeout(
                fetchAllCaspioPages(RESOURCE_PATH, { 'q.where': where1, 'q.select': LOOKUP_FIELDS, 'q.limit': '200' }),
                'Master'
            ),
            withTimeout(
                fetchAllCaspioPages(`/tables/${FALLBACK_TABLE}/records`, { 'q.where': where2, 'q.select': SEARCH_ALL_FIELDS.shopworks, 'q.limit': '100' }),
                'ShopWorks'
            ),
            withTimeout(
                fetchAllCaspioPages('/tables/Shopworks_Thumbnail_Report/records', { 'q.where': where3, 'q.select': SEARCH_ALL_FIELDS.thumbnail, 'q.limit': '100' }),
                'Thumbnails'
            ),
            withTimeout(
                fetchAllCaspioPages('/tables/ArtRequests/records', { 'q.where': where4, 'q.select': SEARCH_ALL_FIELDS.artRequests, 'q.limit': '100' }),
                'ArtRequests'
            )
        ]);

        const masterRecords = r1.status === 'fulfilled' ? r1.value : [];
        const shopworksRecords = r2.status === 'fulfilled' ? r2.value : [];
        const thumbnailRecords = r3.status === 'fulfilled' ? r3.value : [];
        const artRecords = r4.status === 'fulfilled' ? r4.value : [];

        // Log any failures
        if (r1.status === 'rejected') console.warn(`[Search-All] Master table failed: ${r1.reason.message}`);
        if (r2.status === 'rejected') console.warn(`[Search-All] ShopWorks table failed: ${r2.reason.message}`);
        if (r3.status === 'rejected') console.warn(`[Search-All] Thumbnail table failed: ${r3.reason.message}`);
        if (r4.status === 'rejected') console.warn(`[Search-All] ArtRequests table failed: ${r4.reason.message}`);

        console.log(`[Search-All] Raw hits: Master=${masterRecords.length}, ShopWorks=${shopworksRecords.length}, Thumbnails=${thumbnailRecords.length}, ArtRequests=${artRecords.length}`);

        // Merge into unified results keyed by design number
        const merged = {};

        // 1. Master table (highest priority for stitch data)
        for (const rec of masterRecords) {
            const dn = String(rec.Design_Number);
            if (!merged[dn]) {
                merged[dn] = {
                    designNumber: dn,
                    company: rec.Company || '',
                    designName: '',
                    customerId: rec.Customer_ID || '',
                    maxStitchCount: 0,
                    maxStitchTier: 'Standard',
                    maxAsSurcharge: 0,
                    variantCount: 0,
                    dstFilenames: [],
                    hasImage: false,
                    artworkUrl: null,
                    placement: '',
                    sources: []
                };
            }
            const entry = merged[dn];
            if (!entry.sources.includes('master')) entry.sources.push('master');

            const stitchCount = parseInt(rec.Stitch_Count, 10) || 0;
            entry.variantCount++;
            entry.dstFilenames.push(rec.DST_Filename || '');
            if (stitchCount > entry.maxStitchCount) {
                entry.maxStitchCount = stitchCount;
                entry.maxStitchTier = rec.Stitch_Tier || 'Standard';
                entry.maxAsSurcharge = parseFloat(rec.AS_Surcharge) || 0;
            }
        }

        // 2. ShopWorks_Designs (fills design name, colors, order history)
        for (const rec of shopworksRecords) {
            const dn = String(rec.Design_Number || '').trim();
            if (!dn) continue;
            if (!merged[dn]) {
                merged[dn] = {
                    designNumber: dn,
                    company: rec.Company_Name || '',
                    designName: rec.Design_Name || '',
                    customerId: '',
                    maxStitchCount: parseInt(rec.Stitch_Count, 10) || 0,
                    maxStitchTier: rec.Stitch_Tier || '',
                    maxAsSurcharge: 0,
                    variantCount: 1,
                    dstFilenames: [],
                    hasImage: false,
                    artworkUrl: null,
                    placement: '',
                    sources: []
                };
            }
            const entry = merged[dn];
            if (!entry.sources.includes('shopworks')) entry.sources.push('shopworks');
            if (!entry.company && rec.Company_Name) entry.company = rec.Company_Name;
            if (!entry.designName && rec.Design_Name) entry.designName = rec.Design_Name;
            if (rec.Thread_Colors) entry.threadColors = rec.Thread_Colors;
            if (rec.Last_Order_Date) entry.lastOrderDate = rec.Last_Order_Date;
            if (rec.Order_Count) entry.orderCount = parseInt(rec.Order_Count, 10) || 0;
        }

        // 3. Thumbnail table (adds hasImage + designName)
        for (const rec of thumbnailRecords) {
            const dn = String(rec.Thumb_DesLocid_Design || '').replace(/\.\d+$/, '').trim();
            if (!dn) continue;
            if (!merged[dn]) {
                merged[dn] = {
                    designNumber: dn,
                    company: '',
                    designName: (rec.Thumb_DesLoc_DesDesignName || '').trim(),
                    customerId: '',
                    maxStitchCount: 0,
                    maxStitchTier: '',
                    maxAsSurcharge: 0,
                    variantCount: 0,
                    dstFilenames: [],
                    hasImage: false,
                    artworkUrl: null,
                    placement: '',
                    sources: []
                };
            }
            const entry = merged[dn];
            if (!entry.sources.includes('thumbnail')) entry.sources.push('thumbnail');
            if (!entry.designName && rec.Thumb_DesLoc_DesDesignName) {
                entry.designName = rec.Thumb_DesLoc_DesDesignName.trim();
            }
            // Build image URL from ExternalKey or FileUrl
            const imageUrl = rec.ExternalKey
                ? `https://caspio-pricing-proxy-ab30a049961a.herokuapp.com/api/files/${rec.ExternalKey}`
                : (rec.FileUrl || null);
            if (imageUrl) {
                entry.hasImage = true;
                if (!entry.thumbnailUrl) entry.thumbnailUrl = imageUrl;
            }
        }

        // 4. ArtRequests (adds artwork CDN URL, placement, notes)
        for (const rec of artRecords) {
            // Use Design_Num_SW if available, fall back to ID_Design
            const dn = String(rec.Design_Num_SW || '').trim() || String(rec.ID_Design || '').trim();
            if (!dn) continue;
            if (!merged[dn]) {
                merged[dn] = {
                    designNumber: dn,
                    company: rec.CompanyName || '',
                    designName: '',
                    customerId: rec.Shopwork_customer_number ? String(rec.Shopwork_customer_number) : '',
                    maxStitchCount: 0,
                    maxStitchTier: '',
                    maxAsSurcharge: 0,
                    variantCount: 0,
                    dstFilenames: [],
                    hasImage: false,
                    artworkUrl: null,
                    placement: '',
                    sources: []
                };
            }
            const entry = merged[dn];
            if (!entry.sources.includes('artrequests')) entry.sources.push('artrequests');
            if (!entry.company && rec.CompanyName) entry.company = rec.CompanyName;
            if (!entry.customerId && rec.Shopwork_customer_number) {
                entry.customerId = String(rec.Shopwork_customer_number);
            }
            // Use most recent CDN link (ArtRequests sorted by Date_Created DESC)
            if (!entry.artworkUrl && rec.CDN_Link && rec.CDN_Link.length > 30) {
                entry.artworkUrl = rec.CDN_Link;
            }
            if (!entry.placement && rec.Garment_Placement) {
                entry.placement = rec.Garment_Placement;
            }
        }

        // Sort by design number (numeric) and limit
        const results = Object.values(merged)
            .sort((a, b) => parseInt(a.designNumber) - parseInt(b.designNumber))
            .slice(0, resultLimit);

        const response = {
            success: true,
            query: searchTerm,
            searchType: isNumeric ? 'design_number' : 'company',
            results,
            count: results.length,
            totalMatches: Object.keys(merged).length,
            tablesQueried: {
                master: r1.status === 'fulfilled' ? masterRecords.length : 'failed',
                shopworks: r2.status === 'fulfilled' ? shopworksRecords.length : 'failed',
                thumbnails: r3.status === 'fulfilled' ? thumbnailRecords.length : 'failed',
                artRequests: r4.status === 'fulfilled' ? artRecords.length : 'failed'
            }
        };

        designsCache.set(cacheKey, { data: response, timestamp: Date.now() });
        res.json(response);
    } catch (error) {
        console.error(`[Search-All] Failed for "${searchTerm}":`, error.message);
        res.status(500).json({
            success: false,
            error: 'Search failed',
            details: error.message
        });
    }
});


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
    if (['cache', 'lookup', 'design', 'seed', 'fallback'].includes(id)) return;

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
