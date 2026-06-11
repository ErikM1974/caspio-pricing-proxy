/**
 * Locks the shared wholesale tax-account routing (2026-06-08, DTF/SCP parity).
 * resolveTaxAccount + isWholesaleSession route a per-order IsWholesale flag → GL 2203 (Wholesale Sales),
 * short-circuiting the destination-rate lookup. Used by the EMB, DTF, and SCP push transformers.
 */
const { resolveTaxAccount, isWholesaleSession, getTaxAccount } = require('../../config/manageorders-emb-config');

describe('isWholesaleSession — parses the per-order flag', () => {
  test.each([true, 'Yes', 1, '1', 'true', 'TRUE'])('truthy: %p → wholesale', (v) => {
    expect(isWholesaleSession({ IsWholesale: v })).toBe(true);
  });
  test.each([false, 'No', '', 0, null, undefined])('falsy: %p → NOT wholesale (never auto-wholesale)', (v) => {
    expect(isWholesaleSession({ IsWholesale: v })).toBe(false);
  });
  test('missing session / field → false', () => {
    expect(isWholesaleSession({})).toBe(false);
    expect(isWholesaleSession(null)).toBe(false);
  });
});

describe('resolveTaxAccount — 2203 short-circuit', () => {
  test('wholesale → 2203 regardless of rate/state, no tax part', () => {
    expect(resolveTaxAccount({ isWholesale: true, taxRate: 0.101, shipState: 'WA' }).accountCode).toBe('2203');
    expect(resolveTaxAccount({ isWholesale: true, taxRate: 0, shipState: 'OR' }).accountCode).toBe('2203');
    expect(resolveTaxAccount({ isWholesale: true, taxRate: 0.088, shipState: 'WA' }).partNumber).toBe('');
  });
  test('NOT wholesale → defers to getTaxAccount (WA rate account, never 2203)', () => {
    const r = resolveTaxAccount({ isWholesale: false, taxRate: 0.101, shipState: 'WA' });
    expect(r.accountCode).not.toBe('2203');
    expect(r).toEqual(getTaxAccount(0.101, 'WA'));
  });
  test('NOT wholesale, out-of-state → 2202', () => {
    expect(resolveTaxAccount({ isWholesale: false, taxRate: 0, shipState: 'OR' }).accountCode).toBe('2202');
  });
});
