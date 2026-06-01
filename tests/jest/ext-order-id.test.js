/**
 * ExtOrderID uniqueness + year-safety across all three push methods.
 *
 * Regression guards for the 2026-06-01 fix. SCP/DTF quote IDs are
 * `Prefix{MMDD}-{seq}` with a DAILY-reset sequence and NO year, so the old
 * extractSequence() approach collapsed every day's first quote to `-1`
 * (a daily collision, not just annual). EMB IDs already embed the year and MUST
 * stay byte-identical — this file pins that so the one working method can't drift.
 */
const {
  generateEmbExtOrderID,
  getQuoteYear,
} = require('../../config/manageorders-emb-config');
const { generateScpExtOrderID } = require('../../config/manageorders-scp-config');
const { generateDtfExtOrderID } = require('../../config/manageorders-dtf-config');

describe('ExtOrderID — EMB output is unchanged (working path must not drift)', () => {
  test('EMB-2026-177 → EMB-2026-177', () => {
    expect(generateEmbExtOrderID('EMB-2026-177')).toBe('EMB-2026-177');
  });
  test('test push → EMB-TEST-2026-177', () => {
    expect(generateEmbExtOrderID('EMB-2026-177', true)).toBe('EMB-TEST-2026-177');
  });
});

describe('ExtOrderID — SCP no longer collides daily', () => {
  test('two different-day quotes with the same trailing seq get different IDs', () => {
    const a = generateScpExtOrderID('SP0601-1', false, '2026');
    const b = generateScpExtOrderID('SP0602-1', false, '2026');
    expect(a).toBe('SCP-2026-0601-1');
    expect(b).toBe('SCP-2026-0602-1');
    expect(a).not.toBe(b); // old extractSequence reduced both to 'SCP-1'
  });
  test('same MMDD-seq in different years also differ', () => {
    expect(generateScpExtOrderID('SP0601-1', false, '2026'))
      .not.toBe(generateScpExtOrderID('SP0601-1', false, '2027'));
  });
  test('test prefix + the hyphenated SPC- fixture form both work', () => {
    expect(generateScpExtOrderID('SPC-0101-1', true, '2026')).toBe('SCP-TEST-2026-0101-1');
  });
});

describe('ExtOrderID — DTF no longer collides daily', () => {
  test('two different-day quotes get different IDs', () => {
    const a = generateDtfExtOrderID('DTF0521-1', false, '2026');
    const b = generateDtfExtOrderID('DTF0522-1', false, '2026');
    expect(a).toBe('DTF-2026-0521-1');
    expect(b).toBe('DTF-2026-0522-1');
    expect(a).not.toBe(b);
  });
});

describe('getQuoteYear — stable year sourced from the session', () => {
  test('reads 20xx from DateOrderPlaced', () => {
    expect(getQuoteYear({ DateOrderPlaced: '2026-05-31' })).toBe('2026');
  });
  test('reads from CreatedAt_Quote when DateOrderPlaced absent', () => {
    expect(getQuoteYear({ CreatedAt_Quote: '5/31/2026 14:00:00' })).toBe('2026');
  });
  test('falls back to current year when no date present', () => {
    expect(getQuoteYear({})).toBe(String(new Date().getFullYear()));
  });
});

describe('ExtOrderID — shape guarantees', () => {
  test('every method always carries a 20xx year segment', () => {
    expect(generateScpExtOrderID('SP0601-9', false, '2026')).toMatch(/^SCP-20\d\d-/);
    expect(generateDtfExtOrderID('DTF1231-3', false, '2026')).toMatch(/^DTF-20\d\d-/);
    expect(generateEmbExtOrderID('EMB-2026-5')).toMatch(/^EMB-20\d\d-/);
  });
  test('a December MMDD (1231) is not mistaken for a year', () => {
    expect(generateScpExtOrderID('SP1231-1', false, '2026')).toBe('SCP-2026-1231-1');
  });
});
