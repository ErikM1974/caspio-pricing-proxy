/**
 * Unit tests for src/utils/catalog-display-price.js — the server-side "from $X"
 * catalog card price (margin + rounding 100% Caspio-sourced, never hardcoded).
 * Pure unit tests: Caspio access is mocked, no network.
 */

jest.mock('../../src/utils/caspio', () => ({
  fetchAllCaspioPages: jest.fn()
}));

const { fetchAllCaspioPages } = require('../../src/utils/caspio');
const {
  applyRounding,
  computeDisplayPrice,
  formatDisplayPriceLabel,
  getBlankDisplayPricingConfig,
  _resetBlankConfigCacheForTests
} = require('../../src/utils/catalog-display-price');

const BLANK_TIERS = [
  { TierLabel: '1-23', MinQuantity: 1, MaxQuantity: 23, MarginDenominator: 0.5 },
  { TierLabel: '24-47', MinQuantity: 24, MaxQuantity: 47, MarginDenominator: 0.52 },
  { TierLabel: '72+', MinQuantity: 72, MaxQuantity: 999, MarginDenominator: 0.53 }
];
const BLANK_RULES = [
  { RuleName: 'RoundingMethod', RuleValue: 'HalfDollarCeil_Final' }
];

beforeEach(() => {
  _resetBlankConfigCacheForTests();
  fetchAllCaspioPages.mockReset();
});

describe('applyRounding', () => {
  test('HalfDollarCeil_Final rounds UP to nearest $0.50', () => {
    expect(applyRounding(10.00, 'HalfDollarCeil_Final')).toBe(10.00);
    expect(applyRounding(10.01, 'HalfDollarCeil_Final')).toBe(10.50);
    expect(applyRounding(10.49, 'HalfDollarCeil_Final')).toBe(10.50);
    expect(applyRounding(10.50, 'HalfDollarCeil_Final')).toBe(10.50);
    expect(applyRounding(10.51, 'HalfDollarCeil_Final')).toBe(11.00);
  });

  test('is immune to float noise at exact half-dollar boundaries', () => {
    // 2.65 / 0.53 = 5.000000000000001 in IEEE754 — must stay $5.00, not jump to $5.50
    expect(applyRounding(2.65 / 0.53, 'HalfDollarCeil_Final')).toBe(5.00);
  });

  test('CeilDollar rounds UP to whole dollar', () => {
    expect(applyRounding(10.01, 'CeilDollar')).toBe(11);
    expect(applyRounding(10.00, 'CeilDollar')).toBe(10);
  });

  test('unknown method warns and falls back to half-dollar ceil (never under-charges)', () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    expect(applyRounding(10.01, 'SomeFutureMethod')).toBe(10.50);
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});

describe('computeDisplayPrice', () => {
  test('cheapest-cost / Caspio margin, half-dollar-ceil rounded (PC54 real numbers)', () => {
    // PC54 cheapest size cost $3.00, BLANK MarginDenominator 0.53 → 5.66 → $6.00
    expect(computeDisplayPrice(3.00, 0.53, 'HalfDollarCeil_Final')).toBe(6.00);
  });

  test('uses the margin it is given — no baked-in literal', () => {
    expect(computeDisplayPrice(3.00, 0.6, 'HalfDollarCeil_Final')).toBe(5.00);  // 5.00 exact
    expect(computeDisplayPrice(3.00, 0.57, 'HalfDollarCeil_Final')).toBe(5.50); // 5.26 → 5.50
  });

  test('returns null on missing/invalid cost — never a guessed price', () => {
    expect(computeDisplayPrice(null, 0.53, 'HalfDollarCeil_Final')).toBeNull();
    expect(computeDisplayPrice(undefined, 0.53, 'HalfDollarCeil_Final')).toBeNull();
    expect(computeDisplayPrice(0, 0.53, 'HalfDollarCeil_Final')).toBeNull();
    expect(computeDisplayPrice(-4, 0.53, 'HalfDollarCeil_Final')).toBeNull();
    expect(computeDisplayPrice(NaN, 0.53, 'HalfDollarCeil_Final')).toBeNull();
    expect(computeDisplayPrice('not-a-price', 0.53, 'HalfDollarCeil_Final')).toBeNull();
  });

  test('returns null on missing/invalid margin — never a hardcoded fallback', () => {
    expect(computeDisplayPrice(3.00, null, 'HalfDollarCeil_Final')).toBeNull();
    expect(computeDisplayPrice(3.00, 0, 'HalfDollarCeil_Final')).toBeNull();
    expect(computeDisplayPrice(3.00, NaN, 'HalfDollarCeil_Final')).toBeNull();
  });
});

describe('formatDisplayPriceLabel', () => {
  test('whole dollars render without cents', () => {
    expect(formatDisplayPriceLabel(24)).toBe('from $24');
  });

  test('half dollars render with cents', () => {
    expect(formatDisplayPriceLabel(24.5)).toBe('from $24.50');
  });

  test('null/invalid price → null label', () => {
    expect(formatDisplayPriceLabel(null)).toBeNull();
    expect(formatDisplayPriceLabel(0)).toBeNull();
    expect(formatDisplayPriceLabel(NaN)).toBeNull();
  });
});

describe('getBlankDisplayPricingConfig', () => {
  function mockCaspio({ tiers = BLANK_TIERS, rules = BLANK_RULES } = {}) {
    fetchAllCaspioPages.mockImplementation((path, params) => {
      if (path.includes('Pricing_Tiers')) return Promise.resolve(tiers);
      if (path.includes('Pricing_Rules')) return Promise.resolve(rules);
      return Promise.resolve([]);
    });
  }

  test('returns margin from the highest-quantity BLANK tier + rounding from rules', async () => {
    mockCaspio();
    const config = await getBlankDisplayPricingConfig();
    expect(config).toEqual({
      marginDenominator: 0.53,
      roundingMethod: 'HalfDollarCeil_Final',
      tierLabel: '72+'
    });
  });

  test('caches the config — second call makes no further Caspio requests', async () => {
    mockCaspio();
    await getBlankDisplayPricingConfig();
    const callsAfterFirst = fetchAllCaspioPages.mock.calls.length; // tiers + rules = 2
    await getBlankDisplayPricingConfig();
    expect(fetchAllCaspioPages.mock.calls.length).toBe(callsAfterFirst);
  });

  test('no valid tiers → null (omit price, no fallback) and failure is NOT cached', async () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    mockCaspio({ tiers: [] });
    expect(await getBlankDisplayPricingConfig()).toBeNull();
    expect(warnSpy).toHaveBeenCalled();

    // Caspio recovers → next call refetches and succeeds
    mockCaspio();
    const config = await getBlankDisplayPricingConfig();
    expect(config).not.toBeNull();
    expect(config.marginDenominator).toBe(0.53);
    warnSpy.mockRestore();
  });

  test('Caspio error → null (visible warn), never a substituted margin', async () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    fetchAllCaspioPages.mockRejectedValue(new Error('Caspio down'));
    expect(await getBlankDisplayPricingConfig()).toBeNull();
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  test('non-numeric MarginDenominator rows are ignored', async () => {
    mockCaspio({
      tiers: [
        { TierLabel: '1-23', MinQuantity: 1, MarginDenominator: null },
        { TierLabel: '72+', MinQuantity: 72, MarginDenominator: 'garbage' },
        { TierLabel: '24-47', MinQuantity: 24, MarginDenominator: 0.52 }
      ]
    });
    const config = await getBlankDisplayPricingConfig();
    expect(config.marginDenominator).toBe(0.52);
    expect(config.tierLabel).toBe('24-47');
  });
});
