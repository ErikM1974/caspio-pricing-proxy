// Service Codes API
// Returns embroidery service codes, pricing tiers, and fee structures
// Used by quote builders for ShopWorks import and pricing calculations
//
// Data fetched from Caspio Service_Codes table

const express = require('express');
const router = express.Router();
const { fetchAllCaspioPages } = require('../utils/caspio');

// Cache (5 min TTL - service codes don't change frequently)
const serviceCodesCache = new Map();
const CACHE_TTL = 5 * 60 * 1000;

// Service code aliases for typo handling (kept in code per Erik's decision)
const SERVICE_CODE_ALIASES = {
    'AONOGRAM': 'Monogram',
    'NNAME': 'Name',
    'NNAMES': 'Name',
    'NAMES': 'Name',
    'EJB': 'FB',           // Embroidered Jacket Back → Full Back
    'FLAG': 'AL',          // Legacy code
    'SETUP': 'GRT-50',
    'SETUP FEE': 'GRT-50',
    'DESIGN PREP': 'GRT-75',
    'EXCESS STITCH': 'ART'
};

/**
 * Fetch all service codes from Caspio with caching
 * @param {boolean} forceRefresh - Bypass cache if true
 * @returns {Promise<Array>} Array of service code records
 */
async function fetchServiceCodes(forceRefresh = false) {
    const cacheKey = 'all-service-codes';
    const cached = serviceCodesCache.get(cacheKey);

    if (!forceRefresh && cached && Date.now() - cached.timestamp < CACHE_TTL) {
        console.log('[CACHE HIT] service-codes');
        return cached.data;
    }

    console.log('[CACHE MISS] service-codes - fetching from Caspio');

    try {
        const records = await fetchAllCaspioPages('/tables/Service_Codes/records', {});

        // Cache the results
        serviceCodesCache.set(cacheKey, {
            data: records,
            timestamp: Date.now()
        });

        console.log(`[Service Codes] Fetched ${records.length} records from Caspio`);
        return records;
    } catch (error) {
        console.error('[Service Codes] Error fetching from Caspio:', error.message);

        // Return cached data if available (even if stale)
        if (cached) {
            console.log('[Service Codes] Using stale cache due to error');
            return cached.data;
        }

        throw error;
    }
}

/**
 * Resolve a service code alias to the canonical code
 * @param {string} code - Input service code (may be alias or typo)
 * @returns {string} Canonical service code
 */
function resolveAlias(code) {
    if (!code) return code;
    const upper = code.toUpperCase().trim();
    return SERVICE_CODE_ALIASES[upper] || code;
}

/**
 * Get price for a tiered service based on quantity
 * @param {Array} serviceCodes - All service codes from Caspio
 * @param {string} serviceCode - Service code (AL, FB, CB, DECG, DECC)
 * @param {number} quantity - Quantity to price
 * @returns {Object|null} Matching tier data or null
 */
function getTierForQuantity(serviceCodes, serviceCode, quantity) {
    const code = resolveAlias(serviceCode);
    const tiers = serviceCodes.filter(sc =>
        sc.ServiceCode &&
        sc.ServiceCode.toUpperCase() === code.toUpperCase() &&
        sc.PricingMethod === 'TIERED' &&
        sc.IsActive !== false
    );

    if (tiers.length === 0) return null;

    // Parse tier ranges and find matching tier
    for (const tier of tiers) {
        const label = tier.TierLabel;
        if (!label) continue;

        if (label.endsWith('+')) {
            // e.g., "72+" or "144+"
            const min = parseInt(label.replace('+', ''));
            if (quantity >= min) return tier;
        } else if (label.includes('-')) {
            // e.g., "1-23" or "24-47"
            const [min, max] = label.split('-').map(n => parseInt(n));
            if (quantity >= min && quantity <= max) return tier;
        }
    }

    // Fallback to highest tier if quantity exceeds all
    return tiers[tiers.length - 1];
}

// GET /api/service-codes
// Returns all service codes or filtered by query params
// Query params:
//   - code: Filter by specific ServiceCode
//   - type: Filter by ServiceType (DIGITIZING, EMBROIDERY, DECORATION, FEE, RUSH)
//   - category: Filter by Category
//   - position: Filter by Position (LC, FB, CB, CAP, etc.)
//   - active: Filter by IsActive (default: true)
//   - quantity: If provided with code, returns the appropriate tier
//   - refresh: Set to "true" to bypass cache
router.get('/service-codes', async (req, res) => {
    const { code, type, category, position, active = 'true', quantity, refresh } = req.query;
    const forceRefresh = refresh === 'true';

    try {
        let results = await fetchServiceCodes(forceRefresh);

        // Filter by active status
        if (active === 'true') {
            results = results.filter(sc => sc.IsActive !== false);
        } else if (active === 'false') {
            results = results.filter(sc => sc.IsActive === false);
        }

        // Filter by service code (with alias resolution)
        if (code) {
            const resolvedCode = resolveAlias(code);
            results = results.filter(sc =>
                sc.ServiceCode && sc.ServiceCode.toUpperCase() === resolvedCode.toUpperCase()
            );
        }

        // Filter by type
        if (type) {
            results = results.filter(sc =>
                sc.ServiceType && sc.ServiceType.toUpperCase() === type.toUpperCase()
            );
        }

        // Filter by category
        if (category) {
            results = results.filter(sc =>
                sc.Category && sc.Category.toLowerCase().includes(category.toLowerCase())
            );
        }

        // Filter by position
        if (position) {
            results = results.filter(sc =>
                sc.Position && sc.Position.toUpperCase() === position.toUpperCase()
            );
        }

        // If quantity provided with code, return specific tier
        if (code && quantity) {
            const qty = parseInt(quantity);
            if (!isNaN(qty)) {
                const allCodes = await fetchServiceCodes(forceRefresh);
                const tier = getTierForQuantity(allCodes, code, qty);
                if (tier) {
                    return res.json({
                        success: true,
                        data: [tier],
                        count: 1,
                        tier: tier.TierLabel,
                        quantity: qty,
                        source: 'caspio'
                    });
                }
            }
        }

        res.json({
            success: true,
            data: results,
            count: results.length,
            source: 'caspio'
        });
    } catch (error) {
        console.error('Error in /api/service-codes:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to fetch service codes',
            details: error.message
        });
    }
});

// GET /api/service-codes/aliases
// Returns the alias mapping table for typo correction
router.get('/service-codes/aliases', (req, res) => {
    res.json({
        success: true,
        data: SERVICE_CODE_ALIASES
    });
});

// GET /api/service-codes/tier/:code/:quantity
// Convenience endpoint to get pricing for a specific code/quantity combo
router.get('/service-codes/tier/:code/:quantity', async (req, res) => {
    const { code, quantity } = req.params;
    const qty = parseInt(quantity);

    if (isNaN(qty) || qty < 1) {
        return res.status(400).json({
            success: false,
            error: 'Invalid quantity. Must be a positive integer.'
        });
    }

    try {
        const allCodes = await fetchServiceCodes();
        const tier = getTierForQuantity(allCodes, code, qty);

        if (!tier) {
            return res.status(404).json({
                success: false,
                error: `No pricing tier found for code '${code}' at quantity ${qty}`
            });
        }

        res.json({
            success: true,
            data: tier,
            resolvedCode: resolveAlias(code),
            quantity: qty,
            tierLabel: tier.TierLabel,
            sellPrice: tier.SellPrice,
            unitCost: tier.UnitCost,
            source: 'caspio'
        });
    } catch (error) {
        console.error('Error in /api/service-codes/tier:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to fetch tier pricing',
            details: error.message
        });
    }
});

// GET /api/service-codes/cache/clear
// Clears the service codes cache (for admin use)
router.get('/service-codes/cache/clear', (req, res) => {
    serviceCodesCache.clear();
    console.log('[Service Codes] Cache cleared');
    res.json({
        success: true,
        message: 'Service codes cache cleared'
    });
});

module.exports = router;
