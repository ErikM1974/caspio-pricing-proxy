/**
 * Unit tests for rep-email-map.js — focused on resolveAEEmailLoose, the
 * looser Note_By resolver that powers the art-note watcher fan-out.
 *
 * A stand-in who posts a reply on an art request often signs with a FULL
 * name ("Erik Mickelson") while REP_EMAIL_MAP is keyed on bare first names
 * ("Erik"). resolveAEEmailLoose bridges that gap WITHOUT any Caspio schema
 * change — while still refusing to leak to external/customer addresses.
 *
 * No mocks — these are pure functions.
 */
const {
    resolveAEEmail,
    resolveAEEmailLoose
} = require('../../src/utils/rep-email-map');

describe('resolveAEEmailLoose — exact map hit', () => {
    test("'Erik' → erik@nwcustomapparel.com", () => {
        expect(resolveAEEmailLoose('Erik')).toBe('erik@nwcustomapparel.com');
    });

    test("'Taneisha' → taneisha@nwcustomapparel.com", () => {
        expect(resolveAEEmailLoose('Taneisha')).toBe('taneisha@nwcustomapparel.com');
    });
});

describe('resolveAEEmailLoose — full-name first-token fallback', () => {
    test("'Erik Mickelson' → erik@nwcustomapparel.com (first token resolves)", () => {
        expect(resolveAEEmailLoose('Erik Mickelson')).toBe('erik@nwcustomapparel.com');
    });

    test("leading/trailing whitespace is tolerated: '  Erik  Mickelson '", () => {
        expect(resolveAEEmailLoose('  Erik  Mickelson ')).toBe('erik@nwcustomapparel.com');
    });

    test("first token that isn't a known rep → null ('Jane Customer')", () => {
        expect(resolveAEEmailLoose('Jane Customer')).toBeNull();
    });
});

describe('resolveAEEmailLoose — internal email passthrough', () => {
    test('an internal email is returned as-is (lowercased)', () => {
        expect(resolveAEEmailLoose('Taneisha@NWCustomApparel.com'))
            .toBe('taneisha@nwcustomapparel.com');
    });
});

describe('resolveAEEmailLoose — refuses external / unknown', () => {
    test('external customer email → null (no leak)', () => {
        expect(resolveAEEmailLoose('foo@gmail.com')).toBeNull();
        expect(resolveAEEmailLoose('archterra@comcast.net')).toBeNull();
    });

    test('unknown single-token name → null', () => {
        expect(resolveAEEmailLoose('Unknown')).toBeNull();
    });

    test('empty / null / non-string → null', () => {
        expect(resolveAEEmailLoose('')).toBeNull();
        expect(resolveAEEmailLoose('   ')).toBeNull();
        expect(resolveAEEmailLoose(null)).toBeNull();
        expect(resolveAEEmailLoose(undefined)).toBeNull();
        expect(resolveAEEmailLoose(12345)).toBeNull();
    });
});

describe('resolveAEEmailLoose vs resolveAEEmail — only the loose form handles full names', () => {
    test("strict resolveAEEmail returns null for 'Erik Mickelson'", () => {
        // Guards against regressing the loose-only behavior: the strict
        // resolver must NOT silently start matching full names.
        expect(resolveAEEmail('Erik Mickelson')).toBeNull();
        expect(resolveAEEmailLoose('Erik Mickelson')).toBe('erik@nwcustomapparel.com');
    });
});
