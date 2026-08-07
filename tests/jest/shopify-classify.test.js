// shopify-classify.js — deterministic first, model second, human always.
//
// The stake: the 8 city collections are AUTOMATIC, so a tag files the product the
// moment it is saved. A wrong city is a wrong shelf that a customer finds before we
// do. So the rules under test are: match text when the artwork names a place, refuse
// to pick when it names two, and never emit a tag no collection files on.

const K = require('../../src/utils/shopify-classify');

const VOCAB = ['tacoma', 'puyallup', 'fife', 'edgewood', 'milton', 'sumner', 'spanaway', 'washington-pnw'];

const CFG = {
    tagVocabulary: VOCAB,
    baseTags: ['253-gear'],
    styles: [
        { option: 'T-Shirt', filterTag: 'tee' },
        { option: 'Hoodie', filterTag: 'hoodie' }
    ],
    collectionRules: VOCAB.map((v) => ({ handle: v, column: 'TAG', relation: 'EQUALS', condition: v }))
        .concat([{ handle: '253-gear', column: 'TAG', relation: 'EQUALS', condition: '253-gear' }])
};

describe('the artwork text settles it when it can', () => {
    test('a design that says TACOMA is filed under tacoma, with a checkable reason', () => {
        const r = K.classifyFromText('TACOMA, EST 1875, CITY OF DESTINY', VOCAB);
        expect(r.method).toBe('text');
        expect(r.city).toBe('tacoma');
        expect(r.confidence).toBe('high');
        expect(r.reason).toMatch(/says "TACOMA"/);
    });

    test('matching is case- and punctuation-insensitive', () => {
        expect(K.classifyFromText('puyallup!', VOCAB).city).toBe('puyallup');
        expect(K.classifyFromText('  Sumner  ', VOCAB).city).toBe('sumner');
    });

    test('a hyphenated collection matches on its meaningful token', () => {
        // 'washington-pnw' -> 'washington' is a stopword, so 'pnw' is what a design prints.
        const r = K.classifyFromText('PNW STRONG', VOCAB);
        expect(r.city).toBe('washington-pnw');
    });

    test('a substring is not a match — FIFE must not fire on "FIFER"', () => {
        expect(K.classifyFromText('THE FIFER MARCHING BAND', VOCAB).city).toBeNull();
    });
});

describe('it refuses to guess rather than guessing wrong', () => {
    test('two places named in one design is ambiguous, not a coin flip', () => {
        const r = K.classifyFromText('SOUTH OF TACOMA — MILTON WA', VOCAB);
        expect(r.method).toBe('ambiguous');
        expect(r.city).toBeNull();
        expect(r.candidates.sort()).toEqual(['milton', 'tacoma']);
        expect(r.reason).toMatch(/needs a human/);
    });

    test('no recognisable place returns none, never a nearest match', () => {
        const r = K.classifyFromText('CLYDES WATER SLIDE 1982', VOCAB);
        expect(r.method).toBe('none');
        expect(r.city).toBeNull();
    });

    test('empty artwork text is none, not a crash', () => {
        expect(K.classifyFromText('', VOCAB).method).toBe('none');
        expect(K.classifyFromText(null, VOCAB).method).toBe('none');
    });

    test('with no vocabulary yet it says so instead of matching nothing', () => {
        // collectionsKnown === false. "unavailable" is honest; "none" would read as
        // "we checked and there is no city", which is a different claim.
        const r = K.classifyFromText('TACOMA', []);
        expect(r.method).toBe('unavailable');
        expect(r.reason).toMatch(/collection rules have not been read/);
    });
});

describe('model suggestions are bounded by the real vocabulary', () => {
    test('a suggestion inside the vocabulary is accepted, capped at medium confidence', () => {
        // Only the text pass produces a fact; an inference is never "high".
        const r = K.acceptModelSuggestion(
            { city: 'edgewood', confidence: 'high', reason: 'The windmill is the Nyholm windmill in Edgewood.' }, VOCAB);
        expect(r.method).toBe('model');
        expect(r.city).toBe('edgewood');
        expect(r.confidence).toBe('medium');
        expect(r.reason).toMatch(/Nyholm/);
    });

    test('a suggestion OUTSIDE the vocabulary is discarded, not emitted', () => {
        // 'seattle' matches no collection rule, so the tag would file nothing —
        // which looks like success and is not.
        const r = K.acceptModelSuggestion({ city: 'Seattle', confidence: 'high' }, VOCAB);
        expect(r.method).toBe('none');
        expect(r.city).toBeNull();
        expect(r.reason).toMatch(/no collection files on/);
    });

    test('an empty suggestion asks for a human', () => {
        expect(K.acceptModelSuggestion({ city: '' }, VOCAB).reason).toMatch(/needs a human/);
        expect(K.acceptModelSuggestion(null, VOCAB).city).toBeNull();
    });

    test('a suggestion with no reason still says so rather than inventing one', () => {
        const r = K.acceptModelSuggestion({ city: 'fife', confidence: 'low' }, VOCAB);
        expect(r.reason).toMatch(/no stated reason/);
    });
});

describe('tag assembly', () => {
    test('city, garment filters and the house tag all land', () => {
        const { tags, rejected } = K.buildTagSet({ city: 'sumner', styles: ['T-Shirt', 'Hoodie'] }, CFG);
        expect(tags).toEqual(expect.arrayContaining(['253-gear', 'sumner', 'tee', 'hoodie']));
        expect(rejected).toEqual([]);
    });

    test('a city outside the vocabulary is REJECTED, never quietly emitted', () => {
        const { tags, rejected } = K.buildTagSet({ city: 'seattle', styles: ['T-Shirt'] }, CFG);
        expect(tags).not.toContain('seattle');
        expect(rejected).toEqual(['seattle']);
    });

    test('every emitted city tag exists in the live vocabulary', () => {
        for (const city of VOCAB) {
            const { tags } = K.buildTagSet({ city, styles: [] }, CFG);
            expect(tags).toContain(city);
        }
    });
});

describe('tags are shown as the collections they will actually produce', () => {
    test('resolves a tag set to real collection handles', () => {
        const { known, handles } = K.collectionsForTags(['253-gear', 'sumner', 'tee'], CFG);
        expect(known).toBe(true);
        expect(handles.sort()).toEqual(['253-gear', 'sumner']);
    });

    test('a garment tag that no collection files on adds no handle', () => {
        const { handles } = K.collectionsForTags(['tee'], CFG);
        expect(handles).toEqual([]);
    });

    test('with no rules read it reports known:false rather than "no collections"', () => {
        const { known, handles } = K.collectionsForTags(['sumner'], { collectionRules: [] });
        expect(known).toBe(false);
        expect(handles).toEqual([]);
    });
});

describe('SEO trimming', () => {
    test('short text is untouched', () => {
        expect(K.trimToWidth('Retro Sumner Tee', 60)).toBe('Retro Sumner Tee');
    });

    test('long text is cut on a word boundary, not mid-word', () => {
        const long = 'Retro Sumner Washington vintage arch design printed to order in Milton';
        const out = K.trimToWidth(long, 40);
        expect(out.length).toBeLessThanOrEqual(40);
        expect(long.startsWith(out)).toBe(true);
        expect(out.endsWith(' ')).toBe(false);
    });
});
