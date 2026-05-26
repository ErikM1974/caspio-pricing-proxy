// EMB Pricing Cache — Phase G
//
// In-memory cache of Caspio's Pricing_Tiers + Embroidery_Costs tables, used
// by emb-quote-ai.js to enrich bot tool responses with imputed all-in deal
// margin (not just SanMar-side garment margin).
//
// Pricing formula the EMB quote builder uses:
//   SellPrice_per_unit = (GarmentCost + EmbroideryCost) / MarginDenominator
//   At MarginDenominator = 0.57, target margin = 43%.
//
// The bot uses this cache to compute, for each style returned by
// lookup_style_performance + recommend_high_margin_alternative:
//   - imputed_embroidery_cost_per_unit (looked up by item type + qty tier)
//   - imputed_all_in_cost_per_unit (sanmar wholesale + embroidery)
//   - imputed_customer_price_per_unit (cost / 0.57)
//   - imputed_deal_profit_per_unit (price - cost)
//   - imputed_all_in_margin_pct
//
// Assumptions baked in: 8K stitch, single logo, today's pricing.
// Real orders deviate, but ~5pt margin accuracy is fine for ranking + deal-health.
//
// Graceful degrade: if Caspio fetch fails, getters return null and callers
// skip imputation. Bot still gets existing fields (no crash).
//
// Refresh: cache reloads every 15 min. Matches pricingBundleCache TTL pattern
// in src/routes/pricing.js.
//
// Created 2026-05-25 — EMB Smart Phase G (Pass 1).

const { fetchAllCaspioPages } = require('../src/utils/caspio');

const REFRESH_MS = 15 * 60 * 1000; // 15 min

// Module-level state
let cache = {
    tiers: null,            // [{ DecorationMethod, TierLabel, MinQuantity, MaxQuantity, MarginDenominator, LTM_Fee }]
    costs: null,            // [{ ItemType, TierLabel, EmbroideryCost, DigitizingFee }]
    marginDenominator: null,
    loadedAt: null,
    lastError: null,
};
let inflight = null;

async function loadFromCaspio() {
    const [tiersRaw, costsRaw] = await Promise.all([
        fetchAllCaspioPages('/tables/Pricing_Tiers/records', {
            'q.where': `DecorationMethod='EmbroideryShirts' OR DecorationMethod='EmbroideryCaps'`,
            'q.select': 'TierID,DecorationMethod,TierLabel,MinQuantity,MaxQuantity,MarginDenominator,LTM_Fee',
            'q.limit': 100,
        }),
        fetchAllCaspioPages('/tables/Embroidery_Costs/records', {
            'q.where': `(ItemType='Shirt' OR ItemType='Cap') AND StitchCount=8000`,
            'q.select': 'EmbroideryCostID,ItemType,StitchCount,TierLabel,EmbroideryCost,DigitizingFee',
            'q.limit': 100,
        }),
    ]);

    const tiers = (tiersRaw || []).map((r) => ({
        decorationMethod: r.DecorationMethod,
        tierLabel: r.TierLabel,
        minQuantity: Number(r.MinQuantity) || 0,
        maxQuantity: Number(r.MaxQuantity) || 999999,
        marginDenominator: Number(r.MarginDenominator) || 0,
        ltmFee: Number(r.LTM_Fee) || 0,
    }));
    const costs = (costsRaw || []).map((r) => ({
        itemType: r.ItemType,
        stitchCount: Number(r.StitchCount) || 0,
        tierLabel: r.TierLabel,
        embroideryCost: Number(r.EmbroideryCost) || 0,
        digitizingFee: Number(r.DigitizingFee) || 0,
    }));

    // Pick the canonical margin denominator (should be 0.57 across all rows).
    // If they differ between rows, take the first one for EmbroideryShirts.
    const shirtTier = tiers.find((t) => t.decorationMethod === 'EmbroideryShirts');
    const marginDenominator = shirtTier ? shirtTier.marginDenominator : null;

    return { tiers, costs, marginDenominator };
}

async function refresh() {
    if (inflight) return inflight;
    inflight = (async () => {
        try {
            const data = await loadFromCaspio();
            cache = {
                tiers: data.tiers,
                costs: data.costs,
                marginDenominator: data.marginDenominator,
                loadedAt: Date.now(),
                lastError: null,
            };
            console.log(`[emb-pricing-cache] Loaded ${data.tiers.length} tiers + ${data.costs.length} costs, marginDenominator=${data.marginDenominator}`);
        } catch (err) {
            cache.lastError = err.message;
            console.error('[emb-pricing-cache] Refresh failed:', err.message);
            // Keep stale cache rather than wiping it — graceful degrade
        } finally {
            inflight = null;
        }
    })();
    return inflight;
}

function isStale() {
    if (!cache.loadedAt) return true;
    return (Date.now() - cache.loadedAt) > REFRESH_MS;
}

async function ensureFresh() {
    if (isStale()) await refresh();
}

// Public: pick the qty tier label.
// Tiers in Embroidery_Costs: '1-7', '8-23', '24-47', '48-71', '72+'
// Matches the same tier structure the live EMB quote builder uses.
function pickTier(qty) {
    const n = Number(qty) || 0;
    if (n <= 7) return '1-7';
    if (n <= 23) return '8-23';
    if (n <= 47) return '24-47';
    if (n <= 71) return '48-71';
    return '72+';
}

// Public: look up the embroidery cost for {itemType, qty}.
// itemType: 'Shirt' or 'Cap' (case-insensitive). Returns null if not found.
function getEmbroideryCost({ itemType, qty }) {
    if (!cache.costs) return null;
    const wantType = String(itemType || '').toLowerCase() === 'cap' ? 'Cap' : 'Shirt';
    const wantTier = pickTier(qty);
    const row = cache.costs.find((c) => c.itemType === wantType && c.tierLabel === wantTier);
    return row ? row.embroideryCost : null;
}

// Public: the universal margin denominator (0.57 for all EMB tiers).
function getMarginDenominator() {
    return cache.marginDenominator;
}

// Public: classify a Sanmar category as Shirt vs Cap.
// CATEGORY_NAME containing 'Caps' (case-insensitive) → Cap; everything else → Shirt.
function classifyItemType(categoryName) {
    const c = String(categoryName || '').toLowerCase();
    return c.includes('cap') ? 'Cap' : 'Shirt';
}

// Public: cache health for /api/emb-margin-cache-status
function getCacheStatus() {
    return {
        tiersLoaded: cache.tiers ? cache.tiers.length : 0,
        costsLoaded: cache.costs ? cache.costs.length : 0,
        marginDenominator: cache.marginDenominator,
        loadedAt: cache.loadedAt ? new Date(cache.loadedAt).toISOString() : null,
        isStale: isStale(),
        lastError: cache.lastError,
        sampleCosts: cache.costs ? cache.costs.slice(0, 6).map((c) => ({
            itemType: c.itemType, tier: c.tierLabel, cost: c.embroideryCost,
        })) : [],
    };
}

// Kick off initial load on module require — don't await (silent background).
// First requests hitting the cache will await refresh() via ensureFresh().
refresh();

module.exports = {
    ensureFresh,
    getEmbroideryCost,
    getMarginDenominator,
    pickTier,
    classifyItemType,
    getCacheStatus,
    // Exposed for tests/debugging only
    _refresh: refresh,
};
