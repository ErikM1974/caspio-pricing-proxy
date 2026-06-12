// Catalog display price helpers — server-side "from $X" card pricing for /api/products/search.
//
// WHY: The customer catalog frontend used to compute card prices in browser JS with a
// hardcoded margin literal ((PIECE_PRICE / 0.57) + 15 in product-search-service.js) which
// drifted from Caspio (BLANK MarginDenominator is 0.53 as of 2026-06). Erik's iron rule:
// every customer-facing price comes from the API and Caspio is the single source of truth,
// so a price change in Caspio reaches customers with NO deploy.
//
// Formula (mirrors the pricing-bundle BLANK machinery + decorated-cap-prices.js approach):
//   displayPrice = round( cheapestSizeCost / MarginDenominator )
//   - cheapestSizeCost = MIN over sizes of MAX(CASE_PRICE) per size (same per-size garment
//     cost convention as /api/pricing-bundle's `sizes[]`).
//   - MarginDenominator from Caspio Pricing_Tiers, DecorationMethod='Blank' (best/highest
//     quantity tier — "from $X" semantics, same as decorated-cap-prices' default '72+').
//   - Rounding from Caspio Pricing_Rules RoundingMethod for Blank (HalfDollarCeil_Final).
//
// HARD RULE (Erik's #1): if cost or margin is unavailable, return null — the frontend shows
// no price. NEVER substitute a hardcoded number silently.

const { fetchAllCaspioPages } = require('./caspio');

// ---------------------------------------------------------------------------
// Rounding
// ---------------------------------------------------------------------------

// Rounding methods that mean "round UP to the nearest $0.50"
// (same aliases the frontend pricing services accept).
const HALF_DOLLAR_CEIL_METHODS = ['HalfDollarCeil_Final', 'HalfDollarUp_Final', 'HalfDollarUp', 'HalfDollarCeil'];
const CEIL_DOLLAR_METHODS = ['CeilDollar', 'CeilDollar_Final'];

/**
 * Apply a Caspio RoundingMethod to an amount.
 * Unknown methods round UP to the nearest $0.50 with a console.warn — rounding up can
 * never under-charge, and the margin itself is never defaulted (Erik's #1 rule applies
 * to the margin/cost, which always come from Caspio or the price is omitted).
 * @param {number} amount
 * @param {string} method - e.g. 'HalfDollarCeil_Final'
 * @returns {number}
 */
function applyRounding(amount, method) {
  // Kill float noise before ceiling (e.g. 5.5000000000000004 must not become 6.00)
  const cents = Math.round(amount * 100) / 100;

  if (CEIL_DOLLAR_METHODS.includes(method)) {
    return Math.ceil(cents);
  }
  if (!HALF_DOLLAR_CEIL_METHODS.includes(method)) {
    console.warn(`[catalog-display-price] Unknown RoundingMethod '${method}' — defaulting to half-dollar ceil (rounds UP, never under-charges)`);
  }
  return Math.ceil(cents * 2) / 2;
}

/**
 * Compute the customer-facing "from $X" price for a product.
 * With embCost (decorated cards, Erik 2026-06-11): mirrors the EMB garment/cap
 * formula the product-page ladder uses — round((base / margin) + embCost) — so
 * the card equals the configurator's 72+ embroidered column for the style's
 * cheapest color/size.
 * @param {number} baseCost - cheapest size's garment cost (CASE_PRICE based)
 * @param {number} marginDenominator - Caspio Pricing_Tiers.MarginDenominator
 * @param {string} roundingMethod - Caspio Pricing_Rules.RoundingMethod
 * @param {number} [embCost=0] - per-piece embroidery cost at the same tier (8K stitches)
 * @returns {number|null} rounded price, or null when inputs are missing/invalid
 */
function computeDisplayPrice(baseCost, marginDenominator, roundingMethod, embCost = 0) {
  const cost = Number(baseCost);
  const margin = Number(marginDenominator);
  const emb = Number(embCost) || 0;

  if (!Number.isFinite(cost) || cost <= 0) return null;
  if (!Number.isFinite(margin) || margin <= 0) return null;
  if (emb < 0) return null;

  return applyRounding(cost / margin + emb, roundingMethod);
}

/**
 * Format the label shown on catalog cards, e.g. "from $47 with logo".
 * @param {number|null} price
 * @param {string} [suffix=' with logo'] - '' for plain blank pricing
 * @returns {string|null}
 */
function formatDisplayPriceLabel(price, suffix = ' with logo') {
  if (!Number.isFinite(price) || price <= 0) return null;
  const amount = Number.isInteger(price) ? `$${price}` : `$${price.toFixed(2)}`;
  return `from ${amount}${suffix}`;
}

// ---------------------------------------------------------------------------
// Cached BLANK margin/rounding config (ONE Caspio lookup per hour, not per product)
// ---------------------------------------------------------------------------

const BLANK_CONFIG_CACHE_TTL = 60 * 60 * 1000; // 1 hour
let blankConfigCache = null;   // { config: {marginDenominator, roundingMethod, tierLabel}, timestamp }
let blankConfigInFlight = null; // de-dupe concurrent fetches

/**
 * Fetch (cached) the BLANK-method margin + rounding config from Caspio.
 * Same tables the /api/pricing-bundle?method=BLANK endpoint reads.
 * @param {{refresh?: boolean}} [opts]
 * @returns {Promise<{marginDenominator:number, roundingMethod:string, tierLabel:string}|null>}
 *          null when Caspio data is unavailable — caller must omit prices (no fallback).
 */
async function getBlankDisplayPricingConfig(opts = {}) {
  const now = Date.now();
  if (!opts.refresh && blankConfigCache && (now - blankConfigCache.timestamp) < BLANK_CONFIG_CACHE_TTL) {
    return blankConfigCache.config;
  }

  if (!blankConfigInFlight) {
    blankConfigInFlight = (async () => {
      try {
        const [tiers, rules] = await Promise.all([
          fetchAllCaspioPages('/tables/Pricing_Tiers/records', {
            'q.where': "DecorationMethod='Blank'",
            'q.select': 'TierLabel,MinQuantity,MaxQuantity,MarginDenominator',
            'q.limit': 100
          }),
          fetchAllCaspioPages('/tables/Pricing_Rules/records', {
            'q.where': "DecorationMethod='Blank'"
          })
        ]);

        // "from $X" = the best (highest-quantity) tier, mirroring decorated-cap-prices'
        // default tier '72+'. All BLANK tiers currently share one MarginDenominator.
        const validTiers = (tiers || []).filter(t => Number.isFinite(Number(t.MarginDenominator)) && Number(t.MarginDenominator) > 0);
        if (validTiers.length === 0) {
          console.warn('[catalog-display-price] No valid BLANK Pricing_Tiers rows — displayPrice will be omitted (no hardcoded fallback)');
          return null;
        }
        const bestTier = validTiers.reduce((best, t) =>
          (Number(t.MinQuantity) > Number(best.MinQuantity) ? t : best), validTiers[0]);

        const rulesObject = {};
        (rules || []).forEach(rule => {
          if (rule.RuleName && rule.RuleValue) rulesObject[rule.RuleName] = rule.RuleValue;
        });

        const config = {
          marginDenominator: Number(bestTier.MarginDenominator),
          roundingMethod: rulesObject.RoundingMethod || 'HalfDollarCeil_Final',
          tierLabel: bestTier.TierLabel
        };

        blankConfigCache = { config, timestamp: Date.now() };
        return config;
      } catch (error) {
        // Erik's #1: never a silent wrong price. Surface the failure, return null —
        // /api/products/search will then OMIT displayPrice (frontend shows no price).
        console.warn('[catalog-display-price] Failed to fetch BLANK pricing config from Caspio:', error.message);
        return null; // failures are NOT cached — next request retries
      } finally {
        blankConfigInFlight = null;
      }
    })();
  }

  return blankConfigInFlight;
}

// ---------------------------------------------------------------------------
// Cached DECORATED (embroidery-included) config — Erik 2026-06-11: catalog cards
// show "from $X with logo" = the product page's 72+ embroidered price for the
// style's cheapest color/size. Garments use EmbroideryShirts margins + Shirt
// 8K-stitch costs; caps use EmbroideryCaps + Cap costs (decorated-cap-prices
// pattern). One Caspio lookup set per hour, never per product.
// ---------------------------------------------------------------------------

const DECORATED_CONFIG_CACHE_TTL = 60 * 60 * 1000; // 1 hour
let decoratedConfigCache = null;   // { config: {garment, cap}, timestamp }
let decoratedConfigInFlight = null;

/**
 * Best (highest-MinQuantity) tier with a valid margin for one DecorationMethod.
 * "from $X" semantics — same convention as decorated-cap-prices' default '72+'.
 */
function bestTierFor(tiers, decorationMethod) {
  const valid = (tiers || []).filter(t =>
    t.DecorationMethod === decorationMethod &&
    Number.isFinite(Number(t.MarginDenominator)) && Number(t.MarginDenominator) > 0
  );
  if (valid.length === 0) return null;
  return valid.reduce((best, t) =>
    (Number(t.MinQuantity) > Number(best.MinQuantity) ? t : best), valid[0]);
}

/**
 * Fetch (cached) the embroidery-decorated card-pricing config from Caspio.
 * @param {{refresh?: boolean}} [opts]
 * @returns {Promise<{garment:{marginDenominator,embCost,roundingMethod,tierLabel}|null,
 *                    cap:{marginDenominator,embCost,roundingMethod,tierLabel}|null}|null>}
 *          null when Caspio is unavailable. A null garment/cap SECTION means
 *          those products get NO price (never a fallback margin/cost).
 */
async function getDecoratedDisplayPricingConfig(opts = {}) {
  const now = Date.now();
  if (!opts.refresh && decoratedConfigCache && (now - decoratedConfigCache.timestamp) < DECORATED_CONFIG_CACHE_TTL) {
    return decoratedConfigCache.config;
  }

  if (!decoratedConfigInFlight) {
    decoratedConfigInFlight = (async () => {
      try {
        const [tiers, embCosts, rules] = await Promise.all([
          fetchAllCaspioPages('/tables/Pricing_Tiers/records', {
            'q.where': "DecorationMethod='EmbroideryShirts' OR DecorationMethod='EmbroideryCaps'",
            'q.select': 'DecorationMethod,TierLabel,MinQuantity,MaxQuantity,MarginDenominator',
            'q.limit': 100
          }),
          fetchAllCaspioPages('/tables/Embroidery_Costs/records', {
            'q.where': "StitchCount=8000 AND (ItemType='Shirt' OR ItemType='Cap')",
            'q.select': 'ItemType,TierLabel,EmbroideryCost',
            'q.limit': 100
          }),
          fetchAllCaspioPages('/tables/Pricing_Rules/records', {
            'q.where': "DecorationMethod='EmbroideryShirts' OR DecorationMethod='EmbroideryCaps' OR DecorationMethod='Embroidery'"
          })
        ]);

        const rulesObject = {};
        (rules || []).forEach(rule => {
          if (rule.RuleName && rule.RuleValue && rulesObject[rule.RuleName] === undefined) {
            rulesObject[rule.RuleName] = rule.RuleValue;
          }
        });
        // Live value is CeilDollar (EMB bundle rulesR, verified 2026-06-11);
        // applyRounding's unknown-method path rounds UP so a missing rule can
        // never under-charge.
        const roundingMethod = rulesObject.RoundingMethod || 'CeilDollar';

        function sectionFor(decorationMethod, itemType) {
          const tier = bestTierFor(tiers, decorationMethod);
          if (!tier) {
            console.warn(`[catalog-display-price] No valid ${decorationMethod} tier — those cards get no price (no fallback)`);
            return null;
          }
          const costRow = (embCosts || []).find(c =>
            c.ItemType === itemType && c.TierLabel === tier.TierLabel &&
            Number.isFinite(Number(c.EmbroideryCost)) && Number(c.EmbroideryCost) >= 0
          );
          if (!costRow) {
            console.warn(`[catalog-display-price] No ${itemType} 8K embroidery cost for tier '${tier.TierLabel}' — those cards get no price (no fallback)`);
            return null;
          }
          return {
            marginDenominator: Number(tier.MarginDenominator),
            embCost: Number(costRow.EmbroideryCost),
            roundingMethod,
            tierLabel: tier.TierLabel
          };
        }

        const config = {
          garment: sectionFor('EmbroideryShirts', 'Shirt'),
          cap: sectionFor('EmbroideryCaps', 'Cap')
        };

        if (!config.garment && !config.cap) return null; // nothing usable — retry next request

        decoratedConfigCache = { config, timestamp: Date.now() };
        return config;
      } catch (error) {
        // Erik's #1: never a silent wrong price. null => displayPrice omitted everywhere.
        console.warn('[catalog-display-price] Failed to fetch decorated pricing config from Caspio:', error.message);
        return null; // failures are NOT cached — next request retries
      } finally {
        decoratedConfigInFlight = null;
      }
    })();
  }

  return decoratedConfigInFlight;
}

/** Test hook — clears the cached config so tests can exercise fetch paths. */
function _resetBlankConfigCacheForTests() {
  blankConfigCache = null;
  blankConfigInFlight = null;
  decoratedConfigCache = null;
  decoratedConfigInFlight = null;
}

module.exports = {
  applyRounding,
  computeDisplayPrice,
  formatDisplayPriceLabel,
  getBlankDisplayPricingConfig,
  getDecoratedDisplayPricingConfig,
  _resetBlankConfigCacheForTests
};
