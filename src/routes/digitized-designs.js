// Digitized Designs API — Unified Table Version
// Queries single Design_Lookup_2026 table (pre-merged from 4 source tables via sync script)
//
// Endpoints:
//   GET /lookup?designs=29988,39112       — Batch lookup by design numbers (import flow)
//   GET /fallback?designs=...             — Same table, fallback response shape
//   GET /search-all?q=<term>&limit=20     — Fuzzy search by company/design name
//   GET /by-customer?customerId=12025     — Customer design gallery
//   GET /cache/clear                      — Clear in-memory cache

const express = require('express');
const axios = require('axios');
const router = express.Router();
const config = require('../../config');
const { getCaspioAccessToken, fetchAllCaspioPages } = require('../utils/caspio');

// ============================================
// Configuration
// ============================================

const UNIFIED_TABLE = 'Design_Lookup_2026';
const RESOURCE_PATH = `/tables/${UNIFIED_TABLE}/records`;

// All fields in the unified table
const ALL_FIELDS = [
    'ID_Unique', 'Design_Number', 'Design_Name', 'Company', 'Customer_ID',
    'Stitch_Count', 'Stitch_Tier', 'AS_Surcharge', 'DST_Filename',
    'Color_Changes', 'Extra_Colors', 'Extra_Color_Surcharge',
    'FB_Price_1_7', 'FB_Price_8_23', 'FB_Price_24_47', 'FB_Price_48_71', 'FB_Price_72plus',
    'Thumbnail_URL', 'DST_Preview_URL', 'Artwork_URL', 'Mockup_URL', 'Placement', 'Thread_Colors',
    'Last_Order_Date', 'Order_Count', 'Art_Notes', 'Sales_Rep', 'Customer_Type',
    'Is_Active', 'Date_Updated'
].join(',');

// Cache (15 min TTL)
const designsCache = new Map();
const CACHE_TTL = 15 * 60 * 1000;

// Active-only filter for all queries
const ACTIVE_FILTER = "Is_Active='true'";


// ============================================
// Shared Helpers
// ============================================

/**
 * Sanitize a design number — digits only
 */
function sanitizeDesignNumber(input) {
    if (!input || typeof input !== 'string') return null;
    const sanitized = input.replace(/[^\d]/g, '').trim();
    return (sanitized.length > 0 && sanitized.length <= 10) ? sanitized : null;
}

/**
 * Group raw unified records by Design_Number, compute max stitch info.
 * Returns the /lookup response shape: { designs: { "29988": {...} }, notFound: [] }
 */
function groupByDesignNumber(records, requestedNumbers) {
    const grouped = {};

    for (const rec of records) {
        const dn = String(rec.Design_Number);
        if (!grouped[dn]) {
            grouped[dn] = {
                designNumber: dn,
                company: rec.Company || '',
                designName: rec.Design_Name || '',
                customerId: rec.Customer_ID != null ? String(rec.Customer_ID) : '',
                salesRep: rec.Sales_Rep || '',
                customerType: rec.Customer_Type || '',
                variants: [],
                maxStitchCount: 0,
                maxStitchTier: 'Standard',
                maxAsSurcharge: 0,
                hasFBPricing: false,
                thumbnailUrl: '',
                dstPreviewUrl: '',
                artworkUrl: '',
                mockupUrl: '',
                threadColors: '',
                placement: '',
                lastOrderDate: null,
                orderCount: 0,
                artNotes: ''
            };
        }

        const stitchCount = parseInt(rec.Stitch_Count, 10) || 0;
        const asSurcharge = parseFloat(rec.AS_Surcharge) || 0;

        grouped[dn].variants.push({
            idUnique: rec.ID_Unique,
            dstFilename: rec.DST_Filename || '',
            designDescription: rec.Design_Name || '',
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

        if (stitchCount > grouped[dn].maxStitchCount) {
            grouped[dn].maxStitchCount = stitchCount;
            grouped[dn].maxStitchTier = rec.Stitch_Tier || 'Standard';
            grouped[dn].maxAsSurcharge = asSurcharge;
        }

        const fbPrice = parseFloat(rec.FB_Price_1_7) || 0;
        if (fbPrice > 0) {
            grouped[dn].hasFBPricing = true;
        }

        // Pick best metadata from variants (first non-empty wins)
        const g = grouped[dn];
        if (rec.Thumbnail_URL && !g.thumbnailUrl) g.thumbnailUrl = rec.Thumbnail_URL;
        if (rec.DST_Preview_URL && !g.dstPreviewUrl) g.dstPreviewUrl = rec.DST_Preview_URL;
        if (rec.Artwork_URL && rec.Artwork_URL.length > 10 && !g.artworkUrl) g.artworkUrl = rec.Artwork_URL;
        if (rec.Mockup_URL && rec.Mockup_URL.length > 10 && !g.mockupUrl) g.mockupUrl = rec.Mockup_URL;
        if (rec.Thread_Colors && !g.threadColors) g.threadColors = rec.Thread_Colors;
        if (rec.Placement && !g.placement) g.placement = rec.Placement;
        if (rec.Last_Order_Date && !g.lastOrderDate) g.lastOrderDate = rec.Last_Order_Date;
        const recOrderCount = parseInt(rec.Order_Count, 10) || 0;
        if (recOrderCount > g.orderCount) g.orderCount = recOrderCount;
        if (rec.Art_Notes && !g.artNotes) g.artNotes = rec.Art_Notes;
    }

    const foundNumbers = new Set(Object.keys(grouped));
    const notFound = requestedNumbers.filter(n => !foundNumbers.has(n));

    return { designs: grouped, notFound };
}

/**
 * Map unified records to the search-all/by-customer result shape.
 * Groups variant rows by design number, picks best image, computes maxes.
 */
function groupToSearchResults(records) {
    const grouped = {};

    for (const rec of records) {
        const dn = String(rec.Design_Number);
        if (!grouped[dn]) {
            grouped[dn] = {
                designNumber: dn,
                company: rec.Company || '',
                designName: rec.Design_Name || '',
                customerId: rec.Customer_ID != null ? String(rec.Customer_ID) : '',
                salesRep: rec.Sales_Rep || '',
                customerType: rec.Customer_Type || '',
                maxStitchCount: 0,
                maxStitchTier: 'Standard',
                maxAsSurcharge: 0,
                variantCount: 0,
                dstFilenames: [],
                hasImage: false,
                artworkUrl: null,
                thumbnailUrl: null,
                dstPreviewUrl: null,
                mockupUrl: null,
                placement: '',
                sources: ['unified'],
                threadColors: '',
                lastOrderDate: null,
                orderCount: 0,
                artNotes: ''
            };
        }

        const entry = grouped[dn];
        const stitchCount = parseInt(rec.Stitch_Count, 10) || 0;
        entry.variantCount++;
        if (rec.DST_Filename) entry.dstFilenames.push(rec.DST_Filename);

        if (stitchCount > entry.maxStitchCount) {
            entry.maxStitchCount = stitchCount;
            entry.maxStitchTier = rec.Stitch_Tier || 'Standard';
            entry.maxAsSurcharge = parseFloat(rec.AS_Surcharge) || 0;
        }

        // Best image wins
        if (rec.Artwork_URL && rec.Artwork_URL.length > 10 && !entry.artworkUrl) {
            entry.artworkUrl = rec.Artwork_URL;
            entry.hasImage = true;
        }
        if (rec.Thumbnail_URL && rec.Thumbnail_URL.length > 10 && !entry.thumbnailUrl) {
            entry.thumbnailUrl = rec.Thumbnail_URL;
            entry.hasImage = true;
        }
        if (rec.DST_Preview_URL && rec.DST_Preview_URL.length > 10 && !entry.dstPreviewUrl) {
            entry.dstPreviewUrl = rec.DST_Preview_URL;
            entry.hasImage = true;
        }
        if (rec.Mockup_URL && rec.Mockup_URL.length > 10 && !entry.mockupUrl) {
            entry.mockupUrl = rec.Mockup_URL;
            entry.hasImage = true;
        }

        // First non-empty values win
        if (!entry.placement && rec.Placement) entry.placement = rec.Placement;
        if (!entry.threadColors && rec.Thread_Colors) entry.threadColors = rec.Thread_Colors;
        if (!entry.lastOrderDate && rec.Last_Order_Date) entry.lastOrderDate = rec.Last_Order_Date;
        if (rec.Order_Count && parseInt(rec.Order_Count, 10) > entry.orderCount) {
            entry.orderCount = parseInt(rec.Order_Count, 10);
        }

        if (!entry.artNotes && rec.Art_Notes) entry.artNotes = rec.Art_Notes;

        // Build sources list based on available data
        if (stitchCount > 0 && !entry.sources.includes('master')) entry.sources.push('master');
        if (entry.artworkUrl && !entry.sources.includes('artrequests')) entry.sources.push('artrequests');
    }

    return grouped;
}


// ============================================
// Fuzzy Search Utilities
// ============================================

/**
 * Levenshtein distance (case-insensitive)
 */
function levenshtein(a, b) {
    a = a.toLowerCase();
    b = b.toLowerCase();
    if (a === b) return 0;
    if (!a.length) return b.length;
    if (!b.length) return a.length;
    const matrix = [];
    for (let i = 0; i <= b.length; i++) matrix[i] = [i];
    for (let j = 0; j <= a.length; j++) matrix[0][j] = j;
    for (let i = 1; i <= b.length; i++) {
        for (let j = 1; j <= a.length; j++) {
            if (b[i - 1] === a[j - 1]) {
                matrix[i][j] = matrix[i - 1][j - 1];
            } else {
                matrix[i][j] = Math.min(
                    matrix[i - 1][j - 1] + 1,
                    matrix[i][j - 1] + 1,
                    matrix[i - 1][j] + 1
                );
            }
        }
    }
    return matrix[b.length][a.length];
}

/**
 * Fuzzy relevance score (0–100). Higher = better match.
 */
function fuzzyScore(searchTerm, company, designName) {
    const term = searchTerm.toLowerCase();
    const comp = (company || '').toLowerCase();
    const name = (designName || '').toLowerCase();

    // Exact substring in company → high score
    if (comp.includes(term)) {
        const ratio = term.length / Math.max(comp.length, 1);
        return Math.round(80 + ratio * 20);
    }
    // Exact substring in design name
    if (name.includes(term)) {
        const ratio = term.length / Math.max(name.length, 1);
        return Math.round(70 + ratio * 20);
    }

    // Word-level matching
    const companyWords = comp.replace(/[''&.,\-/]/g, ' ').split(/\s+/).filter(w => w.length > 1);
    const nameWords = name.replace(/[''&.,\-/]/g, ' ').split(/\s+/).filter(w => w.length > 1);
    const allWords = [...companyWords, ...nameWords];

    // Multi-word search
    const searchWords = term.split(/\s+/).filter(w => w.length >= 2);
    if (searchWords.length > 1) {
        let totalScore = 0;
        for (const sw of searchWords) {
            let bestForThisWord = 0;
            if (comp.includes(sw)) {
                bestForThisWord = 0.9;
            } else if (name.includes(sw)) {
                bestForThisWord = 0.8;
            } else {
                for (const word of allWords) {
                    const dist = levenshtein(sw, word);
                    const maxLen = Math.max(sw.length, word.length);
                    const sim = 1 - dist / maxLen;
                    const prefixBonus = word.startsWith(sw) ? 0.15 : 0;
                    const wordScore = Math.min(1, sim + prefixBonus);
                    if (wordScore > bestForThisWord) bestForThisWord = wordScore;
                }
            }
            totalScore += bestForThisWord;
        }
        const avgScore = totalScore / searchWords.length;
        return Math.round(avgScore * 85);
    }

    // Single-word: best matching word
    let bestWordScore = 0;
    for (const word of allWords) {
        const dist = levenshtein(term, word);
        const maxLen = Math.max(term.length, word.length);
        const similarity = 1 - dist / maxLen;
        const prefixBonus = word.startsWith(term) ? 0.15 : 0;
        const wordScore = Math.min(1, similarity + prefixBonus);
        if (wordScore > bestWordScore) bestWordScore = wordScore;
    }

    // Also check full company name (single-word companies)
    const compDist = levenshtein(term, comp);
    const compSim = 1 - compDist / Math.max(term.length, comp.length, 1);
    if (compSim > bestWordScore) bestWordScore = compSim;

    return Math.round(bestWordScore * 70);
}


// ============================================
// LOOKUP ENDPOINT (primary — used by import)
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

    const rawNumbers = designs.split(',').map(s => s.trim());
    const designNumbers = rawNumbers.map(sanitizeDesignNumber).filter(Boolean);

    if (designNumbers.length === 0) {
        return res.status(400).json({ success: false, error: 'No valid design numbers provided.' });
    }

    if (designNumbers.length > 20) {
        return res.status(400).json({ success: false, error: 'Maximum 20 design numbers per lookup.' });
    }

    try {
        const cacheKey = `lookup:${designNumbers.sort().join(',')}`;
        const cached = designsCache.get(cacheKey);
        if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
            return res.json(cached.data);
        }

        console.log(`[Designs] Lookup: ${designNumbers.join(', ')}`);

        const inList = designNumbers.map(n => `'${n}'`).join(',');
        const records = await fetchAllCaspioPages(RESOURCE_PATH, {
            'q.where': `Design_Number IN (${inList}) AND ${ACTIVE_FILTER}`,
            'q.select': ALL_FIELDS
        });

        console.log(`[Designs] Lookup found ${records.length} records for ${designNumbers.length} design numbers`);

        const result = groupByDesignNumber(records, designNumbers);
        const response = {
            success: true,
            ...result,
            count: Object.keys(result.designs).length,
            totalVariants: records.length
        };

        designsCache.set(cacheKey, { data: response, timestamp: Date.now() });
        res.json(response);
    } catch (error) {
        console.error('[Designs] Lookup failed:', error.message);
        res.status(500).json({ success: false, error: 'Failed to look up designs', details: error.message });
    }
});


// ============================================
// FALLBACK ENDPOINT (same table, different response shape)
// ============================================

/**
 * GET /api/digitized-designs/fallback?designs=435,1363,5373
 * Returns designs in the fallback response shape (companyName, designName fields).
 * Now queries the same unified table — no separate ShopWorks_Designs lookup needed.
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
        return res.status(400).json({ success: false, error: 'No valid design numbers provided.' });
    }

    if (designNumbers.length > 20) {
        return res.status(400).json({ success: false, error: 'Maximum 20 design numbers per fallback.' });
    }

    try {
        const cacheKey = `fallback:${designNumbers.sort().join(',')}`;
        const cached = designsCache.get(cacheKey);
        if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
            return res.json(cached.data);
        }

        console.log(`[Designs] Fallback lookup: ${designNumbers.join(', ')}`);

        const inList = designNumbers.map(n => `'${n}'`).join(',');
        const records = await fetchAllCaspioPages(RESOURCE_PATH, {
            'q.where': `Design_Number IN (${inList}) AND ${ACTIVE_FILTER}`,
            'q.select': ALL_FIELDS
        });

        // Build fallback response shape — one entry per design number (not per variant)
        // Frontend expects: companyName, designName (NOT company, designDescription)
        const foundDesigns = {};
        for (const rec of records) {
            const dn = String(rec.Design_Number);
            const stitchCount = parseInt(rec.Stitch_Count, 10) || 0;

            if (!foundDesigns[dn]) {
                foundDesigns[dn] = {
                    designNumber: dn,
                    designName: rec.Design_Name || '',
                    companyName: rec.Company || '',
                    designCode: '',
                    threadColors: rec.Thread_Colors || '',
                    colorCount: parseInt(rec.Color_Changes, 10) || 0,
                    lastOrderDate: rec.Last_Order_Date || '',
                    orderCount: parseInt(rec.Order_Count, 10) || 0,
                    designTypeId: 0,
                    stitchCount,
                    stitchTier: rec.Stitch_Tier || '',
                    asSurcharge: parseFloat(rec.AS_Surcharge) || 0,
                    hasStitchData: stitchCount > 0,
                    maxStitchCount: stitchCount
                };
            } else if (stitchCount > foundDesigns[dn].maxStitchCount) {
                // Track max stitch across variants
                foundDesigns[dn].maxStitchCount = stitchCount;
                foundDesigns[dn].stitchCount = stitchCount;
                foundDesigns[dn].stitchTier = rec.Stitch_Tier || '';
                foundDesigns[dn].asSurcharge = parseFloat(rec.AS_Surcharge) || 0;
            }
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
        console.error('[Designs] Fallback lookup failed:', error.message);
        res.status(500).json({ success: false, error: 'Fallback lookup failed', details: error.message });
    }
});


// ============================================
// SEARCH-ALL ENDPOINT (fuzzy search)
// ============================================

/**
 * GET /api/digitized-designs/search-all?q=<term>&limit=20&customerId=<id>
 * Fuzzy search across Design_Lookup_2026 by company name or design number.
 * Optional customerId: prioritize customer's designs in results.
 */
router.get('/digitized-designs/search-all', async (req, res) => {
    const { q, limit: limitParam, customerId: customerIdParam } = req.query;

    if (!q || typeof q !== 'string' || q.trim().length < 2) {
        return res.status(400).json({ success: false, error: 'Search query must be at least 2 characters' });
    }

    const searchTerm = q.trim();
    const resultLimit = Math.min(Math.max(parseInt(limitParam, 10) || 20, 1), 200);
    const isNumeric = /^\d+$/.test(searchTerm);
    const escaped = searchTerm.replace(/'/g, "''");
    const customerId = (customerIdParam && typeof customerIdParam === 'string') ? customerIdParam.trim().replace(/'/g, "''") : '';

    try {
        const cacheKey = `search-all:${searchTerm.toLowerCase()}:${resultLimit}:${customerId}`;
        const cached = designsCache.get(cacheKey);
        if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
            return res.json(cached.data);
        }

        console.log(`[Designs] Search-all: "${searchTerm}" (${isNumeric ? 'numeric' : 'text'})`);

        // Build WHERE clause
        const searchWords = escaped.split(/\s+/).filter(w => w.length >= 2);
        const useFuzzy = !isNumeric && escaped.length >= 5;
        let whereClause;

        if (isNumeric) {
            const sanitized = sanitizeDesignNumber(searchTerm);
            if (!sanitized) return res.status(400).json({ success: false, error: 'Invalid design number' });
            whereClause = `(Design_Number='${sanitized}' OR Design_Number LIKE '${sanitized}%')`;
        } else if (useFuzzy) {
            // Fuzzy: multi-word AND + prefix broadening
            const isMultiWord = searchWords.length > 1;

            function buildFuzzyWhere(field) {
                if (isMultiWord) {
                    const exactParts = searchWords.map(w => `${field} LIKE '%${w}%'`);
                    const fuzzyParts = searchWords.map(w => {
                        const pfx = w.substring(0, Math.min(4, w.length));
                        return `${field} LIKE '%${pfx}%'`;
                    });
                    return `(${exactParts.join(' AND ')}) OR (${fuzzyParts.join(' AND ')})`;
                } else {
                    const prefix = escaped.substring(0, 4);
                    return `${field} LIKE '%${escaped}%' OR ${field} LIKE '%${prefix}%'`;
                }
            }

            whereClause = `(${buildFuzzyWhere('Company')}) OR (${buildFuzzyWhere('Design_Name')})`;
        } else {
            // Short terms: exact substring
            whereClause = `Company LIKE '%${escaped}%' OR Design_Name LIKE '%${escaped}%'`;
        }

        // Broaden for customer scope
        if (customerId && !isNumeric) {
            whereClause = `(${whereClause}) OR (Customer_ID='${customerId}')`;
        }

        // Add active filter
        whereClause = `(${whereClause}) AND ${ACTIVE_FILTER}`;

        const records = await fetchAllCaspioPages(RESOURCE_PATH, {
            'q.where': whereClause,
            'q.select': ALL_FIELDS,
            'q.limit': '500'
        });

        console.log(`[Designs] Search-all found ${records.length} raw records`);

        // Group by design number
        const merged = groupToSearchResults(records);

        // Tag customer matches
        const allResults = Object.values(merged);
        if (customerId) {
            for (const entry of allResults) {
                entry.customerMatch = (String(entry.customerId) === String(customerId));
            }
        }

        // Score and sort
        let results;
        if (!isNumeric) {
            for (const entry of allResults) {
                entry.relevanceScore = fuzzyScore(searchTerm, entry.company, entry.designName);
            }
            allResults.sort((a, b) => {
                if (customerId) {
                    if (a.customerMatch && !b.customerMatch) return -1;
                    if (!a.customerMatch && b.customerMatch) return 1;
                }
                const scoreDiff = (b.relevanceScore || 0) - (a.relevanceScore || 0);
                if (scoreDiff !== 0) return scoreDiff;
                return parseInt(a.designNumber) - parseInt(b.designNumber);
            });
            const MIN_FUZZY_SCORE = useFuzzy ? 45 : 0;
            results = allResults.filter(r => r.customerMatch || (r.relevanceScore || 0) >= MIN_FUZZY_SCORE).slice(0, resultLimit);
        } else {
            allResults.sort((a, b) => parseInt(a.designNumber) - parseInt(b.designNumber));
            results = allResults.slice(0, resultLimit);
        }

        const response = {
            success: true,
            query: searchTerm,
            searchType: isNumeric ? 'design_number' : 'company',
            fuzzyEnabled: useFuzzy || false,
            customerScoped: !!customerId,
            results,
            count: results.length,
            totalMatches: allResults.length,
            tablesQueried: { unified: records.length }
        };

        designsCache.set(cacheKey, { data: response, timestamp: Date.now() });
        res.json(response);
    } catch (error) {
        console.error(`[Designs] Search-all failed for "${searchTerm}":`, error.message);
        res.status(500).json({ success: false, error: 'Search failed', details: error.message });
    }
});


// ============================================
// BY-CUSTOMER ENDPOINT (gallery view)
// ============================================

/**
 * GET /api/digitized-designs/by-customer?customerId=12025
 * Fetches ALL designs belonging to a specific customer. Used for gallery view.
 */
router.get('/digitized-designs/by-customer', async (req, res) => {
    const { customerId: rawId } = req.query;

    if (!rawId || typeof rawId !== 'string' || !/^\d+$/.test(rawId.trim())) {
        return res.status(400).json({ success: false, error: 'customerId must be a numeric string' });
    }

    const customerId = rawId.trim();

    try {
        const cacheKey = `customer:${customerId}`;
        const cached = designsCache.get(cacheKey);
        if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
            return res.json(cached.data);
        }

        console.log(`[Designs] By-customer: customerId=${customerId}`);

        const records = await fetchAllCaspioPages(RESOURCE_PATH, {
            'q.where': `Customer_ID='${customerId}' AND ${ACTIVE_FILTER}`,
            'q.select': ALL_FIELDS,
            'q.limit': '500'
        });

        console.log(`[Designs] By-customer found ${records.length} records for customer ${customerId}`);

        // Group and convert to search result shape
        const merged = groupToSearchResults(records);
        const allResults = Object.values(merged);

        // Tag all as customer matches, sort by design number
        for (const entry of allResults) {
            entry.customerMatch = true;
        }
        allResults.sort((a, b) => parseInt(a.designNumber) - parseInt(b.designNumber));

        const response = {
            success: true,
            customerId,
            results: allResults,
            count: allResults.length,
            tablesQueried: { unified: records.length }
        };

        designsCache.set(cacheKey, { data: response, timestamp: Date.now() });
        res.json(response);
    } catch (error) {
        console.error(`[Designs] By-customer failed for customerId=${customerId}:`, error.message);
        res.status(500).json({ success: false, error: 'Failed to fetch customer designs', details: error.message });
    }
});


// ============================================
// CACHE MANAGEMENT
// ============================================

router.get('/digitized-designs/cache/clear', (req, res) => {
    designsCache.clear();
    console.log('[Designs] Cache cleared');
    res.json({ success: true, message: 'Design lookup cache cleared' });
});


// ============================================
// POST /digitized-designs/sync-rep
// Update Sales_Rep in Design_Lookup_2026 for a given Customer_ID.
// Called by MCP server after account move operations (move_account, move_to_house, move_from_house).
// ============================================

router.post('/digitized-designs/sync-rep', express.json(), async (req, res) => {
    const { customerId, salesRep } = req.body;

    if (!customerId || isNaN(Number(customerId)) || Number(customerId) <= 0) {
        return res.status(400).json({ success: false, error: 'customerId must be a positive integer' });
    }

    const newRep = (salesRep != null) ? String(salesRep).trim() : '';

    try {
        const token = await getCaspioAccessToken();
        const url = `${config.caspio.apiBaseUrl}/tables/${UNIFIED_TABLE}/records?q.where=Customer_ID=${Number(customerId)}`;

        const result = await axios({
            method: 'put',
            url,
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json'
            },
            data: { Sales_Rep: newRep },
            timeout: 15000
        });

        const recordsAffected = result.data?.RecordsAffected || 0;
        console.log(`[Designs] Synced Sales_Rep="${newRep}" for Customer_ID=${customerId} (${recordsAffected} records)`);

        res.json({ success: true, recordsAffected });
    } catch (error) {
        console.error('[Designs] sync-rep error:', error.response?.data || error.message);
        res.status(500).json({ success: false, error: 'Failed to sync Sales_Rep in Design_Lookup_2026' });
    }
});


module.exports = router;
