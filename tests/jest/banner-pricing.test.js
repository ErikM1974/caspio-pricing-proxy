// Locks the banner rate card and — critically — the ORDER OF OPERATIONS in
// computeBannerQuote. Banners had zero automated coverage before 2026-07-24.
//
// The order matters and is not obvious: the $40 minimum is a floor on the BASE
// square-foot charge, applied BEFORE the double-sided multiplier. Reordering
// those two silently changes what a small double-sided banner costs, and the
// arithmetic hides it on most inputs — see the dedicated test below.
//
// Caspio is mocked to throw, forcing the inline rate card (source of truth in
// the route). Hermetic, no network.

jest.mock('../../src/utils/caspio', () => ({
  fetchAllCaspioPages: jest.fn(async () => { throw new Error('no caspio in test — force inline'); }),
}));

const {
  computeBannerQuote,
  loadBannerRates,
} = require('../../src/routes/banner-pricing');

const rate = (rates, pn) => rates.find(r => r.PartNumber === pn);

describe('banner-pricing — the rate card', () => {
  test('all six part numbers and their rates are pinned', async () => {
    const { rates, source } = await loadBannerRates();
    expect(source).toBe('inline');
    expect(rate(rates, 'BAN-SQFT').Rate).toBe(10.0);
    expect(rate(rates, 'BAN-MIN').Rate).toBe(40.0);
    expect(rate(rates, 'BAN-GROMMET').Rate).toBe(0.5);
    expect(rate(rates, 'BAN-POLE-POCKET').Rate).toBe(2.5);
    expect(rate(rates, 'BAN-DOUBLE-SIDE').Rate).toBe(1.8);
    expect(rate(rates, 'RUSH-25PCT').Rate).toBe(1.25);
  });

  test('RUSH-25PCT lives HERE and is the single home of the rush multiplier', async () => {
    // sticker-pricing and custom-decal-pricing both read this row. If it ever
    // forks into three local constants, a rush quote stops agreeing with itself.
    const { resolveRushMultiplier } = require('../../src/routes/sticker-pricing');
    const { rates } = await loadBannerRates();
    expect(await resolveRushMultiplier()).toBe(rate(rates, 'RUSH-25PCT').Rate);
  });

  test('the inline fallback is never cached', async () => {
    const a = await loadBannerRates();
    const b = await loadBannerRates();
    expect(a.source).toBe('inline');
    expect(b.source).toBe('inline');
  });
});

describe('banner-pricing — square-foot maths', () => {
  test('sqft = (W × H) / 144', async () => {
    const q = await computeBannerQuote({ widthIn: 36, heightIn: 24, qty: 1 });
    expect(q.dimensions.sqft).toBeCloseTo(6, 6);
    expect(q.orderTotal).toBe(60);           // 6 sqft × $10
    expect(q.partNumber).toBe('BAN-36X24');
  });

  test('the $40 minimum floors small banners and says so in appliedRules', async () => {
    const q = await computeBannerQuote({ widthIn: 12, heightIn: 12, qty: 1 });
    expect(q.dimensions.sqft).toBeCloseTo(1, 6);   // 1 sqft × $10 = $10 → floored
    expect(q.orderTotal).toBe(40);
    expect(q.appliedRules.minimum).toBeTruthy();
    // ...and stays null when the floor did NOT fire, so the note is never misleading.
    const big = await computeBannerQuote({ widthIn: 48, heightIn: 24, qty: 1 });
    expect(big.appliedRules.minimum).toBeNull();
  });

  test('exactly 4 sqft (24×24) is the break-even point of the minimum', async () => {
    // Everything from 12×12 up to 24×24 costs the same $40 — worth knowing
    // before this goes on a customer page, because it reads as a bug.
    const small = await computeBannerQuote({ widthIn: 12, heightIn: 12, qty: 1 });
    const atBreak = await computeBannerQuote({ widthIn: 24, heightIn: 24, qty: 1 });
    expect(small.orderTotal).toBe(40);
    expect(atBreak.orderTotal).toBe(40);
    const above = await computeBannerQuote({ widthIn: 24, heightIn: 30, qty: 1 });
    expect(above.orderTotal).toBeGreaterThan(40);
  });

  test('quantity multiplies the per-banner total', async () => {
    const one = await computeBannerQuote({ widthIn: 48, heightIn: 24, qty: 1 });
    const ten = await computeBannerQuote({ widthIn: 48, heightIn: 24, qty: 10 });
    expect(ten.orderTotal).toBeCloseTo(one.orderTotal * 10, 2);
  });

  test('there is NO volume break — 10 banners cost exactly 10 × 1', async () => {
    // Pinned deliberately: the sticker page's savings-% ladder has nothing to
    // attach to on banners. Any future banner UI must not imply a volume break
    // that the rate card does not have.
    const one = await computeBannerQuote({ widthIn: 36, heightIn: 60, qty: 1 });
    const ten = await computeBannerQuote({ widthIn: 36, heightIn: 60, qty: 10 });
    expect(ten.orderTotal / one.orderTotal).toBeCloseTo(10, 6);
  });
});

describe('banner-pricing — order of operations (the case where orderings diverge)', () => {
  test('🔴 6×6in double-sided is floor-first: max(2.5, 40) × 1.8 = $72, NOT max(2.5×1.8, 40) = $40', async () => {
    // 6×6in = 0.25 sqft = $2.50 base.
    //   correct   → floor to $40, then ×1.8  = $72.00
    //   reordered → $2.50 × 1.8 = $4.50, floor = $40.00
    // A $32 divergence on a single banner. This is the test that catches a
    // well-meaning refactor of computeBannerQuote.
    const q = await computeBannerQuote({ widthIn: 6, heightIn: 6, qty: 1, extras: { doubleSided: true } });
    expect(q.orderTotal).toBe(72);
  });

  test('double-sided applies 1.8× above the floor too', async () => {
    const single = await computeBannerQuote({ widthIn: 48, heightIn: 24, qty: 1 });
    const double = await computeBannerQuote({ widthIn: 48, heightIn: 24, qty: 1, extras: { doubleSided: true } });
    expect(single.orderTotal).toBe(80);       // 8 sqft × $10
    expect(double.orderTotal).toBe(144);      // × 1.8
  });

  test('rush applies AFTER the finishing extras, not before', async () => {
    // 8 sqft = $80 base, + 4 extra grommets @ $0.50 = $82, × 1.25 = $102.50.
    // Rushing before the extras would give 80 × 1.25 + 2 = $102.00.
    const q = await computeBannerQuote({
      widthIn: 48, heightIn: 24, qty: 1,
      extras: { grommetCount: 4, rush: true },
    });
    expect(q.orderTotal).toBe(102.5);
  });

  test('pole pockets bill by linear foot of banner width', async () => {
    // 48in = 4ft wide; both sides = 8 lf × $2.50 = $20 on top of the $80 base.
    const q = await computeBannerQuote({
      widthIn: 48, heightIn: 24, qty: 1,
      extras: { polePockets: 'both' },
    });
    expect(q.orderTotal).toBe(100);
  });

  test('grommets and pole pockets are charged per banner, then multiplied by qty', async () => {
    const q = await computeBannerQuote({
      widthIn: 48, heightIn: 24, qty: 10,
      extras: { grommetCount: 4 },
    });
    expect(q.orderTotal).toBe(820);           // ($80 + $2) × 10
  });
});

describe('banner-pricing — bad input never yields a price', () => {
  test.each([
    ['zero width', { widthIn: 0, heightIn: 24, qty: 1 }],
    ['negative height', { widthIn: 48, heightIn: -1, qty: 1 }],
    ['non-numeric qty', { widthIn: 48, heightIn: 24, qty: 'abc' }],
    ['all missing', {}],
  ])('%s → an error, not a price', async (_label, input) => {
    const q = await computeBannerQuote(input);
    expect(q.error).toBeTruthy();
    expect(q.orderTotal).toBeUndefined();
  });
});
