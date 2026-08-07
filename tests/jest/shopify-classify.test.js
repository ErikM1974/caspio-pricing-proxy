// shopify-classify.js — deterministic first, model second, human always.
//
// The stake: the 8 city collections are AUTOMATIC, so a tag files the product the
// moment it is saved. A wrong city is a wrong shelf that a customer finds before we
// do. So the rules under test are: match text when the artwork names a place, refuse
// to pick when it names two, and never emit a tag no collection files on.

const K = require('../../src/utils/shopify-classify');

const CITIES = [
    { name: 'Tacoma', tag: 'city:Tacoma', collection: 'tacoma' },
    { name: 'Puyallup', tag: 'city:Puyallup', collection: 'puyallup' },
    { name: 'Fife', tag: 'city:Fife', collection: 'fife' },
    { name: 'Edgewood', tag: 'city:Edgewood', collection: 'edgewood' },
    { name: 'Milton', tag: 'city:Milton', collection: 'milton' },
    { name: 'Sumner', tag: 'city:Sumner', collection: 'sumner' },
    { name: 'Spanaway', tag: 'city:Spanaway', collection: 'spanaway' },
    { name: 'Washington', tag: 'city:Washington', collection: 'washington-pnw' }
];

const CFG = {
    cities: CITIES,
    baseTags: ['253'],
    styles: [
        { option: 'T-Shirt', filterTag: 'T-Shirt' },
        { option: 'Hoodie', filterTag: 'Hoodie' }
    ]
};

describe('the artwork text settles it when it can', () => {
    test('a design that says TACOMA is filed under tacoma, with a checkable reason', () => {
        const r = K.classifyFromText('TACOMA, EST 1875, CITY OF DESTINY', CITIES);
        expect(r.method).toBe('text');
        expect(r.city).toBe('Tacoma');
        expect(r.confidence).toBe('high');
        expect(r.reason).toMatch(/says "TACOMA"/);
    });

    test('matching is case- and punctuation-insensitive', () => {
        expect(K.classifyFromText('puyallup!', CITIES).city).toBe('Puyallup');
        expect(K.classifyFromText('  Sumner  ', CITIES).city).toBe('Sumner');
    });

    test('a city whose collection handle differs from its name still matches by NAME', () => {
        // The collection is 'washington-pnw' but the city is 'Washington' and the tag
        // is 'city:Washington'. Matching must use the name the artwork would print.
        const r = K.classifyFromText('WASHINGTON STATE PRIDE', CITIES);
        expect(r.city).toBe('Washington');
    });

    test('a substring is not a match — FIFE must not fire on "FIFER"', () => {
        expect(K.classifyFromText('THE FIFER MARCHING BAND', CITIES).city).toBeNull();
    });
});

describe('it refuses to guess rather than guessing wrong', () => {
    test('two places named in one design is ambiguous, not a coin flip', () => {
        const r = K.classifyFromText('SOUTH OF TACOMA — MILTON WA', CITIES);
        expect(r.method).toBe('ambiguous');
        expect(r.city).toBeNull();
        expect(r.candidates.sort()).toEqual(['Milton', 'Tacoma']);
        expect(r.reason).toMatch(/needs a human/);
    });

    test('no recognisable place returns none, never a nearest match', () => {
        const r = K.classifyFromText('CLYDES WATER SLIDE 1982', CITIES);
        expect(r.method).toBe('none');
        expect(r.city).toBeNull();
    });

    test('empty artwork text is none, not a crash', () => {
        expect(K.classifyFromText('', CITIES).method).toBe('none');
        expect(K.classifyFromText(null, CITIES).method).toBe('none');
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
            { city: 'Edgewood', confidence: 'high', reason: 'The windmill is the Nyholm windmill in Edgewood.' }, CITIES);
        expect(r.method).toBe('model');
        expect(r.city).toBe('Edgewood');
        expect(r.confidence).toBe('medium');
        expect(r.reason).toMatch(/Nyholm/);
    });

    test('a suggestion OUTSIDE the vocabulary is discarded, not emitted', () => {
        // 'seattle' matches no collection rule, so the tag would file nothing —
        // which looks like success and is not.
        const r = K.acceptModelSuggestion({ city: 'Seattle', confidence: 'high' }, CITIES);
        expect(r.method).toBe('none');
        expect(r.city).toBeNull();
        expect(r.reason).toMatch(/no collection files on/);
    });

    test('an empty suggestion asks for a human', () => {
        expect(K.acceptModelSuggestion({ city: '' }, CITIES).reason).toMatch(/needs a human/);
        expect(K.acceptModelSuggestion(null, CITIES).city).toBeNull();
    });

    test('a suggestion with no reason still says so rather than inventing one', () => {
        const r = K.acceptModelSuggestion({ city: 'Fife', confidence: 'low' }, CITIES);
        expect(r.reason).toMatch(/no stated reason/);
    });
});

describe('tag assembly emits the LITERAL tags the rules key on', () => {
    test('city, garment filters and the house tag all land, exactly spelled', () => {
        const { tags, rejected } = K.buildTagSet({ city: 'Sumner', styles: ['T-Shirt', 'Hoodie'] }, CFG);
        expect(tags.sort()).toEqual(['253', 'Hoodie', 'T-Shirt', 'city:Sumner']);
        expect(rejected).toEqual([]);
    });

    test('nothing is slugified — that produced tags matching no rule at all', () => {
        const { tags } = K.buildTagSet({ city: 'Tacoma', styles: ['T-Shirt'] }, CFG);
        expect(tags).toContain('city:Tacoma');
        expect(tags).not.toContain('city:tacoma');
        expect(tags).not.toContain('tacoma');
        expect(tags).not.toContain('tee');
    });

    test('a city outside the list is REJECTED, never quietly emitted', () => {
        const { tags, rejected } = K.buildTagSet({ city: 'Seattle', styles: ['T-Shirt'] }, CFG);
        expect(tags).not.toContain('Seattle');
        expect(rejected).toEqual(['Seattle']);
    });

    test('every known city yields a tag that resolves to its collection', () => {
        for (const c of CITIES) {
            const { tags, rejected } = K.buildTagSet({ city: c.name, styles: [] }, CFG);
            expect(rejected).toEqual([]);
            expect(tags).toContain(c.tag);
            expect(K.collectionsForTags(tags, CFG).handles).toContain(c.collection);
        }
    });
});

describe('tags are shown as the collections they will actually produce', () => {
    test('resolves a tag set to real collection handles', () => {
        const { known, handles } = K.collectionsForTags(['253', 'city:Sumner', 'T-Shirt'], CFG);
        expect(known).toBe(true);
        expect(handles).toEqual(['sumner']);
    });

    test('tag matching is case-insensitive, as Shopify treats tags', () => {
        expect(K.collectionsForTags(['city:sumner'], CFG).handles).toEqual(['sumner']);
    });

    test('a garment tag that no collection files on adds no handle', () => {
        expect(K.collectionsForTags(['T-Shirt'], CFG).handles).toEqual([]);
    });

    test('with no city list it reports known:false rather than "no collections"', () => {
        const { known, handles } = K.collectionsForTags(['city:Sumner'], { cities: [] });
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
