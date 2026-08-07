// shopify-config.js — the Caspio key/value config that keeps prices out of code.
//
// The point of these tests is Rule 4: an incomplete config must REFUSE, naming what
// is missing, never fall back to a built-in number. Publishing a product at a price
// nobody set is worse than refusing to publish.

jest.mock('../../src/utils/caspio', () => ({
    fetchAllCaspioPages: jest.fn(),
    getCaspioAccessToken: jest.fn()
}));

const C = require('../../src/utils/shopify-config');

const STYLES = [
    { option: 'T-Shirt', sanmarStyle: 'PC54', weightOz: 5.4, filterTag: 'tee', price: 22.50 },
    { option: 'Hoodie', sanmarStyle: 'PC78H', weightOz: 12.5, filterTag: 'hoodie', price: 43.75 }
];

function rows(over = {}) {
    const base = {
        styles: { v: JSON.stringify(STYLES), t: 'json' },
        size_ladder: { v: JSON.stringify({ '2XL': 2, '3XL': 3, '4XL': 4 }), t: 'json' },
        size_order: { v: JSON.stringify(['S', 'M', 'L']), t: 'json' },
        base_tags: { v: JSON.stringify(['253-gear']), t: 'json' },
        vendor: { v: '253 Gear', t: 'string' },
        product_type: { v: 'Apparel', t: 'string' },
        ...over
    };
    return Object.entries(base)
        .filter(([, spec]) => spec !== null)
        .map(([Config_Key, spec]) => ({
            Config_Key, Config_Value: spec.v, Value_Type: spec.t, Active: spec.active || 'Yes'
        }));
}

describe('value parsing', () => {
    test('json, number, bool and string all round-trip', () => {
        expect(C.parseValue('{"a":1}', 'json')).toEqual({ a: 1 });
        expect(C.parseValue('22.5', 'number')).toBe(22.5);
        expect(C.parseValue('Yes', 'bool')).toBe(true);
        expect(C.parseValue('no', 'bool')).toBe(false);
        expect(C.parseValue('hello', 'string')).toBe('hello');
        expect(C.parseValue('hello')).toBe('hello');      // default type
    });

    test('malformed JSON names the key rather than throwing something opaque', () => {
        expect(() => C.rowsToMap([{ Config_Key: 'styles', Config_Value: '{not json', Value_Type: 'json' }]))
            .toThrow(/Config key "styles"/);
    });

    test('a non-numeric "number" is rejected, not coerced to NaN', () => {
        expect(() => C.parseValue('abc', 'number')).toThrow(/not a number/);
    });
});

describe('Active flag', () => {
    test('Active=No rows are ignored', () => {
        const map = C.rowsToMap([
            { Config_Key: 'vendor', Config_Value: 'Live', Value_Type: 'string', Active: 'Yes' },
            { Config_Key: 'product_type', Config_Value: 'Ignored', Value_Type: 'string', Active: 'No' }
        ]);
        expect(map.vendor).toBe('Live');
        expect(map.product_type).toBeUndefined();
    });

    test('a blank Active counts as active — a fresh import should just work', () => {
        const map = C.rowsToMap([{ Config_Key: 'vendor', Config_Value: 'Live', Value_Type: 'string', Active: '' }]);
        expect(map.vendor).toBe('Live');
    });
});

describe('shaping', () => {
    test('prices are DERIVED from styles, so a garment cannot drift across two rows', () => {
        const cfg = C.shapeConfig(C.rowsToMap(rows()));
        expect(cfg.prices).toEqual({ 'T-Shirt': 22.50, 'Hoodie': 43.75 });
        expect(cfg.styles).toHaveLength(2);
    });

    test('a missing required key refuses and NAMES it', () => {
        expect(() => C.shapeConfig(C.rowsToMap(rows({ vendor: null }))))
            .toThrow(/missing required keys: vendor/);
        try {
            C.shapeConfig(C.rowsToMap(rows({ size_ladder: null, base_tags: null })));
        } catch (e) {
            expect(e.code).toBe('NOT_CONFIGURED');
            expect(e.detail.missing).toEqual(expect.arrayContaining(['size_ladder', 'base_tags']));
        }
    });

    // Number(null) === 0 and 0 is finite, so an isFinite-only guard turns "nobody set
    // this price" into "$0.00" and ships it. Absent must never become zero.
    test.each([
        ['null', null],
        ['undefined', undefined],
        ['empty string', ''],
        ['whitespace', '   '],
        ['zero', 0],
        ['negative', -5],
        ['non-numeric', 'TBD']
    ])('a %s price refuses — it never becomes $0.00', (_label, price) => {
        const styles = [{ option: 'Crewneck', sanmarStyle: 'PC78', weightOz: 11.5, filterTag: 'crewneck', price }];
        expect(() => C.shapeConfig(C.rowsToMap(rows({ styles: { v: JSON.stringify(styles), t: 'json' } }))))
            .toThrow(/no usable price/);
    });

    test('a price supplied as a numeric STRING is still accepted', () => {
        // Caspio hands back text; "22.50" is a set price, not a missing one.
        const styles = [{ option: 'T-Shirt', sanmarStyle: 'PC54', weightOz: 5.4, filterTag: 'tee', price: '22.50' }];
        const cfg = C.shapeConfig(C.rowsToMap(rows({ styles: { v: JSON.stringify(styles), t: 'json' } })));
        expect(cfg.prices['T-Shirt']).toBe(22.50);
    });

    test('a style with no SanMar mapping refuses — SKU and weight depend on it', () => {
        const noStyle = [{ option: 'Crewneck', weightOz: 11.5, price: 39 }];
        expect(() => C.shapeConfig(C.rowsToMap(rows({ styles: { v: JSON.stringify(noStyle), t: 'json' } }))))
            .toThrow(/no sanmarStyle/);
    });

    test('an empty styles array refuses', () => {
        expect(() => C.shapeConfig(C.rowsToMap(rows({ styles: { v: '[]', t: 'json' } }))))
            .toThrow(/non-empty JSON array/);
    });
});

describe('collection knowledge is explicit, never assumed', () => {
    test('collectionsKnown is false until the live rules have been read', () => {
        const cfg = C.shapeConfig(C.rowsToMap(rows()));
        expect(cfg.collectionsKnown).toBe(false);
        expect(cfg.tagVocabulary).toEqual([]);
    });

    test('an EMPTY collection_rules is not "known" — the seed ships []', () => {
        // Defined-but-empty must not read as verified. Same absent-vs-zero trap as a
        // null price becoming $0.00: it would claim the tag vocabulary was discovered
        // while it is still the assumed list.
        const seeded = C.shapeConfig(C.rowsToMap(rows({
            tag_vocabulary: { v: JSON.stringify(['sumner']), t: 'json' },
            collection_rules: { v: '[]', t: 'json' }
        })));
        expect(seeded.collectionsKnown).toBe(false);
    });

    test('collectionsKnown flips only when BOTH discovered keys are present', () => {
        const partial = C.shapeConfig(C.rowsToMap(rows({
            tag_vocabulary: { v: JSON.stringify(['sumner']), t: 'json' }
        })));
        expect(partial.collectionsKnown).toBe(false);

        const full = C.shapeConfig(C.rowsToMap(rows({
            tag_vocabulary: { v: JSON.stringify(['sumner']), t: 'json' },
            collection_rules: { v: JSON.stringify([{ handle: 'sumner', column: 'TAG', relation: 'EQUALS', condition: 'sumner' }]), t: 'json' }
        })));
        expect(full.collectionsKnown).toBe(true);
        expect(full.tagVocabulary).toEqual(['sumner']);
    });
});

describe('the seed script matches what the loader requires', () => {
    test('every required key is present and active in the seed', () => {
        const { ROWS } = require('../../scripts/253gear-seed-config');
        const active = ROWS.filter((r) => r.Active !== 'No');
        const keys = active.map((r) => r.Config_Key);
        for (const required of C.REQUIRED_KEYS) expect(keys).toContain(required);
    });

    test('the seed actually shapes into a usable config', () => {
        const { ROWS } = require('../../scripts/253gear-seed-config');
        const cfg = C.shapeConfig(C.rowsToMap(ROWS.map((r) => ({
            Config_Key: r.Config_Key, Config_Value: r.Config_Value, Value_Type: r.Value_Type, Active: r.Active
        }))));
        expect(cfg.prices['T-Shirt']).toBeGreaterThan(0);
        expect(cfg.prices['Hoodie']).toBeGreaterThan(0);
        expect(cfg.vendor).toBeTruthy();
    });

    test('the unconfirmed crewneck row is seeded INACTIVE so it cannot ship a guessed price', () => {
        const { ROWS } = require('../../scripts/253gear-seed-config');
        const pending = ROWS.find((r) => r.Config_Key === 'styles_pending_crewneck');
        expect(pending).toBeTruthy();
        expect(pending.Active).toBe('No');
    });
});
