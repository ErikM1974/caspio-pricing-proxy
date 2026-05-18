// DTG Canonical Pricing — single source of truth for DTG per-piece prices.
//
// Ported VERBATIM (algorithm-equivalent) from
// shared_components/js/dtg-pricing-service.js in the Pricing Index repo,
// so the three DTG surfaces always produce identical numbers:
//   1. /pricing/dtg (calculators/dtg-pricing.html → window.DTGPricingService)
//   2. /order-form.html (pages/order-form + window.DTGPricingService)
//   3. /quote-builders/dtg-quote-builder.html (AI chat tool → this module via
//      POST /api/dtg/quote-pricing; inline form also uses window.DTGPricingService
//      live for the visual preview)
//
// Pure functions only. No HTTP, no caching, no logging. Caller provides the
// product-bundle data already fetched.
//
// Rules baked in:
//   - Tier <24 → use the 24-47 tier base + LTM ($50 distributed)
//   - LTM perUnit = Math.floor((50/combinedQty) * 100) / 100 (floor, NOT round)
//   - Base garment cost per style = Math.min of valid size prices (>0)
//   - Base unit = Math.ceil((garmentCost / marginDenominator + printCost) * 2) / 2
//   - Per-size = baseUnit + upcharges[size]  (then add ltmPerUnit per piece)
//   - Print cost combos (LC_FB etc.) = sum of PrintCost across the underlying
//     codes at the resolved tier
//
// DO NOT diverge from dtg-pricing-service.js. If the frontend ever changes,
// update this AND re-run tests/dtg-canonical-pricing.test.js.

'use strict';

const LTM_THRESHOLD = 24;
const LTM_FEE = 50;
// Fallback margin if the API doesn't supply one — matches dtg-pricing-service.js:520.
const FALLBACK_MARGIN_DENOM = 0.57;

const STANDARD_LOCATIONS = ['LC', 'FF', 'JF', 'FB', 'JB'];
const COMBO_LOCATIONS = ['LC_FB', 'FF_FB', 'JF_JB', 'LC_JB'];
const ALL_LOCATION_CODES = [...STANDARD_LOCATIONS, ...COMBO_LOCATIONS];

const LOCATION_LABELS = {
    LC: 'Left Chest',
    FF: 'Full Front',
    JF: 'Jumbo Front',
    FB: 'Full Back',
    JB: 'Jumbo Back',
    LC_FB: 'Left Chest + Full Back',
    FF_FB: 'Full Front + Full Back',
    JF_JB: 'Jumbo Front + Jumbo Back',
    LC_JB: 'Left Chest + Jumbo Back',
};

/** Round UP to the nearest $0.50. */
function roundUpToHalfDollar(amount) {
    return Math.ceil(amount * 2) / 2;
}

/**
 * Pick the tier object for a given combined quantity.
 * Mirrors getTierForQuantity in dtg-pricing-service.js (lines 477-534).
 * For qty<24 we return the 24-47 tier with TierLabel '24-47' (the consumer
 * tags the line as "1-23 (LTM)" itself).
 */
function tierForCombinedQty(tiers, qty) {
    const isLtm = qty < LTM_THRESHOLD;

    if (!Array.isArray(tiers) || tiers.length === 0) {
        return {
            TierLabel: '24-47',
            MinQuantity: 1,
            MaxQuantity: 47,
            MarginDenominator: FALLBACK_MARGIN_DENOM,
            _fallback: true,
            _isLtm: isLtm,
        };
    }

    if (isLtm) {
        const t = tiers.find((row) => row.TierLabel === '24-47');
        if (t) return { ...t, _isLtm: true };
        return {
            TierLabel: '24-47',
            MinQuantity: 1,
            MaxQuantity: 47,
            MarginDenominator: FALLBACK_MARGIN_DENOM,
            _fallback: true,
            _isLtm: true,
        };
    }

    const t = tiers.find((row) => qty >= Number(row.MinQuantity) && qty <= Number(row.MaxQuantity));
    if (t) return { ...t, _isLtm: false };
    // Cap at the highest tier if we're above all ranges.
    return { ...tiers[tiers.length - 1], _isLtm: false };
}

/**
 * LTM distributed per piece when combined qty < 24. Floors to cents to
 * avoid over-charging the customer (per /memory/MEMORY.md "DTG LTM: floor not round").
 */
function ltmPerUnit(combinedQty) {
    if (!Number.isFinite(combinedQty) || combinedQty < 1) return 0;
    if (combinedQty >= LTM_THRESHOLD) return 0;
    return Math.floor((LTM_FEE / combinedQty) * 100) / 100;
}

/**
 * Compute the per-size BASE price for a given style at a tier + location combo.
 * Returns { baseUnit, totalPrintCost, marginDenominator, perSize: { [size]: price } }.
 * Does NOT include LTM — caller adds ltmPerUnit per piece.
 *
 * Ported from calculatePriceFromRawData (lines 679-714) and the inline
 * formula in calculateAllTierPricesForLocation (lines 439-471).
 */
function priceForLocationCombo({ bundle, locationCode, tierLabel }) {
    const pricing = bundle && bundle.pricing ? bundle.pricing : (bundle || {});
    const tiers = Array.isArray(pricing.tiers) ? pricing.tiers : [];
    const costs = Array.isArray(pricing.costs) ? pricing.costs : [];
    const sizes = Array.isArray(pricing.sizes) ? pricing.sizes : [];
    const upcharges = pricing.upcharges && typeof pricing.upcharges === 'object' ? pricing.upcharges : {};

    const tier = tiers.find((t) => t.TierLabel === tierLabel);
    const marginDenominator = (tier && Number(tier.MarginDenominator)) || FALLBACK_MARGIN_DENOM;

    // Base garment cost = Math.min of valid size prices (supports both 'price' and 'maxCasePrice')
    const validPrices = sizes
        .map((s) => parseFloat(s.price != null ? s.price : s.maxCasePrice))
        .filter((p) => Number.isFinite(p) && p > 0);
    if (validPrices.length === 0) {
        return { error: 'no_valid_garment_prices', perSize: {}, baseUnit: 0, totalPrintCost: 0, marginDenominator };
    }
    const baseGarmentCost = Math.min(...validPrices);

    // Sum print cost across combo codes at the resolved tier
    const codes = String(locationCode || '').split('_');
    let totalPrintCost = 0;
    for (const code of codes) {
        const row = costs.find((c) => c.PrintLocationCode === code && c.TierLabel === tierLabel);
        if (row) totalPrintCost += parseFloat(row.PrintCost) || 0;
    }

    const baseUnit = roundUpToHalfDollar(baseGarmentCost / marginDenominator + totalPrintCost);

    const perSize = {};
    for (const sz of sizes) {
        const size = sz.size;
        const p = parseFloat(sz.price != null ? sz.price : sz.maxCasePrice);
        if (!Number.isFinite(p) || p <= 0) {
            // Size unavailable — mark explicitly (matches dtg-pricing-service.js 'N/A')
            perSize[size] = null;
            continue;
        }
        const upcharge = parseFloat(upcharges[size]) || 0;
        perSize[size] = baseUnit + upcharge;
    }

    return {
        baseUnit,
        totalPrintCost,
        marginDenominator,
        baseGarmentCost,
        perSize,
    };
}

/**
 * Multi-line aggregation — given a shared locationCode and an array of lines,
 * compute the combined qty, derive ONE tier + ONE ltmPerUnit, fetch each
 * line's price-per-size from its bundle, and return a fully detailed
 * breakdown.
 *
 * Caller is responsible for fetching each line's `bundle` (the proxy route
 * does this; tests provide mocked bundles). Bundles are keyed by upper-case
 * style number in `bundlesByStyle`.
 *
 * @returns {Object} A multi-line quote object with shared tier + line
 *                   breakdowns + subtotal + warnings.
 */
function priceLines({ locationCode, lines, bundlesByStyle }) {
    const errors = [];

    const normLoc = String(locationCode || '').toUpperCase();
    if (!ALL_LOCATION_CODES.includes(normLoc)) {
        return {
            error: 'bad_input',
            message: `locationCode must be one of: ${ALL_LOCATION_CODES.join(', ')}. Got "${locationCode}".`,
        };
    }
    if (!Array.isArray(lines) || lines.length === 0) {
        return { error: 'bad_input', message: 'lines[] is required and must be non-empty' };
    }
    if (!bundlesByStyle || typeof bundlesByStyle !== 'object') {
        return { error: 'bad_input', message: 'bundlesByStyle map is required' };
    }

    // Normalize + sum
    const normLines = [];
    let combinedQty = 0;
    for (let i = 0; i < lines.length; i++) {
        const ln = lines[i] || {};
        const style = String(ln.styleNumber || '').trim().toUpperCase();
        const color = String(ln.color || '').trim();
        const sizes = ln.sizes && typeof ln.sizes === 'object' ? ln.sizes : null;
        if (!style) return { error: 'bad_input', message: `lines[${i}].styleNumber is required` };
        if (!color) return { error: 'bad_input', message: `lines[${i}].color is required` };
        if (!sizes) return { error: 'bad_input', message: `lines[${i}].sizes object is required` };
        const sizeQty = Object.values(sizes).reduce((s, v) => s + (Number(v) || 0), 0);
        if (sizeQty < 1) return { error: 'bad_input', message: `lines[${i}].sizes total must be ≥ 1` };
        normLines.push({ index: i, styleNumber: style, color, sizes, lineQty: sizeQty });
        combinedQty += sizeQty;
    }
    if (combinedQty < 1) return { error: 'bad_input', message: 'Combined qty must be ≥ 1' };

    // Pick the first bundle that has tier data — tiers are shared across styles.
    let tiers = [];
    for (const style of Object.keys(bundlesByStyle)) {
        const b = bundlesByStyle[style];
        const t = (b && b.pricing && Array.isArray(b.pricing.tiers)) ? b.pricing.tiers : [];
        if (t.length > 0) { tiers = t; break; }
    }

    const tier = tierForCombinedQty(tiers, combinedQty);
    const tierLabel = tier.TierLabel;
    const isLtm = tier._isLtm;
    const perUnitLtm = isLtm ? ltmPerUnit(combinedQty) : 0;

    // For each line, look up its style bundle and compute per-size pricing.
    const lineItems = [];
    let subtotal = 0;

    for (const ln of normLines) {
        const bundle = bundlesByStyle[ln.styleNumber];
        if (!bundle) {
            errors.push(`No bundle provided for style ${ln.styleNumber}`);
            continue;
        }

        const priced = priceForLocationCombo({ bundle, locationCode: normLoc, tierLabel });
        if (priced.error) {
            errors.push(`${ln.styleNumber}: ${priced.error}`);
            continue;
        }

        const lineSizes = [];
        let lineTotal = 0;
        let aggregateBase = 0;
        let aggregateQtyForAvg = 0;
        const upchargesUsed = [];

        for (const [size, sizeQtyRaw] of Object.entries(ln.sizes)) {
            const q = Number(sizeQtyRaw) || 0;
            if (q <= 0) continue;
            const sz = String(size);
            const baseForSize = priced.perSize[sz] != null ? priced.perSize[sz] : priced.perSize[sz.toUpperCase()];
            if (baseForSize == null) {
                lineSizes.push({ size: sz, quantity: q, error: `Size ${sz} not available for ${ln.styleNumber}` });
                continue;
            }
            const upchargeRaw = (bundle.pricing && bundle.pricing.upcharges && bundle.pricing.upcharges[sz]) || 0;
            const upcharge = parseFloat(upchargeRaw) || 0;
            const finalUnit = Math.round((baseForSize + perUnitLtm) * 100) / 100;
            const lineTotalForSize = Math.round(finalUnit * q * 100) / 100;
            lineSizes.push({
                size: sz,
                quantity: q,
                baseUnit: Math.round(baseForSize * 100) / 100,
                ltmPerUnit: perUnitLtm,
                finalUnit,
                lineTotal: lineTotalForSize,
                sizeUpcharge: Math.round(upcharge * 100) / 100,
            });
            if (upcharge > 0) upchargesUsed.push({ size: sz, qty: q, amount: Math.round(upcharge * 100) / 100 });
            lineTotal += lineTotalForSize;
            aggregateBase += baseForSize * q;
            aggregateQtyForAvg += q;
        }

        const avgBaseUnit = aggregateQtyForAvg > 0
            ? Math.round((aggregateBase / aggregateQtyForAvg) * 100) / 100
            : 0;
        const avgFinalUnit = Math.round((avgBaseUnit + perUnitLtm) * 100) / 100;
        const partNumber = `${ln.styleNumber}-${ln.color.replace(/\s+/g, '').toUpperCase()}-${normLoc}`;

        lineItems.push({
            partNumber,
            styleNumber: ln.styleNumber,
            color: ln.color,
            description: (bundle.product && bundle.product.title)
                ? `${bundle.product.title} — ${ln.color}`
                : `${ln.styleNumber} — ${ln.color}`,
            locationCode: normLoc,
            locationLabel: LOCATION_LABELS[normLoc] || normLoc,
            sizes: ln.sizes,
            totalQuantity: ln.lineQty,
            tier: isLtm ? `${tierLabel} (LTM)` : tierLabel,
            baseTier: tierLabel,
            isLtmTier: isLtm,
            baseUnitPrice: avgBaseUnit,
            ltmPerUnit: perUnitLtm,
            finalUnitPrice: avgFinalUnit,
            lineTotal: Math.round(lineTotal * 100) / 100,
            lineSizes,
            sizeUpcharges: upchargesUsed,
        });
        subtotal += lineTotal;
    }

    const result = {
        productType: 'dtg',
        locationCode: normLoc,
        locationLabel: LOCATION_LABELS[normLoc] || normLoc,
        tier: isLtm ? `${tierLabel} (LTM)` : tierLabel,
        baseTier: tierLabel,
        isLtmTier: isLtm,
        marginDenominator: Number(tier.MarginDenominator) || FALLBACK_MARGIN_DENOM,
        ltmPerUnit: perUnitLtm,
        combinedQuantity: combinedQty,
        totalQuantity: combinedQty,
        subtotal: Math.round(subtotal * 100) / 100,
        lineItems,
        lineCount: lineItems.length,
        appliedRules: {
            tier: isLtm
                ? `${combinedQty} combined pieces → ${tierLabel} tier with LTM (under ${LTM_THRESHOLD}-piece minimum)`
                : `${combinedQty} combined pieces → ${tierLabel} tier (standard)`,
            ltm: isLtm
                ? `$${LTM_FEE} distributed across ${combinedQty} pieces: +$${perUnitLtm.toFixed(2)}/piece (${LTM_FEE}/${combinedQty} floored)`
                : null,
            tierIsByImprint: 'Tier is computed from the TOTAL pieces across all lines (same imprint), NOT per style.',
        },
    };

    // Backward-compat top-level fields when only one line.
    if (lineItems.length === 1) {
        const only = lineItems[0];
        result.partNumber = only.partNumber;
        result.styleNumber = only.styleNumber;
        result.color = only.color;
        result.sizes = only.sizes;
        result.lineSizes = only.lineSizes;
        result.baseUnitPrice = only.baseUnitPrice;
        result.finalUnitPrice = only.finalUnitPrice;
        result.lineTotal = only.lineTotal;
    }
    if (errors.length) result.warnings = errors;

    return result;
}

module.exports = {
    LTM_THRESHOLD,
    LTM_FEE,
    FALLBACK_MARGIN_DENOM,
    STANDARD_LOCATIONS,
    COMBO_LOCATIONS,
    ALL_LOCATION_CODES,
    LOCATION_LABELS,
    roundUpToHalfDollar,
    tierForCombinedQty,
    ltmPerUnit,
    priceForLocationCombo,
    priceLines,
};
