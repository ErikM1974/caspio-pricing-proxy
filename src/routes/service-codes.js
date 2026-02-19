// Service Codes API
// Returns embroidery service codes, pricing tiers, and fee structures
// Used by quote builders for ShopWorks import and pricing calculations
//
// Data fetched from Caspio Service_Codes table

const express = require('express');
const router = express.Router();
const { fetchAllCaspioPages, makeCaspioRequest } = require('../utils/caspio');

// Cache (5 min TTL - service codes don't change frequently)
const serviceCodesCache = new Map();
const CACHE_TTL = 5 * 60 * 1000;

// Service code aliases for typo handling (kept in code per Erik's decision)
// Must stay in sync with shared_components/js/shopworks-import-parser.js
const SERVICE_CODE_ALIASES = {
    'AONOGRAM': 'Monogram',
    'NNAME': 'Name/Number',    // Common typo → Name/Number ($15)
    'NNAMES': 'Name/Number',   // Common typo → Name/Number ($15)
    'NAME': 'Name/Number',     // Legacy NAME → Name/Number ($15)
    'NAMES': 'Monogram',       // Plural "names" = monogramming
    'EJB': 'FB',               // Embroidered Jacket Back → Full Back
    'FLAG': 'AL',              // Legacy code
    'SETUP': 'GRT-50',
    'SETUP FEE': 'DD',         // Maps to digitizing setup
    'DESIGN PREP': 'GRT-75',
    'EXCESS STITCH': 'AS-GARM', // Additional stitches (garment)
    // SECC is cap sewing (NOT DECC) — separate service from customer-supplied caps
    'SEW': 'SEG',              // Alias Sew → SEG (sewing)
    'SEW-ON': 'SEG',           // Alias Sew-on → SEG (sewing)
    'NAME_DROP': 'Monogram',   // Reps manually typing — normalize to Monogram
    'NAME_DROP_BIG': 'Monogram', // Reps manually typing — normalize to Monogram
    'NAME DROP': 'Monogram',   // Space variant
    'NAMEDROP': 'Monogram',    // No separator variant
    'HEAVYWEIGHT-SURCHARGE': 'HW-SURCHG', // Renamed for ShopWorks compat
    'CDP 5x5': 'CDP',         // Consolidated → CDP
    'CDP 5x5-10': 'CDP',      // Consolidated → CDP
    'DGT-001': 'DD',          // Legacy → DD
    'DGT-002': 'DDE',         // Legacy → DDE
    'DGT-003': 'DDT'          // Legacy → DDT
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

// ============================================
// SEED DATA - Initial database population
// ============================================
// NOTE: This is for initial seeding only. All pricing should be managed
// via the database using the CRUD endpoints (POST, PUT, DELETE).
// After seeding, changes should be made in Caspio directly or via API.
// ============================================
const SERVICE_CODES_DATA = [
    // Digitizing (1 record - flat fee, handled manually per order)
    { ServiceCode: 'DD', ServiceType: 'DIGITIZING', DisplayName: 'Digitizing', Category: 'Digitizing', PricingMethod: 'FLAT', TierLabel: '', UnitCost: 0, SellPrice: 0, PerUnit: 'per order', QuoteBuilderField: 'digitizing', Position: '', StitchBase: 0, IsActive: true },

    // Apparel Left Chest (AL) - 4 tiers
    { ServiceCode: 'AL', ServiceType: 'EMBROIDERY', DisplayName: 'Apparel Left Chest 1-23 pcs', Category: 'Apparel Left Chest', PricingMethod: 'TIERED', TierLabel: '1-23', UnitCost: 6.75, SellPrice: 13.50, PerUnit: 'each', QuoteBuilderField: 'leftChest', Position: 'LC', StitchBase: 8000, IsActive: true },
    { ServiceCode: 'AL', ServiceType: 'EMBROIDERY', DisplayName: 'Apparel Left Chest 24-47 pcs', Category: 'Apparel Left Chest', PricingMethod: 'TIERED', TierLabel: '24-47', UnitCost: 6.25, SellPrice: 12.50, PerUnit: 'each', QuoteBuilderField: 'leftChest', Position: 'LC', StitchBase: 8000, IsActive: true },
    { ServiceCode: 'AL', ServiceType: 'EMBROIDERY', DisplayName: 'Apparel Left Chest 48-71 pcs', Category: 'Apparel Left Chest', PricingMethod: 'TIERED', TierLabel: '48-71', UnitCost: 5.25, SellPrice: 10.50, PerUnit: 'each', QuoteBuilderField: 'leftChest', Position: 'LC', StitchBase: 8000, IsActive: true },
    { ServiceCode: 'AL', ServiceType: 'EMBROIDERY', DisplayName: 'Apparel Left Chest 72+ pcs', Category: 'Apparel Left Chest', PricingMethod: 'TIERED', TierLabel: '72+', UnitCost: 4.75, SellPrice: 9.50, PerUnit: 'each', QuoteBuilderField: 'leftChest', Position: 'LC', StitchBase: 8000, IsActive: true },

    // Full Back (FB) - STITCH-BASED pricing (not tiered)
    // ALL stitches charged at $1.25/1K, minimum 25K stitches = $31.25 minimum
    { ServiceCode: 'FB', ServiceType: 'EMBROIDERY', DisplayName: 'Full Back (Stitch-Based)', Category: 'Full Back', PricingMethod: 'STITCH_BASED', TierLabel: 'ALL', UnitCost: 0.625, SellPrice: 1.25, PerUnit: 'per 1000 stitches', QuoteBuilderField: 'fullBack', Position: 'FB', StitchBase: 25000, IsActive: true },

    // Cap Back (CB) - 4 tiers
    { ServiceCode: 'CB', ServiceType: 'EMBROIDERY', DisplayName: 'Cap Back 1-23 pcs', Category: 'Cap Back', PricingMethod: 'TIERED', TierLabel: '1-23', UnitCost: 3.40, SellPrice: 6.75, PerUnit: 'each', QuoteBuilderField: 'capBack', Position: 'CB', StitchBase: 8000, IsActive: true },
    { ServiceCode: 'CB', ServiceType: 'EMBROIDERY', DisplayName: 'Cap Back 24-47 pcs', Category: 'Cap Back', PricingMethod: 'TIERED', TierLabel: '24-47', UnitCost: 2.90, SellPrice: 5.75, PerUnit: 'each', QuoteBuilderField: 'capBack', Position: 'CB', StitchBase: 8000, IsActive: true },
    { ServiceCode: 'CB', ServiceType: 'EMBROIDERY', DisplayName: 'Cap Back 48-71 pcs', Category: 'Cap Back', PricingMethod: 'TIERED', TierLabel: '48-71', UnitCost: 2.75, SellPrice: 5.50, PerUnit: 'each', QuoteBuilderField: 'capBack', Position: 'CB', StitchBase: 8000, IsActive: true },
    { ServiceCode: 'CB', ServiceType: 'EMBROIDERY', DisplayName: 'Cap Back 72+ pcs', Category: 'Cap Back', PricingMethod: 'TIERED', TierLabel: '72+', UnitCost: 2.65, SellPrice: 5.25, PerUnit: 'each', QuoteBuilderField: 'capBack', Position: 'CB', StitchBase: 8000, IsActive: true },

    // Monogram/Name (2)
    { ServiceCode: 'Monogram', ServiceType: 'EMBROIDERY', DisplayName: 'Monogram (3 letters)', Category: 'Special', PricingMethod: 'FLAT', TierLabel: '', UnitCost: 6.25, SellPrice: 12.50, PerUnit: 'each', QuoteBuilderField: 'monogram', Position: 'OTHER', StitchBase: 2000, IsActive: true },
    { ServiceCode: 'Name/Number', ServiceType: 'EMBROIDERY', DisplayName: 'Name & Number', Category: 'Special', PricingMethod: 'FLAT', TierLabel: '', UnitCost: 7.50, SellPrice: 15.00, PerUnit: 'each', QuoteBuilderField: 'nameNumber', Position: 'OTHER', StitchBase: 3500, IsActive: true },

    // DECG (Customer-Supplied Garments) - 7 tiers
    { ServiceCode: 'DECG', ServiceType: 'DECORATION', DisplayName: 'Garment Decoration 1-2 pcs', Category: 'Decoration Garments', PricingMethod: 'TIERED', TierLabel: '1-2', UnitCost: 22.50, SellPrice: 45.00, PerUnit: 'each', QuoteBuilderField: 'decorationGarment', Position: 'FULL', StitchBase: 10000, IsActive: true },
    { ServiceCode: 'DECG', ServiceType: 'DECORATION', DisplayName: 'Garment Decoration 3-5 pcs', Category: 'Decoration Garments', PricingMethod: 'TIERED', TierLabel: '3-5', UnitCost: 20.00, SellPrice: 40.00, PerUnit: 'each', QuoteBuilderField: 'decorationGarment', Position: 'FULL', StitchBase: 10000, IsActive: true },
    { ServiceCode: 'DECG', ServiceType: 'DECORATION', DisplayName: 'Garment Decoration 6-11 pcs', Category: 'Decoration Garments', PricingMethod: 'TIERED', TierLabel: '6-11', UnitCost: 19.00, SellPrice: 38.00, PerUnit: 'each', QuoteBuilderField: 'decorationGarment', Position: 'FULL', StitchBase: 10000, IsActive: true },
    { ServiceCode: 'DECG', ServiceType: 'DECORATION', DisplayName: 'Garment Decoration 12-23 pcs', Category: 'Decoration Garments', PricingMethod: 'TIERED', TierLabel: '12-23', UnitCost: 16.00, SellPrice: 32.00, PerUnit: 'each', QuoteBuilderField: 'decorationGarment', Position: 'FULL', StitchBase: 10000, IsActive: true },
    { ServiceCode: 'DECG', ServiceType: 'DECORATION', DisplayName: 'Garment Decoration 24-71 pcs', Category: 'Decoration Garments', PricingMethod: 'TIERED', TierLabel: '24-71', UnitCost: 15.00, SellPrice: 30.00, PerUnit: 'each', QuoteBuilderField: 'decorationGarment', Position: 'FULL', StitchBase: 10000, IsActive: true },
    { ServiceCode: 'DECG', ServiceType: 'DECORATION', DisplayName: 'Garment Decoration 72-143 pcs', Category: 'Decoration Garments', PricingMethod: 'TIERED', TierLabel: '72-143', UnitCost: 12.50, SellPrice: 25.00, PerUnit: 'each', QuoteBuilderField: 'decorationGarment', Position: 'FULL', StitchBase: 10000, IsActive: true },
    { ServiceCode: 'DECG', ServiceType: 'DECORATION', DisplayName: 'Garment Decoration 144+ pcs', Category: 'Decoration Garments', PricingMethod: 'TIERED', TierLabel: '144+', UnitCost: 7.50, SellPrice: 15.00, PerUnit: 'each', QuoteBuilderField: 'decorationGarment', Position: 'FULL', StitchBase: 10000, IsActive: true },

    // DECC (Customer-Supplied Caps) - 7 tiers
    { ServiceCode: 'DECC', ServiceType: 'DECORATION', DisplayName: 'Cap Decoration 1-2 pcs', Category: 'Decoration Caps', PricingMethod: 'TIERED', TierLabel: '1-2', UnitCost: 18.00, SellPrice: 36.00, PerUnit: 'each', QuoteBuilderField: 'decorationCap', Position: 'CAP', StitchBase: 8000, IsActive: true },
    { ServiceCode: 'DECC', ServiceType: 'DECORATION', DisplayName: 'Cap Decoration 3-5 pcs', Category: 'Decoration Caps', PricingMethod: 'TIERED', TierLabel: '3-5', UnitCost: 16.00, SellPrice: 32.00, PerUnit: 'each', QuoteBuilderField: 'decorationCap', Position: 'CAP', StitchBase: 8000, IsActive: true },
    { ServiceCode: 'DECC', ServiceType: 'DECORATION', DisplayName: 'Cap Decoration 6-11 pcs', Category: 'Decoration Caps', PricingMethod: 'TIERED', TierLabel: '6-11', UnitCost: 15.00, SellPrice: 30.00, PerUnit: 'each', QuoteBuilderField: 'decorationCap', Position: 'CAP', StitchBase: 8000, IsActive: true },
    { ServiceCode: 'DECC', ServiceType: 'DECORATION', DisplayName: 'Cap Decoration 12-23 pcs', Category: 'Decoration Caps', PricingMethod: 'TIERED', TierLabel: '12-23', UnitCost: 12.50, SellPrice: 25.00, PerUnit: 'each', QuoteBuilderField: 'decorationCap', Position: 'CAP', StitchBase: 8000, IsActive: true },
    { ServiceCode: 'DECC', ServiceType: 'DECORATION', DisplayName: 'Cap Decoration 24-71 pcs', Category: 'Decoration Caps', PricingMethod: 'TIERED', TierLabel: '24-71', UnitCost: 12.00, SellPrice: 24.00, PerUnit: 'each', QuoteBuilderField: 'decorationCap', Position: 'CAP', StitchBase: 8000, IsActive: true },
    { ServiceCode: 'DECC', ServiceType: 'DECORATION', DisplayName: 'Cap Decoration 72-143 pcs', Category: 'Decoration Caps', PricingMethod: 'TIERED', TierLabel: '72-143', UnitCost: 10.00, SellPrice: 20.00, PerUnit: 'each', QuoteBuilderField: 'decorationCap', Position: 'CAP', StitchBase: 8000, IsActive: true },
    { ServiceCode: 'DECC', ServiceType: 'DECORATION', DisplayName: 'Cap Decoration 144+ pcs', Category: 'Decoration Caps', PricingMethod: 'TIERED', TierLabel: '144+', UnitCost: 6.00, SellPrice: 12.00, PerUnit: 'each', QuoteBuilderField: 'decorationCap', Position: 'CAP', StitchBase: 8000, IsActive: true },

    // Fees (5)
    { ServiceCode: 'GRT-50', ServiceType: 'FEE', DisplayName: 'Setup Fee (Standard)', Category: 'Fees', PricingMethod: 'FLAT', TierLabel: '', UnitCost: 25.00, SellPrice: 50.00, PerUnit: 'per order', QuoteBuilderField: 'setupFee', Position: '', StitchBase: 0, IsActive: true },
    { ServiceCode: 'GRT-75', ServiceType: 'FEE', DisplayName: 'Design Prep Fee', Category: 'Fees', PricingMethod: 'FLAT', TierLabel: '', UnitCost: 37.50, SellPrice: 75.00, PerUnit: 'per hour', QuoteBuilderField: 'designPrepFee', Position: '', StitchBase: 0, IsActive: true },
    { ServiceCode: 'RUSH', ServiceType: 'RUSH', DisplayName: 'Rush Order Fee', Category: 'Fees', PricingMethod: 'FLAT', TierLabel: '', UnitCost: 0, SellPrice: 50.00, PerUnit: 'per order', QuoteBuilderField: 'rushFee', Position: '', StitchBase: 0, IsActive: true },
    { ServiceCode: 'LTM', ServiceType: 'FEE', DisplayName: 'Less Than Minimum Fee', Category: 'Fees', PricingMethod: 'FLAT', TierLabel: '', UnitCost: 25.00, SellPrice: 50.00, PerUnit: 'per order', QuoteBuilderField: 'ltmFee', Position: '', StitchBase: 0, IsActive: true },
    { ServiceCode: 'ART', ServiceType: 'FEE', DisplayName: 'Art Charge', Category: 'Fees', PricingMethod: 'FLAT', TierLabel: '', UnitCost: 0, SellPrice: 0, PerUnit: 'varies', QuoteBuilderField: 'artCharge', Position: '', StitchBase: 0, IsActive: true },

    // Configuration values (used by pricing calculator - fetch from API instead of hardcoding)
    { ServiceCode: 'STITCH-RATE', ServiceType: 'CONFIG', DisplayName: 'Garment Stitch Rate', Category: 'Config', PricingMethod: 'CONFIG', TierLabel: '', UnitCost: 0.625, SellPrice: 1.25, PerUnit: 'per 1000 stitches', QuoteBuilderField: 'additionalStitchRate', Position: '', StitchBase: 8000, IsActive: true },
    { ServiceCode: 'CAP-STITCH-RATE', ServiceType: 'CONFIG', DisplayName: 'Cap Stitch Rate', Category: 'Config', PricingMethod: 'CONFIG', TierLabel: '', UnitCost: 0.50, SellPrice: 1.00, PerUnit: 'per 1000 stitches', QuoteBuilderField: 'capAdditionalStitchRate', Position: '', StitchBase: 5000, IsActive: true },
    { ServiceCode: 'PUFF-UPCHARGE', ServiceType: 'CONFIG', DisplayName: '3D Puff Upcharge', Category: 'Config', PricingMethod: 'CONFIG', TierLabel: '', UnitCost: 2.50, SellPrice: 5.00, PerUnit: 'per cap', QuoteBuilderField: 'puffUpchargePerCap', Position: '', StitchBase: 0, IsActive: true },
    { ServiceCode: 'PATCH-UPCHARGE', ServiceType: 'CONFIG', DisplayName: 'Laser Patch Upcharge', Category: 'Config', PricingMethod: 'CONFIG', TierLabel: '', UnitCost: 2.50, SellPrice: 5.00, PerUnit: 'per cap', QuoteBuilderField: 'patchUpchargePerCap', Position: '', StitchBase: 0, IsActive: true },

    // Additional service codes (added 2026-02-01 pricing audit)
    { ServiceCode: 'SEG', ServiceType: 'FEE', DisplayName: 'Sew Emblems to Garments', Category: 'Fees', PricingMethod: 'FLAT', TierLabel: '', UnitCost: 2.50, SellPrice: 5.00, PerUnit: 'per emblem', QuoteBuilderField: 'sewingFee', Position: '', StitchBase: 0, IsActive: true },
    { ServiceCode: 'CAP-DISCOUNT', ServiceType: 'CONFIG', DisplayName: 'Cap Discount Percentage', Category: 'Config', PricingMethod: 'CONFIG', TierLabel: '', UnitCost: 0, SellPrice: 0.20, PerUnit: 'multiplier', QuoteBuilderField: 'capDiscount', Position: '', StitchBase: 0, IsActive: true },
    { ServiceCode: 'HEAVYWEIGHT-SURCHARGE', ServiceType: 'CONFIG', DisplayName: 'Heavyweight Garment Surcharge', Category: 'Config', PricingMethod: 'CONFIG', TierLabel: '', UnitCost: 5.00, SellPrice: 10.00, PerUnit: 'per garment', QuoteBuilderField: 'heavyweightSurcharge', Position: '', StitchBase: 0, IsActive: true }
];

/**
 * Create a unique key for a service code record (ServiceCode + TierLabel)
 */
function makeRecordKey(record) {
    return `${record.ServiceCode}|${record.TierLabel || ''}`;
}

// POST /api/service-codes/seed
// Seeds the Caspio Service_Codes table with initial data
// Safe to run multiple times - only inserts records that don't exist
router.post('/service-codes/seed', async (req, res) => {
    console.log('[Service Codes] Starting seed operation...');

    const results = {
        inserted: 0,
        skipped: 0,
        failed: 0,
        errors: []
    };

    try {
        // First, fetch existing records to check what already exists
        console.log('[Service Codes] Fetching existing records...');
        const existingRecords = await fetchAllCaspioPages('/tables/Service_Codes/records', {});

        // Build set of existing keys (ServiceCode + TierLabel)
        const existingKeys = new Set();
        for (const record of existingRecords) {
            existingKeys.add(makeRecordKey(record));
        }
        console.log(`[Service Codes] Found ${existingRecords.length} existing records`);

        // Insert only records that don't exist
        for (const record of SERVICE_CODES_DATA) {
            const key = makeRecordKey(record);

            if (existingKeys.has(key)) {
                results.skipped++;
                console.log(`[Service Codes] Skipped (exists): ${record.ServiceCode} - ${record.TierLabel || 'FLAT'}`);
                continue;
            }

            try {
                await makeCaspioRequest('post', '/tables/Service_Codes/records', {}, record);
                results.inserted++;
                console.log(`[Service Codes] Inserted: ${record.ServiceCode} - ${record.TierLabel || 'FLAT'}`);
            } catch (err) {
                results.failed++;
                results.errors.push({
                    code: record.ServiceCode,
                    tier: record.TierLabel,
                    error: err.message
                });
                console.error(`[Service Codes] Failed to insert ${record.ServiceCode}:`, err.message);
            }
        }

        // Clear cache after seeding
        serviceCodesCache.clear();

        const totalExpected = SERVICE_CODES_DATA.length;
        const totalInDb = results.inserted + results.skipped;

        res.json({
            success: true,
            message: `Seed complete: ${results.inserted} inserted, ${results.skipped} skipped (already exist), ${results.failed} failed`,
            results,
            summary: {
                expected: totalExpected,
                nowInDatabase: totalInDb,
                missing: totalExpected - totalInDb
            }
        });
    } catch (error) {
        console.error('[Service Codes] Seed operation failed:', error);
        res.status(500).json({
            success: false,
            error: 'Seed operation failed',
            details: error.message,
            results
        });
    }
});

// POST /api/service-codes/update-fb
// Updates the FB (Full Back) records in Caspio to use stitch-based pricing
// Deletes old tiered FB records and inserts the new stitch-based record
router.post('/service-codes/update-fb', async (req, res) => {
    console.log('[Service Codes] Updating FB records to stitch-based pricing...');

    const results = {
        deleted: 0,
        inserted: 0,
        errors: []
    };

    try {
        // 1. Fetch existing FB records
        console.log('[Service Codes] Fetching existing FB records...');
        const existingRecords = await fetchAllCaspioPages('/tables/Service_Codes/records', {
            'q.where': "ServiceCode='FB'"
        });
        console.log(`[Service Codes] Found ${existingRecords.length} existing FB records`);

        // 2. Delete old FB records (they have PK_ID field)
        for (const record of existingRecords) {
            if (record.PK_ID) {
                try {
                    await makeCaspioRequest('delete', `/tables/Service_Codes/records/${record.PK_ID}`);
                    results.deleted++;
                    console.log(`[Service Codes] Deleted FB record: PK_ID=${record.PK_ID}, TierLabel=${record.TierLabel}`);
                } catch (err) {
                    results.errors.push({ action: 'delete', id: record.PK_ID, error: err.message });
                    console.error(`[Service Codes] Failed to delete FB record ${record.PK_ID}:`, err.message);
                }
            }
        }

        // 3. Insert the new stitch-based FB record
        const newFBRecord = {
            ServiceCode: 'FB',
            ServiceType: 'EMBROIDERY',
            DisplayName: 'Full Back (Stitch-Based)',
            Category: 'Full Back',
            PricingMethod: 'STITCH_BASED',
            TierLabel: 'ALL',
            UnitCost: 0.625,
            SellPrice: 1.25,
            PerUnit: 'per 1000 stitches',
            QuoteBuilderField: 'fullBack',
            Position: 'FB',
            StitchBase: 25000,
            IsActive: true
        };

        try {
            await makeCaspioRequest('post', '/tables/Service_Codes/records', {}, newFBRecord);
            results.inserted++;
            console.log('[Service Codes] Inserted new stitch-based FB record');
        } catch (err) {
            results.errors.push({ action: 'insert', error: err.message });
            console.error('[Service Codes] Failed to insert new FB record:', err.message);
        }

        // 4. Clear cache
        serviceCodesCache.clear();

        res.json({
            success: results.inserted > 0,
            message: `FB update complete: ${results.deleted} old records deleted, ${results.inserted} new record inserted`,
            results,
            newRecord: newFBRecord
        });
    } catch (error) {
        console.error('[Service Codes] FB update failed:', error);
        res.status(500).json({
            success: false,
            error: 'FB update failed',
            details: error.message,
            results
        });
    }
});

// ============================================
// CRUD OPERATIONS - Full database management
// ============================================

// POST /api/service-codes (Create single record)
// Creates a new service code in the database
router.post('/service-codes', async (req, res) => {
    const record = req.body;

    // Validate required fields
    if (!record.ServiceCode) {
        return res.status(400).json({
            success: false,
            error: 'ServiceCode is required'
        });
    }
    if (!record.ServiceType) {
        return res.status(400).json({
            success: false,
            error: 'ServiceType is required'
        });
    }

    // Set defaults for optional fields
    const newRecord = {
        ServiceCode: record.ServiceCode,
        ServiceType: record.ServiceType,
        DisplayName: record.DisplayName || record.ServiceCode,
        Category: record.Category || 'Other',
        PricingMethod: record.PricingMethod || 'FLAT',
        TierLabel: record.TierLabel || '',
        UnitCost: record.UnitCost || 0,
        SellPrice: record.SellPrice || 0,
        PerUnit: record.PerUnit || 'each',
        QuoteBuilderField: record.QuoteBuilderField || '',
        Position: record.Position || '',
        StitchBase: record.StitchBase || 0,
        IsActive: record.IsActive !== false // Default to true
    };

    try {
        console.log(`[Service Codes] Creating new record: ${newRecord.ServiceCode}`);
        const result = await makeCaspioRequest('post', '/tables/Service_Codes/records', {}, newRecord);

        // Clear cache after creating
        serviceCodesCache.clear();

        res.status(201).json({
            success: true,
            message: `Service code '${newRecord.ServiceCode}' created successfully`,
            data: { ...newRecord, PK_ID: result.PK_ID }
        });
    } catch (error) {
        console.error('[Service Codes] Create failed:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to create service code',
            details: error.message
        });
    }
});

// PUT /api/service-codes/:id (Update record by PK_ID)
// Updates an existing service code
router.put('/service-codes/:id', async (req, res) => {
    const { id } = req.params;
    const updates = req.body;

    if (!id || isNaN(parseInt(id))) {
        return res.status(400).json({
            success: false,
            error: 'Valid numeric ID (PK_ID) is required'
        });
    }

    // Remove PK_ID from updates if present (can't update primary key)
    delete updates.PK_ID;

    if (Object.keys(updates).length === 0) {
        return res.status(400).json({
            success: false,
            error: 'No fields to update'
        });
    }

    try {
        console.log(`[Service Codes] Updating record PK_ID=${id}:`, updates);
        // Caspio REST API uses query params for targeting records to update
        await makeCaspioRequest('put', '/tables/Service_Codes/records', { 'q.where': `PK_ID=${id}` }, updates);

        // Clear cache after updating
        serviceCodesCache.clear();

        res.json({
            success: true,
            message: `Service code PK_ID=${id} updated successfully`,
            updatedFields: Object.keys(updates)
        });
    } catch (error) {
        console.error(`[Service Codes] Update failed for PK_ID=${id}:`, error);

        // Check if it's a 404 (record not found)
        if (error.message && error.message.includes('404')) {
            return res.status(404).json({
                success: false,
                error: `Service code with PK_ID=${id} not found`
            });
        }

        res.status(500).json({
            success: false,
            error: 'Failed to update service code',
            details: error.message
        });
    }
});

// DELETE /api/service-codes/:id (Soft delete by PK_ID)
// Sets IsActive = false instead of hard delete (preserves history)
router.delete('/service-codes/:id', async (req, res) => {
    const { id } = req.params;
    const { hard } = req.query; // ?hard=true for actual deletion

    if (!id || isNaN(parseInt(id))) {
        return res.status(400).json({
            success: false,
            error: 'Valid numeric ID (PK_ID) is required'
        });
    }

    try {
        if (hard === 'true') {
            // Hard delete - actually remove from database
            // Caspio REST API uses query params for targeting records to delete
            console.log(`[Service Codes] HARD DELETE record PK_ID=${id}`);
            await makeCaspioRequest('delete', '/tables/Service_Codes/records', { 'q.where': `PK_ID=${id}` });

            serviceCodesCache.clear();

            res.json({
                success: true,
                message: `Service code PK_ID=${id} permanently deleted`
            });
        } else {
            // Soft delete - set IsActive = false
            console.log(`[Service Codes] Soft delete (deactivate) record PK_ID=${id}`);
            await makeCaspioRequest('put', '/tables/Service_Codes/records', { 'q.where': `PK_ID=${id}` }, { IsActive: false });

            serviceCodesCache.clear();

            res.json({
                success: true,
                message: `Service code PK_ID=${id} deactivated (soft delete)`,
                note: 'Use ?hard=true to permanently delete'
            });
        }
    } catch (error) {
        console.error(`[Service Codes] Delete failed for PK_ID=${id}:`, error);

        if (error.message && error.message.includes('404')) {
            return res.status(404).json({
                success: false,
                error: `Service code with PK_ID=${id} not found`
            });
        }

        res.status(500).json({
            success: false,
            error: 'Failed to delete service code',
            details: error.message
        });
    }
});

// GET /api/service-codes/:id (Get single record by PK_ID)
// Fetch a specific service code by its primary key
router.get('/service-codes/:id', async (req, res) => {
    const { id } = req.params;

    // Skip if id matches other routes
    if (['aliases', 'cache', 'tier'].includes(id)) {
        return res.status(400).json({
            success: false,
            error: 'Invalid ID format'
        });
    }

    if (!id || isNaN(parseInt(id))) {
        return res.status(400).json({
            success: false,
            error: 'Valid numeric ID (PK_ID) is required'
        });
    }

    try {
        const records = await fetchAllCaspioPages('/tables/Service_Codes/records', {
            'q.where': `PK_ID=${id}`
        });

        if (records.length === 0) {
            return res.status(404).json({
                success: false,
                error: `Service code with PK_ID=${id} not found`
            });
        }

        res.json({
            success: true,
            data: records[0]
        });
    } catch (error) {
        console.error(`[Service Codes] Get by ID failed for PK_ID=${id}:`, error);
        res.status(500).json({
            success: false,
            error: 'Failed to fetch service code',
            details: error.message
        });
    }
});

module.exports = router;
