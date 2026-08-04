/**
 * Locks the shared normalizers behind design-search dup-clusters.
 *
 * normalizeCompanyName must stay behaviorally identical to the copy in
 * scripts/sync-design-lookup.js — these expectations are the spec both copies
 * answer to. normalizeDesignName deliberately keeps suffix words ("co", "the",
 * "and"): they are part of an art title, not a legal-entity suffix.
 */

const { normalizeCompanyName, normalizeDesignName } = require('../../src/utils/design-normalize');

describe('normalizeCompanyName', () => {
    test('strips punctuation, casing, and legal suffixes', () => {
        expect(normalizeCompanyName('Acme, Inc.')).toBe('acme');
        expect(normalizeCompanyName('The ACME Co')).toBe('acme');
        expect(normalizeCompanyName('  Acme   LLC  ')).toBe('acme');
        expect(normalizeCompanyName('Acme Corp.')).toBe('acme');
    });

    test('keeps distinguishing words — near-miss companies do NOT collapse', () => {
        expect(normalizeCompanyName('Acme Northwest')).not.toBe(normalizeCompanyName('Acme NW'));
        expect(normalizeCompanyName('Acme Plumbing')).not.toBe(normalizeCompanyName('Acme Electric'));
    });

    test('ampersand survives (punctuation list excludes &)', () => {
        expect(normalizeCompanyName('A&B Embroidery')).toBe('a&b embroidery');
    });

    test('empty and null yield empty string', () => {
        expect(normalizeCompanyName('')).toBe('');
        expect(normalizeCompanyName(null)).toBe('');
        expect(normalizeCompanyName(undefined)).toBe('');
    });
});

describe('normalizeDesignName', () => {
    test('folds casing, punctuation, whitespace', () => {
        expect(normalizeDesignName('Eagle Logo (Left Chest)!')).toBe('eagle logo left chest');
        expect(normalizeDesignName('  EAGLE   logo ')).toBe('eagle logo');
    });

    test('keeps company-suffix words — they are part of an art title', () => {
        expect(normalizeDesignName('The Eagle And Co')).toBe('the eagle and co');
    });

    test('coerces non-strings; empty and null yield empty string', () => {
        expect(normalizeDesignName(12345)).toBe('12345');
        expect(normalizeDesignName('')).toBe('');
        expect(normalizeDesignName(null)).toBe('');
    });
});
