// Reference_ID must never be a bare number (src/routes/creditcard-lookups.js).
//
// THE BUG (2026-08-03): a Bank of America reference is 23 digits — longer than ANY
// numeric type holds (a 64-bit integer tops out at 19). The formatter emitted it as
// digits only, so Excel rendered it "2.41164E+22" on open-and-save, and a numeric
// Caspio field rounded it the same way. What survives is the leading ~7 significant
// digits — the acquirer/BIN prefix, which identifies the payment PROCESSOR, not the
// charge. A 92-charge statement collapsed to 21 distinct keys: every SUPACOLOR,
// ANTHROPIC, INKSOFT, SHOPIFY and ZAPIER charge shared the key 24011346. Reference_ID
// is marked Unique, so 71 payables were rejected and the month was understated by
// ~$19K with no error surfaced to the operator.
//
// The fix is the 'R' prefix: it keeps the value text in every consumer, and makes a
// numeric field reject the write outright instead of silently merging charges.

const { refDigits, refKey } = require('../../src/routes/creditcard-lookups');

// Real references from the July 2026 statement, chosen because they share a prefix.
const SUPACOLOR = '24011346160100052488457';
const ANTHROPIC = '24011346161100144538250';
const ZOHO      = '24011346188100078202047';
const STAHLS    = '24707806163017034004591';

describe('refKey — the value written to Caspio', () => {
  test('prefixes the digits so the value is not numeric', () => {
    expect(refKey(`Ref: ${SUPACOLOR}`)).toBe(`R${SUPACOLOR}`);
    expect(Number.isNaN(Number(refKey(SUPACOLOR)))).toBe(true);
  });

  test('is idempotent — re-keying an already-keyed value is a no-op', () => {
    expect(refKey(refKey(SUPACOLOR))).toBe(`R${SUPACOLOR}`);
  });

  test('blank in, blank out (the upsert skips these rather than dedup on empty)', () => {
    expect(refKey('')).toBe('');
    expect(refKey(null)).toBe('');
    expect(refKey('Ref: ')).toBe('');
  });
});

describe('THE REGRESSION: charges sharing an acquirer prefix stay distinct', () => {
  // Guard the exact failure. If someone "simplifies" refKey back to bare digits,
  // these three go through Excel/a numeric field as ONE value and two charges vanish.
  const charges = [SUPACOLOR, ANTHROPIC, ZOHO, STAHLS];

  test('all four keys survive a float round-trip as distinct strings', () => {
    const keys = charges.map(refKey);
    expect(new Set(keys).size).toBe(4);
  });

  test('a numeric field REJECTS the key instead of silently rounding it', () => {
    for (const c of charges) {
      expect(Number.isNaN(Number(refKey(c)))).toBe(true);   // loud failure
      expect(Number.isNaN(Number(c))).toBe(false);          // what used to happen
    }
  });

  test('the leading digits alone are NOT identity — three charges share 24011346', () => {
    const prefix = s => s.slice(0, 8);
    expect(new Set([SUPACOLOR, ANTHROPIC, ZOHO].map(prefix)).size).toBe(1);
    expect(new Set([SUPACOLOR, ANTHROPIC, ZOHO].map(refKey)).size).toBe(3);
  });

  test('float32 — what a single-precision field does — collapses the bare digits', () => {
    const f32 = v => Math.fround(Number(v));
    expect(new Set([SUPACOLOR, ANTHROPIC, ZOHO].map(f32)).size).toBe(1); // the bug
    expect(new Set([SUPACOLOR, ANTHROPIC, ZOHO].map(refKey)).size).toBe(3); // the fix
  });
});

describe('refDigits — the comparison key used to match existing rows', () => {
  test('a legacy bare-digit row still matches its new R-prefixed key', () => {
    expect(refDigits(SUPACOLOR)).toBe(refDigits(`R${SUPACOLOR}`));
  });

  test('ignores NOREF placeholders so they never collide with a real reference', () => {
    // scripts/clean-atmos-table.js keys reference-less rows "NOREF-<PK_ID>".
    expect(refDigits('NOREF-1234')).toBeNull();
    expect(refDigits('NOREF-999999')).toBeNull();
  });

  test('ignores values with no reference-length digit run', () => {
    expect(refDigits('')).toBeNull();
    expect(refDigits(null)).toBeNull();
    expect(refDigits('STAHLS')).toBeNull();
    expect(refDigits('113466')).toBeNull();   // a PO number, not a reference
  });

  test('pulls the reference out of a full InvoiceNumber string', () => {
    expect(refDigits(`STAHLS 'Ref: Ref: ${STAHLS}'`)).toBe(STAHLS);
  });
});
