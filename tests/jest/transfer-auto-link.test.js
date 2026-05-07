/**
 * Unit tests for transfer-auto-link.js
 *
 * Focus: extractPoDigits regex contract. Bradley types the ShopWorks PO# in
 * the queue UI to drive the deterministic Step A0 auto-link match. The regex
 * has to be forgiving — Bradley pastes from anywhere (ShopWorks confirmation,
 * Slack, his own typing) and may put "BW" before or after the digits, with
 * or without spaces. Single source of truth for that forgiveness.
 *
 * History:
 *   v1 (pre-2026-05-07): /^(\d+)/ — leading digits only. Failed on
 *       "BW 112898" and "PO# 112898" because they start with letters.
 *   v2 (2026-05-07): /(\d{5,})/ — any 5+ digit run anywhere in the input.
 *       Captures every plausible Bradley typing pattern; only blocks
 *       genuinely PO-less inputs.
 */
const { _extractPoDigits } = require('../../src/utils/transfer-auto-link');

describe('extractPoDigits — Bradley typing patterns', () => {
    test.each([
        ['112898',                          112898, 'pure digits'],
        ['112898 BW',                       112898, 'digits + space + BW (Supacolor canonical)'],
        ['112898BW',                        112898, 'digits + BW no space'],
        ['112898-BW',                       112898, 'digits + hyphen + BW'],
        ['BW 112898',                       112898, 'BW + space + digits (alpha-first)'],
        ['BW112898',                        112898, 'BW + digits no space'],
        ['PO# 112898',                      112898, 'with PO# prefix'],
        ['PO 112898 BW',                    112898, 'with PO prefix and BW suffix'],
        ['Supacolor PO 112898 BW for tee',  112898, 'embedded in free text'],
        ['  112898 BW  ',                   112898, 'leading/trailing whitespace'],
        ['1234567',                       1234567, '7 digits (future-proof for PO space growth)'],
        ['99999',                           99999, '5 digits (minimum)'],
    ])('"%s" → %d (%s)', (input, expected) => {
        expect(_extractPoDigits(input)).toBe(expected);
    });
});

describe('extractPoDigits — rejects invalid inputs', () => {
    test.each([
        ['',           'empty string'],
        ['BW',         'letters only'],
        ['BW BW',      'letters with spaces'],
        ['1234',       '4 digits — below 5-digit minimum'],
        ['12 34',      'split short digit runs (no 5+ run)'],
        [null,         'null input'],
        [undefined,    'undefined input'],
        ['no digits in here at all', 'free text without digits'],
    ])('"%s" → null (%s)', (input) => {
        expect(_extractPoDigits(input)).toBeNull();
    });
});

describe('extractPoDigits — first-match semantics', () => {
    test('captures first 5+ digit run when multiple are present', () => {
        // If Bradley pastes something with two PO-like numbers (e.g., a
        // copied email "PO 112898 → confirmation 998877"), we take the first.
        // Real PO ranges shouldn't collide; this just pins the behavior.
        expect(_extractPoDigits('PO 112898 confirmation 998877')).toBe(112898);
    });

    test('skips short digit runs to find a qualifying one', () => {
        // "DTF 12 BW 112898" — "12" is too short, regex skips ahead to 112898
        expect(_extractPoDigits('DTF 12 BW 112898')).toBe(112898);
    });
});
