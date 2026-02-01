// Service Codes API
// Returns embroidery service codes, pricing tiers, and fee structures
// Used by quote builders for ShopWorks import and pricing calculations
//
// NOTE: Data is hardcoded until Caspio Service_Codes table is created
// See /memory/SERVICE_CODES_TABLE.md for planned Caspio table schema

const express = require('express');
const router = express.Router();

// Service code data (hardcoded until Caspio table created)
// Structure matches planned Caspio Service_Codes table schema
const SERVICE_CODES = [
    // Digitizing Services
    { ServiceCode: 'DD', ServiceType: 'DIGITIZING', DisplayName: 'Digitizing (Legacy)', Category: 'Digitizing', PricingMethod: 'FLAT', TierLabel: null, UnitCost: 0, SellPrice: 0, PerUnit: 'per order', QuoteBuilderField: 'digitizing', Position: null, StitchBase: null, IsActive: true },
    { ServiceCode: 'DGT-001', ServiceType: 'DIGITIZING', DisplayName: 'Small Design (<5K stitches)', Category: 'Digitizing', PricingMethod: 'FLAT', TierLabel: null, UnitCost: 25, SellPrice: 50, PerUnit: 'per design', QuoteBuilderField: 'digitizing', Position: null, StitchBase: 5000, IsActive: true },
    { ServiceCode: 'DGT-002', ServiceType: 'DIGITIZING', DisplayName: 'Medium Design (5K-10K stitches)', Category: 'Digitizing', PricingMethod: 'FLAT', TierLabel: null, UnitCost: 35, SellPrice: 75, PerUnit: 'per design', QuoteBuilderField: 'digitizing', Position: null, StitchBase: 10000, IsActive: true },
    { ServiceCode: 'DGT-003', ServiceType: 'DIGITIZING', DisplayName: 'Large Design (10K-15K stitches)', Category: 'Digitizing', PricingMethod: 'FLAT', TierLabel: null, UnitCost: 50, SellPrice: 100, PerUnit: 'per design', QuoteBuilderField: 'digitizing', Position: null, StitchBase: 15000, IsActive: true },
    { ServiceCode: 'DGT-004', ServiceType: 'DIGITIZING', DisplayName: 'Extra Large Design (15K+ stitches)', Category: 'Digitizing', PricingMethod: 'FLAT', TierLabel: null, UnitCost: 75, SellPrice: 150, PerUnit: 'per design', QuoteBuilderField: 'digitizing', Position: null, StitchBase: 20000, IsActive: true },

    // Apparel Left Chest (AL) - Standard Embroidery Tiers
    { ServiceCode: 'AL', ServiceType: 'EMBROIDERY', DisplayName: 'Apparel Left Chest 1-23 pcs', Category: 'Apparel Left Chest', PricingMethod: 'TIERED', TierLabel: '1-23', UnitCost: 6.75, SellPrice: 13.50, PerUnit: 'each', QuoteBuilderField: 'leftChest', Position: 'LC', StitchBase: 8000, IsActive: true },
    { ServiceCode: 'AL', ServiceType: 'EMBROIDERY', DisplayName: 'Apparel Left Chest 24-47 pcs', Category: 'Apparel Left Chest', PricingMethod: 'TIERED', TierLabel: '24-47', UnitCost: 6.25, SellPrice: 12.50, PerUnit: 'each', QuoteBuilderField: 'leftChest', Position: 'LC', StitchBase: 8000, IsActive: true },
    { ServiceCode: 'AL', ServiceType: 'EMBROIDERY', DisplayName: 'Apparel Left Chest 48-71 pcs', Category: 'Apparel Left Chest', PricingMethod: 'TIERED', TierLabel: '48-71', UnitCost: 5.25, SellPrice: 10.50, PerUnit: 'each', QuoteBuilderField: 'leftChest', Position: 'LC', StitchBase: 8000, IsActive: true },
    { ServiceCode: 'AL', ServiceType: 'EMBROIDERY', DisplayName: 'Apparel Left Chest 72+ pcs', Category: 'Apparel Left Chest', PricingMethod: 'TIERED', TierLabel: '72+', UnitCost: 4.75, SellPrice: 9.50, PerUnit: 'each', QuoteBuilderField: 'leftChest', Position: 'LC', StitchBase: 8000, IsActive: true },

    // Full Back (FB) - Different tier structure (1-11, 12-23, 24-47, 48+)
    // Note: Prices TBD - need competitive research
    { ServiceCode: 'FB', ServiceType: 'EMBROIDERY', DisplayName: 'Full Back 1-11 pcs', Category: 'Full Back', PricingMethod: 'TIERED', TierLabel: '1-11', UnitCost: null, SellPrice: null, PerUnit: 'each', QuoteBuilderField: 'fullBack', Position: 'FB', StitchBase: 15000, IsActive: true },
    { ServiceCode: 'FB', ServiceType: 'EMBROIDERY', DisplayName: 'Full Back 12-23 pcs', Category: 'Full Back', PricingMethod: 'TIERED', TierLabel: '12-23', UnitCost: null, SellPrice: null, PerUnit: 'each', QuoteBuilderField: 'fullBack', Position: 'FB', StitchBase: 15000, IsActive: true },
    { ServiceCode: 'FB', ServiceType: 'EMBROIDERY', DisplayName: 'Full Back 24-47 pcs', Category: 'Full Back', PricingMethod: 'TIERED', TierLabel: '24-47', UnitCost: null, SellPrice: null, PerUnit: 'each', QuoteBuilderField: 'fullBack', Position: 'FB', StitchBase: 15000, IsActive: true },
    { ServiceCode: 'FB', ServiceType: 'EMBROIDERY', DisplayName: 'Full Back 48+ pcs', Category: 'Full Back', PricingMethod: 'TIERED', TierLabel: '48+', UnitCost: null, SellPrice: null, PerUnit: 'each', QuoteBuilderField: 'fullBack', Position: 'FB', StitchBase: 15000, IsActive: true },

    // Cap Back (CB) - Same tiers as Cap AL
    { ServiceCode: 'CB', ServiceType: 'EMBROIDERY', DisplayName: 'Cap Back 1-23 pcs', Category: 'Cap Back', PricingMethod: 'TIERED', TierLabel: '1-23', UnitCost: 3.40, SellPrice: 6.75, PerUnit: 'each', QuoteBuilderField: 'capBack', Position: 'CB', StitchBase: 8000, IsActive: true },
    { ServiceCode: 'CB', ServiceType: 'EMBROIDERY', DisplayName: 'Cap Back 24-47 pcs', Category: 'Cap Back', PricingMethod: 'TIERED', TierLabel: '24-47', UnitCost: 2.90, SellPrice: 5.75, PerUnit: 'each', QuoteBuilderField: 'capBack', Position: 'CB', StitchBase: 8000, IsActive: true },
    { ServiceCode: 'CB', ServiceType: 'EMBROIDERY', DisplayName: 'Cap Back 48-71 pcs', Category: 'Cap Back', PricingMethod: 'TIERED', TierLabel: '48-71', UnitCost: 2.75, SellPrice: 5.50, PerUnit: 'each', QuoteBuilderField: 'capBack', Position: 'CB', StitchBase: 8000, IsActive: true },
    { ServiceCode: 'CB', ServiceType: 'EMBROIDERY', DisplayName: 'Cap Back 72+ pcs', Category: 'Cap Back', PricingMethod: 'TIERED', TierLabel: '72+', UnitCost: 2.65, SellPrice: 5.25, PerUnit: 'each', QuoteBuilderField: 'capBack', Position: 'CB', StitchBase: 8000, IsActive: true },

    // Monogram/Name Services
    { ServiceCode: 'Monogram', ServiceType: 'EMBROIDERY', DisplayName: 'Monogram (3 letters)', Category: 'Special', PricingMethod: 'FLAT', TierLabel: null, UnitCost: 6.25, SellPrice: 12.50, PerUnit: 'each', QuoteBuilderField: 'monogram', Position: 'OTHER', StitchBase: 2000, IsActive: true },
    { ServiceCode: 'Name', ServiceType: 'EMBROIDERY', DisplayName: 'Name Personalization', Category: 'Special', PricingMethod: 'FLAT', TierLabel: null, UnitCost: 6.25, SellPrice: 12.50, PerUnit: 'each', QuoteBuilderField: 'name', Position: 'OTHER', StitchBase: 3500, IsActive: true },

    // DECG (Customer-Supplied Garments) Tiers
    { ServiceCode: 'DECG', ServiceType: 'DECORATION', DisplayName: 'Garment Decoration 1-2 pcs', Category: 'Decoration Garments', PricingMethod: 'TIERED', TierLabel: '1-2', UnitCost: 22.50, SellPrice: 45.00, PerUnit: 'each', QuoteBuilderField: 'decorationGarment', Position: 'FULL', StitchBase: 10000, IsActive: true },
    { ServiceCode: 'DECG', ServiceType: 'DECORATION', DisplayName: 'Garment Decoration 3-5 pcs', Category: 'Decoration Garments', PricingMethod: 'TIERED', TierLabel: '3-5', UnitCost: 20.00, SellPrice: 40.00, PerUnit: 'each', QuoteBuilderField: 'decorationGarment', Position: 'FULL', StitchBase: 10000, IsActive: true },
    { ServiceCode: 'DECG', ServiceType: 'DECORATION', DisplayName: 'Garment Decoration 6-11 pcs', Category: 'Decoration Garments', PricingMethod: 'TIERED', TierLabel: '6-11', UnitCost: 19.00, SellPrice: 38.00, PerUnit: 'each', QuoteBuilderField: 'decorationGarment', Position: 'FULL', StitchBase: 10000, IsActive: true },
    { ServiceCode: 'DECG', ServiceType: 'DECORATION', DisplayName: 'Garment Decoration 12-23 pcs', Category: 'Decoration Garments', PricingMethod: 'TIERED', TierLabel: '12-23', UnitCost: 16.00, SellPrice: 32.00, PerUnit: 'each', QuoteBuilderField: 'decorationGarment', Position: 'FULL', StitchBase: 10000, IsActive: true },
    { ServiceCode: 'DECG', ServiceType: 'DECORATION', DisplayName: 'Garment Decoration 24-71 pcs', Category: 'Decoration Garments', PricingMethod: 'TIERED', TierLabel: '24-71', UnitCost: 15.00, SellPrice: 30.00, PerUnit: 'each', QuoteBuilderField: 'decorationGarment', Position: 'FULL', StitchBase: 10000, IsActive: true },
    { ServiceCode: 'DECG', ServiceType: 'DECORATION', DisplayName: 'Garment Decoration 72-143 pcs', Category: 'Decoration Garments', PricingMethod: 'TIERED', TierLabel: '72-143', UnitCost: 12.50, SellPrice: 25.00, PerUnit: 'each', QuoteBuilderField: 'decorationGarment', Position: 'FULL', StitchBase: 10000, IsActive: true },
    { ServiceCode: 'DECG', ServiceType: 'DECORATION', DisplayName: 'Garment Decoration 144+ pcs', Category: 'Decoration Garments', PricingMethod: 'TIERED', TierLabel: '144+', UnitCost: 7.50, SellPrice: 15.00, PerUnit: 'each', QuoteBuilderField: 'decorationGarment', Position: 'FULL', StitchBase: 10000, IsActive: true },

    // DECC (Customer-Supplied Caps) Tiers - ~20% lower than DECG
    { ServiceCode: 'DECC', ServiceType: 'DECORATION', DisplayName: 'Cap Decoration 1-2 pcs', Category: 'Decoration Caps', PricingMethod: 'TIERED', TierLabel: '1-2', UnitCost: 18.00, SellPrice: 36.00, PerUnit: 'each', QuoteBuilderField: 'decorationCap', Position: 'CAP', StitchBase: 8000, IsActive: true },
    { ServiceCode: 'DECC', ServiceType: 'DECORATION', DisplayName: 'Cap Decoration 3-5 pcs', Category: 'Decoration Caps', PricingMethod: 'TIERED', TierLabel: '3-5', UnitCost: 16.00, SellPrice: 32.00, PerUnit: 'each', QuoteBuilderField: 'decorationCap', Position: 'CAP', StitchBase: 8000, IsActive: true },
    { ServiceCode: 'DECC', ServiceType: 'DECORATION', DisplayName: 'Cap Decoration 6-11 pcs', Category: 'Decoration Caps', PricingMethod: 'TIERED', TierLabel: '6-11', UnitCost: 15.00, SellPrice: 30.00, PerUnit: 'each', QuoteBuilderField: 'decorationCap', Position: 'CAP', StitchBase: 8000, IsActive: true },
    { ServiceCode: 'DECC', ServiceType: 'DECORATION', DisplayName: 'Cap Decoration 12-23 pcs', Category: 'Decoration Caps', PricingMethod: 'TIERED', TierLabel: '12-23', UnitCost: 12.50, SellPrice: 25.00, PerUnit: 'each', QuoteBuilderField: 'decorationCap', Position: 'CAP', StitchBase: 8000, IsActive: true },
    { ServiceCode: 'DECC', ServiceType: 'DECORATION', DisplayName: 'Cap Decoration 24-71 pcs', Category: 'Decoration Caps', PricingMethod: 'TIERED', TierLabel: '24-71', UnitCost: 12.00, SellPrice: 24.00, PerUnit: 'each', QuoteBuilderField: 'decorationCap', Position: 'CAP', StitchBase: 8000, IsActive: true },
    { ServiceCode: 'DECC', ServiceType: 'DECORATION', DisplayName: 'Cap Decoration 72-143 pcs', Category: 'Decoration Caps', PricingMethod: 'TIERED', TierLabel: '72-143', UnitCost: 10.00, SellPrice: 20.00, PerUnit: 'each', QuoteBuilderField: 'decorationCap', Position: 'CAP', StitchBase: 8000, IsActive: true },
    { ServiceCode: 'DECC', ServiceType: 'DECORATION', DisplayName: 'Cap Decoration 144+ pcs', Category: 'Decoration Caps', PricingMethod: 'TIERED', TierLabel: '144+', UnitCost: 6.00, SellPrice: 12.00, PerUnit: 'each', QuoteBuilderField: 'decorationCap', Position: 'CAP', StitchBase: 8000, IsActive: true },

    // Fees
    { ServiceCode: 'GRT-50', ServiceType: 'FEE', DisplayName: 'Setup Fee (Standard)', Category: 'Fees', PricingMethod: 'FLAT', TierLabel: null, UnitCost: 25.00, SellPrice: 50.00, PerUnit: 'per order', QuoteBuilderField: 'setupFee', Position: null, StitchBase: null, IsActive: true },
    { ServiceCode: 'GRT-75', ServiceType: 'FEE', DisplayName: 'Design Prep Fee', Category: 'Fees', PricingMethod: 'FLAT', TierLabel: null, UnitCost: 37.50, SellPrice: 75.00, PerUnit: 'per hour', QuoteBuilderField: 'designPrepFee', Position: null, StitchBase: null, IsActive: true },
    { ServiceCode: 'RUSH', ServiceType: 'RUSH', DisplayName: 'Rush Order Fee', Category: 'Fees', PricingMethod: 'FLAT', TierLabel: null, UnitCost: 0, SellPrice: 50.00, PerUnit: 'per order', QuoteBuilderField: 'rushFee', Position: null, StitchBase: null, IsActive: true },
    { ServiceCode: 'LTM', ServiceType: 'FEE', DisplayName: 'Less Than Minimum Fee', Category: 'Fees', PricingMethod: 'FLAT', TierLabel: null, UnitCost: 25.00, SellPrice: 50.00, PerUnit: 'per order', QuoteBuilderField: 'ltmFee', Position: null, StitchBase: null, IsActive: true },
    { ServiceCode: 'ART', ServiceType: 'FEE', DisplayName: 'Art Charge', Category: 'Fees', PricingMethod: 'FLAT', TierLabel: null, UnitCost: 0, SellPrice: 0, PerUnit: 'varies', QuoteBuilderField: 'artCharge', Position: null, StitchBase: null, IsActive: true }
];

// Service code aliases for typo handling
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
 * @param {string} serviceCode - Service code (AL, FB, CB, DECG, DECC)
 * @param {number} quantity - Quantity to price
 * @returns {Object|null} Matching tier data or null
 */
function getTierForQuantity(serviceCode, quantity) {
    const code = resolveAlias(serviceCode);
    const tiers = SERVICE_CODES.filter(sc =>
        sc.ServiceCode.toUpperCase() === code.toUpperCase() &&
        sc.PricingMethod === 'TIERED' &&
        sc.IsActive
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
router.get('/service-codes', (req, res) => {
    const { code, type, category, position, active = 'true', quantity } = req.query;

    let results = [...SERVICE_CODES];

    // Filter by active status
    if (active === 'true') {
        results = results.filter(sc => sc.IsActive);
    } else if (active === 'false') {
        results = results.filter(sc => !sc.IsActive);
    }

    // Filter by service code (with alias resolution)
    if (code) {
        const resolvedCode = resolveAlias(code);
        results = results.filter(sc =>
            sc.ServiceCode.toUpperCase() === resolvedCode.toUpperCase()
        );
    }

    // Filter by type
    if (type) {
        results = results.filter(sc =>
            sc.ServiceType.toUpperCase() === type.toUpperCase()
        );
    }

    // Filter by category
    if (category) {
        results = results.filter(sc =>
            sc.Category.toLowerCase().includes(category.toLowerCase())
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
            const tier = getTierForQuantity(code, qty);
            if (tier) {
                return res.json({
                    success: true,
                    data: [tier],
                    count: 1,
                    tier: tier.TierLabel,
                    quantity: qty
                });
            }
        }
    }

    res.json({
        success: true,
        data: results,
        count: results.length
    });
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
router.get('/service-codes/tier/:code/:quantity', (req, res) => {
    const { code, quantity } = req.params;
    const qty = parseInt(quantity);

    if (isNaN(qty) || qty < 1) {
        return res.status(400).json({
            success: false,
            error: 'Invalid quantity. Must be a positive integer.'
        });
    }

    const tier = getTierForQuantity(code, qty);
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
        unitCost: tier.UnitCost
    });
});

module.exports = router;
